-- Run AFTER schema.sql and video_schema.sql. Additive; existing members remain valid.
begin;
create table if not exists safenest_private.family_invites (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references safenest_private.devices(id) on delete cascade,
  code_hash text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  max_uses integer not null default 5 check (max_uses between 1 and 100),
  uses integer not null default 0 check (uses >= 0 and uses <= max_uses),
  enabled boolean not null default true,
  created_at timestamptz not null default clock_timestamp()
);
create table if not exists safenest_private.family_limits (
  scope text primary key, window_at timestamptz not null, attempts integer not null
);
create table if not exists safenest_private.care_notes (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references safenest_private.devices(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 1000),
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists care_notes_device_time on safenest_private.care_notes(device_id,created_at desc,id);
alter table safenest_private.family_invites enable row level security;
alter table safenest_private.family_limits enable row level security;
alter table safenest_private.care_notes enable row level security;
revoke all on safenest_private.family_invites,safenest_private.family_limits,safenest_private.care_notes from public,anon,authenticated;

create or replace function safenest_private.family_user()
returns uuid language plpgsql security definer set search_path='' as $$
declare uid uuid := auth.uid();
begin
  if uid is null or not exists(select 1 from auth.users u where u.id=uid
    and (u.banned_until is null or u.banned_until<clock_timestamp())) then
    raise exception 'Sign in required' using errcode='42501';
  end if;
  return uid;
end;
$$;

-- Returns false rather than raising: the caller MUST return normally on denial,
-- otherwise PostgreSQL rolls back the attempt counter along with the exception.
create or replace function safenest_private.family_limit(p_scope text,p_limit integer)
returns boolean language plpgsql security definer set search_path='' as $$
declare count_now integer;
begin
  insert into safenest_private.family_limits(scope,window_at,attempts)
  values(p_scope,clock_timestamp(),1)
  on conflict(scope) do update set
    attempts=case when safenest_private.family_limits.window_at<clock_timestamp()-interval '1 minute'
      then 1 else least(safenest_private.family_limits.attempts+1,p_limit+1) end,
    window_at=case when safenest_private.family_limits.window_at<clock_timestamp()-interval '1 minute'
      then clock_timestamp() else safenest_private.family_limits.window_at end
  returning attempts into count_now;
  delete from safenest_private.family_limits where window_at<clock_timestamp()-interval '1 day';
  return count_now<=p_limit;
end;
$$;

create or replace function public.list_my_monitors()
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid := safenest_private.family_user(); result jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('device_id',d.id,
    'name',coalesce(nullif(s.payload->>'room',''),'Monitored home'),
    'camera_name',coalesce(s.payload->>'camera_name','Camera')) order by d.id),'[]'::jsonb)
  into result from safenest_private.members m
  join safenest_private.devices d on d.id=m.device_id and d.enabled
  left join safenest_private.snapshots s on s.device_id=d.id
  where m.user_id=uid;
  return result;
end;
$$;

create or replace function public.redeem_family_invite(p_code text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid := safenest_private.family_user(); inv safenest_private.family_invites%rowtype;
  code_now text := lower(btrim(p_code)); added integer;
begin
  if not safenest_private.family_limit('invite:'||uid::text,10) then
    return jsonb_build_object('ok',false,'error','rate_limited');
  end if;
  if code_now is null or code_now !~ '^[0-9a-f]{32}$' then
    return jsonb_build_object('ok',false,'error','invalid_invite');
  end if;
  -- Row lock makes the usage cap atomic when several relatives redeem at once.
  select * into inv from safenest_private.family_invites
    where code_hash=encode(sha256(convert_to(code_now,'UTF8')),'hex') for update;
  if not found then return jsonb_build_object('ok',false,'error','invalid_invite'); end if;
  if not inv.enabled or inv.expires_at<=clock_timestamp() or inv.uses>=inv.max_uses
    or not exists(select 1 from safenest_private.devices where id=inv.device_id and enabled) then
    return jsonb_build_object('ok',false,'error','invalid_invite');
  end if;
  insert into safenest_private.members(device_id,user_id) values(inv.device_id,uid) on conflict do nothing;
  get diagnostics added = row_count;
  if added=1 then update safenest_private.family_invites set uses=uses+1 where id=inv.id; end if;
  return jsonb_build_object('ok',true,'device_id',inv.device_id,'already_member',added=0);
end;
$$;

create or replace function public.list_care_notes(p_device uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid := safenest_private.family_user(); result jsonb;
begin
  if not exists(select 1 from safenest_private.members m join safenest_private.devices d on d.id=m.device_id
    where m.user_id=uid and m.device_id=p_device and d.enabled) then
    raise exception 'Access denied' using errcode='42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',n.id,'body',n.body,'created_at',n.created_at,
    'author',coalesce(nullif(left(btrim(u.raw_user_meta_data->>'display_name'),80),''),'Family member'),
    'is_mine',n.user_id=uid) order by n.created_at desc,n.id),'[]'::jsonb)
  into result from (select * from safenest_private.care_notes where device_id=p_device
    order by created_at desc,id limit 30) n join auth.users u on u.id=n.user_id;
  return result;
end;
$$;

create or replace function public.add_care_note(p_device uuid,p_body text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid := safenest_private.family_user(); body_now text := btrim(p_body); note_id uuid;
begin
  if not exists(select 1 from safenest_private.members m join safenest_private.devices d on d.id=m.device_id
    where m.user_id=uid and m.device_id=p_device and d.enabled) then
    raise exception 'Access denied' using errcode='42501';
  end if;
  if body_now is null or body_now !~ '[^[:space:]]' or char_length(body_now)>1000 then
    return jsonb_build_object('ok',false,'error','invalid_note');
  end if;
  if not safenest_private.family_limit('note:'||uid::text,5) then
    return jsonb_build_object('ok',false,'error','rate_limited');
  end if;
  insert into safenest_private.care_notes(device_id,user_id,body) values(p_device,uid,body_now)
    returning id into note_id;
  return jsonb_build_object('ok',true,'id',note_id);
end;
$$;

revoke all on function safenest_private.family_user() from public,anon,authenticated;
revoke all on function safenest_private.family_limit(text,integer) from public,anon,authenticated;
revoke all on function public.list_my_monitors() from public,anon,authenticated;
revoke all on function public.redeem_family_invite(text) from public,anon,authenticated;
revoke all on function public.list_care_notes(uuid) from public,anon,authenticated;
revoke all on function public.add_care_note(uuid,text) from public,anon,authenticated;
grant execute on function public.list_my_monitors(),public.redeem_family_invite(text),
  public.list_care_notes(uuid),public.add_care_note(uuid,text) to authenticated;
notify pgrst, 'reload schema';
commit;
