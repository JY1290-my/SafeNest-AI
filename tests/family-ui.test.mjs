import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from '../video_frontend/node_modules/jsdom/lib/api.js';
import {RecoverySession,recoveryLink} from '../web/password-recovery.js';
import {CloudClient} from '../web/cloud-client.js';
import {bootDashboard} from '../web/dashboard.js';
const html=await readFile(new URL('../web/index.html',import.meta.url),'utf8');
const config={supabaseUrl:'https://test.supabase.co',publishableKey:'public-key',videoEnabled:true,livekitUrl:'wss://test.livekit.cloud'};
const session={access_token:'user-one',refresh_token:'refresh-one',expires_in:3600};
const D='10000000-0000-4000-8000-000000000001',D2='10000000-0000-4000-8000-000000000002';
const homes=[{device_id:D,name:'Home A'},{device_id:D2,name:'Home B'}];
const reply=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
const snapshot=(name)=>({server_now:new Date().toISOString(),received_at:new Date().toISOString(),payload:{room:name,status:'Normal',camera_connected:true,demo:false,events:[{status:name+' event'}]}});
function harness(handler=()=>undefined,overrides={},saved={},url='https://family.example/') {
  const dom=new JSDOM(html,{url,pretendToBeVisual:true});
  const {window}=dom; window.SAFENEST_CONFIG={...config,...overrides};
  for(const [key,value] of Object.entries(saved))window.sessionStorage.setItem(key,value);
  const calls=[],cameras=[],presences=[];
  const fetcher=async(url,options={})=>{
    const path=new URL(url,'https://family.example').pathname,body=options.body?JSON.parse(options.body):{};
    const call={path,url,body,options};calls.push(call);
    const custom=await handler(call); if(custom!==undefined)return custom;
    if(path.startsWith('/auth/v1/'))return reply(session);
    if(path==='/api/status')return reply({},401);
    if(path.endsWith('list_my_monitors'))return reply(homes);
    if(path.endsWith('read_monitor'))return reply(snapshot(body.p_device===D?'Home A':'Home B'));
    if(path.endsWith('list_care_notes'))return reply([]);
    if(path.endsWith('list_fall_alerts'))return reply({alerts:[],unviewed_count:0});
    if(path.endsWith('redeem_family_invite'))return reply({ok:true,device_id:D});
    if(path.endsWith('add_care_note'))return reply({ok:true,id:'note'});
    return reply({});
  };
  const app=bootDashboard({window,document:window.document,fetch:fetcher,createFamilyPresence:options=>{
    const controller={options,stops:0,start(){options.onChange({state:'online',members:[{name:'Ka Ying',is_mine:true}]});},stop(){this.stops++;options.onChange({state:'stopped',members:[]});},refresh(){}};
    presences.push(controller);return controller;
  },createRemoteCamera:options=>{
    const camera={options,active:false,stops:0,start(){this.active=true;options.onState('Live',true);options.video.hidden=false;},stop(){this.active=false;this.stops++;options.video.hidden=true;options.onState('Paused',false);}};
    cameras.push(camera);return camera;
  }});
  const $=id=>window.document.getElementById(id);
  const submit=id=>$(id).dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
  const choose=id=>{$('device-select').value=id;$('device-select').dispatchEvent(new window.Event('change'));};
  const open=async(id=$('device-select').value)=>{choose(id);$('open-home').click();await settle();};
  const change=async id=>{$('choose-home').click();await settle();await open(id);};
  const login=async(signup=false,monitor=true)=>{await app.ready;if(signup)$('signup-tab').click();$('email').value='relative@example.com';$('password').value='test-password';$('display-name').value='Relative';submit('login-form');await settle();if(monitor&&!overrides.mode&&!$('open-home').disabled)await open();};
  return {app,window,$,submit,change,login,choose,open,calls,cameras,presences,saved(){return Object.fromEntries(Object.keys(window.sessionStorage).map(key=>[key,window.sessionStorage.getItem(key)]));},close(){app.dispose();window.close();}};
}
test('Family Dashboard lists authorized homes without opening video or asking for another invitation',async()=>{
 const h=harness();
 try{
  await h.app.ready;h.$('show-invite').click();h.submit('invite-form');
  assert.equal(h.$('invite-panel').hidden,true);assert.equal(h.calls.length,0);
  await h.login(false,false);
  assert.equal(h.$('family-title').textContent,'Family Dashboard');
  assert.equal(h.$('device-select').options.length,2);
  assert.equal(h.$('invite-panel').hidden,true);
  assert.equal(h.$('show-invite').getAttribute('aria-expanded'),'false');
  assert.equal(h.$('local-setup-panel').hidden,true);
  assert.equal(h.cameras.length,0);
  assert.ok(!h.calls.some(c=>c.path.endsWith('read_monitor')||c.path.endsWith('redeem_family_invite')));
  h.$('show-invite').click();assert.equal(h.$('invite-panel').hidden,false);
  assert.equal(h.window.document.activeElement,h.$('invite-code'));
  h.$('invite-code').value='private-code';h.$('cancel-invite').click();
  assert.equal(h.$('invite-code').value,'');assert.equal(h.$('invite-panel').hidden,true);
  assert.equal(h.window.document.activeElement,h.$('show-invite'));
  assert.ok(!JSON.stringify(h.saved()).includes('private-code'));
 }finally{h.close();}
});
test('unbound accounts get an explicit add-home choice, not a device setup privilege',async()=>{
 const h=harness(c=>c.path.endsWith('list_my_monitors')?reply([]):undefined);
 try{
  await h.login(false,false);assert.match(h.$('homes-message').textContent,/No homes linked/);
  assert.equal(h.$('open-home').disabled,true);assert.equal(h.$('invite-panel').hidden,true);
  h.choose(D2);h.$('open-home').click();h.$('view-camera').click();await settle();
  assert.equal(h.$('dashboard').hidden,true);assert.equal(h.cameras.length,0);
  assert.ok(!h.calls.some(c=>c.path.endsWith('read_monitor')||c.path.endsWith('video-token')));
  h.$('show-invite').click();assert.equal(h.$('invite-panel').hidden,false);
  assert.match(h.$('family-panel').textContent,/cannot register cameras/);
 }finally{h.close();}
});
test('invitation success closes and clears the form without automatically starting monitoring',async()=>{
 const h=harness();
 try{
  await h.login(false,false);h.$('show-invite').click();h.$('invite-code').value='a'.repeat(32);
  h.submit('invite-form');await settle();
  assert.equal(h.$('invite-panel').hidden,true);assert.equal(h.$('invite-code').value,'');
  assert.match(h.$('invite-message').textContent,/linked/);
  assert.equal(h.$('dashboard').hidden,true);assert.equal(h.cameras.length,0);
  assert.equal(h.$('show-invite').disabled,false);
  assert.ok(!JSON.stringify(h.saved()).includes('a'.repeat(32)));
 }finally{h.close();}
});
test('late invitation response cannot switch devices or restore an old signed-out screen',async()=>{
 for(const leave of ['device','logout']){
  const result=deferred();const h=harness(c=>c.path.endsWith('redeem_family_invite')?result.promise:undefined);
  try{
   await h.login(false,false);h.$('show-invite').click();h.$('invite-code').value='a'.repeat(32);
   h.submit('invite-form');await settle();
   if(leave==='device')await h.open(D2);else{h.$('homes-logout').click();await settle();}
   const before=h.calls.filter(c=>c.path.endsWith('list_my_monitors')).length;
   result.resolve(reply({ok:true,device_id:D}));await settle();
   assert.equal(h.$('invite-panel').hidden,true);assert.equal(h.$('invite-code').value,'');
   assert.equal(h.calls.filter(c=>c.path.endsWith('list_my_monitors')).length,before);
   if(leave==='device'){
    assert.equal(h.$('room').textContent,'Home B');assert.equal(h.$('device-select').value,D2);
    h.$('choose-home').click();await settle();h.$('show-invite').click();
    assert.equal(h.$('bind-device').disabled,false);
   }else assert.equal(h.$('auth-content').hidden,false);
  }finally{h.close();}
 }
});
test('list errors are distinct from no devices and raw invitations are cleared on page teardown',async()=>{
 const h=harness(c=>c.path.endsWith('list_my_monitors')?reply({},503):undefined);
 try{
  await h.login(false,false);assert.match(h.$('homes-message').textContent,/Could not load/);
  assert.equal(h.$('invite-panel').hidden,true);
  h.$('show-invite').click();h.$('invite-code').value='private-code';
  h.window.dispatchEvent(new h.window.Event('pagehide'));
  assert.equal(h.$('invite-panel').hidden,true);assert.equal(h.$('invite-code').value,'');
 }finally{h.close();}
});
test('local monitor has separate setup guidance and cannot submit family invitation operations',async()=>{
 let authenticated=false;
 const h=harness(c=>{
  if(c.path==='/api/login'){authenticated=true;return reply({ok:true});}
  if(c.path==='/api/status')return authenticated?reply(snapshot('Local room')):reply({},401);
 },{mode:'local'});
 try{
  await h.app.ready;assert.equal(h.$('auth-title').textContent,'Local monitoring');
  assert.equal(h.$('local-setup-panel').hidden,true);
  await h.login();assert.equal(h.$('local-setup-panel').hidden,false);
  assert.match(h.$('local-setup-panel').textContent,/Start_Camera_Setup.cmd/);
  assert.equal(h.$('family-panel').hidden,true);assert.equal(h.$('choose-home').hidden,true);
  h.$('show-invite').click();h.submit('invite-form');await settle();
  assert.ok(!h.calls.some(c=>c.path.startsWith('/rest/')||c.path.startsWith('/functions/')));
  assert.equal(h.cameras.length,0);
  h.$('logout').click();await settle();assert.equal(h.$('local-setup-panel').hidden,true);
 }finally{h.close();}
});
test('context reasons render as text and disappear on stale data, device switch and logout',async()=>{
  let disconnected=false;
  const h=harness(c=>{
    if(c.path.endsWith('read_monitor')){
      if(disconnected)return reply({},503);
      const data=snapshot('Context home');
      data.payload.status='Resting in Bed';
      data.payload.context={calibration:'<img src=x onerror=alert(1)>',visible_count:1,missing_count:0,
        people:[{person_number:1,state:'RESTING_IN_BED',reason:'<script>bad()</script>'}]};
      data.payload.events=[{status:'Person 1: Check Person',time:new Date().toISOString(),reason:'<img src=x>'}];
      return reply(data);
    }
  });
  try{
    await h.login();assert.equal(h.$('context-panel').hidden,false);
    assert.match(h.$('person-context').textContent,/Resting in bed — monitoring/);
    assert.equal(h.$('context-panel').querySelector('script,img'),null);
    assert.equal(h.$('events').querySelector('img'),null);
    disconnected=true;await h.app.poll();assert.equal(h.$('context-panel').hidden,true);
    assert.equal(h.$('person-context').textContent,'');
    disconnected=false;await h.app.poll();assert.equal(h.$('context-panel').hidden,false);
    h.$('choose-home').click();assert.equal(h.$('context-panel').hidden,true);
    await settle();await h.open();
    h.$('logout').click();await settle();
    assert.equal(h.$('context-panel').hidden,true);
  }finally{h.close();}
});
test('signup with confirmation enabled stays signed out and never reads device data',async()=>{
  const h=harness(c=>c.path==='/auth/v1/signup'?reply({id:'new-user'}):undefined);
  try {await h.login(true);assert.equal(h.$('dashboard').hidden,true);assert.match(h.$('login-message').textContent,/confirmation email/);assert.equal(h.calls.length,1);assert.equal(h.calls[0].body.data.display_name,'Relative');assert.equal(h.$('sign-in').textContent,'Sign in');}finally{h.close();}
});
test('signup without confirmation signs in with an empty home list and no monitor reads',async()=>{
  const h=harness(c=>c.path.endsWith('list_my_monitors')?reply([]):undefined);
  try {await h.login(true);assert.equal(h.$('dashboard').hidden,true);assert.equal(h.$('login').hidden,false);assert.equal(h.$('auth-content').hidden,true);assert.equal(h.$('family-panel').hidden,false);assert.equal(h.$('monitor-content').hidden,true);assert.match(h.$('homes-message').textContent,/No homes linked/);assert.match(h.$('invite-message').textContent,/Account created/);assert.ok(!h.calls.some(c=>c.path.endsWith('read_monitor')||c.path.includes('video-token')));}finally{h.close();}
});
test('signup errors and unconfirmed sign-in show safe actionable messages',async()=>{
  const h=harness(c=>c.path.startsWith('/auth/v1/')?reply({error_code:c.path.endsWith('signup')?'weak_password':'email_not_confirmed',msg:'<script>secret</script>'},400):undefined);
  try {await h.login(true);assert.match(h.$('login-message').textContent,/Account creation failed/);h.$('login-tab').click();await h.login();assert.match(h.$('login-message').textContent,/Confirm your email/);assert.ok(!h.$('login-message').textContent.includes('secret'));assert.equal(h.$('sign-in').disabled,false);}finally{h.close();}
});
test('invite binding refreshes list, selects new home, and gives generic failure or rate message',async()=>{
  let bound=false,mode='bad';
  const h=harness(c=>{
    if(c.path.endsWith('list_my_monitors'))return reply(bound?homes:[]);
    if(c.path.endsWith('redeem_family_invite')) {if(mode==='good'){bound=true;return reply({ok:true,device_id:D2});}return reply({ok:false,error:mode==='rate'?'rate_limited':'invalid_invite'});}
  });
  try {await h.login();h.$('show-invite').click();h.$('invite-code').value='test';h.submit('invite-form');await settle();assert.match(h.$('invite-message').textContent,/Invitation unavailable/);
    mode='rate';h.submit('invite-form');await settle();assert.match(h.$('invite-message').textContent,/Wait one minute/);
    mode='good';h.submit('invite-form');await settle();assert.equal(h.$('device-select').value,D2);assert.equal(h.$('dashboard').hidden,true);assert.equal(h.$('invite-code').value,'');await h.open();assert.equal(h.$('room').textContent,'Home B');
  }finally{h.close();}
});
test('switch stops old camera, isolates its element and ignores late status, notes and callbacks',async()=>{
  const status=deferred(),notes=deferred();let delay=false;
  const h=harness(c=>{
    if(delay&&c.body.p_device===D&&c.path.endsWith('read_monitor'))return status.promise;
    if(delay&&c.body.p_device===D&&c.path.endsWith('list_care_notes'))return notes.promise;
  });
  try {await h.login();h.$('view-camera').click();const old=h.cameras[0];assert.equal(old.options.deviceId,D);
    delay=true;const pending=h.app.poll(),pendingNotes=h.app.loadNotes();await settle();await h.change(D2);
    assert.ok(old.stops>0);assert.equal(h.$('room').textContent,'Home B');assert.ok(!h.$('events').textContent.includes('Home A'));
    h.$('view-camera').click();const current=h.cameras[1];assert.notEqual(old.options.video,current.options.video);assert.equal(current.options.deviceId,D2);
    status.resolve(reply(snapshot('OLD HOME')));notes.resolve(reply([{author:'Old',body:'Old note',created_at:new Date().toISOString()}]));await Promise.all([pending,pendingNotes]);
    old.options.onState('OLD DISCONNECT',false);assert.equal(h.$('room').textContent,'Home B');assert.ok(!h.$('notes').textContent.includes('Old note'));assert.equal(h.$('stream-state').textContent,'Live');assert.equal(h.$('camera-video').hidden,false);
  }finally{h.close();}
});
test('notes use text rendering; in-flight posts never clear another home draft',async()=>{
  const post=deferred();let delay=false;
  const h=harness(c=>{
    if(c.path.endsWith('list_care_notes'))return reply([{author:'<img src=x onerror=alert(1)>',body:'<script>alert(1)</script>',created_at:new Date().toISOString(),is_mine:true}]);
    if(c.path.endsWith('add_care_note')&&delay)return post.promise;
  });
  try {await h.login();assert.equal(h.$('notes').querySelector('script,img'),null);assert.match(h.$('notes').textContent,/<script>/);
    h.$('note-body').value=' ';h.submit('note-form');await settle();assert.match(h.$('note-message').textContent,/1–1,000/);
    delay=true;h.$('note-body').value='A observation';h.submit('note-form');await settle();assert.equal(h.calls.filter(c=>c.path.endsWith('add_care_note')).at(-1).body.p_device,D);
    await h.change(D2);h.$('note-body').value='B draft';post.resolve(reply({ok:true}));await settle();assert.equal(h.$('note-body').value,'B draft');assert.equal(h.$('note-message').textContent,'');
  }finally{h.close();}
});
test('revocation clears visible device data but keeps an account able to enter invitations',async()=>{
  let revoked=false;
  const h=harness(c=>{
    if(revoked&&c.path.endsWith('read_monitor'))return reply({code:'42501'},403);
    if(revoked&&c.path.endsWith('list_my_monitors'))return reply([]);
  });
  try {await h.login();h.$('view-camera').click();revoked=true;await h.app.poll();await settle();assert.equal(h.$('dashboard').hidden,true);assert.equal(h.$('family-panel').hidden,false);assert.equal(h.$('monitor-content').hidden,true);assert.equal(h.$('events').textContent,'');assert.ok(h.cameras[0].stops>0);}finally{h.close();}
});
test('local login and status preview remain available without family controls',async()=>{
  const h=harness(c=>c.path==='/api/status'?reply({...snapshot('Local home'),camera_transport:'local-jpeg'}):undefined,{mode:'local'});
  try {await h.login();assert.equal(h.$('family-panel').hidden,true);assert.equal(h.$('signup-tab').hidden,true);assert.equal(h.$('notes-panel').hidden,true);assert.equal(h.$('monitor-content').hidden,false);assert.equal(h.$('room').textContent,'Local home');assert.equal(h.$('view-camera').disabled,false);assert.ok(h.calls.every(c=>c.path.startsWith('/api/')));}finally{h.close();}
});
test('single refresh serves simultaneous RPCs without rotating the token twice',async()=>{
  const refresh=deferred(),calls=[];let now=0;
  const client=new CloudClient(config,async(url,options)=>{calls.push({url,options});return url.includes('refresh_token')?refresh.promise:reply([]);},()=>now);
  client.save(session);now=3600000;
  const a=client.rpc('list_my_monitors'),b=client.rpc('list_care_notes',{p_device:D});await settle();
  assert.equal(calls.length,1);refresh.resolve(reply({...session,access_token:'refreshed'}));await Promise.all([a,b]);
  assert.equal(calls.length,3);assert.ok(calls.slice(1).every(c=>c.options.headers.Authorization==='Bearer refreshed'));
});
test('old camera releases correct device/account after switching or signing out',async()=>{
  const calls=[],issue=deferred();
  const client=new CloudClient(config,async(url,options)=>{const body=JSON.parse(options.body);calls.push({body,token:options.headers.Authorization});return body.action==='issue'?issue.promise:reply({});});
  client.save(session);const old=client.cameraRequester(D);const pending=old('issue');await settle();
  client.clear();client.save({...session,access_token:'user-two'});issue.resolve(reply({session_id:'old-lease'}));const lease=await pending;
  await old('release',lease.session_id);assert.deepEqual(calls.at(-1),{body:{device_id:D,action:'release',session_id:'old-lease'},token:'Bearer user-one'});
  await assert.rejects(old('renew','old-lease'),/Session changed/);
});
test('late refresh cannot restore a signed-out account',async()=>{
  const refresh=deferred();const client=new CloudClient(config,()=>refresh.promise,()=>1000);
  client.save({...session,expires_in:0});const pending=client.token();await settle();client.clear();refresh.resolve(reply(session));await assert.rejects(pending,/Session changed/);assert.equal(client.session,null);
});
test('note rate and validation errors preserve the draft and re-enable posting',async()=>{
  let error='rate_limited';
  const h=harness(c=>c.path.endsWith('add_care_note')?reply({ok:false,error}):undefined);
  try {await h.login();h.$('note-body').value='Keep this draft';h.submit('note-form');await settle();
    assert.match(h.$('note-message').textContent,/5 notes per minute/);assert.equal(h.$('note-body').value,'Keep this draft');assert.equal(h.$('post-note').disabled,false);
    error='invalid_note';h.submit('note-form');await settle();assert.match(h.$('note-message').textContent,/1–1,000/);
  }finally{h.close();}
});
test('refreshing home list cannot undo a selection made while it was loading',async()=>{
  const list=deferred();let delay=false;
  const h=harness(c=>delay&&c.path.endsWith('list_my_monitors')?list.promise:undefined);
  try {await h.login(false,false);delay=true;h.$('refresh-homes').click();await settle();h.choose(D2);list.resolve(reply(homes));await settle();assert.equal(h.$('device-select').value,D2);await h.open();assert.equal(h.$('room').textContent,'Home B');}finally{h.close();}
});
test('confirmation return clears URL tokens and does not auto-grant a session',()=>{
  const dom=new JSDOM(html,{url:'https://family.example/#access_token=private-token&refresh_token=private-refresh'});
  dom.window.SAFENEST_CONFIG=config;
  let calls=0;
  const app=bootDashboard({window:dom.window,document:dom.window.document,fetch:async()=>{calls++;return reply({});},createRemoteCamera:()=>{throw new Error('Unexpected video');}});
  try {assert.equal(dom.window.location.hash,'');assert.equal(calls,0);assert.equal(dom.window.document.getElementById('dashboard').hidden,true);assert.match(dom.window.document.getElementById('login-message').textContent,/Sign in with your email/);}finally{app.dispose();dom.window.close();}
});

test('Followed homes lives in the signed-in login page; monitoring opens only on request',async()=>{
  const h=harness();
  try {
    assert.equal(h.$('family-panel').hidden,true);
    await h.login(false,false);
    assert.equal(h.$('login').contains(h.$('family-panel')),true);
    assert.equal(h.$('dashboard').contains(h.$('family-panel')),false);
    assert.equal(h.$('login').hidden,false);assert.equal(h.$('auth-content').hidden,true);
    assert.equal(h.$('dashboard').hidden,true);assert.equal(h.$('family-panel').hidden,false);
    assert.ok(!h.calls.some(c=>c.path.endsWith('read_monitor')||c.path.endsWith('list_care_notes')));
    await h.open(D2);assert.equal(h.$('dashboard').hidden,false);assert.equal(h.$('login').hidden,true);
    assert.equal(h.$('room').textContent,'Home B');
    h.$('choose-home').click();await settle();
    assert.equal(h.$('login').hidden,false);assert.equal(h.$('family-panel').hidden,false);
    assert.equal(h.$('auth-content').hidden,true);assert.equal(h.$('dashboard').hidden,true);
  }finally{h.close();}
});
test('F5 restores the signed-in selected home after membership RPC, without restarting video',async()=>{
  const first=harness();let saved;
  try {
    await first.login();await first.change(D2);first.$('view-camera').click();
    saved=first.saved();
    assert.ok(!JSON.stringify(saved).includes('test-password'));
    assert.ok(!JSON.stringify(saved).includes('Home B event'));
    first.window.dispatchEvent(new first.window.Event('pagehide'));
    assert.ok(first.cameras.at(-1).stops>0);
  }finally{first.close();}
  const membership=deferred();
  const next=harness(c=>c.path.endsWith('list_my_monitors')?membership.promise:undefined,{},saved);
  try {
    await settle();assert.equal(next.$('dashboard').hidden,true);
    assert.ok(!next.calls.some(c=>c.path.endsWith('read_monitor')));
    membership.resolve(reply(homes));await next.app.ready;await settle();
    assert.equal(next.$('dashboard').hidden,false);assert.equal(next.$('room').textContent,'Home B');
    assert.equal(next.calls.filter(c=>c.path.endsWith('read_monitor'))[0].body.p_device,D2);
    assert.ok(!next.calls.some(c=>c.url.includes('grant_type=password')));
    assert.equal(next.cameras.length,0);assert.equal(next.$('camera-video').hidden,true);
  }finally{next.close();}
});
test('F5 preserves the home chooser and does not read monitors before Open monitoring',async()=>{
  const first=harness();let saved;
  try {await first.login(false,false);first.choose(D2);saved=first.saved();}finally{first.close();}
  const next=harness(()=>undefined,{},saved);
  try {await next.app.ready;assert.equal(next.$('dashboard').hidden,true);assert.equal(next.$('family-panel').hidden,false);
    assert.equal(next.$('device-select').value,D2);assert.ok(!next.calls.some(c=>c.path.endsWith('read_monitor')));
  }finally{next.close();}
});
test('expired saved access token refreshes once and persists its replacement across F5',async()=>{
  const key='safenest:session:'+config.supabaseUrl;
  const saved={[key]:JSON.stringify({version:1,...session,expires_at:Date.now()/1000-10})};
  const h=harness(c=>c.url.includes('grant_type=refresh_token')?reply({...session,access_token:'new-access',refresh_token:'new-refresh'}):undefined,{},saved);
  try {
    await h.app.ready;assert.equal(h.$('family-panel').hidden,false);
    assert.equal(h.calls.filter(c=>c.url.includes('grant_type=refresh_token')).length,1);
    assert.equal(h.calls.find(c=>c.path.endsWith('list_my_monitors')).options.headers.Authorization,'Bearer new-access');
    const persisted=JSON.parse(h.saved()[key]);assert.equal(persisted.refresh_token,'new-refresh');assert.ok(persisted.expires_at>Date.now()/1000);
  }finally{h.close();}
});
test('invalid saved refresh token clears sign-in and selected home on F5',async()=>{
  const key='safenest:session:'+config.supabaseUrl,viewKey='safenest:view:'+config.supabaseUrl;
  const saved={[key]:JSON.stringify({version:1,...session,expires_at:Date.now()/1000-10}),[viewKey]:JSON.stringify({screen:'monitor',deviceId:D})};
  const h=harness(c=>c.url.includes('grant_type=refresh_token')?reply({error_code:'refresh_token_not_found'},400):undefined,{},saved);
  try {await h.app.ready;assert.equal(h.$('auth-content').hidden,false);assert.equal(h.$('family-panel').hidden,true);assert.equal(h.$('dashboard').hidden,true);
    assert.match(h.$('login-message').textContent,/Session expired/);assert.equal(h.saved()[key],undefined);assert.equal(h.saved()[viewKey],undefined);
    assert.ok(!h.calls.some(c=>c.path.endsWith('read_monitor')));
  }finally{h.close();}
});
test('restored unauthorized device preferences never grant access',async()=>{
  const key='safenest:session:'+config.supabaseUrl,viewKey='safenest:view:'+config.supabaseUrl;
  const saved={[key]:JSON.stringify({version:1,...session,expires_at:Date.now()/1000+3500}),[viewKey]:JSON.stringify({screen:'monitor',deviceId:D2})};
  const h=harness(c=>c.path.endsWith('list_my_monitors')?reply([homes[0]]):undefined,{},saved);
  try {await h.app.ready;assert.equal(h.$('dashboard').hidden,true);assert.equal(h.$('family-panel').hidden,false);
    assert.ok(!h.calls.some(c=>c.path.endsWith('read_monitor')||c.path.endsWith('list_care_notes')));
    assert.equal(h.$('device-select').value,D);
  }finally{h.close();}
});
test('signing out removes saved tokens and F5 does not sign in again',async()=>{
  const first=harness();let saved;
  try {await first.login(false,false);first.$('homes-logout').click();await settle();saved=first.saved();
    assert.deepEqual(saved,{});assert.equal(first.$('auth-content').hidden,false);
  }finally{first.close();}
  const next=harness(()=>undefined,{},saved);
  try {await next.app.ready;assert.equal(next.$('family-panel').hidden,true);assert.equal(next.$('dashboard').hidden,true);assert.equal(next.calls.length,0);}finally{next.close();}
});
test('returning to home chooser releases camera and suspends monitor and note polling',async()=>{
  const h=harness();
  try {await h.login();h.$('view-camera').click();const camera=h.cameras[0];
    h.$('choose-home').click();await settle();assert.ok(camera.stops>0);assert.equal(h.$('events').textContent,'');
    const before=h.calls.length;await h.app.poll();await h.app.loadNotes();assert.equal(h.calls.length,before);
    assert.equal(h.$('dashboard').hidden,true);
    await h.open(D2);assert.equal(h.$('room').textContent,'Home B');
  }finally{h.close();}
});
test('malformed stored session is removed and gives no monitoring access',async()=>{
  const key='safenest:session:'+config.supabaseUrl;
  for(const value of ['{bad json}',JSON.stringify({version:1,access_token:42,refresh_token:'x',expires_at:9999999999})]) {
    const h=harness(()=>undefined,{}, {[key]:value});
    try {await h.app.ready;assert.equal(h.saved()[key],undefined);assert.equal(h.calls.length,0);assert.equal(h.$('auth-content').hidden,false);}finally{h.close();}
  }
});
test('temporary network failure keeps saved Auth session and allows retrying home list',async()=>{
  const key='safenest:session:'+config.supabaseUrl;
  let offline=true;
  const h=harness(c=>{if(offline&&c.path.endsWith('list_my_monitors'))throw new TypeError('offline');}, {},
    {[key]:JSON.stringify({version:1,...session,expires_at:Date.now()/1000+3500})});
  try {await h.app.ready;assert.ok(h.saved()[key]);assert.equal(h.$('dashboard').hidden,true);assert.match(h.$('homes-message').textContent,/Could not load/);
    offline=false;h.$('refresh-homes').click();await settle();assert.equal(h.$('open-home').disabled,false);await h.open();assert.equal(h.$('room').textContent,'Home A');
  }finally{h.close();}
});
test('F5 local mode restores server cookie session without a password request',async()=>{
  const h=harness(c=>c.path==='/api/status'?reply({...snapshot('Local home'),camera_transport:'local-jpeg'}):undefined,{mode:'local'});
  try {await h.app.ready;await settle();assert.equal(h.$('dashboard').hidden,false);assert.equal(h.$('room').textContent,'Local home');
    assert.ok(!h.calls.some(c=>c.path==='/api/login'));assert.deepEqual(h.saved(),{});
  }finally{h.close();}
});
test('late refresh after sign-out cannot restore persisted Auth tokens',async()=>{
  const values=new Map(),storage={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
  const refresh=deferred();
  const client=new CloudClient(config,()=>refresh.promise,()=>1000,{storage});
  client.save({...session,expires_in:0});const pending=client.token();await settle();client.clear();refresh.resolve(reply(session));
  await assert.rejects(pending,/Session changed/);assert.equal(values.size,0);
});
test('storage-denied browsers can still sign in and read authorized devices',async()=>{
  const storage={getItem(){throw new Error('denied');},setItem(){throw new Error('denied');},removeItem(){throw new Error('denied');}};
  const client=new CloudClient(config,async url=>reply(url.endsWith('/signup')?session:[]),undefined,{storage});
  assert.equal(client.restore(),false);
  assert.equal(await client.authenticate('signup','relative@example.com','test-password','Relative'),'signed_in');
  assert.deepEqual(await client.rpc('list_my_monitors'),[]);client.clear();assert.equal(client.session,null);
});

test('per-person fall events retain danger highlighting and safe text rendering',async()=>{
  const h=harness(c=>{
    if(c.path.endsWith('read_monitor')) {
      const data=snapshot('Home A');
      data.payload.status='Suspected Fall';
      data.payload.events=[{status:'Person 2: Suspected Fall',angle_deg:'90',width_height_ratio:'2'},
        {status:'Person 1: Normal'},{status:'<img src=x onerror=alert(1)>'}];
      return reply(data);
    }
  });
  try {
    await h.login();
    const events=h.$('events');
    assert.equal(events.querySelector('.event-danger').textContent,'Person 2: Suspected Fall');
    assert.match(events.textContent,/Person 1: Normal/);
    assert.match(events.textContent,/<img src=x onerror=alert\(1\)>/);
    assert.equal(events.querySelector('img'),null);
  } finally {h.close();}
});

test('one invitation redemption persists across F5, sign-out/sign-in and a new browser',async()=>{
 let bound=false,redemptions=0;
 const backend=c=>{
  if(c.path.endsWith('list_my_monitors'))return reply(bound?[homes[0]]:[]);
  if(c.path.endsWith('redeem_family_invite')){redemptions++;bound=true;return reply({ok:true,device_id:D});}
 };
 const first=harness(backend);let saved;
 try{
  await first.login(false,false);assert.match(first.$('homes-message').textContent,/No homes linked/);
  first.$('show-invite').click();first.$('invite-code').value='a'.repeat(32);first.submit('invite-form');await settle();await first.open();saved=first.saved();
  assert.ok(!JSON.stringify(saved).includes('a'.repeat(32)));assert.equal(redemptions,1);
 }finally{first.close();}
 const reload=harness(backend,{},saved);
 try{
  await reload.app.ready;await settle();assert.equal(reload.$('dashboard').hidden,false);
  reload.$('logout').click();await settle();await reload.login(false,false);assert.equal(reload.$('device-select').options.length,1);
  assert.equal(reload.$('invite-code').value,'');
 }finally{reload.close();}
 const otherBrowser=harness(backend);
 try{await otherBrowser.login();assert.equal(otherBrowser.$('room').textContent,'Home A');assert.equal(redemptions,1);}finally{otherBrowser.close();}
});
test('event display takes the newest 10 of an unsorted list and leaves server data unchanged',async()=>{
 const events=Array.from({length:30},(_,i)=>({time:`2026-10-16T08:${String(i).padStart(2,'0')}:00`,status:'Event '+i}));
 const original=JSON.stringify(events);
 const h=harness(c=>{if(c.path.endsWith('read_monitor')){const value=snapshot('Home A');value.payload.events=events;return reply(value);}});
 try{await h.login();const items=[...h.$('events').querySelectorAll('li')];assert.equal(items.length,10);
  assert.equal(items[0].querySelector('span').textContent,'Event 29');assert.equal(items[9].querySelector('span').textContent,'Event 20');assert.equal(JSON.stringify(events),original);
 }finally{h.close();}
});
test('names fall back safely and existing accounts can save a display name through their Auth session',async()=>{
 let name='',put;
 const h=harness(c=>{
  if(c.path==='/auth/v1/user'){if(c.options.method==='PUT'){put=c;name=c.body.data.display_name;}return reply({user_metadata:{display_name:name}});}
  if(c.path.endsWith('list_care_notes'))return reply([{author:name||'',body:'Observation',created_at:new Date().toISOString()}, {author:'person@example.com',body:'Legacy name',created_at:new Date().toISOString()}]);
 });
 try{
  await h.login();assert.match(h.$('notes').textContent,/Family member/);assert.ok(!h.$('notes').textContent.includes('@'));
  h.$('choose-home').click();await settle();h.$('profile-name').value='Ka Ying';h.submit('profile-form');await settle();
  assert.equal(put.options.headers.Authorization,'Bearer user-one');assert.deepEqual(put.body,{data:{display_name:'Ka Ying'}});
  await h.open();assert.match(h.$('notes').textContent,/Ka Ying/);
 }finally{h.close();}
});
test('device switch, revocation, logout and pagehide clear old presence and floating camera views',async()=>{
 let revoked=false;
 const h=harness(c=>{
  if(revoked&&c.path.endsWith('list_my_monitors'))return reply([]);
  if(revoked&&c.path.endsWith('read_monitor'))return reply({code:'42501'},403);
 });
 try{
  await h.login();h.$('view-camera').click();h.$('camera-pip').click();await settle();
  assert.ok(h.$('camera-stage').classList.contains('is-floating'));const old=h.presences[0];
  await h.change(D2);assert.ok(old.stops);assert.ok(!h.$('camera-stage').classList.contains('is-floating'));
  old.options.onChange({state:'online',members:[{name:'OLD PERSON'}]});assert.ok(!h.$('online-members').textContent.includes('OLD PERSON'));
  h.$('view-camera').click();h.$('camera-pip').click();revoked=true;await h.app.poll();await settle();
  assert.equal(h.$('online-members').textContent,'');assert.equal(h.$('dashboard').hidden,true);assert.ok(h.cameras.at(-1).stops);
  revoked=false;h.$('refresh-homes').click();await settle();await h.open(D);h.$('view-camera').click();h.$('camera-pip').click();
  h.window.dispatchEvent(new h.window.Event('pagehide'));assert.ok(h.presences.at(-1).stops);assert.ok(!h.$('camera-stage').classList.contains('is-floating'));
  h.window.dispatchEvent(new h.window.Event('pageshow'));await settle();assert.equal(h.$('online-members').textContent,'Ka Ying (you)');
  h.$('logout').click();await settle();assert.equal(h.$('online-members').textContent,'');assert.equal(h.$('presence-panel').hidden,true);
 }finally{h.close();}
});
test('native PiP survives switching browser tabs and is exited on logout',async()=>{
 const h=harness();let exits=0;
 try{
  Object.defineProperty(h.window.document,'pictureInPictureEnabled',{configurable:true,value:true});
  h.window.HTMLVideoElement.prototype.requestPictureInPicture=async function(){h.window.document.pictureInPictureElement=this;};
  h.window.document.exitPictureInPicture=async()=>{exits++;h.window.document.pictureInPictureElement=null;};
  await h.login();h.$('view-camera').click();h.$('camera-pip').click();await settle();
  const old=h.cameras[0];Object.defineProperty(h.window.document,'hidden',{configurable:true,value:true});
  h.window.document.dispatchEvent(new h.window.Event('visibilitychange'));assert.equal(old.stops,0);
  h.$('logout').click();await settle();assert.equal(exits,1);assert.ok(old.stops);assert.equal(h.$('camera-video').hidden,true);
 }finally{h.close();}
});
test('a late Presence leave always uses the old device and old account token',async()=>{
 const calls=[];const client=new CloudClient(config,async(url,options)=>{calls.push({url,body:JSON.parse(options.body),token:options.headers.Authorization});return reply({ok:true});});
 client.save(session);const old=client.presenceRequester(D);await old('heartbeat','old-session');
 client.clear();client.save({...session,access_token:'other-user'});await old('leave','old-session');
 assert.equal(calls.at(-1).body.p_device,D);assert.equal(calls.at(-1).token,'Bearer user-one');await assert.rejects(old('heartbeat','old-session'),/Session changed/);
});

test('media controls reset clips and settings on device switch, revocation, logout and pagehide',async()=>{
  let revoked=false;
  const h=harness(c=>revoked&&c.path.endsWith('read_monitor')?reply({code:'42501'},403):undefined);
  const urls=[],revokes=[];h.window.URL.createObjectURL=()=>{const u='blob:test/'+urls.length;urls.push(u);return u;};h.window.URL.revokeObjectURL=u=>revokes.push(u);
  h.window.HTMLMediaElement.prototype.pause=function(){};h.window.HTMLMediaElement.prototype.load=function(){};
  h.window.MediaStream=class{constructor(tracks){this.tracks=tracks;}getVideoTracks(){return this.tracks;}};
  h.window.MediaRecorder=class{static isTypeSupported(){return true;}constructor(){this.mimeType='video/webm';}start(){this.state='recording';}stop(){this.state='inactive';queueMicrotask(()=>{this.ondataavailable({data:new h.window.Blob(['clip'])});this.onstop();});}};
  const start=async()=>{
    h.$('view-camera').click();const camera=h.cameras.at(-1),video=camera.options.video;
    video.srcObject=new h.window.MediaStream([{readyState:'live',clone:()=>({stop(){}})}]);
    Object.defineProperties(video,{readyState:{value:2},videoWidth:{value:640},videoHeight:{value:480}});
    camera.options.onState('Live',true);h.$('record-video').click();h.$('record-video').click();await settle();assert.equal(h.$('local-clips').children.length,1);h.$('open-settings').click();return camera;
  };
  try{
    await h.login();let old=await start();await h.change(D2);assert.equal(h.$('local-clips').children.length,0);assert.equal(h.$('settings-panel').hidden,true);assert.ok(old.stops>0);assert.equal(h.$('capture-frame').disabled,true);assert.ok(!h.$('events').textContent.includes('Home A'));
    old=await start();revoked=true;await h.app.poll();await settle();assert.equal(h.$('local-clips').children.length,0);assert.equal(h.$('dashboard').hidden,true);assert.ok(old.stops>0);
    revoked=false;await h.open();await start();h.window.dispatchEvent(new h.window.Event('pagehide'));await settle();assert.equal(h.$('local-clips').children.length,0);
    h.window.dispatchEvent(new h.window.Event('pageshow'));await settle();
    await start();h.$('logout').click();await settle();assert.equal(h.$('local-clips').children.length,0);assert.equal(h.$('events').children.length,0);assert.equal(h.$('online-members').children.length,0);assert.equal(new Set(revokes).size,urls.length);
  }finally{h.close();}
});

test('device manager capability is scoped to the selected device and clears on switch/logout',async()=>{
 const h=harness(c=>c.path.endsWith('list_my_monitors')?reply([{...homes[0],can_manage:true},{...homes[1],can_manage:false}]):
  c.path.endsWith('list_family_access')?reply({members:[],invitations:[]}):undefined);
 try{
  await h.login();assert.equal(h.$('manage-family').hidden,false);h.$('manage-family').click();await settle();
  assert.equal(h.$('management-panel').hidden,false);
  assert.equal(h.calls.find(c=>c.path.endsWith('list_family_access')).body.p_device,D);
  h.$('created-invite-code').value='one-time-code';await h.change(D2);
  assert.equal(h.$('manage-family').hidden,true);assert.equal(h.$('management-panel').hidden,true);assert.equal(h.$('created-invite-code').value,'');
  h.$('manage-family').click();await settle();assert.equal(h.calls.filter(c=>c.path.endsWith('list_family_access')).length,1);
  h.$('logout').click();await settle();assert.equal(h.$('manage-family').hidden,true);
 }finally{h.close();}
});
test('management permission loss reloads server capabilities without treating UI flags as authority',async()=>{
 let manager=true;
 const h=harness(c=>c.path.endsWith('list_my_monitors')?reply([{...homes[0],can_manage:manager}]):
  c.path.endsWith('list_family_access')?(manager?reply({members:[],invitations:[]}):reply({code:'42501'},403)):undefined);
 try{
  await h.login();manager=false;h.$('manage-family').click();await settle();
  assert.equal(h.$('manage-family').hidden,true);assert.equal(h.$('management-panel').hidden,true);
  assert.equal(h.$('dashboard').hidden,false);assert.equal(h.$('room').textContent,'Home A');
 }finally{h.close();}
});
test('page teardown and hidden page clear one-time manager codes',async()=>{
 const h=harness(c=>c.path.endsWith('list_my_monitors')?reply([{...homes[0],can_manage:true}]):
  c.path.endsWith('list_family_access')?reply({members:[],invitations:[]}):undefined);
 try{
  await h.login();h.$('manage-family').click();await settle();h.$('created-invite-code').value='secret-once';
  h.window.dispatchEvent(new h.window.Event('pagehide'));assert.equal(h.$('created-invite-code').value,'');
  h.$('manage-family').click();await settle();h.$('created-invite-code').value='secret-again';
  Object.defineProperty(h.window.document,'hidden',{configurable:true,value:true});
  h.window.document.dispatchEvent(new h.window.Event('visibilitychange'));assert.equal(h.$('created-invite-code').value,'');
 }finally{h.close();}
});

test('claim entry alone grants nothing and never opens a camera; successful claim reloads backend authority',async()=>{
 let claimed=false;
 const h=harness(c=>{
  if(c.path.endsWith('list_my_monitors'))return reply(claimed?[{...homes[0],can_manage:true}]:[]);
  if(c.path.endsWith('redeem_device_claim')){claimed=true;return reply({ok:true,device_id:D});}
 });
 let saved;
 try{
  await h.app.ready;h.$('show-claim').click();h.submit('claim-form');assert.equal(h.calls.length,0);
  await h.login(false,false);h.$('show-claim').click();
  assert.equal(h.$('claim-panel').hidden,false);assert.equal(h.cameras.length,0);
  assert.equal(h.$('manage-family').hidden,true);assert.equal(h.$('open-home').disabled,true);
  assert.ok(!h.calls.some(c=>c.path.endsWith('redeem_device_claim')));
  const code='sn-claim-'+'a'.repeat(32);h.$('claim-code').value=code;h.submit('claim-form');await settle();
  const calls=h.calls.filter(c=>c.path.endsWith('redeem_device_claim'));assert.equal(calls.length,1);
  assert.deepEqual(calls[0].body,{p_code:code});
  assert.equal(h.$('claim-code').value,'');assert.equal(h.$('claim-panel').hidden,true);
  assert.equal(h.$('device-select').value,D);assert.equal(h.cameras.length,0);
  saved=h.saved();assert.ok(!JSON.stringify(saved).includes(code));assert.equal(h.window.localStorage.length,0);
  await h.open(D);assert.equal(h.$('manage-family').hidden,false);
 }finally{h.close();}
 const restored=harness(c=>c.path.endsWith('list_my_monitors')?reply([{...homes[0],can_manage:true}]):undefined,{},saved);
 try{
  await restored.app.ready;assert.equal(restored.$('device-select').value,D);
  assert.ok(!restored.calls.some(c=>c.path.endsWith('redeem_device_claim')));
  await restored.open(D);assert.equal(restored.$('manage-family').hidden,false);
 }finally{restored.close();}
});
test('claim success cannot promote a user without a server-authorized manager relationship',async()=>{
 const h=harness(c=>c.path.endsWith('redeem_device_claim')?reply({ok:true,device_id:D}):undefined);
 try{await h.login(false,false);h.$('show-claim').click();h.$('claim-code').value='sn-claim-'+'a'.repeat(32);h.submit('claim-form');await settle();
  await h.open(D);assert.equal(h.$('manage-family').hidden,true);
 }finally{h.close();}
});
test('claim invalid/expired/used and rate-limit responses are safe and clear pasted codes',async()=>{
 let error='invalid_claim';
 const h=harness(c=>c.path.endsWith('redeem_device_claim')?reply({ok:false,error}):undefined);
 try{await h.login(false,false);h.$('show-claim').click();h.$('claim-code').value='secret-code';h.submit('claim-form');await settle();
  assert.match(h.$('claim-message').textContent,/Claim unavailable/);assert.equal(h.$('claim-code').value,'');
  assert.equal(h.$('claim-device').disabled,false);assert.equal(h.$('manage-family').hidden,true);
  error='rate_limited';h.submit('claim-form');await settle();assert.match(h.$('claim-message').textContent,/one minute/);
  assert.ok(!JSON.stringify(h.saved()).includes('secret-code'));
 }finally{h.close();}
});
test('pending claim responses cannot restore signed-out or switched-device screens',async()=>{
 for(const action of ['logout','device','cancel']){
  const pending=deferred();const h=harness(c=>c.path.endsWith('redeem_device_claim')?pending.promise:undefined);
  try{await h.login(false,false);h.$('show-claim').click();h.$('claim-code').value='sn-claim-'+'a'.repeat(32);h.submit('claim-form');await settle();
   const requests=h.calls.filter(c=>c.path.endsWith('list_my_monitors')).length;
   if(action==='logout')h.$('homes-logout').click();else if(action==='device')await h.open(D2);else h.$('cancel-claim').click();
   await settle();pending.resolve(reply({ok:true,device_id:D}));await settle();
   assert.equal(h.$('claim-code').value,'');assert.equal(h.$('claim-panel').hidden,true);
   assert.equal(h.calls.filter(c=>c.path.endsWith('list_my_monitors')).length,requests);
   if(action==='logout')assert.equal(h.$('family-panel').hidden,true);
   if(action==='device')assert.equal(h.$('device-select').value,D2);
  }finally{h.close();}
 }
});
test('claim input is cleared on pagehide and when opening family invitation; local monitor cannot claim',async()=>{
 const h=harness();
 try{await h.login(false,false);h.$('show-claim').click();h.$('claim-code').value='secret';h.$('show-invite').click();
  assert.equal(h.$('claim-panel').hidden,true);assert.equal(h.$('claim-code').value,'');
  h.$('show-claim').click();assert.equal(h.$('invite-panel').hidden,true);h.$('claim-code').value='secret';
  h.window.dispatchEvent(new h.window.Event('pagehide'));assert.equal(h.$('claim-code').value,'');
 }finally{h.close();}
 const local=harness(c=>c.path==='/api/status'?reply({}):undefined,{mode:'local'});
 try{await local.app.ready;local.$('show-claim').click();local.submit('claim-form');await settle();
  assert.equal(local.$('claim-panel').hidden,true);assert.ok(!local.calls.some(c=>c.path.includes('device_claim')));
 }finally{local.close();}
});

const noteId='40000000-0000-4000-8000-000000000001',otherNoteId='40000000-0000-4000-8000-000000000002';
const careNote=(extra={})=>({id:noteId,author:'Ka Ying',body:'Rested after lunch.',created_at:'2026-10-18T06:00:00Z',is_mine:true,can_delete:true,...extra});
test('care notes use safe names, real timestamps, plain text and server deletion capabilities',async()=>{
 const h=harness(c=>c.path.endsWith('list_care_notes')?reply([
  careNote({author:'<b>Name</b>',body:'<img src=x onerror=alert(1)> & <script>bad()</script>'}),
  careNote({id:otherNoteId,author:D,is_mine:false,can_delete:false}),
  careNote({id:'legacy',author:'x'.repeat(90)+'@example.com',can_delete:false}),
  careNote({id:'missing',author:null,can_delete:false})]):undefined);
 try{await h.login();const list=h.$('notes');
  assert.equal(list.querySelector('b,img,script'),null);assert.ok(list.textContent.includes('<b>Name</b>'));
  assert.ok(!list.textContent.includes(D));assert.ok(!list.textContent.includes('@'));
  assert.equal([...list.querySelectorAll('strong')].filter(n=>n.textContent.includes('Family member')).length,3);
  assert.equal(list.querySelector('time').dateTime,'2026-10-18T06:00:00Z');assert.ok(!list.querySelector('time').textContent.includes('Invalid'));
  assert.equal(list.querySelectorAll('button').length,1);assert.match(list.querySelector('button').textContent,/Delete my note/);
  h.$('note-body').value='New observation';h.submit('note-form');await settle();
  assert.deepEqual(h.calls.find(c=>c.path.endsWith('add_care_note')).body,{p_device:D,p_body:'New observation'});
 }finally{h.close();}
});
test('delete requires English confirmation; Cancel and Escape do not send a request; success preserves state/events/video',async()=>{
 let deleted=false;
 const h=harness(c=>c.path.endsWith('list_care_notes')?reply(deleted?[]:[careNote()]):c.path.endsWith('delete_care_note')?(deleted=true,reply({ok:true})):undefined);
 try{await h.login();h.$('view-camera').click();await settle();
  const status=h.$('status-label').textContent,events=h.$('events').textContent,camera=h.cameras[0];
  h.$('notes').querySelector('button').click();assert.equal(h.$('note-delete-confirm').hidden,false);
  assert.match(h.$('note-delete-title').textContent,/Delete this care note/);
  assert.match(h.$('note-delete-help').textContent,/cannot be undone/);
  assert.equal(h.window.document.activeElement,h.$('cancel-note-delete'));
  assert.equal(h.calls.filter(c=>c.path.endsWith('delete_care_note')).length,0);
  h.$('cancel-note-delete').click();assert.equal(h.$('note-delete-confirm').hidden,true);
  assert.equal(h.window.document.activeElement,h.$('notes').querySelector('button'));
  h.$('notes').querySelector('button').click();h.$('note-delete-confirm').dispatchEvent(new h.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  assert.equal(h.$('note-delete-confirm').hidden,true);assert.equal(h.calls.filter(c=>c.path.endsWith('delete_care_note')).length,0);
  h.$('notes').querySelector('button').click();h.$('confirm-note-delete').click();h.$('confirm-note-delete').click();await settle();
  const calls=h.calls.filter(c=>c.path.endsWith('delete_care_note'));assert.equal(calls.length,1);assert.deepEqual(calls[0].body,{p_device:D,p_note:noteId});
  assert.equal(h.$('notes').children.length,0);assert.match(h.$('note-delete-message').textContent,/deleted/);
  assert.equal(h.$('status-label').textContent,status);assert.equal(h.$('events').textContent,events);
  assert.equal(camera.active,true);assert.equal(camera.stops,0);
 }finally{h.close();}
});
test('manager deletion button uses server note permission, including subsequent role loss',async()=>{
 let allowed=true;
 const h=harness(c=>c.path.endsWith('list_care_notes')?reply([careNote({is_mine:false,can_delete:allowed})]):undefined);
 try{await h.login();assert.match(h.$('notes').querySelector('button').textContent,/Device manager/);
  h.$('notes').querySelector('button').click();allowed=false;await h.app.loadNotes();
  assert.equal(h.$('notes').querySelector('button'),null);assert.equal(h.$('note-delete-confirm').hidden,true);
  assert.match(h.$('note-delete-message').textContent,/no longer available/);
  h.$('confirm-note-delete').click();await settle();assert.ok(!h.calls.some(c=>c.path.endsWith('delete_care_note')));
 }finally{h.close();}
});
test('delete failures explain permission, rate limit and uncertain outcome without exposing server text',async()=>{
 for(const failure of ['note_unavailable','rate_limited','network','denied']){
  const h=harness(c=>c.path.endsWith('list_care_notes')?reply([careNote()]):c.path.endsWith('delete_care_note')?
   failure==='network'?Promise.reject(new Error('DO-NOT-SHOW-SECRET')):failure==='denied'?reply({code:'42501'},403):reply({ok:false,error:failure}):undefined);
  try{await h.login();h.$('notes').querySelector('button').click();h.$('confirm-note-delete').click();await settle();
   assert.equal(h.$('note-delete-confirm').hidden,true);assert.equal(h.$('note-delete-preview').textContent,'');
   if(failure==='denied'){assert.equal(h.$('dashboard').hidden,true);assert.equal(h.$('notes').textContent,'');}
   else{
    assert.equal(h.$('notes').children.length,1);assert.ok(!h.$('note-delete-message').textContent.includes('SECRET'));
    assert.match(h.$('note-delete-message').textContent,failure==='rate_limited'?/one minute/:failure==='network'?/may have succeeded/:/unavailable/);
   }
  }finally{h.close();}
 }
});
test('switch/logout/pagehide discard pending deletion and clear private confirmation; no stale response enters new device',async()=>{
 for(const action of ['switch','logout','pagehide']){
  const pending=deferred();const h=harness(c=>c.path.endsWith('list_care_notes')?reply([careNote({body:c.body.p_device===D?'Old private note':'New home note'})]):c.path.endsWith('delete_care_note')?pending.promise:undefined);
  try{await h.login();h.$('notes').querySelector('button').click();h.$('confirm-note-delete').click();await settle();
   if(action==='switch')await h.change(D2);else if(action==='logout'){h.$('logout').click();await settle();}else h.window.dispatchEvent(new h.window.Event('pagehide'));
   assert.equal(h.$('note-delete-confirm').hidden,true);assert.equal(h.$('note-delete-preview').textContent,'');
   pending.resolve(reply({ok:true}));await settle();
   assert.equal(h.$('note-delete-message').textContent,'');
   if(action==='switch'){assert.equal(h.$('device-select').value,D2);assert.match(h.$('notes').textContent,/New home note/);}
   if(action==='logout')assert.equal(h.$('notes').textContent,'');
  }finally{h.close();}
 }
});
test('an older note refresh cannot resurrect a deleted note; switching clears notes before media disconnect callbacks',async()=>{
 const oldList=deferred(),deletion=deferred();let delay=false,deleted=false;
 const h=harness(c=>{
  if(c.path.endsWith('list_care_notes'))return delay?(delay=false,oldList.promise):reply(deleted?[]:[careNote()]);
  if(c.path.endsWith('delete_care_note'))return deletion.promise;
 });
 try{await h.login();h.$('view-camera').click();await settle();
  delay=true;const pending=h.app.loadNotes();await settle();h.$('notes').querySelector('button').click();h.$('confirm-note-delete').click();await settle();
  oldList.resolve(reply([careNote({body:'Stale old response'})]));await pending;assert.ok(!h.$('notes').textContent.includes('Stale old response'));
  deleted=true;deletion.resolve(reply({ok:true}));await settle();assert.equal(h.$('notes').children.length,0);
  deleted=false;await h.app.loadNotes();const camera=h.cameras[0],presence=h.presences[0];
  const stopCamera=camera.stop.bind(camera),stopPresence=presence.stop.bind(presence);
  camera.stop=()=>{assert.equal(h.$('notes').textContent,'');assert.equal(h.$('events').textContent,'');stopCamera();};
  presence.stop=()=>{assert.equal(h.$('notes').textContent,'');stopPresence();};
  await h.change(D2);assert.ok(camera.stops>0);assert.ok(presence.stops>0);
  // Original stop callbacks remain suitable for the harness teardown.
  camera.stop=stopCamera;presence.stop=stopPresence;
 }finally{h.close();}
});
test('note confirmation is bound to the selected note and old migration has no fake delete control',async()=>{
 const h=harness(c=>c.path.endsWith('list_care_notes')?reply([careNote(),careNote({id:otherNoteId,can_delete:undefined})]):undefined);
 try{await h.login();assert.equal(h.$('notes').querySelectorAll('button').length,1);
  h.$('notes').querySelector('button').click();h.$('confirm-note-delete').click();await settle();
  assert.equal(h.calls.find(c=>c.path.endsWith('delete_care_note')).body.p_note,noteId);
 }finally{h.close();}
});

const recoveryUser='90000000-0000-4000-8000-000000000001';
const recoveryJWT=(extra={})=>['eyJhbGciOiJIUzI1NiJ9',Buffer.from(JSON.stringify({sub:recoveryUser,iss:config.supabaseUrl+'/auth/v1',exp:Math.floor(Date.now()/1000)+3600,amr:[{method:'recovery'}],...extra})).toString('base64url'),'test-signature'].join('.');
test('forgot password sends only Auth recovery request, generic confirmation and cooldown, never monitoring or stored passwords',async()=>{
 const h=harness(c=>c.path.endsWith('/recover')?reply({}):undefined);
 try{await h.app.ready;h.$('forgot-password').click();h.$('recovery-email').value='relative@example.com';h.submit('recovery-send-form');await settle();
  assert.equal(h.$('auth-content').hidden,true);assert.equal(h.$('recovery-panel').hidden,false);
  assert.equal(h.$('recovery-message').textContent,'If an account exists for this email, you’ll receive a reset link.');
  const call=h.calls.find(c=>c.path.endsWith('/recover'));assert.deepEqual(call.body,{email:'relative@example.com'});
  assert.equal(new URL(call.url).searchParams.get('redirect_to'),'https://family.example/?recovery=1');
  assert.ok(!h.calls.some(c=>c.path.includes('/rpc/')||c.path.includes('video-token')));assert.equal(h.cameras.length,0);
  h.submit('recovery-send-form');await settle();assert.equal(h.calls.filter(c=>c.path.endsWith('/recover')).length,1);assert.match(h.$('recovery-message').textContent,/one minute/);
  assert.ok(!JSON.stringify(h.saved()).includes('relative@example.com'));h.$('recovery-back').click();assert.equal(h.$('auth-content').hidden,false);
 }finally{h.close();}
});
test('fragment recovery with server-verified recovery AMR ignores another saved login and never restores homes',async()=>{
 const token=recoveryJWT();
 const original={['safenest:session:'+config.supabaseUrl]:JSON.stringify({version:1,...session,expires_at:Date.now()/1000+3600})};
 const h=harness(c=>c.path==='/auth/v1/user'?reply({id:recoveryUser}):undefined,{},original,
  'https://family.example/?recovery=1#type=recovery&access_token='+encodeURIComponent(token)+'&refresh_token=DO-NOT-STORE');
 try{await h.app.ready;assert.equal(h.$('recovery-update-form').hidden,false);assert.equal(h.$('update-password').disabled,false);
  assert.equal(h.window.location.search,'');assert.equal(h.window.location.hash,'');assert.deepEqual(h.saved(),{});
  assert.ok(!h.calls.some(c=>c.path.includes('/rpc/')));
  assert.equal(h.calls.find(c=>c.path==='/auth/v1/user').options.headers.Authorization,'Bearer '+token);
  h.$('reset-new-password').value='New-password-123';h.$('reset-confirm-password').value='Different';h.submit('recovery-update-form');await settle();assert.match(h.$('recovery-message').textContent,/do not match/);
  h.$('reset-new-password').value='short';h.$('reset-confirm-password').value='short';h.submit('recovery-update-form');await settle();assert.match(h.$('recovery-message').textContent,/at least 8/);
  h.$('reset-new-password').value='New-password-123';h.$('reset-confirm-password').value='New-password-123';h.submit('recovery-update-form');await settle();
  const update=h.calls.find(c=>c.path==='/auth/v1/user'&&c.options.method==='PUT');assert.equal(update.options.headers.Authorization,'Bearer '+token);assert.deepEqual(update.body,{password:'New-password-123'});
  assert.match(h.$('recovery-message').textContent,/Password updated/);assert.equal(h.$('reset-new-password').value,'');assert.deepEqual(h.saved(),{});
  assert.ok(h.calls.some(c=>c.path==='/auth/v1/logout'&&new URL(c.url).searchParams.get('scope')==='local'));
 }finally{h.close();}
});
test('verified token-hash recovery supports another browser and server password-policy errors',async()=>{
 const token=recoveryJWT();let weak=true;
 const h=harness(c=>{
  if(c.path==='/auth/v1/verify'){assert.deepEqual(c.body,{token_hash:'a'.repeat(64),type:'recovery'});return reply({access_token:token,user:{id:recoveryUser}});}
  if(c.path==='/auth/v1/user')return c.options.method==='PUT'&&weak?reply({code:'weak_password'},422):reply({id:recoveryUser});
 },{},{},'https://family.example/?token_hash='+'a'.repeat(64)+'&type=recovery');
 try{await h.app.ready;assert.equal(h.$('recovery-update-form').hidden,false);
  for(const field of ['reset-new-password','reset-confirm-password'])h.$(field).value='New-password-123';h.submit('recovery-update-form');await settle();
  assert.match(h.$('recovery-message').textContent,/password policy/);assert.equal(h.$('update-password').disabled,false);
  weak=false;for(const field of ['reset-new-password','reset-confirm-password'])h.$(field).value='Better-password-456';h.submit('recovery-update-form');await settle();
  assert.match(h.$('recovery-message').textContent,/Password updated/);assert.ok(!JSON.stringify(h.saved()).includes(token));
 }finally{h.close();}
});
test('recovery rejects type-only, ordinary sign-in token, untyped OTP, expired/tampered token and mismatched server identity',async()=>{
 for(const mode of ['flag','normal','otp-no-type','magiclink','expired','tampered','identity','hash-expired','hash-no-type']){
  const token=recoveryJWT(mode==='normal'?{amr:[{method:'password'}]}:mode==='expired'?{exp:1}:{});
  const url=mode==='hash-no-type'?'https://family.example/?token_hash='+'a'.repeat(64):mode==='flag'?'https://family.example/?type=recovery':mode==='hash-expired'?'https://family.example/?token_hash='+'a'.repeat(64)+'&type=recovery':mode==='magiclink'?'https://family.example/?recovery=1#type=magiclink&access_token='+encodeURIComponent(token):mode==='otp-no-type'?'https://family.example/?recovery=1#access_token='+encodeURIComponent(token):'https://family.example/#type=recovery&access_token='+encodeURIComponent(token);
  const h=harness(c=>c.path==='/auth/v1/verify'?reply({code:'otp_expired'},403):c.path==='/auth/v1/user'?mode==='tampered'?reply({},401):reply({id:mode==='identity'?D:recoveryUser}):undefined,{},{},url);
  try{await h.app.ready;assert.equal(h.$('recovery-update-form').hidden,true);assert.equal(h.$('recovery-send-form').hidden,true);assert.equal(h.$('recovery-panel').dataset.recoveryState,'failed');assert.match(h.$('recovery-message').textContent,/reset (link|credential)/i);
   h.submit('recovery-update-form');await settle();assert.ok(!h.calls.some(c=>c.path==='/auth/v1/user'&&c.options.method==='PUT'));
   assert.ok(!h.calls.some(c=>c.path.includes('/rpc/')));assert.deepEqual(h.saved(),{});
  }finally{h.close();}
 }
});
test('recovery rate/network errors and late verify after Back cannot restore a reset session',async()=>{
 for(const status of [429,500]){
  const h=harness(c=>c.path==='/auth/v1/recover'?reply({},status):undefined);
  try{await h.app.ready;h.$('forgot-password').click();h.$('recovery-email').value='relative@example.com';h.submit('recovery-send-form');await settle();
   assert.match(h.$('recovery-message').textContent,status===429?/Too many/:/could not be requested/);
  }finally{h.close();}
 }
 const pending=deferred(),token=recoveryJWT();
 const h=harness(c=>c.path==='/auth/v1/user'?pending.promise:undefined,{},{},'https://family.example/#type=recovery&access_token='+encodeURIComponent(token));
 try{await settle();h.$('recovery-back').click();pending.resolve(reply({id:recoveryUser}));await h.app.ready;
  assert.equal(h.$('recovery-panel').hidden,true);assert.equal(h.$('auth-content').hidden,false);assert.deepEqual(h.saved(),{});
 }finally{h.close();}
});
test('management modal, notes toggle and presence disclosure preserve the single camera connection and reset on switch',async()=>{
 const h=harness(c=>c.path.endsWith('list_my_monitors')?reply(homes.map((m,i)=>({...m,home_code:'Home-00'+(i+1),can_manage:true}))):undefined);
 try{await h.login();assert.match(h.$('device-select').selectedOptions[0].textContent,/Home-001 · Home A/);assert.equal(h.$('home-code').textContent,'Home-001');
  h.$('view-camera').click();await settle();const camera=h.cameras[0];
  h.$('manage-family').focus();h.$('manage-family').click();await settle();assert.equal(h.$('management-panel').hidden,false);
  assert.equal(h.$('management-panel').getAttribute('aria-modal'),'true');assert.equal(h.window.document.querySelector('main').hasAttribute('inert'),true);
  assert.match(h.$('management-home').textContent,/Home-001 · Home A/);assert.equal(h.window.document.activeElement,h.$('close-management'));
  h.$('close-management').dispatchEvent(new h.window.KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}));
  assert.ok(h.$('management-panel').contains(h.window.document.activeElement));assert.notEqual(h.window.document.activeElement,h.$('close-management'));
  h.$('management-panel').dispatchEvent(new h.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
  assert.equal(h.$('management-panel').hidden,true);assert.equal(h.window.document.activeElement,h.$('manage-family'));assert.equal(h.window.document.querySelector('main').hasAttribute('inert'),false);
  h.$('notes-toggle').click();assert.equal(h.$('notes-panel').classList.contains('is-open'),true);h.$('close-notes').click();
  assert.equal(h.$('notes-panel').classList.contains('is-open'),false);h.$('presence-toggle').click();assert.equal(h.$('presence-panel').hidden,false);
  h.$('presence-panel').dispatchEvent(new h.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(h.$('presence-panel').hidden,true);
  assert.equal(camera.stops,0);assert.equal(h.cameras.length,1);assert.equal(h.presences.length,1);assert.equal(h.window.document.querySelectorAll('#camera-video').length,1);assert.equal(h.window.document.querySelectorAll('#note-form').length,1);
  h.$('notes-toggle').click();h.$('presence-toggle').click();await h.change(D2);assert.equal(h.$('home-code').textContent,'Home-002');assert.equal(h.$('presence-panel').hidden,true);assert.equal(h.$('notes-panel').classList.contains('is-open'),false);assert.equal(h.cameras.length,1);assert.ok(camera.stops>0);
 }finally{h.close();}
});
test('presence header shows current safe names/counts, empty/loading/unavailable states and no stale names',async()=>{
 const h=harness();
 try{await h.login();const p=h.presences[0];
  p.options.onChange({state:'online',members:[{name:'A very long family member display name'},{name:'person@example.com'},{name:D}]});
  assert.equal(h.$('presence-count').textContent,'Family · 3');assert.equal(h.$('presence-more').textContent,'+2');assert.ok(!h.$('online-members').textContent.includes('@'));assert.ok(!h.$('online-members').textContent.includes(D));
  h.$('presence-toggle').click();p.options.onChange({state:'unavailable',members:[{name:'Old name'}]});
  assert.equal(h.$('online-members').textContent,'');assert.equal(h.$('presence-short-name').textContent,'');assert.match(h.$('presence-count').textContent,/unavailable/);
  p.options.onChange({state:'connecting',members:[]});assert.match(h.$('presence-message').textContent,/Checking/);
  p.options.onChange({state:'online',members:[]});assert.equal(h.$('presence-count').textContent,'Family · 0');assert.match(h.$('presence-message').textContent,/No family/);
  h.$('logout').click();await settle();assert.equal(h.$('presence-entry').hidden,true);assert.equal(h.$('presence-panel').hidden,true);
 }finally{h.close();}
});

test('temporary recovery session expires after 15 minutes and cannot update after cancellation',async()=>{
 let now=Date.now(),updates=0;
 const token=recoveryJWT();
 const client=new RecoverySession({supabaseUrl:config.supabaseUrl,now:()=>now,request:async(path,body,access,method)=>{
  if(path==='/auth/v1/user'&&method==='PUT')updates++;
  return {id:recoveryUser};
 }});
 await client.verify({accessToken:token,type:'recovery'});now+=15*60*1000+1;
 await assert.rejects(client.update('New-password-123'),e=>e.recoveryCode==='expired_link'&&e.status===401);assert.equal(updates,0);
 now=Date.now();await client.verify({accessToken:token,type:'recovery'});client.cancel();
 await assert.rejects(client.update('New-password-123'),e=>e.recoveryCode==='expired_link'&&e.status===401);assert.equal(updates,0);
});

test('multi-camera Home lists all authorized cameras automatically and switches one on-demand stream without reconnecting Home Presence',async()=>{
 const C1='30000000-0000-4000-8000-000000000001',C2='30000000-0000-4000-8000-000000000002';
 const cam=(id,device,name,status='Normal')=>({camera_id:id,device_id:device,name,enabled:true,...snapshot(name),payload:{...snapshot(name).payload,status}});
 const cameras=[cam(C1,D,'Bedside'),cam(C2,D2,'Door','Suspected Fall')];
 const h=harness(c=>{
  if(c.path.endsWith('list_my_monitors'))return reply([{device_id:D,home_id:D,home_code:'Home-001',name:'Bedroom',can_manage:true}]);
  if(c.path.endsWith('read_home_cameras'))return reply(cameras);
  if(c.path.endsWith('list_home_events'))return reply(Array.from({length:15},(_,i)=>({status:'Normal',time:new Date(1750000000000+i*1000).toISOString(),camera_name:i%2?'Door':'Bedside'})));
 });
 try{
  await h.login();assert.equal(h.$('camera-list').children.length,2);assert.equal(h.cameras.length,0);
  assert.equal(h.$('home-status-label').textContent,'Suspected Fall');assert.equal(h.$('status-label').textContent,'Normal');
  assert.equal(h.$('events').children.length,10);assert.match(h.$('events').textContent,/Door|Bedside/);
  const originalPresence=h.presences[0];h.$('view-camera').click();await settle();assert.equal(h.cameras.length,1);assert.equal(h.cameras[0].options.cameraId,C1);
  const notes=h.$('note-body');notes.value='Draft for this Home';
  h.$('camera-list').children[1].querySelector('button').click();await settle();
  assert.equal(h.cameras[0].active,false);assert.equal(h.cameras.length,1);assert.equal(h.$('status-label').textContent,'Suspected Fall');
  assert.equal(h.presences.length,1);assert.equal(originalPresence.stops,0);assert.equal(notes.value,'Draft for this Home');
  h.$('view-camera').click();assert.equal(h.cameras.length,2);assert.equal(h.cameras[1].options.deviceId,D2);assert.equal(h.cameras[1].options.cameraId,C2);
  await h.cameras[1].options.requestToken('issue');const request=h.calls.findLast(c=>c.path.endsWith('video-token'));assert.equal(request.body.camera_id,C2);assert.equal(request.body.device_id,D2);
  assert.equal(h.window.document.querySelectorAll('#camera-video').length,1);assert.equal(h.window.document.querySelectorAll('#note-form').length,1);
  h.$('logout').click();await settle();assert.equal(h.$('camera-list').children.length,0);assert.ok(originalPresence.stops>0);assert.equal(h.cameras[1].active,false);
 }finally{h.close();}
});

test('multi-camera Home inventories clear stale cards on failure, logout and revoked Home binding',async()=>{
 let revoked=false,fail=false;const C1='30000000-0000-4000-8000-000000000001';
 const h=harness(c=>{
  if(c.path.endsWith('list_my_monitors'))return reply(revoked?[]:[{device_id:D,home_id:D,name:'Bedroom'}]);
  if(c.path.endsWith('read_home_cameras'))return reply(fail?{}:[{camera_id:C1,device_id:D,enabled:true,name:'Camera',...snapshot('Home')}]);
  if(c.path.endsWith('list_home_events'))return reply([]);
 });
 try{
  await h.login();h.$('view-camera').click();assert.equal(h.cameras.length,1);
  fail=true;await h.app.poll();assert.equal(h.$('camera-list').children.length,0);assert.equal(h.cameras[0].active,false);assert.equal(h.$('home-status-label').textContent,'Monitoring unavailable');
  fail=false;await h.app.poll();assert.equal(h.$('camera-list').children.length,1);
  revoked=true;h.$('choose-home').click();await settle();assert.equal(h.$('camera-list').children.length,0);assert.equal(h.$('open-home').disabled,true);assert.equal(h.$('dashboard').hidden,true);
 }finally{h.close();}
});

test('Home manager can issue and hide a one-time camera pairing code without opening a camera',async()=>{
 const code='sn-camera-'+'a'.repeat(32),C1='30000000-0000-4000-8000-000000000001';
 const h=harness(c=>{
  if(c.path.endsWith('list_my_monitors'))return reply([{device_id:D,home_id:D,home_code:'Home-001',name:'Bedroom',can_manage:true}]);
  if(c.path.endsWith('read_home_cameras'))return reply([{camera_id:C1,device_id:D,enabled:true,name:'Bedside',...snapshot('Home')}]);
  if(c.path.endsWith('list_home_events')||c.path.endsWith('list_camera_setup_codes'))return reply([]);
  if(c.path.endsWith('list_family_access'))return reply({members:[],invitations:[]});
  if(c.path.endsWith('create_camera_setup_code'))return reply({ok:true,setup_code:code,expires_at:new Date(Date.now()+600000).toISOString()});
 });
 try{
  await h.login();h.$('view-camera').click();const camera=h.cameras[0];h.$('manage-family').click();await settle();
  assert.equal(h.$('camera-management').hidden,false);assert.match(h.$('management-home').textContent,/Home-001.*Bedroom/);
  h.$('create-camera-code').click();await settle();assert.equal(h.$('camera-setup-code').value,code);assert.ok(camera.active);assert.equal(h.cameras.length,1);
  assert.ok(!JSON.stringify(h.saved()).includes(code));h.$('close-management').click();assert.equal(h.$('camera-setup-code').value,'');assert.ok(camera.active);
 }finally{h.close();}
});

test('current fall prompt separates observation/history and requires a server episode for shared acknowledgement',async()=>{
 let state='Suspected Fall',eventId='fall-1';
 const value=()=>{const s=snapshot('Home A');s.payload.status=state;s.payload.camera_name='Bedside';s.payload.observed_at=new Date().toISOString();
  s.payload.context={people:[{person_number:2,state:'POSSIBLE_FALL',reason:'Fall-like posture'}]};
  s.payload.events=[{id:eventId,status:'Person 2: Suspected Fall',time:'2026-10-19T01:30:00Z'}];return s;};
 const h=harness(c=>c.path.endsWith('read_monitor')?reply(value()):undefined);
 try{
  await h.login();assert.equal(h.$('fall-alert').hidden,false);assert.match(h.$('fall-alert').textContent,/Home A/);
  assert.match(h.$('fall-alert-list').textContent,/Bedside.*Person 2/s);assert.match(h.$('fall-alert-list').textContent,/Latest recorded suspected-fall event/);
  assert.equal(h.$('status-label').textContent,'Suspected Fall');assert.equal(h.cameras.length,0);
  const before=h.calls.length,history=h.$('events').textContent,button=h.$('fall-alert-list').querySelectorAll('button')[1];
  button.click();await settle();assert.equal(h.calls.length,before);assert.equal(h.cameras.length,0);
  assert.equal(h.$('status-label').textContent,'Suspected Fall');assert.equal(h.$('events').textContent,history);assert.equal(button.disabled,true);assert.equal(button.getAttribute('aria-pressed'),'false');
  await h.app.poll();assert.equal(h.$('fall-alert-list').querySelectorAll('button')[1].getAttribute('aria-pressed'),'false');
  eventId='fall-2';await h.app.poll();assert.equal(button.getAttribute('aria-pressed'),'false');
  state='Normal';await h.app.poll();assert.equal(h.$('fall-alert').hidden,true);assert.match(h.$('events').textContent,/Person 2: Suspected Fall/);
  assert.equal(h.$('status-label').textContent,'Normal');assert.ok(!JSON.stringify(h.saved()).includes('fall-2'));
 }finally{h.close();}
});

test('alert View camera checks the target Camera and opens just one authorized stream on click while keeping Home Presence',async()=>{
 const C1='30000000-0000-4000-8000-000000000001',C2='30000000-0000-4000-8000-000000000002';
 let stale=false,revoked=false;
 const h=harness(c=>{
  if(c.path.endsWith('list_my_monitors'))return reply([{device_id:D,home_id:D,home_code:'Home-001',name:'Bedroom'}]);
  if(c.path.endsWith('read_home_cameras'))return revoked?reply({},403):reply([C1,C2].map((id,i)=>{
   const s=snapshot('Bedroom');s.payload.status=i?'Suspected Fall':'Normal';s.payload.camera_name=i?'Door':'Bedside';s.payload.stale=stale;
   return{...s,camera_id:id,device_id:i?D2:D,name:i?'Door':'Bedside',enabled:true};}));
  if(c.path.endsWith('list_home_events'))return reply([]);
 });
 try{
  await h.login();assert.equal(h.cameras.length,0);assert.equal(h.$('status-label').textContent,'Normal');
  assert.equal(h.$('home-status-label').textContent,'Suspected Fall');assert.equal(h.$('fall-alert-list').children.length,1);
  assert.match(h.$('fall-alert-home').textContent,/Home-001.*Bedroom/);assert.match(h.$('fall-alert-list').textContent,/Door/);
  h.$('view-camera').click();const first=h.cameras[0],presence=h.presences[0];
  h.$('fall-alert-list').querySelector('button').click();await settle();
  assert.equal(first.active,false);assert.equal(h.cameras.length,2);assert.equal(h.cameras[1].options.cameraId,C2);assert.equal(h.cameras[1].options.deviceId,D2);
  assert.equal(h.presences.length,1);assert.equal(presence.stops,0);assert.match(h.$('storage-scope').textContent,/Home-001.*Door/);
  h.$('fall-alert-list').querySelector('button').click();assert.equal(h.cameras.length,2);
  await h.cameras[1].options.requestToken('issue');const token=h.calls.findLast(c=>c.path.endsWith('video-token'));assert.equal(token.body.camera_id,C2);assert.equal(token.body.device_id,D2);
  stale=true;await h.app.poll();assert.equal(h.$('fall-alert').hidden,true);assert.equal(h.$('status-label').textContent,'Connection Lost');assert.equal(h.$('home-status-label').textContent,'Monitoring unavailable');assert.equal(h.cameras[1].active,false);
  stale=false;await h.app.poll();assert.equal(h.$('fall-alert').hidden,false);assert.equal(h.cameras.length,2);
  revoked=true;await h.app.poll();await settle();assert.equal(h.$('fall-alert').hidden,true);assert.equal(h.$('fall-alert-list').children.length,0);assert.equal(h.$('camera-list').children.length,0);
 }finally{h.close();}
});

test('Home changes, sign-out and page teardown clear live alert, acknowledgement and media scope without altering saved history',async()=>{
 const h=harness(c=>{
  if(c.path.endsWith('read_monitor')){const s=snapshot(c.body.p_device===D?'Home A':'Home B');s.payload.status=c.body.p_device===D?'Suspected Fall':'Normal';return reply(s);}
 });
 try{
  await h.login();h.$('fall-alert-list').querySelectorAll('button')[1].click();
  await h.change(D2);assert.equal(h.$('fall-alert').hidden,true);assert.equal(h.$('fall-alert-home').textContent,'');assert.ok(!h.$('storage-scope').textContent.includes('Home A'));
  await h.change(D);assert.equal(h.$('fall-alert-list').querySelectorAll('button')[1].getAttribute('aria-pressed'),'false');
  h.window.dispatchEvent(new h.window.Event('pagehide'));assert.equal(h.$('fall-alert-list').children.length,0);
  h.window.dispatchEvent(new h.window.Event('pageshow'));await settle();assert.equal(h.$('fall-alert').hidden,false);
  h.$('logout').click();await settle();assert.equal(h.$('fall-alert-home').textContent,'');assert.equal(h.$('storage-scope').textContent,'Current camera unavailable');
 }finally{h.close();}
});

test('late status/notes after page teardown cannot resurrect alerts, media scope or old data; back navigation rechecks without video',async()=>{
 const status=deferred(),notes=deferred();let delayed=false;
 const h=harness(c=>{
  if(delayed&&c.path.endsWith('read_monitor'))return status.promise;
  if(delayed&&c.path.endsWith('list_care_notes'))return notes.promise;
 });
 try{
  await h.login();delayed=true;const poll=h.app.poll(),notePoll=h.app.loadNotes();await settle();
  h.window.dispatchEvent(new h.window.Event('pagehide'));
  const s=snapshot('Home A');s.payload.status='Suspected Fall';status.resolve(reply(s));notes.resolve(reply([careNote({body:'Old private note'})]));
  await Promise.all([poll,notePoll]);await settle();
  assert.equal(h.$('fall-alert').hidden,true);assert.equal(h.$('notes').textContent,'');assert.equal(h.$('events').textContent,'');assert.equal(h.$('storage-scope').textContent,'Current camera unavailable');
  const before=h.calls.length;await h.app.poll();await h.app.loadNotes();assert.equal(h.calls.length,before);
  delayed=false;h.window.dispatchEvent(new h.window.Event('pageshow'));await settle();
  assert.equal(h.$('status-label').textContent,'Normal');assert.equal(h.cameras.length,0);assert.match(h.$('event-scope').textContent,/Home A/);
 }finally{h.close();}
});

test('acknowledgement and storage settings preserve an existing single stream and Home Presence',async()=>{
 const h=harness(c=>{if(c.path.endsWith('read_monitor')){const s=snapshot('Home A');s.payload.status='Suspected Fall';return reply(s);}});
 try{
  await h.login();h.$('view-camera').click();const camera=h.cameras[0],presence=h.presences[0],before=h.calls.length;
  h.$('fall-alert-list').querySelectorAll('button')[1].click();h.$('open-settings').click();h.$('close-settings').click();await settle();
  assert.equal(h.cameras.length,1);assert.equal(camera.active,true);assert.equal(camera.stops,0);assert.equal(h.presences.length,1);assert.equal(presence.stops,0);assert.equal(h.calls.length,before);
  assert.equal(h.$('status-label').textContent,'Suspected Fall');
 }finally{h.close();}
});

test('shared alert confirmation is persisted, restored after polling and does not reconnect video or Presence',async()=>{
 let viewed=false;
 const h=harness(c=>{
  if(c.path.endsWith('list_my_monitors'))return reply([{device_id:D,home_id:D,home_code:'Home-001',name:'Bedroom'}]);
  if(c.path.endsWith('read_home_cameras'))return reply([{...snapshot('Bedroom'),camera_id:'cam-1',device_id:D,name:'Bedside',enabled:true,payload:{...snapshot('Bedroom').payload,status:'Suspected Fall',observed_at:new Date().toISOString()}}]);
  if(c.path.endsWith('list_home_events'))return reply([]);
  if(c.path.endsWith('list_fall_alerts'))return reply({unviewed_count:viewed?0:1,alerts:[{id:'server-alert',camera_id:'cam-1',camera_name:'Bedside',current:true,occurred_at:new Date().toISOString(),viewed_by_me:viewed,views:viewed?[{name:'Server-derived name',viewed_at:new Date().toISOString()}]:[]}]});
  if(c.path.endsWith('acknowledge_fall_alert')){viewed=true;return reply({ok:true});}
 });
 try{
  await h.login();h.$('view-camera').click();await settle();const camera=h.cameras[0],presence=h.presences.at(-1),count=h.cameras.length;
  h.$('fall-alert-list').querySelectorAll('button')[1].click();await settle();
  assert.equal(h.calls.filter(c=>c.path.endsWith('acknowledge_fall_alert')).length,1);assert.match(h.$('fall-alert-list').textContent,/Server-derived name/);
  assert.equal(h.$('family-alert-list').querySelector('button').textContent,'Acknowledged by you');assert.equal(h.$('status-label').textContent,'Suspected Fall');
  assert.ok(camera.active);assert.equal(h.cameras.length,count);assert.equal(presence.stops,0);
  h.$('refresh-alerts').click();await settle();assert.match(h.$('fall-alert-list').textContent,/Server-derived name/);assert.equal(h.cameras.length,count);
  h.$('logout').click();await settle();assert.equal(h.$('family-alert-list').children.length,0);assert.equal(h.$('family-alert-panel').hidden,true);assert.ok(!camera.active);
 }finally{h.close();}
});
test('late alert/acknowledgement responses cannot resurrect previous Home or page-teardown data',async()=>{
 let delay=false;const waiting=deferred();
 const h=harness(c=>{if(c.path.endsWith('list_fall_alerts'))return delay?waiting.promise:reply({alerts:[{id:'old',camera_id:'cam',camera_name:'Old Camera',current:true,occurred_at:new Date().toISOString(),views:[]}],unviewed_count:1});});
 try{
  await h.login();delay=true;h.$('refresh-alerts').click();await settle();h.window.dispatchEvent(new h.window.Event('pagehide'));
  waiting.resolve(reply({alerts:[{id:'late',camera_name:'Private old Home'}],unviewed_count:1}));await settle();
  assert.equal(h.$('family-alert-panel').hidden,true);assert.equal(h.$('family-alert-list').textContent,'');assert.equal(h.$('push-settings').hidden,true);
 }finally{h.close();}
});
test('opaque push link is resolved after login against authorized Homes and never starts LiveKit',async()=>{
 const key='a'.repeat(32),h=harness(c=>c.path.endsWith('open_fall_notification')?reply({home_id:D2,alert_id:'alert'}):undefined,{}, {},'https://family.example/?safety-alert='+key);
 try{
  await h.login(false,false);assert.equal(h.$('dashboard').hidden,false);assert.match(h.$('room').textContent,/Home B/);assert.equal(h.cameras.length,0);
  const target=h.calls.find(c=>c.path.endsWith('open_fall_notification'));assert.deepEqual(target.body,{p_key:key});assert.equal(h.window.location.search,'');
  assert.ok(!h.calls.some(c=>c.path.endsWith('video-token')));assert.ok(!JSON.stringify(h.saved()).includes(key));
 }finally{h.close();}
});
test('push link for another account or revoked Home cannot reveal its alert or open a camera',async()=>{
 const key='a'.repeat(32),h=harness(c=>c.path.endsWith('open_fall_notification')?reply({},403):undefined,{}, {},'https://family.example/?safety-alert='+key);
 try{await h.login(false,false);assert.equal(h.$('dashboard').hidden,true);assert.match(h.$('homes-message').textContent,/unavailable for this account/);assert.equal(h.cameras.length,0);assert.equal(h.$('family-alert-list').children.length,0);}finally{h.close();}
});

test('Gmail-compatible fragment token hash verifies recovery with OTP AMR in a fresh browser and updates only its account',async()=>{
 const token=recoveryJWT({amr:[{method:'otp'}]});
 const saved={['safenest:session:'+config.supabaseUrl]:JSON.stringify({version:1,...session,expires_at:Date.now()/1000+3600})};
 const h=harness(c=>{
  if(c.path==='/auth/v1/verify')return reply({access_token:token,user:{id:recoveryUser}});
  if(c.path==='/auth/v1/user')return reply({id:recoveryUser});
 },{},saved,'https://family.example/?recovery=1#token_hash='+'b'.repeat(64)+'&type=recovery');
 try{await h.app.ready;assert.equal(h.$('recovery-panel').dataset.recoveryState,'ready');
  assert.equal(h.$('recovery-send-form').hidden,true);assert.equal(h.$('recovery-update-form').hidden,false);
  const verify=h.calls.find(c=>c.path==='/auth/v1/verify');assert.deepEqual(verify.body,{token_hash:'b'.repeat(64),type:'recovery'});assert.ok(!verify.options.headers.Authorization);
  for(const id of ['reset-new-password','reset-confirm-password'])h.$(id).value='A-new-password-456';
  h.submit('recovery-update-form');await settle();
  const update=h.calls.find(c=>c.options.method==='PUT');assert.equal(update.options.headers.Authorization,'Bearer '+token);assert.deepEqual(update.body,{password:'A-new-password-456'});
  assert.equal(h.$('recovery-panel').dataset.recoveryState,'complete');assert.deepEqual(h.saved(),{});
  assert.ok(!h.calls.some(c=>c.path.includes('/rpc/')||c.path.includes('video-token')));
 }finally{h.close();}
});
test('callback parameters stay available until Auth verification finishes, then are removed without storing credentials',async()=>{
 const pending=deferred(),token=recoveryJWT({amr:[{method:'otp'}]});
 const h=harness(c=>c.path==='/auth/v1/verify'?pending.promise:c.path==='/auth/v1/user'?reply({id:recoveryUser}):undefined,{},{},
  'https://family.example/?recovery=1#token_hash='+'c'.repeat(64)+'&type=recovery');
 try{await settle();assert.equal(h.$('recovery-panel').dataset.recoveryState,'verifying');
  assert.ok(h.window.location.hash.includes('token_hash'));assert.equal(h.$('recovery-send-form').hidden,true);assert.equal(h.$('recovery-update-form').hidden,true);
  pending.resolve(reply({access_token:token,user:{id:recoveryUser}}));await h.app.ready;
  assert.equal(h.window.location.hash,'');assert.equal(h.window.location.search,'');assert.deepEqual(h.saved(),{});
 }finally{h.close();}
});
test('default Supabase recovery callback accepts its server-validated OTP bearer, ignores another saved account and offers a clearly labelled retry',async()=>{
 const token=recoveryJWT({amr:[{method:'otp'}]});
 const saved={['safenest:session:'+config.supabaseUrl]:JSON.stringify({version:1,...session,expires_at:Date.now()/1000+3600})};
 const h=harness(c=>c.path==='/auth/v1/user'?reply({id:recoveryUser}):undefined,{},saved,
  'https://family.example/?recovery=1#type=recovery&access_token='+token+'&refresh_token=one-time-callback-refresh');
 try{await h.app.ready;assert.equal(h.$('recovery-title').textContent,'Reset password');
  assert.equal(h.$('recovery-send-form').hidden,true);assert.equal(h.$('recovery-update-form').hidden,false);
  assert.equal(h.calls.find(c=>c.path==='/auth/v1/user').options.headers.Authorization,'Bearer '+token);
  assert.deepEqual(h.saved(),{});assert.ok(!h.calls.some(c=>c.path.includes('/rpc/')||c.path.includes('video-token')));
  for(const id of ['reset-new-password','reset-confirm-password'])h.$(id).value='Safe-new-password-456';
  h.submit('recovery-update-form');await settle();
  const update=h.calls.find(c=>c.options.method==='PUT');assert.equal(update.options.headers.Authorization,'Bearer '+token);
  assert.equal(h.$('recovery-panel').dataset.recoveryState,'complete');assert.deepEqual(h.saved(),{});
 }finally{h.close();}
});
test('default recovery callback fragment stays intact until Auth validates the callback bearer',async()=>{
 const pending=deferred(),token=recoveryJWT({amr:[{method:'otp'}]});
 const h=harness(c=>c.path==='/auth/v1/user'?pending.promise:undefined,{},{},
  'https://family.example/?recovery=1#type=recovery&access_token='+token+'&refresh_token=temporary-refresh');
 try{await settle();assert.equal(h.$('recovery-panel').dataset.recoveryState,'verifying');
  assert.equal(h.window.location.search,'?recovery=1');assert.ok(h.window.location.hash.includes('access_token='));
  assert.equal(h.$('recovery-update-form').hidden,true);pending.resolve(reply({id:recoveryUser}));await h.app.ready;
  assert.equal(h.$('recovery-panel').dataset.recoveryState,'ready');assert.equal(h.window.location.search,'');assert.equal(h.window.location.hash,'');assert.deepEqual(h.saved(),{});
 }finally{h.close();}
});
test('unrelated PKCE callback is not exchanged and does not adopt an old account session',async()=>{
 const saved={['safenest:session:'+config.supabaseUrl]:JSON.stringify({version:1,...session,expires_at:Date.now()/1000+3600})};
 const h=harness(()=>undefined,{},saved,'https://family.example/?recovery=1&code=external-code');
 try{await h.app.ready;assert.match(h.$('recovery-message').textContent,/original browser/);assert.match(h.$('recovery-message').textContent,/no matching verifier/);
  assert.equal(h.$('recovery-send-form').hidden,true);assert.equal(h.$('recovery-update-form').hidden,true);
  assert.ok(!h.calls.some(c=>c.path.includes('/token')||c.path.includes('/rpc/')));assert.deepEqual(h.saved(),{});assert.equal(h.window.location.search,'');
 }finally{h.close();}
});
test('used or expired recovery hash and unavailable Auth have distinct failed states with an explicit new-link action',async()=>{
 for(const status of [403,503]){
  const h=harness(c=>c.path==='/auth/v1/verify'?reply({code:status===403?'otp_expired':'unavailable'},status):undefined,{},{},
   'https://family.example/?recovery=1#token_hash='+'d'.repeat(64)+'&type=recovery');
  try{await h.app.ready;assert.equal(h.$('recovery-panel').dataset.recoveryState,'failed');
   assert.match(h.$('recovery-message').textContent,status===403?/expired or already used/:/connection or account service/);
   assert.equal(h.$('recovery-send-form').hidden,true);assert.equal(h.$('recovery-update-form').hidden,true);
   assert.equal(h.$('recovery-request-new').hidden,false);assert.equal(h.window.location.hash,'');
   assert.equal(h.$('recovery-request-new').textContent,'Enter email to request another link');
   if(status===403){h.$('recovery-request-new').click();assert.equal(h.$('recovery-title').textContent,'Forgot password?');assert.equal(h.$('recovery-send-form').hidden,false);assert.equal(h.$('recovery-update-form').hidden,true);}
  }finally{h.close();}
 }
});
test('same one-use recovery hash cannot be reused after Auth has consumed it',async()=>{
 let used=false;const token=recoveryJWT({amr:[{method:'otp'}]});
 const handler=c=>{if(c.path==='/auth/v1/verify'){if(used)return reply({code:'otp_expired'},403);used=true;return reply({access_token:token,user:{id:recoveryUser}});}if(c.path==='/auth/v1/user')return reply({id:recoveryUser});};
 const url='https://family.example/?recovery=1#token_hash='+'e'.repeat(64)+'&type=recovery';
 const first=harness(handler,{},{},url);try{await first.app.ready;assert.equal(first.$('recovery-panel').dataset.recoveryState,'ready');}finally{first.close();}
 const again=harness(handler,{},{},url);try{await again.app.ready;assert.equal(again.$('recovery-panel').dataset.recoveryState,'failed');assert.equal(again.$('recovery-update-form').hidden,true);assert.ok(!again.calls.some(c=>c.options.method==='PUT'));}finally{again.close();}
});
test('starting password recovery from a live Home pauses media/Presence and clears old server alert data',async()=>{
 const h=harness();try{await h.login();h.$('view-camera').click();await settle();const camera=h.cameras[0],presence=h.presences[0];
  h.$('forgot-password').click();await settle();assert.equal(h.$('dashboard').hidden,true);assert.equal(camera.active,false);assert.ok(camera.stops>0);assert.ok(presence.stops>0);
  assert.equal(h.$('family-alert-list').children.length,0);assert.equal(h.$('family-alert-scope').textContent,'');assert.equal(h.$('alert-push-summary').textContent,'');assert.deepEqual(h.saved(),{});
 }finally{h.close();}
});
test('Camera Settings and notification settings are one focus-managed modal without new media or Presence connections',async()=>{
 const h=harness();try{await h.login();h.$('view-camera').click();await settle();const camera=h.cameras[0],presence=h.presences[0],panel=h.$('settings-panel');
  h.$('open-settings').focus();h.$('open-settings').click();
  assert.equal(panel.tagName,'DIALOG');assert.equal(panel.getAttribute('aria-modal'),'true');assert.equal(h.window.document.body.style.overflow,'hidden');
  assert.equal(h.$('open-settings').getAttribute('aria-expanded'),'true');assert.ok(panel.contains(h.window.document.activeElement));
  panel.dispatchEvent(new h.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
  assert.equal(panel.hidden,true);assert.equal(h.window.document.activeElement,h.$('open-settings'));assert.equal(h.window.document.body.style.overflow,'');
  h.$('alert-notification-settings').focus();h.$('alert-notification-settings').click();
  assert.equal(panel.hidden,false);assert.equal(h.window.document.activeElement,h.$('push-title'));
  h.$('close-settings').click();assert.equal(h.window.document.activeElement,h.$('alert-notification-settings'));
  assert.equal(h.cameras.length,1);assert.equal(camera.stops,0);assert.equal(h.presences.length,1);assert.equal(presence.stops,0);
  assert.equal(h.window.document.querySelectorAll('#settings-panel').length,1);assert.equal(h.window.document.querySelectorAll('#camera-video').length,1);
  h.$('open-settings').click();await h.change(D2);assert.equal(panel.hidden,true);assert.equal(h.window.document.body.style.overflow,'');assert.ok(!h.$('settings-scope').textContent.includes('Home A'));
 }finally{h.close();}
});
test('page teardown closes Camera Settings and restores background scrolling',async()=>{
 const h=harness();try{await h.login();h.$('open-settings').click();assert.equal(h.$('settings-panel').hidden,false);
  h.window.dispatchEvent(new h.window.PageTransitionEvent('pagehide'));await settle();
  assert.equal(h.$('settings-panel').hidden,true);assert.equal(h.window.document.body.style.overflow,'');assert.equal(h.$('family-alert-list').children.length,0);
 }finally{h.close();}
});

test('ambiguous duplicate/mixed recovery credentials fail closed; recommended email template uses a fragment',async()=>{
 for(const value of ['?recovery=1&token_hash=abc&token_hash=def&type=recovery','?recovery=1&type=signup#token_hash=abc&type=recovery','?recovery=1&token_hash=abc&type=recovery#token_hash=def&type=recovery','?recovery=1#token_hash=abc&type=recovery&access_token=def']){
  const url=new URL('https://family.example/'+value);assert.equal(recoveryLink(url).invalid,true);
 }
 const template=await readFile(new URL('../cloud/reset_password_email.html.example',import.meta.url),'utf8');assert.match(template,/\{\{ \.RedirectTo \}\}#token_hash=/);assert.ok(!template.includes('}}&amp;token_hash='));
});
