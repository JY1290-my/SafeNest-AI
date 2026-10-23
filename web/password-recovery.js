// Recovery credentials are isolated from normal sign-in and kept only in memory.
const GENERIC = 'If an account exists for this email, you’ll receive a reset link.';
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const failure = code => Object.assign(new Error('Password recovery unavailable'), {recoveryCode:code});
export function recoveryLink(location) {
  const query = new URLSearchParams(location.search), hash = new URLSearchParams(location.hash.slice(1));
  if (query.get('recovery') !== '1' && query.get('type') !== 'recovery' && hash.get('type') !== 'recovery' && !query.has('token_hash') && !hash.has('token_hash')) return null;
  const tokenHash = hash.get('token_hash') || query.get('token_hash'), accessToken = hash.get('access_token');
  const type = hash.get('type') || query.get('type');
  const duplicate = ['token_hash','type','code','error','error_code','recovery','access_token'].some(key => query.getAll(key).length > 1 || hash.getAll(key).length > 1);
  const mixed = (query.has('token_hash') && hash.has('token_hash')) || (tokenHash && accessToken) ||
    (query.has('type') && hash.has('type') && query.get('type') !== hash.get('type'));
  let problem = duplicate || mixed || (tokenHash && type !== 'recovery') ? 'invalid_link' : null;
  if (query.has('code') || hash.has('code')) problem = 'unsupported_pkce';
  if (query.has('error') || hash.has('error') || query.has('error_code') || hash.has('error_code')) {
    const code = query.get('error_code') || hash.get('error_code');
    problem = code === 'otp_expired' ? 'expired_link' : 'invalid_link';
  }
  if (!tokenHash && !accessToken && !problem) problem = 'missing_credential';
  return {tokenHash,accessToken,type,invalid:!!problem,problem};
}
export class RecoverySession {
  constructor({request,supabaseUrl,now=()=>Date.now()}) {Object.assign(this,{request,supabaseUrl,now});this.version=0;this.clear();}
  clear(){this.version++;this.access=null;this.user=null;this.until=0;}
  async send(email,redirect) {
    const destination=new URL(redirect);
    if(destination.protocol!=='https:' && !(destination.protocol==='http:' && ['localhost','127.0.0.1'].includes(destination.hostname)))throw failure('invalid_origin');
    try {await this.request('/auth/v1/recover?redirect_to='+encodeURIComponent(redirect),{email});}
    catch(error){if(!['user_not_found','email_not_found'].includes(error.code))throw error;}
    return GENERIC;
  }
  async verify(link) {
    this.clear();const version=this.version;
    if(!link || link.invalid)throw failure(link?.problem || 'invalid_link');
    if(!link.tokenHash&&link.type!=='recovery')throw failure('invalid_link');
    let access=link.accessToken,expected=null,fromTokenHash=false;
    try {
      if(link.tokenHash){
        if(!/^[a-zA-Z0-9_-]{20,256}$/.test(link.tokenHash))throw failure('invalid_link');
        // This Auth operation verifies the one-use email credential AS recovery.
        // No client-supplied account ID/email or old CloudClient session is used.
        const value=await this.request('/auth/v1/verify',{token_hash:link.tokenHash,type:'recovery'});
        access=value.access_token;expected=value.user?.id;fromTokenHash=true;
        if(version!==this.version)throw failure('cancelled');
        if(!uuid(expected))throw failure('invalid_link');
      }
      if(typeof access!=='string'||!access||access.length>16384)throw failure('missing_credential');
      const user=await this.request('/auth/v1/user',undefined,access,'GET');
      if(version!==this.version)throw failure('cancelled');
      // Only inspect claims AFTER the exact bearer was validated by Auth.
      let claims;
      try{const segment=access.split('.')[1];claims=JSON.parse(atob(segment.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-segment.length%4)%4)));}catch{throw failure('invalid_link');}
      if(!uuid(user.id)||claims.sub!==user.id||(expected&&user.id!==expected)||claims.iss!==this.supabaseUrl.replace(/\/$/,'')+'/auth/v1'||!Number.isFinite(claims.exp)||claims.exp*1000<=this.now())throw failure('invalid_link');
      if(!fromTokenHash){
        // Match Supabase's supported implicit recovery callback: the callback
        // must explicitly be type=recovery and carry its own access token.
        // Supabase may sign that token with AMR "otp" for the default email
        // template, so the AMR alone cannot distinguish this from magic link.
        // Crucially, the URL token is validated with Auth and is never taken
        // from the normal stored login session. A URL flag by itself is not
        // sufficient to open the password form.
        const methods=Array.isArray(claims.amr)?claims.amr.map(item=>item?.method):[];
        if(!methods.some(method=>method==='recovery'||method==='otp'))throw failure('invalid_link');
      }
      this.access=access;this.user=user.id;this.until=Math.min(claims.exp*1000,this.now()+15*60*1000);
    } catch(error) {
      if(access && (fromTokenHash || version!==this.version))this.request('/auth/v1/logout?scope=local',{},access).catch(()=>{});
      throw error;
    }
  }
  async update(password) {
    const access=this.access,user=this.user,version=this.version;
    if(!access||!user||this.now()>=this.until){this.clear();throw Object.assign(failure('expired_link'),{status:401});}
    const result=await this.request('/auth/v1/user',{password},access,'PUT');
    if(version!==this.version)throw failure('cancelled');
    if(result.id!==user){this.cancel();throw failure('invalid_link');}
    this.clear();
    try{await this.request('/auth/v1/logout?scope=local',{},access);}catch{}
  }
  cancel(){const access=this.access;this.clear();if(access)this.request('/auth/v1/logout?scope=local',{},access).catch(()=>{});}
}
function recoveryMessage(error) {
  const code=error.recoveryCode;
  if(code==='unsupported_pkce')return 'This site has no matching verifier for that PKCE link. If another app requested it, open it in the original browser. Otherwise request a fresh reset link from this website.';
  if(code==='missing_credential')return 'This page did not receive a reset credential. Request a fresh link. If it happens again, ask the site administrator to check the reset email template and return address.';
  if(error.status===429)return 'Too many verification attempts. Please wait before requesting a new reset link.';
  if(code==='expired_link'||error.code==='otp_expired'||[400,401,403,422].includes(error.status)||code==='invalid_link')return 'This reset link is invalid, expired or already used. Request a new reset link.';
  return 'Your reset link could not be verified because the connection or account service is unavailable. Check your connection, then request a fresh link.';
}
export class PasswordRecovery {
  constructor({window,document,request,supabaseUrl,onStart,onBack}) {
    Object.assign(this,{window,document,onStart,onBack});this.$=id=>document.getElementById(id);
    this.client=new RecoverySession({request,supabaseUrl});this.version=0;this.active=false;this.busy=false;this.cooldown=0;
    this.$('forgot-password').addEventListener('click',()=>this.open());
    this.$('recovery-back').addEventListener('click',()=>this.back());
    this.$('recovery-request-new').addEventListener('click',()=>this.open());
    this.$('recovery-send-form').addEventListener('submit',event=>{event.preventDefault();this.send();});
    this.$('recovery-update-form').addEventListener('submit',event=>{event.preventDefault();this.update();});
  }
  state(value,title){
    this.stage=value;this.$('recovery-panel').dataset.recoveryState=value;this.$('recovery-title').textContent=title;
    this.$('recovery-send-form').hidden=value!=='request';
    this.$('recovery-update-form').hidden=value!=='ready';
    this.$('recovery-request-new').hidden=value!=='failed';
  }
  cleanCallback(){if(this.callbackPending){this.callbackPending=false;this.window.history.replaceState(null,'',this.window.location.pathname);}}
  begin(){
    this.cleanCallback();this.version++;this.client.cancel();this.active=true;this.busy=false;this.onStart();
    this.$('recovery-panel').hidden=false;this.$('recovery-message').textContent='';
    for(const id of ['reset-new-password','reset-confirm-password','recovery-email'])this.$(id).value='';
    this.$('send-reset-link').disabled=false;this.$('update-password').disabled=true;
  }
  open(){this.begin();this.state('request','Forgot password?');this.$('recovery-email').focus();}
  failed(error){
    this.client.cancel();this.state('failed','Reset link unavailable');
    this.$('recovery-message').textContent=recoveryMessage(error);this.$('recovery-request-new').focus();
  }
  async startLink(link){
    this.begin();const version=this.version;this.callbackPending=true;this.state('verifying','Checking reset link');
    this.$('recovery-message').textContent='Verifying your reset link…';
    try{
      await this.client.verify(link);if(version!==this.version)return;
      this.state('ready','Reset password');this.$('update-password').disabled=false;
      this.$('recovery-message').textContent='Choose a new password. This reset session lasts up to 15 minutes.';this.$('reset-new-password').focus();
    }catch(error){if(version===this.version)this.failed(error);}
    finally{
      // Process/validate this callback before removing its URL. Cancellation also
      // removes it. Credentials never enter browser storage, logs or normal Auth.
      if(version===this.version)this.cleanCallback();
      link=null;
    }
  }
  async send(){
    if(!this.active||this.busy||this.stage!=='request')return;
    if(Date.now()<this.cooldown){this.$('recovery-message').textContent='Please wait one minute before requesting another link.';return;}
    const email=this.$('recovery-email').value.trim();if(!this.$('recovery-email').checkValidity()||!email)return;
    this.busy=true;this.$('send-reset-link').disabled=true;const version=this.version;
    try{
      const redirect=this.window.location.origin+this.window.location.pathname+'?recovery=1';
      const message=await this.client.send(email,redirect);if(version!==this.version)return;
      this.cooldown=Date.now()+60000;this.$('recovery-message').textContent=message;
    }catch(error){if(version===this.version)this.$('recovery-message').textContent=error.status===429||error.code==='over_email_send_rate_limit'?'Too many reset requests. Please wait before trying again.':'The reset email could not be requested. Check your connection and try again later.';}
    finally{if(version===this.version){this.busy=false;this.$('send-reset-link').disabled=false;}}
  }
  async update(){
    if(!this.active||this.busy||this.stage!=='ready')return;
    const password=this.$('reset-new-password').value,confirmation=this.$('reset-confirm-password').value;
    if(password!==confirmation){this.$('recovery-message').textContent='Passwords do not match.';return;}
    if(password.length<8){this.$('recovery-message').textContent='Use at least 8 characters and follow the account password policy.';return;}
    this.busy=true;this.$('update-password').disabled=true;const version=this.version;
    try{
      await this.client.update(password);if(version!==this.version)return;
      this.state('complete','Password updated');this.$('recovery-message').textContent='Password updated. Return to sign in with your new password.';
    }catch(error){
      if(version!==this.version)return;
      if([401,403].includes(error.status)||error.recoveryCode)this.failed(error);
      else this.$('recovery-message').textContent=error.code==='weak_password'||error.code==='same_password'?'Choose a different password that meets your account password policy.':'Password update could not be confirmed. Try signing in, or request a new reset link.';
    }finally{if(version===this.version){this.busy=false;this.$('update-password').disabled=this.stage!=='ready';this.$('reset-new-password').value='';this.$('reset-confirm-password').value='';}}
  }
  back(){this.dispose();this.onBack();}
  dispose(){this.cleanCallback();this.version++;this.client.cancel();this.active=false;this.busy=false;this.stage='closed';this.$('recovery-panel').hidden=true;for(const id of ['reset-new-password','reset-confirm-password','recovery-email'])this.$(id).value='';}
}
