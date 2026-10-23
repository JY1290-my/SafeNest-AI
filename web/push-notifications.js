function matchingKey(window,sub,key){
 try{const expected=Uint8Array.from(window.atob(key.replace(/-/g,'+').replace(/_/g,'/')+'='),c=>c.charCodeAt(0));
 const actual=sub.options?.applicationServerKey;return !!actual&&actual.byteLength===expected.length&&expected.every((v,i)=>v===new Uint8Array(actual)[i]);}catch{return false;}
}
const permissionLabel = value => value==='granted'?'Allowed':value==='denied'?'Denied':'Not decided';
// User-click opt-in only. Subscription, permission and provider acceptance are
// different facts. No browser interface here can prove phone delivery.
export class PushNotifications {
 constructor({window,rpc,configRequest,onStatus,onAccessError}){
  Object.assign(this,{window,rpc,configRequest,onStatus,onAccessError});
  this.home='';this.version=0;this.checkRequest=0;this.publicKey='';this.enabled=false;this.busy=false;this.checks={};
 }
 supported(){const w=this.window;return w.isSecureContext===true&&!!w.navigator.serviceWorker&&!!w.PushManager&&!!w.Notification;}
 status(message,enable=false,disable=false,code='info'){this.onStatus({message,enable,disable,busy:this.busy,code,checks:{...this.checks}});}
 setHome(home){this.home=home;this.version++;this.checkRequest++;this.publicKey='';this.enabled=false;this.busy=false;this.checks={};
  if(home)this.refresh();else this.status('Choose an authorized Home to manage browser notifications.');}
 async subscription(){const reg=await this.window.navigator.serviceWorker.getRegistration('/');return reg?await reg.pushManager.getSubscription():null;}
 failed(error,stage){
  this.checks[stage]='Unavailable';this.checks['Phone display']='Cannot confirm delivery';
  if([401,403].includes(error.status)){
   this.status('Your notification access could not be authorized. Choose an authorized Home or sign in again.',false,false,'access_denied');
   this.onAccessError(error);return;
  }
  if(error.status===404||error.code==='push_schema_missing'){
   this.status('Push service is not configured. Ask the Home manager to check notification setup. In-app alerts remain available.',false,this.enabled,'not_configured');
  }else this.status('Push request failed. Could not check browser push settings or confirm delivery. In-app alerts remain available.',false,this.enabled,'request_failed');
 }
 async refresh(){
  const home=this.home,version=this.version;if(!home||this.busy)return;
  const request=++this.checkRequest,current=()=>version===this.version&&request===this.checkRequest;
  this.publicKey='';this.enabled=false;
  this.checks={'Browser support':this.supported()?'Supported':'Not supported here',
   'Permission':permissionLabel(this.window.Notification?.permission),
   'This device':'Not checked','Push service':'Not checked',
   'Background sending':'Not verified by this page','Phone display':'Cannot confirm delivery'};
  if(!this.supported()){
   this.status('Browser notifications are not supported here. This browser does not support Web Push in this context. In-app alerts remain available. On iPhone or iPad, add this site to the Home Screen, open it there and enable notifications.',false,false,'unsupported');return;
  }
  this.status('Checking browser notification settings…',false,false,'checking');
  const [configResult,subResult]=await Promise.allSettled([this.configRequest(home),this.subscription()]);
  if(!current())return;
  if(subResult.status==='rejected'){this.failed(subResult.reason,'This device');return;}
  let sub=subResult.value;this.checks['This device']=sub?'Subscription found; ownership not yet checked':'Not subscribed';
  if(configResult.status==='rejected'){this.failed(configResult.reason,'Push service');return;}
  const config=configResult.value;
  if(!config||typeof config.configured!=='boolean'){this.failed(new Error('Invalid configuration response'),'Push service');return;}
  try{
   const state=await this.rpc('family_push_status',{p_home:home,p_endpoint:sub?.endpoint||null});
   if(!current())return;
   if(typeof state.owned!=='boolean'||typeof state.enabled!=='boolean')throw new Error('Invalid subscription status');
   this.publicKey=config.configured&&/^[\w-]{87}$/.test(config.public_key||'')?config.public_key:'';
   this.enabled=state.enabled===true&&state.owned===true&&!!sub;
   this.checks['Push service']=this.publicKey?'Signing configuration available; membership checked':'Not configured';
   if(sub&&!state.owned){await sub.unsubscribe();if(!current())return;sub=null;}
   this.checks['This device']=this.enabled?'Saved for this Home':sub?'Not enabled for this Home':'Not subscribed';
   if(sub&&state.owned&&this.publicKey&&!matchingKey(this.window,sub,this.publicKey)){
    this.checks['This device']='Signing key changed; renew subscription';
    this.status('Push signing key changed. Enable notifications again to renew this browser subscription.',this.window.Notification.permission!=='denied',this.enabled,'key_changed');return;
   }
   const permission=this.window.Notification.permission;
   if(permission==='denied'){
    this.status('Notification permission denied. Browser notifications are blocked; allow this site in browser and phone settings. In-app alerts remain available.',false,this.enabled,'permission_denied');
   }else if(!this.publicKey){
    this.status('Push service is not configured. In-app alerts remain available. Ask the Home manager to check notification setup.',false,this.enabled,'not_configured');
   }else if(this.enabled&&permission==='granted'){
    this.status('Subscription saved; delivery has not been verified. Background sending and phone display cannot be confirmed by this page.',false,true,'enabled_unverified');
   }else if(permission==='granted'){
    this.status('This device is not subscribed for this Home. Browser permission is allowed; enable notifications on this phone or browser.',true,false,'not_subscribed');
   }else{
    this.status('Notification permission not decided. Enable browser notifications to choose whether to allow them.',true,this.enabled,'permission_default');
   }
  }catch(error){if(current()){this.publicKey='';this.enabled=false;this.failed(error,'This device');}}
 }
 async enable(){
  const home=this.home,version=this.version;
  if(!home||!this.publicKey||this.busy||!this.supported())return;
  this.busy=true;this.status('Enabling browser notifications…',false,false,'enabling');let created=null;
  try{
   // Keep this before any await: permission must come from the explicit click.
   const permission=this.window.Notification.permission==='granted'?'granted':await this.window.Notification.requestPermission();
   if(version!==this.version)return;
   this.checks['Permission']=permissionLabel(permission);
   if(permission!=='granted'){
    this.busy=false;
    this.status(permission==='denied'?'Notification permission denied. Notifications were not allowed; check browser and phone settings. In-app alerts remain available.':'Notification permission not decided. Notifications were not allowed. In-app alerts remain available.',permission==='default',this.enabled,permission==='denied'?'permission_denied':'permission_default');return;
   }
   const reg=await this.window.navigator.serviceWorker.register('/sw.js',{scope:'/',updateViaCache:'none'});
   if(!reg.active)await new Promise((resolve,reject)=>{
    const worker=reg.installing||reg.waiting;if(!worker){reject(new Error('Service worker unavailable'));return;}
    const timeout=this.window.setTimeout(()=>{worker.removeEventListener('statechange',change);reject(new Error('Activation timed out'));},10000);
    const change=()=>{if(worker.state==='activated'){this.window.clearTimeout(timeout);worker.removeEventListener('statechange',change);resolve();}else if(worker.state==='redundant'){this.window.clearTimeout(timeout);worker.removeEventListener('statechange',change);reject(new Error('Activation failed'));}};
    worker.addEventListener('statechange',change);change();
   });
   if(version!==this.version)return;
   let sub=await reg.pushManager.getSubscription();
   if(sub){
    const state=await this.rpc('family_push_status',{p_home:home,p_endpoint:sub.endpoint});
    if(!state.owned||!matchingKey(this.window,sub,this.publicKey)){await sub.unsubscribe();sub=null;}
   }
   if(version!==this.version)return;
   if(!sub){
    const key=Uint8Array.from(this.window.atob(this.publicKey.replace(/-/g,'+').replace(/_/g,'/')+'='),c=>c.charCodeAt(0));
    sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});created=sub;
   }
   if(version!==this.version){if(created)await created.unsubscribe();return;}
   const result=await this.rpc('register_family_push',{p_home:home,p_subscription:sub.toJSON(),p_application_key:this.publicKey});
   if(!result.ok)throw new Error('Subscription not accepted');
   if(version!==this.version){await this.rpc('disable_family_push',{p_home:home,p_endpoint:sub.endpoint}).catch(()=>{});if(created)await created.unsubscribe();return;}
  }catch(error){
   if(created)await created.unsubscribe().catch(()=>{});
   if(version===this.version){this.busy=false;this.checks['This device']='Subscription not confirmed';this.failed(error,'This device');}
   return;
  }finally{if(version===this.version)this.busy=false;}
  if(version===this.version)await this.refresh();
 }
 async disable(){
  const home=this.home,version=this.version;if(!home||this.busy||!this.supported())return;
  this.busy=true;this.status('Disabling push for this Home…');
  try{const sub=await this.subscription();if(sub)await this.rpc('disable_family_push',{p_home:home,p_endpoint:sub.endpoint});}
  catch(error){if(version===this.version){this.busy=false;this.status('Push request failed. Could not confirm push was disabled. Try again.',false,true,'request_failed');this.onAccessError(error);}return;}
  finally{if(version===this.version)this.busy=false;}
  if(version===this.version)await this.refresh();
 }
 async logout(authenticated=true){
  this.setHome('');if(!this.supported())return;
  try{
   const sub=await this.subscription();
   if(sub){
    const pending=authenticated?this.rpc('remove_my_push_subscription',{p_endpoint:sub.endpoint}).catch(()=>{}):Promise.resolve();
    await sub.unsubscribe();await pending;
   }
   const reg=await this.window.navigator.serviceWorker.getRegistration('/');
   for(const notification of await reg?.getNotifications?.()||[])notification.close();
  }catch{} // Session loss independently clears all private page data.
 }
}
