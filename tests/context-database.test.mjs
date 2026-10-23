import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '../video_frontend/node_modules/@electric-sql/pglite/dist/index.js';

const D='10000000-0000-4000-8000-000000000001',D2='10000000-0000-4000-8000-000000000002';
const U='20000000-0000-4000-8000-000000000001',OTHER='20000000-0000-4000-8000-000000000002';
const TOKEN='fake-device-token-for-local-tests-only-0000';
const payload=(status='Normal')=>({status,camera_connected:true,stale:false,demo:false,events:[],room:'Test room'});
const context={calibration:'Bed area calibrated; keep camera still',visible_count:1,missing_count:0,
 people:[{person_number:1,state:'RESTING_IN_BED',zone:'inside',visible:true,baseline_status:'Normal',reason:'Stable posture'}]};
test('incremental context migration preserves device authorization and old data',async t=>{
 const db=new PGlite();
 const admin=()=>db.exec('reset role');
 const user=async(id=U)=>{await db.exec('reset role;set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);};
 const publish=async(data,token=TOKEN,device=D)=>{await db.exec('reset role;set role anon');return db.query('select public.publish_monitor($1,$2,$3)',[device,token,data]);};
 const read=async(device=D)=>(await db.query('select public.read_monitor($1) as data',[device])).rows[0].data;
 try{
  await db.exec(`create role anon;create role authenticated;create schema auth;
   create table auth.users(id uuid primary key,banned_until timestamptz,raw_user_meta_data jsonb default '{}');
   create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   grant usage on schema auth to authenticated;`);
  for(const file of ['schema.sql','video_schema.sql','family_schema.sql'])await db.exec(await readFile(new URL('../cloud/'+file,import.meta.url),'utf8'));
  await db.query('insert into auth.users(id) values($1),($2)',[U,OTHER]);
  await db.query("insert into safenest_private.devices values($1,encode(sha256(convert_to($3,'UTF8')),'hex'),true),($2,encode(sha256(convert_to($3,'UTF8')),'hex'),true)",[D,D2,TOKEN]);
  await db.query('insert into safenest_private.members values($1,$2)',[D,U]);
  await db.query("insert into safenest_private.care_notes(device_id,user_id,body) values($1,$2,'Keep me')",[D,U]);
  await publish({...payload(),events:[{id:'old',time:'old',status:'Normal'}]});
  await admin();
  const migration=await readFile(new URL('../cloud/context_monitoring.sql',import.meta.url),'utf8');
  await db.exec(migration);
  await t.test('migration is additive and rerunnable without changing old snapshot or note records',async()=>{
   await db.exec(migration);await user();
   assert.equal((await read()).payload.events[0].id,'old');
   assert.equal((await db.query('select public.list_care_notes($1) as data',[D])).rows[0].data[0].body,'Keep me');
  });
  await t.test('all new status strings and bounded summaries survive authorized publication',async()=>{
   for(const status of ['Check Person','Tracking Lost','Resting in Bed','Suspected Fall']){
    await publish({...payload(status),context});await user();
    const data=(await read()).payload;
    assert.equal(data.status,status);assert.deepEqual(data.context,context);
   }
  });
  await t.test('legacy payloads still work and arbitrary frame/geometry keys are stripped',async()=>{
   await publish(payload());await user();assert.equal((await read()).payload.context,undefined);
   await publish({...payload(),frame:'private-image',context:{...context,bed_polygon:[[0,0]],
    people:[{...context.people[0],keypoints:[1,2],token:'secret'}]},
    events:[{id:'new',status:'Person 1: Check Person',reason:'x'.repeat(200),frame:'image'}]});
   await user();const data=(await read()).payload;
   assert.equal(data.events[0].reason.length,160);
   for(const forbidden of ['private-image','bed_polygon','keypoints','secret','"frame"'])assert.ok(!JSON.stringify(data).includes(forbidden));
  });
  await t.test('unbound and cross-device readers, wrong tokens, and direct table access are rejected',async()=>{
   await user(OTHER);await assert.rejects(read(),/denied/);
   await user();await assert.rejects(read(D2),/denied/);
   await assert.rejects(db.query('select * from safenest_private.snapshots'),/permission denied/);
   await assert.rejects(publish(payload(),'bad'),/Invalid device credentials/);
   await admin();await db.query('delete from safenest_private.members where user_id=$1',[U]);
   await user();await assert.rejects(read(),/denied/);
  });
  await t.test('invalid summaries and oversized payloads fail rather than hiding errors',async()=>{
   for(const bad of [[],{...context,people:{}},{...context,people:Array(17).fill(context.people[0])},
    {...context,visible_count:-1},{...context,people:[{...context.people[0],state:'SAFE'}]},
    {...context,people:[{...context.people[0],person_number:0}]},
    {...context,people:[{...context.people[0],visible:'yes'}]}]){
    await assert.rejects(publish({...payload(),context:bad}));
   }
   await assert.rejects(publish({...payload(),room:'x'.repeat(21000)}),/Invalid metadata payload/);
   await assert.rejects(publish(payload('Unsupported state')),/Unknown detector state/);
  });
 }finally{await db.close();}
});
