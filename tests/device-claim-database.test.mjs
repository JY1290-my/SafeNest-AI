import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '../video_frontend/node_modules/@electric-sql/pglite/dist/index.js';
const D='10000000-0000-4000-8000-000000000001', E='10000000-0000-4000-8000-000000000002';
const U='20000000-0000-4000-8000-000000000001', V='20000000-0000-4000-8000-000000000002';
const TOKEN='local-test-device-token-not-a-real-secret';
const migration=await readFile(new URL('../cloud/device_claim.sql',import.meta.url),'utf8');
test('device claim: execute migrations and real SQL authorization',async t=>{
 const db=new PGlite();
 const admin=()=>db.exec('reset role');
 const user=async(uid=U,role='authenticated')=>{await db.exec('reset role;set role '+role);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[uid||'']);};
 const call=async(sql,args=[]) => (await db.query('select '+sql+' as data',args)).rows[0].data;
 const issue=(device=D,token=TOKEN)=>call('public.issue_device_claim($1,$2)',[device,token]);
 const redeem=code=>call('public.redeem_device_claim($1)',[code]);
 const cancel=(code,device=D)=>call("public.cancel_device_claim($1,$2,encode(sha256(convert_to($3,'UTF8')),'hex'))",[device,TOKEN,code]);
 const reset=async()=>{await admin();await db.exec('delete from safenest_private.family_limits');};
 let code;
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
  for(const file of ['schema.sql','video_schema.sql','family_schema.sql','website_improvements.sql','context_monitoring.sql','family_management.sql'])await db.exec(await readFile(new URL('../cloud/'+file,import.meta.url),'utf8'));
  for(const id of [U,V])await db.query("insert into auth.users(id,raw_user_meta_data) values($1,'{\"role\":\"admin\"}')",[id]);
  for(const device of [D,E])await db.query("insert into safenest_private.devices(id,token_hash) values($1,encode(sha256(convert_to($2,'UTF8')),'hex'))",[device,TOKEN]);
  for(const id of [U,V]){
   await db.query('insert into safenest_private.members values($1,$2)',[E,id]);
   await db.query('insert into safenest_private.device_managers(device_id,user_id) values($1,$2)',[E,id]);
  }
  await db.exec(migration);await db.exec(migration);
  await t.test('migration preserves existing managers and marks them non-claimable, including multiple managers',async()=>{
   assert.equal(await call('(select count(*) from safenest_private.device_managers)'),2);
   assert.equal(await call('(select count(*) from safenest_private.device_claims where assigned_at is not null)'),1);
   await user(null,'anon');assert.deepEqual(await issue(E),{ok:false,error:'claim_unavailable'});
  });
  await t.test('no table access, anon redemption, logged-in issuance or user-metadata promotion',async()=>{
   for(const role of ['anon','authenticated']){
    await user(U,role);
    await assert.rejects(db.query('select * from safenest_private.device_claims'),/permission denied/);
    await assert.rejects(db.query('update safenest_private.device_claims set assigned_at=null'),/permission denied/);
    await assert.rejects(call('safenest_private.lock_claim_device($1,$2)',[D,TOKEN]),/permission denied/);
   }
   await assert.rejects(issue(),/permission denied/);
   await user(null,'anon');await assert.rejects(redeem('bad'),/permission denied/);
   await user(null);await assert.rejects(redeem('bad'),/Sign in required/);
   await user(U);assert.ok(!(await call('public.list_my_monitors()')).some(d=>d.device_id===D));
   await assert.rejects(call('public.create_family_invite($1)',[D]),/Access denied/);
  });
  await t.test('physical device credential and enabled device are required',async()=>{
   await user(null,'anon');for(const bad of [null,'', 'x'.repeat(40), 'x'.repeat(257)])await assert.rejects(issue(D,bad),/Access denied/);
   await assert.rejects(issue('10000000-0000-4000-8000-000000000099'),/Access denied/);
   await admin();await db.query('update safenest_private.devices set enabled=false where id=$1',[D]);
   await user(null,'anon');await assert.rejects(issue(),/Access denied/);
   await admin();await db.query('update safenest_private.devices set enabled=true where id=$1',[D]);
  });
  await t.test('codes are random, hash-only, short-lived; reissue invalidates the previous code',async()=>{
   await user(null,'anon');const first=await issue(),second=await issue();code=second.claim_code;
   assert.equal(first.ok,true);assert.match(code,/^sn-claim-[0-9a-f]{32}$/);assert.notEqual(first.claim_code,code);
   assert.equal(second.ttl_seconds,600);assert.ok(Date.parse(second.expires_at)>Date.now()+590000);assert.ok(Date.parse(second.expires_at)<=Date.now()+601000);
   await admin();const stored=await call('(select to_jsonb(c) from safenest_private.device_claims c where device_id=$1)',[D]);
   assert.ok(!JSON.stringify(stored).includes(code));assert.equal(stored.assigned_at,null);assert.match(stored.code_hash,/^[0-9a-f]{64}$/);
   await user(U);assert.deepEqual(await redeem(first.claim_code),{ok:false,error:'invalid_claim'});
   assert.deepEqual(await call('public.redeem_family_invite($1)',[code]),{ok:false,error:'invalid_invite'});
   assert.deepEqual(await redeem('a'.repeat(32)),{ok:false,error:'invalid_claim'});
  });
  await t.test('invalid, expired and disabled codes have the same generic denial, no binding',async()=>{
   await user(U);for(const value of [null,'bad','sn-claim-'+'f'.repeat(32)])assert.deepEqual(await redeem(value),{ok:false,error:'invalid_claim'});
   await admin();await db.query("update safenest_private.device_claims set expires_at=clock_timestamp()-interval '1 second' where device_id=$1",[D]);
   await user(U);assert.deepEqual(await redeem(code),{ok:false,error:'invalid_claim'});
   await user(null,'anon');code=(await issue()).claim_code;
   await admin();await db.query('update safenest_private.devices set enabled=false where id=$1',[D]);
   await user(U);assert.deepEqual(await redeem(code),{ok:false,error:'invalid_claim'});
   await admin();assert.equal(await call('(select count(*) from safenest_private.members where device_id=$1)',[D]),0);
   await db.query('update safenest_private.devices set enabled=true where id=$1',[D]);
  });
  await t.test('explicit cancellation revokes only the matching code, never a replacement',async()=>{
   await user(null,'anon');const old=code;code=(await issue()).claim_code;
   await cancel(old);await admin();assert.equal(await call('(select code_hash is not null from safenest_private.device_claims where device_id=$1)',[D]),true);
   await user(null,'anon');await cancel(code);await cancel(code);
   await user(U);assert.deepEqual(await redeem(code),{ok:false,error:'invalid_claim'});
  });
  await t.test('issuance and unsuccessful redemption counters persist and limit attempts',async()=>{
   await reset();await user(null,'anon');for(let i=0;i<5;i++)assert.equal((await issue()).ok,true);
   assert.deepEqual(await issue(),{ok:false,error:'rate_limited'});
   await user(U);for(let i=0;i<10;i++)assert.deepEqual(await redeem('bad'),{ok:false,error:'invalid_claim'});
   assert.deepEqual(await redeem(code),{ok:false,error:'rate_limited'});
  });
  await t.test('successful redemption atomically binds account and grants manager; competing/replayed requests cannot win',async()=>{
   await reset();await user(null,'anon');code=(await issue()).claim_code;
   await user(U);assert.deepEqual(await redeem(' '+code.toUpperCase()+' '),{ok:true,device_id:D});
   await user(V);assert.deepEqual(await redeem(code),{ok:false,error:'invalid_claim'});
   await assert.rejects(call('public.read_monitor($1)',[D]),/denied/);
   await assert.rejects(call('public.create_family_invite($1)',[D]),/denied/);
   await user(null);await user(U);const home=(await call('public.list_my_monitors()')).find(d=>d.device_id===D);assert.equal(home.can_manage,true);
   assert.equal((await call('public.create_family_invite($1)',[D])).ok,true);
   await admin();const row=await call('(select to_jsonb(c) from safenest_private.device_claims c where device_id=$1)',[D]);assert.equal(row.code_hash,null);assert.ok(row.assigned_at);
   assert.equal(await call('(select count(*) from safenest_private.device_managers where device_id=$1)',[D]),1);
   await user(null,'anon');assert.deepEqual(await issue(),{ok:false,error:'claim_unavailable'});
  });
  await t.test('removing ALL managers or account deletion never reopens claim, even after rerunning migration',async()=>{
   await admin();await db.query('delete from safenest_private.members where device_id=$1',[D]);
   await db.exec(migration);
   await user(U);assert.ok(!(await call('public.list_my_monitors()')).some(d=>d.device_id===D));
   await user(null,'anon');assert.deepEqual(await issue(),{ok:false,error:'claim_unavailable'});
   await admin();await db.exec('delete from auth.users');await db.exec(migration);
   await user(null,'anon');assert.deepEqual(await issue(E),{ok:false,error:'claim_unavailable'});
  });
  await t.test('SQL operator grants invalidate outstanding code and durably protect recovery',async()=>{
   await admin();await db.query('insert into auth.users(id) values($1)',[U]);
   // A different, genuinely never-assigned device is still eligible.
   const X='10000000-0000-4000-8000-000000000003';
   await db.query("insert into safenest_private.devices(id,token_hash) values($1,encode(sha256(convert_to($2,'UTF8')),'hex'))",[X,TOKEN]);
   await user(null,'anon');const pending=(await issue(X)).claim_code;
   await admin();await db.query('insert into safenest_private.members values($1,$2)',[X,U]);
   await db.query('insert into safenest_private.device_managers(device_id,user_id) values($1,$2)',[X,U]);
   await user(U);assert.deepEqual(await redeem(pending),{ok:false,error:'invalid_claim'});
   await user(null,'anon');assert.deepEqual(await issue(X),{ok:false,error:'claim_unavailable'});
  });
 }finally{await db.close();}
});
