import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {PGlite} from '../video_frontend/node_modules/@electric-sql/pglite/dist/index.js';
const [D,E]=[1,2].map(n=>`10000000-0000-4000-8000-00000000000${n}`);
const [A,B,C]=[1,2,3].map(n=>`20000000-0000-4000-8000-00000000000${n}`),TOKEN='test-only-device-token-12345678901234567890',KEY='B'.repeat(87);
const stack=['schema','video_schema','family_schema','website_improvements','context_monitoring','family_management','device_claim','care_note_management','home_identity','multi_camera_homes'];
const migration=await readFile(new URL('../cloud/fall_notifications.sql',import.meta.url),'utf8');
const subscription=name=>({endpoint:'https://fcm.googleapis.com/wp/'+name,keys:{p256dh:'B'.repeat(87),auth:'a'.repeat(22)}});
test('incremental notifications: real SQL, device publishers, Home authorization and private queue',async t=>{
 const db=new PGlite(),call=async(fn,args=[]) => (await db.query('select '+fn+' as data',args)).rows[0].data;
 const admin=()=>db.exec('reset role'),user=async(id=A,role='authenticated')=>{await db.exec('reset role;set role '+role);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id||'']);};
 const worker=()=>user(null,'service_role'),clearLimits=async()=>{await admin();await db.exec('delete from safenest_private.family_limits');};
 let cam,other,stamp=Date.now(),alert1,alert2,job;
 const payload=(status='Suspected Fall',extra={})=>({status,observed_at:new Date(stamp=Math.max(stamp+1,Date.now())).toISOString(),camera_connected:true,stale:false,demo:false,events:[],room:'Bedroom',camera_name:'Camera',...extra});
 const publish=async(p,c=cam,d=D)=>{await user(null,'anon');return call('public.publish_camera_monitor($1,$2,$3,$4)',[d,TOKEN,c,p]);};
 const alerts=async(home=D,id=A)=>{await user(id);return call('public.list_fall_alerts($1)',[home]);};
 const register=async(id,name,home=D)=>{await user(id);return call('public.register_family_push($1,$2,$3)',[home,subscription(name),KEY]);};
 const count=async table=>{await admin();return call('(select count(*) from safenest_private.'+table+')');};
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
  create table auth.users(id uuid primary key,banned_until timestamptz,raw_user_meta_data jsonb default '{}');
  create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
  grant usage on schema auth to authenticated;create schema realtime;create table realtime.messages(extension text);
  alter table realtime.messages enable row level security;create function realtime.topic() returns text language sql as $$select ''::text$$;`);
  for(const f of stack)await db.exec(await readFile(new URL('../cloud/'+f+'.sql',import.meta.url),'utf8'));
  for(const [id,name] of [[A,'Ka Ying'],[B,'person@example.com'],[C,'Other Home']])await db.query('insert into auth.users(id,raw_user_meta_data) values($1,$2)',[id,{display_name:name,role:'admin'}]);
  for(const d of [D,E])await db.query("insert into safenest_private.devices(id,token_hash) values($1,encode(sha256(convert_to($2,'UTF8')),'hex'))",[d,TOKEN]);
  for(const [d,id] of [[D,A],[D,B],[E,C]])await db.query('insert into safenest_private.members values($1,$2)',[d,id]);
  await db.query('insert into safenest_private.device_managers(device_id,user_id) values($1,$2)',[D,A]);
  await db.exec(await readFile(new URL('../cloud/multi_camera_homes.sql',import.meta.url),'utf8'));
  cam=await call('(select id from safenest_private.cameras where device_id=$1)',[D]);other=await call('(select id from safenest_private.cameras where device_id=$1)',[E]);
  // Existing history is preserved, but applying this migration never pushes it.
  await db.query('insert into safenest_private.camera_snapshots values($1,clock_timestamp(),$2)',[cam,payload()]);
  await db.exec(migration);await db.exec(migration);
  await t.test('operator diagnosis is read-only, reveals no subscriptions and leaves absent optional delivery setup unknown',async()=>{
   const script=await readFile(new URL('../cloud/diagnose_fall_push.sql.example',import.meta.url),'utf8');
   const results=await db.exec(script),rows=results.flatMap(r=>r.rows);
   assert.ok(rows.some(r=>r.check_name==='Push queue'&&r.result==='Present'));
   assert.ok(rows.some(r=>r.check_name==='Optional background wake function'&&r.result==='Missing'));
   assert.equal(await count('fall_alerts'),0);assert.equal(await count('fall_push_jobs'),0);
   assert.ok(!JSON.stringify(rows).includes('endpoint'));assert.ok(!JSON.stringify(rows).includes(TOKEN));
  });
  await t.test('migration reruns preserve existing data and do not replay history',async()=>{
   assert.equal(await count('fall_alerts'),0);assert.equal(await count('camera_snapshots'),1);assert.equal(await count('members'),3);
   assert.equal(await call("(select relrowsecurity from pg_class where oid='safenest_private.push_subscriptions'::regclass)"),true);
  });
  await t.test('own opt-in only, endpoint allowlist, account ownership, rate limiting and RLS',async()=>{
   assert.equal((await register(A,'alice')).ok,true);assert.equal((await register(B,'bob')).ok,true);assert.equal((await register(C,'other',E)).ok,true);
   await user(A);assert.equal((await call('public.family_push_status($1,$2)',[D,subscription('alice').endpoint])).enabled,true);
   assert.equal((await call('public.register_family_push($1,$2,$3)',[D,subscription('bob'),KEY])).ok,false);
   for(const endpoint of ['http://fcm.googleapis.com/wp/x','https://127.0.0.1/x','https://fcm.googleapis.com.evil.test/x','https://fcm.googleapis.com:444/x','https://fcm.googleapis.com@evil.test/x'])
    assert.equal((await call('public.register_family_push($1,$2,$3)',[D,{...subscription('x'),endpoint},KEY])).error,'invalid_subscription');
   for(let i=0;i<22;i++)await call('public.register_family_push($1,$2,$3)',[D,subscription('alice'),KEY]);
   assert.equal((await call('public.register_family_push($1,$2,$3)',[D,subscription('alice'),KEY])).error,'rate_limited');await clearLimits();
   for(const role of ['anon','authenticated']){await user(A,role);for(const table of ['fall_alerts','fall_alert_views','camera_alert_state','push_subscriptions','home_push_preferences','fall_push_jobs'])await assert.rejects(db.query('select * from safenest_private.'+table),/permission denied/);
    for(const fn of ['public.claim_fall_push($1)','public.begin_fall_push(null,null,$1)'])await assert.rejects(call(fn,[KEY]),/permission denied/);}
   await user(C);for(const fn of ['public.list_fall_alerts($1)','public.family_push_status($1)'])await assert.rejects(call(fn,[D]),/denied/);
   await assert.rejects(call('public.register_family_push($1,$2,$3)',[D,subscription('attack'),KEY]),/denied/);
  });
  await t.test('only fresh real suspected observations create one server episode across heartbeat/history/Person changes',async()=>{
   for(const state of ['Normal','No Person','Checking','Pose Unclear','Tracking Lost','Camera Offline'])await publish(payload(state));
   for(const extra of [{demo:true},{stale:true},{camera_connected:false},{observed_at:'bad'},{observed_at:'2025-01-01T00:00:00Z'},{observed_at:new Date(Date.now()+60000).toISOString()}]){
    if(extra.demo){await admin();await db.query('update safenest_private.camera_snapshots set received_at=clock_timestamp(),payload=$1 where camera_id=$2',[payload('Suspected Fall',extra),cam]);}
    else await publish(payload('Suspected Fall',extra));
   }
   assert.equal(await count('fall_alerts'),0);
   const p=payload('Suspected Fall',{events:[{id:'old',time:'2025-01-01T00:00:00Z',status:'Person 9: Suspected Fall'}]});
   await publish(p);alert1=(await alerts()).alerts[0];assert.equal(alert1.current,true);assert.equal(alert1.camera_id,cam);
   for(let i=0;i<3;i++)await publish(payload());await publish(p);
   await publish(payload('Pose Unclear'));await publish(payload());
   assert.equal(await count('fall_alerts'),1);assert.equal(await count('fall_push_jobs'),2);
   await admin();await db.exec(migration);assert.equal(await count('fall_alerts'),1);
   // An old/out-of-order Normal must not re-arm a current episode.
   await publish(payload('Normal',{observed_at:'2025-01-01T00:00:00Z'}));await publish(payload());assert.equal(await count('fall_alerts'),1);
  });
  await t.test('fresh Normal followed by a distinct fall creates a new ID; old repeated events do not drive it',async()=>{
   await publish(payload('Normal'));await publish(payload('Suspected Fall',{events:[{id:'old',time:'2025-01-01T00:00:00Z',status:'Suspected Fall'}]}));
   alert2=(await alerts()).alerts[0];assert.notEqual(alert1.id,alert2.id);assert.equal(await count('fall_alerts'),2);
   await user(C);await assert.rejects(call('public.acknowledge_fall_alert($1,$2)',[D,alert2.id]),/denied/);
   await user(A);await assert.rejects(call('public.acknowledge_fall_alert($1,$2)',[E,alert2.id]),/denied/);
  });
  await t.test('shared viewing is server-derived, idempotent and never changes detector snapshot/history',async()=>{
   await admin();const before=await call('(select jsonb_agg(to_jsonb(s)) from safenest_private.camera_snapshots s)');
   await user(B);assert.equal((await call('public.acknowledge_fall_alert($1,$2)',[D,alert2.id])).ok,true);await call('public.acknowledge_fall_alert($1,$2)',[D,alert2.id]);
   const mine=(await call('public.list_fall_alerts($1)',[D])).alerts[0];assert.equal(mine.viewed_by_me,true);assert.equal(mine.views.length,1);assert.equal(mine.views[0].name,'Family member');
   assert.ok(!JSON.stringify(mine).includes(B));assert.ok(!JSON.stringify(mine).includes('@example.com'));
   const seen=(await alerts()).alerts[0];assert.equal(seen.views.length,1);assert.equal(seen.viewed_by_me,false);
   await assert.rejects(call('public.acknowledge_fall_alert($1,$2,$3)',[D,alert2.id,B]),/does not exist/);
   await admin();assert.deepEqual(await call('(select jsonb_agg(to_jsonb(s)) from safenest_private.camera_snapshots s)'),before);
   assert.equal(await count('fall_alert_views'),1);
  });
  await t.test('queue leases prevent double send; recipient sees only own opaque link and current Home',async()=>{
   await worker();job=await call('public.claim_fall_push($1)',[KEY]);assert.ok(job);
   const data=await call('public.begin_fall_push($1,$2,$3)',[job.id,job.claim,KEY]);assert.ok(data);assert.match(data.notification_key,/^[a-f0-9]{32}$/);
   assert.equal(await call('public.begin_fall_push($1,$2,$3)',[job.id,job.claim,KEY]),null);
   await call('public.finish_fall_push($1,$2,$3)',[job.id,job.claim,'sent']);
   const owner=data.endpoint.endsWith('alice')?A:B,otherOwner=owner===A?B:A;
   await user(owner);assert.equal((await call('public.open_fall_notification($1)',[data.notification_key])).home_id,D);
   await user(otherOwner);await assert.rejects(call('public.open_fall_notification($1)',[data.notification_key]),/denied/);
   await worker();await call('public.finish_fall_push($1,$2,$3)',[job.id,job.claim,'retry']);
   await admin();assert.equal(await call('(select state from safenest_private.fall_push_jobs where id=$1)',[job.id]),'sent');
  });
  await t.test('revocation between claim and send cancels every queued delivery and all Home reads',async()=>{
   await worker();let pending=await call('public.claim_fall_push($1)',[KEY]);
   await admin();const owner=await call('(select s.user_id from safenest_private.fall_push_jobs j join safenest_private.push_subscriptions s on s.id=j.subscription_id where j.id=$1)',[pending.id]);
   // Revoke B regardless of which row was just claimed, then try all remaining rows.
   await user(A);await call('public.revoke_family_member($1,$2)',[D,B]);
   await user(B);for(const fn of ['public.list_fall_alerts($1)','public.family_push_status($1)','public.read_home_cameras($1)','public.list_home_events($1)','public.list_care_notes($1)'])await assert.rejects(call(fn,[D]),/denied/);
   await assert.rejects(call('public.acknowledge_fall_alert($1,$2)',[D,alert2.id]),/denied/);
   await worker();const data=await call('public.begin_fall_push($1,$2,$3)',[pending.id,pending.claim,KEY]);
   if(owner===B)assert.equal(data,null);else {assert.ok(data);await call('public.finish_fall_push($1,$2,$3)',[pending.id,pending.claim,'unknown']);}
   await admin();assert.equal(await call("(select count(*) from safenest_private.fall_push_jobs j join safenest_private.push_subscriptions s on s.id=j.subscription_id where s.user_id=$1 and j.state in ('pending','retry','preparing'))",[B]),0);
  });
  await t.test('disable, logout, missing membership, bans and expiry prevent queued sends; no old replay on enable',async()=>{
   await user(A);await call('public.disable_family_push($1,$2)',[D,subscription('alice').endpoint]);
   await publish(payload('Normal'));await publish(payload());const before=await count('fall_push_jobs');
   assert.equal((await register(A,'alice')).ok,true);assert.equal(await count('fall_push_jobs'),before);
   await publish(payload('Normal'));await publish(payload());
   await admin();await db.exec("update safenest_private.fall_push_jobs set expires_at=clock_timestamp()-interval '1 second' where state in ('pending','retry')");
   await worker();assert.equal(await call('public.claim_fall_push($1)',[KEY]),null);
   await user(A);await call('public.remove_my_push_subscription($1)',[subscription('bob').endpoint]); // Cannot disable another account.
   await admin();assert.equal(await call('(select enabled from safenest_private.push_subscriptions where user_id=$1)',[B]),true);
   await user(A);await call('public.remove_my_push_subscription($1)',[subscription('alice').endpoint]);assert.equal((await call('public.family_push_status($1,$2)',[D,subscription('alice').endpoint])).enabled,false);
   assert.equal((await alerts(E,C)).alerts.length,0);
  });
  await t.test('bans, disabled cameras, interrupted sends and invalid providers are never replayed',async()=>{
   await clearLimits();await register(A,'alice');await publish(payload('Normal'));await publish(payload());
   await admin();await db.query("update auth.users set banned_until=clock_timestamp()+interval '1 day' where id=$1",[A]);
   await worker();assert.equal(await call('public.claim_fall_push($1)',[KEY]),null);
   await admin();await db.query('update auth.users set banned_until=null where id=$1',[A]);
   await publish(payload('Normal'));await publish(payload());await admin();await db.query('update safenest_private.cameras set enabled=false where id=$1',[cam]);
   await worker();assert.equal(await call('public.claim_fall_push($1)',[KEY]),null);
   await admin();await db.query('update safenest_private.cameras set enabled=true where id=$1',[cam]);
   await publish(payload('Normal'));await publish(payload());await worker();const claimed=await call('public.claim_fall_push($1)',[KEY]);
   assert.ok(await call('public.begin_fall_push($1,$2,$3)',[claimed.id,claimed.claim,KEY]));
   await admin();await db.query("update safenest_private.fall_push_jobs set lease_until=clock_timestamp()-interval '1 second' where id=$1",[claimed.id]);
   await worker();assert.equal(await call('public.claim_fall_push($1)',[KEY]),null);await admin();assert.equal(await call('(select state from safenest_private.fall_push_jobs where id=$1)',[claimed.id]),'unknown');
  });
  await t.test('explicit retry has bounded attempts and stable key; 410 clears the dead subscription',async()=>{
   await publish(payload('Normal'));await publish(payload());let previousKey;
   for(let attempt=1;attempt<=3;attempt++){
    await worker();const claimed=await call('public.claim_fall_push($1)',[KEY]);assert.ok(claimed);
    const data=await call('public.begin_fall_push($1,$2,$3)',[claimed.id,claimed.claim,KEY]);
    if(previousKey)assert.equal(data.notification_key,previousKey);previousKey=data.notification_key;
    await call('public.finish_fall_push($1,$2,$3)',[claimed.id,claimed.claim,'retry']);
    await admin();await db.query("update safenest_private.fall_push_jobs set next_attempt=clock_timestamp()-interval '1 second' where id=$1",[claimed.id]);
    assert.equal(await call('(select attempts from safenest_private.fall_push_jobs where id=$1)',[claimed.id]),attempt);
   }
   await worker();assert.equal(await call('public.claim_fall_push($1)',[KEY]),null);
   await publish(payload('Normal'));await publish(payload());await worker();const claimed=await call('public.claim_fall_push($1)',[KEY]);
   await call('public.begin_fall_push($1,$2,$3)',[claimed.id,claimed.claim,KEY]);await call('public.finish_fall_push($1,$2,$3)',[claimed.id,claimed.claim,'gone']);
   await user(A);assert.equal((await call('public.family_push_status($1,$2)',[D,subscription('alice').endpoint])).enabled,false);
  });
 }finally{await db.close();}
});

test('read-only notification setup checks also run before migrations without creating schemas, rows or requests',async()=>{
 const db=new PGlite();try{
  const results=await db.exec(await readFile(new URL('../cloud/diagnose_fall_push.sql.example',import.meta.url),'utf8'));
  assert.ok(results.flatMap(r=>r.rows).some(r=>r.check_name==='Push queue'&&r.result==='Missing'));
  assert.equal((await db.query("select to_regclass('safenest_private.fall_alerts') as alerts")).rows[0].alerts,null);
 }finally{await db.close();}
});
