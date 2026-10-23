/* Push only. No fetch handler, offline page cache, Auth session or media store. */
'use strict';
const validKey=key=>typeof key==='string'&&/^[a-f0-9]{32}$/.test(key);
function claimNotification(key){
 return new Promise((resolve,reject)=>{
  const request=indexedDB.open('safenest-push-dedup',1);
  request.onupgradeneeded=()=>request.result.createObjectStore('seen',{keyPath:'key'});
  request.onerror=()=>reject(new Error('Push dedup unavailable'));
  request.onsuccess=()=>{
   const db=request.result,tx=db.transaction('seen','readwrite'),store=tx.objectStore('seen');let fresh=false;
   const get=store.get(key);get.onsuccess=()=>{if(!get.result){fresh=true;store.put({key,time:Date.now()});}};
   // Bounded metadata: no identities, content, credentials or subscription endpoints.
   const cursor=store.openCursor();let count=0;
   cursor.onsuccess=()=>{const c=cursor.result;if(!c)return;if(c.value.time<Date.now()-86400000||++count>300)c.delete();c.continue();};
   tx.oncomplete=()=>{db.close();resolve(fresh);};tx.onerror=()=>{db.close();reject(new Error('Push dedup unavailable'));};
  };
 });
}
self.addEventListener('push',event=>{
 event.waitUntil((async()=>{
  let data;try{data=event.data.json();}catch{return;}
  if(data?.version!==1||!validKey(data.key))return;
  // On a storage failure the browser's stable notification tag still coalesces
  // duplicates. No claim of guaranteed delivery or exactly-once display is made.
  if(!await claimNotification(data.key).catch(()=>true))return;
  await self.registration.showNotification('SafeNest safety alert',{
   body:'SafeNest has a safety alert. Sign in to review.',icon:'/icon.svg',
   tag:'safenest-'+data.key,renotify:false,data:{key:data.key}
  });
 })());
});
self.addEventListener('notificationclick',event=>{
 event.notification.close();
 event.waitUntil((async()=>{
  const key=event.notification.data?.key;
  const path=validKey(key)?'/?safety-alert='+key:'/';
  const target=new URL(path,self.location.origin).href;
  const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
  const existing=windows.find(client=>new URL(client.url).origin===self.location.origin);
  if(existing){await existing.navigate(target);await existing.focus();}else await self.clients.openWindow(target);
 })());
});
