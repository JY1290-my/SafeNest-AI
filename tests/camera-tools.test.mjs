import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from '../video_frontend/node_modules/jsdom/lib/api.js';
import {CameraTools,recordingType} from '../web/camera-tools.js';
const html=await readFile(new URL('../web/index.html',import.meta.url),'utf8');
const settle=async()=>{for(let i=0;i<3;i++)await new Promise(r=>setImmediate(r));};
function setup(){
  const dom=new JSDOM(html,{url:'https://family.test',pretendToBeVisual:true}),{window}=dom,$=id=>window.document.getElementById(id);
  $('login').hidden=true;$('dashboard').hidden=false;$('monitor-content').hidden=false;
  const urls=[],revoked=[],downloads=[],clones=[],recorders=[];let snapshot;
  window.URL.createObjectURL=blob=>{const url='blob:local/'+urls.length;urls.push({url,blob});return url;};
  window.URL.revokeObjectURL=url=>revoked.push(url);
  window.HTMLAnchorElement.prototype.click=function(){downloads.push(this.href);};
  window.HTMLMediaElement.prototype.pause=function(){};window.HTMLMediaElement.prototype.load=function(){};
  window.HTMLCanvasElement.prototype.getContext=()=>({drawImage:()=>{}});
  window.HTMLCanvasElement.prototype.toBlob=function(callback){snapshot=callback;};
  class Recorder{
    static isTypeSupported(type){return type==='video/webm;codecs=vp8';}
    constructor(stream,options){this.stream=stream;this.mimeType=options.mimeType;this.state='inactive';recorders.push(this);}
    start(){this.state='recording';}
    stop(){this.state='inactive';queueMicrotask(()=>{this.ondataavailable({data:new window.Blob(['video'],{type:this.mimeType})});this.onstop();});}
  }
  window.MediaRecorder=Recorder;window.MediaStream=class{constructor(tracks){this.tracks=tracks;}getVideoTracks(){return this.tracks;}};
  const original={readyState:'live',stops:0,stop(){this.stops++;},clone(){const clone={stops:0,stop(){this.stops++;}};clones.push(clone);return clone;}};
  const video=$('camera-video');video.hidden=false;video.srcObject=new window.MediaStream([original]);
  Object.defineProperties(video,{readyState:{value:2},videoWidth:{value:640},videoHeight:{value:480}});
  const controller=new CameraTools({window,document:window.document});
  return{window,$,controller,urls,revoked,downloads,original,clones,recorders,finishSnapshot(){snapshot(new window.Blob(['png'],{type:'image/png'}));},close(){controller.dispose();window.close();}};
}
test('media controls require a live decoded source; init never captures or records',()=>{
  const h=setup();try{assert.equal(h.$('capture-frame').disabled,true);assert.equal(h.$('record-video').disabled,true);h.controller.capture();h.controller.start();assert.equal(h.recorders.length,0);assert.equal(h.urls.length,0);h.controller.setLive(true);assert.equal(h.recorders.length,0);assert.equal(h.$('capture-frame').disabled,false);assert.equal(h.$('record-video').disabled,false);}finally{h.close();}
});
test('screenshot is an explicit local blob download with a visible mobile retry link',async()=>{
 const h=setup();try{h.controller.setLive(true);h.$('capture-frame').click();h.finishSnapshot();await settle();assert.equal(h.urls[0].blob.type,'image/png');assert.deepEqual(h.downloads,['blob:local/0']);assert.equal(h.$('snapshot-download').hidden,false);assert.equal(h.window.localStorage.length,0);assert.equal(h.window.sessionStorage.length,0);h.controller.reset();assert.deepEqual(h.revoked,['blob:local/0']);assert.equal(h.$('snapshot-download').hasAttribute('href'),false);}finally{h.close();}
});
test('late screenshot cannot reappear after switching devices or losing the video',async()=>{
 for(const reset of ['reset','disconnect']){const h=setup();try{h.controller.setLive(true);h.$('capture-frame').click();if(reset==='reset')h.controller.reset();else h.controller.setLive(false);h.finishSnapshot();await settle();assert.equal(h.urls.length,0);assert.equal(h.downloads.length,0);}finally{h.close();}}
});
test('recording owns clones only and creates an actual local clip after explicit stop',async()=>{
 const h=setup();try{h.controller.setLive(true);h.$('record-video').click();assert.equal(h.recorders.length,1);assert.equal(h.$('recording-indicator').hidden,false);assert.equal(h.$('record-video').textContent,'Stop recording');assert.equal(h.urls.length,0);h.$('record-video').click();await settle();assert.equal(h.original.stops,0);assert.ok(h.clones[0].stops>0);assert.equal(h.$('local-clips').querySelectorAll('video').length,1);assert.equal(h.$('no-clips').hidden,true);assert.equal(h.downloads.length,0);assert.match(h.$('local-clips').querySelector('a').download,/\.webm$/);assert.equal(h.$('recording-indicator').hidden,true);}finally{h.close();}
});
test('device/session reset discards unfinished recording and revokes previous clips',async()=>{
 const h=setup();try{h.controller.setLive(true);h.controller.start();h.controller.stop();await settle();h.controller.start();h.controller.reset();await settle();assert.equal(h.$('local-clips').children.length,0);assert.equal(h.$('no-clips').hidden,false);assert.equal(h.urls.length,1);assert.deepEqual(h.revoked,['blob:local/0']);assert.equal(h.original.stops,0);assert.ok(h.clones.every(t=>t.stops>0));}finally{h.close();}
});
test('disconnect stops recording while preserving a completed same-home clip',async()=>{
 const h=setup();try{h.controller.setLive(true);h.controller.start();h.controller.setLive(false);await settle();assert.equal(h.$('record-video').disabled,true);assert.equal(h.$('local-clips').children.length,1);assert.equal(h.original.stops,0);}finally{h.close();}
});
test('hidden page stops recording even while picture-in-picture may keep viewing',async()=>{
 const h=setup();try{h.controller.setLive(true);h.controller.start();Object.defineProperty(h.window.document,'hidden',{value:true});h.window.document.dispatchEvent(new h.window.Event('visibilitychange'));await settle();assert.equal(h.controller.recording,null);assert.equal(h.$('local-clips').children.length,1);h.controller.start();assert.equal(h.recorders.length,1);}finally{h.close();}
});
test('unsupported recorder and local JPEG preview explain limitations without fake controls',()=>{
 const h=setup();try{h.window.MediaRecorder=undefined;h.controller.setLive(true);assert.equal(h.$('record-video').disabled,true);assert.equal(h.$('capture-frame').disabled,false);assert.match(h.$('capture-help').textContent,/does not support/);h.$('camera-video').hidden=true;const img=h.$('camera-image');img.hidden=false;Object.defineProperties(img,{complete:{value:true},naturalWidth:{value:640},naturalHeight:{value:480}});h.controller.refresh();assert.equal(h.$('capture-frame').disabled,false);assert.equal(h.$('record-video').disabled,true);assert.match(h.$('capture-help').textContent,/JPEG/);assert.equal(recordingType(undefined),null);}finally{h.close();}
});
test('recording error releases clones without affecting the existing stream',async()=>{
 const h=setup();try{h.controller.setLive(true);h.controller.start();h.recorders[0].onerror();await settle();assert.equal(h.urls.length,0);assert.equal(h.original.stops,0);assert.ok(h.clones[0].stops>0);assert.match(h.$('media-message').textContent,/failed/);}finally{h.close();}
});
test('bounded session clips evict and revoke the oldest clip',async()=>{
 const h=setup();try{h.controller.setLive(true);for(let i=0;i<4;i++){h.controller.start();h.controller.stop();await settle();}assert.equal(h.controller.clips.length,3);assert.ok(h.revoked.includes('blob:local/0'));h.controller.reset();assert.equal(new Set(h.revoked).size,4);}finally{h.close();}
});
test('oversized recording is discarded and does not leave a running recorder',async()=>{
 const h=setup();try{h.controller.setLive(true);h.controller.start();h.recorders[0].ondataavailable({data:{size:65*1024*1024}});await settle();assert.equal(h.controller.recording,null);assert.equal(h.urls.length,0);assert.match(h.$('media-message').textContent,/exceeded/);}finally{h.close();}
});
test('replay empty state, real settings and named controls are accessible without unsupported PTZ/prediction switches',()=>{
 const h=setup();try{h.$('open-replay').click();assert.equal(h.window.document.activeElement.id,'replay-panel');assert.match(h.$('no-clips').textContent,/No video clips/);h.$('open-settings').click();assert.equal(h.$('settings-panel').hidden,false);assert.match(h.$('settings-panel').textContent,/PTZ unavailable/);assert.match(h.$('settings-panel').textContent,/No validated prediction model/);assert.equal([...h.window.document.querySelectorAll('button')].some(b=>/PTZ|Prediction Mode/.test(b.textContent)),false);h.$('large-text').click();assert.ok(h.window.document.body.classList.contains('large-text'));h.$('close-settings').click();assert.equal(h.window.document.activeElement.id,'open-settings');assert.equal(h.$('settings-panel').hidden,true);}finally{h.close();}
});

test('mobile page keeps a single camera, viewport scaling and accessible textual status explanations',()=>{
  const h=setup();try{
    assert.match(h.window.document.querySelector('meta[name=viewport]').content,/width=device-width/);
    assert.equal(h.window.document.querySelectorAll('#camera-video').length,1);
    assert.match(h.window.document.querySelector('.legend').textContent,/not a confirmed emergency/);
    for(const label of ['Normal','Checking','Pose Unclear','Tracking Lost','No Person','Suspected Fall'])assert.ok(h.window.document.querySelector('.legend').textContent.includes(label));
    for(const id of ['capture-frame','record-video','open-replay','open-settings'])assert.ok(h.$(id).textContent.trim());
  }finally{h.close();}
});

test('storage inventory counts actual retained screenshot/clip/chunk payloads and never disk or cloud usage',async()=>{
 const h=setup();try{
  h.window.fetch=()=>{throw new Error('Media must not upload');};
  h.controller.setContext({key:'home-camera-1',homeCode:'Home-007',home:'Home-007 · Bedroom',camera:'Bedside'});
  assert.match(h.$('storage-scope').textContent,/Home-007.*Bedroom.*Bedside/);assert.equal(h.$('storage-total').textContent,'0 B');
  h.controller.setLive(true);h.$('capture-frame').click();h.finishSnapshot();await settle();
  assert.equal(h.$('storage-screenshot').textContent,'3 B');assert.match(h.$('snapshot-download').download,/Home-007-Bedside-snapshot/);
  h.controller.start();h.controller.stop();await settle();
  assert.equal(h.$('storage-clips').textContent,'1 clip(s) · 5 B');assert.equal(h.$('storage-total').textContent,'8 B');
  assert.match(h.$('local-clips').textContent,/Home-007.*Bedside/);assert.match(h.$('local-clips').querySelector('a').download,/Home-007-Bedside-recording/);
  h.controller.start();h.recorders[1].ondataavailable({data:new h.window.Blob(['chunk'])});
  assert.equal(h.$('storage-recording').textContent,'Recording · 5 B');assert.equal(h.$('storage-total').textContent,'13 B');
  h.controller.reset();await settle();assert.equal(h.$('storage-total').textContent,'0 B');assert.equal(h.$('storage-recording').textContent,'Not recording · 0 B');
  assert.equal(h.downloads.length,1);assert.equal(h.window.localStorage.length,0);assert.equal(h.window.sessionStorage.length,0);
 }finally{h.close();}
});

test('scope changes discard old media/late callbacks, clear sensitive labels and retain downloaded files outside page control',async()=>{
 const h=setup();try{
  h.controller.setContext({key:'a',home:'Home-001 · <img src=x>',homeCode:'Home-001',camera:'Bedside / first'});
  h.controller.setLive(true);h.controller.capture();h.finishSnapshot();await settle();
  assert.equal(h.$('storage-scope').querySelector('img'),null);
  h.controller.start();h.controller.setContext({key:'b',home:'Home-002 · Living room',homeCode:'Home-002',camera:'Door'});await settle();
  assert.equal(h.$('storage-total').textContent,'0 B');assert.equal(h.$('local-clips').children.length,0);assert.equal(h.$('snapshot-download').hidden,true);
  assert.ok(!h.$('capture-scope').textContent.includes('Home-001'));assert.equal(h.original.stops,0);assert.ok(h.clones[0].stops>0);
  assert.equal(h.downloads.length,1);assert.deepEqual(h.revoked,['blob:local/0']);
  h.controller.setContext(null);assert.equal(h.$('storage-scope').textContent,'Current camera unavailable');
 }finally{h.close();}
});

test('settings explain unavailable features without fake controls or capacity meters and Escape returns focus without stopping video',()=>{
 const h=setup();try{
  h.controller.setLive(true);h.$('open-settings').click();
  const panel=h.$('settings-panel');assert.match(panel.textContent,/No cloud video recording, microSD management or quick voice commands/);
  assert.equal(panel.querySelector('progress,meter'),null);
  assert.equal([...panel.querySelectorAll('button,input')].some(e=>/cloud|microSD|voice|format|delete|reset|prediction/i.test(e.textContent+' '+e.id)),false);
  assert.equal(h.recorders.length,0);assert.equal(h.original.stops,0);assert.equal(h.$('capture-frame').disabled,false);
  panel.dispatchEvent(new h.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  assert.equal(panel.hidden,true);assert.equal(h.window.document.activeElement,h.$('open-settings'));assert.equal(h.$('capture-frame').disabled,false);
 }finally{h.close();}
});

test('five-minute cap stops recording and leaves only an explicitly downloadable clip',async()=>{
 const h=setup();try{let finish;h.window.setTimeout=(callback,delay)=>{assert.equal(delay,300000);finish=callback;return 1;};h.controller.setLive(true);h.controller.start();finish();await settle();assert.equal(h.controller.recording,null);assert.equal(h.$('local-clips').children.length,1);assert.equal(h.downloads.length,0);assert.equal(h.original.stops,0);}finally{h.close();}
});

test('Settings reuses native showModal when present and traps fallback focus without stopping media',()=>{
 const h=setup();try{let opens=0,closes=0;const panel=h.$('settings-panel');
  panel.showModal=()=>{opens++;panel.setAttribute('open','');};panel.close=()=>{closes++;panel.removeAttribute('open');};
  h.window.document.body.style.overflow='auto';h.$('open-settings').focus();h.$('open-settings').click();h.$('open-settings').click();
  assert.equal(opens,1);assert.equal(panel.getAttribute('aria-modal'),'true');assert.equal(h.window.document.activeElement,h.$('close-settings'));
  h.$('close-settings').dispatchEvent(new h.window.KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}));assert.ok(panel.contains(h.window.document.activeElement));assert.notEqual(h.window.document.activeElement,h.$('close-settings'));
  h.$('view-camera').focus();assert.ok(panel.contains(h.window.document.activeElement));
  panel.dispatchEvent(new h.window.Event('cancel',{cancelable:true}));assert.equal(closes,1);assert.equal(panel.hidden,true);assert.equal(h.window.document.body.style.overflow,'auto');assert.equal(h.window.document.activeElement,h.$('open-settings'));assert.equal(h.original.stops,0);
 }finally{h.close();}
});
test('responsive Settings structure is a single fixed modal with a narrow-screen bottom sheet and safe local setup guidance',async()=>{
 const css=await readFile(new URL('../web/styles.css',import.meta.url),'utf8');
 assert.match(css,/\.settings-dialog\{position:fixed/);assert.match(css,/@media\(max-width:599px\)\{\.settings-dialog\{inset:auto 0 0/);assert.match(css,/max-height:94dvh/);
 const h=setup();try{assert.equal(h.window.document.querySelectorAll('#settings-panel').length,1);assert.equal(h.$('open-settings').getAttribute('aria-haspopup'),'dialog');assert.match(h.$('settings-panel').textContent,/Calibration cannot be changed remotely/);assert.match(h.$('settings-panel').textContent,/cannot inspect or clear that computer/);}finally{h.close();}
});
