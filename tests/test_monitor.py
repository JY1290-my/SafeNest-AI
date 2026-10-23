import ast
import csv
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from monitor_bridge import MonitorState, CloudPublisher, create_local_app
BASE = Path(__file__).resolve().parents[1]

class MonitoringTests(unittest.TestCase):
    def test_auth_and_private_files(self):
        state = MonitorState(); state.update('Normal', True)
        client = create_local_app(state, 'test-password-long').test_client()
        for endpoint in ['/api/status','/api/frame']:
            self.assertEqual(client.get(endpoint).status_code,401)
        for endpoint in ['/.env','/events.csv','/fall_detection.py','/multi_person.py','/../events.csv']:
            self.assertEqual(client.get(endpoint).status_code,404)
        for endpoint in ['/app.js','/dashboard.js','/cloud-client.js','/logic.js','/video-client.js',
                         '/camera-window.js','/camera-tools.js','/fall-alert.js','/family-alerts.js','/push-notifications.js','/family-view.js','/presence-client.js']:
            with client.get(endpoint) as response:
                self.assertEqual(response.status_code,200)
        self.assertEqual(client.post('/api/login',json=['bad']).status_code,400)
        self.assertEqual(client.post('/api/login',json={'password':'bad'}).status_code,401)
        self.assertEqual(client.post('/api/login',json={'password':'test-password-long'},headers={'Origin':'https://evil.example'}).status_code,403)
        self.assertEqual(client.post('/api/login',json={'password':'test-password-long'}).status_code,200)
        response=client.get('/api/status')
        self.assertEqual(response.json['payload']['status'],'Normal')
        self.assertEqual(response.headers['Cache-Control'],'no-store')
        self.assertIn("media-src 'self' blob:", response.headers['Content-Security-Policy'])
        self.assertEqual(client.get('/api/frame').status_code,503)
        self.assertGreater(state.frame_requested_until, time.monotonic())
        client.post('/api/logout'); self.assertEqual(client.get('/api/status').status_code,401)

    def test_stale_is_never_normal(self):
        state=MonitorState();state.update('Normal',True)
        state.updated_mono-=16
        value=state.snapshot()
        self.assertEqual(value['status'],'Connection Lost')
        self.assertFalse(value['camera_connected'])
        self.assertTrue(value['stale'])

    def test_csv_history_and_ids(self):
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'events.csv'
            with path.open('w',newline='') as f:
                writer=csv.writer(f);writer.writerow(['time','status','angle_deg','width_height_ratio'])
                for n in range(40):writer.writerow([str(n),'Normal','0','0.5'])
            a,b=MonitorState(path),MonitorState(path)
            self.assertEqual(len(a.events),30)
            self.assertEqual(a.events[0]['time'],'39')
            self.assertEqual(a.events[0]['id'],b.events[0]['id'])

    def test_metadata_only_and_timeouts(self):
        state=MonitorState(); state.frame_requested_until=time.monotonic()+10
        state.update('Normal',True,(0,0.5),frame=object())
        with patch.dict(os.environ,{'SUPABASE_URL':'https://test.supabase.co','SUPABASE_PUBLISHABLE_KEY':'public','SAFENEST_DEVICE_ID':'test','SAFENEST_DEVICE_TOKEN':'x'*40}):
            publisher=CloudPublisher(state)
            session=Mock();session.post.return_value.status_code=204
            publisher._send(session)
            args=session.post.call_args.kwargs
            payload=args['json']['p_payload']
            self.assertNotIn('frame',payload);json.dumps(payload)
            self.assertEqual(args['timeout'],(2,3))
            self.assertFalse(args['allow_redirects'])
            self.assertFalse(CloudPublisher(MonitorState(demo=True)).enabled)

    def test_network_failure_does_not_block_state(self):
        import requests
        with patch.dict(os.environ,{'SUPABASE_URL':'https://test.supabase.co','SUPABASE_PUBLISHABLE_KEY':'public','SAFENEST_DEVICE_ID':'test','SAFENEST_DEVICE_TOKEN':'x'*40}):
            state=MonitorState();publisher=CloudPublisher(state)
            called=threading.Event()
            def failed(*args,**kwargs):
                called.set();raise requests.ConnectionError('offline')
            with patch.object(publisher,'_send',side_effect=failed):
                publisher.start();self.assertTrue(called.wait(2))
                state.update('Suspected Fall',True)
                self.assertEqual(state.snapshot()['status'],'Suspected Fall')
                publisher.close()
            self.assertEqual(state.cloud_state,'Disconnected')

    def test_source_algorithm_unchanged(self):
        old=ast.parse((BASE/'original_source/fall_detection_before_video.py').read_text(encoding='utf-8'))
        new=ast.parse((BASE/'fall_detection.py').read_text(encoding='utf-8'))
        for name in ['pose_features','update_status']:
            a=next(n for n in old.body if isinstance(n,ast.FunctionDef) and n.name==name)
            b=next(n for n in new.body if isinstance(n,ast.FunctionDef) and n.name==name)
            self.assertEqual(ast.dump(a),ast.dump(b))
        for name in ['KEYPOINT_CONF','ANGLE_LIMIT','RATIO_LIMIT','CONFIRM_SECONDS']:
            def assignment(tree):return next(n for n in tree.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id==name for t in n.targets))
            self.assertEqual(ast.dump(assignment(old)),ast.dump(assignment(new)))
        def predicts(tree):return [ast.dump(n) for n in ast.walk(tree) if isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute) and n.func.attr=='predict']
        self.assertEqual(predicts(old),predicts(new))

    def test_real_capture_loop_integration_with_stubs(self):
        # Actual capture loop with two people and repeated confirmed-fall frames.
        import numpy as np
        class Tensor:
            def __init__(self,value):self.value=value
            def cpu(self):return self
            def numpy(self):return self.value
        class Boxes:
            def __init__(self,count):
                self.count=count
                self.xyxy=[Tensor([300*i,0,300*i+200,200]) for i in range(count)]
            def __len__(self):return self.count
        class Keypoints:
            def __init__(self,poses):
                self.xy=[];self.conf=[]
                for horizontal in poses:
                    points=[[0,0] for _ in range(17)]
                    points[5]=points[6]=[100,100] if horizontal else [0,0]
                    points[11]=points[12]=[0,100]
                    points[15]=points[16]=[100,100] if horizontal else [0,200]
                    self.xy.append(Tensor(points));self.conf.append(Tensor([1]*17))
            def __len__(self):return len(self.xy)
        def result(poses):
            return types.SimpleNamespace(boxes=Boxes(len(poses)),keypoints=Keypoints(poses),plot=lambda:np.zeros((480,640,3),dtype=np.uint8))
        results=[result([]),result([False]),result([False,False]),
                 result([False,True]),result([False,True]),result([False,True])]
        cap=Mock();cap.isOpened.return_value=True;cap.read.side_effect=[(True,np.zeros((480,640,3),dtype=np.uint8)) for _ in results]+[(False,None)]
        cv=Mock();cv.VideoCapture.return_value=cap;cv.waitKey.return_value=-1
        cv.getTextSize.return_value=((200,10),0)
        sound=Mock();model=Mock();model.predict.side_effect=[[r] for r in results]
        yolo=types.SimpleNamespace(YOLO=Mock(return_value=model))
        with patch.dict(sys.modules,{'cv2':cv,'winsound':sound,'ultralytics':yolo}):
            spec=importlib.util.spec_from_file_location('detector_test',BASE/'fall_detection.py')
            module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
            bridge=Mock()
            from multi_person import NativeTracker
            with tempfile.TemporaryDirectory() as tmp, patch.object(module.time,'monotonic',side_effect=[0,.1,.2,.3,1.8,2.0]), patch.object(module.NativeTracker,'create',return_value=NativeTracker()):
                module.__file__=str(Path(tmp)/'fall_detection.py')
                module.run_detector(bridge)
                with (Path(tmp)/'events.csv').open(encoding='utf-8') as f:rows=list(csv.DictReader(f))
            aggregate=[r['status'] for r in rows if not r['status'].startswith('Person ') and r['status']!='Bed Calibration']
            self.assertEqual(aggregate,['No Person','Normal','Checking','Suspected Fall'])
            self.assertIn('Person 2: Suspected Fall',[r['status'] for r in rows])
            cv.VideoCapture.assert_called_once_with(0)
            sound.MessageBeep.assert_called_once_with(sound.MB_ICONEXCLAMATION)
            bridge.state.update.assert_any_call('Camera Offline',False)
            self.assertEqual(bridge.state.record_event.call_count,len(rows))
            self.assertEqual(model.predict.call_count,len(results))
            labels=[call.args[1] for call in cv.putText.call_args_list]
            self.assertIn('Person 1: Normal',labels)
            self.assertIn('Person 2: Suspected Fall',labels)
            cap.release.assert_called_once()

if __name__=='__main__':unittest.main()
