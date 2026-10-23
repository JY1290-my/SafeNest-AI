import test from 'node:test';import assert from 'node:assert/strict';
import {CameraController} from '../video_frontend/camera-controller.js';
function setup(){
 let time=100,callback=null;const calls=[],states=[],handlers={};
 const room={on:(name,fn)=>{handlers[name]=fn},connect:async()=>{},disconnect:async()=>calls.push('disconnect'),remoteParticipants:new Map()};
 const video={hidden:true,srcObject:null,removeAttribute:()=>{},pause:()=>{},play:async()=>{},requestVideoFrameCallback:fn=>{callback=fn;return 1},cancelVideoFrameCallback:()=>{callback=null}};
 const events=Object.fromEntries(['TrackPublished','TrackSubscribed','TrackUnsubscribed','TrackMuted','ParticipantDisconnected','Disconnected','Reconnecting'].map(x=>[x,x]));
 const requestToken=async(action,session)=>{calls.push(action);return{session_id:'test-session',lease_seconds:25,server_url:'wss://test.livekit.cloud',room:'safenest-device',publisher_identity:'device-device',token:'test'};};
 const c=new CameraController({createRoom:()=>room,events,cameraSource:'camera',requestToken,video,serverUrl:'wss://test.livekit.cloud',deviceId:'device',onState:(message,live)=>states.push([message,live]),now:()=>time});
 return{c,room,video,calls,states,handlers,frame:()=>callback?.(),setTime:value=>time=value};
}
function track(){return{kind:'video',attach:v=>{v.srcObject={}},detach:()=>{}}}
const pub=()=>({source:'camera',trackName:'safenest-camera',setSubscribed:()=>{}});
test('no live label until an actual decoded video frame',async()=>{const s=setup();await s.c.start();try{s.handlers.TrackSubscribed(track(),pub(),{identity:'device-device'});assert.equal(s.video.hidden,true);assert.equal(s.states.some(x=>x[0]==='Live'),false);s.frame();assert.equal(s.video.hidden,false);assert.ok(s.states.some(x=>x[0]==='Live'))}finally{s.c.stop()}});
test('stalled frame clears old picture and disconnects',async()=>{const s=setup();await s.c.start();s.handlers.TrackSubscribed(track(),pub(),{identity:'device-device'});s.frame();s.setTime(2201);s.c.check();assert.equal(s.c.active,false);assert.equal(s.video.hidden,true);assert.equal(s.video.srcObject,null);assert.ok(s.calls.includes('disconnect'));assert.ok(s.calls.includes('release'))});
test('unrelated device track is rejected',async()=>{const s=setup();await s.c.start();try{let subscribed=true;const p=pub();p.setSubscribed=value=>subscribed=value;s.handlers.TrackSubscribed(track(),p,{identity:'other-device'});assert.equal(subscribed,false);assert.equal(s.video.srcObject,null)}finally{s.c.stop()}});
test('renew permission failure stops video immediately',async()=>{const s=setup();await s.c.start();s.c.requestToken=async()=>{throw new Error('Access denied')};await s.c.renew(s.c.version);assert.equal(s.c.active,false);assert.equal(s.video.srcObject,null)});
test('lease expiration stops active connection even with valid room token',async()=>{const s=setup();await s.c.start();s.setTime(25101);s.c.check();assert.equal(s.c.active,false);assert.ok(s.states.some(x=>x[0]==='Camera access expired'))});
test('stop during pending token request releases lease without joining room',async()=>{const s=setup();let resolve;s.c.requestToken=async action=>action==='issue'?await new Promise(r=>resolve=r):(s.calls.push(action),{});const task=s.c.start();s.c.stop();resolve({session_id:'session'});await task;assert.ok(s.calls.includes('release'));assert.equal(s.c.room,null)});
test('camera controller rejects a sibling Camera room and accepts only selected Camera publisher',async()=>{
 const s=setup();s.c.cameraId='selected-camera';s.c.requestToken=async()=>({session_id:'s',lease_seconds:25,server_url:'wss://test.livekit.cloud',room:'safenest-camera-selected-camera',publisher_identity:'camera-selected-camera',token:'test'});
 await s.c.start();try{assert.ok(s.c.active);let subscribed=true;const p=pub();p.setSubscribed=v=>subscribed=v;s.handlers.TrackSubscribed(track(),p,{identity:'camera-other'});assert.equal(subscribed,false);s.handlers.TrackSubscribed(track(),pub(),{identity:'camera-selected-camera'});s.frame();assert.equal(s.video.hidden,false);}finally{s.c.stop();}
 const bad=setup();bad.c.cameraId='another-camera';await bad.c.start();assert.equal(bad.c.active,false);assert.equal(bad.c.room,null);
});
