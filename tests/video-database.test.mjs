import test from 'node:test';import assert from 'node:assert/strict';import{readFile}from'node:fs/promises';
import{PGlite}from'../video_frontend/node_modules/@electric-sql/pglite/dist/index.js';
const D='f22ef861-34ca-4f33-ae67-85b0ec44bd07',U='5773c37c-89b5-4112-9ac7-2a01a2ab5a88',U2='00000000-0000-0000-0000-000000000002',TOKEN='x'.repeat(40);
test('PostgreSQL migrations: auth, member revocation, expiry, secrets and rate limits',async()=>{
 const db=new PGlite();
 try{
  await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key,banned_until timestamptz);create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;`);
  await db.exec(await readFile(new URL('../cloud/schema.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../cloud/video_schema.sql',import.meta.url),'utf8'));
  await db.query('insert into auth.users(id) values($1),($2)',[U,U2]);
  await db.query("insert into safenest_private.devices(id,token_hash) values($1,encode(sha256(convert_to($2,'UTF8')),'hex'))",[D,TOKEN]);
  await db.query('insert into safenest_private.members(device_id,user_id) values($1,$2)',[D,U]);
  await db.exec('set role anon');
  // The unchanged metadata RPC accepts per-person event labels, but only a
  // supported aggregate status. It still strips arbitrary image/person blobs.
  const payload={schema_version:1,status:'Suspected Fall',camera_connected:true,stale:false,demo:false,
    room:'Living room',camera_name:'Camera',observed_at:'2026-10-15T08:00:00Z',frame:'must-not-persist',
    events:[{id:'a'.repeat(64),time:'2026-10-15T08:00:00',status:'Person 2: Suspected Fall',angle_deg:'90',width_height_ratio:'2'}]};
  await assert.rejects(db.query('select public.publish_monitor($1,$2,$3)',[D,'wrong'.repeat(10),payload]));
  await db.query('select public.publish_monitor($1,$2,$3)',[D,TOKEN,payload]);
  await assert.rejects(db.query('select public.video_device_session($1,$2,$3)',[D,'wrong'.repeat(10),'issue']));
  await assert.rejects(db.query('select * from safenest_private.video_sessions'));
  await assert.rejects(db.query("select public.video_viewer_session($1,'issue')",[D]));
  assert.deepEqual((await db.query("select public.video_device_session($1,$2,'sync') as data",[D,TOKEN])).rows[0].data.viewers,[]);
  await db.exec('reset role;set role authenticated');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[U2]);
  await assert.rejects(db.query('select public.read_monitor($1)',[D]),/denied/);
  await assert.rejects(db.query("select public.video_viewer_session($1,'issue')",[D]));
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[U]);
  const monitor=(await db.query('select public.read_monitor($1) as data',[D])).rows[0].data.payload;
  assert.equal(monitor.status,'Suspected Fall');
  assert.equal(monitor.events[0].status,'Person 2: Suspected Fall');
  assert.equal(monitor.events[0].angle_deg,'90');
  assert.ok(!('frame' in monitor));

  const lease=(await db.query("select public.video_viewer_session($1,'issue') as data",[D])).rows[0].data;
  assert.equal(lease.identity,`family-${U}-${lease.session_id}`);
  await db.query("select public.video_viewer_session($1,'renew',$2)",[D,lease.session_id]);
  await db.exec('reset role;set role anon');
  assert.deepEqual((await db.query("select public.video_device_session($1,$2,'sync') as data",[D,TOKEN])).rows[0].data.viewers,[lease.identity]);
  await db.exec('reset role');
  await db.query('delete from safenest_private.members where device_id=$1',[D]);
  await db.exec('set role anon');
  assert.deepEqual((await db.query("select public.video_device_session($1,$2,'sync') as data",[D,TOKEN])).rows[0].data.viewers,[]);
  await db.exec('reset role;set role authenticated');
  await assert.rejects(db.query("select public.video_viewer_session($1,'renew',$2)",[D,lease.session_id]));
  await db.exec('reset role');
  await db.query('insert into safenest_private.members(device_id,user_id) values($1,$2)',[D,U]);
  await db.query("update safenest_private.video_sessions set expires_at=clock_timestamp()-interval '1 second'");
  await db.exec('set role authenticated');
  await assert.rejects(db.query("select public.video_viewer_session($1,'renew',$2)",[D,lease.session_id]));
  for(let i=0;i<9;i++)await db.query("select public.video_viewer_session($1,'issue')",[D]);
  await assert.rejects(db.query("select public.video_viewer_session($1,'issue')",[D]),/limit exceeded/);
  await db.exec('reset role');
  await db.query('update safenest_private.devices set enabled=false where id=$1',[D]);
  await db.exec('set role anon');
  await assert.rejects(db.query("select public.video_device_session($1,$2,'issue')",[D,TOKEN]));
 }finally{await db.close();}
});
