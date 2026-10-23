import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {PGlite} from '../video_frontend/node_modules/@electric-sql/pglite/dist/index.js';
const D='10000000-0000-4000-8000-000000000001',E='10000000-0000-4000-8000-000000000002',F='10000000-0000-4000-8000-000000000003';
const A='20000000-0000-4000-8000-000000000001',B='20000000-0000-4000-8000-000000000002',C='20000000-0000-4000-8000-000000000003';const TOKEN='test-device-token-12345678901234567890';
const files=['schema','video_schema','family_schema','website_improvements','context_monitoring','family_management','device_claim','care_note_management','home_identity','multi_camera_homes'];
const migration=await readFile(new URL('../cloud/multi_camera_homes.sql',import.meta.url),'utf8');
test('multi-camera Home migration and security',async t=>{
 const db=new PGlite();const call=async(fn,args=[]) => (await db.query('select '+fn+' as data',args)).rows[0].data;
 const admin=()=>db.exec('reset role');const user=async(id=A,role='authenticated')=>{await db.exec('reset role;set role '+role);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id||'']);};
 const insert=id=>db.query("insert into safenest_private.devices(id,token_hash) values($1,encode(sha256(convert_to($2,'UTF8')),'hex'))",[id,TOKEN]);
 const register=(id,key,name)=>call('public.register_camera($1,$2,$3,$4)',[id,TOKEN,key.repeat(64),name]);
 const payload=(status='Normal',events=[])=>({status,observed_at:new Date().toISOString(),room:'Bedroom',camera_name:'Camera',camera_connected:true,stale:false,demo:false,events});
 let cam1,cam2,cam3,topic;
 try{
 await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key,banned_until timestamptz,raw_user_meta_data jsonb default '{}');create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;create schema realtime;create table realtime.messages(id bigint generated always as identity,extension text);alter table realtime.messages enable row level security;create function realtime.topic() returns text language sql as $$select coalesce(current_setting('realtime.topic',true),'')$$;grant usage on schema realtime to anon,authenticated;grant select,insert on realtime.messages to anon,authenticated;grant usage on all sequences in schema realtime to anon,authenticated;`);
 for(const f of files.slice(0,-1))await db.exec(await readFile(new URL('../cloud/'+f+'.sql',import.meta.url),'utf8'));
 for(const id of [A,B,C])await db.query('insert into auth.users(id) values($1)',[id]);
 for(const id of [D,E])await insert(id);
 for(const [d,u] of [[D,A],[D,B],[E,C]])await db.query('insert into safenest_private.members values($1,$2)',[d,u]);
 await db.query('insert into safenest_private.device_managers(device_id,user_id) values($1,$2)',[D,A]);
 await db.query('insert into safenest_private.snapshots(device_id,payload) values($1,$2)',[D,payload()]);
 await db.query("insert into safenest_private.care_notes(device_id,user_id,body) values($1,$2,'Old note')",[D,B]);
 await db.exec(migration);
 await t.test('backfill stable Homes and default Cameras, retain notes/roles and rerun',async()=>{
 const before=(await db.query('select * from safenest_private.cameras order by id')).rows;
 await db.exec(migration);assert.deepEqual((await db.query('select * from safenest_private.cameras order by id')).rows,before);
 assert.equal(await call('(select count(*) from safenest_private.homes)'),2);assert.equal(await call('(select count(*) from safenest_private.care_notes)'),1);
 await user(A);const homes=await call('public.list_my_monitors()');assert.equal(homes.length,1);assert.equal(homes[0].home_code,'Home-001');assert.equal(homes[0].can_manage,true);
 await user(C);assert.equal((await call('public.list_my_monitors()'))[0].device_id,E);
 });
 await t.test('manager-only setup code; new device pairs once without another Home',async()=>{
 await user(B);await assert.rejects(call('public.create_camera_setup_code($1)',[D]),/denied/);
 await user(A);const setup=await call('public.create_camera_setup_code($1)',[D]);assert.match(setup.setup_code,/^sn-camera-[0-9a-f]{32}$/);
 await admin();await insert(F);await db.exec(migration);assert.equal(await call('(select count(*) from safenest_private.homes)'),2);
 assert.equal(await call('(select count(*) from safenest_private.camera_setup_codes where code_hash=$1)',[setup.setup_code]),0);
 await user(null,'anon');assert.equal((await call('public.pair_camera_device($1,$2,$3)',[F,TOKEN,setup.setup_code])).ok,true);
 assert.equal((await call('public.pair_camera_device($1,$2,$3)',[F,TOKEN,setup.setup_code])).error,'invalid_setup');
 await assert.rejects(call('public.pair_camera_device($1,$2,$3)',[E,'invalid-token-length-1234567890123456789',setup.setup_code]),/denied/);
 assert.equal((await call('public.issue_device_claim($1,$2)',[F,TOKEN])).error,'claim_unavailable');
 cam1=(await register(D,'a','Bedside')).camera_id;cam2=(await register(D,'b','Door')).camera_id;cam3=(await register(F,'c','Other computer')).camera_id;
 assert.equal((await register(D,'a','Bedside')).camera_id,cam1);assert.notEqual(cam1,cam2);
 await user(B);assert.equal((await call('public.list_my_monitors()')).length,1);assert.equal((await call('public.read_home_cameras($1)',[D])).length,3);
 await assert.rejects(call('public.read_home_cameras($1)',[E]),/denied/);await assert.rejects(call('public.read_camera($1,$2)',[cam1,F]),/denied/);
 });
 await t.test('invalid, expired, revoked, used and rate-limited codes use generic failures',async()=>{
 await user(A);const setup=await call('public.create_camera_setup_code($1)',[D]);await admin();const J='10000000-0000-4000-8000-000000000009';await insert(J);await db.query("update safenest_private.camera_setup_codes set expires_at=clock_timestamp()-interval '1 second' where id=$1",[setup.code_id]);
 await user(null,'anon');assert.equal((await call('public.pair_camera_device($1,$2,$3)',[J,TOKEN,setup.setup_code])).error,'invalid_setup');
 for(let n=0;n<10;n++)await call('public.pair_camera_device($1,$2,$3)',[J,TOKEN,'bad']);
 assert.equal((await call('public.pair_camera_device($1,$2,$3)',[J,TOKEN,'bad'])).error,'rate_limited');
 await user(A);const fresh=await call('public.create_camera_setup_code($1)',[D]);await call('public.revoke_camera_setup_code($1,$2)',[D,fresh.code_id]);
 assert.ok((await call('public.list_camera_setup_codes($1)',[D])).some(x=>x.id===fresh.code_id&&!x.enabled));
 });
 await t.test('per-camera whitelist and append-only latest ten Home events, cross-home denial',async()=>{
 await user(null,'anon');const events=Array.from({length:15},(_,i)=>({id:'event-'+i,time:new Date(1750000000000+i*1000).toISOString(),status:'Normal'}));
 await call('public.publish_camera_monitor($1,$2,$3,$4)',[D,TOKEN,cam1,payload('Normal',events)]);
 await call('public.publish_camera_monitor($1,$2,$3,$4)',[F,TOKEN,cam3,payload('Suspected Fall',[{id:'other',time:new Date().toISOString(),status:'Person 1: Suspected Fall'}])]);
 await assert.rejects(call('public.publish_camera_monitor($1,$2,$3,$4)',[D,TOKEN,cam3,payload()]),/denied/);
 await user(B);const cams=await call('public.read_home_cameras($1)',[D]);assert.equal(cams.find(x=>x.camera_id===cam3).payload.status,'Suspected Fall');assert.equal(cams.find(x=>x.camera_id===cam1).payload.status,'Normal');
 const recent=await call('public.list_home_events($1)',[D]);assert.equal(recent.length,10);assert.equal(recent[0].camera_name,'Other computer');
 await user(C);await assert.rejects(call('public.read_camera($1)',[cam1]),/denied/);await assert.rejects(call('public.video_viewer_session($1,$2)',[D,'issue']),/denied/);await assert.rejects(call('public.read_monitor($1)',[D]),/denied/);await assert.rejects(call('public.list_home_events($1)',[D]),/denied/);
 await admin();assert.equal(await call('(select count(*) from safenest_private.camera_events)'),16);
 });
 await t.test('shared Home notes and private Presence; revocation removes every camera lease and roster access',async()=>{
 await user(B);assert.equal((await call('public.list_care_notes($1)',[D]))[0].body,'Old note');
 const note=await call('public.add_care_note($1,$2)',[D,'Shared across views']);assert.equal((await call('public.delete_care_note($1,$2)',[D,note.id])).ok,true);
 const sid='30000000-0000-4000-8000-000000000001';topic=(await call('public.family_presence($1,$2)',[D,sid])).topic;
 assert.equal(await call('public.can_join_family_presence($1)',[topic]),true);
 const lease=await call('public.camera_viewer_session($1,$2,$3)',[F,cam3,'issue']);await assert.rejects(call('public.video_viewer_session($1,$2,$3)',[F,'renew',lease.session_id]),/expired/);await user(null,'anon');assert.equal((await call('public.camera_device_session($1,$2,$3,$4)',[F,TOKEN,cam3,'sync'])).viewers.length,1);
 await user(A);await call('public.revoke_family_member($1,$2)',[D,B]);
 await user(B);assert.deepEqual(await call('public.list_my_monitors()'),[]);assert.equal(await call('public.can_join_family_presence($1)',[topic]),false);
 for(const fn of ['public.read_home_cameras($1)','public.list_home_events($1)','public.list_care_notes($1)'])await assert.rejects(call(fn,[D]),/denied/);
 await assert.rejects(call('public.camera_viewer_session($1,$2,$3,$4)',[F,cam3,'renew',lease.session_id]),/denied/);
 await assert.rejects(call('public.read_monitor($1)',[F]),/denied/);
 await user(null,'anon');assert.deepEqual((await call('public.camera_device_session($1,$2,$3,$4)',[F,TOKEN,cam3,'sync'])).viewers,[]);
 await admin();assert.equal(await call('(select count(*) from safenest_private.video_sessions)'),0);
 });
 await t.test('old publisher stays compatible, reads cannot expose sibling Camera data, and migration keeps Home numbers fixed',async()=>{
 await user(null,'anon');await call('public.publish_monitor($1,$2,$3)',[D,TOKEN,payload('Checking')]);await call('public.publish_camera_monitor($1,$2,$3,$4)',[D,TOKEN,cam2,payload('Pose Unclear')]);
 assert.equal((await call('public.device_setup_info($1,$2)',[F,TOKEN])).home_code,'Home-001');
 await user(A);assert.equal((await call('public.read_monitor($1)',[D])).payload.status,'Checking');assert.equal((await call('public.read_camera($1)',[cam2])).payload.status,'Pose Unclear');
 await admin();await db.exec(migration);await assert.rejects(db.query('update safenest_private.homes set home_number=999 where id=$1',[D]),/fixed/);await user(A);assert.equal((await call('public.read_monitor($1)',[D])).payload.status,'Checking');
 });
 await t.test('new Home claim works; existing claimed devices cannot move; single-use pairing survives concurrent requests',async()=>{
 const G='10000000-0000-4000-8000-000000000004',H='10000000-0000-4000-8000-000000000005',I='10000000-0000-4000-8000-000000000006';
 await admin();for(const id of [G,H,I])await insert(id);
 await user(null,'anon');const claim=await call('public.issue_device_claim($1,$2)',[I,TOKEN]);assert.equal(claim.ok,true);
 await user(C);assert.equal((await call('public.redeem_device_claim($1)',[claim.claim_code])).ok,true);assert.equal((await call('public.list_my_monitors()')).length,2);
 await user(A);const setup=await call('public.create_camera_setup_code($1)',[D]);
 await user(null,'anon');assert.equal((await call('public.pair_camera_device($1,$2,$3)',[I,TOKEN,setup.setup_code])).error,'invalid_setup');
 const results=await Promise.all([G,H].map(id=>call('public.pair_camera_device($1,$2,$3)',[id,TOKEN,setup.setup_code])));assert.equal(results.filter(x=>x.ok).length,1);assert.equal(results.filter(x=>x.error==='invalid_setup').length,1);
 await admin();assert.equal(await call('(select count(*) from safenest_private.homes)'),3);await db.exec(migration);assert.equal(await call('(select count(*) from safenest_private.homes)'),3);
 });
 await t.test('private new tables have RLS and no direct client rights; disable one camera without deleting it',async()=>{
 await user(A);await call('public.set_home_camera_enabled($1,$2,$3)',[D,cam1,false]);await assert.rejects(call('public.read_camera($1)',[cam1]),/denied/);await assert.rejects(call('public.video_viewer_session($1,$2)',[D,'issue']),/denied/);await assert.rejects(call('public.read_monitor($1)',[D]),/denied/);
 for(const table of ['homes','home_devices','cameras','camera_events','camera_snapshots','camera_setup_codes'])await assert.rejects(call('(select count(*) from safenest_private.'+table+')'),/permission denied/);
 await user(C);await assert.rejects(call('public.set_home_camera_enabled($1,$2,$3)',[D,cam2,false]),/denied/);
 });
 }finally{await db.close();}
});
