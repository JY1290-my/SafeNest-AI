import {currentStatus} from './logic.js';
import {displayName} from './family-view.js';

const fallEvent = event => /^(?:Person [1-9][0-9]*: )?Suspected Fall$/.test(String(event?.status || ''));
export function alertTime(value) {
  const time = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}[T ]/.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? new Date(time).toLocaleString() : 'Time unavailable';
}

// Current Camera observations only. Historical events never create a live alert
// or provide an identity for the people in the current frame.
export function currentFallAlerts(cameras, elapsed = 0, failed = false) {
  if (failed) return [];
  return cameras.filter(camera => camera.enabled === true && !camera.payload?.demo &&
    currentStatus(camera, elapsed).status === 'Suspected Fall').map(camera => {
    const payload = camera.payload;
    const people = [...new Set((Array.isArray(payload.context?.people) ? payload.context.people : [])
      .filter(person => person?.state === 'POSSIBLE_FALL' && Number.isSafeInteger(person.person_number) && person.person_number > 0)
      .map(person => person.person_number))].sort((a,b) => a-b);
    const event = (Array.isArray(payload.events) ? payload.events : []).filter(fallEvent)
      .filter(event => Number.isFinite(Date.parse(event.time)))
      .slice().sort((a,b) => Date.parse(b.time)-Date.parse(a.time))[0];
    return {key:camera.camera_id, name:String(camera.name || payload.camera_name || 'Current camera'),
      observed:payload.observed_at, eventTime:event?.time, people,
      // Heartbeats do not reset acknowledgement; new event/person evidence does.
      evidence:JSON.stringify([event?.id || '',event?.time || '',event?.status || '',people])};
  });
}

// Current observations stay separate from persistent server alert/view records.
export class FallAlert {
  constructor({document,onView,onAcknowledge}) {
    this.document=document;this.onView=onView;this.onAcknowledge=onAcknowledge;this.$=id=>document.getElementById(id);
    this.rows=new Map();this.announcement='';
  }
  update({homeLabel,cameras,elapsed=0,failed=false,selected='',viewing=false,canView=false,sharedAlerts=[],sharedLoaded=false,acknowledging=new Set()}) {
    const alerts=currentFallAlerts(cameras,elapsed,failed);
    this.$('fall-alert').hidden=!alerts.length;
    this.$('fall-alert-home').textContent=alerts.length?homeLabel:'';
    const keys=new Set(alerts.map(alert=>alert.key));
    for(const [key,row] of this.rows)if(!keys.has(key)){row.node.remove();this.rows.delete(key);}
    alerts.forEach((alert,index)=>{
      let row=this.rows.get(alert.key);
      if(!row){row=this.createRow(alert.key);this.rows.set(alert.key,row);}
      row.evidence=alert.evidence;
      row.shared=sharedLoaded?sharedAlerts.find(record=>record.camera_id===alert.key&&record.current===true):null;
      row.saving=!!row.shared&&acknowledging.has(row.shared.id);
      row.name.textContent=alert.name;
      row.observed.textContent=alertTime(alert.observed);
      row.observed.dateTime=Number.isFinite(Date.parse(alert.observed))?alert.observed:'';
      row.event.textContent=alert.eventTime?'Latest recorded suspected-fall event: '+alertTime(alert.eventTime):'No matching event time was provided. See Recent events for recorded history.';
      row.people.textContent=alert.people.length?alert.people.map(number=>'Person '+number).join(', '):'Temporary person label unavailable';
      row.view.disabled=!canView || selected===alert.key&&viewing;
      row.view.textContent=selected===alert.key&&viewing?'Camera view open':canView?'View camera':'Video unavailable';
      row.view.setAttribute('aria-label','View camera: '+alert.name);
      row.view.title=canView?'Open this camera using the existing on-demand video connection.':'Video is not configured or current camera status is unavailable.';
      this.renderAcknowledgement(row);
      const position=this.$('fall-alert-list').children[index];
      if(position!==row.node)this.$('fall-alert-list').insertBefore(row.node,position||null);
    });
    const announcement=JSON.stringify(alerts.map(alert=>[alert.key,alert.evidence]));
    if(announcement!==this.announcement){
      this.announcement=announcement;
      this.$('fall-alert-announcement').textContent=alerts.length?`Suspected fall reported by ${alerts.length} camera(s). Please check the situation. This is not confirmation of injury.`:'';
    }
  }
  createRow(key) {
    const make=(tag,className='')=>{const node=this.document.createElement(tag);node.className=className;return node;};
    const node=make('li'),name=make('h3'),observed=make('time'),people=make('p'),event=make('p','small'),
      actions=make('div','home-actions'),view=make('button','secondary'),ack=make('button','secondary'),message=make('p','small');
    const observation=make('p','small');observation.append('Latest observation: ',observed);
    view.type=ack.type='button';ack.textContent='Acknowledge';
    view.addEventListener('click',()=>{if(this.rows.get(key)===row&&!view.disabled)this.onView(key);});
    ack.addEventListener('click',()=>{
      if(this.rows.get(key)!==row)return;
      if(row.shared&&!ack.disabled)this.onAcknowledge?.(row.shared.id);
    });
    actions.append(view,ack);node.append(name,people,observation,event,actions,message);
    const row={node,name,observed,people,event,view,ack,message,acknowledged:false,evidence:null};
    return row;
  }
  renderAcknowledgement(row) {
    const alert=row.shared;
    row.ack.disabled=!this.onAcknowledge||!alert||alert.viewed_by_me===true||row.saving;
    row.ack.setAttribute('aria-pressed',String(alert?.viewed_by_me===true));
    row.ack.textContent=row.saving?'Saving…':alert?.viewed_by_me?'Acknowledged by you':'Acknowledge';
    row.message.textContent=alert?(Array.isArray(alert.views)&&alert.views.length?
      'Viewed by '+alert.views.map(view=>displayName(view.name)+' · '+alertTime(view.viewed_at)).join('; '):'No family viewing confirmation recorded.'):
      'Shared acknowledgement requires a current server-recorded alert for an authorized cloud Home.';
  }
  clear() {
    this.rows.clear();this.announcement='';this.$('fall-alert').hidden=true;
    this.$('fall-alert-list').replaceChildren();this.$('fall-alert-home').textContent='';this.$('fall-alert-announcement').textContent='';
  }
}
