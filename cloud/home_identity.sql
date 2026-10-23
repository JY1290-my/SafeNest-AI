-- Incremental: run AFTER care_note_management.sql. Existing device IDs and data stay intact.
begin;
lock table safenest_private.devices in share row exclusive mode;
create sequence if not exists safenest_private.home_numbers as bigint minvalue 1 no cycle;
revoke all on sequence safenest_private.home_numbers from public,anon,authenticated;
alter table safenest_private.devices add column if not exists home_number bigint;
-- Never rewind the sequence or reassign a number on reruns.
do $$
declare maximum bigint; current_number bigint; item record;
begin
  select max(home_number) into maximum from safenest_private.devices;
  select last_value into current_number from safenest_private.home_numbers;
  if maximum>current_number then perform setval('safenest_private.home_numbers',maximum,true); end if;
  for item in select id from safenest_private.devices where home_number is null order by id for update loop
    update safenest_private.devices set home_number=nextval('safenest_private.home_numbers') where id=item.id;
  end loop;
end;
$$;
alter table safenest_private.devices alter column home_number set not null;
create unique index if not exists devices_home_number_unique on safenest_private.devices(home_number);

create or replace function safenest_private.assign_home_number()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='INSERT' then new.home_number:=nextval('safenest_private.home_numbers');
  elsif new.home_number is distinct from old.home_number then
    raise exception 'Home number is fixed' using errcode='23514';
  end if;
  return new;
end;
$$;
revoke all on function safenest_private.assign_home_number() from public,anon,authenticated;
drop trigger if exists safenest_assign_home_number on safenest_private.devices;
create trigger safenest_assign_home_number before insert or update on safenest_private.devices
  for each row execute function safenest_private.assign_home_number();
create or replace function safenest_private.home_code(p_number bigint)
returns text language sql immutable set search_path='' as $$
  select 'Home-'||lpad(p_number::text,greatest(3,length(p_number::text)),'0');
$$;
revoke all on function safenest_private.home_code(bigint) from public,anon,authenticated;

create or replace function public.list_my_monitors()
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=safenest_private.family_user(); result jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('device_id',d.id,
    'home_code',safenest_private.home_code(d.home_number),
    'name',coalesce(nullif(s.payload->>'room',''),'Monitored home'),
    'camera_name',coalesce(s.payload->>'camera_name','Camera'),
    'can_manage',exists(select 1 from safenest_private.device_managers a where a.device_id=d.id and a.user_id=uid))
    order by d.home_number),'[]'::jsonb) into result
    from safenest_private.members m join safenest_private.devices d on d.id=m.device_id and d.enabled
    left join safenest_private.snapshots s on s.device_id=d.id where m.user_id=uid;
  return result;
end;
$$;

create or replace function public.device_setup_info(p_device uuid,p_token text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare code_now text;
begin
  -- Existing device credential verification; no account/device enumeration.
  perform safenest_private.lock_claim_device(p_device,p_token);
  select safenest_private.home_code(home_number) into code_now from safenest_private.devices where id=p_device;
  return jsonb_build_object('ok',true,'device_id',p_device,'home_code',code_now);
end;
$$;
revoke all on function public.list_my_monitors(),public.device_setup_info(uuid,text) from public,anon,authenticated;
grant execute on function public.list_my_monitors() to authenticated;
grant execute on function public.device_setup_info(uuid,text) to anon;
notify pgrst,'reload schema';
commit;
