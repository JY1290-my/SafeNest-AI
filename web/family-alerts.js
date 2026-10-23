import {alertTime} from './fall-alert.js';
import {displayName} from './family-view.js';
import {PushNotifications} from './push-notifications.js';
export class FamilyAlerts {
 constructor({window,document,rpc,configRequest,onChange,onAccessError}){
  Object.assign(this,{window,document,rpc,onChange,onAccessError});this.$=id=>document.getElementById(id);
  this.home='';this.version=0;this.request=0;this.pending=false;this.rows=[];this.loaded=false;this.acking=new Set();this.nodes=new Map();
  this.push=new PushNotifications({window,rpc,configRequest,onAccessError,onStatus:state=>{
   this.$('push-status').textContent=state.message;
   this.$('alert-push-summary').textContent=this.home?state.message:'';
   this.$('push-status').dataset.state=state.code;
   const checks=Object.entries(state.checks||{}).map(([label,value])=>{
    const row=document.createElement('div'),term=document.createElement('dt'),detail=document.createElement('dd');
    term.textContent=label;detail.textContent=value;row.append(term,detail);return row;
   });this.$('push-checks').replaceChildren(...checks);
   this.$('enable-push').hidden=!state.enable;this.$('disable-push').hidden=!state.disable;
   this.$('enable-push').disabled=this.$('disable-push').disabled=state.busy;
   this.$('refresh-push').disabled=state.busy;
  }});
  this.$('enable-push').addEventListener('click',()=>this.push.enable());
  this.$('disable-push').addEventListener('click',()=>this.push.disable());
  this.$('refresh-push').addEventListener('click',()=>this.push.refresh());
  this.$('refresh-alerts').addEventListener('click',()=>{this.refresh();this.push.refresh();});
 }
 setHome(home,label=''){
  this.version++;this.request++;this.pending=false;this.home=home;this.label=label;
  this.rows=[];this.loaded=false;this.acking.clear();this.nodes.clear();this.$('family-alert-list').replaceChildren();
  this.$('family-alert-count').textContent='';this.$('family-alert-scope').textContent=home?label:'';
  this.$('family-alert-panel').hidden=!home;this.$('push-settings').hidden=!home;
  this.$('family-alert-message').textContent=home?'Loading this Home’s alerts…':'';
  this.$('family-alert-action').textContent='';this.push.setHome(home);this.onChange();
  if(home)this.refresh();
 }
 async refresh(){
  if(!this.home||this.pending)return;
  const version=this.version,request=++this.request,home=this.home;this.pending=true;
  try{
   const value=await this.rpc('list_fall_alerts',{p_home:home});
   if(version!==this.version||request!==this.request)return;
   if(!Array.isArray(value.alerts))throw new Error('Invalid alerts');
   this.rows=value.alerts.slice(0,30);this.loaded=true;this.render();
   this.$('family-alert-count').textContent=Number.isSafeInteger(value.unviewed_count)?value.unviewed_count+' not yet viewed by you':'';
   this.$('family-alert-message').textContent=this.rows.length?'Latest 30 alerts · History is retained. Current status is checked separately.':'No suspected-fall alerts recorded for this Home yet.';
   this.onChange();
  }catch(e){if(version!==this.version)return;this.rows=[];this.loaded=false;this.nodes.clear();this.$('family-alert-list').replaceChildren();this.$('family-alert-count').textContent='';
   this.$('family-alert-message').textContent='Could not load family alerts. Check your connection and notification migration setup.';this.onChange();this.onAccessError(e);
  }finally{if(version===this.version)this.pending=false;}
 }
 current(camera){return this.loaded?this.rows.find(row=>row.camera_id===camera&&row.current===true):null;}
 render(){
  const keep=new Set(this.rows.map(a=>a.id));
  for(const [key,row] of this.nodes)if(!keep.has(key)){row.li.remove();this.nodes.delete(key);}
  this.rows.forEach((alert,index)=>{
   let row=this.nodes.get(alert.id);
   if(!row){
    const make=tag=>this.document.createElement(tag),li=make('li'),title=make('h3'),time=make('p'),state=make('p'),views=make('p'),button=make('button');
    views.className='small';button.type='button';button.className='secondary';
    const id=alert.id;button.addEventListener('click',()=>this.acknowledge(id));li.append(title,time,state,views,button);
    row={li,title,time,state,views,button};this.nodes.set(id,row);
   }
   row.title.textContent='Suspected Fall — Please check';row.time.textContent=String(alert.camera_name||'Camera name unavailable')+' · '+alertTime(alert.occurred_at);
   row.state.textContent=alert.current?'Current suspected-fall observation':'Recorded alert · Check Camera status for the current observation';
   row.views.textContent=sharedViews(alert);row.button.textContent=alert.viewed_by_me?'Acknowledged by you':'Acknowledge';row.button.disabled=alert.viewed_by_me===true||this.acking.has(alert.id);
   const position=this.$('family-alert-list').children[index];if(position!==row.li)this.$('family-alert-list').insertBefore(row.li,position||null);
  });
 }
 async acknowledge(id){
  const alert=this.rows.find(row=>row.id===id),home=this.home,version=this.version;
  if(!home||!this.loaded||!alert||alert.viewed_by_me||this.acking.has(id))return;
  this.acking.add(id);this.render();this.onChange();this.$('family-alert-action').textContent='Saving your viewed confirmation…';
  try{
   const value=await this.rpc('acknowledge_fall_alert',{p_home:home,p_alert:id});
   if(version!==this.version)return;if(!value.ok)throw new Error('Not saved');
   this.$('family-alert-action').textContent='Viewed confirmation saved for this Home’s family. This does not confirm recovery or change detection or local alerts.';
   // Invalidate any earlier poll, then reload authoritative names and times.
   this.request++;this.pending=false;await this.refresh();
  }catch(e){if(version===this.version){this.$('family-alert-action').textContent='Could not confirm your acknowledgement. Refresh alerts before trying again.';this.onAccessError(e);}}
  finally{if(version===this.version){this.acking.delete(id);this.render();this.onChange();}}
 }
 pause(){this.setHome('');}
 async logout(authenticated=true){this.pause();await this.push.logout(authenticated);}
}
export function sharedViews(alert){
 const views=Array.isArray(alert.views)?alert.views:[];
 return views.length?'Viewed by '+views.map(view=>displayName(view.name)+' · '+alertTime(view.viewed_at)).join('; '):'No family viewing confirmation recorded.';
}
