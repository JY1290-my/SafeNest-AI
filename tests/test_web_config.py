"""Exercise generated CSP/config in an isolated copy without any real secrets."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

BASE = Path(__file__).resolve().parents[1]


class WebConfigTests(unittest.TestCase):
    def generate(self, video):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'web').mkdir()
            shutil.copy(BASE / 'configure_web.py', root / 'configure_web.py')
            shutil.copy(BASE / 'web/vercel.json', root / 'web/vercel.json')
            env = {**os.environ, 'SUPABASE_URL': 'https://test.supabase.co',
                   'SUPABASE_PUBLISHABLE_KEY': 'sb_publishable_test',
                   'SAFENEST_DEVICE_ID': '10000000-0000-4000-8000-000000000001',
                   'SAFENEST_DEVICE_TOKEN': 'private-device-token-for-test-only',
                   'SAFENEST_VIDEO_ENABLED': '1' if video else '0',
                   'LIVEKIT_URL': 'wss://test.livekit.cloud',
                   'SAFENEST_VIDEO_EXTRA_ORIGINS': '[]'}
            subprocess.run([sys.executable, str(root / 'configure_web.py')],
                           env=env, check=True, capture_output=True, text=True)
            config = (root / 'web/config.js').read_text(encoding='utf-8')
            headers = json.loads((root / 'web/vercel.json').read_text(encoding='utf-8'))['headers'][0]['headers']
            csp = next(h['value'] for h in headers if h['key'] == 'Content-Security-Policy')
            self.assertNotIn(env['SAFENEST_DEVICE_TOKEN'], config)
            self.assertNotIn('SAFENEST_DEVICE_TOKEN', config)
            self.assertIn('https://test.supabase.co', csp)
            self.assertIn('wss://test.supabase.co', csp)
            self.assertNotIn('connect-src *', csp)
            return config, csp

    def test_realtime_allowed_when_remote_video_is_disabled(self):
        config, csp = self.generate(False)
        self.assertIn('"videoEnabled": false', config)
        self.assertNotIn('wss://test.livekit.cloud', csp)

    def test_video_and_realtime_endpoints_are_both_allowed(self):
        config, csp = self.generate(True)
        self.assertIn('"videoEnabled": true', config)
        self.assertIn('wss://test.livekit.cloud', csp)
        self.assertIn('https://test.livekit.cloud', csp)


if __name__ == '__main__':
    unittest.main()
