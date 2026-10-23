import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '../video_frontend/node_modules/@electric-sql/pglite/dist/index.js';
const D='10000000-0000-4000-8000-000000000001', D2='10000000-0000-4000-8000-000000000002';
const U='20000000-0000-4000-8000-000000000001', U2='20000000-0000-4000-8000-000000000002';
const U3='20000000-0000-4000-8000-000000000003', U4='20000000-0000-4000-8000-000000000004';
const CODE='a'.repeat(32), SECOND='b'.repeat(32), EXPIRED='c'.repeat(32), DISABLED='d'.repeat(32);
test('Family migration and actual PostgreSQL RPC authorization', async t => {
  const db=new PGlite();
  const admin=()=>db.exec('reset role');
  async function user(id=U,role='authenticated') {
    await db.exec('reset role;set role '+role);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id || '']);
  }
  const call=async(sql,args=[]) => (await db.query('select '+sql+' as data',args)).rows[0].data;
  const redeem=code=>call('public.redeem_family_invite($1)',[code]);
  const note=(device,body)=>call('public.add_care_note($1,$2)',[device,body]);
  try {
    await db.exec(`create role anon;create role authenticated;create schema auth;
      create table auth.users(id uuid primary key,banned_until timestamptz,raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      grant usage on schema auth to authenticated;`);
    for(const file of ['schema.sql','video_schema.sql','family_schema.sql']) await db.exec(await readFile(new URL('../cloud/'+file,import.meta.url),'utf8'));
    await db.query('insert into auth.users(id) values($1),($2),($3),($4)',[U,U2,U3,U4]);
    await db.query('update auth.users set raw_user_meta_data=$1 where id=$2',[{display_name:'<img src=x onerror=alert(1)>'},U]);
    await db.query('insert into safenest_private.devices(id,token_hash) values($1,$3),($2,$3)',[D,D2,'f'.repeat(64)]);
    await db.query('insert into safenest_private.snapshots(device_id,payload) values($1,$3),($2,$3)',[D,D2,{room:'Test home',status:'Normal',events:[{status:'Normal'}]}]);
    for(const [code,device,max,expired,enabled] of [[CODE,D,2,false,true],[SECOND,D2,1,false,true],[EXPIRED,D,1,true,true],[DISABLED,D,1,false,false]]) {
      await db.query(`insert into safenest_private.family_invites(device_id,code_hash,expires_at,max_uses,enabled)
        values($1,encode(sha256(convert_to($2,'UTF8')),'hex'),clock_timestamp()+($3::integer * interval '1 hour'),$4,$5)`,[device,code,expired?-1:1,max,enabled]);
    }
    await t.test('anonymous RPC and direct-table access denied; all private tables use RLS',async()=>{
      const tables=(await db.query("select relname,relrowsecurity from pg_class join pg_namespace on relnamespace=pg_namespace.oid where nspname='safenest_private' and relkind='r'")).rows;
      assert.ok(tables.every(row=>row.relrowsecurity));
      for(const role of ['anon','authenticated']) {
        await user(role==='anon'?null:U,role);
        for(const table of ['devices','members','snapshots','family_invites','family_limits','care_notes']) {
          await assert.rejects(db.query('select * from safenest_private.'+table),/permission denied/);
          await assert.rejects(db.query('delete from safenest_private.'+table),/permission denied/);
        }
        await assert.rejects(call("safenest_private.family_limit('x',999)"),/permission denied/);
      }
      await user(null,'anon');
      for(const [sql,args] of [['public.list_my_monitors()',[]],['public.redeem_family_invite($1)',[CODE]],['public.list_care_notes($1)',[D]],['public.add_care_note($1,$2)',[D,'hi']]]) await assert.rejects(call(sql,args),/permission denied/);
      await user(null); await assert.rejects(call('public.list_my_monitors()'),/Sign in required/);
    });
    await t.test('new account has no homes, status, events, video or notes access',async()=>{
      await user(U); assert.deepEqual(await call('public.list_my_monitors()'),[]);
      await assert.rejects(call('public.read_monitor($1)',[D]),/denied/);
      await assert.rejects(call("public.video_viewer_session($1,'issue')",[D]),/denied/);
      await assert.rejects(call('public.list_care_notes($1)',[D]),/denied/);
      await assert.rejects(note(D,'unauthorized'),/denied/);
    });
    await t.test('invalid, malformed, expired and disabled codes share a generic response',async()=>{
      for(const code of ['bad',null,'0'.repeat(32),EXPIRED,DISABLED]) assert.deepEqual(await redeem(code),{ok:false,error:'invalid_invite'});
    });
    await t.test('valid code binds exactly once and exposes only that home',async()=>{
      assert.equal((await redeem(' '+CODE.toUpperCase()+' ')).ok,true);
      assert.equal((await redeem(CODE)).already_member,true);
      const homes=await call('public.list_my_monitors()'); assert.deepEqual(homes.map(h=>h.device_id),[D]);
      assert.equal((await call('public.read_monitor($1)',[D])).payload.status,'Normal');
      assert.ok((await call("public.video_viewer_session($1,'issue')",[D])).session_id);
      await admin(); assert.equal((await db.query('select uses from safenest_private.family_invites where code_hash=encode(sha256(convert_to($1,\'UTF8\')),\'hex\')',[CODE])).rows[0].uses,1);
      const values=JSON.stringify((await db.query('select * from safenest_private.family_invites')).rows); assert.ok(!values.includes(CODE));
      await user(U);
    });
    await t.test('cross-device status, video and note access rejected',async()=>{
      for(const sql of ['public.read_monitor($1)',"public.video_viewer_session($1,'issue')",'public.list_care_notes($1)']) await assert.rejects(call(sql,[D2]),/denied/);
      await assert.rejects(note(D2,'forged device'),/denied/);
    });
    await t.test('usage cap denies another account without leaking a device',async()=>{
      await user(U2); assert.equal((await redeem(CODE)).ok,true);
      await user(U3); assert.deepEqual(await redeem(CODE),{ok:false,error:'invalid_invite'});
      assert.deepEqual(await call('public.list_my_monitors()'),[]);
    });
    await t.test('brute-force counter persists after rejected requests and resets after window',async()=>{
      await user(U4);
      for(let i=0;i<10;i++) assert.equal((await redeem('invalid')).error,'invalid_invite');
      assert.equal((await redeem(SECOND)).error,'rate_limited');
      await admin();
      assert.equal((await db.query('select attempts from safenest_private.family_limits where scope=$1',['invite:'+U4])).rows[0].attempts,11);
      await db.query("update safenest_private.family_limits set window_at=clock_timestamp()-interval '61 seconds' where scope=$1",['invite:'+U4]);
      await user(U4); assert.equal((await redeem('invalid')).error,'invalid_invite');
    });
    await t.test('one account binds multiple homes; cap still enforced',async()=>{
      await user(U); assert.equal((await redeem(SECOND)).device_id,D2);
      assert.equal((await call('public.list_my_monitors()')).length,2);
      await user(U3); assert.equal((await redeem(SECOND)).error,'invalid_invite');
    });
    await t.test('notes length, blank rejection, authorship and per-account rate limit',async()=>{
      await user(U);
      for(const body of [null,'',' \n\t ', 'x'.repeat(1001)]) assert.deepEqual(await note(D,body),{ok:false,error:'invalid_note'});
      assert.equal((await note(D,'<script>alert(1)</script>')).ok,true);
      assert.equal((await note(D,'\u957f'.repeat(1000))).ok,true);
      for(let i=0;i<3;i++) assert.equal((await note(D,'Observation '+i)).ok,true);
      assert.deepEqual(await note(D2,'across devices'),{ok:false,error:'rate_limited'});
      await user(U2);
      const notes=await call('public.list_care_notes($1)',[D]); assert.equal(notes.length,5);
      assert.ok(notes.every(n=>n.author==='<img src=x onerror=alert(1)>' && n.is_mine===false && n.created_at && n.id));
      assert.ok(notes.some(n=>n.body==='<script>alert(1)</script>'));
      assert.equal((await note(D,'Another family member')).ok,true);
      await user(U3); await assert.rejects(call('public.list_care_notes($1)',[D]),/denied/);
      await admin();
      await db.query("update safenest_private.family_limits set window_at=clock_timestamp()-interval '61 seconds' where scope=$1",['note:'+U]);
      await user(U); assert.equal((await note(D,'Window reset')).ok,true);
      assert.equal((await call('public.read_monitor($1)',[D])).payload.status,'Normal');
    });
    await t.test('revocation, disabled devices and banned accounts denied',async()=>{
      await admin(); await db.query('delete from safenest_private.members where user_id=$1',[U2]);
      await user(U2); await assert.rejects(note(D,'after revoke'),/denied/);
      await assert.rejects(call('public.list_care_notes($1)',[D]),/denied/);
      await admin(); await db.query('update safenest_private.devices set enabled=false where id=$1',[D2]);
      await user(U); assert.equal((await call('public.list_my_monitors()')).length,1);
      await assert.rejects(note(D2,'disabled'),/denied/);
      await admin(); await db.query("update auth.users set banned_until=clock_timestamp()+interval '1 hour' where id=$1",[U]);
      await user(U); await assert.rejects(call('public.list_my_monitors()'),/Sign in required/);
      await assert.rejects(redeem(CODE),/Sign in required/);
    });
    await t.test('migration rerun preserves existing membership and notes',async()=>{
      await admin(); const before=await call('(select count(*) from safenest_private.care_notes)');
      await db.exec(await readFile(new URL('../cloud/family_schema.sql',import.meta.url),'utf8'));
      assert.equal(await call('(select count(*) from safenest_private.care_notes)'),before);
      assert.equal(await call('(select count(*) from safenest_private.members)'),2);
    });
    await t.test('administrator example returns one code and persists only its hash',async()=>{
      await admin();
      const template=await readFile(new URL('../cloud/create_family_invite.sql.example',import.meta.url),'utf8');
      const rows=(await db.query(template.replaceAll('REPLACE_DEVICE_UUID',D))).rows;
      assert.equal(rows.length,1);const created=rows[0];assert.match(created.invitation_code,/^[0-9a-f]{32}$/);
      const stored=(await db.query("select code_hash=encode(sha256(convert_to($1,'UTF8')),'hex') as valid,uses from safenest_private.family_invites where id=$2",[created.invitation_code,created.invite_id])).rows[0];
      assert.equal(stored.valid,true);assert.equal(stored.uses,0);assert.equal(created.max_uses,5);
    });
  } finally { await db.close(); }
});
