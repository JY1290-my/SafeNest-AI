import {ModalSurface} from './ui-overlays.js';
import {displayName} from './family-view.js';

// UI capability flags are hints only. Every RPC independently checks device managers.
export class FamilyManagement {
  constructor({window,document,rpc,onAccessError}) {
    Object.assign(this,{window,document,rpc,onAccessError});
    this.$=id=>document.getElementById(id);this.version=0;this.device='';this.allowed=false;this.busy=false;
    this.modal=new ModalSurface({window,document,panel:this.$('management-panel'),opener:this.$('manage-family'),onClose:()=>this.close()});
    this.$('create-camera-code').addEventListener('click',()=>this.createCameraCode());
    this.$('hide-camera-code').addEventListener('click',()=>this.clearCameraCode());
    this.$('manage-family').addEventListener('click',()=>this.open());
    this.$('close-management').addEventListener('click',()=>this.close());
    this.$('refresh-management').addEventListener('click',()=>this.refresh());
    this.$('create-invite-form').addEventListener('submit',event=>{event.preventDefault();this.create();});
    this.$('dismiss-created-code').addEventListener('click',()=>this.clearCode());
    this.$('copy-created-code').addEventListener('click',()=>this.copyCode());
    this.$('cancel-family-action').addEventListener('click',()=>this.cancel());
    this.$('confirm-family-action').addEventListener('click',()=>this.confirm());
  }
  setDevice(device,name,allowed,multi=false) {
    if(device!==this.device||allowed!==this.allowed)this.close();
    this.device=device;this.allowed=allowed===true&&!!device;this.multi=multi;
    this.$('camera-management').hidden=!multi;
    this.$('management-home').textContent=name||'Selected home';
    this.$('manage-family').hidden=!this.allowed;
  }
  clearCameraCode(){
    this.window.clearTimeout(this.codeTimer);this.codeTimer=null;
    this.$('camera-setup-code').value='';this.$('camera-code-panel').hidden=true;
  }
  clearCode() {
    this.clearCameraCode();
    this.$('created-invite-code').value='';this.$('created-code-panel').hidden=true;
    this.$('created-code-message').textContent='';
  }
  close() {
    this.version++;this.busy=false;this.pending=null;this.clearCode();
    this.modal.close();this.$('family-action-confirm').hidden=true;
    this.$('managed-members').replaceChildren();this.$('managed-invites').replaceChildren();
    this.$('managed-cameras').replaceChildren();this.$('camera-setup-codes').replaceChildren();this.$('camera-management-message').textContent='';
    this.$('management-message').textContent='';this.$('create-invite-message').textContent='';
    this.controls(false);
  }
  controls(busy) {
    this.busy=busy;
    for(const id of ['create-camera-code','create-family-invite','refresh-management','confirm-family-action','cancel-family-action'])this.$(id).disabled=busy;
    for(const button of this.$('management-panel').querySelectorAll('[data-family-action]'))button.disabled=busy;
  }
  async open() {
    if(!this.allowed||!this.device)return;
    this.close();this.modal.open();await this.refresh();
  }
  current(version) {return version===this.version&&this.allowed&&!this.$('management-panel').hidden;}
  error(error,message,version) {
    if(!this.current(version))return;
    this.clearCode();this.cancel();this.$('managed-members').replaceChildren();this.$('managed-invites').replaceChildren();
    this.$('management-message').textContent=message;
    if([401,403].includes(error.status)||error.code==='42501') {
      this.close();this.allowed=false;this.$('manage-family').hidden=true;this.onAccessError(error);
    }
  }
  async refresh() {
    if(!this.allowed||this.busy||this.$('management-panel').hidden)return;
    const version=this.version,device=this.device;this.controls(true);
    this.$('management-message').textContent='Loading family access…';
    try {
      const data=await this.rpc('list_family_access',{p_device:device});
      if(!this.current(version))return;
      if(!Array.isArray(data.members)||!Array.isArray(data.invitations))throw new Error('Invalid response');
      if(this.multi){
        const [codes,cameras]=await Promise.all([this.rpc('list_camera_setup_codes',{p_home:device}),this.rpc('read_home_cameras',{p_home:device})]);
        if(!this.current(version))return;data.camera_codes=codes;data.cameras=cameras;
      }
      this.render(data);this.$('management-message').textContent=`${data.members.length} authorized member(s). Showing active invitations and recent history (up to 50).`;
    }catch(error){this.error(error,'Could not load family access. Refresh to try again.',version);}
    finally{if(this.current(version))this.controls(false);}
  }
  render(data) {
    const row=(title,detail,action)=>{
      const li=this.document.createElement('li'),text=this.document.createElement('div'),name=this.document.createElement('strong'),small=this.document.createElement('p');
      name.textContent=title;small.textContent=detail;text.append(name,small);li.append(text);
      if(action){const button=this.document.createElement('button');button.type='button';button.className='secondary compact';
        button.textContent=action.label;button.dataset.familyAction=action.kind;button.addEventListener('click',()=>this.prepare(action));li.append(button);}
      return li;
    };
    const date=value=>Number.isFinite(Date.parse(value))?new Date(value).toLocaleString():'Unknown date';
    this.$('managed-members').replaceChildren(...data.members.map(member=>row(
      displayName(member.name)+(member.is_self?' (you)':''),member.role==='manager'?'Device manager · role changes require the project operator':'Family member',
      member.role==='family'&&!member.is_self?{kind:'member',id:member.member_id,name:displayName(member.name),label:'Remove access'}:null)));
    this.$('managed-invites').replaceChildren(...data.invitations.map(invite=>row(
      `${({active:'Active',expired:'Expired',used_up:'Used up',revoked:'Revoked'})[invite.status]||'Unavailable'} · ${invite.uses}/${invite.max_uses} new members`,
      `Created ${date(invite.created_at)} by ${displayName(invite.created_by)} · Expires ${date(invite.expires_at)}`,
      invite.status==='active'?{kind:'invite',id:invite.invite_id,name:'this invitation',label:'Revoke invitation'}:null)));
    if(this.multi){
      this.$('camera-setup-codes').replaceChildren(...data.camera_codes.map(code=>row(code.used?'Used':!code.enabled?'Revoked':Date.parse(code.expires_at)<=Date.now()?'Expired':'Active',`Expires ${date(code.expires_at)}`,code.enabled&&!code.used?{kind:'camera-code',id:code.id,name:'this setup code',label:'Revoke setup code'}:null)));
      this.$('managed-cameras').replaceChildren(...data.cameras.map(camera=>row(camera.name,camera.enabled?'Expected online':'Disabled',{kind:'camera',id:camera.camera_id,enabled:!camera.enabled,name:camera.name,label:camera.enabled?'Disable expectation':'Enable expectation'})));
    }
    if(!data.invitations.length)this.$('managed-invites').append(row('No invitations yet','Create an invitation to add a family member.'));
  }
  async createCameraCode(){
    if(!this.allowed||!this.multi||this.busy||this.$('management-panel').hidden)return;
    const version=this.version,home=this.device;this.clearCameraCode();this.controls(true);
    try{
      const result=await this.rpc('create_camera_setup_code',{p_home:home});
      if(!this.current(version))return;
      if(!result.ok){this.$('camera-management-message').textContent=result.error==='rate_limited'?'Too many requests. Wait one minute.':'Too many active setup codes. Revoke an unused code first.';return;}
      if(!/^sn-camera-[0-9a-f]{32}$/.test(result.setup_code))throw new Error('Invalid response');
      this.$('camera-setup-code').value=result.setup_code;this.$('camera-code-panel').hidden=false;
      this.codeTimer=this.window.setTimeout(()=>this.clearCameraCode(),Math.min(600000,Math.max(0,Date.parse(result.expires_at)-Date.now())));
      this.$('camera-management-message').textContent='Copy the code now. Enter it only on the additional monitoring computer. Family members will see its cameras automatically after registration.';
      this.controls(false);await this.refresh();
    }catch(error){this.error(error,'Could not confirm camera setup code creation. Refresh before retrying.',version);}
    finally{if(this.current(version))this.controls(false);}
  }
  async create() {
    if(!this.allowed||this.busy||this.$('management-panel').hidden)return;
    const hours=Number(this.$('invite-hours').value),uses=Number(this.$('invite-uses').value);
    if(!Number.isInteger(hours)||hours<1||hours>720||!Number.isInteger(uses)||uses<1||uses>100) {
      this.$('create-invite-message').textContent='Use 1–720 hours and 1–100 new family members.';return;
    }
    const version=this.version,device=this.device;this.clearCode();this.cancel();this.controls(true);
    this.$('create-invite-message').textContent='Creating invitation…';
    try {
      const result=await this.rpc('create_family_invite',{p_device:device,p_hours:hours,p_max_uses:uses});
      if(!this.current(version))return;
      if(!result.ok){this.$('create-invite-message').textContent=result.error==='rate_limited'?'Up to 5 invitations per minute. Please wait.':result.error==='too_many_invites'?'This home has 20 active invitations. Revoke an unused one first.':'Invitation settings were rejected.';return;}
      if(!/^[0-9a-f]{32}$/.test(result.invitation_code))throw new Error('Invalid response');
      this.$('created-invite-code').value=result.invitation_code;this.$('created-code-panel').hidden=false;
      this.$('create-invite-message').textContent='Invitation created. Copy it now and share privately; it cannot be retrieved later.';
      this.controls(false);await this.refresh();
    }catch(error){this.error(error,'Creation could not be confirmed. Refresh invitations; revoke any unwanted new entry before creating another code.',version);}
    finally{if(this.current(version))this.controls(false);}
  }
  async copyCode() {
    const value=this.$('created-invite-code').value,version=this.version;
    if(!value||!this.current(version))return;
    try {
      if(!this.window.navigator.clipboard?.writeText)throw new Error('Clipboard unavailable');
      await this.window.navigator.clipboard.writeText(value);
      if(this.current(version))this.$('created-code-message').textContent='Copied. Share only with the intended family members.';
    }catch {
      if(!this.current(version))return;
      this.$('created-invite-code').focus();this.$('created-invite-code').select();
      this.$('created-code-message').textContent='Select and copy the code manually; clipboard access is unavailable.';
    }
  }
  prepare(action) {
    if(!this.allowed||this.busy)return;
    this.pending=action;this.$('family-action-confirm').hidden=false;
    this.$('family-action-description').textContent=action.kind==='member'
      ? `Remove access for ${action.name}? This also revokes ALL outstanding invitations for this home, so an old code cannot restore access. Existing notes and events are kept. Create new invitations if needed.`
      : action.kind==='camera'?`${action.enabled?'Enable':'Disable'} expected monitoring for ${action.name}? Video access follows this setting. Local AI monitoring is controlled on the monitoring computer.`
      : action.kind==='camera-code'?'Revoke this camera setup code? It will no longer connect another computer.': 'Revoke this invitation? It will no longer add members. People already linked keep their access.';
    this.$('confirm-family-action').focus();
  }
  cancel() {this.pending=null;this.$('family-action-confirm').hidden=true;this.$('family-action-description').textContent='';}
  async confirm() {
    if(!this.allowed||this.busy||!this.pending)return;
    const action=this.pending,version=this.version,device=this.device;this.controls(true);this.clearCode();
    try {
      const result=await this.rpc(action.kind==='camera'?'set_home_camera_enabled':action.kind==='camera-code'?'revoke_camera_setup_code':action.kind==='member'?'revoke_family_member':'revoke_family_invite',
        action.kind==='camera'?{p_home:device,p_camera:action.id,p_enabled:action.enabled}:action.kind==='camera-code'?{p_home:device,p_code:action.id}:{p_device:device,...(action.kind==='member'?{p_member:action.id}:{p_invite:action.id})});
      if(!this.current(version))return;
      this.cancel();this.controls(false);
      if(!result.ok){this.$('management-message').textContent='This manager cannot be removed here. Ask the project operator.';return;}
      await this.refresh();
    }catch(error){this.error(error,'Removal could not be confirmed. Refresh the list before trying again.',version);}
    finally{if(this.current(version))this.controls(false);}
  }
}
