import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from '../video_frontend/node_modules/jsdom/lib/api.js';
import {FamilyManagement} from '../web/family-management.js';
const html=await readFile(new URL('../web/index.html',import.meta.url),'utf8');
const D='10000000-0000-4000-8000-000000000001',E='10000000-0000-4000-8000-000000000002';
const member='20000000-0000-4000-8000-000000000001',code='a'.repeat(32);
const roster={members:[{member_id:'manager',name:'Caregiver',role:'manager',is_self:true},{member_id:member,name:'Relative',role:'family',is_self:false}],
 invitations:[{invite_id:'invite',status:'active',uses:0,max_uses:5,created_at:'2026-10-18T00:00:00Z',expires_at:'2026-10-25T00:00:00Z',created_by:'Caregiver'}]};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const settle=async()=>{for(let n=0;n<8;n++)await new Promise(r=>setImmediate(r));};
function harness(handler=()=>undefined){
 const dom=new JSDOM(html,{url:'https://family.example'}),{window}=dom,$=id=>window.document.getElementById(id),calls=[],denied=[];
 const ui=new FamilyManagement({window,document:window.document,onAccessError:e=>denied.push(e),rpc:async(name,body)=>{
  calls.push({name,body});const custom=await handler(name,body);if(custom!==undefined)return custom;
  if(name==='list_family_access')return roster;
  if(name==='create_family_invite')return{ok:true,invitation_code:code};return{ok:true};
 }});
 ui.setDevice(D,'Bedroom',true);
 return{ui,window,$,calls,denied,async open(){await ui.open();},async create(){await ui.create();},close(){ui.close();window.close();}};
}
test('ordinary family accounts cannot open management or invoke actions by forcing button clicks',async()=>{
 const h=harness();try{
  h.ui.setDevice(D,'Bedroom',false);h.$('manage-family').click();await h.ui.create();await h.ui.confirm();
  assert.equal(h.$('manage-family').hidden,true);assert.equal(h.calls.length,0);
 }finally{h.close();}
});
test('authorized management lists only server data as text, with no exposed emails or UUID labels',async()=>{
 const h=harness(name=>name==='list_family_access'?{...roster,members:[{member_id:member,name:'<img src=x onerror=alert(1)>',role:'family'}]}:undefined);
 try{
  await h.open();assert.deepEqual(h.calls[0],{name:'list_family_access',body:{p_device:D}});
  assert.equal(h.$('managed-members').querySelector('img'),null);
  assert.match(h.$('managed-members').textContent,/<img/);assert.ok(!h.$('managed-members').textContent.includes(member));
  assert.ok(!h.$('managed-invites').textContent.includes(code));
 }finally{h.close();}
});
test('creation is explicit, scoped, uses default limits and never persists the raw code',async()=>{
 const h=harness();try{
  await h.open();assert.equal(h.calls.filter(x=>x.name==='create_family_invite').length,0);
  await h.create();assert.deepEqual(h.calls.find(x=>x.name==='create_family_invite').body,{p_device:D,p_hours:168,p_max_uses:5});
  assert.equal(h.$('created-invite-code').value,code);assert.equal(h.$('created-code-panel').hidden,false);
  assert.equal(h.window.localStorage.length,0);assert.equal(h.window.sessionStorage.length,0);
  h.$('copy-created-code').click();await settle();assert.match(h.$('created-code-message').textContent,/manually/);
  h.$('dismiss-created-code').click();assert.equal(h.$('created-invite-code').value,'');
 }finally{h.close();}
});
test('closing, switching device and losing manager authority clear displayed codes and action targets',async()=>{
 const h=harness();try{
  await h.open();await h.create();h.ui.close();assert.equal(h.$('created-invite-code').value,'');
  await h.open();await h.create();h.$('managed-members').querySelector('button').click();
  h.ui.setDevice(E,'Other home',true);assert.equal(h.$('created-invite-code').value,'');assert.equal(h.ui.pending,null);
  assert.equal(h.$('managed-members').children.length,0);assert.equal(h.$('management-panel').hidden,true);
  await h.open();await h.create();h.ui.setDevice(E,'Other home',false);
  assert.equal(h.$('created-invite-code').value,'');assert.equal(h.$('manage-family').hidden,true);
 }finally{h.close();}
});
test('removal requires explicit confirmation and announces that all old invitations will be revoked',async()=>{
 const h=harness();try{
  await h.open();const button=h.$('managed-members').querySelector('button');button.click();
  assert.match(h.$('family-action-description').textContent,/ALL outstanding invitations/);
  assert.equal(h.calls.filter(x=>x.name==='revoke_family_member').length,0);
  h.$('cancel-family-action').click();await h.ui.confirm();assert.equal(h.calls.filter(x=>x.name==='revoke_family_member').length,0);
  button.click();await h.ui.confirm();assert.deepEqual(h.calls.find(x=>x.name==='revoke_family_member').body,{p_device:D,p_member:member});
  h.$('managed-invites').querySelector('button').click();await h.ui.confirm();
  assert.deepEqual(h.calls.find(x=>x.name==='revoke_family_invite').body,{p_device:D,p_invite:'invite'});
 }finally{h.close();}
});
test('late creation/list responses cannot restore previous-device data or code after a switch',async()=>{
 const pending=deferred();const h=harness(name=>name==='create_family_invite'?pending.promise:undefined);
 try{
  await h.open();const request=h.ui.create();h.ui.setDevice(E,'Other home',true);
  pending.resolve({ok:true,invitation_code:code});await request;
  assert.equal(h.$('created-invite-code').value,'');assert.equal(h.$('management-panel').hidden,true);
  const slow=deferred();h.ui.rpc=()=>slow.promise;const listing=h.ui.open();h.ui.setDevice(D,'Bedroom',true);
  slow.resolve(roster);await listing;assert.equal(h.$('managed-members').children.length,0);
 }finally{h.close();}
});
test('server denial clears stale roster and code even if the client had a manager flag',async()=>{
 let deny=false;const h=harness(()=>{if(deny)throw Object.assign(new Error('Denied'),{status:403,code:'42501'});});
 try{
  await h.open();await h.create();deny=true;await h.ui.refresh();
  assert.equal(h.$('created-invite-code').value,'');assert.equal(h.$('managed-members').children.length,0);
  assert.equal(h.$('manage-family').hidden,true);assert.equal(h.denied.length,1);
 }finally{h.close();}
});
test('rate limits and uncertain network results are explained, without automatic re-creation',async()=>{
 let fail=false;const h=harness(name=>{if(name==='create_family_invite'){if(fail)throw new Error('network');return{ok:false,error:'rate_limited'};}});
 try{
  await h.open();await h.create();assert.match(h.$('create-invite-message').textContent,/5 invitations per minute/);
  fail=true;await h.create();assert.match(h.$('management-message').textContent,/could not be confirmed/);
  assert.equal(h.calls.filter(x=>x.name==='create_family_invite').length,2);assert.equal(h.$('created-invite-code').value,'');
 }finally{h.close();}
});
