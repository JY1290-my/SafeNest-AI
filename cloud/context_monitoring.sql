-- Run AFTER existing base/video/family/website migrations. No table or data changes.
begin;
create or replace function public.publish_monitor(p_device uuid, p_token text, p_payload jsonb)
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

revoke all on function public.publish_monitor(uuid,text,jsonb) from public, anon, authenticated;
grant execute on function public.publish_monitor(uuid,text,jsonb) to anon;
notify pgrst, 'reload schema';
commit;
