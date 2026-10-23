"""Local Camera IDs, no credentials. Device-scoped settings and server authority."""
import json
import re
from pathlib import Path
from uuid import UUID
from device_settings import SettingsStore, DeviceSetupError, atomic_json
from device_claim import _request, ClaimError


class CameraCatalog:
    def __init__(self, root):
        self.root = Path(root)
        self.store = SettingsStore(root)
        self.path = self.root / 'camera_sources.json'
        try:
            if self.path.stat().st_size > 65536: raise ValueError()
            data = json.loads(self.path.read_text(encoding='utf-8'))
            if data.get('version') != 1 or not isinstance(data.get('devices'), dict): raise ValueError()
            for device, items in data['devices'].items():
                UUID(device)
                if not isinstance(items, dict): raise ValueError()
                for key, item in items.items():
                    UUID(item['camera_id']); UUID(item['home_id'])
                    if not re.fullmatch('[0-9a-f]{64}', key): raise ValueError()
                    if not re.fullmatch(r'Home-[0-9]{3,19}', item['home_code']): raise ValueError()
            self.data = data
        except FileNotFoundError:
            self.data = {'version': 1, 'devices': {}}
        except (ValueError, KeyError, TypeError, OSError):
            raise DeviceSetupError('Camera catalog is invalid. Back up and repair camera_sources.json; it was not overwritten.') from None

    def entries(self):
        items = self.data['devices'].get(self.store.device_id, {})
        result = []
        for key, item in items.items():
            saved = self.store.data['setups'].get(key)
            if saved and saved['scope'] == self.store.scope:
                result.append((self.store.decode(saved), dict(item)))
        return result

    def register(self, camera):
        if not self.store.device_id or camera.scope != self.store.device_id:
            raise DeviceSetupError('Register this monitoring computer first. Camera IDs cannot be shared between devices.')
        items = dict(self.data['devices'].get(self.store.device_id, {}))
        # One active view per physical input; different angles must be re-confirmed.
        for key in list(items):
            saved = self.store.data['setups'].get(key)
            if saved and saved['source'] == camera.source and key != camera.key:
                raise DeviceSetupError('This camera index is already registered with another view profile. Use that profile or remove its local entry first.')
        result = _request(self.root, self.store.device_id, 'register_camera',
            {'p_key': camera.key, 'p_name': camera.camera_name, 'p_room':camera.room}, migration='cloud/multi_camera_homes.sql')
        try:
            camera_id = str(UUID(result['camera_id'])); home_id = str(UUID(result['home_id']))
            code = result['home_code']
            if result['device_id'] != self.store.device_id or not re.fullmatch(r'Home-[0-9]{3,19}', code): raise ValueError()
        except (ValueError, KeyError, TypeError):
            raise ClaimError('Camera registration could not be verified. Refresh Home ID and retry.') from None
        item = {'camera_id': camera_id, 'home_id': home_id, 'home_code': code,
                'is_default': result.get('is_default') is True}
        items[camera.key] = item
        data = {'version': 1, 'devices': {**self.data['devices'], self.store.device_id: items}}
        # Preserve a legacy saved outline. Loading still requires current-view verification.
        old = self.root / 'camera_profiles' / 'devices' / (camera.key + '.json')
        new = self.root / 'camera_profiles' / 'cameras' / camera_id / (camera.key + '.json')
        if old.exists() and not new.exists():
            import shutil
            new.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(old, new)
        atomic_json(self.path, data); self.data = data
        return item

    def remove_local(self, key):
        items = dict(self.data['devices'].get(self.store.device_id, {})); items.pop(key, None)
        data = {'version': 1, 'devices': {**self.data['devices'], self.store.device_id: items}}
        atomic_json(self.path, data); self.data = data


def pair_device(root, device, code):
    # Never persist the setup code; the server maps this exact local device to a Home.
    result = _request(root, device, 'pair_camera_device', {'p_code': code.strip()}, migration='cloud/multi_camera_homes.sql')
    try:
        if result['device_id'] != device: raise ValueError()
        UUID(result['home_id'])
    except (ValueError,KeyError,TypeError):
        raise ClaimError('Camera setup could not be verified. Refresh Home ID before retrying.') from None
    return result
