"""Reset real local calibration state with synthetic frames and mocked controls."""
import json
import math
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import cv2
import numpy as np

from device_settings import SettingsStore
from room_calibration import CalibrationUI, RoomCalibration


A='11111111-1111-4111-8111-111111111111'
B='22222222-2222-4222-8222-222222222222'
SIZE=(640,480)
POLY=[(.2,.2),(.8,.2),(.8,.8),(.2,.8)]
MESSAGE='Bed zone cleared — mark 3–12 points, then press Enter to save.'


class BedZoneResetTests(unittest.TestCase):
    def setUp(self):
        tmp=tempfile.TemporaryDirectory();self.addCleanup(tmp.cleanup)
        self.root=Path(tmp.name)
        env=patch.dict(os.environ,{},clear=True);env.start();self.addCleanup(env.stop)
        self.frame=np.zeros((SIZE[1],SIZE[0],3),np.uint8)

    def ui(self, path=None, *, saved=True):
        cal=RoomCalibration(path or self.root/'bed.json',device_scope=A)
        if saved:cal.confirm(POLY,SIZE)
        cv=Mock(wraps=cv2);cv.error=cv2.error
        for name in ('WINDOW_AUTOSIZE','EVENT_LBUTTONDOWN','EVENT_RBUTTONDOWN',
                     'EVENT_MOUSEMOVE','EVENT_LBUTTONUP','FONT_HERSHEY_SIMPLEX'):
            setattr(cv,name,getattr(cv2,name))
        cv.namedWindow=Mock();cv.setMouseCallback=Mock()
        ui=CalibrationUI(cv,'test',cal);ui.size=SIZE
        ui.guard=Mock();ui.guard.capture.return_value=True
        return cal,ui,cv

    def assert_cleared(self,cal,ui,cv):
        self.assertEqual(cal.polygon,[])
        self.assertEqual(ui.points,[])
        self.assertIsNone(ui.drag_index)
        self.assertTrue(ui.editing)  # Click to draw a replacement immediately.
        self.assertFalse(cal.active);self.assertFalse(cal.verified)
        self.assertEqual(cal.verification_label(0),'needs calibration')
        self.assertEqual(ui.message,MESSAGE)
        cv.polylines.reset_mock();cv.circle.reset_mock();cv.putText.reset_mock()
        ui.overlay(self.frame.copy())
        cv.polylines.assert_not_called();cv.circle.assert_not_called()
        text=' '.join(c.args[1] for c in cv.putText.call_args_list)
        self.assertIn('Calibration: needs calibration',text)
        self.assertIn('Bed zone cleared - mark 3-12 points, then press Enter to save.',text)

    def test_lowercase_and_uppercase_r_clear_saved_geometry_and_reopen_empty(self):
        for key in ('r','R'):
            with self.subTest(key=key):
                cal,ui,cv=self.ui(self.root/(key+'.json'))
                ui.handle(ord(key),self.frame,[])
                self.assert_cleared(cal,ui,cv)
                raw=json.loads(cal.path.read_text())
                self.assertEqual(raw['bed_polygon'],[]);self.assertTrue(raw['cleared'])
                reopened=RoomCalibration(cal.path,device_scope=A)
                self.assertEqual(reopened.polygon,[])
                self.assertEqual(reopened.reason,'Bed area not calibrated')
                self.assertEqual(reopened.verification_label(0),'needs calibration')

    def test_r_clears_draft_and_saved_polygon_together(self):
        cal,ui,cv=self.ui();ui.begin();ui.points=[(.1,.1),(.9,.1)]
        ui.drag_index=1
        ui.handle(ord('r'),self.frame,[])
        self.assert_cleared(cal,ui,cv)

    def test_reset_button_runs_the_same_clear_operation(self):
        cal,ui,cv=self.ui()
        ui.mouse(cv.EVENT_LBUTTONDOWN,490,10,0,None)
        ui.handle(255,self.frame,[])
        self.assert_cleared(cal,ui,cv)
        self.assertIsNone(ui.pending_key)

    def test_repeated_reset_is_idempotent_and_does_not_claim_view_movement(self):
        cal,ui,cv=self.ui();view_revision=cal.view_revision
        ui.handle(ord('r'),self.frame,[]);revision=cal.revision
        for _ in range(3):ui.handle(ord('r'),self.frame,[])
        self.assert_cleared(cal,ui,cv)
        self.assertEqual(cal.revision,revision)
        self.assertEqual(cal.view_revision,view_revision)

    def test_enter_requires_new_points_after_reset_and_never_restores_the_old_zone(self):
        cal,ui,cv=self.ui();ui.handle(ord('r'),self.frame,[])
        ui.handle(13,self.frame,[])
        self.assertFalse(cal.active);self.assertEqual(cal.polygon,[])
        self.assertIn('3 to 12',ui.message)
        ui.handle(27,self.frame,[])
        self.assertEqual(RoomCalibration(cal.path,device_scope=A).polygon,[])
        cv.polylines.reset_mock();ui.overlay(self.frame.copy())
        cv.polylines.assert_not_called()

    def test_replacement_polygon_is_yellow_until_enter_then_green_and_persisted(self):
        for count in (3,5,12):
            with self.subTest(points=count):
                cal,ui,cv=self.ui(self.root/(str(count)+'.json'))
                ui.handle(ord('r'),self.frame,[])
                points=[(.5+.3*math.cos(2*math.pi*i/count),
                         .5+.3*math.sin(2*math.pi*i/count)) for i in range(count)]
                for x,y in points:
                    ui.mouse(cv.EVENT_LBUTTONDOWN,round(x*SIZE[0]),round(y*SIZE[1])+28,0,None)
                    ui.mouse(cv.EVENT_LBUTTONUP,0,0,0,None)
                ui.overlay(self.frame.copy())
                self.assertEqual(cv.polylines.call_args.args[3],(0,220,255))
                self.assertFalse(cal.verified)
                ui.guard.capture=Mock(return_value=True)
                ui.handle(13,self.frame,[])
                self.assertTrue(cal.active);self.assertTrue(cal.verified)
                ui.overlay(self.frame.copy())
                self.assertEqual(cv.polylines.call_args.args[3],(0,220,0))
                reopened=RoomCalibration(cal.path,device_scope=A)
                self.assertEqual(reopened.polygon,cal.polygon)
                self.assertFalse(reopened.active)  # Every new session still needs confirmation.
                self.assertNotIn('cleared',json.loads(cal.path.read_text()))

    def test_reset_is_scoped_and_preserves_other_cameras_devices_settings_and_logs(self):
        entries=[]
        for device,source,profile in ((A,0,'bed'),(A,1,'bed'),(A,0,'door'),(B,0,'bed')):
            camera=SettingsStore(self.root,{'SAFENEST_DEVICE_ID':device}).save(source,profile,'Room','Camera')
            cal=RoomCalibration(camera.calibration_path(self.root),str(source),profile,device_scope=device)
            cal.confirm(POLY,SIZE);entries.append(cal)
        for name in ('events.csv','context_events.jsonl','.env'):
            (self.root/name).write_text('existing data')
        preserved={p:p.read_bytes() for p in [*(c.path for c in entries[1:]),
                   self.root/'device_settings.json',self.root/'events.csv',
                   self.root/'context_events.jsonl',self.root/'.env']}
        entries[0].clear()
        for path,before in preserved.items():self.assertEqual(path.read_bytes(),before)
        self.assertEqual(RoomCalibration(entries[0].path,'0','bed',device_scope=A).polygon,[])

    def test_view_changed_outline_is_inactive_then_reset_removes_it_without_auto_recovery(self):
        cal,ui,cv=self.ui()
        cal.invalidate('Camera view changed; recalibrate',view_changed=True)
        ui.overlay(self.frame.copy())
        self.assertEqual(cv.polylines.call_args.args[3],(0,0,255))
        self.assertEqual(cal.zone(None,None,SIZE),'unknown')
        ui.handle(ord('r'),self.frame,[])
        self.assertIsNone(ui.guard.reference)
        ui.observe(self.frame,[],1.)
        self.assert_cleared(cal,ui,cv)
        self.assertEqual(cal.zone(None,None,SIZE),'unknown')

    def test_reset_write_error_keeps_saved_file_and_disables_calibration_with_error(self):
        cal,ui,cv=self.ui();before=cal.path.read_bytes()
        with patch.object(Path,'replace',side_effect=OSError('denied')):
            ui.handle(ord('r'),self.frame,[])
        self.assertFalse(cal.active)
        self.assertEqual(cal.path.read_bytes(),before)
        self.assertIn('Could not clear',ui.message)
        self.assertEqual(list(self.root.glob('*.tmp')),[])


if __name__=='__main__':unittest.main()
