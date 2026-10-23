"""Local, credential-free camera settings and a process-wide capture lease."""
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import uuid


class DeviceSetupError(ValueError):
    pass


def environment(root, overrides=None):
    from dotenv import dotenv_values
    try:
        file_values = dotenv_values(Path(root) / '.env', interpolate=False)
    except (OSError, UnicodeError):
        raise DeviceSetupError('Local environment file cannot be read; check it before starting.') from None
    values = dict(file_values)
    values.update(os.environ if overrides is None else overrides)
    return values


def source_index(value):
    if isinstance(value, bool) or not re.fullmatch(r'\d{1,2}', str(value)) or not 0 <= int(value) <= 31:
        raise DeviceSetupError('Camera index must be an integer from 0 to 31.')
    return int(value)


def profile_name(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', value):
        raise DeviceSetupError('View profile needs 1–64 letters, digits, underscores or hyphens.')
    return value


def label(value):
    if not isinstance(value, str) or not value.strip() or len(value.strip()) > 80 or any(not c.isprintable() for c in value):
        raise DeviceSetupError('Room and camera names need 1–80 printable characters.')
    return value.strip()


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = json.dumps(value, indent=2, ensure_ascii=False)
    if len(raw.encode('utf-8')) > 65536:
        raise DeviceSetupError('Too many saved setups; keep the settings file below 64 KiB.')
    fd, tmp = tempfile.mkstemp(prefix=path.name + '.', suffix='.tmp', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            stream.write(raw)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)


@dataclass(frozen=True)
class CameraSettings:
    scope: str
    source: int
    profile: str
    room: str
    camera_name: str

    @property
    def key(self):
        return hashlib.sha256(f'{self.scope}\0{self.source}\0{self.profile}'.encode()).hexdigest()

    def calibration_path(self, root):
        from camera_catalog import CameraCatalog
        for camera, binding in CameraCatalog(root).entries():
            if camera.key == self.key:
                return Path(root) / 'camera_profiles' / 'cameras' / binding['camera_id'] / (self.key + '.json')
        return Path(root) / 'camera_profiles' / 'devices' / (self.key + '.json')


class SettingsStore:
    def __init__(self, root, environ=None):
        self.root = Path(root)
        self.path = self.root / 'device_settings.json'
        values = environment(root, environ)
        raw_id = values.get('SAFENEST_DEVICE_ID', '') or ''
        try:
            device_id = str(uuid.UUID(raw_id)) if raw_id else ''
        except (ValueError, AttributeError, TypeError):
            device_id = ''
        self.camera_key = values.get('SAFENEST_CAMERA_KEY', '')
        self.device_id = device_id
        self.device_status = ('Device ID invalid; local setup only. Cloud access is not verified.' if raw_id and not device_id
            else 'Local only: no cloud device ID configured.' if not device_id
            else f'Device {device_id[:8]}… · ' + ('Credentials present locally; not verified online.'
                if len(values.get('SAFENEST_DEVICE_TOKEN', '') or '') >= 32 else 'Device credentials missing or incomplete.'))
        self.defaults = (values.get('SAFENEST_ROOM') or 'Living room',
                         values.get('SAFENEST_CAMERA_NAME') or 'Laptop camera',
                         profile_name(values.get('SAFENEST_CAMERA_PROFILE', 'default')))
        try:
            if self.path.stat().st_size > 65536: raise ValueError()
            data = json.loads(self.path.read_text(encoding='utf-8'))
            if data.get('version') != 1 or not isinstance(data.get('selected'), dict) or not isinstance(data.get('setups'), dict):
                raise ValueError()
            uuid.UUID(data['local_id'])
            for key, item in data['setups'].items():
                camera = self.decode(item)
                if key != camera.key: raise ValueError()
            for scope, key in data['selected'].items():
                if key not in data['setups'] or data['setups'][key]['scope'] != scope: raise ValueError()
            self.data = data
        except FileNotFoundError:
            self.data = {'version':1, 'local_id':str(uuid.uuid4()), 'selected':{}, 'setups':{}}
        except (OSError, UnicodeError, ValueError, KeyError, TypeError, AttributeError):
            raise DeviceSetupError('Saved device settings are invalid. Keep a backup and repair or rename device_settings.json; it was not overwritten.') from None
        self.scope = self.device_id or 'local-' + self.data['local_id']

    @staticmethod
    def decode(item):
        scope = item['scope']
        if not isinstance(scope, str): raise ValueError()
        uuid.UUID(scope.removeprefix('local-'))
        return CameraSettings(scope, source_index(item['source']), profile_name(item['profile']),
                              label(item['room']), label(item['camera_name']))

    def ensure(self):
        if not self.path.exists(): atomic_json(self.path, self.data)
        return self

    def selection(self, source, profile):
        value = CameraSettings(self.scope, source_index(source), profile_name(profile),
                               label(self.defaults[0]), label(self.defaults[1]))
        item = self.data['setups'].get(value.key)
        return self.decode(item) if item else value

    def current(self):
        key = self.camera_key or self.data['selected'].get(self.scope)
        if key and (key not in self.data['setups'] or self.data['setups'][key]['scope'] != self.scope):
            raise DeviceSetupError('Selected camera belongs to another device or is unavailable.')
        return self.decode(self.data['setups'][key]) if key else self.selection(0, self.defaults[2])

    def save(self, source, profile, room, camera_name):
        camera = CameraSettings(self.scope, source_index(source), profile_name(profile), label(room), label(camera_name))
        # Build first; failed writes leave both memory and the previous file intact.
        data = {**self.data, 'selected':{**self.data['selected'], self.scope:camera.key},
                'setups':{**self.data['setups'], camera.key:camera.__dict__}}
        atomic_json(self.path, data)
        self.data = data
        return camera


class CaptureLease:
    """One scanner/preview/detector per project; the OS releases locks on exit."""
    def __init__(self, root):
        self.path = Path(root) / 'camera_capture.lock'
        self.stream = None

    def __enter__(self):
        self.stream = self.path.open('a+b')
        try:
            self.stream.seek(0, 2)
            if self.stream.tell() == 0:
                self.stream.write(b'0'); self.stream.flush()
            self.stream.seek(0)
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(self.stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.stream.close(); self.stream = None
            raise DeviceSetupError('Camera is in use by this project. Close the preview or stop monitoring with Q first.') from None
        return self

    def __exit__(self, *args):
        if self.stream:
            self.stream.close(); self.stream = None
