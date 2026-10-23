-- Incremental: run AFTER schema.sql, video_schema.sql and family_schema.sql.
-- Does not modify detector snapshots, event retention, invites or existing notes.
begin;
create table if not exists safenest_private.presence_rooms (
  device_id uuid primary key references safenest_private.devices(id) on delete cascade,
  topic_id uuid not null default gen_random_uuid()
);
create table if not exists safenest_private.family_presence_sessions (
  id uuid primary key,
  device_id uuid not null references safenest_private.devices(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  seen_at timestamptz not null default clock_timestamp()
);
create index if not exists family_presence_device_seen on safenest_private.family_presence_sessions(device_id,seen_at);
alter table safenest_private.presence_rooms enable row level security;
alter table safenest_private.family_presence_sessions enable row level security;
revoke all on safenest_private.presence_rooms,safenest_private.family_presence_sessions from public,anon,authenticated;
insert into safenest_private.presence_rooms(device_id) select id from safenest_private.devices on conflict do nothing;

create or replace function safenest_private.family_display_name(p_meta jsonb)
returns text language sql immutable set search_path='' as $$
  select case when name='' or position('@' in name)>0 then 'Family member' else name end
  from (select left(btrim(regexp_replace(coalesce(p_meta->>'display_name',''),'[[:cntrl:]]','','g')),80) as name) n;
$$;
revoke all on function safenest_private.family_display_name(jsonb) from public,anon,authenticated;

-- Rotate topics on membership/device changes: old cached Realtime joins never
-- receive the new topic. Roster RPCs always recheck current database membership.
create or replace function safenest_private.rotate_family_presence()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_table_name='members' then
    if tg_op in ('UPDATE','DELETE') then
      update safenest_private.presence_rooms set topic_id=gen_random_uuid() where device_id=old.device_id;
      delete from safenest_private.family_presence_sessions where device_id=old.device_id and user_id=old.user_id;
    end if;
    if tg_op in ('INSERT','UPDATE') then
      insert into safenest_private.presence_rooms(device_id) values(new.device_id)
      on conflict(device_id) do update set topic_id=gen_random_uuid();
    end if;
  else
    if tg_op='INSERT' then
      insert into safenest_private.presence_rooms(device_id) values(new.id) on conflict do nothing;
    elsif old.enabled is distinct from new.enabled then
      update safenest_private.presence_rooms set topic_id=gen_random_uuid() where device_id=new.id;
      delete from safenest_private.family_presence_sessions where device_id=new.id;
    end if;
  end if;
  return null;
end;
$$;
revoke all on function safenest_private.rotate_family_presence() from public,anon,authenticated;
drop trigger if exists safenest_presence_members on safenest_private.members;
create trigger safenest_presence_members after insert or update or delete on safenest_private.members
  for each row execute function safenest_private.rotate_family_presence();
drop trigger if exists safenest_presence_devices on safenest_private.devices;
create trigger safenest_presence_devices after insert or update of enabled on safenest_private.devices
  for each row execute function safenest_private.rotate_family_presence();

create or replace function public.can_join_family_presence(p_topic text)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from safenest_private.presence_rooms r
    join safenest_private.devices d on d.id=r.device_id and d.enabled
    join safenest_private.members m on m.device_id=d.id and m.user_id=auth.uid()
    join auth.users u on u.id=m.user_id and (u.banned_until is null or u.banned_until<now())
    where p_topic='safenest-family:'||r.topic_id::text);
$$;
revoke all on function public.can_join_family_presence(text) from public,anon,authenticated;
grant execute on function public.can_join_family_presence(text) to authenticated;

create or replace function public.family_presence(p_device uuid,p_session uuid,p_action text default 'heartbeat')
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=safenest_private.family_user(); roster jsonb; topic_now text; saved uuid;
begin
  if p_session is null or p_action is null or p_action not in ('heartbeat','leave') then
    raise exception 'Invalid presence request';
  end if;
  -- An owner can clean up their old lease even after membership was revoked.
  if p_action='leave' then
    delete from safenest_private.family_presence_sessions where id=p_session and device_id=p_device and user_id=uid;
    return jsonb_build_object('ok',true);
  end if;
  select 'safenest-family:'||r.topic_id::text into topic_now
    from safenest_private.presence_rooms r join safenest_private.devices d on d.id=r.device_id and d.enabled
    join safenest_private.members m on m.device_id=d.id and m.user_id=uid where d.id=p_device;
  if topic_now is null then raise exception 'Access denied' using errcode='42501'; end if;
  if not safenest_private.family_limit('presence:'||uid::text,120) then
    return jsonb_build_object('ok',false,'error','rate_limited');
  end if;
  delete from safenest_private.family_presence_sessions where seen_at<clock_timestamp()-interval '45 seconds';
  insert into safenest_private.family_presence_sessions(id,device_id,user_id,seen_at)
    values(p_session,p_device,uid,clock_timestamp())
    on conflict(id) do update set seen_at=excluded.seen_at
      where safenest_private.family_presence_sessions.user_id=uid and safenest_private.family_presence_sessions.device_id=p_device
    returning id into saved;
  if saved is null then raise exception 'Access denied' using errcode='42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('name',name,'is_mine',user_id=uid) order by name,user_id),'[]'::jsonb)
    into roster from (
      select distinct s.user_id,safenest_private.family_display_name(u.raw_user_meta_data) as name
      from safenest_private.family_presence_sessions s
      join safenest_private.members m on m.device_id=s.device_id and m.user_id=s.user_id
      join auth.users u on u.id=s.user_id and (u.banned_until is null or u.banned_until<clock_timestamp())
      where s.device_id=p_device and s.seen_at>clock_timestamp()-interval '45 seconds'
    ) online;
  return jsonb_build_object('ok',true,'topic',topic_now,'members',roster);
end;
$$;
revoke all on function public.family_presence(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.family_presence(uuid,uuid,text) to authenticated;

-- Existing notes remain intact. Names are labels, never authorization claims.
create or replace function public.list_care_notes(p_device uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=safenest_private.family_user(); result jsonb;
begin
  if not exists(select 1 from safenest_private.members m join safenest_private.devices d on d.id=m.device_id
    where m.user_id=uid and m.device_id=p_device and d.enabled) then
    raise exception 'Access denied' using errcode='42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',n.id,'body',n.body,'created_at',n.created_at,
    'author',safenest_private.family_display_name(u.raw_user_meta_data),'is_mine',n.user_id=uid)
    order by n.created_at desc,n.id),'[]'::jsonb)
  into result from (select * from safenest_private.care_notes where device_id=p_device
    order by created_at desc,id limit 30) n join auth.users u on u.id=n.user_id;
  return result;
end;
$$;
revoke all on function public.list_care_notes(uuid) from public,anon,authenticated;
grant execute on function public.list_care_notes(uuid) to authenticated;

-- Supabase owns realtime.messages and already enables RLS. Only policies are
-- managed here; do NOT ALTER that service-owned table or create objects there.
drop policy if exists safenest_family_presence_read on realtime.messages;
create policy safenest_family_presence_read on realtime.messages for select to authenticated
  using (extension='presence' and public.can_join_family_presence((select realtime.topic())));
drop policy if exists safenest_family_presence_write on realtime.messages;
create policy safenest_family_presence_write on realtime.messages for insert to authenticated
  with check (extension='presence' and public.can_join_family_presence((select realtime.topic())));
-- Restrictive guards keep unrelated permissive project policies from opening
-- SafeNest topics. Other applications' topics are unaffected.
drop policy if exists safenest_family_presence_read_guard on realtime.messages;
create policy safenest_family_presence_read_guard on realtime.messages as restrictive for select to authenticated
  using ((select realtime.topic()) not like 'safenest-family:%'
    or (extension='presence' and public.can_join_family_presence((select realtime.topic()))));
drop policy if exists safenest_family_presence_write_guard on realtime.messages;
create policy safenest_family_presence_write_guard on realtime.messages as restrictive for insert to authenticated
  with check ((select realtime.topic()) not like 'safenest-family:%'
    or (extension='presence' and public.can_join_family_presence((select realtime.topic()))));
drop policy if exists safenest_family_presence_anon_guard on realtime.messages;
create policy safenest_family_presence_anon_guard on realtime.messages as restrictive for all to anon
  using ((select realtime.topic()) not like 'safenest-family:%')
  with check ((select realtime.topic()) not like 'safenest-family:%');
notify pgrst,'reload schema';
commit;
