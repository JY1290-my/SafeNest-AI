import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import vm from 'node:vm';
import {JSDOM} from '../video_frontend/node_modules/jsdom/lib/api.js';
import {PushNotifications} from '../web/push-notifications.js';import {FamilyAlerts} from '../web/family-alerts.js';
const html=await readFile(new URL('../web/index.html',import.meta.url),'utf8'),sw=await readFile(new URL('../web/sw.js',import.meta.url),'utf8');
const KEY='B'.repeat(87),stamp=new Date().toISOString(),settle=async()=>{for(let i=0;i<6;i++)await new Promise(resolve=>setImmediate(resolve));};
function pushFixture(extra={}){
 const calls=[],states=[];let sub=null,owned=true,enabled=false;
 const makeSub=()=>({endpoint:'https://fcm.googleapis.com/wp/test',options:{applicationServerKey:Buffer.from(KEY,'base64url')},toJSON(){return{endpoint:this.endpoint,keys:{p256dh:KEY,auth:'a'.repeat(22)}};},async unsubscribe(){calls.push('unsubscribe');sub=null;return true;}});
 const reg={active:{},pushManager:{getSubscription:async()=>sub,subscribe:async opts=>{calls.push({subscribe:opts.userVisibleOnly});sub=makeSub();return sub;}},getNotifications:async()=>[{close(){calls.push('close-notification');}}]};
 const window={isSecureContext:true,Notification:{permission:'default',requestPermission:async()=>{calls.push('permission');window.Notification.permission='granted';return'granted';}},PushManager:function(){},navigator:{serviceWorker:{getRegistration:async()=>reg,register:async()=>{calls.push('register-sw');return reg;}}},atob:x=>Buffer.from(x,'base64').toString('binary'),setTimeout,clearTimeout};
 const rpc=async(name,body)=>{calls.push({name,body});if(name==='family_push_status')return{owned,enabled};if(name==='register_family_push'){enabled=true;owned=true;}if(name==='disable_family_push'||name==='remove_my_push_subscription')enabled=false;return{ok:true};};
 const controller=new PushNotifications({window,rpc,configRequest:async()=>({configured:true,public_key:KEY}),onStatus:s=>states.push(s),onAccessError:()=>{},...extra});
 return{window,controller,calls,states,reg,setSub(value=true){sub=value?makeSub():null;},setOwned(value){owned=value;}};
}
test('push opt-in requests permission/registers only after enable click; per-Home disable leaves other subscriptions intact',async()=>{
 const h=pushFixture();h.controller.setHome('home');await settle();assert.ok(!h.calls.includes('permission'));assert.ok(!h.calls.includes('register-sw'));assert.equal(h.states.at(-1).enable,true);
 await h.controller.enable();assert.equal(h.calls.filter(x=>x==='permission').length,1);assert.equal(h.calls.filter(x=>x==='register-sw').length,1);assert.match(h.states.at(-1).message,/not been verified/);
 const register=h.calls.find(x=>x.name==='register_family_push');assert.equal(register.body.p_home,'home');assert.equal(register.body.p_subscription.endpoint,'https://fcm.googleapis.com/wp/test');assert.ok(!('user_id'in register.body));
 await h.controller.disable();assert.ok(!h.calls.includes('unsubscribe'));assert.equal(h.states.at(-1).enable,true);
});
test('unsupported, denied and unconfigured browsers report real status and never register',async()=>{
 const h=pushFixture();h.window.isSecureContext=false;h.controller.setHome('home');await settle();assert.match(h.states.at(-1).message,/does not support/);assert.equal(h.calls.length,0);
 const blocked=pushFixture();blocked.window.Notification.permission='denied';blocked.controller.setHome('home');await settle();assert.match(blocked.states.at(-1).message,/blocked/);assert.equal(blocked.states.at(-1).enable,false);
 const absent=pushFixture({configRequest:async()=>({configured:false})});absent.controller.setHome('home');await settle();assert.match(absent.states.at(-1).message,/not configured/);assert.equal(absent.states.at(-1).enable,false);
});
test('sign out removes only the account subscription and unsubscribes locally; account switch does not reuse another owner',async()=>{
 const h=pushFixture();h.setSub();h.setOwned(false);h.controller.setHome('home');await settle();await h.controller.enable();assert.ok(h.calls.includes('unsubscribe'));
 await h.controller.logout();assert.ok(h.calls.some(c=>c.name==='remove_my_push_subscription'));assert.ok(h.calls.includes('close-notification'));assert.equal(h.controller.home,'');
 const lost=pushFixture();lost.setSub();await lost.controller.logout(false);assert.ok(lost.calls.includes('unsubscribe'));assert.ok(!lost.calls.some(c=>c.name==='remove_my_push_subscription'));
});
test('late subscription result after Home change is cancelled rather than enabling a hidden old Home',async()=>{
 let resolve;const waiting=new Promise(r=>resolve=r),h=pushFixture();h.controller.setHome('one');await settle();
 const original=h.reg.pushManager.subscribe;h.reg.pushManager.subscribe=async opts=>{await waiting;return original(opts);};
 const enabling=h.controller.enable();await settle();h.controller.setHome('two');resolve();await enabling;assert.ok(h.calls.includes('unsubscribe'));assert.ok(!h.calls.some(c=>c.name==='register_family_push'));
});
function alertFixture(rpc){
 const dom=new JSDOM(html,{url:'https://family.test'}),calls=[],errors=[];const controller=new FamilyAlerts({window:dom.window,document:dom.window.document,rpc:async(name,body)=>{calls.push({name,body});return rpc(name,body);},configRequest:async()=>({configured:false}),onChange:()=>{},onAccessError:e=>errors.push(e)});
 return{controller,calls,errors,$:id=>dom.window.document.getElementById(id),close(){controller.pause();dom.window.close();}};
}
test('persistent alert list renders names as text with fallback; shared confirmation sends only server-scoped IDs',async()=>{
 let viewed=false;
 const h=alertFixture(async(name)=>name==='list_fall_alerts'?{unviewed_count:viewed?0:1,alerts:[{id:'alert',camera_id:'cam',camera_name:'<img src=x>',current:true,occurred_at:stamp,viewed_by_me:viewed,views:viewed?[{name:'<script>Ka Ying</script>',viewed_at:stamp},{name:'person@example.com',viewed_at:stamp}]:[]}]}:{ok:(viewed=true)});
 try{h.controller.setHome('home','Home-001 · Bedroom');await settle();assert.equal(h.$('family-alert-list').querySelector('img'),null);assert.match(h.$('family-alert-count').textContent,/1 not yet viewed/);
  await h.controller.acknowledge('alert');const call=h.calls.find(c=>c.name==='acknowledge_fall_alert');assert.deepEqual(call.body,{p_home:'home',p_alert:'alert'});
  assert.match(h.$('family-alert-list').textContent,/Viewed by <script>Ka Ying<\/script>/);assert.match(h.$('family-alert-list').textContent,/Family member/);assert.equal(h.$('family-alert-list').querySelector('script'),null);
  assert.equal(h.$('family-alert-list').querySelector('button').disabled,true);assert.match(h.$('family-alert-action').textContent,/does not confirm recovery/);
 }finally{h.close();}
});
test('loading, empty, error, revocation and late-response cleanup remain distinct across Homes',async()=>{
 let resolve,mode='pending';const waiting=new Promise(r=>resolve=r);
 const h=alertFixture(async()=>{if(mode==='pending')return waiting;if(mode==='fail')throw{status:403};return{alerts:[],unviewed_count:0};});
 try{h.controller.setHome('old','Old');assert.match(h.$('family-alert-message').textContent,/Loading/);h.controller.pause();resolve({alerts:[{id:'old'}]});await settle();assert.equal(h.$('family-alert-panel').hidden,true);assert.equal(h.controller.rows.length,0);
  mode='empty';h.controller.setHome('new','New');await settle();assert.match(h.$('family-alert-message').textContent,/No suspected-fall/);
  mode='fail';await h.controller.refresh();assert.match(h.$('family-alert-message').textContent,/Could not load/);assert.equal(h.controller.rows.length,0);assert.equal(h.errors[0].status,403);
 }finally{h.close();}
});
test('Service Worker displays generic content, coalesces opaque keys and opens only same-origin authenticated app route',async()=>{
 const handlers={},shown=[],opened=[],seen=new Set();const self={location:{origin:'https://family.test'},addEventListener:(name,fn)=>handlers[name]=fn,registration:{showNotification:async(title,options)=>shown.push({title,options})},clients:{matchAll:async()=>[],openWindow:async url=>opened.push(url)}};
 const context=vm.createContext({self,URL,Date,Promise});vm.runInContext(sw,context);context.claimNotification=async key=>{if(seen.has(key))return false;seen.add(key);return true;};
 const fire=async(name,event)=>{let pending;handlers[name]({...event,waitUntil:p=>pending=p});await pending;};
 const key='a'.repeat(32);await fire('push',{data:{json:()=>({version:1,key,url:'https://evil.test',home_id:'ignored',body:'ignored'})}});await fire('push',{data:{json:()=>({version:1,key})}});
 assert.equal(shown.length,1);assert.equal(shown[0].options.body,'SafeNest has a safety alert. Sign in to review.');assert.deepEqual(Object.keys(shown[0].options.data),['key']);assert.ok(!JSON.stringify(shown).includes('ignored'));
 await fire('notificationclick',{notification:{data:{key,url:'https://evil.test'},close(){}}});assert.equal(opened[0],'https://family.test/?safety-alert='+key);
 await fire('notificationclick',{notification:{data:{key:'bad'},close(){}}});assert.equal(opened[1],'https://family.test/');
 assert.ok(!/addEventListener\(['"]fetch/.test(sw)); // Worker never caches private HTML/Auth/media.
});

test('permission, subscription and unverified delivery are separate facts, never a fake sent/delivered state',async()=>{
 const h=pushFixture();h.window.Notification.permission='granted';h.controller.setHome('home');await settle();
 assert.equal(h.states.at(-1).code,'not_subscribed');assert.match(h.states.at(-1).message,/This device is not subscribed/);
 assert.equal(h.states.at(-1).checks.Permission,'Allowed');assert.equal(h.states.at(-1).checks['Phone display'],'Cannot confirm delivery');
 await h.controller.enable();assert.equal(h.states.at(-1).code,'enabled_unverified');assert.match(h.states.at(-1).message,/Subscription saved; delivery has not been verified/);
 assert.equal(h.states.at(-1).checks['This device'],'Saved for this Home');assert.equal(h.states.at(-1).checks['Background sending'],'Not verified by this page');
 assert.ok(!h.calls.some(c=>c?.name==='list_fall_alerts'||c?.name==='claim_fall_push'));
});
test('missing configuration function and missing notification schema are actionable configuration gaps, not subscription success',async()=>{
 for(const error of [{status:404},{status:503,code:'push_schema_missing'}]){
  const h=pushFixture({configRequest:async()=>{throw error;}});h.controller.setHome('home');await settle();
  const state=h.states.at(-1);assert.equal(state.code,'not_configured');assert.match(state.message,/Push service is not configured/);assert.equal(state.enable,false);assert.equal(state.checks['Phone display'],'Cannot confirm delivery');assert.ok(!h.calls.includes('permission'));assert.ok(!h.calls.includes('register-sw'));
 }
});
test('network/provider failures do not claim backend configured or phone delivered and leave in-app alerts independent',async()=>{
 const down=pushFixture({configRequest:async()=>{throw {status:503};}});down.controller.setHome('home');await settle();assert.equal(down.states.at(-1).code,'request_failed');assert.match(down.states.at(-1).message,/In-app alerts remain available/);
 const failed=pushFixture();failed.controller.setHome('home');await settle();failed.reg.pushManager.subscribe=async()=>{throw new Error('PRIVATE-ENDPOINT must not render');};await failed.controller.enable();
 assert.equal(failed.states.at(-1).code,'request_failed');assert.ok(!JSON.stringify(failed.states).includes('PRIVATE-ENDPOINT'));assert.ok(!failed.calls.some(c=>c?.name==='register_family_push'));
});
test('denied and undecided permission have distinct states; a valid server config cannot request permission by itself',async()=>{
 for(const [permission,code] of [['default','permission_default'],['denied','permission_denied']]){
  const h=pushFixture();h.window.Notification.permission=permission;h.controller.setHome('home');await settle();assert.equal(h.states.at(-1).code,code);assert.ok(!h.calls.includes('permission'));assert.ok(!h.calls.includes('register-sw'));
 }
});
test('revoked authorization clears notification controls and pending old-Home diagnostics cannot return',async()=>{
 const errors=[],denied=pushFixture({configRequest:async()=>{throw{status:403};},onAccessError:e=>errors.push(e)});denied.controller.setHome('home');await settle();assert.equal(denied.states.at(-1).code,'access_denied');assert.equal(denied.states.at(-1).enable,false);assert.equal(errors.length,1);
 let resolve;const pending=new Promise(r=>resolve=r),late=pushFixture({configRequest:()=>pending});late.controller.setHome('old');await settle();late.controller.setHome('');resolve({configured:true,public_key:KEY});await settle();assert.match(late.states.at(-1).message,/Choose an authorized Home/);assert.deepEqual(late.states.at(-1).checks,{});
});
test('Home changes clear rendered diagnostic details and expose only safe status text',async()=>{
 const h=alertFixture(()=>({alerts:[],unviewed_count:0}));try{
  h.controller.setHome('home-a','Home A');await settle();assert.ok(h.$('push-checks').textContent.length>0);assert.match(h.$('alert-push-summary').textContent,/In-app alerts remain available/);
  h.controller.setHome('');assert.equal(h.$('alert-push-summary').textContent,'');assert.equal(h.$('push-checks').children.length,0);assert.equal(h.$('push-settings').hidden,true);
 }finally{h.close();}
});

test('late same-Home configuration response cannot overwrite a newer failed setup check',async()=>{
 let resolve,calls=0;const older=new Promise(r=>resolve=r);
 const h=pushFixture({configRequest:()=>++calls===1?older:Promise.reject({status:404})});
 h.controller.setHome('home');await h.controller.refresh();assert.equal(h.states.at(-1).code,'not_configured');
 resolve({configured:true,public_key:KEY});await settle();assert.equal(h.states.at(-1).code,'not_configured');assert.equal(h.states.at(-1).enable,false);
});
