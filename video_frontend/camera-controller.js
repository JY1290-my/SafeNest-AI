// Transport lifecycle is dependency-injected for authorization/stale-frame tests.
export class CameraController {
  constructor({createRoom,events,cameraSource,requestToken,video,serverUrl,deviceId,cameraId,onState,now=()=>performance.now()}) {
    Object.assign(this,{createRoom,events,cameraSource,requestToken,video,serverUrl,deviceId,cameraId,onState,now});
    this.active=false;this.version=0;this.room=null;this.lease=null;this.track=null;
    this.lastFrame=0;this.renewedUntil=0;this.startedAt=0;this.renewing=false;this.frameCallback=null;
  }
  clearMedia(){
    if(this.frameCallback!==null&&this.video.cancelVideoFrameCallback)this.video.cancelVideoFrameCallback(this.frameCallback);
    this.frameCallback=null;this.track?.detach(this.video);this.track=null;
    this.video.pause();this.video.srcObject=null;this.video.removeAttribute('src');this.video.hidden=true;
  }
  stop(message='Camera preview paused') {
    this.active=false;this.version++;
    clearInterval(this.watchdog);clearInterval(this.renewTimer);
    const room=this.room,lease=this.lease;this.room=null;this.lease=null;
    this.clearMedia();this.onState(message,false);
    if(room)Promise.resolve(room.disconnect()).catch(()=>{});
    if(lease)this.requestToken('release',lease.session_id).catch(()=>{});
  }
  async start(){
    this.stop();this.active=true;const version=this.version;
    this.onState('Connecting to camera…',false);this.startedAt=this.now();this.lastFrame=0;
    try{
      const lease=await this.requestToken('issue');
      if(!this.active||version!==this.version){this.requestToken('release',lease.session_id).catch(()=>{});return;}
      if(lease.server_url!==this.serverUrl||lease.room!==(this.cameraId?`safenest-camera-${this.cameraId}`:`safenest-${this.deviceId}`)||lease.publisher_identity!==(this.cameraId?`camera-${this.cameraId}`:`device-${this.deviceId}`))throw new Error('Unexpected camera connection');
      this.lease=lease;this.renewedUntil=this.now()+Math.min(25,lease.lease_seconds)*1000;
      this.watchdog=setInterval(()=>this.check(),500);
      const room=this.createRoom();this.room=room;
      const matches=(publication,participant)=>participant?.identity===lease.publisher_identity&&publication?.source===this.cameraSource&&publication?.trackName==='safenest-camera';
      room.on(this.events.TrackPublished,(publication,participant)=>{if(matches(publication,participant))publication.setSubscribed(true);});
      room.on(this.events.TrackSubscribed,(track,publication,participant)=>{
        if(!this.active||version!==this.version||!matches(publication,participant)||track.kind!=='video'){publication.setSubscribed(false);return;}
        this.clearMedia();this.track=track;track.attach(this.video);
        this.video.play().catch(()=>this.stop('Camera playback unavailable'));
        this.watchFrames(version);
      });
      room.on(this.events.TrackUnsubscribed,track=>{if(track===this.track)this.stop('Camera stream not connected');});
      room.on(this.events.TrackMuted,publication=>{if(publication.track===this.track)this.stop('Camera stream not connected');});
      room.on(this.events.ParticipantDisconnected,p=>{if(p.identity===lease.publisher_identity)this.stop('Camera stream not connected');});
      room.on(this.events.Disconnected,()=>{if(this.active)this.stop('Camera stream not connected');});
      room.on(this.events.Reconnecting,()=>this.stop('Camera stream not connected'));
      // Do not subscribe to arbitrary participant tracks or request phone camera/mic.
      await room.connect(lease.server_url,lease.token,{autoSubscribe:false});
      if(!this.active||version!==this.version){await room.disconnect();return;}
      for(const participant of room.remoteParticipants.values())for(const publication of participant.trackPublications.values())if(matches(publication,participant))publication.setSubscribed(true);
      this.renewTimer=setInterval(()=>this.renew(version),8000);
      this.check();
    }catch{if(version===this.version)this.stop('Camera stream not connected');}
  }
  watchFrames(version){
    if(this.video.requestVideoFrameCallback){
      const arrived=()=>{
        if(!this.active||version!==this.version)return;
        this.lastFrame=this.now();this.video.hidden=false;this.onState('Live',true);
        this.frameCallback=this.video.requestVideoFrameCallback(arrived);
      };
      this.frameCallback=this.video.requestVideoFrameCallback(arrived);
    }else{
      this.lastDecoded=this.video.getVideoPlaybackQuality?.().totalVideoFrames||0;
    }
  }
  check(){
    if(!this.active)return;
    const now=this.now();
    if(now>=this.renewedUntil){this.stop('Camera access expired');return;}
    if(this.track&&!this.video.requestVideoFrameCallback){
      const frames=this.video.getVideoPlaybackQuality?.().totalVideoFrames;
      if(Number.isFinite(frames)&&frames>this.lastDecoded){this.lastDecoded=frames;this.lastFrame=now;this.video.hidden=false;this.onState('Live',true);}
    }
    if((this.lastFrame&&now-this.lastFrame>2000)||(!this.lastFrame&&now-this.startedAt>15000))this.stop('Camera stream not connected');
  }
  async renew(version){
    if(!this.active||this.renewing)return;
    this.renewing=true;
    try{
      const value=await this.requestToken('renew',this.lease.session_id);
      if(this.active&&version===this.version)this.renewedUntil=this.now()+Math.min(25,value.lease_seconds)*1000;
    }catch{if(version===this.version)this.stop('Camera access denied or connection lost');}
    finally{this.renewing=false;}
  }
}
