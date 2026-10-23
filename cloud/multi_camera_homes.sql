-- Incremental: AFTER home_identity.sql. Keep legacy tables, IDs and event data.
begin;
lock table safenest_private.devices in share row exclusive mode;
create table if not exists safenest_private.homes (
 id uuid primary key references safenest_private.devices(id),
 home_number bigint not null unique,
 name text not null default 'Monitored home' check(char_length(name) between 1 and 80)
);
create table if not exists safenest_private.home_devices (
 device_id uuid primary key references safenest_private.devices(id),
 home_id uuid not null references safenest_private.homes(id), unique(device_id,home_id)
);
create table if not exists safenest_private.cameras (
 id uuid primary key default gen_random_uuid(),
 home_id uuid not null references safenest_private.homes(id),
 device_id uuid not null references safenest_private.devices(id),
 local_key text check(local_key ~ '^[0-9a-f]{64}$'),
 name text not null check(char_length(name) between 1 and 80),
 source_type text not null default 'local' check(source_type='local'),
 enabled boolean not null default true,
 is_default boolean not null default false,
 unique(device_id,local_key),
 foreign key(device_id,home_id) references safenest_private.home_devices(device_id,home_id)
);
create unique index if not exists cameras_one_default on safenest_private.cameras(device_id) where is_default;
create table if not exists safenest_private.camera_snapshots (
 camera_id uuid primary key references safenest_private.cameras(id),
 received_at timestamptz not null, payload jsonb not null
);
create table if not exists safenest_private.camera_events (
 camera_id uuid not null references safenest_private.cameras(id),
 event_key text not null, event_time timestamptz not null, payload jsonb not null,
 primary key(camera_id,event_key)
);
create index if not exists camera_events_time on safenest_private.camera_events(event_time desc);
create table if not exists safenest_private.camera_setup_codes (
 id uuid primary key default gen_random_uuid(), home_id uuid not null references safenest_private.homes(id),
 code_hash text not null unique check(code_hash ~ '^[0-9a-f]{64}$'),
 expires_at timestamptz not null, used_at timestamptz, enabled boolean not null default true,
 created_by uuid not null references auth.users(id), created_at timestamptz not null default clock_timestamp()
);
create table if not exists safenest_private.home_migration_state(version integer primary key);
alter table safenest_private.home_migration_state enable row level security;
-- No renumbering and no merging of existing homes, even on migration reruns.
insert into safenest_private.homes(id,home_number,name)
 select d.id,d.home_number,coalesce(nullif(s.payload->>'room',''),'Monitored home')
 from safenest_private.devices d left join safenest_private.snapshots s on s.device_id=d.id
 where not exists(select 1 from safenest_private.home_devices hd where hd.device_id=d.id)
 and not exists(select 1 from safenest_private.home_migration_state where version=1)
 on conflict(id) do nothing;
insert into safenest_private.home_devices select id,id from safenest_private.homes on conflict do nothing;
insert into safenest_private.home_migration_state values(1) on conflict do nothing;
insert into safenest_private.cameras(home_id,device_id,name,is_default)
 select hd.home_id,d.id,coalesce(nullif(s.payload->>'camera_name',''),'Camera'),true
 from safenest_private.devices d join safenest_private.home_devices hd on hd.device_id=d.id
 left join safenest_private.snapshots s on s.device_id=d.id
 where not exists(select 1 from safenest_private.cameras c where c.device_id=d.id);
insert into safenest_private.camera_snapshots
 select c.id,s.received_at,s.payload from safenest_private.cameras c
 join safenest_private.snapshots s on s.device_id=c.device_id where c.is_default and c.local_key is null
 on conflict do nothing;
alter table safenest_private.video_sessions add column if not exists camera_id uuid references safenest_private.cameras(id);
create index if not exists video_sessions_camera on safenest_private.video_sessions(camera_id);
alter table safenest_private.homes enable row level security;
alter table safenest_private.home_devices enable row level security;
alter table safenest_private.cameras enable row level security;
alter table safenest_private.camera_snapshots enable row level security;
alter table safenest_private.camera_events enable row level security;
alter table safenest_private.camera_setup_codes enable row level security;
revoke all on all tables in schema safenest_private from public,anon,authenticated;

create or replace function safenest_private.fixed_home_identity()
returns trigger language plpgsql set search_path='' as $$
begin
 if new.id is distinct from old.id or new.home_number is distinct from old.home_number then raise exception 'Home number is fixed' using errcode='23514';end if;return new;
end; $$;
revoke all on function safenest_private.fixed_home_identity() from public,anon,authenticated;
drop trigger if exists fixed_home_identity on safenest_private.homes;
create trigger fixed_home_identity before update on safenest_private.homes for each row execute function safenest_private.fixed_home_identity();
-- Memberships/manager roles/notes/presence/invitations stay on the immutable Home
-- anchor (the old device UUID). A physical host is NEVER a new family identity.
create or replace function safenest_private.require_home_member(p_home uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare uid uuid:=safenest_private.family_user();
begin
 if not exists(select 1 from safenest_private.homes h join safenest_private.devices a on a.id=h.id and a.enabled
 join safenest_private.members m on m.device_id=h.id and m.user_id=uid where h.id=p_home) then
 raise exception 'Access denied' using errcode='42501'; end if;
 return uid;
end; $$;
create or replace function safenest_private.require_camera_member(p_camera uuid,p_device uuid default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare home_now uuid;
begin
 select c.home_id into home_now from safenest_private.cameras c join safenest_private.devices d on d.id=c.device_id and d.enabled
 where c.id=p_camera and c.enabled and (p_device is null or c.device_id=p_device);
 if home_now is null then raise exception 'Access denied' using errcode='42501'; end if;
 perform safenest_private.require_home_member(home_now);
 return home_now;
end; $$;
create or replace function safenest_private.ensure_device_home(p_device uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare home_now uuid;
begin
 select home_id into home_now from safenest_private.home_devices where device_id=p_device;
 if home_now is not null then return home_now; end if;
 insert into safenest_private.homes(id,home_number)
 select id,home_number from safenest_private.devices where id=p_device;
 insert into safenest_private.home_devices values(p_device,p_device);
 insert into safenest_private.cameras(home_id,device_id,name,is_default) values(p_device,p_device,'Camera',true);
 return p_device;
end; $$;
-- Prevent new physical hosts from acquiring a second membership/manager namespace.
create or replace function safenest_private.check_home_anchor()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from safenest_private.home_devices where device_id=new.device_id and home_id<>new.device_id) then
 raise exception 'Use Home membership' using errcode='42501'; end if;
 perform safenest_private.ensure_device_home(new.device_id);return new;
end; $$;
drop trigger if exists safenest_home_anchor on safenest_private.members;
create trigger safenest_home_anchor before insert or update on safenest_private.members
 for each row execute function safenest_private.check_home_anchor();

create or replace function public.list_my_monitors()
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=safenest_private.family_user(); result jsonb;
begin
 select coalesce(jsonb_agg(jsonb_build_object('device_id',h.id,'home_id',h.id,
 'home_code',safenest_private.home_code(h.home_number),'name',h.name,
 'can_manage',exists(select 1 from safenest_private.device_managers a where a.device_id=h.id and a.user_id=uid),
 'camera_count',(select count(*) from safenest_private.cameras c where c.home_id=h.id and c.enabled)) order by h.home_number),'[]')
 into result from safenest_private.homes h join safenest_private.devices d on d.id=h.id and d.enabled
 join safenest_private.members m on m.device_id=h.id and m.user_id=uid;
 return result;
end; $$;

create or replace function public.device_setup_info(p_device uuid,p_token text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 perform safenest_private.lock_claim_device(p_device,p_token);
 select jsonb_build_object('home_id',h.id,'home_code',safenest_private.home_code(h.home_number),'home_name',h.name)
 into result from safenest_private.homes h join safenest_private.home_devices hd on hd.home_id=h.id where hd.device_id=p_device;
 return jsonb_build_object('ok',true,'device_id',p_device)||coalesce(result,'{}');
end; $$;

create or replace function public.create_camera_setup_code(p_home uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=safenest_private.require_device_manager(p_home); code_now text; code_id uuid; expiry timestamptz;
begin
 perform 1 from safenest_private.devices where id=p_home for update;
 uid:=safenest_private.require_device_manager(p_home);perform safenest_private.require_home_member(p_home);
 if not safenest_private.family_limit('camera-setup-create:'||uid::text,5) then return jsonb_build_object('ok',false,'error','rate_limited');end if;
 if (select count(*) from safenest_private.camera_setup_codes where home_id=p_home and enabled and used_at is null and expires_at>clock_timestamp())>=10 then
 return jsonb_build_object('ok',false,'error','too_many_codes');end if;
 code_now:='sn-camera-'||replace(gen_random_uuid()::text,'-','');expiry:=clock_timestamp()+interval '10 minutes';
 insert into safenest_private.camera_setup_codes(home_id,code_hash,expires_at,created_by)
 values(p_home,encode(sha256(convert_to(code_now,'UTF8')),'hex'),expiry,uid) returning id into code_id;
 return jsonb_build_object('ok',true,'setup_code',code_now,'code_id',code_id,'expires_at',expiry);
end; $$;
create or replace function public.list_camera_setup_codes(p_home uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform safenest_private.require_device_manager(p_home);perform safenest_private.require_home_member(p_home);
 return (select coalesce(jsonb_agg(jsonb_build_object('id',id,'expires_at',expires_at,'used',used_at is not null,'enabled',enabled) order by created_at desc),'[]')
 from (select * from safenest_private.camera_setup_codes where home_id=p_home order by created_at desc limit 30) s);
end; $$;
create or replace function public.revoke_camera_setup_code(p_home uuid,p_code uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform safenest_private.require_device_manager(p_home);
 perform 1 from safenest_private.devices where id=p_home for update;
 perform safenest_private.require_device_manager(p_home);
 update safenest_private.camera_setup_codes set enabled=false where id=p_code and home_id=p_home;
 return jsonb_build_object('ok',true);
end; $$;
create or replace function public.pair_camera_device(p_device uuid,p_token text,p_code text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare inv safenest_private.camera_setup_codes%rowtype; code_now text:=lower(btrim(p_code));
begin
 perform safenest_private.lock_claim_device(p_device,p_token);
 if not safenest_private.family_limit('camera-pair:'||p_device::text,10) then return jsonb_build_object('ok',false,'error','rate_limited');end if;
 if code_now is null or code_now !~ '^sn-camera-[0-9a-f]{32}$' then return jsonb_build_object('ok',false,'error','invalid_setup');end if;
 select * into inv from safenest_private.camera_setup_codes where code_hash=encode(sha256(convert_to(code_now,'UTF8')),'hex');
 if not found then return jsonb_build_object('ok',false,'error','invalid_setup');end if;
 perform 1 from safenest_private.devices where id=inv.home_id and enabled for update;
 if not found then return jsonb_build_object('ok',false,'error','invalid_setup');end if;
 select * into inv from safenest_private.camera_setup_codes where id=inv.id for update;
 if not inv.enabled or inv.used_at is not null or inv.expires_at<=clock_timestamp()
 or not exists(select 1 from safenest_private.device_managers a join auth.users u on u.id=a.user_id
 where a.device_id=inv.home_id and a.user_id=inv.created_by and (u.banned_until is null or u.banned_until<clock_timestamp()))
 or exists(select 1 from safenest_private.home_devices where device_id=p_device)
 or exists(select 1 from safenest_private.members where device_id=p_device)
 or exists(select 1 from safenest_private.device_claims where device_id=p_device and assigned_at is not null) then
 return jsonb_build_object('ok',false,'error','invalid_setup');end if;
 insert into safenest_private.home_devices values(p_device,inv.home_id);
 insert into safenest_private.device_claims(device_id,assigned_at) values(p_device,clock_timestamp())
 on conflict(device_id) do update set assigned_at=clock_timestamp(),code_hash=null,expires_at=null;
 update safenest_private.camera_setup_codes set used_at=clock_timestamp() where id=inv.id;
 return jsonb_build_object('ok',true,'device_id',p_device,'home_id',inv.home_id);
end; $$;
create or replace function public.register_camera(p_device uuid,p_token text,p_key text,p_name text,p_room text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare home_now uuid; cam uuid; title text:=btrim(p_name);
begin
 perform safenest_private.lock_claim_device(p_device,p_token);
 select home_id into home_now from safenest_private.home_devices where device_id=p_device;
 if home_now is null then return jsonb_build_object('ok',false,'error','pairing_required');end if;
 if p_key is null or p_key !~ '^[0-9a-f]{64}$' or title is null or char_length(title) not between 1 and 80 or title ~ '[[:cntrl:]]' then
 return jsonb_build_object('ok',false,'error','invalid_camera');end if;
 if p_room is not null and (char_length(btrim(p_room)) not between 1 and 80 or p_room ~ '[[:cntrl:]]') then return jsonb_build_object('ok',false,'error','invalid_camera');end if;
 if not safenest_private.family_limit('camera-register:'||p_device::text,30) then return jsonb_build_object('ok',false,'error','rate_limited');end if;
 select id into cam from safenest_private.cameras where device_id=p_device and local_key=p_key;
 if cam is null then
 select id into cam from safenest_private.cameras where device_id=p_device and is_default and local_key is null;
 if cam is not null then update safenest_private.cameras set local_key=p_key,name=title where id=cam;
 else
 if (select count(*) from safenest_private.cameras where device_id=p_device)>=16 then return jsonb_build_object('ok',false,'error','camera_limit');end if;
 insert into safenest_private.cameras(home_id,device_id,local_key,name,is_default)
 values(home_now,p_device,p_key,title,not exists(select 1 from safenest_private.cameras where device_id=p_device)) returning id into cam;
 end if;
 else update safenest_private.cameras set name=title where id=cam;
 end if;
 if p_device=home_now and p_room is not null and exists(select 1 from safenest_private.cameras where id=cam and is_default) then update safenest_private.homes set name=btrim(p_room) where id=home_now;end if;
 return jsonb_build_object('ok',true,'camera_id',cam,'device_id',p_device,'home_id',home_now,
 'is_default',(select is_default from safenest_private.cameras where id=cam),
 'home_code',(select safenest_private.home_code(home_number) from safenest_private.homes where id=home_now));
end; $$;
create or replace function public.set_home_camera_enabled(p_home uuid,p_camera uuid,p_enabled boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform safenest_private.require_device_manager(p_home);
 perform 1 from safenest_private.devices where id=p_home for update;
 perform safenest_private.require_device_manager(p_home);
 if p_enabled is null then raise exception 'Invalid request';end if;
 update safenest_private.cameras set enabled=p_enabled where id=p_camera and home_id=p_home;
 if not found then raise exception 'Access denied' using errcode='42501';end if;
 if not p_enabled then delete from safenest_private.video_sessions where camera_id=p_camera;end if;
 return jsonb_build_object('ok',true);
end; $$;

create or replace function safenest_private.archive_camera_events(p_camera uuid,p_payload jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare ev jsonb; stamp timestamptz;
begin
 for ev in select value from jsonb_array_elements(coalesce(p_payload->'events','[]')) loop
 begin stamp:=(ev->>'time')::timestamptz;exception when others then continue;end;
 if stamp is null then continue;end if;
 insert into safenest_private.camera_events(camera_id,event_key,event_time,payload)
 values(p_camera,coalesce(nullif(ev->>'id',''),encode(sha256(convert_to(ev::text,'UTF8')),'hex')),stamp,ev)
 on conflict do nothing;
 end loop;
end; $$;
select safenest_private.archive_camera_events(camera_id,payload) from safenest_private.camera_snapshots;
create or replace function safenest_private.publish_device_metadata(p_device uuid, p_token text, p_payload jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  clean_events jsonb;
  clean_payload jsonb;
  clean_context jsonb;
  clean_people jsonb;
  person jsonb;
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
     'Starting','Camera Offline','AI Offline','Connection Lost',
     'Check Person','Tracking Lost','Resting in Bed') then
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
    'width_height_ratio',left(item->>'width_height_ratio',20),
    'reason',left(item->>'reason',160)) order by ordinal), '[]'::jsonb)
    into clean_events
    from jsonb_array_elements(p_payload->'events') with ordinality as e(item, ordinal);
  -- Optional additive metadata. Legacy publishers remain accepted unchanged.
  if p_payload ? 'context' and p_payload->'context' <> 'null'::jsonb then
    if jsonb_typeof(p_payload->'context') is distinct from 'object'
      or jsonb_typeof(p_payload->'context'->'people') is distinct from 'array' then
      raise exception 'Invalid context metadata';
    end if;
    if jsonb_array_length(p_payload->'context'->'people') > 16 then
      raise exception 'Too many context summaries';
    end if;
    if coalesce(p_payload->'context'->>'visible_count','') !~ '^[0-9]{1,4}$'
      or coalesce(p_payload->'context'->>'missing_count','') !~ '^[0-9]{1,4}$' then
      raise exception 'Invalid context counts';
    end if;
    for person in select value from jsonb_array_elements(p_payload->'context'->'people') loop
      if jsonb_typeof(person) is distinct from 'object'
        or coalesce(person->>'person_number','') !~ '^[1-9][0-9]{0,8}$'
        or jsonb_typeof(person->'visible') is distinct from 'boolean'
        or coalesce(person->>'state','') not in
          ('ACTIVE','LOWERING','RESTING_IN_BED','POSSIBLE_FALL','CHECK_PERSON','TRACKING_LOST','RECOVERED')
        or coalesce(person->>'zone','') not in ('inside','outside','boundary','unknown') then
        raise exception 'Invalid person summary';
      end if;
    end loop;
    select coalesce(jsonb_agg(jsonb_build_object(
      'person_number',(item->>'person_number')::integer, 'visible',item->'visible',
      'state',item->>'state','zone',item->>'zone',
      'baseline_status',left(item->>'baseline_status',32),'reason',left(item->>'reason',160)
    ) order by ordinal),'[]'::jsonb) into clean_people
    from jsonb_array_elements(p_payload->'context'->'people') with ordinality as e(item,ordinal);
    clean_context := jsonb_build_object('people',clean_people,
      'calibration',left(p_payload->'context'->>'calibration',160),
      'visible_count',(p_payload->'context'->>'visible_count')::integer,
      'missing_count',(p_payload->'context'->>'missing_count')::integer);
  end if;
  -- Whitelist fields; arbitrary blobs/frames/extra keys cannot reach the table.
  clean_payload := jsonb_build_object(
    'schema_version',1, 'status',p_payload->>'status',
    'observed_at',left(p_payload->>'observed_at',50),
    'room',left(p_payload->>'room',80), 'camera_name',left(p_payload->>'camera_name',80),
    'camera_connected',p_payload->'camera_connected', 'stale',p_payload->'stale',
    'demo',false, 'events',clean_events);
  if clean_context is not null then
    clean_payload := clean_payload || jsonb_build_object('context',clean_context);
  end if;
  insert into safenest_private.snapshots(device_id, received_at, payload)
    values(p_device, clock_timestamp(), clean_payload)
    on conflict(device_id) do update
      set received_at = excluded.received_at, payload = excluded.payload;
end;
$$;


create or replace function public.publish_camera_monitor(p_device uuid,p_token text,p_camera uuid,p_payload jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare clean jsonb; home_now uuid;
begin
 perform safenest_private.lock_claim_device(p_device,p_token);
 select home_id into home_now from safenest_private.cameras where id=p_camera and device_id=p_device and enabled;
 if home_now is null or not exists(select 1 from safenest_private.devices where id=home_now and enabled) then
 raise exception 'Access denied' using errcode='42501';end if;
 -- Reuse the exact existing whitelist/validation; no image fields are accepted.
 perform safenest_private.publish_device_metadata(p_device,p_token,p_payload);
 select payload into clean from safenest_private.snapshots where device_id=p_device;
 insert into safenest_private.camera_snapshots values(p_camera,clock_timestamp(),clean)
 on conflict(camera_id) do update set received_at=excluded.received_at,payload=excluded.payload;
 perform safenest_private.archive_camera_events(p_camera,clean);
end; $$;
create or replace function public.read_camera(p_camera uuid,p_device uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare home_now uuid; result jsonb;
begin
 home_now:=safenest_private.require_camera_member(p_camera,p_device);
 select jsonb_build_object('server_now',clock_timestamp(),'received_at',s.received_at,'payload',s.payload,'camera_transport','livekit')
 into result from safenest_private.camera_snapshots s where s.camera_id=p_camera;
 return coalesce(result,jsonb_build_object('server_now',clock_timestamp(),'received_at',null,'payload',null,'camera_transport','livekit'));
end; $$;
create or replace function public.read_home_cameras(p_home uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 perform safenest_private.require_home_member(p_home);
 select coalesce(jsonb_agg(jsonb_build_object('camera_id',c.id,'device_id',c.device_id,'name',c.name,
 'enabled',c.enabled,'legacy_video',c.is_default and c.local_key is null,'source_type',c.source_type,'server_now',clock_timestamp(),
 'received_at',case when d.enabled and c.enabled then coalesce(s.received_at,legacy.received_at) end,
 'payload',case when d.enabled and c.enabled then coalesce(s.payload,legacy.payload) end) order by c.name,c.id),'[]') into result
 from safenest_private.cameras c join safenest_private.devices d on d.id=c.device_id
 left join safenest_private.camera_snapshots s on s.camera_id=c.id
 left join safenest_private.snapshots legacy on legacy.device_id=c.device_id and c.is_default and c.local_key is null and s.camera_id is null
 where c.home_id=p_home;
 return result;
end; $$;
create or replace function public.list_home_events(p_home uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform safenest_private.require_home_member(p_home);
 return (select coalesce(jsonb_agg(payload||jsonb_build_object('camera_name',name,'camera_id',camera_id) order by event_time desc,camera_id,event_key),'[]')
 from (select e.*,c.name from safenest_private.camera_events e join safenest_private.cameras c on c.id=e.camera_id
 where c.home_id=p_home order by e.event_time desc,e.camera_id,e.event_key limit 10) recent);
end; $$;
-- Legacy read permission resolves the host through the Home, never its own members.
create or replace function public.read_monitor(p_device uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare cam uuid;
begin
 select id into cam from safenest_private.cameras where device_id=p_device and is_default;
 return public.read_camera(cam,p_device);
end; $$;
-- Revocation cleans EVERY host/camera lease, and old private topics rotate via the
-- existing membership trigger. Pending setup codes are invalidated as well.
create or replace function safenest_private.cleanup_removed_family_member()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 perform 1 from safenest_private.devices where id=old.device_id for update;
 delete from safenest_private.video_sessions where user_id=old.user_id and device_id in
 (select device_id from safenest_private.home_devices where home_id=old.device_id);
 update safenest_private.family_invites set enabled=false where device_id=old.device_id and enabled;
 update safenest_private.camera_setup_codes set enabled=false where home_id=old.device_id and enabled;
 return null;
end; $$;

create or replace function public.publish_monitor(p_device uuid,p_token text,p_payload jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare clean jsonb; cam uuid;
begin
 perform safenest_private.publish_device_metadata(p_device,p_token,p_payload);
 select payload into clean from safenest_private.snapshots where device_id=p_device;
 select id into cam from safenest_private.cameras where device_id=p_device and is_default and enabled;
 if cam is not null then
 insert into safenest_private.camera_snapshots values(cam,clock_timestamp(),clean)
 on conflict(camera_id) do update set received_at=excluded.received_at,payload=excluded.payload;
 perform safenest_private.archive_camera_events(cam,clean);
 end if;
 update safenest_private.homes set name=coalesce(nullif(clean->>'room',''),name) where id=p_device;
end; $$;
create or replace function public.issue_device_claim(p_device uuid,p_token text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare code_now text; expiry timestamptz;
begin
  perform safenest_private.lock_claim_device(p_device,p_token);
  if exists(select 1 from safenest_private.device_claims where device_id=p_device and assigned_at is not null)
    or exists(select 1 from safenest_private.device_managers where device_id=p_device) then
    return jsonb_build_object('ok',false,'error','claim_unavailable');
  end if;
  if not safenest_private.family_limit('claim-issue:'||p_device::text,5) then
    return jsonb_build_object('ok',false,'error','rate_limited');
  end if;
  perform safenest_private.ensure_device_home(p_device);
  code_now:='sn-claim-'||replace(gen_random_uuid()::text,'-','');
  expiry:=clock_timestamp()+interval '10 minutes';
  insert into safenest_private.device_claims(device_id,code_hash,expires_at)
    values(p_device,encode(sha256(convert_to(code_now,'UTF8')),'hex'),expiry)
    on conflict(device_id) do update set code_hash=excluded.code_hash,expires_at=excluded.expires_at;
  return jsonb_build_object('ok',true,'claim_code',code_now,'expires_at',expiry,'ttl_seconds',600);
end;
$$;

create or replace function public.video_viewer_session(p_device uuid,p_action text,p_session uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=safenest_private.family_user(); sid uuid; identity_now text;
begin
  if p_action not in ('issue','renew','release') or p_action is null then raise exception 'Invalid action'; end if;
  if p_action='release' then
    perform safenest_private.video_limit('viewer-'||uid::text||'-release',30);
    delete from safenest_private.video_sessions where id=p_session and device_id=p_device and camera_id is null and user_id=uid returning identity into identity_now;
    return jsonb_build_object('identity',identity_now);
  end if;
  -- Reject unrelated requests before taking a device lock, then check again.
  if not exists(select 1 from safenest_private.members m join safenest_private.home_devices hd on hd.home_id=m.device_id where m.user_id=uid and hd.device_id=p_device) then
    raise exception 'Access denied' using errcode='42501';
  end if;
  perform 1 from safenest_private.devices where id=p_device for update;
  if not exists(select 1 from safenest_private.members m join safenest_private.home_devices hd on hd.home_id=m.device_id join safenest_private.devices d on d.id=hd.device_id
    where m.user_id=uid and hd.device_id=p_device and d.enabled) then
    raise exception 'Access denied' using errcode='42501';
  end if;
  perform safenest_private.require_home_member((select home_id from safenest_private.home_devices where device_id=p_device));
  perform safenest_private.require_camera_member((select id from safenest_private.cameras where device_id=p_device and is_default),p_device);
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
      where id=sid and device_id=p_device and camera_id is null and user_id=uid and expires_at>clock_timestamp() returning identity into identity_now;
    if identity_now is null then raise exception 'Video session expired' using errcode='42501'; end if;
  end if;
  return jsonb_build_object('session_id',sid,'identity',identity_now,'lease_seconds',25);
end;
$$;


create or replace function public.camera_viewer_session(p_device uuid,p_camera uuid,p_action text,p_session uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=safenest_private.family_user(); home_now uuid; sid uuid; identity_now text;
begin
 if p_action is null or p_action not in ('issue','renew','release') then raise exception 'Invalid action';end if;
 if p_action='release' then
 delete from safenest_private.video_sessions where id=p_session and device_id=p_device and camera_id=p_camera and user_id=uid returning identity into identity_now;
 return jsonb_build_object('identity',identity_now);end if;
 home_now:=safenest_private.require_camera_member(p_camera,p_device);
 perform 1 from safenest_private.devices where id=home_now for update;
 perform safenest_private.require_camera_member(p_camera,p_device);
 perform safenest_private.video_limit('viewer-'||uid::text||'-'||p_action,case when p_action='issue' then 10 else 30 end);
 delete from safenest_private.video_sessions where expires_at<clock_timestamp();
 if p_action='issue' then
 if (select count(*) from safenest_private.video_sessions where camera_id=p_camera)>=12 then raise exception 'Too many video viewers';end if;
 sid:=gen_random_uuid();identity_now:='family-'||uid::text||'-'||sid::text;
 insert into safenest_private.video_sessions(id,device_id,camera_id,user_id,identity,expires_at)
 values(sid,p_device,p_camera,uid,identity_now,clock_timestamp()+interval '25 seconds');
 else
 update safenest_private.video_sessions set expires_at=clock_timestamp()+interval '25 seconds'
 where id=p_session and camera_id=p_camera and device_id=p_device and user_id=uid and expires_at>clock_timestamp() returning id,identity into sid,identity_now;
 if identity_now is null then raise exception 'Video session expired' using errcode='42501';end if;
 end if;
 return jsonb_build_object('session_id',sid,'identity',identity_now,'lease_seconds',25);
end; $$;
create or replace function public.camera_device_session(p_device uuid,p_token text,p_camera uuid,p_action text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare home_now uuid; viewers jsonb;
begin
 perform safenest_private.lock_claim_device(p_device,p_token);
 select home_id into home_now from safenest_private.cameras where id=p_camera and device_id=p_device and enabled;
 if home_now is null or not exists(select 1 from safenest_private.devices where id=home_now and enabled) then raise exception 'Access denied' using errcode='42501';end if;
 if p_action is null or p_action not in ('issue','sync') then raise exception 'Invalid action';end if;
 perform safenest_private.video_limit('camera-'||p_camera::text||'-'||p_action,case when p_action='issue' then 10 else 60 end);
 select coalesce(jsonb_agg(s.identity),'[]') into viewers from safenest_private.video_sessions s
 join safenest_private.members m on m.device_id=home_now and m.user_id=s.user_id
 join auth.users u on u.id=s.user_id and (u.banned_until is null or u.banned_until<clock_timestamp())
 where s.camera_id=p_camera and s.device_id=p_device and s.expires_at>clock_timestamp();
 return jsonb_build_object('viewers',viewers,'valid_for_seconds',5);
end; $$;
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
    join safenest_private.home_devices hd on hd.device_id=s.device_id
    join safenest_private.devices a on a.id=hd.home_id and a.enabled
    join safenest_private.members m on m.device_id=hd.home_id and m.user_id=s.user_id
    join auth.users u on u.id=s.user_id
    where exists(select 1 from safenest_private.cameras c where c.device_id=p_device and c.is_default and c.enabled)
      and s.device_id=p_device and s.camera_id is null and s.expires_at>clock_timestamp()
      and (u.banned_until is null or u.banned_until<clock_timestamp());
  return jsonb_build_object('viewers',viewers,'valid_for_seconds',5);
end;
$$;
revoke all on function safenest_private.publish_device_metadata(uuid,text,jsonb) from public,anon,authenticated;
revoke all on function safenest_private.require_home_member(uuid) from public,anon,authenticated;
revoke all on function safenest_private.require_camera_member(uuid,uuid) from public,anon,authenticated;
revoke all on function safenest_private.ensure_device_home(uuid) from public,anon,authenticated;
revoke all on function safenest_private.check_home_anchor() from public,anon,authenticated;
revoke all on function safenest_private.archive_camera_events(uuid,jsonb) from public,anon,authenticated;
revoke all on function public.create_camera_setup_code(uuid) from public,anon,authenticated;
grant execute on function public.create_camera_setup_code(uuid) to authenticated;
revoke all on function public.list_camera_setup_codes(uuid) from public,anon,authenticated;
grant execute on function public.list_camera_setup_codes(uuid) to authenticated;
revoke all on function public.revoke_camera_setup_code(uuid,uuid) from public,anon,authenticated;
grant execute on function public.revoke_camera_setup_code(uuid,uuid) to authenticated;
revoke all on function public.set_home_camera_enabled(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.set_home_camera_enabled(uuid,uuid,boolean) to authenticated;
revoke all on function public.read_camera(uuid,uuid) from public,anon,authenticated;
grant execute on function public.read_camera(uuid,uuid) to authenticated;
revoke all on function public.read_home_cameras(uuid) from public,anon,authenticated;
grant execute on function public.read_home_cameras(uuid) to authenticated;
revoke all on function public.list_home_events(uuid) from public,anon,authenticated;
grant execute on function public.list_home_events(uuid) to authenticated;
revoke all on function public.camera_viewer_session(uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.camera_viewer_session(uuid,uuid,text,uuid) to authenticated;
revoke all on function public.pair_camera_device(uuid,text,text) from public,anon,authenticated;
grant execute on function public.pair_camera_device(uuid,text,text) to anon;
revoke all on function public.register_camera(uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function public.register_camera(uuid,text,text,text,text) to anon;
revoke all on function public.publish_camera_monitor(uuid,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.publish_camera_monitor(uuid,text,uuid,jsonb) to anon;
revoke all on function public.camera_device_session(uuid,text,uuid,text) from public,anon,authenticated;
grant execute on function public.camera_device_session(uuid,text,uuid,text) to anon;
notify pgrst,'reload schema';
commit;
