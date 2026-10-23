-- Run once in the Supabase SQL editor. No video fields, no Storage bucket.
begin;
create schema if not exists safenest_private;
revoke all on schema safenest_private from public, anon, authenticated;
create table if not exists safenest_private.devices (
  id uuid primary key,
  token_hash text not null check (length(token_hash) = 64),
  enabled boolean not null default true
);
create table if not exists safenest_private.members (
  device_id uuid not null references safenest_private.devices(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  primary key (device_id, user_id)
);
create table if not exists safenest_private.snapshots (
  device_id uuid primary key references safenest_private.devices(id) on delete cascade,
  received_at timestamptz not null default now(),
  payload jsonb not null
);
alter table safenest_private.devices enable row level security;
alter table safenest_private.members enable row level security;
alter table safenest_private.snapshots enable row level security;
-- No direct client grants or policies: all browser access goes through checked RPCs.
revoke all on all tables in schema safenest_private from public, anon, authenticated;

create or replace function public.publish_monitor(p_device uuid, p_token text, p_payload jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  clean_events jsonb;
  clean_payload jsonb;
begin
  if p_token is null or length(p_token) < 32 or length(p_token) > 256 then
    raise exception 'Invalid device credentials' using errcode = '42501';
  end if;
  if not exists (
    select 1 from safenest_private.devices d
    where d.id = p_device and d.enabled
      and d.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
  ) then
    raise exception 'Invalid device credentials' using errcode = '42501';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object'
     or octet_length(p_payload::text) > 20000 then
    raise exception 'Invalid metadata payload';
  end if;
  if (p_payload->>'status') is null or (p_payload->>'status') not in
    ('Normal','Checking','Suspected Fall','No Person','Multiple People','Pose Unclear',
     'Starting','Camera Offline','AI Offline','Connection Lost') then
    raise exception 'Unknown detector state';
  end if;
  if jsonb_typeof(p_payload->'camera_connected') is distinct from 'boolean'
     or jsonb_typeof(p_payload->'stale') is distinct from 'boolean'
     or p_payload->'demo' is distinct from 'false'::jsonb
     or jsonb_typeof(p_payload->'events') is distinct from 'array' then
    raise exception 'Invalid metadata fields (demo publishing is disabled)';
  end if;
  if jsonb_array_length(p_payload->'events') > 30 then
    raise exception 'At most 30 recent events permitted';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',left(item->>'id',64), 'time',left(item->>'time',50),
    'status',left(item->>'status',40), 'angle_deg',left(item->>'angle_deg',20),
    'width_height_ratio',left(item->>'width_height_ratio',20)) order by ordinal), '[]'::jsonb)
    into clean_events
    from jsonb_array_elements(p_payload->'events') with ordinality as e(item, ordinal);
  -- Whitelist fields; arbitrary blobs/frames/extra keys cannot reach the table.
  clean_payload := jsonb_build_object(
    'schema_version',1, 'status',p_payload->>'status',
    'observed_at',left(p_payload->>'observed_at',50),
    'room',left(p_payload->>'room',80), 'camera_name',left(p_payload->>'camera_name',80),
    'camera_connected',p_payload->'camera_connected', 'stale',p_payload->'stale',
    'demo',false, 'events',clean_events);
  insert into safenest_private.snapshots(device_id, received_at, payload)
    values(p_device, clock_timestamp(), clean_payload)
    on conflict(device_id) do update
      set received_at = excluded.received_at, payload = excluded.payload;
end;
$$;

create or replace function public.read_monitor(p_device uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  if auth.uid() is null or not exists (
    select 1 from safenest_private.members m
    join safenest_private.devices d on d.id = m.device_id
    where m.device_id = p_device and m.user_id = auth.uid() and d.enabled
  ) then
    raise exception 'Camera access denied' using errcode = '42501';
  end if;
  select jsonb_build_object('server_now',clock_timestamp(), 'received_at',s.received_at,
                           'payload',s.payload,'camera_transport','none')
    into result from safenest_private.snapshots s where s.device_id = p_device;
  return coalesce(result, jsonb_build_object('server_now',clock_timestamp(),
                  'received_at',null,'payload',null,'camera_transport','none'));
end;
$$;
revoke all on function public.publish_monitor(uuid,text,jsonb) from public, anon, authenticated;
revoke all on function public.read_monitor(uuid) from public, anon, authenticated;
grant execute on function public.publish_monitor(uuid,text,jsonb) to anon;
grant execute on function public.read_monitor(uuid) to authenticated;
commit;
