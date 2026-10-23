import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../web/logic.js',import.meta.url),'utf8');
const {currentStatus,STATES}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const snapshot = (status='Normal') => ({server_now:'2026-10-13T12:00:00Z',received_at:'2026-10-13T12:00:00Z',payload:{status,camera_connected:true,stale:false}});
test('all actual detector states retain their identity',()=>{for(const s of ['Normal','Checking','Suspected Fall','No Person','Multiple People','Pose Unclear'])assert.equal(currentStatus(snapshot(s)).status,s)});
test('stale Normal becomes Connection Lost',()=>assert.equal(currentStatus(snapshot(),15001).status,'Connection Lost'));
test('network failure immediately invalidates Normal',()=>assert.equal(currentStatus(snapshot(),0,true).status,'Connection Lost'));
test('camera offline cannot show Normal',()=>{const d=snapshot();d.payload.camera_connected=false;assert.equal(currentStatus(d).status,'Camera Offline')});
test('missing payload is Connection Lost',()=>assert.equal(currentStatus(null).status,'Connection Lost'));
test('laptop stalled despite cloud heartbeat is Connection Lost',()=>{const d=snapshot();d.payload.stale=true;assert.equal(currentStatus(d).status,'Connection Lost')});
test('unknown state cannot become Normal',()=>assert.equal(currentStatus(snapshot('Surprise')).status,'Connection Lost'));
test('context states remain cautionary and never become a safe/normal badge',()=>{
  for(const state of ['Check Person','Tracking Lost','Resting in Bed']){
    const s=currentStatus(snapshot(state));assert.equal(s.status,state);assert.equal(s.tone,'warning');
  }
});
test('server timestamps avoid phone clock skew',()=>{const d=snapshot();d.server_now='2026-10-13T12:00:30Z';assert.equal(currentStatus(d).status,'Connection Lost')});
test('explicit infrastructure states preserved',()=>{for(const status of ['Camera Offline','AI Offline','Starting']){const d=snapshot(status);d.payload.camera_connected=false;assert.equal(currentStatus(d).status,status)}});
