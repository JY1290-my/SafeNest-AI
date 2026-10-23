import {createClient} from 'npm:@supabase/supabase-js@2.117.3';
import {AccessToken,RoomServiceClient,TrackSource} from 'npm:livekit-server-sdk@2.19.1';
import {createHandler,HttpError} from './video-core.js';

export function makeHandler(kind) {
  const env=name=>Deno.env.get(name)||'';
  const supabaseUrl=env('SUPABASE_URL'),key=env('SAFENEST_SUPABASE_PUBLISHABLE_KEY')||env('SUPABASE_ANON_KEY');
  const serverUrl=env('LIVEKIT_URL').replace(/\/$/,''),apiKey=env('LIVEKIT_API_KEY'),secret=env('LIVEKIT_API_SECRET');
  let origins=[];try{origins=JSON.parse(env('SAFENEST_ALLOWED_ORIGINS')||'[]');}catch{}
  try { if(!Array.isArray(origins)||origins.some(x=>typeof x!=='string'||!x.startsWith('https://')||new URL(x).origin!==x))origins=[]; } catch {origins=[];}
  const ready=Boolean(supabaseUrl&&key&&serverUrl.startsWith('wss://')&&apiKey&&secret&&origins.length);
  const fetchTimed=(input,init={})=>fetch(input,{...init,signal:AbortSignal.timeout(6000)});
  const client=jwt=>createClient(supabaseUrl,key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:fetchTimed,headers:jwt?{Authorization:`Bearer ${jwt}`}:{}}});
  const rpc=async(jwt,name,params)=>{
    const {data,error}=await client(jwt).rpc(name,params);
    if(error){
      if(error.code==='42501')throw new HttpError(403,'Access denied');
      if(error.message?.includes('limit exceeded')||error.message?.includes('Too many'))throw new HttpError(429,'Too many requests');
      throw new HttpError(503,'Video database unavailable');
    }
    return data;
  };
  const rooms=ready?new RoomServiceClient(serverUrl.replace(/^wss:/,'https:'),apiKey,secret,{requestTimeout:3,failover:false}):null;
  const missing=e=>e?.code==='not_found';
  const services={serverUrl,
    verifyUser:async jwt=>{const {data,error}=await client().auth.getUser(jwt);if(error||!data.user)throw new HttpError(401,'Invalid session');return data.user;},
    readMonitor:(jwt,device,camera)=>camera?rpc(jwt,'read_camera',{p_camera:camera,p_device:device}):rpc(jwt,'read_monitor',{p_device:device}),
    viewerSession:(jwt,device,action,session,camera)=>rpc(jwt,camera?'camera_viewer_session':'video_viewer_session',{p_device:device,p_action:action,p_session:session,...(camera?{p_camera:camera}:{})}),
    deviceSession:(device,token,action,camera)=>rpc(null,camera?'camera_device_session':'video_device_session',{p_device:device,p_token:token,p_action:action,...(camera?{p_camera:camera}:{})}),
    signToken:async({identity,ttl,grants})=>{const token=new AccessToken(apiKey,secret,{identity,ttl});token.addGrant({...grants,...(grants.canPublishSources?{canPublishSources:[TrackSource.CAMERA]}:{})});return await token.toJwt();},
    listParticipants:async room=>{try{return await rooms.listParticipants(room);}catch(e){if(missing(e))return [];throw e;}},
    removeParticipant:async(room,identity)=>{try{await rooms.removeParticipant(room,identity);}catch(e){if(!missing(e))throw e;}}
  };
  const handler=createHandler(kind,services,origins);
  return request=>ready?handler(request):new Response(JSON.stringify({error:'Video service not configured'}),{status:503,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
}
