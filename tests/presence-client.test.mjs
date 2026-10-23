import test from 'node:test';
import assert from 'node:assert/strict';
import {FamilyPresence} from '../video_frontend/presence-controller.js';
const T='safenest-family:10000000-0000-4000-8000-000000000001',T2='safenest-family:10000000-0000-4000-8000-000000000002';
const S='30000000-0000-4000-8000-000000000001';
const settle=async()=>{for(let i=0;i<6;i++)await new Promise(r=>setImmediate(r));};
function setup(handler){
 const channels=[],calls=[],updates=[],timers=new Map();let clock=0,accessErrors=0;
 const client={disconnected:0,auth:0,async setAuth(){this.auth++;},channel(topic,options){
  const c={topic,options,tracks:[],untracked:0,on(event,filter,cb){this.sync=cb;return this;},subscribe(cb){this.status=cb;return this;},async track(data){this.tracks.push(data);return'ok';},async untrack(){this.untracked++;}};
  channels.push(c);return c;
 },async removeChannel(c){c.removed=true;},async disconnect(){this.disconnected++;}};
 const controller=new FamilyPresence({createClient:onDisconnect=>{client.onDisconnect=onDisconnect;return client;},sessionId:S,requestPresence:async(action,session)=>{
  calls.push({action,session});const value=await handler?.(action);return value??{ok:true,topic:T,members:[{name:'Ka Ying',is_mine:true}]};
 },onChange:value=>updates.push(value),onAccessError:()=>accessErrors++,now:()=>clock,
 setInterval:(cb,ms)=>{timers.set(ms,cb);return ms;},clearInterval:id=>timers.delete(id),setTimeout:cb=>{cb();return 1;},clearTimeout:()=>{}});
 return{controller,channels,client,calls,updates,timers,get accessErrors(){return accessErrors;},setClock:value=>{clock=value;}};
}
test('only private presence channels are opened, payloads contain no names or monitoring data',async()=>{
 const h=setup();try{
  h.controller.start();await settle();assert.equal(h.channels.length,1);
  assert.deepEqual(h.channels[0].options,{config:{private:true,presence:{key:S}}});
  await h.channels[0].status('SUBSCRIBED');
  assert.deepEqual(h.channels[0].tracks,[{online:true}]);assert.equal(h.updates.at(-1).state,'online');
  assert.equal(h.updates.at(-1).members[0].name,'Ka Ying');
  h.channels[0].sync();await settle();assert.ok(h.calls.filter(c=>c.action==='heartbeat').length>=2);
 }finally{h.controller.stop();}
 assert.equal(h.client.disconnected,1);assert.ok(h.channels[0].untracked);assert.equal(h.calls.at(-1).action,'leave');assert.equal(h.timers.size,0);
});
test('unbound/expired session cannot create a channel and triggers access cleanup',async()=>{
 const h=setup(action=>{if(action==='heartbeat')throw Object.assign(new Error('denied'),{status:403,code:'42501'});});
 h.controller.start();await settle();assert.equal(h.channels.length,0);assert.equal(h.accessErrors,1);assert.equal(h.controller.active,false);
 assert.equal(h.updates.at(-1).members.length,0);
});
test('topic rotation replaces the old channel; late old callbacks cannot restore members',async()=>{
 let topic=T;const h=setup(()=>({ok:true,topic,members:[{name:'Current family',is_mine:true}]}));
 try{
  h.controller.start();await settle();await h.channels[0].status('SUBSCRIBED');const old=h.channels[0];
  topic=T2;await h.controller.refresh();assert.ok(old.removed);assert.ok(old.untracked);
  await h.channels[1].status('SUBSCRIBED');await old.status('SUBSCRIBED');assert.equal(h.controller.channel,h.channels[1]);
  h.controller.stop();await h.channels[1].status('SUBSCRIBED');h.client.onDisconnect();assert.equal(h.updates.at(-1).state,'stopped');
 }finally{h.controller.stop();}
});
test('disconnects and stale verification clear the online list; next success reconnects',async()=>{
 let fail=false;const h=setup(action=>{if(action==='heartbeat'&&fail)throw new TypeError('offline');});
 try{
  h.controller.start();await settle();await h.channels[0].status('SUBSCRIBED');
  h.setClock(31000);h.timers.get(1000)();assert.deepEqual(h.updates.at(-1),{state:'unavailable',members:[]});
  fail=true;await h.controller.refresh();assert.equal(h.updates.at(-1).state,'unavailable');assert.ok(h.channels[0].removed);
  fail=false;await h.controller.refresh();await h.channels[1].status('SUBSCRIBED');assert.equal(h.updates.at(-1).state,'online');
 }finally{h.controller.stop();}
});
test('late heartbeat after logout releases its lease without creating a channel',async()=>{
 let finish;const h=setup(action=>action==='heartbeat'?new Promise(resolve=>{finish=resolve;}):{ok:true});
 h.controller.start();await settle();h.controller.stop();finish({ok:true,topic:T,members:[]});await settle();
 assert.equal(h.channels.length,0);assert.equal(h.calls.filter(c=>c.action==='leave').length,2);
 assert.equal(h.updates.at(-1).state,'stopped');
});
