"""Synthetic poses/frames only; no model, physical camera or cloud credentials."""
import csv
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from test_multi_person import detector_rules
from multi_person import Detection, MultiPersonMonitor, write_events
from context_monitor import ContextMonitor, ContextConfig
from room_calibration import RoomCalibration, CalibrationUI, ViewGuard, validate_polygon
from monitor_bridge import MonitorState

SIZE = (1000,1000)
BED = [(.05,.1),(.6,.1),(.6,.85),(.05,.85)]


def detection(i=0, x=.3, y=.5, angle=0, ratio=.6, leg=0, reliable=True):
    import math
    points = [[x*1000,y*1000] for _ in range(17)]
    for j,dx in ((5,-10),(6,10)):
        points[j] = [x*1000+100*math.sin(math.radians(angle))+dx,
                     y*1000-100*math.cos(math.radians(angle))]
    points[11],points[12] = [x*1000-10,y*1000],[x*1000+10,y*1000]
    box = (x*1000-ratio*200,y*1000-200,x*1000+ratio*200,y*1000+200)
    return Detection(i,box,(angle,ratio,leg) if reliable else None,True,
                     points,[1.]*17 if reliable else [.1]*17)


class ContextTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.cal = RoomCalibration(Path(self.tmp.name)/'bed.json')
        self.cal.confirm(BED,SIZE)
        self.base = MultiPersonMonitor(detector_rules().update_status,preserve_occlusion=True)
        self.context = ContextMonitor(self.cal)

    def step(self, detections, now, ids=None):
        return self.context.update(self.base.update(detections,now,ids),now,SIZE)

    def rest(self, start=0, x=.3):
        # Same track observed before lying down; not an initial horizontal pose.
        for i in range(16):
            self.step([detection(x=x,angle=i*70/15,ratio=2,leg=80)],start-1.5+i*.1)
        for i in range(1,35):
            out = self.step([detection(x=x,angle=70,ratio=2,leg=80)],start+i*.1)
        return out

    def test_no_people_then_one_then_two_normal(self):
        self.assertEqual(self.step([],0).status,'No Person')
        self.assertEqual(self.step([detection()],.1).status,'Normal')
        self.assertEqual(self.step([detection(),detection(1,x=.8)],.2).status,'Normal')
        self.assertEqual(len(self.context.tracks),2)

    def test_gradual_bed_entry_rests_only_after_stable_observation(self):
        self.step([detection()],0)
        for i in range(1,36):
            self.step([detection(angle=min(70,i*2),ratio=.8,leg=80)],i*.1)
        self.assertNotEqual(self.context.tracks[1].state,'RESTING_IN_BED')
        for i in range(36,75):
            out=self.step([detection(angle=70,ratio=.8,leg=80)],i*.1)
        self.assertEqual(out.status,'Resting in Bed')
        self.assertFalse(out.should_alarm)

    def test_initial_horizontal_pose_never_invents_bed_entry(self):
        for i in range(45):
            out=self.step([detection(angle=70,ratio=.8,leg=80)],i*.1)
            self.assertNotEqual(out.status,'Resting in Bed')
        self.assertEqual(out.status,'Check Person')

    def test_verified_gradual_rest_explains_raw_horizontal_fall_without_final_fall_event(self):
        out=self.rest()
        self.assertEqual(out.status,'Resting in Bed')
        self.assertEqual(out.visible[0].status,'Suspected Fall')  # Raw rule unchanged.
        self.assertFalse(out.should_alarm)
        for i in range(20):
            out=self.step([detection(angle=84,ratio=3.51,leg=90)],3.5+i*.1)
            self.assertNotEqual(out.status,'Suspected Fall')
            self.assertFalse(out.should_alarm)
            self.assertNotIn('Person 1: Suspected Fall',[e.status for e in out.events])

    def test_rapid_descent_within_bed_stays_concerning_without_baseline_fall(self):
        self.step([detection(y=.3)],0)
        out=self.step([detection(y=.45,angle=70,ratio=.8,leg=80)],.3)
        self.assertEqual(out.status,'Check Person')
        self.assertTrue(self.context.tracks[1].risk)
        for i in range(1,45):
            out=self.step([detection(y=.45,angle=70,ratio=.8,leg=80)],.3+i*.1)
        self.assertEqual(out.status,'Check Person')
        self.assertFalse(out.should_alarm)

    def test_bed_exit_reassesses_even_if_slow(self):
        self.rest()
        for i in range(1,10):
            out=self.step([detection(x=.3+i*.045,angle=70,ratio=.8,leg=80)],3.4+i*.2)
        self.assertEqual(out.status,'Check Person')
        self.assertNotEqual(self.context.tracks[1].zone,'inside')
        self.assertTrue(self.context.tracks[1].risk)

    def test_bed_exit_fall_retains_original_confirmation_and_alarm(self):
        self.rest()
        outputs=[]
        for i in range(1,10):
            outputs.append(self.step([detection(x=.3+i*.045,y=.5+i*.025,angle=90,ratio=2,leg=90)],3.4+i*.2))
        self.assertEqual(outputs[-1].status,'Suspected Fall')
        self.assertEqual(sum(out.should_alarm for out in outputs),1)

    def test_slow_slide_and_bending_do_not_become_normal_or_new_loud_alarm(self):
        for i in range(15):
            out=self.step([detection(x=.8,y=.5+i*.02,angle=40,ratio=.8)],i*.2)
        self.assertEqual(out.status,'Check Person')
        self.assertFalse(out.should_alarm)
        out=self.step([detection(x=.8,y=.78,angle=80,ratio=1.1,leg=0)],3.)
        self.assertEqual(out.visible[0].status,'Normal')  # original bending exclusion
        self.assertFalse(out.should_alarm)

    def test_invalid_calibration_clears_rest_and_requires_new_observation(self):
        self.rest()
        self.cal.invalidate('Camera view changed; recalibrate')
        out=self.step([detection(angle=70,ratio=.8,leg=80)],3.5)
        self.assertEqual(out.status,'Check Person')
        self.assertEqual(self.context.tracks[1].zone,'unknown')
        self.cal.confirm(BED,SIZE)
        self.assertNotEqual(self.step([detection(angle=70,ratio=.8,leg=80)],3.6).status,'Resting in Bed')

    def test_missing_and_unreliable_tracks_are_not_normal(self):
        self.step([detection(),detection(1,x=.8)],0)
        out=self.step([detection()],.2)
        self.assertEqual(out.status,'Tracking Lost')
        out=self.step([detection(reliable=False)],.3)
        self.assertEqual(out.status,'Tracking Lost')
        self.assertEqual(self.step([],2.4).status,'No Person')

    def test_missing_timer_is_paused_not_reset_and_unseen_time_never_confirms(self):
        fall=lambda:detection(x=.8,angle=90,ratio=2,leg=90)
        self.step([fall()],0);self.step([fall()],.8)
        self.step([],1.0)
        self.assertEqual(self.base.people[1].since,0)
        out=self.step([fall()],1.4)
        self.assertAlmostEqual(out.visible[0].since,.6)
        self.assertEqual(out.status,'Checking')
        self.assertEqual(self.step([fall()],2.0).status,'Checking')
        self.assertTrue(self.step([fall()],2.2).should_alarm)

    def test_unreliable_keypoints_pause_confirmation(self):
        fall=lambda:detection(x=.8,angle=90,ratio=2,leg=90)
        self.step([fall()],0);self.step([fall()],.8)
        self.step([detection(x=.8,reliable=False)],1.)
        out=self.step([fall()],1.4)
        self.assertAlmostEqual(out.visible[0].since,.6)
        self.assertEqual(out.status,'Checking')

    def test_calibration_changes_never_cancel_baseline_confirmed_fall(self):
        fall=lambda:detection(x=.8,angle=90,ratio=2,leg=90)
        self.step([fall()],0)
        self.assertTrue(self.step([fall()],1.5).should_alarm)
        self.cal.invalidate('Cannot verify background; recalibrate')
        self.assertEqual(self.cal.view_revision,0)
        out=self.step([fall()],1.6)
        self.assertEqual(out.status,'Suspected Fall')
        self.assertFalse(out.should_alarm)
        self.assertEqual(out.visible[0].since,0)
        self.cal.confirm(BED,SIZE)
        self.assertEqual(self.step([fall()],1.7).status,'Suspected Fall')

    def test_long_keypoint_loss_expires_old_confirmation_even_with_visible_box(self):
        fall=lambda:detection(x=.8,angle=90,ratio=2,leg=90)
        self.step([fall()],0);self.step([fall()],.8)
        for now in (1.,2.,3.,4.):self.step([detection(x=.8,reliable=False)],now)
        out=self.step([fall()],4.1)
        self.assertEqual(out.visible[0].number,1)
        self.assertEqual(out.visible[0].since,4.1)
        self.assertEqual(out.status,'Checking')
        self.assertFalse(out.should_alarm)

    def test_confirmed_fall_stays_priority_while_briefly_missing(self):
        fall=lambda:detection(x=.8,angle=90,ratio=2,leg=90)
        self.step([fall()],0);self.step([fall()],1.5)
        out=self.step([],1.6)
        self.assertEqual(out.status,'Suspected Fall')
        self.assertFalse(out.should_alarm)
        self.assertIn('unreliable',self.context.tracks[1].reason)

    def test_low_frame_rate_cannot_accumulate_trusted_rest(self):
        for i in range(10):
            out=self.step([detection(angle=70,ratio=.8,leg=80)],float(i))
            self.assertNotEqual(out.status,'Resting in Bed')

    def test_occlusion_breaks_rest_proof_and_does_not_transfer_history(self):
        self.rest();self.step([],3.5)
        out=self.step([detection(angle=70,ratio=.8,leg=80)],3.6)
        self.assertEqual(out.visible[0].number,1)
        self.assertNotEqual(out.status,'Resting in Bed')
        self.step([],6)
        out=self.step([detection(angle=70,ratio=.8,leg=80)],6.1)
        self.assertEqual(out.visible[0].number,2)
        self.assertNotEqual(out.status,'Resting in Bed')

    def test_independent_timers_and_one_fall_dominates_normal_person(self):
        self.step([detection(x=.8,angle=90,ratio=2,leg=90),detection(1,x=.2)],0)
        self.step([detection(x=.8,angle=90,ratio=2,leg=90),detection(1,x=.2,angle=70,ratio=.8,leg=80)],1.)
        out=self.step([detection(x=.8,angle=90,ratio=2,leg=90),detection(1,x=.2,angle=70,ratio=.8,leg=80)],1.5)
        self.assertEqual(out.status,'Suspected Fall')
        self.assertTrue(out.should_alarm)
        self.assertIsNone(out.visible[1].since)
        self.assertEqual(self.context.tracks[2].state,'CHECK_PERSON')

    def test_ambiguous_crossing_and_native_id_change_discard_context(self):
        self.step([detection(x=.3),detection(1,x=.5)],0,{0:1,1:2})
        out=self.step([detection(x=.4),detection(1,x=.4)],.2,{0:2,1:1})
        self.assertTrue(all(p.number>2 for p in out.visible))
        self.assertNotIn(1,self.context.tracks)
        n=out.visible[0].number
        out=self.step([detection(x=.4)],.4,{0:99})
        self.assertTrue(out.visible[0].number>n)

    def test_recovery_requires_observation_and_rearms_existing_sound(self):
        self.step([detection(x=.8,angle=90,ratio=2,leg=90)],0)
        self.assertTrue(self.step([detection(x=.8,angle=90,ratio=2,leg=90)],1.5).should_alarm)
        for i in range(1,17):out=self.step([detection(x=.8)],1.5+i*.1)
        self.assertEqual(out.status,'Normal')
        self.step([detection(x=.8,angle=90,ratio=2,leg=90)],3.2)
        self.assertTrue(self.step([detection(x=.8,angle=90,ratio=2,leg=90)],4.8).should_alarm)

    def test_reasons_log_without_rewriting_csv_and_only_safe_metadata_published(self):
        path=Path(self.tmp.name)/'events.csv'
        original='time,status,angle_deg,width_height_ratio\nold,Normal,0,.5\n'
        path.write_text(original)
        bridge=MonitorState(path)
        output=self.step([detection(angle=70,ratio=.8,leg=80)],0)
        extra=io.StringIO()
        with path.open('a',newline='',encoding='utf-8') as f:
            write_events(output,'test',csv.writer(f),f,bridge,extra)
        self.assertTrue(path.read_text().startswith(original))
        self.assertTrue(all(len(row)==4 for row in csv.reader(io.StringIO(path.read_text()))))
        self.assertTrue(json.loads(extra.getvalue().splitlines()[0])['reason'])
        bridge.update(output.status,True,context=self.context.metadata)
        payload=bridge.snapshot()
        self.assertEqual(payload['schema_version'],1)
        self.assertNotIn('bed_polygon',json.dumps(payload))
        self.assertNotIn('keypoints',json.dumps(payload).lower())
        bridge.updated_mono-=16
        self.assertNotIn('context',bridge.snapshot())
        bridge.update('Camera Offline',False)
        self.assertNotIn('context',bridge.snapshot())

    def test_realistic_bed_entry_suppresses_only_final_alarm_not_raw_pose_results(self):
        outputs=[];raw=[]
        for i in range(61):
            angle=min(84,i*4)
            # Same shapes as the screenshot, with reliable gradual observations.
            outputs.append(self.step([detection(angle=angle,ratio=3.51,leg=90)],i*.1))
            raw.append(outputs[-1].visible[0].status)
        self.assertEqual(outputs[-1].status,'Resting in Bed')
        self.assertIn('Checking',raw)
        self.assertIn('Suspected Fall',raw)
        self.assertFalse(any(o.should_alarm for o in outputs))
        self.assertFalse(any(e.status in ('Suspected Fall','Person 1: Suspected Fall') for o in outputs for e in o.events))
        self.assertEqual(self.context.metadata['people'][0]['baseline_status'],'Suspected Fall')

    def test_initial_horizontal_bed_posture_is_uncertain_while_raw_confirmation_is_preserved(self):
        outputs=[];raw=[]
        for i in range(31):
            outputs.append(self.step([detection(angle=84,ratio=3.51,leg=90)],i*.1))
            raw.append(outputs[-1].visible[0].status)
        self.assertEqual(outputs[-1].status,'Check Person')
        self.assertNotEqual(outputs[-1].status,'Resting in Bed')
        self.assertEqual(sum(o.should_alarm for o in outputs),0)
        self.assertEqual(raw[14],'Checking')
        self.assertEqual(raw[15],'Suspected Fall')

    def test_abrupt_rotation_in_bed_cannot_claim_gradual_entry(self):
        self.step([detection(angle=0,ratio=2,leg=90)],0)
        outputs=[self.step([detection(angle=84,ratio=2,leg=90)],.1+i*.1) for i in range(51)]
        self.assertEqual(outputs[-1].status,'Check Person')
        self.assertFalse(self.context.tracks[1].entry_proven)
        self.assertEqual(sum(o.should_alarm for o in outputs),0)
        self.assertIn('rotation',self.context.tracks[1].evidence)
        self.assertNotIn('descent',self.context.tracks[1].evidence)

    def test_rapid_descent_in_bed_keeps_alarm_after_same_raw_confirmation(self):
        self.step([detection(y=.3,ratio=2)],0)
        outputs=[self.step([detection(y=.45,angle=84,ratio=2,leg=90)],.3+i*.1) for i in range(35)]
        self.assertEqual(outputs[-1].status,'Suspected Fall')
        self.assertTrue(self.context.tracks[1].risk)
        self.assertEqual(sum(o.should_alarm for o in outputs),1)

    def test_new_descent_after_rest_reassesses_and_rearms_only_once(self):
        self.assertEqual(self.rest().status,'Resting in Bed')
        outputs=[self.step([detection(y=.65,angle=84,ratio=2,leg=90)],3.5+i*.1) for i in range(20)]
        self.assertEqual(outputs[-1].status,'Suspected Fall')
        self.assertEqual(sum(o.should_alarm for o in outputs),1)

    def test_one_resting_person_cannot_explain_another_person_falling(self):
        self.rest()
        outputs=[]
        for i in range(31):
            outputs.append(self.step([detection(angle=70,ratio=2,leg=80),
                                      detection(1,x=.85,angle=84,ratio=2,leg=90)],3.5+i*.1,{0:1,1:2}))
        self.assertEqual(outputs[-1].status,'Suspected Fall')
        self.assertEqual([p.display_status for p in outputs[-1].visible],['Resting in Bed','Suspected Fall'])
        self.assertEqual(sum(o.should_alarm for o in outputs),1)

    def test_lost_verification_disables_rest_but_recovered_location_can_refine_uncertainty(self):
        self.rest()
        self.cal.verify(False,'Background obscured; bed context paused')
        out=self.step([detection(angle=70,ratio=2,leg=80)],3.5)
        self.assertEqual(out.status,'Check Person')
        self.assertFalse(out.should_alarm)
        self.assertEqual(self.context.tracks[1].zone,'unknown')
        self.assertFalse(self.context.tracks[1].entry_proven)
        self.cal.verify(True,'Bed area calibrated; keep camera still')
        for i in range(30):out=self.step([detection(angle=70,ratio=2,leg=80)],3.6+i*.1)
        self.assertEqual(out.status,'Check Person')
        self.assertFalse(self.context.tracks[1].entry_proven)

    def test_observation_gap_cannot_stitch_an_upright_pose_to_initial_horizontal(self):
        self.step([detection(angle=0,ratio=2)],0)
        outputs=[self.step([detection(angle=84,ratio=2,leg=90)],1+i*.1) for i in range(40)]
        self.assertEqual(outputs[-1].status,'Check Person')
        self.assertFalse(any(out.should_alarm for out in outputs))
        self.assertFalse(self.context.tracks[1].entry_proven)

    def test_seated_shoulders_above_bed_can_enter_only_when_final_pose_is_inside(self):
        pose=detection(y=.18,angle=0,ratio=2,leg=90)
        self.assertEqual(self.cal.zone(pose.points,pose.confidences,SIZE),'boundary')
        self.assertEqual(self.cal.zone(pose.points,pose.confidences,SIZE,indices=(11,12)),'inside')
        outputs=[]
        for i in range(71):
            outputs.append(self.step([detection(y=.18,angle=min(84,i*4),ratio=2,leg=90)],i*.1))
        self.assertEqual(outputs[-1].status,'Resting in Bed')
        self.assertEqual(self.context.tracks[1].zone,'inside')
        self.assertFalse(any(out.should_alarm for out in outputs))

    def test_hip_overlap_alone_never_makes_a_boundary_pose_rest(self):
        # Hips stay inside but shoulders extend outside the right boundary.
        for i in range(61):
            out=self.step([detection(x=.55,angle=min(84,i*4),ratio=2,leg=90)],i*.1)
        self.assertEqual(self.context.tracks[1].zone,'boundary')
        self.assertEqual(out.status,'Check Person')
        self.assertFalse(out.should_alarm)
        self.assertFalse(self.context.tracks[1].entry_proven)

    def test_new_tracking_id_lying_in_bed_does_not_invent_a_new_fall(self):
        self.rest()
        self.step([],6.)
        outputs=[self.step([detection(angle=86,ratio=3.05,leg=90)],6.1+i*.1) for i in range(40)]
        self.assertEqual(outputs[-1].visible[0].number,2)
        self.assertEqual(outputs[-1].status,'Check Person')
        self.assertFalse(any(out.should_alarm for out in outputs))
        self.assertIn('entry not observed',self.context.tracks[2].reason)

    def test_missing_bed_observation_is_tracking_lost_not_a_new_confirmed_fall(self):
        self.rest()
        for i in range(8):
            out=self.step([],3.5+i*.1)
            self.assertEqual(out.status,'Tracking Lost')
            self.assertFalse(out.should_alarm)
        out=self.step([detection(angle=86,ratio=3.05,leg=90)],4.3)
        self.assertEqual(out.status,'Check Person')
        self.assertFalse(out.should_alarm)

    def test_unknown_bed_history_then_rapid_descent_still_triggers_one_alarm(self):
        for i in range(21):self.step([detection(y=.4,angle=86,ratio=2,leg=90)],i*.1)
        outputs=[self.step([detection(y=.6,angle=86,ratio=2,leg=90)],2.1+i*.1) for i in range(20)]
        self.assertEqual(outputs[-1].status,'Suspected Fall')
        self.assertEqual(sum(out.should_alarm for out in outputs),1)

    def test_prior_outside_fall_remains_concerning_when_person_reaches_bed(self):
        for i in range(21):self.step([detection(x=.8,angle=86,ratio=2,leg=90)],i*.1)
        # Native ID is stable; move slowly enough for a clear spatial match.
        for i in range(1,11):
            out=self.step([detection(x=.8-i*.05,angle=86,ratio=2,leg=90)],2.+i*.1)
        self.assertEqual(out.status,'Suspected Fall')
        self.assertEqual(self.context.tracks[1].zone,'inside')
        self.assertTrue(self.context.tracks[1].risk)

    def test_confirming_bed_is_not_acknowledging_the_person_or_creating_rest(self):
        for i in range(21):self.step([detection(angle=86,ratio=3.05,leg=90)],i*.1)
        old_since=self.base.people[1].since
        self.cal.confirm(BED,SIZE)
        out=self.step([detection(angle=86,ratio=3.05,leg=90)],2.1)
        self.assertEqual(out.status,'Check Person')
        self.assertFalse(out.should_alarm)
        self.assertEqual(self.base.people[1].since,old_since)
        self.assertFalse(self.context.tracks[1].entry_proven)

    def test_uncertain_bed_events_match_final_status_and_preserve_history(self):
        states=[self.step([detection(angle=86,ratio=3.05,leg=90)],i*.1) for i in range(40)]
        self.assertFalse(any(e.status in {'Suspected Fall','Person 1: Suspected Fall'} for state in states for e in state.events))
        self.assertEqual(self.context.metadata['people'][0]['baseline_status'],'Suspected Fall')
        self.assertEqual(self.context.metadata['people'][0]['state'],'CHECK_PERSON')

    def test_outside_fall_checking_cannot_be_cancelled_by_entering_bed_before_confirmation(self):
        self.step([detection(x=.8,angle=86,ratio=2,leg=90)],0.)
        outputs=[]
        for i in range(1,21):
            outputs.append(self.step([detection(x=max(.3,.8-i*.05),angle=86,ratio=2,leg=90)],i*.1))
        self.assertEqual(outputs[-1].status,'Suspected Fall')
        self.assertEqual(sum(out.should_alarm for out in outputs),1)
        self.assertEqual(self.context.tracks[1].zone,'inside')

    def test_confirming_bed_after_initial_uncalibrated_pose_refines_to_warning_only(self):
        self.cal.invalidate('Bed area not confirmed')
        for i in range(21):out=self.step([detection(angle=86,ratio=3.05,leg=90)],i*.1)
        self.assertEqual(out.status,'Suspected Fall')
        self.assertFalse(self.context.tracks[1].risk_evidence)
        self.cal.confirm(BED,SIZE)
        for i in range(21):
            out=self.step([detection(angle=86,ratio=3.05,leg=90)],2.1+i*.1)
            self.assertEqual(out.status,'Check Person')
            self.assertFalse(out.should_alarm)
            self.assertNotEqual(out.status,'Resting in Bed')

    def test_short_background_interruption_keeps_motion_history_but_not_rest_proof(self):
        self.rest()
        samples=len(self.context.tracks[1].samples)
        revision=self.cal.revision
        self.cal.verify(False,'Fixed background obscured; bed context paused',now=3.5)
        out=self.step([detection(angle=70,ratio=2,leg=80)],3.5)
        self.assertEqual(out.status,'Check Person')
        self.assertEqual(self.cal.revision,revision)
        self.assertGreaterEqual(len(self.context.tracks[1].samples),samples-2)
        self.assertEqual(self.context.tracks[1].location_hint,'inside')
        self.assertEqual(self.context.tracks[1].zone,'unknown')
        self.assertFalse(self.context.tracks[1].entry_proven)
        self.assertFalse(out.should_alarm)

    def test_long_background_loss_does_not_invent_fall_when_location_grace_expires(self):
        self.rest()
        old_since=self.base.people[1].since
        outputs=[]
        for i in range(61):
            now=3.5+i*.1
            self.cal.verify(False,'Fixed background obscured; bed context paused',now=now)
            outputs.append(self.step([detection(angle=86,ratio=3.05,leg=90)],now))
        self.assertTrue(all(o.status=='Check Person' for o in outputs))
        self.assertFalse(any(o.should_alarm for o in outputs))
        self.assertFalse(any(e.status in {'Suspected Fall','Person 1: Suspected Fall'}
                             for o in outputs for e in o.events))
        self.assertEqual(self.context.tracks[1].location_hint,'unknown')
        self.assertIn('current location unknown',self.context.tracks[1].reason)
        self.assertEqual(self.base.people[1].since,old_since)
        self.assertEqual(outputs[-1].visible[0].status,'Suspected Fall')
        # Log the grace expiry once, not a changing countdown every frame.
        calibration_events=[e for o in outputs for e in o.events if e.status=='Bed Calibration']
        self.assertEqual(len(calibration_events),2)
        self.assertIn('2s location grace',calibration_events[0].reason)
        self.assertIn('location unknown',calibration_events[1].reason)

    def test_movement_during_soft_verification_loss_keeps_risk_and_one_alarm(self):
        self.step([detection(y=.3,ratio=2)],0)
        self.cal.verify(False,'Fixed background obscured; bed context paused',now=.1)
        outputs=[self.step([detection(y=.45,angle=84,ratio=2,leg=90)],.3+i*.1)
                 for i in range(40)]
        self.assertTrue(self.context.tracks[1].risk_evidence)
        self.assertIn('Rapid descent',self.context.tracks[1].reason)
        self.assertEqual(outputs[-1].status,'Suspected Fall')
        self.assertEqual(sum(o.should_alarm for o in outputs),1)

    def test_new_floor_person_cannot_borrow_bed_warning_during_background_loss(self):
        self.rest()
        self.cal.verify(False,'Fixed background obscured; bed context paused',now=3.5)
        outputs=[]
        for i in range(41):
            outputs.append(self.step([detection(angle=70,ratio=2,leg=80),
                                      detection(1,x=.85,angle=84,ratio=2,leg=90)],3.5+i*.1))
        self.assertEqual([p.display_status for p in outputs[-1].visible],['Check Person','Suspected Fall'])
        self.assertEqual(outputs[-1].status,'Suspected Fall')
        self.assertEqual(sum(o.should_alarm for o in outputs),1)
        self.assertFalse(self.context.tracks[2].bed_observed)

    def test_new_inside_track_during_grace_gets_warning_not_another_tracks_rest(self):
        self.rest()
        self.step([],5.5)
        self.cal.verify(False,'Fixed background obscured; bed context paused',now=5.6)
        out=self.step([detection(angle=84,ratio=2,leg=90)],5.6)
        self.assertEqual(out.visible[0].number,2)
        self.assertEqual(out.status,'Check Person')
        self.assertFalse(self.context.tracks[2].entry_proven)
        self.assertFalse(out.should_alarm)

    def test_new_track_after_location_grace_cannot_reuse_a_previous_bed_track(self):
        self.rest()
        self.cal.verify(False,'Fixed background obscured; bed context paused',now=3.5)
        self.step([],5.5)
        outputs=[self.step([detection(angle=84,ratio=2,leg=90)],5.6+i*.1) for i in range(31)]
        self.assertEqual(outputs[-1].visible[0].number,2)
        self.assertEqual(outputs[-1].status,'Suspected Fall')
        self.assertEqual(sum(o.should_alarm for o in outputs),1)
        self.assertEqual(self.context.tracks[2].location_hint,'unknown')

    def test_possible_camera_motion_has_no_held_geometry_and_does_not_claim_rest(self):
        self.rest()
        self.cal.verify(False,'Possible camera movement; bed context paused',state='motion_pending',now=3.5)
        out=self.step([detection(angle=70,ratio=2,leg=80)],3.5)
        self.assertEqual(out.status,'Check Person')
        self.assertEqual(self.context.tracks[1].zone,'unknown')
        self.assertEqual(self.context.tracks[1].location_hint,'unknown')
        self.assertFalse(self.context.tracks[1].entry_proven)
        self.assertFalse(out.should_alarm)

    def test_confirmed_view_change_discards_all_old_bed_geometry_and_proof(self):
        self.rest()
        self.cal.invalidate('Camera view changed; recalibrate',view_changed=True)
        out=self.step([detection(angle=70,ratio=2,leg=80)],3.5)
        self.assertEqual(out.status,'Suspected Fall')
        self.assertEqual(self.context.tracks[1].zone,'unknown')
        self.assertEqual(self.context.tracks[1].location_hint,'unknown')
        self.assertFalse(self.context.tracks[1].bed_observed)
        self.assertIn('view changed',self.context.metadata['calibration'])

    def test_background_return_does_not_restore_rest_without_a_new_entry_sequence(self):
        self.rest()
        self.cal.verify(False,'Fixed background obscured; bed context paused',now=3.5)
        self.step([detection(angle=70,ratio=2,leg=80)],3.5)
        self.cal.verify(True,'Bed area calibrated; keep camera still',now=3.6)
        outputs=[self.step([detection(angle=70,ratio=2,leg=80)],3.6+i*.1) for i in range(41)]
        self.assertTrue(all(o.status=='Check Person' for o in outputs))
        self.assertFalse(any(o.should_alarm for o in outputs))

    def test_keypoints_lost_during_background_interruption_remain_tracking_lost(self):
        self.rest()
        self.cal.verify(False,'Fixed background obscured; bed context paused',now=3.5)
        out=self.step([detection(angle=70,ratio=2,leg=80,reliable=False)],3.5)
        self.assertEqual(out.status,'Tracking Lost')
        self.assertFalse(out.should_alarm)

    def test_real_background_guard_and_lie_down_sequence_never_emit_a_static_fall(self):
        import cv2, numpy as np
        cv=Mock(wraps=cv2);cv.error=cv2.error
        cv.namedWindow=Mock();cv.setMouseCallback=Mock()
        ui=CalibrationUI(cv,'test',self.cal)
        ui.guard=ViewGuard(cv2)
        reference=np.random.default_rng(53).integers(0,255,(1000,1000,3),dtype=np.uint8)
        blocked=np.zeros_like(reference)
        self.assertTrue(ui.guard.capture(reference,[],BED))
        outputs=[]
        for i in range(71):
            now=i*.1
            pose=detection(angle=min(84,i*4),ratio=3.05,leg=90)
            # Model poses are mocked; actual ORB sees background become invisible
            # during entry, stay obscured past grace, then return to the same view.
            frame=blocked if 12<=i<50 else reference
            ui.observe(frame,[pose.box],now)
            outputs.append(self.step([pose],now))
            if i==40:
                self.assertFalse(self.cal.verified)
                self.assertEqual(self.context.tracks[1].location_hint,'unknown')
        self.assertFalse(any(o.should_alarm for o in outputs))
        self.assertFalse(any(o.status=='Suspected Fall' for o in outputs))
        self.assertEqual(outputs[-1].status,'Check Person')
        self.assertTrue(self.cal.verified)
        self.assertEqual(self.cal.view_revision,0)
        self.assertIn('Suspected Fall',[o.visible[0].status for o in outputs])

    def test_debug_overlay_shows_raw_final_and_uncertain_bed_location(self):
        import cv2, numpy as np
        self.rest()
        self.cal.verify(False,'Fixed background obscured; bed context paused',now=3.5)
        out=self.step([detection(angle=70,ratio=2,leg=80)],3.5)
        cv=Mock(wraps=cv2);cv.FONT_HERSHEY_SIMPLEX=cv2.FONT_HERSHEY_SIMPLEX
        self.context.draw(cv,np.zeros((1000,1000,3),np.uint8),out)
        text=[c.args[1] for c in cv.putText.call_args_list]
        self.assertTrue(any('Pose: Suspected Fall -> Check Person' in s for s in text))
        self.assertTrue(any('Bed: unknown (recent inside estimate)' in s for s in text))

    def test_empty_view_exposure_changes_then_gradual_bed_entry_keep_calibration(self):
        import cv2, numpy as np
        cv=Mock(wraps=cv2);cv.error=cv2.error
        cv.namedWindow=Mock();cv.setMouseCallback=Mock()
        ui=CalibrationUI(cv,'test',self.cal);ui.guard=ViewGuard(cv2)
        rng=np.random.default_rng(67)
        reference=rng.integers(20,210,(1000,1000,3),dtype=np.uint8)
        self.assertTrue(ui.guard.capture(reference,[],BED))
        outputs=[]
        for i in range(91):
            now=i*.1
            frame=np.clip(reference.astype(float)*(.8+(i%3)*.1)+15,0,255).astype(np.uint8)
            poses=[] if i<20 else [detection(angle=min(84,(i-20)*4),ratio=3.05,leg=90)]
            ui.observe(frame,[p.box for p in poses],now)
            outputs.append(self.step(poses,now))
            self.assertTrue(self.cal.verified)
            self.assertEqual(self.cal.view_revision,0)
        self.assertEqual(outputs[-1].status,'Resting in Bed')
        self.assertFalse(any(o.status=='Suspected Fall' or o.should_alarm for o in outputs))


class CalibrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.path=Path(self.tmp.name)/'bed.json'
        self.cal=RoomCalibration(self.path)

    def test_profile_is_local_geometry_only_and_never_auto_active_after_restart(self):
        self.cal.confirm(BED,SIZE)
        self.assertEqual(set(json.loads(self.path.read_text())),{'version','source','profile','resolution','bed_polygon'})
        new=RoomCalibration(self.path)
        self.assertFalse(new.active)
        self.assertEqual(new.polygon,self.cal.polygon)
        self.assertEqual(RoomCalibration(self.path,source='1').polygon,[])
        self.assertEqual(RoomCalibration(self.path,profile='other').polygon,[])

    def test_polygon_validation_rejects_malformed_crossing_and_nan(self):
        for p in [[],[(0,0),(1,1)],[(0,0),(1,1),(0,1),(1,0)],[(0,0),(1,0),(float('nan'),1)],
                  [(0,0),(1,0),(1,0),(0,1)],[(0,0),(.01,0),(0,.01)]]:
            with self.assertRaises(ValueError):validate_polygon(p)

    def test_multiple_keypoints_required_and_boundary_is_uncertain(self):
        self.cal.confirm(BED,SIZE)
        d=detection()
        self.assertEqual(self.cal.zone(d.points,d.confidences,SIZE),'inside')
        d.points[5]=[900,400]
        self.assertEqual(self.cal.zone(d.points,d.confidences,SIZE),'boundary')
        d.confidences[5]=.1
        self.assertEqual(self.cal.zone(d.points,d.confidences,SIZE),'unknown')

    def test_resolution_or_aspect_change_invalidates_normalized_coordinates(self):
        for size in [(500,500),(1000,500)]:
            self.cal.confirm(BED,SIZE);self.cal.view(size)
            self.assertFalse(self.cal.active)
            d=detection()
            self.assertEqual(self.cal.zone(d.points,d.confidences,size),'unknown')
            self.cal.view(SIZE)
            self.assertFalse(self.cal.active)

    def test_corrupt_profile_and_context_config_fail_closed(self):
        self.path.write_text('{broken')
        self.assertFalse(RoomCalibration(self.path).active)
        self.path.write_text('{"rest_seconds":-1}')
        report=Mock()
        self.assertEqual(ContextConfig.load(self.path,report),ContextConfig())
        report.assert_called_once()

    def test_manual_click_keyboard_cancel_and_saved_confirmation(self):
        import cv2, numpy as np
        cv=Mock(wraps=cv2);cv.error=cv2.error
        for n in ('WINDOW_AUTOSIZE','EVENT_LBUTTONDOWN','EVENT_RBUTTONDOWN'):
            setattr(cv,n,getattr(cv2,n))
        cv.namedWindow=Mock();cv.setMouseCallback=Mock()
        ui=CalibrationUI(cv,'test',self.cal);ui.size=SIZE
        ui.guard=Mock();ui.guard.capture.return_value=True
        frame=np.zeros((1000,1000,3),dtype=np.uint8)
        ui.mouse(cv2.EVENT_LBUTTONDOWN,5,5,None,None)
        self.assertTrue(ui.editing)
        for x,y in BED:ui.mouse(cv2.EVENT_LBUTTONDOWN,int(x*1000),int(y*1000)+28,None,None)
        ui.handle(13,frame,[])
        self.assertTrue(self.cal.active)
        ui.handle(ord('r'),frame,[]);self.assertFalse(self.cal.active)
        self.assertEqual(self.cal.polygon,[])
        ui.handle(ord('b'),frame,[]);self.assertFalse(self.cal.active)
        ui.guard=Mock();ui.guard.capture.return_value=True
        for x,y in BED:ui.mouse(cv2.EVENT_LBUTTONDOWN,int(x*1000),int(y*1000)+28,None,None)
        ui.handle(ord('b'),frame,[]);self.assertTrue(self.cal.active)
        ui.handle(ord('c'),frame,[]);ui.handle(27,frame,[])
        self.assertFalse(self.cal.active)

    def test_background_occlusion_pauses_context_and_recovers_without_recalibration(self):
        import cv2, numpy as np
        cv=Mock(wraps=cv2);cv.error=cv2.error
        cv.namedWindow=Mock();cv.setMouseCallback=Mock()
        ui=CalibrationUI(cv,'test',self.cal)
        ui.guard=Mock();frame=np.zeros((1000,1000,3),np.uint8)
        self.cal.confirm(BED,SIZE)
        ui.guard.check.return_value='Cannot verify background; recalibrate'
        ui.observe(frame,[],0)
        self.assertTrue(self.cal.active)
        self.assertFalse(self.cal.verified)
        self.assertEqual(self.cal.view_revision,0)
        ui.guard.check.return_value='verified'
        ui.observe(frame,[],.6)
        self.assertTrue(self.cal.verified)
        ui.guard.check.return_value='Camera view changed; recalibrate'
        ui.observe(frame,[],1)
        self.assertFalse(self.cal.active)
        self.assertEqual(self.cal.view_revision,1)

    def test_real_opencv_background_shift_masking_and_insufficient_features(self):
        import cv2, numpy as np
        rng=np.random.default_rng(42)
        frame=rng.integers(0,255,(360,640,3),dtype=np.uint8)
        guard=ViewGuard(cv2)
        self.assertTrue(guard.capture(frame,[]))
        self.assertEqual(guard.check(frame,[],0),'verified')
        person=frame.copy();person[140:220,220:300]=0
        self.assertEqual(guard.check(person,[(220,140,300,220)],.6),'verified')
        moved=cv2.warpAffine(frame,np.float32([[1,0,45],[0,1,25]]),(640,360))
        self.assertIn('Possible camera movement',guard.check(moved,[],1.2))
        self.assertIn('changed',guard.check(moved,[],1.8))
        self.assertFalse(guard.capture(np.zeros_like(frame),[]))

    def test_real_opencv_bedding_deformation_and_occupied_bed_keep_fixed_view(self):
        import cv2, numpy as np
        rng=np.random.default_rng(27)
        frame=rng.integers(0,255,(360,640,3),dtype=np.uint8)
        bed=[(.1,.3),(.9,.3),(.9,.8),(.1,.8)]
        occupied=frame.copy()
        occupied[108:289,64:577]=rng.integers(0,255,(181,513,3),dtype=np.uint8)
        person=(100,125,560,280)
        guard=ViewGuard(cv2)
        self.assertTrue(guard.capture(frame,[],bed))
        points,_,size=guard.reference
        self.assertTrue(all(not (.1*size[0]<=x<=.9*size[0] and .3*size[1]<=y<=.8*size[1]) for x,y in points))
        self.assertEqual(guard.check(occupied,[person],0),'verified')
        self.assertEqual(guard.check(occupied,[person],.6),'verified')

    def test_bed_only_texture_cannot_verify_fixed_background(self):
        import cv2, numpy as np
        frame=np.zeros((360,640,3),np.uint8)
        rng=np.random.default_rng(29)
        frame[110:285,70:570]=rng.integers(0,255,(175,500,3),dtype=np.uint8)
        guard=ViewGuard(cv2)
        self.assertFalse(guard.capture(frame,[],[(.08,.28),(.92,.28),(.92,.82),(.08,.82)]))

    def test_occlusion_never_claims_camera_movement_and_reference_is_not_replaced(self):
        import cv2, numpy as np
        frame=np.random.default_rng(31).integers(0,255,(360,640,3),dtype=np.uint8)
        guard=ViewGuard(cv2);self.assertTrue(guard.capture(frame,[]))
        reference=guard.reference
        for i in range(4):
            message=guard.check(np.zeros_like(frame),[(0,0,640,360)],i*.6)
            self.assertIn('paused',message)
            self.assertNotIn('Camera view changed',message)
        self.assertIs(guard.reference,reference)
        self.assertEqual(guard.check(frame,[],3.),'verified')

    def test_single_camera_motion_outlier_is_paused_and_recovery_never_reanchors(self):
        import cv2, numpy as np
        frame=np.random.default_rng(37).integers(0,255,(360,640,3),dtype=np.uint8)
        guard=ViewGuard(cv2);self.assertTrue(guard.capture(frame,[]))
        reference=guard.reference
        moved=cv2.warpAffine(frame,np.float32([[1,0,45],[0,1,25]]),(640,360))
        self.assertIn('Possible camera movement',guard.check(moved,[],0))
        self.assertEqual(guard.check(frame,[],.6),'verified')
        self.assertIs(guard.reference,reference)
        self.assertIn('Possible camera movement',guard.check(moved,[],1.2))
        self.assertIn('Camera view changed',guard.check(moved,[],1.8))

    def test_location_hint_is_bounded_and_never_reported_as_verified_zone(self):
        self.cal.confirm(BED,SIZE)
        pose=detection(angle=84)
        revision=self.cal.revision
        self.cal.verify(False,'Background obscured; bed context paused',now=1.)
        self.assertEqual(self.cal.zone(pose.points,pose.confidences,SIZE),'unknown')
        self.assertEqual(self.cal.held_zone(pose.points,pose.confidences,SIZE,2.9),'inside')
        self.cal.verify(False,'Background obscured; bed context paused',now=2.9)
        self.assertEqual(self.cal.held_zone(pose.points,pose.confidences,SIZE,3.01),'unknown')
        self.assertEqual(self.cal.held_zone(pose.points,pose.confidences,SIZE,.9),'unknown')
        self.assertEqual(self.cal.revision,revision)

    def test_movement_candidate_cannot_reenable_location_hint_on_later_weak_matches(self):
        self.cal.confirm(BED,SIZE)
        self.cal.verify(False,'Possible camera movement',state='motion_pending',now=1.)
        self.cal.verify(False,'Background obscured',now=1.1)
        self.assertEqual(self.cal.verification_state,'motion_pending')
        self.assertFalse(self.cal.holding_location(1.1))
        self.cal.verify(True,'Bed area calibrated; keep camera still',now=1.2)
        self.assertEqual(self.cal.verification_state,'verified')
        self.cal.verify(False,'Background obscured',now=1.3)
        self.assertTrue(self.cal.holding_location(1.3))

    def test_dimension_change_invalidates_the_uncertain_location_hint(self):
        self.cal.confirm(BED,SIZE)
        self.cal.verify(False,'Background obscured',now=1.)
        self.cal.view((640,480))
        self.assertFalse(self.cal.holding_location(1.1))
        self.assertEqual(self.cal.verification_state,'view_changed')

    def test_inconsistent_background_transforms_do_not_count_as_repeated_camera_motion(self):
        import cv2, numpy as np
        frame=np.random.default_rng(59).integers(0,255,(360,640,3),dtype=np.uint8)
        guard=ViewGuard(cv2);self.assertTrue(guard.capture(frame,[]))
        reference=guard.reference
        right=cv2.warpAffine(frame,np.float32([[1,0,45],[0,1,25]]),(640,360))
        left=cv2.warpAffine(frame,np.float32([[1,0,-45],[0,1,-25]]),(640,360))
        self.assertIn('Possible camera movement',guard.check(right,[],0))
        self.assertIn('Possible camera movement',guard.check(left,[],.6))
        self.assertIn('Possible camera movement',guard.check(right,[],1.2))
        self.assertIn('Camera view changed',guard.check(right,[],1.8))
        self.assertIs(guard.reference,reference)

    def test_overlay_distinguishes_verified_occluded_and_confirmed_view_change(self):
        ui,frame=self.control_ui()
        self.cal.confirm(BED,SIZE)
        ui.overlay(frame)
        self.assertTrue(any(c.args[1]=='Calibration: verified' for c in ui.cv.putText.call_args_list))
        ui.cv.putText.reset_mock()
        self.cal.verify(False,'Background obscured',now=1.)
        ui.observed_at=1.1;ui.overlay(frame)
        self.assertTrue(any('2s location grace' in c.args[1] for c in ui.cv.putText.call_args_list))
        ui.cv.putText.reset_mock()
        self.cal.invalidate('Camera view changed; recalibrate',view_changed=True)
        ui.overlay(frame)
        self.assertTrue(any('Calibration: view changed' in c.args[1] for c in ui.cv.putText.call_args_list))
        self.assertEqual(ui.cv.polylines.call_args.args[3],(0,0,255))

    def test_unchanged_background_overrules_a_spurious_repeated_feature_transform(self):
        import cv2, numpy as np
        frame=np.random.default_rng(71).integers(0,255,(360,640,3),dtype=np.uint8)
        # Repetitive rails model the aliasing risk; independent background tiles
        # still have strong unchanged appearance. A false fit must not be used.
        for x in range(40,600,40):cv2.rectangle(frame,(x,150),(x+10,300),(130,170,140),-1)
        guard=ViewGuard(cv2);self.assertTrue(guard.capture(frame,[]))
        wrong=np.array([[1.,0,50],[0,1.,30],[0,0,1.]])
        with patch.object(cv2,'findHomography',return_value=(wrong,np.ones((20,1),np.uint8))) as fit:
            for i in range(5):self.assertEqual(guard.check(frame,[],i*.6),'verified')
            fit.assert_not_called()
        self.assertIn('identity 1.00',guard.diagnostic)
        self.assertEqual(guard.motion_checks,0)

    def test_brightness_change_alone_never_invalidates_an_empty_fixed_view(self):
        import cv2, numpy as np
        rng=np.random.default_rng(73)
        frame=rng.integers(20,210,(360,640,3),dtype=np.uint8)
        changed=np.clip(frame.astype(float)*.75+20+rng.normal(0,2,frame.shape),0,255).astype(np.uint8)
        guard=ViewGuard(cv2);self.assertTrue(guard.capture(frame,[]))
        original=guard.reference
        for i in range(5):self.assertEqual(guard.check(changed,[],i*.6),'verified')
        self.assertIs(guard.reference,original)

    def test_bad_feature_shift_without_image_support_never_counts_towards_red_frame(self):
        import cv2, numpy as np
        rng=np.random.default_rng(79)
        frame=rng.integers(0,255,(360,640,3),dtype=np.uint8)
        changed=frame.copy();changed[180:]=rng.integers(0,255,changed[180:].shape,dtype=np.uint8)
        guard=ViewGuard(cv2);self.assertTrue(guard.capture(frame,[]))
        wrong=np.array([[1.,0,45],[0,1.,25],[0,0,1.]])
        with patch.object(cv2,'findHomography',side_effect=lambda a,*args:(wrong,np.ones((len(a),1),np.uint8))):
            for i in range(5):
                message=guard.check(changed,[],i*.6)
                self.assertIn('lacks independent image support',message)
                self.assertEqual(guard.motion_checks,0)
        self.assertIn('alignment',guard.diagnostic)

    def test_masked_pixels_cannot_vote_for_unchanged_background(self):
        import cv2, numpy as np
        frame=np.random.default_rng(83).integers(0,255,(360,640,3),dtype=np.uint8)
        guard=ViewGuard(cv2);self.assertTrue(guard.capture(frame,[]))
        message=guard.check(frame,[(0,0,640,360)],0)
        self.assertIn('obscured',message)
        self.assertIn('0 tiles',guard.diagnostic)
        self.assertNotEqual(message,'verified')

    def test_only_masked_background_reference_is_retained_in_memory(self):
        import cv2, numpy as np
        frame=np.random.default_rng(89).integers(0,255,(360,640,3),dtype=np.uint8)
        guard=ViewGuard(cv2)
        self.assertTrue(guard.capture(frame,[(450,20,620,170)],[(.1,.4),(.7,.4),(.7,.9),(.1,.9)]))
        self.assertEqual(guard.reference_gray.shape,(270,480))
        self.assertTrue(np.all(guard.reference_gray[guard.reference_mask==0]==0))
        self.assertEqual(list(Path(self.tmp.name).iterdir()),[])

    def test_confirmed_camera_shift_records_image_evidence_and_clears_stale_confirmation(self):
        import cv2, numpy as np
        ui,frame=self.control_ui();ui.guard=ViewGuard(cv2)
        frame=np.random.default_rng(97).integers(0,255,frame.shape,dtype=np.uint8)
        self.cal.confirm(BED,SIZE)
        self.assertTrue(ui.guard.capture(frame,[],BED))
        ui.message='Outline confirmed'
        moved=cv2.warpAffine(frame,np.float32([[1,0,100],[0,1,50]]),SIZE)
        ui.observe(moved,[],0)
        self.assertEqual(ui.message,'')
        ui.observe(moved,[],.6)
        self.assertFalse(self.cal.active)
        self.assertEqual(self.cal.verification_state,'view_changed')
        self.assertIn('alignment',self.cal.reason)
        self.assertIn('checks 2/2',self.cal.reason)
        context=ContextMonitor(self.cal)
        base=MultiPersonMonitor(detector_rules().update_status)
        state=context.update(base.update([],1.),1.,SIZE)
        self.assertTrue(any('alignment' in e.reason for e in state.events if e.status=='Bed Calibration'))

    def test_guard_evidence_overlay_wraps_to_fit_a_small_camera_frame(self):
        import cv2, numpy as np
        ui,_=self.control_ui()
        ui.guard.diagnostic='Shift 0.130; inliers 120; alignment 0.95 vs 0.02; checks 2/2'
        self.cal.invalidate('Camera view changed; recalibrate; '+ui.guard.diagnostic,view_changed=True)
        ui.overlay(np.zeros((480,640,3),np.uint8))
        lines=[c.args[1] for c in ui.cv.putText.call_args_list]
        self.assertTrue(any('alignment' in s for s in lines))
        self.assertTrue(all(cv2.getTextSize(s,cv2.FONT_HERSHEY_SIMPLEX,.4,1)[0][0]<=620 for s in lines))

    def control_ui(self):
        import cv2, numpy as np
        cv=Mock(wraps=cv2);cv.error=cv2.error
        cv.namedWindow=Mock();cv.setMouseCallback=Mock()
        for name in ('WINDOW_AUTOSIZE','EVENT_LBUTTONDOWN','EVENT_RBUTTONDOWN','FONT_HERSHEY_SIMPLEX'):
            setattr(cv,name,getattr(cv2,name))
        ui=CalibrationUI(cv,'test',self.cal);ui.size=SIZE
        ui.guard=Mock();ui.guard.capture.return_value=True
        return ui,np.zeros((1000,1000,3),np.uint8)

    def test_b_and_enter_both_save_draft_and_confirm_saved_outline(self):
        for key in (ord('b'),ord('B'),10,13):
            ui,frame=self.control_ui();ui.begin();ui.points=list(BED)
            ui.handle(key,frame,[])
            self.assertTrue(self.cal.active)
            self.assertFalse(ui.editing)
            self.assertIn('Outline confirmed',ui.message)
            self.cal.invalidate('needs confirmation')
            ui.handle(key,frame,[])
            self.assertTrue(self.cal.active)
            self.assertTrue(self.cal.verified)

    def test_confirm_button_uses_latest_frame_without_keyboard_focus(self):
        import cv2
        ui,frame=self.control_ui();ui.begin();ui.points=list(BED)
        ui.mouse(cv2.EVENT_LBUTTONDOWN,250,12,None,None)
        self.assertFalse(self.cal.active)
        ui.handle(-1,frame,[])
        self.assertTrue(self.cal.active)
        self.assertIsNone(ui.pending_key)
        ui.guard.capture.assert_called_once_with(frame,[],list(BED))
        ui.mouse(cv2.EVENT_LBUTTONDOWN,480,12,None,None)
        ui.handle(-1,frame,[])
        self.assertFalse(self.cal.active)

    def test_b_during_incomplete_drawing_does_not_reactivate_saved_outline(self):
        self.cal.confirm(BED,SIZE)
        ui,frame=self.control_ui();ui.begin();ui.points=[(.1,.1),(.2,.2)]
        ui.handle(ord('b'),frame,[])
        self.assertFalse(self.cal.active)
        self.assertTrue(ui.editing)
        self.assertIn('3 to 12',ui.message)
        ui.guard.capture.assert_not_called()

    def test_confirm_without_outline_has_actionable_feedback(self):
        for key in (ord('b'),13):
            ui,frame=self.control_ui();ui.handle(key,frame,[])
            self.assertFalse(self.cal.active)
            self.assertIn('Press C',ui.message)
            ui.guard.capture.assert_not_called()

    def test_escape_cancels_a_queued_confirmation_click(self):
        import cv2
        ui,frame=self.control_ui();ui.begin();ui.points=list(BED)
        ui.mouse(cv2.EVENT_LBUTTONDOWN,250,12,None,None)
        ui.handle(27,frame,[])
        self.assertFalse(self.cal.active)
        self.assertFalse(ui.editing)
        ui.guard.capture.assert_not_called()

if __name__=='__main__':unittest.main()
