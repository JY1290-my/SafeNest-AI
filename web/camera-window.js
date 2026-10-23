// Reuses the current media element; never creates a camera or obtains a token.
export class CameraWindow {
  constructor({window,document,onHiddenExit=()=>{}}) {
    Object.assign(this,{window,document,onHiddenExit});
    this.button=document.getElementById('camera-pip');
    this.stage=document.getElementById('camera-stage');
    this.slot=document.getElementById('camera-slot');
    this.toolbar=document.getElementById('mini-toolbar');
    this.message=document.getElementById('pip-message');
    this.live=false;this.version=0;this.nativeVideo=null;this.pendingVideo=null;this.floating=false;
    this.listeners=[];
    this.listen(this.button,'click',()=>this.toggle());
    this.listen(document.getElementById('mini-close'),'click',()=>this.close());
    this.listen(this.toolbar,'pointerdown',event=>{
      if(event.target.closest('button')||event.button!==0)return;
      const rect=this.stage.getBoundingClientRect();
      this.drag={x:event.clientX-rect.left,y:event.clientY-rect.top};
      event.preventDefault();
    });
    this.listen(document,'pointermove',event=>{
      if(this.drag&&this.floating)this.move(event.clientX-this.drag.x,event.clientY-this.drag.y);
    });
    this.listen(document,'pointerup',()=>{this.drag=null;});
    this.listen(document,'pointercancel',()=>{this.drag=null;});
    this.listen(this.toolbar,'keydown',event=>{
      if(event.key==='Escape'){this.close();this.button.focus();return;}
      const delta={ArrowLeft:[-20,0],ArrowRight:[20,0],ArrowUp:[0,-20],ArrowDown:[0,20]}[event.key];
      if(delta&&this.floating){event.preventDefault();const r=this.stage.getBoundingClientRect();this.move(r.left+delta[0],r.top+delta[1]);}
    });
    this.listen(window,'resize',()=>{if(this.floating){const r=this.stage.getBoundingClientRect();this.move(r.left,r.top);}});
  }
  listen(target,type,handler){target.addEventListener(type,handler);this.listeners.push(()=>target.removeEventListener(type,handler));}
  get nativeActive(){return !!this.nativeVideo&&this.document.pictureInPictureElement===this.nativeVideo;}
  get keepsPlaying(){return this.nativeActive||!!this.pendingVideo;}
  setLive(live){this.live=live;this.button.disabled=!live;if(!live)this.close();}
  label(active){this.button.setAttribute('aria-pressed',String(active));this.button.querySelector('span').textContent=active?'Return to page':'Picture-in-Picture';}
  async toggle(){
    if(this.floating||this.nativeActive){this.close();return;}
    if(!this.live||this.pendingVideo)return;
    const video=this.document.getElementById('camera-video'),version=++this.version;
    if(!video.hidden&&this.document.pictureInPictureEnabled&&typeof video.requestPictureInPicture==='function'){
      this.pendingVideo=video;
      try{
        // Must be called directly from this click handler, before any await.
        await video.requestPictureInPicture();
        if(version!==this.version||!this.live){
          if(this.document.pictureInPictureElement===video)await this.document.exitPictureInPicture().catch(()=>{});
          return;
        }
        this.nativeVideo=video;this.label(true);
        this.message.textContent='Picture-in-Picture is open. Keep this page open to continue viewing.';
        const left=()=>{
          video.removeEventListener('leavepictureinpicture',left);
          if(this.nativeVideo!==video)return;
          this.nativeVideo=null;this.label(false);this.message.textContent='';
          if(this.document.hidden)this.onHiddenExit();
        };
        video.addEventListener('leavepictureinpicture',left,{once:true});
      }catch{
        if(version===this.version&&this.live)this.showFallback();
      }finally{
        if(this.pendingVideo===video)this.pendingVideo=null;
        if(version===this.version&&!this.nativeActive&&this.document.hidden)this.onHiddenExit();
      }
    }else this.showFallback();
  }
  showFallback(){
    this.floating=true;this.stage.classList.add('is-floating');this.toolbar.hidden=false;
    this.slot.classList.add('mini-active');this.label(true);
    this.message.textContent='Browser Picture-in-Picture is unavailable. This movable mini-player stays inside this webpage.';
    this.toolbar.focus();
  }
  move(left,top){
    const rect=this.stage.getBoundingClientRect();
    this.stage.style.left=Math.max(0,Math.min(left,this.window.innerWidth-rect.width))+'px';
    this.stage.style.top=Math.max(0,Math.min(top,this.window.innerHeight-rect.height))+'px';
    this.stage.style.right='auto';this.stage.style.bottom='auto';
  }
  close(){
    this.version++;const video=this.nativeVideo||this.pendingVideo;
    this.nativeVideo=null;this.pendingVideo=null;this.floating=false;this.drag=null;
    this.stage.classList.remove('is-floating');this.stage.removeAttribute('style');
    this.slot.classList.remove('mini-active');this.toolbar.hidden=true;this.label(false);this.message.textContent='';
    if(video&&this.document.pictureInPictureElement===video){
      try{Promise.resolve(this.document.exitPictureInPicture()).catch(()=>{});}catch{}
    }
  }
  dispose(){this.close();this.listeners.forEach(remove=>remove());}
}
