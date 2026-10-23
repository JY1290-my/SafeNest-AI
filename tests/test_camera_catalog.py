import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch
from camera_catalog import CameraCatalog, pair_device
from device_settings import SettingsStore, DeviceSetupError
from device_claim import ClaimError
from multi_camera_runner import worker_spec, run_all

D='10000000-0000-4000-8000-000000000001'
E='10000000-0000-4000-8000-000000000002'
C1='30000000-0000-4000-8000-000000000001'
C2='30000000-0000-4000-8000-000000000002'

class CameraCatalogTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
        env=patch.dict(os.environ,{'SAFENEST_DEVICE_ID':D},clear=True);env.start();self.addCleanup(env.stop)
        self.one=SettingsStore(self.root).save(0,'front','Bedroom','Bedside')
        self.two=SettingsStore(self.root).save(1,'door','Bedroom','Door')
        self.reply=lambda cam,default=False:{'ok':True,'device_id':D,'camera_id':cam,'home_id':D,'home_code':'Home-001','is_default':default}

    def register(self):
        with patch('camera_catalog._request',side_effect=[self.reply(C1,True),self.reply(C2)]):
            catalog=CameraCatalog(self.root);catalog.register(self.one);catalog.register(self.two)

    def test_registration_is_explicit_idempotent_and_different_devices_do_not_inherit_it(self):
        with patch('camera_catalog._request') as request:
            self.assertEqual(CameraCatalog(self.root).entries(),[]);request.assert_not_called()
        self.register()
        with patch('camera_catalog._request',return_value=self.reply(C1,True)):
            CameraCatalog(self.root).register(self.one)
        self.assertEqual(len(CameraCatalog(self.root).entries()),2)
        os.environ['SAFENEST_DEVICE_ID']=E
        self.assertEqual(CameraCatalog(self.root).entries(),[])
        with self.assertRaises(DeviceSetupError):worker_spec(self.root,self.one.key)

    def test_calibration_and_logs_scoped_to_camera_and_view_preserve_old_outline(self):
        old=self.one.calibration_path(self.root);old.parent.mkdir(parents=True);old.write_text('{"saved":"outline"}')
        self.register();new=self.one.calibration_path(self.root)
        self.assertIn(C1,str(new));self.assertNotEqual(new,self.two.calibration_path(self.root));self.assertEqual(new.read_bytes(),old.read_bytes())
        # RoomCalibration still loads it as unverified: no image reference is copied.
        from room_calibration import RoomCalibration
        cal=RoomCalibration(new,str(self.one.source),self.one.profile,device_scope=D)
        self.assertFalse(cal.verified)

    def test_server_failure_or_wrong_identity_does_not_create_a_local_binding(self):
        for result in [self.reply('not-a-uuid'),{**self.reply(C1),'device_id':E}]:
            with patch('camera_catalog._request',return_value=result),self.assertRaises(ClaimError):CameraCatalog(self.root).register(self.one)
            self.assertFalse((self.root/'camera_sources.json').exists())
        with patch('camera_catalog._request',side_effect=ClaimError('Unavailable')),self.assertRaises(ClaimError):CameraCatalog(self.root).register(self.one)
        self.assertEqual(CameraCatalog(self.root).entries(),[])

    def test_reset_marker_prevents_reimporting_a_legacy_outline_on_registration(self):
        from room_calibration import RoomCalibration
        def calibration():
            return RoomCalibration(self.one.calibration_path(self.root),str(self.one.source),
                                   self.one.profile,device_scope=D)
        calibration().confirm([(.2,.2),(.8,.2),(.8,.8),(.2,.8)],(640,480))
        self.register()
        calibration().clear()
        with patch('camera_catalog._request',return_value=self.reply(C1,True)):
            CameraCatalog(self.root).register(self.one)
        reopened=calibration()
        self.assertEqual(reopened.polygon,[])
        self.assertEqual(reopened.verification_label(0),'needs calibration')

    def test_same_physical_index_cannot_be_started_twice_under_two_profiles(self):
        self.register();other=SettingsStore(self.root).save(0,'rotated','Bedroom','Other view')
        with patch('camera_catalog._request') as request,self.assertRaises(DeviceSetupError):CameraCatalog(self.root).register(other)
        request.assert_not_called()

    def test_pairing_does_not_save_code_or_device_credentials(self):
        code='sn-camera-'+'a'*32
        with patch('camera_catalog._request',return_value={'ok':True,'device_id':D,'home_id':E}) as request:
            pair_device(self.root,D,code);self.assertEqual(request.call_args.args[2],'pair_camera_device')
        for f in self.root.glob('*.json'):self.assertNotIn(code,f.read_text())
        with patch('camera_catalog._request',return_value={'ok':True,'device_id':E,'home_id':E}),self.assertRaises(ClaimError):pair_device(self.root,D,code)

    def test_supervisor_starts_independent_workers_with_no_secrets_in_arguments(self):
        self.register();a=Mock();a.poll.side_effect=[None,0,0,0];b=Mock();b.poll.return_value=0
        spawn=Mock(side_effect=[a,b]);run_all(self.root,popen=spawn,wait=lambda _:None)
        self.assertEqual(spawn.call_count,2)
        argv=[call.args[0] for call in spawn.call_args_list]
        self.assertEqual({v[-1] for v in argv},{self.one.key,self.two.key})
        self.assertTrue(all('--worker' in v for v in argv));self.assertNotIn('token',str(argv))
        a.terminate.assert_not_called();b.terminate.assert_not_called()

    def test_partial_start_failure_cleans_started_workers(self):
        self.register();proc=Mock();proc.poll.return_value=None
        with self.assertRaises(OSError):run_all(self.root,popen=Mock(side_effect=[proc,OSError()]))
        proc.terminate.assert_called_once();proc.wait.assert_called_once()

    def test_removing_local_entry_never_deletes_calibration_or_cloud_history(self):
        self.register();cal=self.one.calibration_path(self.root);cal.parent.mkdir(parents=True);cal.write_text('saved')
        with patch('camera_catalog._request') as request:CameraCatalog(self.root).remove_local(self.one.key);request.assert_not_called()
        self.assertTrue(cal.exists());self.assertEqual(len(CameraCatalog(self.root).entries()),1)


class CameraWorkerIsolationTests(unittest.TestCase):
    setUp=CameraCatalogTests.setUp
    register=CameraCatalogTests.register
    # Run the actual orchestration with an injected detector and bridge, no model.
    def test_worker_capture_context_event_log_and_frames_are_isolated(self):
        self.register()
        from monitor_bridge import MonitorState
        from multi_camera_runner import run_worker
        seen=[]
        def bridge(log):
            obj=Mock();obj.state=MonitorState();obj.device_setup=SettingsStore(self.root).current();return obj
        def detect(obj):
            obj.state.update('Checking',True,frame=object())
            seen.append((os.environ['SAFENEST_CAMERA_ID'],obj, obj.device_setup.calibration_path(self.root)))
        import types
        with patch.dict('sys.modules',{'fall_detection':types.SimpleNamespace(run_detector=detect)}),patch('monitor_bridge.MonitorBridge',side_effect=bridge):
            run_worker(self.root,self.one.key);run_worker(self.root,self.two.key)
        self.assertEqual([x[0] for x in seen],[C1,C2]);self.assertIsNot(seen[0][1].state,seen[1][1].state)
        self.assertNotEqual(seen[0][1].log_path,seen[1][1].log_path);self.assertNotEqual(seen[0][2],seen[1][2])
        self.assertEqual(seen[0][1].log_path,self.root/'events.csv')
        for _,obj,_ in seen:obj.start.assert_called_once();obj.close.assert_called_once()



class CameraPublisherTests(unittest.TestCase):
    def test_selected_camera_is_explicit_in_status_and_video_requests_without_frames(self):
        from monitor_bridge import CloudPublisher,MonitorState
        from video_publisher import VideoPublisher
        env={'SAFENEST_DEVICE_ID':D,'SAFENEST_CAMERA_ID':C1,'SAFENEST_DEVICE_TOKEN':'x'*40,'SUPABASE_URL':'https://test.supabase.co','SUPABASE_PUBLISHABLE_KEY':'public'}
        with patch.dict(os.environ,env,clear=True):
            state=MonitorState();state.update('Normal',True,frame=object());status=CloudPublisher(state);video=VideoPublisher(state)
        session=Mock();session.post.return_value.status_code=200;session.post.return_value.json.return_value={}
        status._send(session);body=session.post.call_args.kwargs['json'];self.assertEqual(body['p_camera'],C1);self.assertEqual(body['p_device'],D);self.assertNotIn('frame',body['p_payload'])
        video._call(session,'sync');body=session.post.call_args.kwargs['json'];self.assertEqual(body['camera_id'],C1);self.assertEqual(body['device_id'],D)

if __name__=='__main__':unittest.main()
