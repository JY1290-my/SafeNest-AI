// No network or credentials in this module. Runtime injects trusted services.
export const PUSH_BODY = 'SafeNest has a safety alert. Sign in to review.';
export function validPushSubscription(value) {
  try {
    const u=new URL(value.endpoint);
    return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&!u.hash&&u.href.length<=2048&&u.pathname!=='/'&&
      ['fcm.googleapis.com','updates.push.services.mozilla.com','web.push.apple.com'].includes(u.hostname)&&
      /^[A-Za-z0-9_-]{87}$/.test(value.keys?.p256dh||'')&&/^[A-Za-z0-9_-]{22}$/.test(value.keys?.auth||'');
  } catch {return false;}
}
export function notificationPayload(key) {
  if(!/^[a-f0-9]{32}$/.test(key))throw new Error('Invalid delivery key');
  // The opaque per-delivery key is only for duplicate suppression. No IDs,
  // Home/Camera labels, credentials, names or current detection data are sent.
  return JSON.stringify({version:1,key});
}
async function equalSecret(a,b) {
  if(!a||!b)return false;
  const hash=async x=>new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(x)));
  const [x,y]=await Promise.all([hash(a),hash(b)]);let difference=0;
  for(let i=0;i<x.length;i++)difference|=x[i]^y[i];return difference===0;
}
const json=(value,status=200,headers={})=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store',...headers}});
export function createDispatchHandler({secret,publicKey,ready,claim,begin,finish,send}) {
  return async request=>{
    if(request.method!=='POST'||request.headers.has('Origin'))return json({error:'Forbidden'},403);
    if(!await equalSecret(request.headers.get('x-safenest-dispatch-secret'),secret))return json({error:'Unauthorized'},401);
    if(!ready)return json({error:'Push service not configured'},503);
    const counts={processed:0,accepted:0,failed:0,unknown:0};
    try {
      const processJob=async job=>{
        // This second transaction rechecks live membership and preference just
        // before sending; stale, revoked, disabled or mismatched jobs return null.
        const subscription=await begin(job,publicKey);if(!subscription)return;
        let result='failed';
        if(validPushSubscription(subscription)){
          try{
            const response=await send(subscription,notificationPayload(subscription.notification_key));
            result=response.status>=200&&response.status<300?'sent':
              [404,410].includes(response.status)?'gone':response.status===429||response.status>=500?'retry':'failed';
          }catch {result='unknown';} // A timeout might already have been accepted. No blind resend.
        }
        await finish(job,result);counts.processed++;
        if(result==='sent')counts.accepted++;else if(result==='unknown')counts.unknown++;else counts.failed++;
      };
      // Bound work per invocation while allowing several family browsers to be
      // notified promptly. SQL claims/attempt tokens prevent overlapping workers.
      for(let batch=0;batch<5;batch++){
        const jobs=[];
        for(let i=0;i<4;i++){const job=await claim(publicKey);if(!job)break;jobs.push(job);}
        if(!jobs.length)break;
        const settled=await Promise.allSettled(jobs.map(processJob));
        if(settled.some(result=>result.status==='rejected'))throw new Error('Queue update unavailable');
      }
      // Accepted by a push provider is NOT proof of delivery or a family response.
      return json(counts);
    }catch {return json({error:'Push processing unavailable'},503);}
  };
}
export function createPushConfigHandler({origins,ready,publicKey,verify,authorize}) {
  return async request=>{
    const origin=request.headers.get('Origin'),allowed=origins.includes(origin);
    const cors=allowed?{'Access-Control-Allow-Origin':origin,'Vary':'Origin','Access-Control-Allow-Headers':'authorization,apikey,content-type','Access-Control-Allow-Methods':'POST,OPTIONS'}:{};
    if(!allowed)return json({error:'Forbidden'},403);
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
    if(request.method!=='POST')return json({error:'Method not allowed'},405,cors);
    const token=/^Bearer ([^\s]+)$/i.exec(request.headers.get('Authorization')||'')?.[1];
    if(!token)return json({error:'Sign in required'},401,cors);
    try{
      await verify(token);
      const text=await request.text();if(text.length>4096)return json({error:'Invalid request'},400,cors);
      const body=JSON.parse(text);
      if(!/^[a-f0-9-]{36}$/i.test(body.home_id||''))return json({error:'Invalid request'},400,cors);
      await authorize(token,body.home_id);
      // This verifies signing configuration + this caller's database access.
      // It does NOT probe/call a dispatcher or claim that Cron/phone delivery works.
      return json({configured:ready,public_key:ready?publicKey:null,
        checks:{membership:'authorized',subscription_schema:'available',signing:ready?'configured':'missing',background_sending:'not_verified',phone_delivery:'not_verified'}},200,cors);
    }catch(error){return json({error:'Notification configuration unavailable',
      ...(error?.code==='push_schema_missing'?{code:'push_schema_missing'}:{})},error?.status===401?401:error?.status===403?403:503,cors);}
  };
}
export function createWebPushSender({webpush,publicKey,privateKey,subject,fetcher=fetch}){
 return async(subscription,payload)=>{
  if(!validPushSubscription(subscription))throw new Error('Unsupported push endpoint');
  const details=webpush.generateRequestDetails(subscription,payload,{TTL:60,urgency:'high',contentEncoding:'aes128gcm',vapidDetails:{subject,publicKey,privateKey}});
  return fetcher(details.endpoint,{method:'POST',headers:details.headers,body:details.body,redirect:'error',signal:AbortSignal.timeout(5000)});
 };
}
