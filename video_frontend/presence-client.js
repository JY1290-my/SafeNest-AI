import {RealtimeClient} from '@supabase/realtime-js';
import {FamilyPresence} from './presence-controller.js';
export function createFamilyPresence({config,token,...options}){
  return new FamilyPresence({...options,createClient:onDisconnect=>new RealtimeClient(
    config.supabaseUrl.replace(/^https:/,'wss:')+'/realtime/v1',{
      params:{apikey:config.publishableKey},accessToken:token,
      heartbeatCallback:status=>{if(status==='timeout'||status==='error'||status==='disconnected')onDisconnect();}
    })});
}
