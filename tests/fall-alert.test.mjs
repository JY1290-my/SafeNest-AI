import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from '../video_frontend/node_modules/jsdom/lib/api.js';
import {currentFallAlerts,FallAlert,alertTime} from '../web/fall-alert.js';
const html=await readFile(new URL('../web/index.html',import.meta.url),'utf8');
const stamp='2026-10-19T01:30:00+00:00';
const camera=(id='bed',status='Suspected Fall')=>({camera_id:id,name:'Bedside',enabled:true,server_now:stamp,received_at:stamp,
  payload:{status,camera_connected:true,observed_at:stamp,events:[],context:{people:[{person_number:2,state:'POSSIBLE_FALL'}]}}});
function setup(){
  const dom=new JSDOM(html,{url:'https://family.test'}),views=[],acks=[];
  const get=id=>dom.window.document.getElementById(id),controller=new FallAlert({document:dom.window.document,onView:id=>views.push(id),onAcknowledge:id=>acks.push(id)});
  return{window:dom.window,$:get,controller,views,acks,close(){controller.clear();dom.window.close();}};
}
test('current suspected Camera observations create alerts; history, uncertainty, offline, disabled and demo do not',()=>{
  const cameras=[camera(),camera('door','Normal')];cameras[1].payload.events=[{status:'Suspected Fall',time:stamp}];
  assert.deepEqual(currentFallAlerts(cameras).map(a=>a.key),['bed']);
  assert.equal(currentFallAlerts(cameras,15001).length,0);assert.equal(currentFallAlerts(cameras,0,true).length,0);
  for(const status of ['Normal','No Person','Checking','Pose Unclear','Tracking Lost','Camera Offline','unknown'])assert.equal(currentFallAlerts([camera('x',status)]).length,0);
  for(const change of [c=>c.enabled=false,c=>c.payload.camera_connected=false,c=>c.payload.stale=true,c=>c.payload.demo=true]){const c=camera();change(c);assert.equal(currentFallAlerts([c]).length,0);}
});
test('person labels derive only from current context; recorded event time is sorted separately without mutating history',()=>{
  const c=camera();c.payload.context.people=[{person_number:3,state:'POSSIBLE_FALL'},{person_number:1,state:'ACTIVE'},
    {person_number:2,state:'POSSIBLE_FALL'},{person_number:3,state:'POSSIBLE_FALL'},{person_number:'7',state:'POSSIBLE_FALL'}];
  c.payload.events=[{time:'2026-10-19T01:29:00Z',status:'Person 99: Suspected Fall'},
    {time:'2026-10-19T01:28:00Z',status:'Suspected Fall'},{time:'bad',status:'Suspected Fall'},
    {time:stamp,status:'Person 1: Normal'}];
  const original=JSON.stringify(c),[alert]=currentFallAlerts([c]);assert.deepEqual(alert.people,[2,3]);
  assert.equal(alert.eventTime,'2026-10-19T01:29:00Z');assert.equal(JSON.stringify(c),original);
  delete c.payload.context;assert.deepEqual(currentFallAlerts([c])[0].people,[]);
  assert.equal(alertTime('not-a-time'),'Time unavailable');
});
test('inline alert renders exact Home/Camera sources as text and keeps view opt-in',()=>{
  const h=setup();try{
    const c=camera();c.name='<img src=x onerror=alert(1)>';
    h.controller.update({homeLabel:'Home-001 · <script>Bedroom</script>',cameras:[c],canView:true});
    assert.equal(h.$('fall-alert').hidden,false);assert.match(h.$('fall-alert-title').textContent,/Suspected Fall — Please check/);
    assert.match(h.$('fall-alert').textContent,/Person 2/);assert.match(h.$('fall-alert').textContent,/Latest observation/);
    assert.equal(h.$('fall-alert').querySelector('script,img,video'),null);assert.equal(h.$('fall-alert').closest('.camera-view'),null);
    assert.equal(h.views.length,0);h.$('fall-alert-list').querySelector('button').click();assert.deepEqual(h.views,['bed']);
    h.controller.update({homeLabel:'Home-001',cameras:[c],canView:false});h.$('fall-alert-list').querySelector('button').click();assert.equal(h.views.length,1);
  }finally{h.close();}
});
test('acknowledgement uses the stable server alert and server-derived views, not heartbeat or Person evidence',()=>{
 const h=setup();try{
  const c=camera(),options={homeLabel:'Home-001',cameras:[c],canView:true,sharedLoaded:true,
   sharedAlerts:[{id:'server-episode',camera_id:'bed',current:true,viewed_by_me:false,views:[]}]};
  h.controller.update(options);const button=h.$('fall-alert-list').querySelectorAll('button')[1];button.focus();button.click();
  assert.deepEqual(h.acks,['server-episode']);assert.equal(button.getAttribute('aria-pressed'),'false'); // only backend response confirms
  options.sharedAlerts[0].viewed_by_me=true;options.sharedAlerts[0].views=[{name:'Ka Ying',viewed_at:stamp}];
  h.controller.update(options);assert.equal(button.getAttribute('aria-pressed'),'true');assert.match(h.$('fall-alert-list').textContent,/Viewed by Ka Ying/);
  c.payload.observed_at='2026-10-19T01:30:01Z';c.payload.events.push({id:'changed-person-event',status:'Person 3: Suspected Fall',time:stamp});h.controller.update(options);
  assert.equal(h.$('fall-alert-list').querySelectorAll('button')[1],button);assert.equal(button.getAttribute('aria-pressed'),'true');
  assert.equal(h.window.document.activeElement,button);
  h.controller.update({...options,elapsed:15001});assert.equal(h.$('fall-alert').hidden,true);h.controller.clear();
  assert.equal(h.$('fall-alert-home').textContent,'');assert.equal(h.window.localStorage.length,0);
 }finally{h.close();}
});
test('missing server record disables shared confirmation; multiple Camera records do not mix',()=>{
 const h=setup();try{
  const cameras=[camera('bed'),camera('door')],options={homeLabel:'Home-001',cameras,canView:true};
  h.controller.update(options);const items=h.$('fall-alert-list').children;
  assert.equal(items[0].querySelectorAll('button')[1].disabled,true);items[0].querySelectorAll('button')[1].click();assert.equal(h.acks.length,0);
  h.controller.update({...options,sharedLoaded:true,sharedAlerts:[{id:'bed-event',camera_id:'bed',current:true,viewed_by_me:true,views:[]}]});
  assert.equal(items[0].querySelectorAll('button')[1].getAttribute('aria-pressed'),'true');assert.equal(items[1].querySelectorAll('button')[1].disabled,true);
  cameras[0].payload.status='Normal';h.controller.update(options);assert.equal(items.length,1);
 }finally{h.close();}
});
