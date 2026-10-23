-- Incremental. Run AFTER schema, video_schema, family_schema,
-- website_improvements and context_monitoring. Existing bindings/data survive.
begin;
create table if not exists safenest_private.device_managers (
  device_id uuid not null,
  user_id uuid not null,
  granted_at timestamptz not null default clock_timestamp(),
  primary key(device_id,user_id),
  foreign key(device_id,user_id) references safenest_private.members(device_id,user_id) on delete cascade
);
alter table safenest_private.device_managers enable row level security;
revoke all on safenest_private.device_managers from public,anon,authenticated;
-- No automatic promotion, self-claim RPC or role from editable Auth metadata.
alter table safenest_private.family_invites add column if not exists created_by uuid
  references auth.users(id) on delete set null;
create index if not exists family_invites_device_created on safenest_private.family_invites(device_id,created_at desc);

create or replace function safenest_private.require_device_manager(p_device uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare uid uuid:=safenest_private.family_user();
begin
  if not exists(select 1 from safenest_private.device_managers a
    join safenest_private.members m using(device_id,user_id)
    join safenest_private.devices d on d.id=a.device_id and d.enabled
    where a.device_id=p_device and a.user_id=uid) then
    raise exception 'Access denied' using errcode='42501';
  end if;
  return uid;
end;
$$;
revoke all on function safenest_private.require_device_manager(uuid) from public,anon,authenticated;

create or replace function public.list_my_monitors()
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=safenest_private.family_user(); result jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('device_id',d.id,
    'name',coalesce(nullif(s.payload->>'room',''),'Monitored home'),
    'camera_name',coalesce(s.payload->>'camera_name','Camera'),
    'can_manage',exists(select 1 from safenest_private.device_managers a where a.device_id=d.id and a.user_id=uid))
    order by d.id),'[]'::jsonb) into result
    from safenest_private.members m join safenest_private.devices d on d.id=m.device_id and d.enabled
    left join safenest_private.snapshots s on s.device_id=d.id where m.user_id=uid;
  return result;
end;
$$;

create or replace function public.list_family_access(p_device uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=safenest_private.require_device_manager(p_device); members_now jsonb; invites_now jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('member_id',m.user_id,
    'name',safenest_private.family_display_name(u.raw_user_meta_data),'is_self',m.user_id=uid,
    'role',case when a.user_id is null then 'family' else 'manager' end)
    order by a.user_id is null,m.user_id),'[]'::jsonb) into members_now
    from safenest_private.members m join auth.users u on u.id=m.user_id
    left join safenest_private.device_managers a using(device_id,user_id)
    where m.device_id=p_device;
  select coalesce(jsonb_agg(jsonb_build_object('invite_id',i.id,'created_at',i.created_at,
    'expires_at',i.expires_at,'uses',i.uses,'max_uses',i.max_uses,
    'status',case when not i.enabled then 'revoked' when i.expires_at<=clock_timestamp() then 'expired'
      when i.uses>=i.max_uses then 'used_up' else 'active' end,
    'created_by',safenest_private.family_display_name(u.raw_user_meta_data))
    order by (i.enabled and i.expires_at>clock_timestamp() and i.uses<i.max_uses) desc,i.created_at desc,i.id),'[]'::jsonb) into invites_now
    from (select * from safenest_private.family_invites where device_id=p_device
      order by (enabled and expires_at>clock_timestamp() and uses<max_uses) desc,created_at desc,id limit 50) i left join auth.users u on u.id=i.created_by;
  -- IDs identify action targets; names are labels, not authority. No emails, codes or hashes.
  return jsonb_build_object('members',members_now,'invitations',invites_now);
end;
$$;

create or replace function public.create_family_invite(p_device uuid,p_hours integer default 168,p_max_uses integer default 5)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=safenest_private.require_device_manager(p_device); code_now text; inv_id uuid; expiry timestamptz;
begin
  -- All invite mutations/redemptions take the device lock before an invite lock.
  perform 1 from safenest_private.devices where id=p_device for update;
  uid:=safenest_private.require_device_manager(p_device);
  if not safenest_private.family_limit('invite-create:'||uid::text,5) then
    return jsonb_build_object('ok',false,'error','rate_limited');
  end if;
  if p_hours is null or p_hours not between 1 and 720 or p_max_uses is null or p_max_uses not between 1 and 100 then
    return jsonb_build_object('ok',false,'error','invalid_settings');
  end if;
  if (select count(*) from safenest_private.family_invites where device_id=p_device
      and enabled and expires_at>clock_timestamp() and uses<max_uses)>=20 then
    return jsonb_build_object('ok',false,'error','too_many_invites');
  end if;
  code_now:=replace(gen_random_uuid()::text,'-','');
  expiry:=clock_timestamp()+p_hours*interval '1 hour';
  insert into safenest_private.family_invites(device_id,code_hash,expires_at,max_uses,created_by)
    values(p_device,encode(sha256(convert_to(code_now,'UTF8')),'hex'),expiry,p_max_uses,uid) returning id into inv_id;
  -- The sole plaintext return. No retrieval RPC and no plaintext column.
  return jsonb_build_object('ok',true,'invite_id',inv_id,'invitation_code',code_now,'expires_at',expiry,'max_uses',p_max_uses);
end;
$$;

create or replace function public.revoke_family_invite(p_device uuid,p_invite uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=safenest_private.require_device_manager(p_device);
begin
  perform 1 from safenest_private.devices where id=p_device for update;
  uid:=safenest_private.require_device_manager(p_device);
  update safenest_private.family_invites set enabled=false where id=p_invite and device_id=p_device;
  if not found then raise exception 'Access denied' using errcode='42501'; end if;
  return jsonb_build_object('ok',true);
end;
$$;

-- Applies also to an operator removing a binding in SQL Editor. Keeping an old
-- shared code usable would allow the removed account to bind again immediately.
create or replace function safenest_private.cleanup_removed_family_member()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  perform 1 from safenest_private.devices where id=old.device_id for update;
  delete from safenest_private.video_sessions where device_id=old.device_id and user_id=old.user_id;
  update safenest_private.family_invites set enabled=false where device_id=old.device_id and enabled;
  return null;
end;
$$;
revoke all on function safenest_private.cleanup_removed_family_member() from public,anon,authenticated;
drop trigger if exists safenest_remove_family_access on safenest_private.members;
create trigger safenest_remove_family_access after delete on safenest_private.members
  for each row execute function safenest_private.cleanup_removed_family_member();

create or replace function public.revoke_family_member(p_device uuid,p_member uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=safenest_private.require_device_manager(p_device);
begin
  perform 1 from safenest_private.devices where id=p_device for update;
  uid:=safenest_private.require_device_manager(p_device);
  if p_member is null or p_member=uid or exists(select 1 from safenest_private.device_managers
      where device_id=p_device and user_id=p_member) then
    return jsonb_build_object('ok',false,'error','protected_manager');
  end if;
  delete from safenest_private.members where device_id=p_device and user_id=p_member;
  -- Idempotent for an already-removed member. No user lookup across devices.
  return jsonb_build_object('ok',true);
end;
$$;

create or replace function public.redeem_family_invite(p_code text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=safenest_private.family_user(); inv safenest_private.family_invites%rowtype;
  code_now text:=lower(btrim(p_code)); device_now uuid; added integer;
begin
  if not safenest_private.family_limit('invite:'||uid::text,10) then
    return jsonb_build_object('ok',false,'error','rate_limited');
  end if;
  if code_now is null or code_now !~ '^[0-9a-f]{32}$' then
    return jsonb_build_object('ok',false,'error','invalid_invite');
  end if;
  select device_id into device_now from safenest_private.family_invites
    where code_hash=encode(sha256(convert_to(code_now,'UTF8')),'hex');
  if not found then return jsonb_build_object('ok',false,'error','invalid_invite'); end if;
  perform 1 from safenest_private.devices where id=device_now for update;
  select * into inv from safenest_private.family_invites
    where code_hash=encode(sha256(convert_to(code_now,'UTF8')),'hex') for update;
  if not found then return jsonb_build_object('ok',false,'error','invalid_invite'); end if;
  if not inv.enabled or inv.expires_at<=clock_timestamp() or inv.uses>=inv.max_uses
    or not exists(select 1 from safenest_private.devices where id=inv.device_id and enabled) then
    return jsonb_build_object('ok',false,'error','invalid_invite');
  end if;
  insert into safenest_private.members(device_id,user_id) values(inv.device_id,uid) on conflict do nothing;
  get diagnostics added=row_count;
  if added=1 then update safenest_private.family_invites set uses=uses+1 where id=inv.id; end if;
  return jsonb_build_object('ok',true,'device_id',inv.device_id,'already_member',added=0);
end;
$$;

-- Preserve video grants/lease durations. Recheck membership AFTER the device
-- lock so a waiting issuance cannot rely on a pre-revocation membership read.
create or replace function public.video_viewer_session(p_device uuid,p_action text,p_session uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=safenest_private.family_user(); sid uuid; identity_now text;
begin
  if p_action not in ('issue','renew','release') or p_action is null then raise exception 'Invalid action'; end if;
  if p_action='release' then
    perform safenest_private.video_limit('viewer-'||uid::text||'-release',30);
    delete from safenest_private.video_sessions where id=p_session and device_id=p_device and user_id=uid returning identity into identity_now;
    return jsonb_build_object('identity',identity_now);
  end if;
  -- Reject unrelated requests before taking a device lock, then check again.
  if not exists(select 1 from safenest_private.members where user_id=uid and device_id=p_device) then
    raise exception 'Access denied' using errcode='42501';
  end if;
  perform 1 from safenest_private.devices where id=p_device for update;
  if not exists(select 1 from safenest_private.members m join safenest_private.devices d on d.id=m.device_id
    where m.user_id=uid and m.device_id=p_device and d.enabled) then
    raise exception 'Access denied' using errcode='42501';
  end if;
  perform safenest_private.video_limit('viewer-'||uid::text||'-'||p_action,case when p_action='issue' then 10 else 30 end);
  delete from safenest_private.video_sessions where expires_at<clock_timestamp();
  if p_action='issue' then
    if (select count(*) from safenest_private.video_sessions where device_id=p_device)>=12 then raise exception 'Too many video viewers'; end if;
    sid:=gen_random_uuid();identity_now:='family-'||uid::text||'-'||sid::text;
    insert into safenest_private.video_sessions(id,device_id,user_id,identity,expires_at)
      values(sid,p_device,uid,identity_now,clock_timestamp()+interval '25 seconds');
  else
    sid:=p_session;
    update safenest_private.video_sessions set expires_at=clock_timestamp()+interval '25 seconds'
      where id=sid and device_id=p_device and user_id=uid and expires_at>clock_timestamp() returning identity into identity_now;
    if identity_now is null then raise exception 'Video session expired' using errcode='42501'; end if;
  end if;
  return jsonb_build_object('session_id',sid,'identity',identity_now,'lease_seconds',25);
end;
$$;

revoke all on function public.list_my_monitors(),public.list_family_access(uuid),
  public.create_family_invite(uuid,integer,integer),public.revoke_family_invite(uuid,uuid),
  public.revoke_family_member(uuid,uuid),public.redeem_family_invite(text),
  public.video_viewer_session(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.list_my_monitors(),public.list_family_access(uuid),
  public.create_family_invite(uuid,integer,integer),public.revoke_family_invite(uuid,uuid),
  public.revoke_family_member(uuid,uuid),public.redeem_family_invite(text),
  public.video_viewer_session(uuid,text,uuid) to authenticated;
notify pgrst,'reload schema';
commit;
