// Pure handler with injected services: testable without Supabase/LiveKit accounts.
export class HttpError extends Error {
  constructor(status,message) {super(message);this.status=status;}
}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const roomName = device => `safenest-${device.toLowerCase()}`;
export const deviceIdentity = device => `device-${device.toLowerCase()}`;
export function createHandler(kind,services,allowedOrigins) {
  const origins=new Set(allowedOrigins);
  // Best-effort per-isolate ingress limit; authenticated DB counters are authoritative.
  const ingress=new Map();
  return async request => {
    const origin=request.headers.get('origin');
    const allowed=origin && origins.has(origin);
    const headers={'Content-Type':'application/json','Cache-Control':'no-store','Vary':'Origin','X-Content-Type-Options':'nosniff'};
    if(allowed)Object.assign(headers,{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'authorization,apikey,content-type','Access-Control-Allow-Methods':'POST, OPTIONS'});
    const respond=(status,body)=>new Response(JSON.stringify(body),{status,headers});
    if((origin && !allowed)||(kind==='viewer'&&!allowed))return respond(403,{error:'Origin not allowed'});
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
    if(request.method!=='POST')return respond(405,{error:'POST required'});
    try {
      const ip=request.headers.get('x-forwarded-for')?.split(',')[0]||'unknown';
      const now=Date.now(),prior=ingress.get(ip),entry=prior&&now-prior.at<60000?prior:{at:now,count:0};
      entry.count++;ingress.set(ip,entry);
      if(ingress.size>2000)ingress.clear();
      if(entry.count>180)throw new HttpError(429,'Too many requests');
      // Check both declared and actual size. Never log request bodies or tokens.
      if(Number(request.headers.get('content-length')||0)>4096)throw new HttpError(413,'Request too large');
      const text=await request.text();if(new TextEncoder().encode(text).length>4096)throw new HttpError(413,'Request too large');
      let body;try{body=JSON.parse(text);}catch{throw new HttpError(400,'Invalid JSON');}
      if(!body||typeof body!=='object'||Array.isArray(body)||typeof body.device_id!=='string'||!UUID.test(body.device_id))throw new HttpError(400,'Valid device_id required');
      if('room' in body || 'identity' in body || 'grants' in body)throw new HttpError(400,'Room and permissions are server-controlled');
      if(body.camera_id!==undefined&&!UUID.test(body.camera_id))throw new HttpError(400,'Valid camera_id required');
      const camera=body.camera_id?.toLowerCase(),device=body.device_id.toLowerCase(),room=camera?`safenest-camera-${camera}`:roomName(device),publisher=camera?`camera-${camera}`:deviceIdentity(device),action=body.action||'issue';
      if(kind==='viewer') {
        if(!['issue','renew','release'].includes(action))throw new HttpError(400,'Invalid action');
        const auth=request.headers.get('authorization');
        if(!auth?.startsWith('Bearer '))throw new HttpError(401,'Sign in required');
        const jwt=auth.slice(7);const user=await services.verifyUser(jwt);
        if(!user?.id)throw new HttpError(401,'Invalid session');
        if(action!=='release')await services.readMonitor(jwt,device,camera); // Same authorization as status reads.
        if(action!=='issue'&&(!UUID.test(body.session_id||'')))throw new HttpError(400,'Valid session_id required');
        const lease=await services.viewerSession(jwt,device,action,body.session_id||null,camera);
        if(action==='release') {
          if(lease.identity)await services.removeParticipant(room,lease.identity);
          return respond(200,{ok:true});
        }
        if(action==='renew')return respond(200,{lease_seconds:lease.lease_seconds});
        try {
          const token=await services.signToken({identity:lease.identity,ttl:60,grants:{roomJoin:true,room,canSubscribe:true,canPublish:false,canPublishData:false,canUpdateOwnMetadata:false}});
          return respond(200,{token,server_url:services.serverUrl,room,identity:lease.identity,publisher_identity:publisher,session_id:lease.session_id,lease_seconds:lease.lease_seconds});
        }catch(e){await services.viewerSession(jwt,device,'release',lease.session_id,camera);throw e;}
      }
      if(!['issue','sync'].includes(action))throw new HttpError(400,'Invalid action');
      if(typeof body.device_token!=='string'||body.device_token.length<32||body.device_token.length>256)throw new HttpError(401,'Device credentials required');
      const allowed=await services.deviceSession(device,body.device_token,action,camera);
      if(action==='sync') {
        // Server-side kicking + laptop track allowlist enforce expiry/revocation.
        const participants=await services.listParticipants(room);
        const keep=new Set([publisher,...allowed.viewers]);
        for(const participant of participants)if(!keep.has(participant.identity))await services.removeParticipant(room,participant.identity);
        return respond(200,allowed);
      }
      const token=await services.signToken({identity:publisher,ttl:60,grants:{roomJoin:true,room,canPublish:true,canPublishSources:['camera'],canSubscribe:false,canPublishData:false,canUpdateOwnMetadata:false}});
      return respond(200,{token,server_url:services.serverUrl,room,identity:publisher});
    }catch(error){
      if(error instanceof HttpError)return respond(error.status,{error:error.message});
      return respond(503,{error:'Video service unavailable'});
    }
  };
}
