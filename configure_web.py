"""Generate public dashboard config. Never exports the private device token."""
import json
import os
from pathlib import Path
from urllib.parse import urlparse
from uuid import UUID
from dotenv import load_dotenv

base = Path(__file__).resolve().parent
load_dotenv(base / '.env')
url = os.getenv('SUPABASE_URL', '').rstrip('/')
key = os.getenv('SUPABASE_PUBLISHABLE_KEY', '')
device = os.getenv('SAFENEST_DEVICE_ID', '')
if urlparse(url).scheme != 'https' or not urlparse(url).hostname:
    raise SystemExit('Set SUPABASE_URL to the HTTPS project URL in .env.')
if not key or key.startswith('sb_secret_'):
    raise SystemExit('Use a public publishable/anon key, never a secret key.')
if key.count('.') == 2:
    import base64
    try:
        claims = json.loads(base64.urlsafe_b64decode(key.split('.')[1] + '==='))
    except (ValueError, UnicodeError):
        raise SystemExit('Invalid legacy anon key.')
    if claims.get('role') != 'anon':
        raise SystemExit('Legacy key must have role=anon. Do not use service_role.')
try:
    UUID(device)
except ValueError:
    raise SystemExit('Set SAFENEST_DEVICE_ID to the registered device UUID.')
video_enabled = os.getenv('SAFENEST_VIDEO_ENABLED') == '1'
livekit_url = os.getenv('LIVEKIT_URL', '').rstrip('/')
video_host = urlparse(livekit_url)
if video_enabled and (video_host.scheme != 'wss' or not video_host.hostname or video_host.path not in ('', '/') or video_host.query or video_host.fragment or video_host.username or video_host.port):
    raise SystemExit('Set LIVEKIT_URL to the exact wss:// project host (no path/credentials/port).')
config = {'mode':'cloud','supabaseUrl':url,'publishableKey':key,'deviceId':device.lower(), 'videoEnabled':video_enabled, 'livekitUrl':livekit_url if video_enabled else ''}
# Update exact endpoint hosts in CSP; websocket signaling is not a Vercel function.
vercel_path = base / 'web/vercel.json'
vercel = json.loads(vercel_path.read_text(encoding='utf-8'))
connect = ["'self'", url, url.replace('https://', 'wss://', 1)]
if video_enabled:
    connect += [livekit_url, livekit_url.replace('wss://','https://',1)]
    try:
        extra = json.loads(os.getenv('SAFENEST_VIDEO_EXTRA_ORIGINS', '[]'))
        if not isinstance(extra, list): raise ValueError()
        for origin in extra:
            parsed = urlparse(origin)
            if parsed.scheme not in ('https', 'wss') or not parsed.hostname or parsed.path or parsed.query or parsed.fragment or parsed.username or parsed.port: raise ValueError()
        connect += extra
    except (ValueError, TypeError):
        raise SystemExit('SAFENEST_VIDEO_EXTRA_ORIGINS must be a JSON array of exact HTTPS/WSS origins.')
for group in vercel['headers']:
    for header in group['headers']:
        if header['key'] == 'Content-Security-Policy':
            import re
            header['value'] = re.sub(r'connect-src[^;]*', 'connect-src ' + ' '.join(connect), header['value'])
            if 'media-src' not in header['value']: header['value'] += "; media-src 'self' blob:"
(base / 'web/config.js').write_text('window.SAFENEST_CONFIG = ' + json.dumps(config) + ';\n', encoding='utf-8')
vercel_path.write_text(json.dumps(vercel,indent=2)+'\n',encoding='utf-8')
print('Created web/config.js with public configuration only. Device token was not exported.')
