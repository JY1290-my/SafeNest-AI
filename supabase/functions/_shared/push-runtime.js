import {createClient} from 'npm:@supabase/supabase-js@2.117.3';
import webpush from 'npm:web-push@3.6.7';
import {createDispatchHandler,createPushConfigHandler,createWebPushSender} from './push-core.js';
const env=name=>Deno.env.get(name)||'';
const url=env('SUPABASE_URL'),anon=env('SAFENEST_SUPABASE_PUBLISHABLE_KEY')||env('SUPABASE_ANON_KEY');
const publicKey=env('SAFENEST_VAPID_PUBLIC_KEY'),privateKey=env('SAFENEST_VAPID_PRIVATE_KEY');
const subject=env('SAFENEST_VAPID_SUBJECT'),secret=env('SAFENEST_PUSH_DISPATCH_SECRET');
const timedFetch=(input,init={})=>fetch(input,{...init,signal:AbortSignal.timeout(5000),redirect:'error'});
const client=(key,jwt)=>createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:timedFetch,headers:jwt?{Authorization:'Bearer '+jwt}:{}}});
let origins=[];try{origins=JSON.parse(env('SAFENEST_ALLOWED_ORIGINS')||'[]');if(!Array.isArray(origins)||origins.some(x=>new URL(x).origin!==x||!x.startsWith('https://')))origins=[];}catch{origins=[];}
let ready=Boolean(url&&anon&&/^[\w-]{87}$/.test(publicKey)&&/^[\w-]{43}$/.test(privateKey)&&secret.length>=32&&origins.length);
try{const u=new URL(subject);ready=ready&&u.protocol==='https:'&&!u.username&&!u.password;}catch{ready=false;}
const rpc=async(db,name,body)=>{const {data,error}=await db.rpc(name,body);if(error)throw Object.assign(new Error('Database unavailable'),{
 status:error.code==='42501'?403:503,...(['PGRST202','PGRST205','42883','42P01'].includes(error.code)?{code:'push_schema_missing'}:{})});return data;};
export function makePushConfigHandler(){
 return createPushConfigHandler({origins,ready,publicKey,
  verify:async jwt=>{const {data,error}=await client(anon).auth.getUser(jwt);if(error||!data.user)throw {status:401};},
  authorize:(jwt,home)=>rpc(client(anon,jwt),'family_push_status',{p_home:home})});
}
export function makePushDispatchHandler(){
 const serviceKey=env('SUPABASE_SERVICE_ROLE_KEY');
 // This service client stays inside the secret-protected function. Browser and
 // normal authenticated roles have NO permission to call the queue RPCs.
 const db=serviceKey?client(serviceKey):null;
 return createDispatchHandler({secret,publicKey,ready:ready&&Boolean(db),
  claim:key=>rpc(db,'claim_fall_push',{p_application_key:key}),
  begin:(job,key)=>rpc(db,'begin_fall_push',{p_job:job.id,p_claim:job.claim,p_application_key:key}),
  finish:(job,result)=>rpc(db,'finish_fall_push',{p_job:job.id,p_claim:job.claim,p_result:result}),
  send:createWebPushSender({webpush,publicKey,privateKey,subject})
 });
}
