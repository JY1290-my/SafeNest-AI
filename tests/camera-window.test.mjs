import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from '../video_frontend/node_modules/jsdom/lib/api.js';
import {CameraWindow} from '../web/camera-window.js';
const html=await readFile(new URL('../web/index.html',import.meta.url),'utf8');
function setup(){
 const dom=new JSDOM(html,{url:'https://family.example',pretendToBeVisual:true});
 const {window}=dom,document=window.document,video=document.getElementById('camera-video');
 video.hidden=false;let hiddenExits=0;
 const controller=new CameraWindow({window,document,onHiddenExit:()=>hiddenExits++});
 controller.setLive(true);
 return{window,document,video,controller,get hiddenExits(){return hiddenExits;},close(){controller.dispose();window.close();}};
}
test('native PiP uses the existing video and exits cleanly',async()=>{
 const h=setup();let requests=0,exits=0;
 try{
  h.document.pictureInPictureEnabled=true;
  h.video.requestPictureInPicture=async()=>{requests++;h.document.pictureInPictureElement=h.video;};
  h.document.exitPictureInPicture=async()=>{exits++;h.document.pictureInPictureElement=null;};
  await h.controller.toggle();assert.equal(requests,1);assert.equal(h.controller.keepsPlaying,true);
  assert.equal(h.document.getElementById('camera-pip').getAttribute('aria-pressed'),'true');
  h.controller.setLive(false);assert.equal(exits,1);assert.equal(h.controller.keepsPlaying,false);
  assert.equal(h.document.querySelectorAll('video').length,1);
 }finally{h.close();}
});
test('unsupported browser and failed native request fall back to a movable closable mini-player',async()=>{
 for(const fail of [false,true]){
  const h=setup();try{
   if(fail){h.document.pictureInPictureEnabled=true;h.video.requestPictureInPicture=async()=>{throw new Error('Browser denied');};}
   await h.controller.toggle();assert.equal(h.controller.floating,true);assert.match(h.document.getElementById('pip-message').textContent,/inside this webpage/);
   const toolbar=h.document.getElementById('mini-toolbar');toolbar.dispatchEvent(new h.window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
   assert.equal(h.controller.stage.style.left,'20px');
   toolbar.dispatchEvent(new h.window.MouseEvent('pointerdown',{button:0,clientX:10,clientY:10,bubbles:true}));
   h.document.dispatchEvent(new h.window.MouseEvent('pointermove',{clientX:70,clientY:90,bubbles:true}));
   assert.equal(h.controller.stage.style.left,'60px');assert.equal(h.controller.stage.style.top,'80px');
   h.document.getElementById('mini-close').click();assert.equal(h.controller.floating,false);assert.equal(h.controller.stage.hasAttribute('style'),false);
  }finally{h.close();}
 }
});
test('late native PiP completion after stop cannot expose the old video or reopen fallback',async()=>{
 const h=setup();let finish,exits=0;
 try{
  h.document.pictureInPictureEnabled=true;
  h.video.requestPictureInPicture=()=>new Promise(resolve=>{finish=()=>{h.document.pictureInPictureElement=h.video;resolve();};});
  h.document.exitPictureInPicture=async()=>{exits++;h.document.pictureInPictureElement=null;};
  const pending=h.controller.toggle();assert.equal(h.controller.keepsPlaying,true);
  h.controller.setLive(false);finish();await pending;
  assert.equal(exits,1);assert.equal(h.controller.floating,false);assert.equal(h.controller.keepsPlaying,false);
 }finally{h.close();}
});
test('leaving native PiP while the tab is hidden requests camera cleanup',async()=>{
 const h=setup();try{
  h.document.pictureInPictureEnabled=true;h.video.requestPictureInPicture=async()=>{h.document.pictureInPictureElement=h.video;};
  await h.controller.toggle();Object.defineProperty(h.document,'hidden',{configurable:true,value:true});
  h.document.pictureInPictureElement=null;h.video.dispatchEvent(new h.window.Event('leavepictureinpicture'));
  assert.equal(h.hiddenExits,1);assert.equal(h.controller.keepsPlaying,false);
 }finally{h.close();}
});
