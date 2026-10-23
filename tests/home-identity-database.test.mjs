import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '../video_frontend/node_modules/@electric-sql/pglite/dist/index.js';
const D='10000000-0000-4000-8000-000000000001',E='10000000-0000-4000-8000-000000000002';
const A='20000000-0000-4000-8000-000000000001',B='20000000-0000-4000-8000-000000000002';
const TOKEN='local-device-token-for-tests-only-123456';
const migration=await readFile(new URL('../cloud/home_identity.sql',import.meta.url),'utf8');
test('Home IDs: all migrations, stable identity, no new authorization or enumeration',async t=>{
 const db=new PGlite();
 const admin=()=>db.exec('reset role');
 const user=async(id=A,role='authenticated')=>{await db.exec('reset role;set role '+role);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id||'']);};
 const call=async(sql,args=[]) => (await db.query('select '+sql+' as data',args)).rows[0].data;
 const info=(device=D,token=TOKEN)=>call('public.device_setup_info($1,$2)',[device,token]);
 const insert=device=>db.query("insert into safenest_private.devices(id,token_hash) values($1,encode(sha256(convert_to($2,'UTF8')),'hex'))",[device,TOKEN]);
 let before;
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
  for(const file of ['schema.sql','video_schema.sql','family_schema.sql','website_improvements.sql','context_monitoring.sql','family_management.sql','device_claim.sql','care_note_management.sql'])await db.exec(await readFile(new URL('../cloud/'+file,import.meta.url),'utf8'));
  for(const id of [A,B])await db.query('insert into auth.users(id) values($1)',[id]);
  await insert(E);await insert(D);
  await db.query('insert into safenest_private.members values($1,$2)',[D,A]);
  await db.query('insert into safenest_private.device_managers(device_id,user_id) values($1,$2)',[D,A]);
  await db.query('insert into safenest_private.snapshots(device_id,payload) values($1,$2)',[D,{room:'Bedroom',status:'Normal',events:[{status:'Normal'}]}]);
  await db.query("insert into safenest_private.care_notes(device_id,user_id,body) values($1,$2,'Existing note')",[D,A]);
  before=await call("jsonb_build_array((select jsonb_agg(to_jsonb(m)) from safenest_private.members m),(select jsonb_agg(to_jsonb(a)) from safenest_private.device_managers a),(select jsonb_agg(to_jsonb(s)) from safenest_private.snapshots s),(select jsonb_agg(to_jsonb(n)) from safenest_private.care_notes n))");
  await db.exec(migration);
  await t.test('backfill is unique, padded and stable on repeated migration without altering existing data',async()=>{
   const original=(await db.query('select id,home_number from safenest_private.devices order by id')).rows;
   assert.deepEqual(original.map(x=>Number(x.home_number)),[1,2]);await db.exec(migration);
   assert.deepEqual((await db.query('select id,home_number from safenest_private.devices order by id')).rows,original);
   assert.deepEqual(await call("jsonb_build_array((select jsonb_agg(to_jsonb(m)) from safenest_private.members m),(select jsonb_agg(to_jsonb(a)) from safenest_private.device_managers a),(select jsonb_agg(to_jsonb(s)) from safenest_private.snapshots s),(select jsonb_agg(to_jsonb(n)) from safenest_private.care_notes n))"),before);
  });
  await t.test('new existing-style registration generates distinct numbers; rollback gaps do not reuse labels',async()=>{
   const ids=Array.from({length:15},(_,i)=>`40000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`);
   await Promise.all(ids.map(id=>insert(id))); // queued transactions; uniqueness is enforced by index/sequence
   assert.equal(await call('(select count(distinct home_number)=count(*) from safenest_private.devices)'),true);
   await db.exec('begin');const temp='50000000-0000-4000-8000-000000000001';await insert(temp);
   const skipped=Number(await call('(select home_number from safenest_private.devices where id=$1)',[temp]));await db.exec('rollback');
   await insert(temp);assert.ok(Number(await call('(select home_number from safenest_private.devices where id=$1)',[temp]))>skipped);
   await db.exec("select setval('safenest_private.home_numbers',999,true)");
   await insert('50000000-0000-4000-8000-000000000002');
   assert.equal(await call('safenest_private.home_code(1000)'),'Home-1000');
   await db.exec(migration);assert.equal(await call("(select last_value from safenest_private.home_numbers)"),1000);
  });
  await t.test('account list exposes only authorized IDs and disabled/unbound users cannot enumerate other homes',async()=>{
   await user(A);const homes=await call('public.list_my_monitors()');assert.equal(homes.length,1);assert.equal(homes[0].home_code,'Home-001');assert.equal(homes[0].device_id,D);assert.equal(homes[0].can_manage,true);
   await assert.rejects(call('public.read_monitor($1)',[E]),/denied/);
   await user(B);assert.deepEqual(await call('public.list_my_monitors()'),[]);
   await assert.rejects(call('public.read_monitor($1)',[D]),/denied/);
   await user(null,'anon');await assert.rejects(call('public.list_my_monitors()'),/permission denied/);
  });
  await t.test('local metadata requires exact enabled device credential and never returns secrets, members or another device',async()=>{
   await user(null,'anon');assert.deepEqual(await info(),{ok:true,device_id:D,home_code:'Home-001'});
   assert.deepEqual(await info(E),{ok:true,device_id:E,home_code:'Home-002'});
   for(const token of [null,'bad','x'.repeat(40)])await assert.rejects(info(D,token),/Access denied/);
   await user(A);await assert.rejects(info(),/permission denied/);
   await admin();await db.query('update safenest_private.devices set enabled=false where id=$1',[D]);
   await user(null,'anon');await assert.rejects(info(),/Access denied/);
   await user(A);assert.deepEqual(await call('public.list_my_monitors()'),[]);
   await admin();await db.query('update safenest_private.devices set enabled=true where id=$1',[D]);
  });
  await t.test('labels remain fixed after room rename, metadata, manager removal and unbinding; clients cannot edit numbers',async()=>{
   await admin();await db.query('update safenest_private.snapshots set payload=$1 where device_id=$2',[{room:'New room'},D]);
   await assert.rejects(db.query('update safenest_private.devices set home_number=5 where id=$1',[D]),/Home number is fixed/);
   await user(A);const home=(await call('public.list_my_monitors()'))[0];assert.equal(home.home_code,'Home-001');assert.equal(home.name,'New room');
   for(const sql of ['select home_number from safenest_private.devices','update safenest_private.devices set home_number=42',"select nextval('safenest_private.home_numbers')"])
    await assert.rejects(db.query(sql),/permission denied/);
   await admin();await db.query('delete from safenest_private.members where device_id=$1',[D]);await db.exec(migration);
   await user(A);assert.deepEqual(await call('public.list_my_monitors()'),[]);
   await user(null,'anon');assert.equal((await info()).home_code,'Home-001');
   assert.deepEqual(await call('public.issue_device_claim($1,$2)',[D,TOKEN]),{ok:false,error:'claim_unavailable'});
  });
 }finally{await db.close();}
});
