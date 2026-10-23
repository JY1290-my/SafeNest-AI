import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '../video_frontend/node_modules/@electric-sql/pglite/dist/index.js';
const D='10000000-0000-4000-8000-000000000001',E='10000000-0000-4000-8000-000000000002';
const [M,A,B,X]=[1,2,3,4].map(n=>`20000000-0000-4000-8000-00000000000${n}`);
const S='30000000-0000-4000-8000-000000000001';
const TOKEN='local-device-token-for-tests-only-123456';
const migration=await readFile(new URL('../cloud/care_note_management.sql',import.meta.url),'utf8');
test('full migration stack: care-note management and integrated family authorization',async t=>{
 const db=new PGlite();
 const admin=()=>db.exec('reset role');
 const user=async(id=A,role='authenticated')=>{await db.exec('reset role;set role '+role);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id||'']);};
 const call=async(sql,args=[]) => (await db.query('select '+sql+' as data',args)).rows[0].data;
 const notes=(d=D)=>call('public.list_care_notes($1)',[d]);
 const add=(body='An observation',d=D)=>call('public.add_care_note($1,$2)',[d,body]);
 const remove=(id,d=D)=>call('public.delete_care_note($1,$2)',[d,id]);
 const resetLimits=async()=>{await admin();await db.exec('delete from safenest_private.family_limits');};
 let owned,other,otherDevice,baseline;
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
  for(const file of ['schema.sql','video_schema.sql','family_schema.sql','website_improvements.sql','context_monitoring.sql','family_management.sql','device_claim.sql'])await db.exec(await readFile(new URL('../cloud/'+file,import.meta.url),'utf8'));
  for(const [id,name] of [[M,'Caregiver'],[A,'Ka Ying'],[B,'Another relative'],[X,'Unbound']])await db.query('insert into auth.users(id,raw_user_meta_data) values($1,$2)',[id,{display_name:name,role:'admin',is_admin:true}]);
  for(const d of [D,E])await db.query("insert into safenest_private.devices(id,token_hash) values($1,encode(sha256(convert_to($2,'UTF8')),'hex'))",[d,TOKEN]);
  // Exercise the delivered local-device claim + Auth account flow, not direct role spoofing.
  for(const [d,manager] of [[D,M],[E,B]]){
   await user(null,'anon');const code=(await call('public.issue_device_claim($1,$2)',[d,TOKEN])).claim_code;
   await user(manager);assert.equal((await call('public.redeem_device_claim($1)',[code])).ok,true);
   const invite=(await call('public.create_family_invite($1)',[d])).invitation_code;
   for(const member of d===D?[A,B]:[A]){await user(member);assert.equal((await call('public.redeem_family_invite($1)',[invite])).ok,true);}
  }
  await admin();
  for(const d of [D,E])await db.query('insert into safenest_private.snapshots(device_id,payload) values($1,$2)',[d,{room:'Test room',status:'Suspected Fall',events:[{time:'2026-10-18T00:00:00Z',status:'Person 2: Suspected Fall'}]}]);
  await user(A);owned=(await add('Keep this existing note')).id;
  await admin();baseline=await call('(select jsonb_agg(to_jsonb(s) order by device_id) from safenest_private.snapshots s)');
  await db.exec(migration);await db.exec(migration);await db.exec(await readFile(new URL('../cloud/home_identity.sql',import.meta.url),'utf8'));
  await t.test('incremental migration retains notes, snapshots, bindings, roles and protected tables',async()=>{
   assert.equal(await call('(select count(*) from safenest_private.care_notes)'),1);
   assert.equal(await call('(select count(*) from safenest_private.members)'),5);
   assert.equal(await call('(select count(*) from safenest_private.device_managers)'),2);
   assert.equal(await call("(select relrowsecurity from pg_class where oid='safenest_private.care_notes'::regclass)"),true);
   for(const role of ['anon','authenticated']){
    await user(A,role);
    for(const sql of ['select * from safenest_private.care_notes','delete from safenest_private.care_notes',"update safenest_private.care_notes set body='forged'"])
     await assert.rejects(db.query(sql),/permission denied/);
    await assert.rejects(call('safenest_private.require_note_member($1)',[D]),/permission denied/);
   }
  });
  await t.test('author IDs come from Auth; no author arguments, email, user UUID or forged role authority',async()=>{
   await user(A);const note=(await notes())[0];assert.equal(note.author,'Ka Ying');assert.equal(note.is_mine,true);assert.equal(note.can_delete,true);assert.ok(Date.parse(note.created_at));
   assert.deepEqual(Object.keys(note).sort(),['author','body','can_delete','created_at','id','is_mine']);
   assert.ok(!JSON.stringify(note).includes(A));
   await assert.rejects(call('public.add_care_note($1,$2,$3,$4)',[D,'Forged',M,'Caregiver']),/does not exist/);
   await assert.rejects(call('public.delete_care_note($1,$2,$3)',[D,owned,M]),/does not exist/);
   await user(B);other=(await add('Other author observation')).id;
   assert.equal((await notes()).find(n=>n.id===owned).can_delete,false); // B is manager of E only; metadata says admin.
   await admin();assert.equal(await call('(select user_id from safenest_private.care_notes where id=$1)',[other]),B);
  });
  await t.test('display labels reject email/UUID/non-string metadata with safe fallback before truncation',async()=>{
   for(const name of ['',null,{},'person@example.com',A,'Name '+A,'a'.repeat(90)+'@example.com']){
    await admin();await db.query('update auth.users set raw_user_meta_data=$1 where id=$2',[{display_name:name},A]);
    await user(B);assert.equal((await notes()).find(n=>n.id===owned).author,'Family member');
   }
   await admin();await db.query('update auth.users set raw_user_meta_data=$1 where id=$2',[{display_name:'  Ka\n Ying  '},A]);
   await user(A);assert.equal((await notes()).find(n=>n.id===owned).author,'Ka Ying');
  });
  await t.test('only current author or same-device manager can delete, with generic target denial',async()=>{
   await user(B);assert.deepEqual(await remove(owned),{ok:false,error:'note_unavailable'});
   await user(A);assert.deepEqual(await remove(other),{ok:false,error:'note_unavailable'});
   assert.deepEqual(await remove(S),{ok:false,error:'note_unavailable'});
   assert.deepEqual(await remove(null),{ok:false,error:'note_unavailable'});
   assert.deepEqual(await remove(owned),{ok:true});
   assert.deepEqual(await remove(owned),{ok:false,error:'note_unavailable'}); // replay, no id enumeration
   assert.equal((await notes()).length,1);
   await user(M);assert.equal((await notes())[0].can_delete,true);
   assert.deepEqual(await remove(other),{ok:true});assert.deepEqual(await notes(),[]);
  });
  await t.test('note/device mismatch and cross-home admin actions are denied even when both devices are followed',async()=>{
   await user(A);otherDevice=(await add('Other home history',E)).id;
   assert.deepEqual(await remove(otherDevice,D),{ok:false,error:'note_unavailable'});
   await user(M);await assert.rejects(remove(otherDevice,E),/Access denied/);
   assert.deepEqual(await remove(otherDevice,D),{ok:false,error:'note_unavailable'});
   await user(A);assert.ok((await notes(E)).some(n=>n.id===otherDevice));
  });
  await t.test('anonymous, missing-session, unbound, banned and disabled-device operations fail',async()=>{
   await user(null,'anon');for(const action of [()=>notes(),()=>add(),()=>remove(otherDevice)])await assert.rejects(action(),/permission denied/);
   for(const uid of [null,X]){
    await user(uid);for(const action of [()=>notes(),()=>add(),()=>remove(otherDevice)])await assert.rejects(action(),/Sign in required|Access denied/);
   }
   await admin();await db.query("update auth.users set banned_until=clock_timestamp()+interval '1 day' where id=$1",[A]);
   await user(A);for(const action of [()=>notes(),()=>add(),()=>remove(otherDevice,E)])await assert.rejects(action(),/Sign in required/);
   await admin();await db.query('update auth.users set banned_until=null where id=$1',[A]);await db.query('update safenest_private.devices set enabled=false where id=$1',[D]);
   await user(M);for(const action of [()=>notes(),()=>add(),()=>remove(otherDevice)])await assert.rejects(action(),/Access denied/);
   await admin();await db.query('update safenest_private.devices set enabled=true where id=$1',[D]);
  });
  await t.test('post length/rate protections remain and deletion denial counters commit',async()=>{
   await resetLimits();await user(A);
   for(const body of [null,'',' \n\t','x'.repeat(1001)])assert.deepEqual(await add(body),{ok:false,error:'invalid_note'});
   assert.equal((await add('x'.repeat(1000))).ok,true);
   for(let i=0;i<4;i++)assert.equal((await add('Observation '+i)).ok,true);
   assert.deepEqual(await add(),{ok:false,error:'rate_limited'});
   for(let i=0;i<20;i++)assert.deepEqual(await remove(S),{ok:false,error:'note_unavailable'});
   assert.deepEqual(await remove(otherDevice,E),{ok:false,error:'rate_limited'});
   await admin();assert.equal(await call('(select attempts from safenest_private.family_limits where scope=$1)',['note-delete:'+A]),21);
  });
  await t.test('removed manager can no longer delete others while own-note rights follow membership',async()=>{
   await user(M);const target=(await notes())[0].id;
   await admin();await db.query('delete from safenest_private.device_managers where device_id=$1 and user_id=$2',[D,M]);
   await user(M);assert.equal((await notes())[0].can_delete,false);assert.deepEqual(await remove(target),{ok:false,error:'note_unavailable'});
   await admin();await db.query('insert into safenest_private.device_managers(device_id,user_id) values($1,$2)',[D,M]);
  });
  await t.test('integrated revocation removes home/read/notes/Presence/video access, preserves other home and history',async()=>{
   await resetLimits();await user(A);const target=(await notes())[0].id;
   const lease=await call('public.video_viewer_session($1,$2,null)',[D,'issue']);
   const topic=(await call('public.family_presence($1,$2,$3)',[D,S,'heartbeat'])).topic;
   await user(M);const oldInvite=(await call('public.create_family_invite($1)',[D])).invitation_code;
   assert.equal((await call('public.revoke_family_member($1,$2)',[D,A])).ok,true);
   await user(null);await user(A);assert.deepEqual((await call('public.list_my_monitors()')).map(d=>d.device_id),[E]);
   for(const action of [()=>notes(),()=>add(),()=>remove(target),()=>call('public.read_monitor($1)',[D]),
    ()=>call('public.video_viewer_session($1,$2,null)',[D,'issue']),()=>call('public.video_viewer_session($1,$2,$3)',[D,'renew',lease.session_id]),
    ()=>call('public.family_presence($1,$2,$3)',[D,S,'heartbeat'])])await assert.rejects(action(),/denied/);
   assert.equal(await call('public.can_join_family_presence($1)',[topic]),false);
   assert.deepEqual(await call('public.redeem_family_invite($1)',[oldInvite]),{ok:false,error:'invalid_invite'});
   assert.ok((await notes(E)).some(n=>n.id===otherDevice));
   await user(M);assert.ok((await notes()).some(n=>n.id===target)); // revocation does not delete author's history
  });
  await t.test('deletions and rerunning migration never modify AI snapshots/events or remaining notes',async()=>{
   await admin();const before=await call('(select jsonb_agg(to_jsonb(n) order by id) from safenest_private.care_notes n)');
   await db.exec(migration);
   assert.deepEqual(await call('(select jsonb_agg(to_jsonb(n) order by id) from safenest_private.care_notes n)'),before);
   assert.deepEqual(await call('(select jsonb_agg(to_jsonb(s) order by device_id) from safenest_private.snapshots s)'),baseline);
  });
 }finally{await db.close();}
});
