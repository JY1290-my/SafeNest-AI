import test from 'node:test';import assert from 'node:assert/strict';
import {homeStatus} from '../web/home-cameras.js';
const cam=(status='Normal',extra={})=>({enabled:true,server_now:new Date().toISOString(),received_at:new Date().toISOString(),payload:{status,camera_connected:true,stale:false},...extra});
test('Home aggregation is conservative across all expected Cameras',()=>{
 assert.equal(homeStatus([]).status,'Monitoring unavailable');
 assert.equal(homeStatus([cam(),cam()]).status,'Normal');
 assert.equal(homeStatus([cam('Suspected Fall'),cam('Pose Unclear')]).status,'Suspected Fall');
 for(const state of ['Checking','Pose Unclear','Tracking Lost','Resting in Bed'])assert.notEqual(homeStatus([cam(),cam(state)]).status,'Normal');
 assert.equal(homeStatus([cam('No Person'),cam('No Person')]).status,'No Person');
 assert.equal(homeStatus([cam(),cam('No Person')]).status,'Status uncertain');
 assert.equal(homeStatus([cam(),cam('Normal',{received_at:new Date(Date.now()-16000).toISOString()})]).status,'Monitoring unavailable');
 assert.equal(homeStatus([cam(),cam('Normal',{payload:{status:'Camera Offline',camera_connected:false}})]).status,'Monitoring unavailable');
 assert.equal(homeStatus([cam(),cam('Camera Offline',{enabled:false})]).status,'Normal');
 assert.equal(homeStatus([cam()],16000).status,'Monitoring unavailable');assert.equal(homeStatus([cam()],0,true).status,'Monitoring unavailable');
});
