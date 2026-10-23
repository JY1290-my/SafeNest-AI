// Names come from the checked RPC, never from peer-supplied Presence payloads.
export class FamilyPresence {
  constructor({createClient,requestPresence,sessionId,onChange,onAccessError=()=>{},now=()=>performance.now(),
    setInterval:interval=setInterval,clearInterval:clear=clearInterval,setTimeout:later=setTimeout,clearTimeout:cancel=clearTimeout}) {
    Object.assign(this,{createClient,requestPresence,sessionId,onChange,onAccessError,now,interval,clear,later,cancel});
    this.active=false;this.version=0;this.client=null;this.channel=null;this.joined=false;this.busy=false;
    this.members=[];this.verifiedAt=-Infinity;this.topic='';
  }
  start(){
    if(this.active)return;
    this.active=true;this.version++;this.onChange({state:'connecting',members:[]});
    this.timer=this.interval(()=>this.refresh(),15000);
    this.staleTimer=this.interval(()=>{if(this.now()-this.verifiedAt>30000)this.onChange({state:'unavailable',members:[]});},1000);
    this.refresh();
  }
  render(){
    if(this.active)this.onChange({state:this.joined&&this.now()-this.verifiedAt<=30000?'online':'connecting',
      members:this.joined&&this.now()-this.verifiedAt<=30000?this.members:[]});
  }
  dropChannel(){
    const channel=this.channel;this.channel=null;this.topic='';this.joined=false;
    if(channel){
      try{Promise.resolve(channel.untrack()).catch(()=>{});}catch{}
      try{Promise.resolve(this.client.removeChannel(channel)).catch(()=>{});}catch{}
    }
  }
  async refresh(){
    if(!this.active||this.busy)return;
    this.busy=true;const version=this.version;
    try{
      const value=await this.requestPresence('heartbeat',this.sessionId);
      if(!this.active||version!==this.version){this.leaveLease();return;}
      if(!value.ok||!/^safenest-family:[0-9a-f-]{36}$/.test(value.topic)||!Array.isArray(value.members))throw new Error('Presence unavailable');
      this.members=value.members;this.verifiedAt=this.now();
      if(!this.client)this.client=this.createClient(()=>{if(this.active){this.joined=false;this.onChange({state:'unavailable',members:[]});}});
      // Refresh Auth through the same CloudClient; no second persisted Auth store.
      await this.client.setAuth();
      if(!this.active||version!==this.version)return;
      if(value.topic!==this.topic){
        const previous=this.channel;this.channel=null;this.joined=false;this.topic=value.topic;
        if(previous){Promise.resolve(previous.untrack()).catch(()=>{});Promise.resolve(this.client.removeChannel(previous)).catch(()=>{});}
        const channel=this.client.channel(value.topic,{config:{private:true,presence:{key:this.sessionId}}});
        this.channel=channel;
        channel.on('presence',{event:'sync'},()=>{
          if(!this.active||this.channel!==channel)return;
          this.cancel(this.syncTimer);this.syncTimer=this.later(()=>this.refresh(),300);
        });
        channel.subscribe(async status=>{
          if(!this.active||this.channel!==channel)return;
          this.joined=false;this.render();
          if(status==='SUBSCRIBED'){
            try{
              // Intentionally no names, Auth IDs or monitoring data on the socket.
              const result=await channel.track({online:true});
              if(this.active&&this.channel===channel){this.joined=result==='ok';this.render();}
            }catch{if(this.active&&this.channel===channel)this.onChange({state:'unavailable',members:[]});}
          }else this.onChange({state:'unavailable',members:[]});
        });
      }
      this.render();
    }catch(error){
      if(!this.active||version!==this.version)return;
      this.dropChannel();this.members=[];this.verifiedAt=-Infinity;
      this.onChange({state:'unavailable',members:[]});
      if([401,403].includes(error.status)||error.code==='42501'){this.stop();this.onAccessError(error);}
    }finally{this.busy=false;}
  }
  leaveLease(){try{Promise.resolve(this.requestPresence('leave',this.sessionId)).catch(()=>{});}catch{}}
  stop(){
    if(!this.active)return;
    this.active=false;this.version++;this.clear(this.timer);this.clear(this.staleTimer);this.cancel(this.syncTimer);
    const channel=this.channel,client=this.client;
    this.channel=null;this.client=null;this.topic='';this.members=[];this.joined=false;
    // Disconnect synchronously starts cleanup; don't wait for a server ACK before hiding UI.
    if(channel){try{Promise.resolve(channel.untrack()).catch(()=>{});}catch{}}
    if(client){try{Promise.resolve(client.disconnect()).catch(()=>{});}catch{}}
    this.leaveLease();this.onChange({state:'stopped',members:[]});
  }
}
