"""Local entry and HTTP boundary tests; no camera, Tk display or model required."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from camera_setup import DetectorLauncher, SetupError, public_settings, check_runtime
from monitor_bridge import MonitorState, create_local_app


class CameraSetupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / 'fall_detection.py').write_text('# not executed', encoding='utf-8')
        (self.root / 'yolo11n-pose.pt').write_bytes(b'mock model, never loaded')

    def test_labels_only_do_not_expose_or_modify_credentials(self):
        envfile = self.root / '.env'
        contents = ('SAFENEST_ROOM=Bedroom\nSAFENEST_CAMERA_NAME=Desk camera\n'
                    'SAFENEST_CAMERA_PROFILE=bedroom\nSAFENEST_DEVICE_TOKEN=secret-device-token\n'
                    'LIVEKIT_API_SECRET=secret-livekit\nSUPABASE_URL=https://private.example\n')
        envfile.write_text(contents, encoding='utf-8')
        before = dict(os.environ)
        value = public_settings(self.root, {'SAFENEST_ROOM':'Living room'})
        self.assertEqual(value, {'SAFENEST_ROOM':'Living room', 'SAFENEST_CAMERA_NAME':'Desk camera',
                                 'SAFENEST_CAMERA_PROFILE':'bedroom'})
        self.assertNotIn('secret', repr(value))
        self.assertEqual(envfile.read_text(encoding='utf-8'), contents)
        self.assertEqual(dict(os.environ), before)

    def test_defaults_work_without_local_configuration(self):
        value = public_settings(self.root, {})
        self.assertEqual(value['SAFENEST_CAMERA_PROFILE'], 'default')
        self.assertEqual(value['SAFENEST_CAMERA_NAME'], 'Laptop camera')

    def test_start_is_explicit_uses_fixed_script_and_never_a_shell(self):
        child = Mock(); child.poll.return_value = None
        popen = Mock(return_value=child)
        launcher = DetectorLauncher(self.root, executable='safe-python', popen=popen, check=lambda:None)
        popen.assert_not_called()
        self.assertTrue(launcher.start())
        args, kwargs = popen.call_args
        self.assertEqual(args[0], ['safe-python', str(self.root / 'fall_detection.py')])
        self.assertEqual(kwargs['cwd'], str(self.root))
        self.assertIs(kwargs['shell'], False)
        self.assertTrue(launcher.running)
        self.assertFalse(launcher.start())
        self.assertEqual(popen.call_count, 1)
        child.terminate.assert_not_called()

    def test_restart_only_after_process_exits(self):
        child = Mock(); child.poll.return_value = None
        popen = Mock(return_value=child)
        launcher = DetectorLauncher(self.root, popen=popen, check=lambda:None)
        launcher.start(); child.poll.return_value = 0
        self.assertFalse(launcher.running)
        launcher.start(); self.assertEqual(popen.call_count, 2)

    def test_missing_model_or_script_does_not_start_or_download(self):
        popen = Mock()
        launcher = DetectorLauncher(self.root, popen=popen, check=lambda:None)
        (self.root / 'yolo11n-pose.pt').unlink()
        with self.assertRaisesRegex(SetupError, 'model is missing'): launcher.start()
        (self.root / 'fall_detection.py').unlink()
        with self.assertRaisesRegex(SetupError, 'fall_detection.py is missing'): launcher.start()
        popen.assert_not_called()

    def test_missing_runtime_and_launch_failure_are_safe_and_retryable(self):
        with patch('camera_setup.importlib.util.find_spec', return_value=None):
            with self.assertRaisesRegex(SetupError, 'dependencies are missing'): check_runtime()
        popen = Mock(side_effect=OSError('sensitive host detail'))
        launcher = DetectorLauncher(self.root, popen=popen, check=lambda:None)
        with self.assertRaises(SetupError) as result: launcher.start()
        self.assertNotIn('sensitive', str(result.exception))
        self.assertFalse(launcher.running)

    def test_web_has_no_control_routes_and_cannot_download_local_setup_files(self):
        app = create_local_app(MonitorState(), 'test-password-long')
        client = app.test_client()
        for signed_in in (False, True):
            if signed_in:
                self.assertEqual(client.post('/api/login', json={'password':'test-password-long'}).status_code, 200)
            for route in ('/api/camera/start', '/api/camera/stop', '/api/calibration', '/api/device/setup'):
                self.assertEqual(client.post(route, json={}).status_code, 405)
            for route in ('/camera_setup.py', '/Start_Camera_Setup.cmd', '/camera_profiles/default.json'):
                self.assertEqual(client.get(route).status_code, 404)
        self.assertEqual(client.post('/api/login', json={'password':'test-password-long'},
                                     headers={'Origin':'https://family.example'}).status_code, 403)


if __name__ == '__main__':
    unittest.main()
