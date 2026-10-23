-- Incremental 11: run AFTER multi_camera_homes.sql. No event/history rewrite.
begin;
create table if not exists safenest_private.fall_alerts (
 id uuid primary key default gen_random_uuid(), home_id uuid not null references safenest_private.homes(id),
 camera_id uuid not null references safenest_private.cameras(id),
 occurred_at timestamptz not null, created_at timestamptz not null default clock_timestamp(), source_event_key text
);
create index if not exists fall_alerts_home_time on safenest_private.fall_alerts(home_id,created_at desc,id);
create table if not exists safenest_private.camera_alert_state (
 camera_id uuid primary key references safenest_private.cameras(id),
 active_alert uuid references safenest_private.fall_alerts(id), last_observed timestamptz not null
);
create table if not exists safenest_private.fall_alert_views (
 alert_id uuid not null references safenest_private.fall_alerts(id),
 user_id uuid not null references auth.users(id), viewed_at timestamptz not null default clock_timestamp(),
 primary key(alert_id,user_id)
);
create table if not exists safenest_private.push_subscriptions (
 id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id),
 endpoint_hash text not null unique, endpoint text not null,p256dh text not null,auth_key text not null,
 application_key text not null, enabled boolean not null default true,
 updated_at timestamptz not null default clock_timestamp()
);
create table if not exists safenest_private.home_push_preferences (
 home_id uuid not null references safenest_private.homes(id),user_id uuid not null references auth.users(id),
 subscription_id uuid not null references safenest_private.push_subscriptions(id),enabled boolean not null default true,
 primary key(home_id,user_id,subscription_id)
);
create table if not exists safenest_private.fall_push_jobs (
 id uuid primary key default gen_random_uuid(),alert_id uuid not null references safenest_private.fall_alerts(id),
 home_id uuid not null references safenest_private.homes(id),subscription_id uuid not null references safenest_private.push_subscriptions(id),
 notification_key text not null default replace(gen_random_uuid()::text,'-',''),
 state text not null default 'pending' check(state in ('pending','preparing','sending','retry','sent','unknown','cancelled','expired','failed')),
 attempts integer not null default 0,claim uuid, lease_until timestamptz,
 next_attempt timestamptz not null default clock_timestamp(),expires_at timestamptz not null default clock_timestamp()+interval '2 minutes',
 result_code text, unique(alert_id,subscription_id)
);
create index if not exists fall_push_ready on safenest_private.fall_push_jobs(state,next_attempt);
alter table safenest_private.fall_alerts enable row level security;
alter table safenest_private.camera_alert_state enable row level security;
alter table safenest_private.fall_alert_views enable row level security;
alter table safenest_private.push_subscriptions enable row level security;
alter table safenest_private.home_push_preferences enable row level security;
alter table safenest_private.fall_push_jobs enable row level security;
revoke all on safenest_private.fall_alerts,safenest_private.camera_alert_state,safenest_private.fall_alert_views,
 safenest_private.push_subscriptions,safenest_private.home_push_preferences,safenest_private.fall_push_jobs from public,anon,authenticated;

-- This trigger runs inside the existing device-authenticated publisher transaction.
-- Monotonic, fresh observations create SERVER episodes; old event arrays cannot.
create or replace function safenest_private.capture_fall_alert()
returns trigger language plpgsql security definer set search_path='' as $$
declare stamp timestamptz; moment timestamptz:=clock_timestamp(); scope uuid; active uuid; previous timestamptz; event_key text; alert_now uuid;
begin
 if new.payload->'demo' is distinct from 'false'::jsonb or new.payload->'stale' is distinct from 'false'::jsonb
 or new.payload->'camera_connected' is distinct from 'true'::jsonb then return new;end if;
 -- Reject timezone-less, malformed, future or delayed observations for notifications.
 if coalesce(new.payload->>'observed_at','') !~ '^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:\d{2})$' then return new;end if;
 begin stamp:=(new.payload->>'observed_at')::timestamptz;exception when others then return new;end;
 if stamp<moment-interval '15 seconds' or stamp>moment+interval '5 seconds'
 or new.received_at<moment-interval '15 seconds' then return new;end if;
 select c.home_id into scope from safenest_private.cameras c
 join safenest_private.devices d on d.id=c.device_id and d.enabled
 join safenest_private.devices h on h.id=c.home_id and h.enabled where c.id=new.camera_id and c.enabled;
 if scope is null then return new;end if;
 select active_alert,last_observed into active,previous from safenest_private.camera_alert_state where camera_id=new.camera_id for update;
 if previous is not null and stamp<=previous then return new;end if;
 if new.payload->>'status'='Suspected Fall' and active is null then
  -- Optional matching event provenance; never trust a historical event as a trigger.
  for event_key in select value->>'id' from jsonb_array_elements(coalesce(new.payload->'events','[]'))
   where value->>'status' ~ '^(Person [1-9][0-9]*: )?Suspected Fall$' and value->>'time'=new.payload->>'observed_at' limit 1 loop exit;end loop;
  insert into safenest_private.fall_alerts(home_id,camera_id,occurred_at,source_event_key)
  values(scope,new.camera_id,stamp,event_key) returning id into active;
  insert into safenest_private.fall_push_jobs(alert_id,home_id,subscription_id)
  select active,scope,s.id from safenest_private.home_push_preferences p
  join safenest_private.push_subscriptions s on s.id=p.subscription_id and s.user_id=p.user_id and s.enabled
  join safenest_private.members m on m.device_id=p.home_id and m.user_id=p.user_id
  join auth.users u on u.id=m.user_id and (u.banned_until is null or u.banned_until<clock_timestamp())
  where p.home_id=scope and p.enabled on conflict do nothing;
 elsif new.payload->>'status' in ('Normal','Resting in Bed') then
  -- Uncertainty, absence, occlusion, offline periods and Person changes do NOT
  -- confirm recovery/re-arm a notification episode. Detector logic is untouched.
  active:=null;
 end if;
 insert into safenest_private.camera_alert_state values(new.camera_id,active,stamp)
 on conflict(camera_id) do update set active_alert=excluded.active_alert,last_observed=excluded.last_observed;
 return new;
end; $$;
revoke all on function safenest_private.capture_fall_alert() from public,anon,authenticated;
drop trigger if exists capture_fall_alert on safenest_private.camera_snapshots;
create trigger capture_fall_alert after insert or update on safenest_private.camera_snapshots
 for each row execute function safenest_private.capture_fall_alert();
-- Deliberately no historical backfill or resend on migration/rerun.

create or replace function public.list_fall_alerts(p_home uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=safenest_private.require_home_member(p_home); result jsonb; unseen bigint;
begin
 select count(*) into unseen from safenest_private.fall_alerts a where a.home_id=p_home
 and not exists(select 1 from safenest_private.fall_alert_views v where v.alert_id=a.id and v.user_id=uid);
 select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'camera_id',a.camera_id,'camera_name',c.name,
 'occurred_at',a.occurred_at,'created_at',a.created_at,
 'current',coalesce(st.active_alert=a.id and c.enabled and d.enabled and s.received_at>clock_timestamp()-interval '15 seconds'
 and st.last_observed>clock_timestamp()-interval '15 seconds' and s.payload->>'status'='Suspected Fall' and s.payload->'stale'='false'::jsonb
 and s.payload->'demo'='false'::jsonb and s.payload->'camera_connected'='true'::jsonb,false),
 'viewed_by_me',exists(select 1 from safenest_private.fall_alert_views v where v.alert_id=a.id and v.user_id=uid),
 'views',coalesce((select jsonb_agg(jsonb_build_object('name',safenest_private.family_display_name(u.raw_user_meta_data),
 'viewed_at',v.viewed_at,'is_mine',v.user_id=uid) order by v.viewed_at)
 from safenest_private.fall_alert_views v join auth.users u on u.id=v.user_id where v.alert_id=a.id),'[]'::jsonb)) order by a.created_at desc,a.id),'[]'::jsonb)
 into result from (select * from safenest_private.fall_alerts where home_id=p_home order by created_at desc,id limit 30) a
 join safenest_private.cameras c on c.id=a.camera_id join safenest_private.devices d on d.id=c.device_id
 left join safenest_private.camera_alert_state st on st.camera_id=c.id
 left join safenest_private.camera_snapshots s on s.camera_id=c.id;
 return jsonb_build_object('alerts',result,'unviewed_count',unseen);
end; $$;
-- A notification carries only an opaque delivery key. Resolution is private to
-- its subscribed account and rechecks CURRENT Home membership after login.
create or replace function public.open_fall_notification(p_key text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=safenest_private.family_user(); target safenest_private.fall_push_jobs%rowtype;
begin
 select j.* into target from safenest_private.fall_push_jobs j
 join safenest_private.push_subscriptions s on s.id=j.subscription_id and s.user_id=uid
 where j.notification_key=p_key;
 if not found then raise exception 'Access denied' using errcode='42501';end if;
 perform safenest_private.require_home_member(target.home_id);
 return jsonb_build_object('home_id',target.home_id,'alert_id',target.alert_id);
end; $$;
create or replace function public.acknowledge_fall_alert(p_home uuid,p_alert uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=safenest_private.require_home_member(p_home);
begin
 perform 1 from safenest_private.devices where id=p_home for update;
 uid:=safenest_private.require_home_member(p_home);
 if not exists(select 1 from safenest_private.fall_alerts where id=p_alert and home_id=p_home) then raise exception 'Access denied' using errcode='42501';end if;
 if not safenest_private.family_limit('fall-view:'||uid::text,60) then return jsonb_build_object('ok',false,'error','rate_limited');end if;
 insert into safenest_private.fall_alert_views(alert_id,user_id) values(p_alert,uid) on conflict do nothing;
 return jsonb_build_object('ok',true);
end; $$;

create or replace function public.family_push_status(p_home uuid,p_endpoint text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=safenest_private.require_home_member(p_home); sub safenest_private.push_subscriptions%rowtype;
begin
 select * into sub from safenest_private.push_subscriptions where user_id=uid and enabled
 and endpoint_hash=encode(sha256(convert_to(coalesce(p_endpoint,''),'UTF8')),'hex');
 return jsonb_build_object('owned',sub.id is not null,'enabled',exists(select 1 from safenest_private.home_push_preferences
 where home_id=p_home and user_id=uid and subscription_id=sub.id and enabled));
end; $$;
create or replace function public.register_family_push(p_home uuid,p_subscription jsonb,p_application_key text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=safenest_private.require_home_member(p_home); ep text:=p_subscription->>'endpoint';
 dh text:=p_subscription->'keys'->>'p256dh'; secret text:=p_subscription->'keys'->>'auth'; sub safenest_private.push_subscriptions%rowtype; hashed text;
begin
 perform 1 from safenest_private.devices where id=p_home for update;uid:=safenest_private.require_home_member(p_home);
 if ep is null or length(ep)>2048 or ep !~ '^https://(fcm[.]googleapis[.]com|updates[.]push[.]services[.]mozilla[.]com|web[.]push[.]apple[.]com)/[^[:space:]#]+$'
 or coalesce(dh,'') !~ '^[A-Za-z0-9_-]{87}$' or coalesce(secret,'') !~ '^[A-Za-z0-9_-]{22}$'
 or coalesce(p_application_key,'') !~ '^[A-Za-z0-9_-]{87}$' then return jsonb_build_object('ok',false,'error','invalid_subscription');end if;
 if not safenest_private.family_limit('push-register:'||uid::text,20) then return jsonb_build_object('ok',false,'error','rate_limited');end if;
 hashed:=encode(sha256(convert_to(ep,'UTF8')),'hex');
 select * into sub from safenest_private.push_subscriptions where endpoint_hash=hashed for update;
 if sub.id is not null and sub.user_id<>uid then return jsonb_build_object('ok',false,'error','invalid_subscription');end if;
 if sub.id is null and (select count(*) from safenest_private.push_subscriptions where user_id=uid and enabled)>=10 then
 return jsonb_build_object('ok',false,'error','subscription_limit');end if;
 insert into safenest_private.push_subscriptions(user_id,endpoint_hash,endpoint,p256dh,auth_key,application_key)
 values(uid,hashed,ep,dh,secret,p_application_key) on conflict(endpoint_hash) do update
 set endpoint=excluded.endpoint,p256dh=excluded.p256dh,auth_key=excluded.auth_key,application_key=excluded.application_key,enabled=true,updated_at=clock_timestamp()
 where safenest_private.push_subscriptions.user_id=uid returning id into sub.id;
 if sub.id is null then return jsonb_build_object('ok',false,'error','invalid_subscription');end if;
 insert into safenest_private.home_push_preferences values(p_home,uid,sub.id,true)
 on conflict(home_id,user_id,subscription_id) do update set enabled=true;
 -- New subscriptions never cause replay of old alerts.
 return jsonb_build_object('ok',true);
end; $$;
create or replace function public.disable_family_push(p_home uuid,p_endpoint text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=safenest_private.require_home_member(p_home);
begin
 perform 1 from safenest_private.devices where id=p_home for update;uid:=safenest_private.require_home_member(p_home);
 update safenest_private.home_push_preferences p set enabled=false from safenest_private.push_subscriptions s
 where p.home_id=p_home and p.user_id=uid and p.subscription_id=s.id and s.user_id=uid
 and s.endpoint_hash=encode(sha256(convert_to(coalesce(p_endpoint,''),'UTF8')),'hex');
 update safenest_private.fall_push_jobs j set state='cancelled' from safenest_private.push_subscriptions s
 where j.home_id=p_home and j.subscription_id=s.id and s.user_id=uid
 and s.endpoint_hash=encode(sha256(convert_to(coalesce(p_endpoint,''),'UTF8')),'hex') and j.state in ('pending','retry','preparing');
 return jsonb_build_object('ok',true);
end; $$;
-- Own-browser cleanup is allowed even after the last Home membership is revoked.
create or replace function public.remove_my_push_subscription(p_endpoint text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=safenest_private.family_user(); sid uuid;
begin
 update safenest_private.push_subscriptions set enabled=false,endpoint='',p256dh='',auth_key='',updated_at=clock_timestamp()
 where user_id=uid and endpoint_hash=encode(sha256(convert_to(coalesce(p_endpoint,''),'UTF8')),'hex') returning id into sid;
 update safenest_private.home_push_preferences set enabled=false where user_id=uid and subscription_id=sid;
 update safenest_private.fall_push_jobs set state='cancelled' where subscription_id=sid and state in ('pending','retry','preparing');
 return jsonb_build_object('ok',true);
end; $$;
create or replace function safenest_private.revoke_family_notifications()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 update safenest_private.home_push_preferences set enabled=false where home_id=old.device_id and user_id=old.user_id;
 update safenest_private.fall_push_jobs j set state='cancelled' from safenest_private.push_subscriptions s
 where j.home_id=old.device_id and s.id=j.subscription_id and s.user_id=old.user_id and j.state in ('pending','retry','preparing');
 return old;
end; $$;
revoke all on function safenest_private.revoke_family_notifications() from public,anon,authenticated;
drop trigger if exists revoke_family_notifications on safenest_private.members;
create trigger revoke_family_notifications after delete on safenest_private.members
 for each row execute function safenest_private.revoke_family_notifications();

-- Service-role-only queue API. No endpoint/recipient list is available to users.
create or replace function safenest_private.push_job_eligible(j safenest_private.fall_push_jobs,p_key text)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from safenest_private.push_subscriptions s
 join safenest_private.home_push_preferences p on p.subscription_id=s.id and p.user_id=s.user_id and p.home_id=j.home_id and p.enabled
 join safenest_private.members m on m.device_id=p.home_id and m.user_id=p.user_id
 join auth.users u on u.id=m.user_id and (u.banned_until is null or u.banned_until<clock_timestamp())
 join safenest_private.devices h on h.id=j.home_id and h.enabled
 join safenest_private.fall_alerts a on a.id=j.alert_id and a.home_id=j.home_id
 join safenest_private.cameras c on c.id=a.camera_id and c.enabled and c.home_id=a.home_id
 join safenest_private.devices d on d.id=c.device_id and d.enabled
 where s.id=j.subscription_id and s.enabled and s.application_key=p_key)
$$;
revoke all on function safenest_private.push_job_eligible(safenest_private.fall_push_jobs,text) from public,anon,authenticated;
create or replace function public.claim_fall_push(p_application_key text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare candidate safenest_private.fall_push_jobs%rowtype; job safenest_private.fall_push_jobs%rowtype;
begin
 -- Every queue mutation uses Home -> job lock order, also on lease expiry.
 -- Never automatically replay an interrupted send: its outcome is unknown.
 for candidate in select * from safenest_private.fall_push_jobs where
 (state in ('pending','retry') and next_attempt<=clock_timestamp()) or
 (state in ('preparing','sending') and lease_until<clock_timestamp()) order by next_attempt,id limit 100 loop
  perform 1 from safenest_private.devices where id=candidate.home_id for update;
  select * into job from safenest_private.fall_push_jobs where id=candidate.id and
  ((state in ('pending','retry') and next_attempt<=clock_timestamp()) or
   (state in ('preparing','sending') and lease_until<clock_timestamp())) for update skip locked;
  if not found then continue;end if;
  if job.state='sending' then
   update safenest_private.fall_push_jobs set state='unknown',result_code='interrupted' where id=job.id;continue;
  end if;
  if job.expires_at<=clock_timestamp() then update safenest_private.fall_push_jobs set state='expired' where id=job.id;continue;end if;
  if not safenest_private.push_job_eligible(job,p_application_key) then update safenest_private.fall_push_jobs set state='cancelled' where id=job.id;continue;end if;
  update safenest_private.fall_push_jobs set state='preparing',claim=gen_random_uuid(),lease_until=clock_timestamp()+interval '30 seconds'
  where id=job.id returning * into job;
  return jsonb_build_object('id',job.id,'claim',job.claim);
 end loop;
 return null;
end; $$;
create or replace function public.begin_fall_push(p_job uuid,p_claim uuid,p_application_key text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare job safenest_private.fall_push_jobs%rowtype; scope uuid; sub safenest_private.push_subscriptions%rowtype;
begin
 select home_id into scope from safenest_private.fall_push_jobs where id=p_job;
 perform 1 from safenest_private.devices where id=scope for update;
 select * into job from safenest_private.fall_push_jobs where id=p_job and claim=p_claim and state='preparing' and lease_until>clock_timestamp() for update;
 if not found then return null;end if;
 if job.expires_at<=clock_timestamp() or not safenest_private.push_job_eligible(job,p_application_key) then
 update safenest_private.fall_push_jobs set state='cancelled' where id=job.id;return null;end if;
 update safenest_private.fall_push_jobs set state='sending',attempts=attempts+1,lease_until=clock_timestamp()+interval '30 seconds' where id=job.id;
 select * into sub from safenest_private.push_subscriptions where id=job.subscription_id;
 return jsonb_build_object('endpoint',sub.endpoint,'keys',jsonb_build_object('p256dh',sub.p256dh,'auth',sub.auth_key),'notification_key',job.notification_key);
end; $$;
create or replace function public.finish_fall_push(p_job uuid,p_claim uuid,p_result text)
returns void language plpgsql security definer set search_path='' as $$
declare job safenest_private.fall_push_jobs%rowtype;
begin
 if p_result not in ('sent','gone','retry','failed','unknown') then raise exception 'Invalid result';end if;
 select * into job from safenest_private.fall_push_jobs where id=p_job and claim=p_claim and state='sending' for update;
 if not found then return;end if;
 update safenest_private.fall_push_jobs set state=case when p_result='gone' then 'failed'
 when p_result='retry' and (attempts>=3 or expires_at<=clock_timestamp()) then 'failed' else p_result end,
 result_code=p_result,next_attempt=clock_timestamp()+interval '20 seconds' where id=job.id;
 if p_result='gone' then update safenest_private.push_subscriptions set enabled=false,endpoint='',p256dh='',auth_key='' where id=job.subscription_id;end if;
end; $$;
revoke all on function public.open_fall_notification(text),public.list_fall_alerts(uuid),public.acknowledge_fall_alert(uuid,uuid),public.family_push_status(uuid,text),
 public.register_family_push(uuid,jsonb,text),public.disable_family_push(uuid,text),public.remove_my_push_subscription(text) from public,anon,authenticated;
grant execute on function public.open_fall_notification(text),public.list_fall_alerts(uuid),public.acknowledge_fall_alert(uuid,uuid),public.family_push_status(uuid,text),
 public.register_family_push(uuid,jsonb,text),public.disable_family_push(uuid,text),public.remove_my_push_subscription(text) to authenticated;
revoke all on function public.claim_fall_push(text),public.begin_fall_push(uuid,uuid,text),public.finish_fall_push(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.claim_fall_push(text),public.begin_fall_push(uuid,uuid,text),public.finish_fall_push(uuid,uuid,text) to service_role;
notify pgrst,'reload schema';
commit;
