-- Incremental: run AFTER family_management.sql. No existing data is removed.
begin;
-- assigned_at is a durable no-reclaim marker, NOT a live count of managers.
create table if not exists safenest_private.device_claims (
  device_id uuid primary key references safenest_private.devices(id) on delete cascade,
  code_hash text unique check (code_hash is null or code_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz,
  assigned_at timestamptz,
  check ((code_hash is null) = (expires_at is null)),
  check (assigned_at is null or code_hash is null)
);
alter table safenest_private.device_claims enable row level security;
revoke all on safenest_private.device_claims from public,anon,authenticated;
insert into safenest_private.device_claims(device_id,assigned_at)
  select device_id,min(granted_at) from safenest_private.device_managers group by device_id
  on conflict(device_id) do update set assigned_at=coalesce(device_claims.assigned_at,excluded.assigned_at),code_hash=null,expires_at=null;

-- Covers the claim RPC AND operator/manual grants. Removing a manager never
-- clears this marker. Recovery/transfer remains a trusted SQL operator action.
create or replace function safenest_private.mark_device_assigned()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  perform 1 from safenest_private.devices where id=new.device_id for update;
  insert into safenest_private.device_claims(device_id,assigned_at) values(new.device_id,clock_timestamp())
    on conflict(device_id) do update set assigned_at=coalesce(device_claims.assigned_at,excluded.assigned_at),code_hash=null,expires_at=null;
  return new;
end;
$$;
revoke all on function safenest_private.mark_device_assigned() from public,anon,authenticated;
drop trigger if exists safenest_mark_device_assigned on safenest_private.device_managers;
create trigger safenest_mark_device_assigned before insert or update on safenest_private.device_managers
  for each row execute function safenest_private.mark_device_assigned();

create or replace function safenest_private.lock_claim_device(p_device uuid,p_token text)
returns void language plpgsql security definer set search_path='' as $$
begin
  if p_token is null or length(p_token) not between 32 and 256 then
    raise exception 'Access denied' using errcode='42501';
  end if;
  -- Untrusted requests cannot lock arbitrary device rows.
  perform 1 from safenest_private.devices where id=p_device and enabled
    and token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex') for update;
  if not found then raise exception 'Access denied' using errcode='42501'; end if;
end;
$$;
revoke all on function safenest_private.lock_claim_device(uuid,text) from public,anon,authenticated;

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
  code_now:='sn-claim-'||replace(gen_random_uuid()::text,'-','');
  expiry:=clock_timestamp()+interval '10 minutes';
  insert into safenest_private.device_claims(device_id,code_hash,expires_at)
    values(p_device,encode(sha256(convert_to(code_now,'UTF8')),'hex'),expiry)
    on conflict(device_id) do update set code_hash=excluded.code_hash,expires_at=excluded.expires_at;
  return jsonb_build_object('ok',true,'claim_code',code_now,'expires_at',expiry,'ttl_seconds',600);
end;
$$;

create or replace function public.cancel_device_claim(p_device uuid,p_token text,p_code_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform safenest_private.lock_claim_device(p_device,p_token);
  -- A late cancellation must never invalidate a replacement code.
  update safenest_private.device_claims set code_hash=null,expires_at=null
    where device_id=p_device and code_hash=p_code_hash and assigned_at is null;
  return jsonb_build_object('ok',true);
end;
$$;

create or replace function public.redeem_device_claim(p_code text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=safenest_private.family_user(); code_now text:=lower(btrim(p_code));
  hash_now text; device_now uuid; claim safenest_private.device_claims%rowtype;
begin
  -- Return denials normally so the attempt counter commits.
  if not safenest_private.family_limit('claim-redeem:'||uid::text,10) then
    return jsonb_build_object('ok',false,'error','rate_limited');
  end if;
  if code_now is null or code_now !~ '^sn-claim-[0-9a-f]{32}$' then
    return jsonb_build_object('ok',false,'error','invalid_claim');
  end if;
  hash_now:=encode(sha256(convert_to(code_now,'UTF8')),'hex');
  select device_id into device_now from safenest_private.device_claims where code_hash=hash_now;
  if not found then return jsonb_build_object('ok',false,'error','invalid_claim'); end if;
  -- All claim/manager mutations lock device first; only one account can win.
  perform 1 from safenest_private.devices where id=device_now and enabled for update;
  if not found then return jsonb_build_object('ok',false,'error','invalid_claim'); end if;
  select * into claim from safenest_private.device_claims where device_id=device_now for update;
  if not found or claim.code_hash is distinct from hash_now or claim.assigned_at is not null
    or claim.expires_at is null or claim.expires_at<=clock_timestamp()
    or exists(select 1 from safenest_private.device_managers where device_id=device_now) then
    return jsonb_build_object('ok',false,'error','invalid_claim');
  end if;
  insert into safenest_private.members(device_id,user_id) values(device_now,uid) on conflict do nothing;
  insert into safenest_private.device_managers(device_id,user_id) values(device_now,uid);
  -- Trigger consumes the code and sets assigned_at in this same transaction.
  return jsonb_build_object('ok',true,'device_id',device_now);
end;
$$;
revoke all on function public.issue_device_claim(uuid,text),public.cancel_device_claim(uuid,text,text),
  public.redeem_device_claim(text) from public,anon,authenticated;
grant execute on function public.issue_device_claim(uuid,text),public.cancel_device_claim(uuid,text,text) to anon;
grant execute on function public.redeem_device_claim(text) to authenticated;
notify pgrst,'reload schema';
commit;
