import test from 'node:test';import assert from 'node:assert/strict';import {createECDH,randomBytes} from 'node:crypto';
import webpush from '../video_frontend/node_modules/web-push/src/index.js';
import ece from '../video_frontend/node_modules/http_ece/ece.js';
import {createDispatchHandler,createPushConfigHandler,validPushSubscription,notificationPayload,createWebPushSender} from '../supabase/functions/_shared/push-core.js';
const secret='local-mock-secret-no-service-credentials',publicKey='B'.repeat(87),key='a'.repeat(32);
const sub={endpoint:'https://fcm.googleapis.com/wp/test',keys:{p256dh:'B'.repeat(87),auth:'a'.repeat(22)},notification_key:key};
const request=(headers={},method='POST')=>new Request('https://edge.test/dispatch',{method,headers:{'x-safenest-dispatch-secret':secret,...headers}});
function setup(extra={}){
 const calls=[],jobs=[{id:'job',claim:'claim'}];
 const handler=createDispatchHandler({secret,publicKey,ready:true,claim:async()=>{calls.push('claim');return jobs.shift();},begin:async()=>{calls.push('begin');return sub;},finish:async(job,result)=>calls.push(result),send:async(s,payload)=>{calls.push(JSON.parse(payload));return{status:201};},...extra});
 return{handler,calls};
}
test('dispatcher requires server secret, rejects browser Origin, wrong methods and unconfigured service',async()=>{
 const h=setup();for(const r of [request({'x-safenest-dispatch-secret':'wrong'}),request({Origin:'https://family.test'}),request({},'GET')])assert.ok((await h.handler(r)).status>=400);
 assert.deepEqual(h.calls,[]);assert.equal((await setup({ready:false}).handler(request())).status,503);
});
test('dispatcher reauthorizes before sending, accepts only minimal opaque payload and does not claim delivered',async()=>{
 const h=setup(),result=await(await h.handler(request())).json();assert.ok(h.calls.indexOf('begin')<h.calls.findIndex(x=>typeof x==='object'));assert.deepEqual(h.calls.find(x=>typeof x==='object'),{version:1,key});assert.equal(h.calls.filter(x=>x==='sent').length,1);
 assert.deepEqual(result,{processed:1,accepted:1,failed:0,unknown:0});
 const cancelled=setup({begin:async()=>null});await cancelled.handler(request());assert.ok(!cancelled.calls.some(x=>typeof x==='object'));
 assert.deepEqual(Object.keys(JSON.parse(notificationPayload(key))).sort(),['key','version']);assert.throws(()=>notificationPayload('user-uuid'));
});
test('gone subscriptions, explicit retryable failures, forbidden endpoints and uncertain timeout have distinct outcomes',async()=>{
 for(const [status,expected] of [[404,'gone'],[410,'gone'],[429,'retry'],[503,'retry'],[400,'failed']]){const h=setup({send:async()=>({status})});await h.handler(request());assert.ok(h.calls.includes(expected));}
 const uncertain=setup({send:async()=>{throw new Error('private endpoint must never be logged');}});await uncertain.handler(request());assert.ok(uncertain.calls.includes('unknown'));assert.ok(!JSON.stringify(uncertain.calls).includes('private endpoint'));
 const invalid=setup({begin:async()=>({...sub,endpoint:'https://127.0.0.1/private'})});await invalid.handler(request());assert.ok(invalid.calls.includes('failed'));
 for(const endpoint of ['http://fcm.googleapis.com/test','https://evil.test/','https://fcm.googleapis.com.evil.test/x','https://fcm.googleapis.com:123/x','https://fcm.googleapis.com@evil.test/x','https://fcm.googleapis.com/x#fragment'])assert.equal(validPushSubscription({...sub,endpoint}),false);
});
test('push config requires allowed Origin, verified Auth and Home membership, and exposes public key only',async()=>{
 let verifies=0,authorizes=0;const handler=createPushConfigHandler({origins:['https://family.test'],ready:true,publicKey,verify:async()=>verifies++,authorize:async(jwt,home)=>{authorizes++;if(home.startsWith('f'))throw{status:403};}});
 const req=(body,headers={})=>new Request('https://edge.test/config',{method:'POST',headers:{Origin:'https://family.test',Authorization:'Bearer user',...headers},body:JSON.stringify(body)});
 assert.equal((await handler(req({home_id:'10000000-0000-4000-8000-000000000001'}))).status,200);
 assert.deepEqual(await(await handler(req({home_id:'10000000-0000-4000-8000-000000000001'}))).json(),{configured:true,public_key:publicKey,checks:{membership:'authorized',subscription_schema:'available',signing:'configured',background_sending:'not_verified',phone_delivery:'not_verified'}});
 assert.equal((await handler(req({home_id:'f0000000-0000-4000-8000-000000000001'}))).status,403);
 const before=verifies;assert.equal((await handler(req({}, {Origin:'https://evil.test'}))).status,403);assert.equal(verifies,before);
 assert.equal((await handler(req({}, {Authorization:''}))).status,401);assert.ok(authorizes>=3);
});
test('pinned web-push sender creates real decryptable aes128gcm + VAPID with no network',async()=>{
 const vapid=webpush.generateVAPIDKeys(),receiver=createECDH('prime256v1');receiver.generateKeys();const auth=randomBytes(16).toString('base64url');
 const subscription={endpoint:'https://fcm.googleapis.com/wp/offline-fixture',keys:{p256dh:receiver.getPublicKey().toString('base64url'),auth}};
 let captured;const send=createWebPushSender({webpush,...vapid,subject:'https://family.test',fetcher:async(url,options)=>{captured={url,options};return{status:201};}});
 const payload=notificationPayload(key);assert.equal((await send(subscription,payload)).status,201);
 const {options}=captured;assert.equal(options.redirect,'error');assert.equal(options.headers['Content-Encoding'],'aes128gcm');assert.equal(options.headers.TTL,60);assert.match(options.headers.Authorization,/^vapid /);
 assert.ok(!options.body.includes(Buffer.from(payload)));assert.equal(ece.decrypt(options.body,{version:'aes128gcm',privateKey:receiver,authSecret:auth}).toString(),payload);
 assert.ok(!JSON.stringify(options.headers).includes(vapid.privateKey));
});

test('config explicitly leaves background sending/delivery unknown and reports schema gaps without private errors',async()=>{
 const req=()=>new Request('https://edge.test/config',{method:'POST',headers:{Origin:'https://family.test',Authorization:'Bearer user'},body:JSON.stringify({home_id:'10000000-0000-4000-8000-000000000001'})});
 const make=extra=>createPushConfigHandler({origins:['https://family.test'],ready:false,publicKey,verify:async()=>{},authorize:async()=>{},...extra});
 const notReady=await(await make({})(req())).json();assert.equal(notReady.configured,false);assert.equal(notReady.public_key,null);assert.equal(notReady.checks.signing,'missing');assert.equal(notReady.checks.background_sending,'not_verified');
 const absent=await make({authorize:async()=>{throw{status:503,code:'push_schema_missing',message:'private database value'};}})(req());assert.equal(absent.status,503);const safe=await absent.json();assert.equal(safe.code,'push_schema_missing');assert.ok(!JSON.stringify(safe).includes('private database value'));
});
