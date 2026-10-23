-- Incremental: run AFTER device_claim.sql (and its earlier prerequisites).
-- No table rewrite, no deletion of existing notes, snapshots or event history.
begin;
alter table safenest_private.care_notes enable row level security;
revoke all on safenest_private.care_notes from public,anon,authenticated;

-- Display labels only, never authority. Check the full input before truncating;
-- do not accidentally reveal an email/UUID supplied as a display name.
create or replace function safenest_private.family_display_name(p_meta jsonb)
returns text language sql immutable set search_path='' as $$
  select case when name='' or position('@' in name)>0
    or name ~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
    then 'Family member' else left(name,80) end
  from (select btrim(regexp_replace(case when jsonb_typeof(p_meta->'display_name')='string'
    then p_meta->>'display_name' else '' end,'[[:cntrl:]]','','g')) as name) n;
$$;
revoke all on function safenest_private.family_display_name(jsonb) from public,anon,authenticated;

create or replace function safenest_private.require_note_member(p_device uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare uid uuid:=safenest_private.family_user();
begin
  if not exists(select 1 from safenest_private.members m join safenest_private.devices d on d.id=m.device_id
      where m.device_id=p_device and m.user_id=uid and d.enabled) then
    raise exception 'Access denied' using errcode='42501';
  end if;
  return uid;
end;
$$;
revoke all on function safenest_private.require_note_member(uuid) from public,anon,authenticated;

create or replace function public.list_care_notes(p_device uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=safenest_private.require_note_member(p_device); result jsonb; manager_now boolean;
begin
  select exists(select 1 from safenest_private.device_managers where device_id=p_device and user_id=uid) into manager_now;
  select coalesce(jsonb_agg(jsonb_build_object('id',n.id,'body',n.body,'created_at',n.created_at,
    'author',safenest_private.family_display_name(u.raw_user_meta_data),'is_mine',n.user_id=uid,
    'can_delete',n.user_id=uid or manager_now) order by n.created_at desc,n.id),'[]'::jsonb)
  into result from (select * from safenest_private.care_notes where device_id=p_device
    order by created_at desc,id limit 30) n join auth.users u on u.id=n.user_id;
  -- Note IDs identify actions; author user IDs/emails never leave this RPC.
  return result;
end;
$$;

create or replace function public.add_care_note(p_device uuid,p_body text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=safenest_private.require_note_member(p_device); body_now text:=btrim(p_body); note_id uuid;
begin
  -- Coordinate with the existing member-revocation/device mutation lock order.
  perform 1 from safenest_private.devices where id=p_device for update;
  uid:=safenest_private.require_note_member(p_device);
  if body_now is null or body_now !~ '[^[:space:]]' or char_length(body_now)>1000 then
    return jsonb_build_object('ok',false,'error','invalid_note');
  end if;
  if not safenest_private.family_limit('note:'||uid::text,5) then
    return jsonb_build_object('ok',false,'error','rate_limited');
  end if;
  -- No author/identity arguments. Name is derived on read from this Auth user.
  insert into safenest_private.care_notes(device_id,user_id,body) values(p_device,uid,body_now) returning id into note_id;
  return jsonb_build_object('ok',true,'id',note_id);
end;
$$;

create or replace function public.delete_care_note(p_device uuid,p_note uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=safenest_private.require_note_member(p_device); removed integer;
begin
  perform 1 from safenest_private.devices where id=p_device for update;
  uid:=safenest_private.require_note_member(p_device);
  if not safenest_private.family_limit('note-delete:'||uid::text,20) then
    return jsonb_build_object('ok',false,'error','rate_limited');
  end if;
  delete from safenest_private.care_notes n where n.id=p_note and n.device_id=p_device
    and (n.user_id=uid or exists(select 1 from safenest_private.device_managers a
      where a.device_id=p_device and a.user_id=uid));
  get diagnostics removed=row_count;
  -- Same response for a missing note, another home or insufficient note rights.
  if removed=0 then return jsonb_build_object('ok',false,'error','note_unavailable'); end if;
  return jsonb_build_object('ok',true);
end;
$$;
revoke all on function public.list_care_notes(uuid),public.add_care_note(uuid,text),
  public.delete_care_note(uuid,uuid) from public,anon,authenticated;
grant execute on function public.list_care_notes(uuid),public.add_care_note(uuid,text),
  public.delete_care_note(uuid,uuid) to authenticated;
notify pgrst,'reload schema';
commit;
