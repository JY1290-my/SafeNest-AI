// Tab-scoped Auth sessions survive reload. Device authority always comes from RPCs.
export class CloudClient {
  constructor(config, fetcher = fetch, now = () => performance.now(), {storage = null, wallNow = () => Date.now()} = {}) {
    this.config = config; this.fetch = fetcher; this.now = now;
    this.storage = storage; this.wallNow = wallNow;
    this.storageKey = 'safenest:session:' + config.supabaseUrl;
    this.session = null; this.epoch = 0; this.refreshing = null;
  }
  async request(path, body, token, method = 'POST') {
    const response = await this.fetch(this.config.supabaseUrl + path, {
      method, cache:'no-store', signal:AbortSignal.timeout(8000),
      headers:{apikey:this.config.publishableKey, 'Content-Type':'application/json',
        ...(token ? {Authorization:'Bearer '+token} : {})}, ...(method === 'GET' ? {} : {body:JSON.stringify(body)})
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error('Cloud request failed');
      error.status = response.status; error.code = value.error_code || value.code;
      throw error;
    }
    return value;
  }
  save(value) {
    if (!value.access_token || !value.refresh_token) throw new Error('Missing session');
    const expiresAt = Number.isFinite(value.expires_at) ? value.expires_at * 1000
      : this.wallNow() + Math.max(0, Number(value.expires_in || 0))*1000;
    this.session = {...value, expiresAt, refreshAt:this.now() + Math.max(0, expiresAt-this.wallNow()-60000)};
    // Never persist passwords, user metadata, device credentials or monitoring data.
    try { this.storage?.setItem(this.storageKey, JSON.stringify({version:1,
      access_token:value.access_token,refresh_token:value.refresh_token,expires_at:expiresAt/1000})); } catch {}
  }
  restore() {
    let saved;
    try { saved = JSON.parse(this.storage?.getItem(this.storageKey) || 'null'); } catch { this.clear(); return false; }
    if (!saved) return false;
    if (saved.version !== 1 || typeof saved.access_token !== 'string' || !saved.access_token
      || saved.access_token.length > 16384 || typeof saved.refresh_token !== 'string' || !saved.refresh_token
      || saved.refresh_token.length > 4096 || !Number.isFinite(saved.expires_at) || saved.expires_at <= 0) {
      this.clear(); return false;
    }
    this.epoch++; this.save(saved); return true;
  }
  async authenticate(mode, email, password, name = '') {
    this.clear(); const epoch = this.epoch;
    const value = await this.request('/auth/v1/' + (mode === 'signup' ? 'signup' : 'token?grant_type=password'),
      {email,password,...(mode === 'signup' ? {data:{display_name:name.trim().slice(0,80)}} : {})});
    if (epoch !== this.epoch) throw new Error('Session changed');
    if (value.access_token && value.refresh_token) { this.save(value); return 'signed_in'; }
    if (mode === 'signup') return 'confirmation_required';
    throw new Error('Missing session');
  }
  async token() {
    if (!this.session) throw Object.assign(new Error('Sign in required'), {status:401});
    if (this.now() >= this.session.refreshAt) {
      if (!this.refreshing) {
        const epoch = this.epoch, refreshToken = this.session.refresh_token;
        const pending = this.request('/auth/v1/token?grant_type=refresh_token', {refresh_token:refreshToken})
          .then(value => { if (epoch !== this.epoch) throw new Error('Session changed'); this.save(value); })
          .catch(error => {
            if (epoch === this.epoch && [400,401,403,422].includes(error.status)) {
              this.clear(); error.status = 401;
            }
            throw error;
          })
          .finally(() => { if (this.refreshing === pending) this.refreshing = null; });
        this.refreshing = pending;
      }
      await this.refreshing;
    }
    if (!this.session) throw Object.assign(new Error('Sign in required'), {status:401});
    return this.session.access_token;
  }
  async rpc(name, body = {}) {
    const epoch = this.epoch, token = await this.token();
    if (epoch !== this.epoch) throw new Error('Session changed');
    return this.request('/rest/v1/rpc/'+name, body, token);
  }
  async profile(name) {
    const epoch = this.epoch, token = await this.token();
    if (epoch !== this.epoch) throw new Error('Session changed');
    const value = await this.request('/auth/v1/user', name === undefined ? undefined : {data:{display_name:name}}, token, name === undefined ? 'GET' : 'PUT');
    if (epoch !== this.epoch) throw new Error('Session changed');
    return value.user_metadata?.display_name || '';
  }
  presenceRequester(deviceId) {
    const epoch = this.epoch;
    let lastToken = this.session?.access_token;
    return async (action, sessionId) => {
      if (action !== 'leave') {
        if (epoch !== this.epoch) throw new Error('Session changed');
        const token = await this.token();
        if (epoch !== this.epoch) throw new Error('Session changed');
        lastToken = token;
      }
      return this.request('/rest/v1/rpc/family_presence', {p_device:deviceId,p_session:sessionId,p_action:action},lastToken);
    };
  }
  cameraRequester(deviceId, cameraId) {
    const epoch = this.epoch;
    let lastToken = this.session?.access_token;
    return async (action, sessionId) => {
      // Late leases must be released for the OLD device and OLD account.
      if (action !== 'release') {
        if (epoch !== this.epoch) throw new Error('Session changed');
        const token = await this.token();
        if (epoch !== this.epoch) throw new Error('Session changed');
        lastToken = token;
      }
      return this.request('/functions/v1/video-token', {
        device_id:deviceId,action,...(cameraId?{camera_id:cameraId}:{}),...(sessionId ? {session_id:sessionId} : {})
      }, lastToken);
    };
  }
  clear() {
    this.epoch++; this.session = null; this.refreshing = null;
    try { this.storage?.removeItem(this.storageKey); } catch {}
  }
  async logout() {
    const token = this.session?.access_token; this.clear();
    if (token) await this.request('/auth/v1/logout', {}, token);
  }
}
