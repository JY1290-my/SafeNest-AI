import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '../video_frontend/node_modules/@electric-sql/pglite/dist/index.js';
import {createHandler,HttpError} from '../supabase/functions/_shared/video-core.js';
const D='10000000-0000-4000-8000-000000000001',E='10000000-0000-4000-8000-000000000002';
const ids=Array.from({length:6},(_,i)=>`20000000-0000-4000-8000-00000000000${i+1}`);
const [M,F,N,N2,T,C]=ids;
const S='30000000-0000-4000-8000-000000000001',S2='30000000-0000-4000-8000-000000000002';
const TOKEN='local-device-token-for-tests-only-123456';
const migration=await readFile(new URL('../cloud/family_management.sql',import.meta.url),'utf8');
const grant=await readFile(new URL('../cloud/grant_device_manager.sql.example',import.meta.url),'utf8');
test('family management: real PostgreSQL permissions, invitations and revocation',async t=>{
 const db=new PGlite();
 const admin=()=>db.exec('reset role');
 const user=async(id=M,role='authenticated')=>{await db.exec('reset role;set role '+role);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id||'']);};
 const call=async(sql,args=[]) => (await db.query('select '+sql+' as data',args)).rows[0].data;
 const create=(device=D,hours=168,uses=5)=>call('public.create_family_invite($1,$2,$3)',[device,hours,uses]);
 const redeem=code=>call('public.redeem_family_invite($1)',[code]);
 const list=(device=D)=>call('public.list_family_access($1)',[device]);
 const remove=(member,device=D)=>call('public.revoke_family_member($1,$2)',[device,member]);
 const revoke=(invite,device=D)=>call('public.revoke_family_invite($1,$2)',[device,invite]);
 const resetLimit=async(scope)=>{await admin();await db.query('delete from safenest_private.family_limits where scope=$1',[scope]);};
 let plain,invite,oldTopic,lease,otherLease;
 try{
  await db.exec(`create role anon;create role authenticated;create schema auth;
   create table auth.users(id uuid primary key,banned_until timestamptz,raw_user_meta_data jsonb default '{}');
   create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   grant usage on schema auth to authenticated;
   create schema realtime;create table realtime.messages(id bigint generated always as identity,extension text);
   alter table realtime.messages enable row level security;
   create function realtime.topic() returns text language sql as $$select coalesce(current_setting('realtime.topic',true),'')$$;
   grant usage on schema realtime to authenticated,anon;grant select,insert on realtime.messages to authenticated,anon;
   grant usage on all sequences in schema realtime to authenticated,anon;`);
  for(const file of ['schema.sql','video_schema.sql','family_schema.sql','website_improvements.sql','context_monitoring.sql'])await db.exec(await readFile(new URL('../cloud/'+file,import.meta.url),'utf8'));
  for(const id of ids)await db.query('insert into auth.users(id,raw_user_meta_data) values($1,$2)',[id,{display_name:'Member '+ids.indexOf(id),role:'admin',is_admin:true}]);
  await db.query("insert into safenest_private.devices(id,token_hash) values($1,encode(sha256(convert_to($3,'UTF8')),'hex')),($2,encode(sha256(convert_to($3,'UTF8')),'hex'))",[D,E,TOKEN]);
  for(const device of [D,E])for(const id of [M,F,T])await db.query('insert into safenest_private.members values($1,$2)',[device,id]);
  await db.query('insert into safenest_private.snapshots(device_id,payload) values($1,$3),($2,$3)',[D,E,{room:'Home',status:'Normal',events:[{status:'Normal'}]}]);
  await db.query("insert into safenest_private.care_notes(device_id,user_id,body) values($1,$2,'Keep historical observation')",[D,T]);
  await db.exec(migration);
  await t.test('migration preserves data and does not promote existing members or metadata roles',async()=>{
   assert.equal(await call('(select count(*) from safenest_private.members)'),6);
   assert.equal(await call('(select count(*) from safenest_private.device_managers)'),0);
   assert.equal(await call('(select count(*) from safenest_private.care_notes)'),1);
   await user(M);assert.ok((await call('public.list_my_monitors()')).every(d=>d.can_manage===false));
   for(const action of [()=>create(),()=>list(),()=>remove(F),()=>revoke(S)])await assert.rejects(action(),/Access denied/);
  });
  await t.test('explicit SQL operator grant is idempotent, tied to membership and device',async()=>{
   await admin();await db.exec(grant.replaceAll('REPLACE_DEVICE_UUID',D).replaceAll('REPLACE_AUTH_USER_UUID',M));
   await db.exec(grant.replaceAll('REPLACE_DEVICE_UUID',D).replaceAll('REPLACE_AUTH_USER_UUID',M));
   await db.exec(grant.replaceAll('REPLACE_DEVICE_UUID',E).replaceAll('REPLACE_AUTH_USER_UUID',F));
   assert.equal(await call('(select count(*) from safenest_private.device_managers)'),2);
   assert.equal(await call('(select count(*) from safenest_private.members)'),6);
   await user(M);const homes=await call('public.list_my_monitors()');
   assert.equal(homes.find(x=>x.device_id===D).can_manage,true);assert.equal(homes.find(x=>x.device_id===E).can_manage,false);
   await assert.rejects(create(E),/Access denied/);await assert.rejects(list(E),/Access denied/);
   await assert.rejects(remove(F,E),/Access denied/);
  });
  await t.test('anonymous and direct-table/function access stay denied, including for managers',async()=>{
   await admin();assert.ok((await db.query("select relrowsecurity from pg_class join pg_namespace n on n.oid=relnamespace where n.nspname='safenest_private' and relkind='r'")).rows.every(x=>x.relrowsecurity));
   for(const role of ['anon','authenticated']){
    await user(role==='anon'?null:M,role);
    for(const table of ['device_managers','members','family_invites']){
     await assert.rejects(db.query('select * from safenest_private.'+table),/permission denied/);
     await assert.rejects(db.query('delete from safenest_private.'+table),/permission denied/);
    }
    await assert.rejects(call('safenest_private.require_device_manager($1)',[D]),/permission denied/);
   }
   await user(null,'anon');for(const action of [()=>create(),()=>list(),()=>remove(F),()=>revoke(S),()=>redeem('a'.repeat(32))])await assert.rejects(action(),/permission denied/);
   await user(null);await assert.rejects(create(),/Sign in required/);
   await user(F);await assert.rejects(create(),/Access denied/);await assert.rejects(list(),/Access denied/);
   await user(N);assert.deepEqual(await call('public.list_my_monitors()'),[]);
   await assert.rejects(call('public.read_monitor($1)',[D]),/denied/);
  });
  await t.test('manager creates hash-only limited invitation, roster omits credentials and codes',async()=>{
   await user(M);const created=await create(D,168,2);assert.equal(created.ok,true);
   plain=created.invitation_code;invite=created.invite_id;assert.match(plain,/^[0-9a-f]{32}$/);
   assert.ok(Date.parse(created.expires_at)>Date.now()+167*3600000);
   const result=await list();assert.equal(result.members.length,3);assert.equal(result.invitations.length,1);
   assert.equal(result.members.find(x=>x.member_id===M).role,'manager');
   assert.ok(!JSON.stringify(result).includes(plain));assert.ok(!JSON.stringify(result).includes('code_hash'));
   assert.ok(!JSON.stringify(result).includes('email'));assert.ok(!JSON.stringify(result).includes(TOKEN));
   await admin();const stored=(await db.query("select code_hash=encode(sha256(convert_to($1,'UTF8')),'hex') as matches,uses,created_by from safenest_private.family_invites where id=$2",[plain,invite])).rows[0];
   assert.deepEqual(stored,{matches:true,uses:0,created_by:M});
  });
  await t.test('existing binding consumes no new use; successful redemption persists across sessions',async()=>{
   await user(F);assert.equal((await redeem(plain)).already_member,true);
   await admin();assert.equal(await call('(select uses from safenest_private.family_invites where id=$1)',[invite]),0);
   await user(N);assert.equal((await redeem(' '+plain.toUpperCase()+' ')).ok,true);
   await user(null);await user(N);const restored=await call('public.list_my_monitors()');
   assert.equal(restored[0].device_id,D);assert.equal(restored[0].can_manage,false);
   assert.equal((await call('public.read_monitor($1)',[D])).payload.status,'Normal');
   await assert.rejects(create(),/Access denied/);
   await user(N2);assert.equal((await redeem(plain)).ok,true);
   await user(C);assert.deepEqual(await redeem(plain),{ok:false,error:'invalid_invite'});
   await admin();assert.equal(await call('(select uses from safenest_private.family_invites where id=$1)',[invite]),2);
  });
  await t.test('unknown, malformed, expired, used-up and revoked invitations give the same generic error',async()=>{
   await user(M);const expired=await create(),revoked=await create();await revoke(revoked.invite_id);
   await admin();await db.query("update safenest_private.family_invites set expires_at=clock_timestamp()-interval '1 second' where id=$1",[expired.invite_id]);
   await user(C);
   for(const code of ['bad',null,'f'.repeat(32),expired.invitation_code,revoked.invitation_code,plain]){
    assert.deepEqual(await redeem(code),{ok:false,error:'invalid_invite'});
   }
   await user(M);assert.equal((await list()).invitations.find(x=>x.invite_id===expired.invite_id).status,'expired');
  });
  await t.test('failed redemption counters commit and block brute force before lookup',async()=>{
   await resetLimit('invite:'+C);await user(C);
   for(let n=0;n<10;n++)assert.deepEqual(await redeem('bad'),{ok:false,error:'invalid_invite'});
   assert.deepEqual(await redeem(plain),{ok:false,error:'rate_limited'});
   await admin();assert.equal(await call('(select attempts from safenest_private.family_limits where scope=$1)',['invite:'+C]),11);
  });
  await t.test('creation settings, limits and maximum active invitations are enforced on the server',async()=>{
   await resetLimit('invite-create:'+M);await user(M);
   for(const [hours,uses] of [[0,1],[721,1],[1,0],[1,101],[null,1]])assert.deepEqual(await create(D,hours,uses),{ok:false,error:'invalid_settings'});
   assert.deepEqual(await create(),{ok:false,error:'rate_limited'});
   await resetLimit('invite-create:'+M);
   await db.query("insert into safenest_private.family_invites(device_id,code_hash,expires_at) select $1,encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex'),clock_timestamp()+interval '1 day' from generate_series(1,20)",[D]);
   await user(M);assert.deepEqual(await create(),{ok:false,error:'too_many_invites'});
   await admin();await db.query("insert into safenest_private.family_invites(device_id,code_hash,expires_at,enabled) select $1,encode(sha256(convert_to(gen_random_uuid()::text,'UTF8')),'hex'),clock_timestamp()+interval '1 day',false from generate_series(1,60)",[D]);
   await user(M);const visible=(await list()).invitations;
   assert.equal(visible.length,50);assert.equal(visible.filter(i=>i.status==='active').length,20);
   assert.ok(visible.slice(0,20).every(i=>i.status==='active'));

   await admin();await db.query('update safenest_private.family_invites set enabled=false where device_id=$1',[D]);
  });
  await t.test('manager cannot revoke another device invitation or remove a manager/self',async()=>{
   await user(F);const other=await create(E);
   await user(M);await assert.rejects(revoke(other.invite_id),/Access denied/);
   assert.deepEqual(await remove(M),{ok:false,error:'protected_manager'});
   await admin();await db.exec(grant.replaceAll('REPLACE_DEVICE_UUID',D).replaceAll('REPLACE_AUTH_USER_UUID',N2));
   await user(M);assert.deepEqual(await remove(N2),{ok:false,error:'protected_manager'});
   await user(F);assert.equal((await list(E)).invitations[0].status,'active');
  });
  await t.test('revocation clears binding, presence and video leases; ALL prior device invitations stop working',async()=>{
   await resetLimit('invite-create:'+M);await user(M);const outstanding=await create();plain=outstanding.invitation_code;
   await user(T);lease=await call('public.video_viewer_session($1,$2,null)',[D,'issue']);
   otherLease=await call('public.video_viewer_session($1,$2,null)',[E,'issue']);
   oldTopic=(await call('public.family_presence($1,$2,$3)',[D,S,'heartbeat'])).topic;
   await call('public.family_presence($1,$2,$3)',[E,S2,'heartbeat']);
   await user(M);assert.equal((await remove(T)).ok,true);
   await admin();assert.equal(await call('(select count(*) from safenest_private.video_sessions where id=$1)',[lease.session_id]),0);
   assert.equal(await call('(select count(*) from safenest_private.video_sessions where id=$1)',[otherLease.session_id]),1);
   assert.equal(await call('(select count(*) from safenest_private.family_presence_sessions where id=$1)',[S]),0);
   assert.equal(await call('(select count(*) from safenest_private.care_notes)'),1);
   assert.equal(await call('(select count(*) from safenest_private.snapshots)'),2);
   await user(T);const homes=await call('public.list_my_monitors()');assert.deepEqual(homes.map(x=>x.device_id),[E]);
   for(const [sql,args] of [['public.read_monitor($1)',[D]],['public.list_care_notes($1)',[D]],['public.add_care_note($1,$2)',[D,'not allowed']],
    ['public.family_presence($1,$2,$3)',[D,S,'heartbeat']],['public.video_viewer_session($1,$2,null)',[D,'issue']],
    ['public.video_viewer_session($1,$2,$3)',[D,'renew',lease.session_id]],['public.list_family_access($1)',[D]]])await assert.rejects(call(sql,args),/denied/);
   assert.equal(await call('public.can_join_family_presence($1)',[oldTopic]),false);
   await db.query("select set_config('realtime.topic',$1,false)",[oldTopic]);
   assert.deepEqual((await db.query('select * from realtime.messages')).rows,[]);
   await assert.rejects(db.query("insert into realtime.messages(extension) values('presence')"),/row-level security/);
   assert.deepEqual(await redeem(plain),{ok:false,error:'invalid_invite'});
   assert.equal((await call('public.read_monitor($1)',[E])).payload.status,'Normal');
   await user(null,'anon');const viewers=await call('public.video_device_session($1,$2,$3)',[D,TOKEN,'sync']);assert.ok(!viewers.viewers.includes(lease.identity));
  });
  await t.test('Edge Function path cannot mint a new video token for a revoked user',async()=>{
   await user(T);let signed=0;
   const service={verifyUser:async()=>({id:T}),readMonitor:async(jwt,device)=>{try{return await call('public.read_monitor($1)',[device]);}catch{throw new HttpError(403,'Access denied');}},
    signToken:async()=>{signed++;return 'must-not-be-returned';}};
   const handler=createHandler('viewer',service,['https://family.example']);
   const response=await handler(new Request('https://edge.example/video-token',{method:'POST',headers:{Origin:'https://family.example',Authorization:'Bearer mock-user-session'},body:JSON.stringify({device_id:D})}));
   assert.equal(response.status,403);assert.equal(signed,0);
  });
  await t.test('removing management permission cannot be bypassed with cached UI flags',async()=>{
   await admin();await db.query('delete from safenest_private.device_managers where device_id=$1 and user_id=$2',[D,N2]);
   await user(N2);assert.equal((await call('public.list_my_monitors()')).find(x=>x.device_id===D).can_manage,false);
   await assert.rejects(create(),/Access denied/);await assert.rejects(list(),/Access denied/);await assert.rejects(remove(F),/Access denied/);
   assert.equal((await call('public.read_monitor($1)',[D])).payload.status,'Normal');
  });
  await t.test('banned manager and disabled device cannot manage; ordinary data remains intact on rerun',async()=>{
   await admin();await db.query("update auth.users set banned_until=clock_timestamp()+interval '1 hour' where id=$1",[M]);
   await user(M);await assert.rejects(create(),/Sign in required/);
   await admin();await db.query('update auth.users set banned_until=null where id=$1',[M]);await db.query('update safenest_private.devices set enabled=false where id=$1',[D]);
   await user(M);await assert.rejects(list(),/Access denied/);
   await admin();await db.query('update safenest_private.devices set enabled=true where id=$1',[D]);
   const before=await call("jsonb_build_array((select count(*) from safenest_private.members),(select count(*) from safenest_private.care_notes),(select count(*) from safenest_private.family_invites))");
   await db.exec(migration);assert.deepEqual(await call("jsonb_build_array((select count(*) from safenest_private.members),(select count(*) from safenest_private.care_notes),(select count(*) from safenest_private.family_invites))"),before);
  });
 } finally {await db.close();}
});
