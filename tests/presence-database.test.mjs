import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '../video_frontend/node_modules/@electric-sql/pglite/dist/index.js';
const D='10000000-0000-4000-8000-000000000001',D2='10000000-0000-4000-8000-000000000002';
const U='20000000-0000-4000-8000-000000000001',U2='20000000-0000-4000-8000-000000000002',U3='20000000-0000-4000-8000-000000000003';
const S='30000000-0000-4000-8000-000000000001',S2='30000000-0000-4000-8000-000000000002',S3='30000000-0000-4000-8000-000000000003';
test('website migration: actual PostgreSQL presence authorization, roster, notes and revocation',async t=>{
 const db=new PGlite();
 const admin=()=>db.exec('reset role');
 const user=async(id=U,role='authenticated')=>{await db.exec('reset role;set role '+role);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id||'']);};
 const topic=async(value)=>db.query("select set_config('realtime.topic',$1,false)",[value]);
 const call=async(sql,args=[]) => (await db.query('select '+sql+' as data',args)).rows[0].data;
 const presence=(device=D,session=S,action='heartbeat')=>call('public.family_presence($1,$2,$3)',[device,session,action]);
 const migration=await readFile(new URL('../cloud/website_improvements.sql',import.meta.url),'utf8');
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
  for(const file of ['schema.sql','video_schema.sql','family_schema.sql'])await db.exec(await readFile(new URL('../cloud/'+file,import.meta.url),'utf8'));
  await db.query('insert into auth.users(id,raw_user_meta_data) values($1,$4),($2,$5),($3,$6)',[U,U2,U3,{display_name:'Ka Ying'},{display_name:'<img src=x onerror=alert(1)>'},{}]);
  await db.query('insert into safenest_private.devices(id,token_hash) values($1,$3),($2,$3)',[D,D2,'f'.repeat(64)]);
  await db.query('insert into safenest_private.members(device_id,user_id) values($1,$3),($1,$4),($2,$4)',[D,D2,U,U2]);
  await db.query("insert into safenest_private.care_notes(device_id,user_id,body) values($1,$2,'Existing observation')",[D,U]);
  await db.exec(migration);
  await db.exec(await readFile(new URL('../cloud/context_monitoring.sql',import.meta.url),'utf8'));
  let currentTopic;
  await t.test('anonymous and unbound accounts cannot join or read presence; tables remain private',async()=>{
   await user(null,'anon');await assert.rejects(presence(),/permission denied/);
   await assert.rejects(call('public.can_join_family_presence($1)',['safenest-family:unknown']),/permission denied/);
   await user(U3);await assert.rejects(presence(),/denied/);
   assert.equal(await call('public.can_join_family_presence($1)',['safenest-family:unknown']),false);
   for(const table of ['presence_rooms','family_presence_sessions'])await assert.rejects(db.query('select * from safenest_private.'+table),/permission denied/);
   await admin();assert.ok((await db.query("select relrowsecurity from pg_class where relname in ('presence_rooms','family_presence_sessions')")).rows.every(r=>r.relrowsecurity));
  });
  await t.test('server-derived roster deduplicates sessions, excludes other devices, and exposes no IDs/emails',async()=>{
   await user();const first=await presence();currentTopic=first.topic;
   assert.deepEqual(first.members,[{name:'Ka Ying',is_mine:true}]);
   await presence(D,S3);assert.equal((await presence()).members.length,1);
   await user(U2);await presence(D2,S2);await assert.rejects(presence(D,S2),/denied/);
   await user();assert.equal((await presence()).members.length,1);
  });
  // A session UUID cannot move across device/account boundaries.
  await admin();await db.query('delete from safenest_private.family_presence_sessions where id=$1',[S2]);
  await t.test('session hijacks are rejected; peer names come from Auth and not a request parameter',async()=>{
   await user(U2);await assert.rejects(presence(D,S),/denied/);
   const result=await presence(D,S2);assert.equal(result.members.length,2);
   assert.ok(result.members.some(m=>m.name==='<img src=x onerror=alert(1)>'));
   assert.ok(!JSON.stringify(result.members).includes(U));assert.ok(!JSON.stringify(result.members).includes('@'));
   await assert.rejects(call('public.family_presence($1,$2,$3,$4)',[D,S2,'heartbeat','Forged author']));
   await user(U);assert.equal(await call('public.can_join_family_presence($1)',[currentTopic]),true);
  });
  await t.test('actual realtime RLS permits presence only; broad unrelated policies cannot override guards',async()=>{
   await admin();await db.exec("insert into realtime.messages(extension) values('presence'),('broadcast'); create policy unrelated_open on realtime.messages for all to authenticated,anon using(true) with check(true)");
   await topic(currentTopic);await user();
   assert.deepEqual((await db.query('select extension from realtime.messages')).rows,[{extension:'presence'}]);
   await db.query("insert into realtime.messages(extension) values('presence')");
   await assert.rejects(db.query("insert into realtime.messages(extension) values('broadcast')"),/row-level security/);
   await user(U3);assert.equal((await db.query('select * from realtime.messages')).rows.length,0);
   await assert.rejects(db.query("insert into realtime.messages(extension) values('presence')"),/row-level security/);
   await user(null,'anon');assert.equal((await db.query('select * from realtime.messages')).rows.length,0);
  });
  await t.test('revoked membership removes roster entries and invalidates the old topic',async()=>{
   await admin();await db.query('delete from safenest_private.members where user_id=$1 and device_id=$2',[U2,D]);
   await user(U2);await assert.rejects(presence(D,S2),/denied/);
   assert.equal(await call('public.can_join_family_presence($1)',[currentTopic]),false);
   assert.equal((await call('public.list_my_monitors()')).length,1);
   await assert.rejects(call('public.read_monitor($1)',[D]),/denied/);
   await assert.rejects(call('public.list_care_notes($1)',[D]),/denied/);
   await user();const result=await presence();assert.notEqual(result.topic,currentTopic);assert.equal(result.members.length,1);
   assert.equal(await call('public.can_join_family_presence($1)',[currentTopic]),false);currentTopic=result.topic;
  });
  await t.test('expired leases and banned users disappear; leave cleans up only the owner',async()=>{
   await admin();await db.query("update safenest_private.family_presence_sessions set seen_at=clock_timestamp()-interval '46 seconds'");
   await user();assert.equal((await presence()).members.length,1);
   await presence(D,S,'leave');await admin();assert.equal((await db.query('select count(*)::int as n from safenest_private.family_presence_sessions')).rows[0].n,0);
   await db.query("update auth.users set banned_until=clock_timestamp()+interval '1 hour' where id=$1",[U]);
   await user();await assert.rejects(presence(),/Sign in required/);assert.equal(await call('public.can_join_family_presence($1)',[currentTopic]),false);
   await admin();await db.query('update auth.users set banned_until=null where id=$1',[U]);
  });
  await t.test('note names and missing-name fallback use the server account and preserve history',async()=>{
   await user();let notes=await call('public.list_care_notes($1)',[D]);assert.equal(notes[0].author,'Ka Ying');
   await admin();await db.query('update auth.users set raw_user_meta_data=$1 where id=$2',[{display_name:'person@example.com'},U]);
   await user();notes=await call('public.list_care_notes($1)',[D]);assert.equal(notes[0].author,'Family member');
   assert.equal(notes[0].body,'Existing observation');assert.ok(!JSON.stringify(notes).includes(U));
  });
  await t.test('rate limit, disabled devices, and rerunnable incremental migration',async()=>{
   await admin();await db.query("update safenest_private.family_limits set attempts=120 where scope=$1",['presence:'+U]);
   await user();assert.deepEqual(await presence(),{ok:false,error:'rate_limited'});
   await admin();await db.query('update safenest_private.devices set enabled=false where id=$1',[D]);
   await user();await assert.rejects(presence(),/denied/);assert.equal(await call('public.can_join_family_presence($1)',[currentTopic]),false);
   await admin();await db.exec(migration);assert.equal((await db.query('select count(*)::int as n from safenest_private.care_notes')).rows[0].n,1);
   assert.equal((await db.query('select count(*)::int as n from safenest_private.members')).rows[0].n,2);
  });
 }finally{await db.close();}
});
