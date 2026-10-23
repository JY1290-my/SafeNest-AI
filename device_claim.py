"""Explicit local device-claim requests. No camera access or credential output."""
import base64
import hashlib
import json
import re
from urllib.parse import urlsplit
from uuid import UUID

import requests
from device_settings import environment


class ClaimError(ValueError):
    """Only authored, credential-free messages may leave this module."""


def _credentials(root, expected_device):
    values = environment(root)
    try:
        device = str(UUID(values.get('SAFENEST_DEVICE_ID', '')))
    except (ValueError, AttributeError, TypeError):
        raise ClaimError('Register this monitoring device first. Check the local .env device configuration.') from None
    if device != expected_device:
        raise ClaimError('Device identity changed. Reopen Camera setup before generating a code.')
    url = (values.get('SUPABASE_URL', '') or '').rstrip('/')
    try:
        parts = urlsplit(url)
        valid = parts.scheme == 'https' and parts.hostname and not (parts.username or parts.password or parts.path or parts.query or parts.fragment)
    except ValueError:
        valid = False
    key = values.get('SUPABASE_PUBLISHABLE_KEY', '') or ''
    anon = False
    if key.startswith('eyJ'):
        try:
            segment = key.split('.')[1]
            anon = json.loads(base64.urlsafe_b64decode(segment + '=' * (-len(segment) % 4))).get('role') == 'anon'
        except (ValueError, IndexError, TypeError, AttributeError):
            pass
    if not valid or not (key.startswith('sb_publishable_') or anon):
        raise ClaimError('Configure the HTTPS Supabase project URL and a publishable/anon key locally. Secret keys are not supported.')
    token = values.get('SAFENEST_DEVICE_TOKEN', '') or ''
    if not 32 <= len(token) <= 256:
        raise ClaimError('The local device credential is missing or incomplete. Check device registration.')
    headers = {'apikey': key, 'Content-Type': 'application/json'}
    if anon:
        headers['Authorization'] = 'Bearer ' + key
    return url, headers, {'p_device': device, 'p_token': token}


def _request(root, expected_device, name, extra=None, migration="cloud/device_claim.sql"):
    url, headers, body = _credentials(root, expected_device)
    body.update(extra or {})
    try:
        response = requests.post(url + '/rest/v1/rpc/' + name, headers=headers, json=body,
                                 timeout=(3, 8), allow_redirects=False)
        if response.status_code in (401, 403):
            raise ClaimError('Device authorization failed. Check the registered device and local configuration.')
        if response.status_code == 404:
            raise ClaimError('Required device setup is not installed. Run '+migration+' in Supabase first.')
        if response.status_code == 429:
            raise ClaimError('Too many requests. Wait one minute and try again.')
        if response.status_code != 200:
            raise ClaimError('The claim request could not be confirmed. Check the connection; generating again replaces any earlier code.')
        result = response.json()
        if not isinstance(result, dict):
            raise ValueError()
    except ClaimError:
        raise
    except Exception:
        # Do not leak request URLs, headers, bodies, tokens or upstream error text.
        raise ClaimError('The claim request could not be confirmed. Check the connection; generating again replaces any earlier code.') from None
    if result.get('ok') is not True:
        if result.get('error') == 'claim_unavailable':
            raise ClaimError('This device already has or previously had a manager. Sign in as its manager; ask your trusted operator for account recovery.')
        if result.get('error') == 'rate_limited':
            raise ClaimError('Too many requests. Wait one minute and try again.')
        if result.get('error') == 'pairing_required':
            raise ClaimError('Join an existing Home using a camera setup code, or explicitly claim a new Home first.')
        if result.get('error') == 'invalid_setup':
            raise ClaimError('Camera setup code unavailable. Ask the Home manager for a new code.')
        raise ClaimError('Device claiming is unavailable. Check device registration with your trusted operator.')
    return result


def issue_claim(root, expected_device):
    result = _request(root, expected_device, 'issue_device_claim')
    code = result.get('claim_code', '')
    if not isinstance(code, str) or not re.fullmatch(r'sn-claim-[0-9a-f]{32}', code) or result.get('ttl_seconds') != 600:
        raise ClaimError('Invalid claim response. Generate a new code after checking the server setup.')
    return code


def cancel_claim(root, expected_device, code):
    if not re.fullmatch(r'sn-claim-[0-9a-f]{32}', code or ''):
        raise ClaimError('No active claim code to revoke.')
    _request(root, expected_device, 'cancel_device_claim',
             {'p_code_hash': hashlib.sha256(code.encode('utf-8')).hexdigest()})


def read_home_code(root, expected_device, with_name=False):
    """Read-only authenticated device metadata, never persisted or sent to a browser."""
    result = _request(root, expected_device, 'device_setup_info', migration='cloud/home_identity.sql')
    code = result.get('home_code')
    if result.get('device_id') != expected_device or not isinstance(code, str) or not re.fullmatch(r'Home-[0-9]{3,19}', code):
        raise ClaimError('Home ID unavailable. Check device registration and server setup.')
    if with_name:
        name = result.get('home_name', 'Monitored home')
        if not isinstance(name, str) or len(name) > 80 or any(not c.isprintable() for c in name):
            raise ClaimError('Home information could not be verified.')
        return {'home_code':code, 'home_name':name}
    return code
