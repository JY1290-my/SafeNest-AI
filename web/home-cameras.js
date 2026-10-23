import {currentStatus} from './logic.js';
// UI-only Home summary; never fed back into AI state or local alarms.
export function homeStatus(cameras,elapsed=0,failed=false){
  const expected=cameras.filter(c=>c.enabled===true);
  if(failed||!expected.length)return {status:'Monitoring unavailable',tone:'offline',description:failed?'Could not refresh this Home’s cameras.':'No active cameras configured.'};
  const states=expected.map(c=>currentStatus(c,elapsed,false));
  if(states.some(s=>s.status==='Suspected Fall'))return {status:'Suspected Fall',tone:'danger',description:'At least one camera reports a suspected fall. Check the situation.'};
  if(states.some(s=>!s.connected))return {status:'Monitoring unavailable',tone:'offline',description:'At least one expected camera is offline, stale or unavailable. Overall normal status cannot be confirmed.'};
  if(states.every(s=>s.status==='Normal'))return {status:'Normal',tone:'normal',description:'All expected cameras currently report Normal. This does not confirm safety outside their view.'};
  if(states.every(s=>s.status==='No Person'))return {status:'No Person',tone:'warning',description:'All working cameras currently report no person in view.'};
  for(const status of ['Checking','Check Person','Tracking Lost','Pose Unclear','Resting in Bed'])if(states.some(s=>s.status===status))return {status,tone:'warning',description:'At least one camera needs attention or cannot assess the person’s condition.'};
  return {status:'Status uncertain',tone:'warning',description:'Camera observations differ. Check the individual camera states.'};
}
export function renderCameraCards({document,list,cameras,selected,elapsed=0,onSelect}){
  const focused=document.activeElement?.dataset?.cameraId;
  list.replaceChildren(...cameras.map(camera=>{
    const li=document.createElement('li'),name=document.createElement('strong'),state=document.createElement('p'),button=document.createElement('button');
    name.textContent=String(camera.name||'Camera');state.textContent=camera.enabled===true?currentStatus(camera,elapsed).status:'Disabled';
    button.type='button';button.className='secondary compact';button.textContent=camera.camera_id===selected?'Selected camera':'Select camera';
    button.dataset.cameraId=camera.camera_id;
    button.setAttribute('aria-pressed',String(camera.camera_id===selected));button.disabled=camera.enabled!==true;
    button.addEventListener('click',()=>onSelect(camera.camera_id));li.append(name,state,button);return li;
  }));
  if(focused)[...list.querySelectorAll('button')].find(b=>b.dataset.cameraId===focused)?.focus();
}
