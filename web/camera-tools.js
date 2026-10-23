import {ModalSurface} from './ui-overlays.js';
// Local-only media tools. Never requests a token, connects a room, or uploads bytes.
const MAX_BYTES = 64 * 1024 * 1024;
export function mediaBytes(bytes) {
  if(!Number.isFinite(bytes)||bytes<=0)return '0 B';
  if(bytes<1024)return `${bytes} B`;
  return bytes<1024*1024?`${(bytes/1024).toFixed(1)} KiB`:`${(bytes/1024/1024).toFixed(1)} MiB`;
}
const fileLabel = value => String(value || '').normalize('NFKC').replace(/[^\p{L}\p{N}_-]+/gu,'-').replace(/^-+|-+$/g,'').slice(0,60);
export function recordingType(Recorder) {
  if (!Recorder || typeof Recorder.isTypeSupported !== 'function') return null;
  return ['video/webm;codecs=vp8','video/webm;codecs=vp9','video/mp4','video/webm']
    .find(type => Recorder.isTypeSupported(type)) || null;
}
export class CameraTools {
  constructor({window, document}) {
    this.window=window; this.document=document; this.$=id=>document.getElementById(id);
    this.live=false; this.epoch=0; this.captureEpoch=0; this.urls=new Set(); this.clips=[]; this.recording=null; this.pending=false;
    this.context=null;this.snapshotBytes=0;
    this.listeners=[];
    this.settings=new ModalSurface({window,document,panel:this.$('settings-panel'),opener:this.$('open-settings'),onClose:()=>this.closeSettings()});
    this.listen(this.$('capture-frame'),'click',()=>this.capture());
    this.listen(this.$('record-video'),'click',()=>this.recording ? this.stop() : this.start());
    this.listen(this.$('open-replay'),'click',()=>this.openPanel('replay-panel'));
    this.listen(this.$('open-settings'),'click',()=>this.openPanel('settings-panel'));
    this.listen(this.$('close-settings'),'click',()=>this.closeSettings());
    this.listen(this.$('large-text'),'change',()=>document.body.classList.toggle('large-text',this.$('large-text').checked));
    this.listen(this.$('camera-image'),'load',()=>this.refresh());
    this.listen(document,'visibilitychange',()=>{if(document.hidden && this.recording){this.stop();this.say('Recording stopped while the page is hidden. Download available clips in Replay.');}});
    this.renderClips(); this.refresh();
  }
  listen(target,event,handler){target.addEventListener(event,handler);this.listeners.push(()=>target.removeEventListener(event,handler));}
  say(message){this.$('media-message').textContent=message;}
  openPanel(id,focusId,opener=this.$('open-settings')){
    if(id==='settings-panel'){
      this.settings.open(opener);this.$('open-settings').setAttribute('aria-expanded','true');
      if(focusId){this.$(focusId)?.focus({preventScroll:true});this.$(focusId)?.scrollIntoView?.({block:'nearest'});}
      return;
    }
    const panel=this.$(id);panel.hidden=false;panel.scrollIntoView?.({block:'start',behavior:'smooth'});panel.focus({preventScroll:true});
  }
  closeSettings(){this.settings.close();this.$('open-settings').setAttribute('aria-expanded','false');}
  setContext(context){
    if(this.context?.key!==context?.key)this.reset();
    this.context=context?{...context}:null;this.renderStorage();
  }
  scope(context=this.context){return context?`${context.home} · Camera: ${context.camera}`:'Current camera unavailable';}
  renderStorage(){
    const clipBytes=this.clips.reduce((sum,clip)=>sum+clip.size,0),task=this.recording||this.finalizing;
    const recordingBytes=(task?.chunks||[]).reduce((sum,chunk)=>sum+chunk.size,0);
    this.$('storage-scope').textContent=this.scope();
    this.$('settings-scope').textContent=this.scope();
    this.$('capture-scope').textContent=this.context?'Screenshots & recordings · '+this.scope():this.scope();
    this.$('storage-screenshot').textContent=mediaBytes(this.snapshotBytes);
    this.$('storage-clips').textContent=`${this.clips.length} clip(s) · ${mediaBytes(clipBytes)}`;
    this.$('storage-recording').textContent=`${this.recording?'Recording':this.finalizing?'Finishing recording':'Not recording'} · ${mediaBytes(recordingBytes)}`;
    this.$('storage-total').textContent=mediaBytes(this.snapshotBytes+clipBytes+recordingBytes);
  }
  source(){
    const video=this.$('camera-video'), image=this.$('camera-image');
    if(!this.live)return null;
    if(!video.hidden && video.readyState>=2 && video.videoWidth>0 && video.videoHeight>0)return {element:video,width:video.videoWidth,height:video.videoHeight};
    if(!image.hidden && image.complete && image.naturalWidth>0)return {element:image,width:image.naturalWidth,height:image.naturalHeight};
    return null;
  }
  stream(){
    const video=this.$('camera-video');
    if(!this.live || video.hidden)return null;
    const stream=video.srcObject;
    return stream?.getVideoTracks?.().some(t=>t.readyState==='live') ? stream : null;
  }
  setLive(live){this.live=live;if(!live){this.captureEpoch++;this.pending=false;this.stop();}this.refresh();}
  refresh(){
    const ready=!!this.source(), stream=this.stream(), type=recordingType(this.window.MediaRecorder);
    this.$('capture-frame').disabled=!ready || this.pending;
    this.$('capture-frame').title=ready?'Save this frame to your device':'Connect the camera and wait for a decoded frame.';
    const canRecord=ready && stream && type && this.window.MediaStream;
    this.$('record-video').disabled=!this.recording && (!canRecord || this.finalizing);
    this.$('record-video').textContent=this.recording?'Stop recording':'Record';
    this.$('record-video').setAttribute('aria-pressed',String(!!this.recording));
    this.$('recording-indicator').hidden=!this.recording;
    this.$('capture-help').textContent=!this.live?'Connect the camera to take a screenshot or record.'
      : !ready?'Waiting for a decoded camera frame.'
      : !stream?'Camera saves a screenshot. Recording is unavailable for the local JPEG preview.'
      : !type || !this.window.MediaStream?'Camera saves a screenshot. This browser does not support video recording.'
      : 'Camera saves a screenshot. Record captures video only, up to 5 minutes or 64 MiB. Nothing is uploaded.';
    this.renderStorage();
  }
  url(blob){const value=this.window.URL.createObjectURL(blob);this.urls.add(value);return value;}
  revoke(value){if(this.urls.delete(value))this.window.URL.revokeObjectURL(value);}
  async capture(){
    const source=this.source();if(!source || this.pending)return;
    const epoch=this.captureEpoch,context=this.context?{...this.context}:null;this.pending=true;this.refresh();
    try{
      const canvas=this.document.createElement('canvas');canvas.width=source.width;canvas.height=source.height;
      canvas.getContext('2d').drawImage(source.element,0,0,source.width,source.height);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
      if(epoch!==this.captureEpoch)return;
      if(!blob)throw new Error('No image');
      this.clearSnapshot();const url=this.url(blob),link=this.$('snapshot-download');
      link.href=url;link.download=this.filename('snapshot','png',context);link.textContent='Download screenshot'+(context?' · '+context.camera:'');link.hidden=false;this.snapshotBytes=blob.size;
      // A visible link remains available if automatic downloads are blocked on mobile.
      link.click();this.say('Screenshot ready. If it did not download, tap Download screenshot.');
    }catch{if(epoch===this.captureEpoch)this.say('This browser could not capture the frame. Try another supported browser.');}
    finally{if(epoch===this.captureEpoch){this.pending=false;this.refresh();}}
  }
  filename(kind,ext,context=this.context){const label=context?[fileLabel(context.homeCode),fileLabel(context.camera)].filter(Boolean).join('-')+'-':'';return `SafeNest-${label}${kind}-${new Date().toISOString().replace(/[:.]/g,'-')}.${ext}`;}
  start(){
    if(this.recording || this.finalizing || this.document.hidden || !this.source())return;
    const stream=this.stream(),mimeType=recordingType(this.window.MediaRecorder);
    if(!stream || !mimeType || !this.window.MediaStream)return;
    const task={epoch:this.epoch,context:this.context?{...this.context}:null,chunks:[],bytes:0,tracks:[],keep:true,started:new Date(),timer:null,recorder:null};
    try{
      // Own clones only. Never stop LiveKit's track or attach a second room.
      for(const track of stream.getVideoTracks().filter(t=>t.readyState==='live'))task.tracks.push(track.clone());
      const recorder=new this.window.MediaRecorder(new this.window.MediaStream(task.tracks),{mimeType});task.recorder=recorder;
      recorder.ondataavailable=event=>{
        if(!task.keep || !event.data?.size)return;
        if(task.bytes+event.data.size>MAX_BYTES){task.keep=false;this.stop();this.say('Recording exceeded 64 MiB and was discarded. Try a shorter recording.');return;}
        task.chunks.push(event.data);task.bytes+=event.data.size;this.renderStorage();
      };
      recorder.onerror=()=>{task.keep=false;this.stop();this.say('Recording failed. Please try a shorter recording or another browser.');};
      recorder.onstop=()=>this.finish(task);
      this.recording=task;recorder.start(1000);
      task.timer=this.window.setTimeout(()=>{if(this.recording===task){this.stop();this.say('Five-minute recording limit reached. Download the clip in Replay.');}},300000);
      this.say('Recording video only on this device. Keep this page visible. Tap Stop recording to finish.');
    }catch{
      task.keep=false;task.tracks.forEach(t=>t.stop());this.recording=null;
      this.say('Recording could not start in this browser. Camera viewing is still available.');
    }
    this.refresh();
  }
  stop(discard=false){
    const task=this.recording;if(!task)return;
    if(discard)task.keep=false;
    this.recording=null;this.finalizing=task;this.window.clearTimeout(task.timer);
    try{if(task.recorder.state!=='inactive')task.recorder.stop();else this.finish(task);}
    catch{task.keep=false;this.finish(task);}
    // Stop owned clones immediately, including when a page is leaving.
    task.tracks.forEach(t=>t.stop());this.refresh();
  }
  finish(task){
    if(task.finished)return;task.finished=true;this.window.clearTimeout(task.timer);task.tracks.forEach(t=>t.stop());
    if(this.recording===task)this.recording=null;
    if(this.finalizing===task)this.finalizing=null;
    if(task.keep && task.epoch===this.epoch && task.bytes){
      const mime=task.recorder.mimeType || task.chunks[0].type || 'video/webm';
      const blob=new this.window.Blob(task.chunks,{type:mime});
      const clip={url:this.url(blob),size:blob.size,time:task.started,context:task.context,name:this.filename('recording',mime.includes('mp4')?'mp4':'webm',task.context)};
      this.clips.unshift(clip);
      while(this.clips.length>3 || this.clips.reduce((n,c)=>n+c.size,0)>MAX_BYTES){this.revoke(this.clips.pop().url);}
      this.renderClips();this.say('Recording ready in Replay. Download it before leaving this home or refreshing.');
    }
    task.chunks=[];this.refresh();
  }
  renderClips(){
    // Detached media elements may keep playing; release them before rebuilding.
    for(const video of this.$('local-clips').querySelectorAll('video')){video.pause();video.removeAttribute('src');video.load();}
    this.$('local-clips').replaceChildren(...this.clips.map(clip=>{
      const item=this.document.createElement('li'),title=this.document.createElement('p'),video=this.document.createElement('video'),link=this.document.createElement('a');
      title.textContent=`Manual recording · ${clip.time.toLocaleString()}`+(clip.context?' · '+this.scope(clip.context):'');
      video.controls=true;video.playsInline=true;video.preload='none';video.src=clip.url;video.setAttribute('aria-label',title.textContent);
      link.href=clip.url;link.download=clip.name;link.textContent='Download recording';link.className='download-link';
      item.append(title,video,link);return item;
    }));
    this.$('no-clips').hidden=this.clips.length>0;
    this.renderStorage();
  }
  clearSnapshot(){const link=this.$('snapshot-download');if(link.hasAttribute('href'))this.revoke(link.href);link.removeAttribute('href');link.hidden=true;link.textContent='Download screenshot';this.snapshotBytes=0;}
  reset(){
    this.epoch++;this.captureEpoch++;this.pending=false;this.live=false;
    this.stop(true);if(this.finalizing){this.finalizing.keep=false;this.finalizing.chunks=[];this.finalizing=null;}
    for(const video of this.$('local-clips').querySelectorAll('video')){video.pause();video.removeAttribute('src');video.load();}
    for(const url of [...this.urls])this.revoke(url);
    this.clips=[];this.clearSnapshot();this.renderClips();this.say('');this.closeSettings();this.refresh();
  }
  dispose(){this.reset();this.settings.dispose();this.listeners.forEach(remove=>remove());}
}
