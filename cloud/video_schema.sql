-- Additive migration AFTER cloud/schema.sql; preserves devices, members and snapshots.
begin;
create table if not exists safenest_private.video_sessions (
  id uuid primary key,
  device_id uuid not null references safenest_private.devices(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  identity text not null unique,
  expires_at timestamptz not null
);
create index if not exists video_session_device_idx on safenest_private.video_sessions(device_id);
create table if not exists safenest_private.video_rate_limits (
  scope text primary key, window_at timestamptz not null, requests integer not null
);
alter table safenest_private.video_sessions enable row level security;
alter table safenest_private.video_rate_limits enable row level security;
revoke all on all tables in schema safenest_private from public,anon,authenticated;

create or replace function safenest_private.video_limit(p_scope text,p_limit integer)
returns void language plpgsql security definer set search_path='' as $$
declare count_now integer;
begin
  insert into safenest_private.video_rate_limits(scope,window_at,requests)
  values(p_scope,clock_timestamp(),1)
  on conflict(scope) do update set
    requests=case when safenest_private.video_rate_limits.window_at < clock_timestamp()-interval '1 minute'
      then 1 else safenest_private.video_rate_limits.requests+1 end,
    window_at=case when safenest_private.video_rate_limits.window_at < clock_timestamp()-interval '1 minute'
      then clock_timestamp() else safenest_private.video_rate_limits.window_at end
  returning requests into count_now;
  if count_now > p_limit then raise exception 'Video request limit exceeded' using errcode='P0001'; end if;
  delete from safenest_private.video_rate_limits where window_at < clock_timestamp()-interval '10 minutes';
end;
$$;
revoke all on function safenest_private.video_limit(text,integer) from public,anon,authenticated;

create or replace function public.video_viewer_session(p_device uuid,p_action text,p_session uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); sid uuid; identity_now text;
begin
  if uid is null then raise exception 'Access denied' using errcode='42501'; end if;
  if p_action not in ('issue','renew','release') or p_action is null then raise exception 'Invalid action'; end if;
  -- Release is allowed for the session owner even after membership was removed.
  if p_action='release' then
    perform safenest_private.video_limit('viewer-'||uid::text||'-release',30);
    delete from safenest_private.video_sessions where id=p_session and device_id=p_device and user_id=uid
      returning identity into identity_now;
    return jsonb_build_object('identity',identity_now);
  end if;
  if not exists(select 1 from safenest_private.members m join safenest_private.devices d on d.id=m.device_id
    where m.user_id=uid and m.device_id=p_device and d.enabled) then
    raise exception 'Access denied' using errcode='42501';
  end if;
  perform safenest_private.video_limit('viewer-'||uid::text||'-'||p_action,case when p_action='issue' then 10 else 30 end);
  delete from safenest_private.video_sessions where expires_at < clock_timestamp();
  if p_action='issue' then
    -- Serialize new leases for this device so concurrent requests cannot exceed the cap.
    perform 1 from safenest_private.devices where id=p_device for update;
    if (select count(*) from safenest_private.video_sessions where device_id=p_device)>=12 then
      raise exception 'Too many video viewers';
    end if;
    sid:=gen_random_uuid();identity_now:='family-'||uid::text||'-'||sid::text;
    insert into safenest_private.video_sessions(id,device_id,user_id,identity,expires_at)
      values(sid,p_device,uid,identity_now,clock_timestamp()+interval '25 seconds');
  else
    sid:=p_session;
    update safenest_private.video_sessions set expires_at=clock_timestamp()+interval '25 seconds'
      where id=sid and device_id=p_device and user_id=uid and expires_at>clock_timestamp()
      returning identity into identity_now;
    if identity_now is null then raise exception 'Video session expired' using errcode='42501'; end if;
  end if;
  return jsonb_build_object('session_id',sid,'identity',identity_now,'lease_seconds',25);
end;
$$;

create or replace function public.video_device_session(p_device uuid,p_token text,p_action text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare viewers jsonb;
begin
  if p_token is null or length(p_token)<32 or length(p_token)>256 or not exists(
    select 1 from safenest_private.devices where id=p_device and enabled
      and token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex')) then
    raise exception 'Invalid device credentials' using errcode='42501';
  end if;
  if p_action not in ('issue','sync') or p_action is null then raise exception 'Invalid action'; end if;
  perform safenest_private.video_limit('device-'||p_device::text||'-'||p_action,case when p_action='issue' then 10 else 60 end);
  select coalesce(jsonb_agg(s.identity),'[]'::jsonb) into viewers
    from safenest_private.video_sessions s
    join safenest_private.members m on m.device_id=s.device_id and m.user_id=s.user_id
    join auth.users u on u.id=s.user_id
    where s.device_id=p_device and s.expires_at>clock_timestamp()
      and (u.banned_until is null or u.banned_until<clock_timestamp());
  return jsonb_build_object('viewers',viewers,'valid_for_seconds',5);
end;
$$;
revoke all on function public.video_viewer_session(uuid,text,uuid) from public,anon,authenticated;
revoke all on function public.video_device_session(uuid,text,text) from public,anon,authenticated;
grant execute on function public.video_viewer_session(uuid,text,uuid) to authenticated;
grant execute on function public.video_device_session(uuid,text,text) to anon;
commit;
