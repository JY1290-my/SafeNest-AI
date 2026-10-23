"""Bed-edge sequence regressions; synthetic poses, no camera/model/cloud.

The boundary -> horizontal -> inside sequence represents the uploaded video's
observed failure, not keypoints recovered or inferred from its rendered overlay.
"""
import csv
import io
import json
from pathlib import Path
import tempfile
import unittest

from test_context import BED, SIZE, detection
from test_multi_person import detector_rules
from room_calibration import RoomCalibration
from context_monitor import ContextMonitor
from multi_person import MultiPersonMonitor, write_events
from monitor_bridge import MonitorState


class BedEntryTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.cal=RoomCalibration(Path(self.tmp.name)/'bed.json')
        self.cal.confirm(BED,SIZE)
        self.base=MultiPersonMonitor(detector_rules().update_status,preserve_occlusion=True)
        self.context=ContextMonitor(self.cal)

    def step(self, poses, now):
        return self.context.update(self.base.update(poses,now),now,SIZE)

    def entry(self):
        outputs=[]
        # Shoulders cross the mattress boundary while both hips stay on it.
        # The raw fall timer reaches confirmation before the whole torso is in.
        for i in range(42):
            outputs.append(self.step([detection(x=.55,angle=min(84,max(0,(i-10)*4)),ratio=2,leg=90)],i*.1))
        for i in range(1,11):
            outputs.append(self.step([detection(x=.55-i*.025,angle=84,ratio=2,leg=90)],4.1+i*.1))
        for i in range(1,42):
            outputs.append(self.step([detection(x=.3,angle=84,ratio=2,leg=90)],5.1+i*.1))
        return outputs

    def test_boundary_to_inside_entry_never_latches_outside_or_emits_false_alarm(self):
        outputs=self.entry()
        self.assertEqual(outputs[-1].status,'Resting in Bed')
        self.assertTrue(any(o.visible[0].status=='Suspected Fall' for o in outputs))
        self.assertFalse(any(o.status=='Suspected Fall' or o.should_alarm for o in outputs))
        self.assertFalse(any(e.status in {'Suspected Fall','Person 1: Suspected Fall'} for o in outputs for e in o.events))
        self.assertNotIn('outside',self.context.tracks[1].evidence)
        self.assertNotIn('boundary',self.context.tracks[1].evidence)
        self.assertEqual(len(self.context.tracks),1)

    def test_boundary_is_a_warning_and_does_not_reset_the_original_confirmation_timer(self):
        outputs=[self.step([detection(x=.55,angle=84,ratio=2,leg=90)],i*.1) for i in range(31)]
        self.assertTrue(all(o.status=='Check Person' for o in outputs))
        self.assertEqual(outputs[-1].visible[0].since,0)
        self.assertEqual(outputs[-1].visible[0].status,'Suspected Fall')
        self.assertEqual(set(self.context.tracks[1].evidence),{'boundary'})
        self.assertFalse(self.context.tracks[1].risk_evidence)

    def test_initial_boundary_posture_entering_bed_does_not_invent_entry_history(self):
        for i in range(21):self.step([detection(x=.55,angle=84,ratio=2,leg=90)],i*.1)
        outputs=[]
        for i in range(1,11):
            outputs.append(self.step([detection(x=.55-i*.025,angle=84,ratio=2,leg=90)],2.+i*.1))
        for i in range(1,41):
            outputs.append(self.step([detection(x=.3,angle=84,ratio=2,leg=90)],3.+i*.1))
        self.assertEqual(outputs[-1].status,'Check Person')
        self.assertFalse(self.context.tracks[1].entry_proven)
        self.assertFalse(any(o.should_alarm for o in outputs))

    def test_fast_rotation_at_bed_edge_is_caution_not_measured_descent_or_trusted_rest(self):
        self.step([detection(x=.55,ratio=2)],0)
        self.step([detection(x=.55,angle=84,ratio=2,leg=90)],.1)
        self.assertEqual(set(self.context.tracks[1].evidence),{'rotation','boundary'})
        outputs=[]
        for i in range(1,11):
            outputs.append(self.step([detection(x=.55-i*.025,angle=84,ratio=2,leg=90)],.1+i*.1))
        for i in range(1,41):
            outputs.append(self.step([detection(angle=84,ratio=2,leg=90)],1.1+i*.1))
        self.assertTrue(all(o.status=='Check Person' for o in outputs))
        self.assertFalse(any(o.should_alarm for o in outputs))
        self.assertFalse(self.context.tracks[1].entry_proven)
        self.assertEqual(set(self.context.tracks[1].evidence),{'rotation'})

    def test_descent_at_boundary_is_not_erased_by_later_inside_location(self):
        self.step([detection(x=.55,y=.3,ratio=2)],0)
        self.step([detection(x=.55,y=.45,angle=84,ratio=2,leg=90)],.3)
        outputs=[]
        for i in range(1,11):
            outputs.append(self.step([detection(x=.55-i*.025,y=.45,angle=84,ratio=2,leg=90)],.3+i*.1))
        for i in range(1,31):
            outputs.append(self.step([detection(y=.45,angle=84,ratio=2,leg=90)],1.3+i*.1))
        t=self.context.tracks[1]
        self.assertEqual(t.zone,'inside')
        self.assertTrue(t.risk_evidence)
        self.assertEqual(t.evidence['descent'].zone,'boundary')
        self.assertAlmostEqual(t.evidence['descent'].time,.3)
        self.assertEqual(outputs[-1].status,'Suspected Fall')
        self.assertEqual(sum(o.should_alarm for o in outputs),1)
        self.assertIn('observed at boundary',t.reason)

    def test_independent_evidence_sources_do_not_overwrite_the_first_descent(self):
        self.step([detection(x=.55,y=.3,ratio=2)],0)
        self.step([detection(x=.55,y=.45,angle=84,ratio=2,leg=90)],.3)
        for i in range(1,9):
            self.step([detection(x=.55+i*.04,y=.45,angle=84,ratio=2,leg=90)],.3+i*.1)
        t=self.context.tracks[1]
        self.assertIn('descent',t.evidence)
        self.assertIn('outside',t.evidence)
        self.assertEqual(t.evidence['descent'].time,.3)
        self.assertGreater(t.evidence['outside'].time,.3)
        self.assertIn('Rapid descent',t.reason)
        self.assertIn('observed at boundary',t.reason)

    def test_outside_confirmation_is_retained_after_entry_and_manual_reconfirmation(self):
        for i in range(21):self.step([detection(x=.85,angle=84,ratio=2,leg=90)],i*.1)
        for i in range(1,12):self.step([detection(x=.85-i*.05,angle=84,ratio=2,leg=90)],2.+i*.1)
        self.cal.confirm(BED,SIZE)
        out=self.step([detection(angle=84,ratio=2,leg=90)],3.2)
        self.assertEqual(out.status,'Suspected Fall')
        self.assertEqual(self.context.tracks[1].zone,'inside')
        self.assertIn('outside',self.context.tracks[1].evidence)
        self.assertIn('Earlier outside',self.context.tracks[1].reason)
        self.assertFalse(out.should_alarm)

    def test_boundary_warning_then_keypoint_loss_is_tracking_lost_without_new_fall(self):
        for i in range(21):self.step([detection(x=.55,angle=84,ratio=2,leg=90)],i*.1)
        for i in range(1,6):
            out=self.step([],2.+i*.1)
            self.assertEqual(out.status,'Tracking Lost')
            self.assertFalse(out.should_alarm)
        out=self.step([detection(x=.55,angle=84,ratio=2,leg=90)],2.6)
        self.assertEqual(out.status,'Check Person')
        self.assertFalse(self.context.tracks[1].entry_proven)

    def test_track_expiry_never_transfers_boundary_evidence_or_entry_anchor(self):
        for i in range(21):self.step([detection(x=.55,angle=min(84,i*4),ratio=2,leg=90)],i*.1)
        self.step([],4.1)
        out=self.step([detection(angle=84,ratio=2,leg=90)],4.2)
        self.assertEqual(out.visible[0].number,2)
        self.assertEqual(out.status,'Check Person')
        self.assertFalse(self.context.tracks[2].evidence)
        self.assertIsNone(self.context.tracks[2].entry_anchor)

    def test_resting_person_crossing_shoulder_boundary_does_not_immediately_latch_exit(self):
        self.entry()
        for i in range(1,6):
            out=self.step([detection(x=.3+i*.05,angle=84,ratio=2,leg=90)],9.2+i*.1)
        self.assertEqual(self.context.tracks[1].zone,'boundary')
        self.assertEqual(out.status,'Check Person')
        self.assertNotIn('exit',self.context.tracks[1].evidence)
        self.assertFalse(out.should_alarm)

    def test_prior_rest_then_hips_leave_bed_keeps_exit_risk_and_one_alarm(self):
        self.entry()
        outputs=[]
        for i in range(1,12):
            outputs.append(self.step([detection(x=.3+i*.035,angle=84,ratio=2,leg=90)],9.2+i*.2))
        self.assertIn('exit',self.context.tracks[1].evidence)
        self.assertEqual(outputs[-1].status,'Suspected Fall')
        self.assertEqual(sum(o.should_alarm for o in outputs),1)

    def test_another_person_falling_remains_higher_priority_than_bed_entry_warning(self):
        outputs=[]
        for i in range(31):
            outputs.append(self.step([detection(x=.55,angle=84,ratio=2,leg=90),
                                      detection(1,x=.9,angle=84,ratio=2,leg=90)],i*.1))
        self.assertEqual([p.display_status for p in outputs[-1].visible],['Check Person','Suspected Fall'])
        self.assertEqual(sum(o.should_alarm for o in outputs),1)
        self.assertNotIn('outside',self.context.tracks[1].evidence)

    def test_rotation_without_verified_bed_still_uses_original_fall_confirmation(self):
        self.cal.invalidate('Unconfirmed bed')
        self.step([detection(ratio=2)],0)
        outputs=[self.step([detection(angle=84,ratio=2,leg=90)],.1+i*.1) for i in range(31)]
        self.assertEqual(outputs[-1].status,'Suspected Fall')
        self.assertEqual(sum(o.should_alarm for o in outputs),1)
        self.assertIn('rotation',self.context.tracks[1].evidence)
        self.assertNotIn('descent',self.context.tracks[1].evidence)

    def test_full_risk_origins_are_appended_to_local_log_without_changing_csv_columns(self):
        self.step([detection(x=.55,y=.3,ratio=2)],0)
        out=self.step([detection(x=.55,y=.45,angle=84,ratio=2,leg=90)],.3)
        csv_data,local=io.StringIO(),io.StringIO()
        write_events(out,'test',csv.writer(csv_data),csv_data,MonitorState(),local)
        rows=list(csv.reader(io.StringIO(csv_data.getvalue())))
        self.assertTrue(all(len(r)==4 for r in rows))
        reasons=[json.loads(line)['reason'] for line in local.getvalue().splitlines()]
        self.assertTrue(any('descent@+0.3s/boundary' in r and 'rotation@+0.3s/boundary' in r for r in reasons))

    def test_background_uncertainty_breaks_entry_proof_without_turning_boundary_into_fall(self):
        for i in range(21):self.step([detection(x=.55,angle=min(84,i*4),ratio=2,leg=90)],i*.1)
        self.cal.verify(False,'Background obscured',now=2.1)
        self.step([detection(x=.55,angle=84,ratio=2,leg=90)],2.1)
        self.cal.verify(True,'Bed area calibrated; keep camera still',now=2.2)
        outputs=[self.step([detection(x=.55,angle=84,ratio=2,leg=90)],2.2+i*.1) for i in range(31)]
        self.assertEqual(outputs[-1].status,'Check Person')
        self.assertFalse(self.context.tracks[1].entry_proven)
        self.assertFalse(any(o.should_alarm for o in outputs))

    def test_long_background_loss_preserves_boundary_warning_without_claiming_location(self):
        for i in range(21):self.step([detection(x=.55,angle=84,ratio=2,leg=90)],i*.1)
        self.cal.verify(False,'Background obscured',now=2.1)
        outputs=[self.step([detection(x=.55,angle=84,ratio=2,leg=90)],2.1+i*.1) for i in range(51)]
        self.assertTrue(all(o.status=='Check Person' for o in outputs))
        self.assertFalse(any(o.should_alarm for o in outputs))
        self.assertEqual(self.context.tracks[1].zone,'unknown')
        self.assertEqual(self.context.tracks[1].location_hint,'unknown')
        self.assertFalse(self.context.tracks[1].entry_proven)

    def test_descent_after_boundary_warning_still_alarms_when_background_is_unverified(self):
        for i in range(21):self.step([detection(x=.55,y=.4,angle=84,ratio=2,leg=90)],i*.1)
        self.cal.verify(False,'Background obscured',now=2.1)
        outputs=[self.step([detection(x=.55,y=.6,angle=84,ratio=2,leg=90)],2.1+i*.1) for i in range(21)]
        self.assertEqual(outputs[-1].status,'Suspected Fall')
        self.assertIn('descent',self.context.tracks[1].evidence)
        self.assertEqual(sum(o.should_alarm for o in outputs),1)

    def test_upright_recovery_clears_persistent_risk_and_rearms_next_fall(self):
        for i in range(21):self.step([detection(x=.85,angle=84,ratio=2,leg=90)],i*.1)
        for i in range(1,17):out=self.step([detection(x=.85,ratio=2)],2.+i*.1)
        self.assertEqual(out.status,'Normal')
        self.assertFalse(self.context.tracks[1].evidence)
        self.step([detection(x=.85,angle=84,ratio=2,leg=90)],3.7)
        self.assertTrue(self.step([detection(x=.85,angle=84,ratio=2,leg=90)],5.3).should_alarm)


if __name__=='__main__':
    unittest.main()
