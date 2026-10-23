import {FamilyAlerts} from './family-alerts.js';
import {homeStatus,renderCameraCards} from './home-cameras.js';
import {PasswordRecovery,recoveryLink} from './password-recovery.js';
import {FamilyManagement} from './family-management.js';
import {currentStatus} from './logic.js';
import {CloudClient} from './cloud-client.js';
import {CameraTools} from './camera-tools.js';
import {CameraWindow} from './camera-window.js';
import {FallAlert} from './fall-alert.js';
import {displayName,recentEvents} from './family-view.js';

export function bootDashboard({window, document, fetch:fetcher, createRemoteCamera, createFamilyPresence}) {
const $ = id => document.getElementById(id);
const fetch = fetcher, config = window.SAFENEST_CONFIG || {};
const local = config.mode === 'local';
let storage = null;
try { storage = window.sessionStorage; } catch {}
const cloud = new CloudClient(config, fetch, () => performance.now(), {storage});
const viewKey = 'safenest:view:' + config.supabaseUrl;
let data = null, receivedMono = 0, failed = true, signedIn = false, pageActive = true;
let viewing = false, frameURL = null, generation = 0, videoGeneration = 0;
let remoteCamera = null, selectedDeviceId = '', selectedName = '', monitors = [];
let presence = null, profileRequest = 0;
let authMode = 'login', authBusy = false, accountGeneration = 0, listRequest = 0, noteRequest = 0;
let inviteRequest = 0, claimRequest = 0;
let noteDeletion = null, noteDeleteBusy = false, noteDeleteRequest = 0;
let pollGeneration = null, selectionRevision = 0;
let recoveryUI = null;
let homeCameras=[], selectedCameraId='', cameraListReceived=0, inventoryFailed=true;
let recoveryCallback = !local ? recoveryLink(window.location) : null;
const recoveryReturn = !!recoveryCallback;
let pendingNotificationKey=new URLSearchParams(window.location.search).get('safety-alert')||'';
if(!/^[a-f0-9]{32}$/.test(pendingNotificationKey))pendingNotificationKey='';
if(pendingNotificationKey&&!recoveryReturn){const url=new URL(window.location.href);url.searchParams.delete('safety-alert');window.history.replaceState(null,'',url.pathname+url.search+url.hash);}
let openingNotification=false;
const remoteEnabled = !local && config.videoEnabled === true && config.livekitUrl?.startsWith('wss://');
const configured = local || (config.supabaseUrl?.startsWith('https://') && config.publishableKey);
const cameraTools = new CameraTools({window,document});
const cameraWindow = new CameraWindow({window,document,onHiddenExit:()=>stopVideo()});
const fallAlert = new FallAlert({document,onView:viewAlertCamera,onAcknowledge:local?null:id=>familyAlerts.acknowledge(id)});
const familyAlerts = new FamilyAlerts({window,document,rpc:(name,body)=>cloud.rpc(name,body),
  configRequest:async home=>cloud.request('/functions/v1/family-push-config',{home_id:home},await cloud.token()),
  onChange:()=>{if(pageActive&&signedIn)renderAlerts();},onAccessError:accessError});
$('alert-notification-settings').addEventListener('click',event=>{event.preventDefault();cameraTools.openPanel('settings-panel','push-title',event.currentTarget);});
const familyManagement = new FamilyManagement({window,document,rpc:(name,body)=>cloud.rpc(name,body),
  onAccessError:error=>{if(error.status===401)accessError(error);else loadMonitors();}});
$('email-label').hidden = local; $('email').required = !local;
$('signup-tab').hidden = local; $('login-tab').hidden = local;
$('choose-home').hidden = local; $('forgot-password').hidden = local; $('forgot-password').disabled = !configured;
if (local) {
  $('access-mode').textContent = 'LOCAL MONITOR · Prototype';
  $('auth-eyebrow').textContent = 'LOCAL DEVICE ACCESS';
  $('auth-title').textContent = 'Local monitoring';
  $('auth-description').textContent = 'View the detector already running on the monitoring computer. Use its local password; this is separate from your family account.';
  $('monitor-eyebrow').textContent = 'LOCAL MONITOR · EXISTING CAMERA FEED';
  $('account-settings-title').textContent = 'Local device access';
  $('account-settings-help').textContent = 'This page uses the monitoring computer’s local password. Family accounts, invitations and followed homes are managed separately on the family website. Use Camera setup on the monitoring computer for setup instructions.';
}
$('mode-note').textContent = local ? 'Local laptop connection · Use the password configured in .env.' : 'Creating an account does not grant access to any home. Use an invitation after signing in.';
if (!configured) { $('login-message').textContent = 'Cloud connection not configured. Follow README.md to generate web/config.js and deploy.'; $('sign-in').disabled = true; }
// Confirmation links may contain credentials. Do not persist or display them.
const confirmationReturn = !local && !recoveryReturn && !!(window.location.hash || /(?:code|error|token)=/.test(window.location.search));
if (confirmationReturn) {
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const query = new URLSearchParams(window.location.search);
  $('login-message').textContent = hash.has('error') || query.has('error')
    ? 'The confirmation link could not be used. Try signing in or request a new confirmation email.'
    : 'Email confirmation link opened. Sign in with your email and password to continue.';
  window.history.replaceState(null, '', window.location.pathname);
}
function setAuthMode(mode) {
  if (authBusy) return;
  authMode = local ? 'login' : mode;
  const signup = authMode === 'signup';
  $('name-label').hidden = !signup; $('display-name').required = signup;
  $('password').autocomplete = signup ? 'new-password' : 'current-password';
  $('password').minLength = signup ? 8 : 1;
  $('sign-in').textContent = signup ? 'Create account' : 'Sign in';
  for (const [id, active] of [['login-tab',!signup],['signup-tab',signup]]) {
    $(id).setAttribute('aria-pressed', String(active)); $(id).className = active ? '' : 'secondary';
  }
  $('login-message').textContent = '';
}
$('login-tab').addEventListener('click', () => setAuthMode('login'));
$('signup-tab').addEventListener('click', () => setAuthMode('signup'));
async function request(url, options = {}) {
  const response = await fetch(url, {...options, cache:'no-store', signal:AbortSignal.timeout(6000)});
  if (!response.ok) throw Object.assign(new Error('Request failed'), {status:response.status});
  return response.json();
}
function clearView() {
  $('camera-image').hidden = true; $('camera-image').removeAttribute('src');
  if (frameURL) URL.revokeObjectURL(frameURL);
  frameURL = null; $('camera-placeholder').hidden = false; $('video-state-badge').hidden = true;
}
function stopVideo(message = 'Camera preview paused') {
  cameraTools.setLive(false); cameraWindow.setLive(false);
  viewing = false; videoGeneration++;
  const previous = remoteCamera; remoteCamera = null;
  previous?.stop(message); clearView(); $('view-camera').textContent = 'View camera';
  $('stream-state').textContent = message;
}
function multiHome(){return !local&&!!monitors.find(m=>m.device_id===selectedDeviceId)?.home_id;}
function selectedCamera(){return homeCameras.find(c=>c.camera_id===selectedCameraId);}
function selectCamera(id){
  if(!multiHome()||!homeCameras.some(c=>c.camera_id===id&&c.enabled===true))return;
  fallAlert.clear();cameraTools.reset();stopVideo();clearContext();data=null;failed=true;
  selectedCameraId=id;data=selectedCamera();receivedMono=cameraListReceived;failed=inventoryFailed;render();
}
function selectDevice(id) {
  closeClaim(); closeNoteDeletion();
  // Invalidate old callbacks and clear private device data before disconnect callbacks.
  generation++; noteRequest++; data = null; failed = true;
  fallAlert.clear();cameraTools.setContext(null);
  homeCameras=[];selectedCameraId='';inventoryFailed=true;
  $('camera-list').replaceChildren();$('camera-list-message').textContent='Loading this Home’s cameras…';$('home-camera-panel').hidden=true;
  $('notes').replaceChildren(); $('note-body').value = ''; $('note-message').textContent = '';
  cameraTools.reset(); $('events').replaceChildren(); $('event-scope').textContent=''; clearContext(); clearView();
  stopPresence(); stopVideo();
  selectedDeviceId = id; selectedName = monitors.find(m => m.device_id === id)?.name || '';
  familyManagement.setDevice(id,monitorLabel(monitors.find(m=>m.device_id===id)),!local&&signedIn&&monitors.find(m=>m.device_id===id)?.can_manage===true,multiHome());
  $('device-select').value = id; $('room').textContent = selectedName || 'Your homes';
  $('monitor-content').hidden = !local && !id; $('notes-panel').hidden = local || !id;
  closePresencePanel(); $('presence-entry').hidden = local || !id;
  $('notes-panel').classList.remove('is-open'); $('notes-toggle').setAttribute('aria-expanded','false');
  $('notes-toggle').hidden = local || !id;
  $('home-code').textContent = local ? 'Local monitoring' : homeCode(monitors.find(m=>m.device_id===id));
  $('local-setup-panel').hidden = !local || !signedIn;
  $('local-setup-panel').open = false;
  familyAlerts.setHome(!local&&signedIn?id:'',monitorLabel(monitors.find(m=>m.device_id===id)));
  $('events').replaceChildren(); $('notes').replaceChildren(); $('note-body').value = '';
  $('notes-message').textContent = ''; $('note-message').textContent = ''; $('post-note').disabled = false;
  render(); if (signedIn && (local || id)) { poll(); if (!local) { loadNotes(); startPresence(); } }
}
function stopPresence() {
  const old = presence; presence = null; old?.stop();
  closePresencePanel(); renderPresence('connecting',[]);
}
function startPresence() {
  if (!pageActive || local || !signedIn || !selectedDeviceId || presence) return;
  if (!createFamilyPresence) { renderPresence('unavailable',[]); return; }
  const view = generation, account = cloud.epoch;
  const controller = createFamilyPresence({config,sessionId:window.crypto.randomUUID(),
    requestPresence:cloud.presenceRequester(selectedDeviceId),
    token:async()=>{if(account!==cloud.epoch)throw new Error('Session changed');return cloud.token();},
    onAccessError:error=>{if(view===generation)accessError(error);},
    onChange:({state,members})=>{
      if(view!==generation||presence!==controller)return;
      renderPresence(state,members);
    }
  });
  presence=controller;controller.start();
}
function homeCode(monitor) {return /^Home-[0-9]{3,19}$/.test(monitor?.home_code||'') ? monitor.home_code : 'Home ID unavailable';}
function monitorLabel(monitor) {return monitor ? `${homeCode(monitor)} · ${monitor.name||'Monitored home'}` : 'Selected home';}
function closePresencePanel(restoreFocus=false) {
  $('presence-panel').hidden=true;$('presence-toggle').setAttribute('aria-expanded','false');
  if(restoreFocus&&!$('presence-entry').hidden)$('presence-toggle').focus();
}
function renderPresence(state,members) {
  const online=state==='online',list=online&&Array.isArray(members)?members:[];
  $('online-members').replaceChildren(...list.map(member=>{const li=document.createElement('li');li.textContent=displayName(member.name)+(member.is_mine?' (you)':'');return li;}));
  $('presence-count').textContent=online?`Family · ${list.length}`:state==='connecting'?'Family · …':'Family · unavailable';
  $('presence-short-name').textContent=list[0]?displayName(list[0].name)+(list[0].is_mine?' (you)':''):'';
  $('presence-more').textContent=list.length>1?`+${list.length-1}`:'';
  $('presence-message').textContent=online?(list.length?`${list.length} family member(s) recently connected.`:'No family members recently connected.'):state==='connecting'?'Checking family connections…':'Online status unavailable. Reconnecting…';
}
$('presence-toggle').addEventListener('click',()=>{
  if(local||!signedIn||!selectedDeviceId)return;
  const open=$('presence-panel').hidden;closePresencePanel();
  if(open){$('presence-panel').hidden=false;$('presence-toggle').setAttribute('aria-expanded','true');$('close-presence').focus();}
});
$('close-presence').addEventListener('click',()=>closePresencePanel(true));
$('presence-panel').addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();closePresencePanel(true);}});
document.addEventListener('click',event=>{if(!$('presence-panel').hidden&&!$('presence-panel').contains(event.target)&&!$('presence-toggle').contains(event.target))closePresencePanel();});
$('notes-toggle').addEventListener('click',()=>{
  if(local||!signedIn||!selectedDeviceId)return;
  const open=$('notes-panel').classList.toggle('is-open');$('notes-toggle').setAttribute('aria-expanded',String(open));
  if(open){$('notes-title').focus();$('notes-panel').scrollIntoView?.({block:'start',behavior:'instant'});}else closeNoteDeletion();
});
$('close-notes').addEventListener('click',()=>{$('notes-panel').classList.remove('is-open');$('notes-toggle').setAttribute('aria-expanded','false');closeNoteDeletion();$('notes-toggle').focus();});
async function loadProfile() {
  if(local||!signedIn)return;
  const account=accountGeneration,requestId=++profileRequest;
  try{
    const name=await cloud.profile();
    if(account!==accountGeneration||requestId!==profileRequest)return;
    $('profile-name').value=displayName(name)==='Family member'?'':name;
    $('profile-message').textContent=name?'':'Add your name so family members can recognize your notes.';
  }catch(e){
    if(account===accountGeneration&&requestId===profileRequest&&!accessError(e))$('profile-message').textContent='Could not load your display name. You can try saving it below.';
  }
}
$('profile-form').addEventListener('submit',async event=>{
  event.preventDefault();if(!signedIn||local||$('save-name').disabled)return;
  const name=$('profile-name').value.replace(/[\u0000-\u001f\u007f]/g,'').trim();
  if(!name||name.length>80||name.includes('@')){$('profile-message').textContent='Enter a name of 1–80 characters, without an email address.';return;}
  const account=accountGeneration,requestId=++profileRequest;
  $('save-name').disabled=true;
  try{
    await cloud.profile(name);
    if(account!==accountGeneration||requestId!==profileRequest)return;
    $('profile-message').textContent='Name saved. It will appear beside your care notes and online status.';
  }catch(e){if(account===accountGeneration&&requestId===profileRequest&&!accessError(e))$('profile-message').textContent='Could not save your name. Please try again.';}
  finally{if(account===accountGeneration&&requestId===profileRequest)$('save-name').disabled=false;}
});
function rememberView(screen, deviceId = '') {
  if (local) return;
  try { storage?.setItem(viewKey, JSON.stringify({screen,deviceId})); } catch {}
}
function savedView() {
  try {
    const value = JSON.parse(storage?.getItem(viewKey) || 'null');
    if (value && ['homes','monitor'].includes(value.screen) && typeof value.deviceId === 'string') return value;
  } catch {}
  return {screen:'homes',deviceId:''};
}
function showHomes() {
  closeClaim(); closeInvitation();
  const preferred = selectedDeviceId || $('device-select').value;
  selectDevice('');
  $('login').hidden = false; $('auth-content').hidden = true; $('family-panel').hidden = false;
  $('login').classList.add('choosing-home'); $('dashboard').hidden = true;
  if (monitors.some(m => m.device_id === preferred)) $('device-select').value = preferred;
  $('open-home').disabled = !monitors.some(m => m.device_id === $('device-select').value);
  rememberView('homes', $('device-select').value);
  $('family-title').focus();
}
function openHome(id) {
  // A remembered device UUID is a preference, never an authorization grant.
  if (!signedIn || !monitors.some(m => m.device_id === id)) return;
  closeClaim(); closeInvitation();
  $('login').hidden = true; $('family-panel').hidden = true; $('dashboard').hidden = false;
  selectDevice(id); rememberView('monitor', id);
}
function showLocalMonitor() {
  $('login').hidden = true; $('family-panel').hidden = true; $('dashboard').hidden = false;
  selectDevice('');
}
function signedOut(message = '') {
  familyAlerts.logout(false);
  closeClaim(); closeInvitation();
  stopPresence(); stopVideo(); cloud.clear(); signedIn = false; accountGeneration++; listRequest++; profileRequest++;
  monitors = []; selectDevice('');
  $('device-select').replaceChildren(); $('device-select').disabled = true;
  $('dashboard').hidden = true; $('login').hidden = false;
  $('auth-content').hidden = false; $('family-panel').hidden = true;
  $('login').classList.remove('choosing-home'); $('open-home').disabled = true;
  try { storage?.removeItem(viewKey); } catch {}
  $('invite-code').value = ''; $('invite-message').textContent = '';
  $('profile-name').value = ''; $('profile-message').textContent = ''; $('save-name').disabled = false;
  $('bind-device').disabled = false; $('refresh-homes').disabled = false;
  $('login-message').textContent = message;
}
function accessError(e) {
  if (e.status === 401) { signedOut('Session expired. Please sign in again.'); return true; }
  if (e.status === 403 || e.code === '42501') {
    showHomes(); $('homes-message').textContent = 'Access is no longer available. Refreshing your homes…';
    loadMonitors(); return true;
  }
  return false;
}
async function loadMonitors(preferred = selectedDeviceId || $('device-select').value, resumeMonitor = false) {
  const account = accountGeneration, requestId = ++listRequest, view = generation, selection = selectionRevision;
  $('refresh-homes').disabled = true; $('open-home').disabled = true;
  $('homes-message').textContent = 'Loading your followed homes…';
  try {
    const incoming = await cloud.rpc('list_my_monitors');
    if (!signedIn || account !== accountGeneration || requestId !== listRequest) return;
    const latestPreferred = selectedDeviceId || $('device-select').value;
    monitors = incoming;
    $('device-select').replaceChildren(...monitors.map(m => {
      const option = document.createElement('option'); option.value = m.device_id;
      option.textContent = monitorLabel(m); return option;
    }));
    $('device-select').disabled = !monitors.length;
    $('homes-message').textContent = monitors.length ? `${monitors.length} followed home(s).` : 'No homes linked yet. Choose Add a home / device to enter an invitation code.';
    if (view !== generation || selection !== selectionRevision) preferred = latestPreferred;
    const next = monitors.some(m => m.device_id === preferred) ? preferred : monitors[0]?.device_id || '';
    if (selectedDeviceId && !monitors.some(m => m.device_id === selectedDeviceId)) showHomes();
    $('device-select').value = next;
    familyManagement.setDevice(selectedDeviceId,monitorLabel(monitors.find(m=>m.device_id===selectedDeviceId)),!local&&signedIn&&monitors.find(m=>m.device_id===selectedDeviceId)?.can_manage===true,multiHome());
    if(selectedDeviceId){selectedName=monitors.find(m=>m.device_id===selectedDeviceId)?.name||'';$('home-code').textContent=homeCode(monitors.find(m=>m.device_id===selectedDeviceId));}
    $('open-home').disabled = !next;
    if(pageActive&&selectedDeviceId&&familyAlerts.home!==selectedDeviceId)familyAlerts.setHome(selectedDeviceId,monitorLabel(monitors.find(m=>m.device_id===selectedDeviceId)));
    if(pendingNotificationKey)await openNotificationTarget();
    else if (resumeMonitor && next === preferred && view === generation && selection === selectionRevision) openHome(next);
    else if ($('dashboard').hidden) rememberView('homes', next);
  } catch (e) {
    if (!signedIn || account !== accountGeneration || requestId !== listRequest) return;
    if (e.status === 401 || e.status === 403 || e.code === '42501') signedOut('Session expired or account unavailable. Please sign in again.');
    else $('homes-message').textContent = 'Could not load your homes. Check the connection and click Refresh list.';
  } finally { if (account === accountGeneration && requestId === listRequest) $('refresh-homes').disabled = false; }
}
async function openNotificationTarget(){
  if(!pendingNotificationKey||openingNotification||!signedIn||!pageActive)return;
  const key=pendingNotificationKey,account=accountGeneration,selection=selectionRevision;openingNotification=true;
  try{
    const target=await cloud.rpc('open_fall_notification',{p_key:key});
    if(!signedIn||account!==accountGeneration||!pageActive||selection!==selectionRevision)return;
    if(!monitors.some(m=>m.device_id===target.home_id))throw new Error('Home unavailable');
    openHome(target.home_id); // Camera remains disconnected until an explicit click.
    $('family-alert-panel').scrollIntoView?.({block:'start'});
  }catch(e){if(account===accountGeneration&&pageActive){if(e.status===401)accessError(e);else{showHomes();$('homes-message').textContent='This notification is unavailable for this account or Home. Choose an authorized Home to review alerts.';}}}
  finally{pendingNotificationKey='';openingNotification=false;}
}
$('device-select').addEventListener('change', () => {
  selectionRevision++; $('open-home').disabled = !monitors.some(m => m.device_id === $('device-select').value);
  rememberView('homes', $('device-select').value);
});
$('open-home').addEventListener('click', () => openHome($('device-select').value));
$('choose-home').addEventListener('click', () => { const previous = selectedDeviceId; showHomes(); loadMonitors(previous); });
$('refresh-homes').addEventListener('click', () => loadMonitors());
$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); if (authBusy || recoveryUI?.active || !configured) return;
  authBusy = true; $('sign-in').disabled = true; $('login-message').textContent = '';
  const mode = authMode;
  try {
    let result = 'signed_in';
    if (local) await request('/api/login', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:$('password').value})});
    else result = await cloud.authenticate(mode,$('email').value.trim(),$('password').value,$('display-name').value);
    $('password').value = '';
    if (result === 'confirmation_required') {
      authBusy = false; setAuthMode('login');
      $('login-message').textContent = 'Check your inbox for a confirmation email, then sign in. If you already have an account, sign in instead. No home access has been granted.';
    } else {
      signedIn = true; accountGeneration++;
      if (local) showLocalMonitor(); else {
        showHomes();
        loadProfile();
        $('homes-message').textContent = 'Loading your homes…';
        $('invite-message').textContent = mode === 'signup' ? 'Account created. Choose Add a home / device to link a home with an invitation.' : '';
        await loadMonitors();
      }
    }
  } catch (e) {
    $('login-message').textContent = e.status === 429 ? 'Too many attempts. Please wait before trying again.'
      : e.code === 'email_not_confirmed' ? 'Confirm your email before signing in. Check your inbox and spam folder.'
      : mode === 'signup' ? 'Account creation failed. Check the email, password requirements and connection. Registration may be disabled.'
      : 'Sign-in failed. Check your email, password and connection.';
  } finally { if(!recoveryUI?.active){authBusy = false; $('sign-in').disabled = !configured;} }
});
async function logout() {
  stopPresence(); stopVideo(); // Capture the old token before clearing the session.
  if(!local)await familyAlerts.logout(true);
  const pending = local ? request('/api/logout', {method:'POST'}) : cloud.logout();
  signedOut(); const account = accountGeneration;
  try { await pending; } catch { if (account === accountGeneration) $('login-message').textContent = 'Signed out of this page. Server sign-out could not be confirmed.'; }
}
$('logout').addEventListener('click', logout);
$('homes-logout').addEventListener('click', logout);
function closeInvitation(clearMessage = true) {
  inviteRequest++;
  $('invite-panel').hidden = true;
  $('show-invite').setAttribute('aria-expanded', 'false');
  $('invite-code').value = '';
  $('bind-device').disabled = false;
  $('cancel-invite').disabled = false;
  $('show-invite').disabled = false;
  if (clearMessage) $('invite-message').textContent = '';
}
$('show-invite').addEventListener('click', () => {
  if (local || !signedIn || $('family-panel').hidden) return;
  const opening = $('invite-panel').hidden;
  closeClaim(); closeInvitation();
  if (opening) {
    $('invite-panel').hidden = false;
    $('show-invite').setAttribute('aria-expanded', 'true');
    $('invite-code').focus();
  }
});
$('cancel-invite').addEventListener('click', () => {
  closeClaim(); closeInvitation(); $('show-invite').focus();
});
$('invite-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (local || !signedIn || $('family-panel').hidden || $('invite-panel').hidden || $('bind-device').disabled) return;
  const account = accountGeneration, requestId = ++inviteRequest;
  $('bind-device').disabled = true; $('cancel-invite').disabled = true; $('show-invite').disabled = true;
  $('invite-message').textContent = '';
  try {
    const result = await cloud.rpc('redeem_family_invite', {p_code:$('invite-code').value.trim()});
    if (!signedIn || account !== accountGeneration || requestId !== inviteRequest) return;
    if (!result.ok) {
      $('invite-message').textContent = result.error === 'rate_limited' ? 'Too many code attempts. Wait one minute and try again.' : 'Invitation unavailable. Check the code or ask your caregiver for a new one.';
      return;
    }
    closeInvitation(false);
    $('invite-message').textContent = result.already_member ? 'You already follow this home.' : 'Home linked to your account.';
    selectionRevision++; await loadMonitors(result.device_id);
  } catch (e) {
    if (account !== accountGeneration || requestId !== inviteRequest) return;
    if (!accessError(e)) $('invite-message').textContent = 'Could not redeem the invitation. Check your connection and try again.';
  } finally {
    if (account === accountGeneration && requestId === inviteRequest) {
      $('bind-device').disabled = false; $('cancel-invite').disabled = false; $('show-invite').disabled = false;
    }
  }
});
// A code is proof of the local operator's explicit action, never a browser role flag.
function closeClaim(clearMessage = true) {
  claimRequest++; $('claim-panel').hidden = true; $('claim-code').value = '';
  $('show-claim').setAttribute('aria-expanded','false');
  $('claim-device').disabled = false;
  if (clearMessage) $('claim-message').textContent = '';
}
$('show-claim').addEventListener('click', () => {
  if (local || !signedIn || $('family-panel').hidden) return;
  const opening = $('claim-panel').hidden;
  closeClaim(); closeInvitation();
  if (opening) {
    $('claim-panel').hidden = false; $('show-claim').setAttribute('aria-expanded','true');
    $('claim-code').focus();
  }
});
$('cancel-claim').addEventListener('click', () => { closeClaim(); $('show-claim').focus(); });
$('claim-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (local || !signedIn || $('family-panel').hidden || $('claim-panel').hidden || $('claim-device').disabled) return;
  const account = accountGeneration, requestId = ++claimRequest;
  const code = $('claim-code').value.trim();
  $('claim-code').value = ''; $('claim-device').disabled = true; $('claim-message').textContent = '';
  try {
    const result = await cloud.rpc('redeem_device_claim',{p_code:code});
    if (!signedIn || account !== accountGeneration || requestId !== claimRequest) return;
    if (!result.ok) {
      $('claim-message').textContent = result.error === 'rate_limited'
        ? 'Too many claim attempts. Wait one minute and try again.'
        : 'Claim unavailable. Check the code or generate a new one on the monitoring computer. Already-managed devices cannot be claimed.';
      return;
    }
    closeClaim(false);
    const completedRequest = claimRequest;
    $('claim-message').textContent = 'Device claimed. Loading your authorized homes…';
    selectionRevision++; await loadMonitors(result.device_id);
    // All manager UI still comes from list_my_monitors, never from the code itself.
    if (signedIn && account === accountGeneration && completedRequest === claimRequest && !$('family-panel').hidden)
      $('claim-message').textContent = 'Device claimed. Open its monitoring page and choose Manage family to invite relatives. If it is not listed yet, click Refresh list.';
  } catch (e) {
    if (account !== accountGeneration || requestId !== claimRequest) return;
    if (!accessError(e)) $('claim-message').textContent = 'Could not confirm the claim. Refresh your homes first: the request may have succeeded. Otherwise check the connection and server setup.';
  } finally {
    if (account === accountGeneration && requestId === claimRequest) $('claim-device').disabled = false;
  }
});
async function loadNotes() {
  if (!pageActive || !signedIn || local || !selectedDeviceId || noteDeleteBusy) return;
  const selected = selectedDeviceId, view = generation, requestId = ++noteRequest;
  try {
    const notes = await cloud.rpc('list_care_notes', {p_device:selected});
    if (view !== generation || requestId !== noteRequest) return;
    $('notes').replaceChildren(...notes.map(note => {
      const li = document.createElement('li'), author = document.createElement('strong'), time = document.createElement('time'), body = document.createElement('p');
      author.textContent = displayName(note.author) + (note.is_mine ? ' (you)' : '');
      time.dateTime = note.created_at; time.textContent = new Date(note.created_at).toLocaleString();
      body.textContent = note.body; li.append(author,document.createElement('br'),time,body);
      li.dataset.noteId = String(note.id || '');
      if (note.can_delete === true && typeof note.id === 'string') {
        const button = document.createElement('button'); button.type = 'button';
        button.className = 'secondary note-delete'; button.textContent = note.is_mine ? 'Delete my note' : 'Delete note · Device manager';
        button.setAttribute('aria-label', `Delete care note by ${displayName(note.author)} from ${time.textContent}`);
        button.addEventListener('click', () => {
          if (view !== generation || !signedIn || noteDeleteBusy) return;
          closeNoteDeletion();
          noteDeletion = {id:note.id,device:selected,view,account:accountGeneration};
          $('note-delete-preview').textContent = `${author.textContent} · ${time.textContent}\n${note.body}`;
          $('note-delete-confirm').hidden = false; $('cancel-note-delete').focus();
        });
        li.append(button);
      }
      return li;
    }));
    if (noteDeletion && !notes.some(note => note.id === noteDeletion.id && note.can_delete === true)) {
      closeNoteDeletion(true); $('note-delete-message').textContent = 'This note is no longer available to delete. Review the refreshed notes.';
    }
    $('notes-message').textContent = notes.length ? '' : 'No care notes yet. Share the first observation.';
  } catch (e) {
    if (view !== generation || requestId !== noteRequest) return;
    if (!accessError(e)) $('notes-message').textContent = 'Could not refresh notes. Displayed notes may be out of date.';
  }
}
function closeNoteDeletion(restoreFocus = false) {
  const id = noteDeletion?.id;
  noteDeleteRequest++; noteDeletion = null; noteDeleteBusy = false;
  $('note-delete-confirm').hidden = true; $('note-delete-preview').textContent = '';
  $('note-delete-message').textContent = '';
  $('confirm-note-delete').disabled = false; $('cancel-note-delete').disabled = false;
  if (restoreFocus) {
    const item = [...$('notes').children].find(li => li.dataset.noteId === id);
    (item?.querySelector('button') || $('notes-title')).focus();
  }
}
$('cancel-note-delete').addEventListener('click', () => { if (!noteDeleteBusy) closeNoteDeletion(true); });
$('note-delete-confirm').addEventListener('keydown', event => {
  if (event.key === 'Escape' && !noteDeleteBusy) { event.preventDefault(); closeNoteDeletion(true); }
});
$('confirm-note-delete').addEventListener('click', async () => {
  const target = noteDeletion;
  if (!target || noteDeleteBusy || local || !signedIn || target.view !== generation || target.device !== selectedDeviceId || target.account !== accountGeneration) return;
  const requestId = ++noteDeleteRequest;
  noteDeleteBusy = true; noteRequest++; // Invalidate a list fetched before deletion.
  $('confirm-note-delete').disabled = true; $('cancel-note-delete').disabled = true;
  $('note-delete-message').textContent = 'Deleting note…';
  try {
    const result = await cloud.rpc('delete_care_note',{p_device:target.device,p_note:target.id});
    if (requestId !== noteDeleteRequest || target.view !== generation || target.account !== accountGeneration) return;
    if (!result.ok) {
      closeNoteDeletion(true);
      $('note-delete-message').textContent = result.error === 'rate_limited'
        ? 'Too many delete requests. Wait one minute and try again.'
        : 'This note is unavailable or you no longer have permission to delete it. Refreshing notes…';
      await loadNotes(); return;
    }
    // Remove the confirmed deletion now, even if the subsequent refresh fails.
    [...$('notes').children].find(li => li.dataset.noteId === target.id)?.remove();
    closeNoteDeletion(true); $('note-delete-message').textContent = 'Care note deleted. AI status and detection events are unchanged.';
    await loadNotes();
  } catch (e) {
    if (requestId !== noteDeleteRequest || target.view !== generation || target.account !== accountGeneration) return;
    closeNoteDeletion(true);
    if (!accessError(e)) {
      $('note-delete-message').textContent = 'Deletion could not be confirmed. Refreshing notes before you try again; the request may have succeeded.';
      await loadNotes();
    }
  }
});
$('note-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!signedIn || local || !selectedDeviceId || $('post-note').disabled) return;
  const selected = selectedDeviceId, view = generation, body = $('note-body').value.trim();
  if (!body || [...body].length > 1000) { $('note-message').textContent = 'Enter 1–1,000 characters.'; return; }
  $('post-note').disabled = true; $('note-message').textContent = '';
  try {
    const result = await cloud.rpc('add_care_note', {p_device:selected,p_body:body});
    if (view !== generation) return;
    if (!result.ok) {
      $('note-message').textContent = result.error === 'rate_limited' ? 'You can post up to 5 notes per minute. Please wait.' : 'Enter 1–1,000 characters.'; return;
    }
    if ($('note-body').value.trim() === body) $('note-body').value = '';
    $('note-message').textContent = 'Note shared with this home’s family.'; await loadNotes();
  } catch (e) {
    if (view !== generation) return;
    if (!accessError(e)) $('note-message').textContent = 'Posting could not be confirmed. Check the notes before trying again.';
  } finally { if (view === generation) $('post-note').disabled = false; }
});
async function poll() {
  if (!pageActive || !signedIn || (!local && !selectedDeviceId) || pollGeneration === generation) return;
  const view = generation, selected = selectedDeviceId; pollGeneration = view;
  try {
    let incoming;
    if(multiHome()){
      const [cameras,events]=await Promise.all([cloud.rpc('read_home_cameras',{p_home:selected}),cloud.rpc('list_home_events',{p_home:selected})]);
      if(view!==generation)return;
      if(!Array.isArray(cameras)||!Array.isArray(events))throw new Error('Invalid camera response');
      homeCameras=cameras;cameraListReceived=performance.now();inventoryFailed=false;
      const next=cameras.find(c=>c.camera_id===selectedCameraId&&c.enabled===true)?.camera_id||cameras.find(c=>c.enabled===true)?.camera_id||'';
      if(next!==selectedCameraId){fallAlert.clear();cameraTools.reset();stopVideo();clearContext();selectedCameraId=next;}
      incoming=selectedCamera()||null;eventsList(events);
    }else incoming = local ? await request('/api/status') : await cloud.rpc('read_monitor', {p_device:selected});
    if (view !== generation) return;
    data = incoming; receivedMono = performance.now(); failed = false; if(!multiHome())eventsList(data?.payload?.events,data?.payload?.camera_name);
  } catch (e) {
    if (view !== generation) return;
    failed = true; inventoryFailed=true; if (local && [401,403].includes(e.status)) signedOut('Session expired. Please sign in again.');
    else if (!local) accessError(e);
  } finally { if (pollGeneration === view) pollGeneration = null; if (view === generation) render(); }
}
function eventsList(events, cameraName='') {
  const nodes = recentEvents(events).map(event => {
    const li = document.createElement('li'), label = document.createElement('div'), name = document.createElement('span'), detail = document.createElement('small'), time = document.createElement('time');
    name.textContent = String(event.status || 'Unknown'); if (/^(?:Person [0-9]+: )?Suspected Fall$/.test(String(event.status))) name.className = 'event-danger';
    detail.textContent = String(event.camera_name || cameraName || 'Camera name unavailable')+' · ' + (event.reason || (event.angle_deg ? `Torso ${event.angle_deg}° · W/H ${event.width_height_ratio}` : 'Detection event'));
    time.textContent = String(event.time || '').replace('T',' '); label.append(name,detail); li.append(label,time); return li;
  });
  if (!nodes.length) { const li=document.createElement('li'); li.textContent='No events received.'; nodes.push(li); }
  $('events').replaceChildren(...nodes);
}
function clearContext() {
  $('context-panel').hidden=true; $('person-context').replaceChildren();
  $('calibration-state').textContent=''; $('context-counts').textContent='';
}
function renderAlerts() {
  if(!pageActive){fallAlert.clear();return;}
  const cameras=multiHome()?homeCameras:data?[{...data,camera_id:'current',name:data.payload?.camera_name,enabled:true}]:[];
  fallAlert.update({homeLabel:local?'Local monitoring · '+(data?.payload?.room||'Monitoring computer'):monitorLabel(monitors.find(m=>m.device_id===selectedDeviceId)),
    cameras,elapsed:performance.now()-(multiHome()?cameraListReceived:receivedMono),failed:multiHome()?inventoryFailed:failed,
    sharedAlerts:familyAlerts.rows,sharedLoaded:familyAlerts.loaded,acknowledging:familyAlerts.acking,
    selected:multiHome()?selectedCameraId:'current',viewing,canView:local?data?.camera_transport==='local-jpeg':remoteEnabled});
}
function viewAlertCamera(id) {
  // Re-check current scope/freshness on the actual click, not only button visibility.
  if(!pageActive||!signedIn||(!local&&!selectedDeviceId))return;
  const camera=multiHome()?homeCameras.find(c=>c.camera_id===id&&c.enabled===true):id==='current'?data:null;
  const state=currentStatus(camera,performance.now()-(multiHome()?cameraListReceived:receivedMono),multiHome()?inventoryFailed:failed);
  if(state.status!=='Suspected Fall'||!state.connected||camera?.payload?.demo)return;
  if(multiHome()&&selectedCameraId!==id)selectCamera(id);
  beginVideo();renderAlerts();
  $('view-camera').focus();$('camera-stage').scrollIntoView?.({block:'center',behavior:'smooth'});
}
function renderContext(s,p) {
  clearContext();
  if(!s.connected || !p.context || !Array.isArray(p.context.people))return;
  $('context-panel').hidden=false;
  $('calibration-state').textContent=String(p.context.calibration || 'Bed area not calibrated');
  const names={ACTIVE:'Active',LOWERING:'Lowering / observing',RESTING_IN_BED:'Resting in bed — monitoring',
    POSSIBLE_FALL:'Suspected fall',CHECK_PERSON:'Check person',TRACKING_LOST:'Tracking lost',RECOVERED:'Returned upright'};
  $('person-context').replaceChildren(...p.context.people.slice(0,16).map(person=>{
    const li=document.createElement('li'),title=document.createElement('strong'),reason=document.createElement('p');
    const number=Number.isSafeInteger(person.person_number)&&person.person_number>0?person.person_number:'?';
    title.textContent=`Person ${number}: ${names[person.state] || 'Status uncertain'}`;
    reason.textContent=String(person.reason || '');li.append(title,reason);return li;
  }));
  $('context-counts').textContent=`Visible: ${Number(p.context.visible_count)||0} · Recently missing: ${Number(p.context.missing_count)||0} · Up to 16 summaries shown`;
}
function render() {
  if (!pageActive || !signedIn || (!local && !selectedDeviceId)) return;
  const s = currentStatus(data, performance.now()-receivedMono, failed), p = data?.payload || {};
  renderContext(s,p);
  $('home-camera-panel').hidden=!multiHome();
  if(multiHome()){
    const elapsed=performance.now()-cameraListReceived;const summary=homeStatus(homeCameras,elapsed,inventoryFailed);
    $('home-status-label').textContent=summary.status;$('home-status-description').textContent=summary.description;
    $('home-summary').className='card status tone-'+summary.tone;
    $('camera-list-message').textContent=inventoryFailed?'Camera list unavailable. Reconnecting…':homeCameras.length?`${homeCameras.length} camera(s) linked to this Home. Select a camera, then choose View camera.`:'No cameras linked yet. Set up a camera on the monitoring computer.';
    renderCameraCards({document,list:$('camera-list'),cameras:inventoryFailed?[]:homeCameras,selected:selectedCameraId,elapsed,onSelect:selectCamera});
  }
  $('status-card').className = 'card status tone-'+s.tone;
  if($('status-label').textContent!==s.status)$('status-label').textContent = s.status;
  $('status-description').textContent = s.description;
  $('connection').textContent = s.status === 'Connection Lost' ? 'Connection lost · status unavailable' : local ? 'Local status connection' : 'Cloud status connection';
  $('age').textContent = Number.isFinite(s.age) ? `${Math.max(0,Math.floor(s.age/1000))}s since heartbeat` : 'No recent heartbeat';
  $('room').textContent = (multiHome()?selectedName:p.room) || selectedName || 'Your home'; $('camera-name').textContent = selectedCamera()?.name || p.camera_name || '—';
  $('status-scope').textContent='CURRENT CAMERA OBSERVATION · '+($('camera-name').textContent==='—'?'Camera unavailable':$('camera-name').textContent);
  cameraTools.setContext({key:(local?'local':selectedDeviceId)+':'+selectedCameraId,
    home:local?'Local monitoring · '+(p.room||'Monitoring computer'):monitorLabel(monitors.find(m=>m.device_id===selectedDeviceId)),
    homeCode:local?'Local-monitor':homeCode(monitors.find(m=>m.device_id===selectedDeviceId)),camera:$('camera-name').textContent==='—'?'Current camera':$('camera-name').textContent});
  $('event-scope').textContent=local?'Recorded history · Local monitoring · '+(p.room||'Monitoring computer'):'Recorded history · '+monitorLabel(monitors.find(m=>m.device_id===selectedDeviceId))+' · All linked cameras';
  $('camera-state').textContent = s.connected ? 'Camera connected to laptop' : s.status === 'Connection Lost' ? 'Camera state unknown' : 'Camera offline / unavailable';
  $('updated').textContent = p.observed_at && Number.isFinite(Date.parse(p.observed_at)) ? new Date(p.observed_at).toLocaleString() : 'No observation received';
  $('cloud-state').textContent = local ? `Cloud bridge: ${data?.cloud_state || 'Unknown'}` : 'Video uses a separate connection';
  $('demo-banner').hidden = !p.demo;
  const available = (local && data?.camera_transport === 'local-jpeg' || remoteEnabled) && s.connected && !p.demo;
  $('view-camera').disabled = !available;
  if (!available) stopVideo(s.status === 'Connection Lost' ? 'Connection lost' : 'Camera stream not connected');
  else if (!viewing && local) $('stream-state').textContent = 'Camera preview paused';
  $('stream-description').textContent = available ? local ? 'Authenticated local preview from the existing capture loop.' : 'Authenticated WebRTC · Starts only while you are viewing.' : local ? 'A current camera frame is not available.' : remoteEnabled ? 'Current camera status is unavailable.' : 'Remote video is not configured. Set up the video functions and laptop sender first.';
  renderAlerts();
}
async function nextFrame() {
  if (!viewing || !signedIn || document.hidden) return;
  const requestGeneration = generation, viewGeneration = videoGeneration;
  try {
    const response = await fetch('/api/frame', {cache:'no-store',signal:AbortSignal.timeout(2500)});
    if (!response.ok) throw new Error('Frame unavailable');
    const blob = await response.blob();
    if (!viewing || requestGeneration !== generation || viewGeneration !== videoGeneration) return;
    if (frameURL) URL.revokeObjectURL(frameURL);
    frameURL = URL.createObjectURL(blob); $('camera-image').src=frameURL; $('camera-image').hidden=false; $('camera-placeholder').hidden=true;
    cameraWindow.setLive(true); cameraTools.setLive(true);
  } catch { if (viewGeneration !== videoGeneration) return; cameraWindow.setLive(false); cameraTools.setLive(false); clearView(); $('stream-state').textContent='Camera stream not connected'; }
  if (viewing && viewGeneration === videoGeneration) setTimeout(nextFrame,200);
}
function startRemote() {
  // Separate media elements isolate late disconnect/track callbacks from a previous home.
  const oldVideo = $('camera-video'), video = oldVideo.cloneNode(false); oldVideo.replaceWith(video);
  const camera = createRemoteCamera({
    requestToken:cloud.cameraRequester(selectedCamera()?.device_id||selectedDeviceId,(selectedCamera()?.legacy_video?undefined:selectedCameraId)||undefined), video, serverUrl:config.livekitUrl, deviceId:(selectedCamera()?.device_id||selectedDeviceId).toLowerCase(),cameraId:(selectedCamera()?.legacy_video?undefined:selectedCameraId)||undefined,
    onState:(message,live) => {
      if (remoteCamera !== camera) return;
      $('stream-state').textContent = message; $('camera-placeholder').hidden = live;
      $('video-state-badge').hidden = !live; viewing = camera.active === true;
      cameraWindow.setLive(live); cameraTools.setLive(live);
      $('view-camera').textContent = viewing ? 'Stop camera view' : 'View camera';
      renderAlerts();
    }
  });
  remoteCamera = camera; camera.start();
}
function beginVideo() {
  if(!pageActive||viewing||!signedIn||$('view-camera').disabled)return;
  const s=currentStatus(data,performance.now()-receivedMono,failed);
  if(!s.connected||data?.payload?.demo)return;
  viewing = true; $('view-camera').textContent = 'Stop camera view'; if (local) nextFrame(); else startRemote();
}
$('view-camera').addEventListener('click', () => {if(viewing)stopVideo();else beginVideo();renderAlerts();});
window.addEventListener('offline', () => { familyAlerts.pause();stopPresence(); failed = true; inventoryFailed=true; homeCameras=[];render(); });
window.addEventListener('online', () => {if(!local&&signedIn&&selectedDeviceId)familyAlerts.setHome(selectedDeviceId,monitorLabel(monitors.find(m=>m.device_id===selectedDeviceId)));poll(); loadNotes(); startPresence(); });
window.addEventListener('pagehide', () => {
  pageActive=false;generation++;listRequest++;profileRequest++;noteRequest++;familyAlerts.pause();
  if(recoveryUI?.active)recoveryUI.back();
  fallAlert.clear();closePresencePanel();closeNoteDeletion();familyManagement.close();closeClaim();closeInvitation();
  data=null;failed=true;homeCameras=[];inventoryFailed=true;
  $('camera-list').replaceChildren();$('home-camera-panel').hidden=true;$('events').replaceChildren();$('event-scope').textContent='';
  $('notes').replaceChildren();$('note-body').value='';clearContext();
  $('status-card').className='card status tone-offline';$('status-label').textContent='Connection Lost';
  $('status-description').textContent='Current status is unavailable. Refreshing after returning to this page.';
  cameraTools.setContext(null);cameraTools.reset();stopPresence();stopVideo();
});
window.addEventListener('pageshow', () => {
  pageActive=true;
  if(signedIn&&!local){$('refresh-homes').disabled=false;$('save-name').disabled=false;loadMonitors();}
  render();poll();loadNotes();startPresence();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { if (!noteDeleteBusy) closeNoteDeletion(); closeClaim(); familyManagement.close(); if (!cameraWindow.keepsPlaying) stopVideo(); }
  else { render(); poll(); loadNotes(); presence?.refresh(); }
});
const timers = [window.setInterval(()=>{if(pageActive)familyManagement.refresh();},15000), window.setInterval(poll,3000), window.setInterval(render,1000), window.setInterval(loadNotes,15000),
  window.setInterval(()=>{if(pageActive&&signedIn&&!local)familyAlerts.refresh();},5000),
  window.setInterval(()=>{if(pageActive&&signedIn&&!local)familyAlerts.push.refresh();},60000),
  window.setInterval(()=>{if(pageActive&&signedIn&&!local&&!$('refresh-homes').disabled)loadMonitors();},15000)];
async function restoreLogin() {
  if (!configured || confirmationReturn || recoveryReturn) return;
  authBusy = true; $('sign-in').disabled = true; $('session-loading').hidden = false;
  try {
    if (local) {
      // Reuse the server's HttpOnly cookie; no local password is stored in JS.
      await request('/api/status');
      signedIn = true; accountGeneration++; showLocalMonitor();
    } else if (cloud.restore()) {
      const previous = savedView();
      signedIn = true; accountGeneration++; showHomes();
      loadProfile();
      $('homes-message').textContent = 'Restoring sign-in and checking your homes…';
      await loadMonitors(previous.deviceId, previous.screen === 'monitor');
    }
  } catch (e) {
    if (![401,403].includes(e.status)) $('login-message').textContent = 'Could not check your saved sign-in. Check your connection or sign in again.';
  } finally { authBusy = false; $('sign-in').disabled = !configured; $('session-loading').hidden = true; }
}
if(!local)recoveryUI = new PasswordRecovery({window,document,supabaseUrl:config.supabaseUrl||'',request:(...args)=>cloud.request(...args),
  onStart:()=>{signedOut();authBusy=true;$('sign-in').disabled=true;$('auth-content').hidden=true;$('family-panel').hidden=true;},
  onBack:()=>{authBusy=false;$('sign-in').disabled=!configured;$('auth-content').hidden=false;setAuthMode('login');$('email').focus();}});
const ready = recoveryCallback ? recoveryUI.startLink(recoveryCallback) : restoreLogin();
recoveryCallback = null;
// Small lifecycle hook for embedding and tests; no session data exposed.
return {ready, dispose() {
  pageActive=false;
  familyAlerts.pause();recoveryUI?.dispose(); fallAlert.clear(); familyManagement.modal.dispose(); timers.forEach(id => window.clearInterval(id)); closeNoteDeletion(); closeClaim(); familyManagement.setDevice('','',false); familyManagement.close(); stopPresence(); stopVideo(); cameraWindow.dispose(); cameraTools.dispose();
  signedIn = false; generation++; accountGeneration++; listRequest++; noteRequest++;
}, poll, loadNotes};
}
