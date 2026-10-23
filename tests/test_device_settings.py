"""Local setup regression tests: no physical camera, model weights or cloud access."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

import numpy as np

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE))
from device_settings import SettingsStore, CaptureLease, DeviceSetupError
from camera_preview import scan_cameras, preview
from camera_setup import DetectorLauncher, SetupError
from room_calibration import RoomCalibration, CalibrationUI

A = '11111111-1111-4111-8111-111111111111'
B = '22222222-2222-4222-8222-222222222222'
POLY = [(0.2,0.2),(0.8,0.2),(0.8,0.8),(0.2,0.8)]
SIZE = (640,480)


class LocalSetupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        env = patch.dict(os.environ, {}, clear=True)
        env.start(); self.addCleanup(env.stop)

    def store(self, identity=A):
        return SettingsStore(self.root, {'SAFENEST_DEVICE_ID':identity})

    def calibration(self, camera):
        return RoomCalibration(camera.calibration_path(self.root), str(camera.source), camera.profile,
                               device_scope=camera.scope)

    def test_save_reload_names_camera_and_profile_without_secrets(self):
        secret = 'not-for-the-ui-or-json-' * 3
        env = self.root / '.env'
        original = f'SAFENEST_DEVICE_ID={A}\nSAFENEST_DEVICE_TOKEN={secret}\nLIVEKIT_API_SECRET={secret}\n'
        env.write_text(original)
        store = SettingsStore(self.root)
        saved = store.save(3, 'bedroom_right', ' Bedroom ', ' USB camera ')
        self.assertEqual(SettingsStore(self.root).current(), saved)
        self.assertEqual((saved.source,saved.room,saved.camera_name), (3,'Bedroom','USB camera'))
        self.assertIn('not verified online',store.device_status)
        self.assertNotIn(secret,store.device_status)
        raw = (self.root/'device_settings.json').read_text()
        self.assertNotIn(secret,raw)
        self.assertNotIn('TOKEN',raw)
        self.assertEqual(env.read_text(),original)

    def test_local_identity_persists_before_first_selection_and_cloud_scope_is_separate(self):
        local = self.store('').ensure()
        self.assertEqual(local.scope,self.store('').scope)
        saved = local.save(2,'local','Local room','Local camera')
        cloud = self.store()
        self.assertEqual(cloud.current().source,0)
        self.assertNotEqual(cloud.current().calibration_path(self.root),saved.calibration_path(self.root))
        cloud.save(4,'cloud','Cloud room','Cloud camera')
        self.assertEqual(self.store('').current(),saved)

    def test_two_device_ids_do_not_share_selection_names_or_geometry(self):
        first = self.store().save(1,'bed','Room A','Camera A')
        self.calibration(first).confirm(POLY,SIZE)
        second = self.store(B)
        self.assertEqual(second.current().source,0)
        other = second.save(1,'bed','Room B','Camera B')
        self.assertFalse(self.calibration(other).polygon)
        self.assertNotEqual(first.calibration_path(self.root),other.calibration_path(self.root))
        self.assertEqual(self.store().current(),first)

    def test_camera_and_view_profiles_have_independent_names_and_outlines(self):
        store = self.store()
        first = store.save(0,'front','Room','Front')
        self.calibration(first).confirm(POLY,SIZE)
        side = store.save(0,'side','Room','Side')
        usb = store.save(1,'front','Room','USB')
        for value in (side,usb):self.assertFalse(self.calibration(value).polygon)
        self.assertEqual(store.selection(0,'front'),first)
        self.assertEqual(len({x.calibration_path(self.root) for x in (first,side,usb)}),3)

    def test_invalid_identity_is_local_only_and_never_echoed(self):
        store = self.store('not-an-id-sensitive-value')
        self.assertTrue(store.scope.startswith('local-'))
        self.assertIn('invalid',store.device_status)
        self.assertNotIn('sensitive',store.device_status)

    def test_invalid_input_leaves_previous_settings_unchanged(self):
        store = self.store();store.save(0,'front','Room','Camera')
        before = store.path.read_bytes()
        for source,profile,room,name in [(-1,'front','Room','Camera'),(32,'front','Room','Camera'),
            (True,'front','Room','Camera'),('https://camera','front','Room','Camera'),
            (0,'../other','Room','Camera'),(0,'front','','Camera'),(0,'front','Room','x'*81),
            (0,'front','Room\nsecret','Camera')]:
            with self.subTest(source=source,profile=profile):
                with self.assertRaises(DeviceSetupError):store.save(source,profile,room,name)
                self.assertEqual(store.path.read_bytes(),before)

    def test_corrupt_or_cross_scope_selection_is_rejected_without_overwrite(self):
        store = self.store();saved=store.save(0,'front','Room','Camera')
        data=json.loads(store.path.read_text());data['selected'][B]=saved.key
        store.path.write_text(json.dumps(data));before=store.path.read_bytes()
        with self.assertRaises(DeviceSetupError):self.store()
        self.assertEqual(store.path.read_bytes(),before)
        store.path.write_bytes(b'not JSON')
        with self.assertRaises(DeviceSetupError):self.store()
        self.assertEqual(store.path.read_bytes(),b'not JSON')

    def test_atomic_write_error_keeps_previous_selection_and_file(self):
        store=self.store();saved=store.save(0,'front','Room','Camera');before=store.path.read_bytes()
        with patch('device_settings.os.replace',side_effect=OSError('write denied')):
            with self.assertRaises(OSError):store.save(1,'front','Other','Other')
        self.assertEqual(store.current(),saved)
        self.assertEqual(store.path.read_bytes(),before)
        self.assertEqual(list(self.root.glob('*.tmp')),[])

    def test_scoped_calibration_checks_identity_source_profile_and_never_auto_verifies(self):
        camera=self.store().save(2,'bed','Room','Camera');cal=self.calibration(camera)
        cal.confirm(POLY,SIZE)
        raw=json.loads(cal.path.read_text())
        self.assertEqual(set(raw),{'version','device_scope','source','profile','resolution','bed_polygon'})
        self.assertEqual(raw['version'],2)
        reopened=self.calibration(camera)
        self.assertTrue(reopened.polygon);self.assertFalse(reopened.active);self.assertFalse(reopened.verified)
        for source,profile,scope in [('2','bed',B),('1','bed',A),('2','other',A)]:
            other=RoomCalibration(cal.path,source,profile,device_scope=scope)
            self.assertFalse(other.polygon);self.assertFalse(other.active)

    def test_legacy_unscoped_geometry_is_kept_but_not_automatically_trusted(self):
        camera=self.store().save(0,'default','Room','Camera')
        old=RoomCalibration(self.root/'camera_profiles/default.json')
        old.confirm(POLY,SIZE);before=old.path.read_bytes()
        self.assertFalse(self.calibration(camera).polygon)
        self.assertEqual(old.path.read_bytes(),before)
        self.assertFalse(RoomCalibration(old.path,device_scope=A).polygon)

    def make_ui(self):
        cal=self.calibration(self.store().save(0,'bed','Room','Camera'));cal.confirm(POLY,SIZE)
        cv=Mock();cv.error=RuntimeError
        cv.EVENT_LBUTTONDOWN=1;cv.EVENT_MOUSEMOVE=0;cv.EVENT_LBUTTONUP=4;cv.EVENT_RBUTTONDOWN=2
        ui=CalibrationUI(cv,'test',cal);ui.size=SIZE;ui.guard=Mock();ui.guard.capture.return_value=True
        return cal,ui,cv

    def test_supported_view_change_invalidates_old_outline_and_cannot_auto_recover(self):
        cal,ui,cv=self.make_ui();frame=np.zeros((480,640,3),np.uint8)
        ui.guard.check.return_value='Camera view changed; recalibrate'
        ui.observe(frame,[],1)
        self.assertFalse(cal.active);self.assertEqual(cal.verification_state,'view_changed')
        self.assertEqual(cal.zone(None,None,SIZE),'unknown')
        ui.guard.check.return_value='verified';ui.observe(frame,[],2)
        self.assertFalse(cal.active)
        self.assertTrue(self.calibration(self.store().current()).polygon)
        self.assertFalse(self.calibration(self.store().current()).active)

    def test_edit_drag_confirm_and_cancel_do_not_reactivate_old_calibration(self):
        cal,ui,cv=self.make_ui();frame=np.zeros((480,640,3),np.uint8)
        ui.handle(ord('e'),frame,[]);self.assertFalse(cal.active)
        ui.mouse(cv.EVENT_LBUTTONDOWN,128,124,0,None)
        ui.mouse(cv.EVENT_MOUSEMOVE,96,100,0,None)
        ui.mouse(cv.EVENT_LBUTTONUP,96,100,0,None)
        self.assertEqual(ui.points[0],(.15,.15))
        ui.handle(13,frame,[])
        self.assertTrue(cal.active);self.assertEqual(cal.polygon[0],(.15,.15))
        ui.handle(ord('e'),frame,[]);ui.handle(27,frame,[])
        self.assertFalse(cal.active)

    def test_invalid_polygon_or_save_failure_leaves_calibration_inactive(self):
        cal,ui,cv=self.make_ui();frame=np.zeros((480,640,3),np.uint8);before=cal.path.read_bytes()
        ui.begin();ui.points=[(.1,.1),(.9,.9),(.1,.9),(.9,.1)]
        ui.handle(13,frame,[]);self.assertFalse(cal.active)
        self.assertEqual(cal.path.read_bytes(),before)
        ui.points=list(POLY)
        with patch.object(cal,'confirm',side_effect=OSError('Cannot save calibration')):ui.handle(13,frame,[])
        self.assertFalse(cal.active);self.assertIn('Cannot save',ui.message)
        self.assertEqual(cal.path.read_bytes(),before)

    def test_camera_scan_only_lists_readable_cameras_and_releases_each_capture(self):
        caps=[Mock(),Mock(),Mock()]
        caps[0].isOpened.return_value=False
        caps[1].isOpened.return_value=True;caps[1].read.return_value=(True,np.zeros((2,2,3)))
        caps[2].isOpened.return_value=True;caps[2].read.side_effect=RuntimeError('driver')
        cv=Mock();cv.VideoCapture.side_effect=caps
        self.assertEqual(scan_cameras(cv,range(3)),[1])
        for cap in caps:cap.release.assert_called_once()

    def test_preview_uses_selected_camera_and_releases_on_close_or_disconnect(self):
        self.store('').save(3,'view','Room','Camera')
        frame=np.zeros((480,640,3),np.uint8)
        for ok in (True,False):
            with self.subTest(connected=ok):
                cv=Mock();cap=cv.VideoCapture.return_value;cap.isOpened.return_value=True
                cap.read.return_value=(ok,frame if ok else None);cv.waitKey.return_value=ord('q')
                with patch('camera_preview.CalibrationUI') as ctor:
                    if ok:preview(cv,self.root)
                    else:
                        with self.assertRaisesRegex(DeviceSetupError,'disconnected'):preview(cv,self.root)
                    cv.VideoCapture.assert_called_once_with(3)
                    cap.release.assert_called_once();cv.destroyAllWindows.assert_called_once()
                    if ok:
                        cal=ctor.call_args.args[2]
                        self.assertEqual(cal.source,'3');self.assertFalse(cal.active)
                        ctor.return_value.observe.assert_called_once()

    def test_camera_lock_blocks_other_capture_processes_and_releases_after_exception(self):
        with CaptureLease(self.root):
            with self.assertRaises(DeviceSetupError):
                with CaptureLease(self.root):pass
        with self.assertRaises(RuntimeError):
            with CaptureLease(self.root):raise RuntimeError('exit')
        with CaptureLease(self.root):pass

    def test_preview_needs_no_model_and_cannot_start_second_capture(self):
        (self.root/'camera_preview.py').write_text('# mock')
        child=Mock();child.poll.return_value=None
        popen=Mock(return_value=child)
        launcher=DetectorLauncher(self.root,popen=popen,check=Mock(side_effect=AssertionError('model checked')))
        self.assertTrue(launcher.preview());self.assertFalse(launcher.start());self.assertFalse(launcher.scan())
        self.assertEqual(popen.call_count,1)
        self.assertEqual(popen.call_args.args[0][-1],str(self.root/'camera_preview.py'))
        launcher.stop_setup();child.terminate.assert_called_once()
        child.terminate.reset_mock();launcher.mode='monitor';launcher.stop_setup();child.terminate.assert_not_called()

    def test_scan_launch_is_explicit_and_an_existing_capture_lease_prevents_start(self):
        (self.root/'camera_preview.py').write_text('# mock')
        child=Mock();child.poll.return_value=None;popen=Mock(return_value=child)
        launcher=DetectorLauncher(self.root,popen=popen)
        with CaptureLease(self.root):
            with self.assertRaises(SetupError):launcher.scan()
        popen.assert_not_called()
        launcher.scan()
        self.assertEqual(popen.call_args.args[0][-1],'--scan')
        self.assertFalse(popen.call_args.kwargs['shell'])
        self.assertIsNotNone(launcher.scan_deadline)

    def test_bridge_uses_saved_names_in_existing_snapshot_without_secrets(self):
        os.environ['SAFENEST_DEVICE_ID']=A
        self.store().save(3,'front','Bedroom','Bedside camera')
        import monitor_bridge
        with patch.object(monitor_bridge,'BASE',self.root), patch.object(monitor_bridge,'CloudPublisher'), patch('video_publisher.VideoPublisher'):
            bridge=monitor_bridge.MonitorBridge()
        self.assertEqual(bridge.device_setup.source,3)
        snapshot=bridge.state.snapshot()
        self.assertEqual(snapshot['room'],'Bedroom')
        self.assertEqual(snapshot['camera_name'],'Bedside camera')
        self.assertNotIn('device_scope',snapshot)

    def test_detector_uses_selected_source_and_scoped_calibration(self):
        cv=Mock();cv.VideoCapture.return_value.isOpened.return_value=True
        cv.VideoCapture.return_value.read.return_value=(False,None)
        modules={'cv2':cv,'winsound':Mock(),'ultralytics':types.SimpleNamespace(YOLO=Mock())}
        with patch.dict(sys.modules,modules):
            spec=importlib.util.spec_from_file_location('setup_detector_test',BASE/'fall_detection.py')
            detector=importlib.util.module_from_spec(spec);spec.loader.exec_module(detector)
        detector.__file__=str(self.root/'fall_detection.py')
        bridge=Mock();bridge.device_setup=self.store().save(4,'side','Room','Side camera')
        with patch.object(detector,'CalibrationUI'),patch.object(detector,'RoomCalibration') as ctor,patch.object(detector.NativeTracker,'create'):
            detector.run_detector(bridge)
        cv.VideoCapture.assert_called_once_with(4)
        self.assertEqual(ctor.call_args.kwargs,{'source':'4','profile':'side','device_scope':A})
        cv.VideoCapture.return_value.release.assert_called_once()


if __name__=='__main__':unittest.main()
