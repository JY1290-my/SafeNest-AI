"""Deterministic tests: no weights, model downloads, camera or Windows required."""
import csv
import importlib.util
import io
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE))
from multi_person import (Detection, MultiPersonMonitor, NativeTracker,
                          detections_from_result, write_events)
from monitor_bridge import MonitorState


def detector_rules():
    with patch.dict(sys.modules, {"cv2": Mock(), "winsound": Mock(), "ultralytics": Mock()}):
        spec = importlib.util.spec_from_file_location("multi_test_detector", BASE / "fall_detection.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module


NORMAL = (0, .5, 0)
FALL = (90, 2, 90)


def person(index, x=0, features=NORMAL):
    return Detection(index, (x, 0, x + 100, 200), features)


class MultiPersonTests(unittest.TestCase):
    def setUp(self):
        self.rules = detector_rules()
        self.monitor = MultiPersonMonitor(self.rules.update_status)

    def test_zero_one_two_people(self):
        self.assertEqual(self.monitor.update([], 0).status, "No Person")
        first = self.monitor.update([person(0)], .1)
        self.assertEqual(first.status, "Normal")
        pair = self.monitor.update([person(0), person(1, 400)], .2)
        self.assertEqual(pair.status, "Normal")
        self.assertEqual([p.number for p in pair.visible], [1, 2])

    def test_one_person_matches_original_rules_frame_for_frame(self):
        since = None
        samples = [(0, NORMAL), (.1, FALL), (1, FALL), (1.6, FALL), (1.7, None),
                   (2, FALL), (3.5, FALL), (3.6, (90, 2, None)), (4, (90, 2, 0)), (4.5, NORMAL)]
        for now, features in samples:
            expected, since = self.rules.update_status(features, now, since)
            output = self.monitor.update([person(0, features=features)], now)
            self.assertEqual(output.status, expected)
            self.assertEqual(output.visible[0].since, since)

    def test_independent_timers_and_one_fall_dominates(self):
        self.monitor.update([person(0, features=FALL), person(1, 400)], 0)
        self.monitor.update([person(0, features=FALL), person(1, 400, FALL)], 1)
        out = self.monitor.update([person(0, features=FALL), person(1, 400, FALL)], 1.5)
        self.assertEqual([p.status for p in out.visible], ["Suspected Fall", "Checking"])
        self.assertEqual([p.since for p in out.visible], [0, 1])
        self.assertEqual(out.status, "Suspected Fall")
        self.assertTrue(out.should_alarm)
        out = self.monitor.update([person(0, features=FALL), person(1, 400, FALL)], 2.5)
        self.assertFalse(out.should_alarm)  # Same overall alert episode.
        self.assertIn("Person 2: Suspected Fall", [e.status for e in out.events])

    def test_normal_person_cannot_hide_unclear_or_checking_person(self):
        unclear = self.monitor.update([person(0), person(1, 400, None)], 0)
        self.assertEqual(unclear.status, "Pose Unclear")
        self.assertIsNone(unclear.features)
        checking = self.monitor.update([person(0), person(1, 400, FALL)], .1)
        self.assertEqual(checking.status, "Checking")

    def test_nearby_new_person_does_not_erase_a_clear_existing_match(self):
        self.monitor.update([person(0, features=FALL)], 0)
        out = self.monitor.update([person(0, features=FALL), person(1, 70)], 1.5)
        self.assertEqual(out.visible[0].number, 1)
        self.assertEqual(out.visible[0].status, "Suspected Fall")
        self.assertEqual(out.visible[1].status, "Normal")
        self.assertTrue(out.should_alarm)

    def test_order_changes_do_not_exchange_timers(self):
        self.monitor.update([person(0, features=FALL), person(1, 400)], 0)
        out = self.monitor.update([person(0, 400), person(1, features=FALL)], 1.5)
        self.assertEqual([(p.number, p.status) for p in out.visible],
                         [(2, "Normal"), (1, "Suspected Fall")])

    def test_missing_person_is_unclear_while_other_remains_normal(self):
        self.monitor.update([person(0), person(1, 400)], 0)
        out = self.monitor.update([person(0)], .5)
        self.assertEqual(out.status, "Pose Unclear")
        self.assertEqual(out.missing[0].number, 2)
        out = self.monitor.update([person(0)], 1)
        self.assertEqual(out.events, [])  # No per-frame log flooding.
        out = self.monitor.update([person(0)], 2.1)
        self.assertEqual(out.status, "Normal")
        self.assertEqual(out.missing, [])

    def test_gap_keeps_id_but_never_counts_unseen_time(self):
        self.monitor.update([person(0, features=FALL)], 0)
        empty = self.monitor.update([], .8)
        self.assertEqual(empty.status, "No Person")
        self.assertIsNone(empty.missing[0].since)
        out = self.monitor.update([person(0, features=FALL)], 1)
        self.assertEqual(out.visible[0].number, 1)
        self.assertEqual(out.visible[0].since, 1)
        self.assertEqual(self.monitor.update([person(0, features=FALL)], 1.6).status, "Checking")
        self.assertEqual(self.monitor.update([person(0, features=FALL)], 2.5).status, "Suspected Fall")

    def test_expiry_and_native_id_reuse_start_new_history(self):
        self.monitor.update([person(0, features=FALL)], 0, {0: 11})
        out = self.monitor.update([person(0, features=FALL)], 2.1, {0: 11})
        self.assertEqual(out.visible[0].number, 2)
        self.assertEqual(out.visible[0].since, 2.1)
        self.assertEqual(out.status, "Checking")

    def test_native_id_switch_cannot_inherit_confirmation(self):
        self.monitor.update([person(0, features=FALL)], 0, {0: 11})
        out = self.monitor.update([person(0, features=FALL)], 1.5, {0: 99})
        self.assertEqual(out.visible[0].number, 2)
        self.assertEqual(out.status, "Checking")
        self.assertIn("Person 1: Track Reset", [e.status for e in out.events])

    def test_crossing_ambiguous_boxes_reset_even_with_native_hints(self):
        self.monitor.update([person(0, 0, FALL), person(1, 160)], 0, {0: 11, 1: 22})
        self.monitor.update([person(0, 35, FALL), person(1, 125)], .7, {0: 11, 1: 22})
        # Both boxes now overlap both old positions equally. IDs are not evidence.
        out = self.monitor.update([person(0, 80, FALL), person(1, 80)], 1.5, {0: 22, 1: 11})
        self.assertTrue(all(p.number > 2 for p in out.visible))
        self.assertEqual(out.status, "Checking")
        self.assertFalse(out.should_alarm)
        self.assertEqual(out.visible[0].since, 1.5)
        self.assertNotIn(1, self.monitor.people)
        self.assertNotIn(2, self.monitor.people)

    def test_separated_crossing_paths_keep_spatial_association(self):
        a = Detection(0, (0, 0, 100, 100), FALL)
        b = Detection(1, (0, 300, 100, 400), NORMAL)
        self.monitor.update([a, b], 0)
        for i in range(1, 4):
            a = Detection(1, (i*20, 0, i*20+100, 100), FALL)
            b = Detection(0, (i*20, 300, i*20+100, 400), NORMAL)
            out = self.monitor.update([b, a], i*.5)
        self.assertEqual([(p.number, p.status) for p in out.visible], [(2, "Normal"), (1, "Suspected Fall")])

    def test_alarm_dedup_gap_recovery_and_rearm(self):
        self.monitor.update([person(0, features=FALL)], 0)
        self.assertTrue(self.monitor.update([person(0, features=FALL)], 1.5).should_alarm)
        self.assertFalse(self.monitor.update([person(0, features=FALL)], 1.6).should_alarm)
        self.monitor.update([], 1.7)
        self.monitor.update([person(0, features=FALL)], 1.8)
        self.assertFalse(self.monitor.update([person(0, features=FALL)], 3.3).should_alarm)
        self.monitor.update([person(0)], 3.4)
        self.monitor.update([person(0, features=FALL)], 3.5)
        self.assertTrue(self.monitor.update([person(0, features=FALL)], 5).should_alarm)

    def test_alarm_rearms_after_old_scene_expires(self):
        self.monitor.update([person(0, features=FALL)], 0)
        self.monitor.update([person(0, features=FALL)], 1.5)
        self.monitor.update([], 3.6)
        self.monitor.update([person(0, features=FALL)], 4)
        self.assertTrue(self.monitor.update([person(0, features=FALL)], 5.5).should_alarm)

    def test_existing_csv_append_reload_and_cloud_metadata(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "events.csv"
            original = b"time,status,angle_deg,width_height_ratio\nold,Normal,0,0.5\n"
            path.write_bytes(original)
            bridge = MonitorState(path)
            out = self.monitor.update([person(0), person(1, 400, FALL)], 0)
            with path.open("a", newline="", encoding="utf-8") as f:
                write_events(out, "2026-10-15T08:00:00", csv.writer(f), f, bridge)
                out = self.monitor.update([person(0), person(1, 400, FALL)], 1.5)
                write_events(out, "2026-10-15T08:00:02", csv.writer(f), f, bridge)
            self.assertTrue(path.read_bytes().startswith(original))
            reloaded = MonitorState(path)
            self.assertEqual(list(bridge.events), list(reloaded.events))
            event = next(e for e in reloaded.events if e['status'] == "Person 2: Suspected Fall")
            self.assertEqual(event['angle_deg'], '90.0')
            self.assertLessEqual(len(event['status']), 40)
            bridge.update(out.status, True, out.features)
            payload = bridge.snapshot()
            self.assertEqual(payload['status'], 'Suspected Fall')
            self.assertEqual(payload['schema_version'], 1)
            self.assertNotIn('frame', payload)


class Tensor:
    def __init__(self, value): self.value = value
    def cpu(self): return self
    def numpy(self): return self.value


class Boxes:
    def __init__(self, boxes): self.xyxy = [Tensor(b) for b in boxes]
    def __len__(self): return len(self.xyxy)
    def cpu(self): return self
    def numpy(self): return self


class Keypoints:
    def __init__(self, horizontal):
        self.xy, self.conf = [], []
        for fall in horizontal:
            points = [[0, 0] for _ in range(17)]
            points[5] = points[6] = [100, 100] if fall else [0, 0]
            points[11] = points[12] = [0, 100]
            points[15] = points[16] = [100, 100] if fall else [0, 200]
            self.xy.append(Tensor(points))
            self.conf.append(Tensor([1]*17))
    def __len__(self): return len(self.xy)


class InputAndNativeTests(unittest.TestCase):
    def setUp(self):
        self.rules = detector_rules()
        self.result = types.SimpleNamespace(boxes=Boxes([(0, 0, 100, 200), (400, 0, 600, 100)]),
                                            keypoints=Keypoints([False, True]))

    def test_pose_and_box_indices_remain_aligned(self):
        detections = detections_from_result(self.result, self.rules.pose_features)
        self.assertEqual(detections[0].features, NORMAL)
        self.assertEqual(detections[1].features, FALL)

    def test_mismatched_keypoint_count_does_not_pair_wrong_person(self):
        self.result.keypoints = Keypoints([True])
        observations = detections_from_result(self.result, self.rules.pose_features)
        self.assertEqual(len(observations), 2)
        self.assertTrue(all(d.features is None for d in observations))

    def test_missing_short_or_nan_confidence_is_unclear(self):
        for bad in [None, [Tensor([1]), Tensor([float('nan')]*17)]]:
            self.result.keypoints.conf = bad
            observations = detections_from_result(self.result, self.rules.pose_features)
            self.assertTrue(all(d.features is None for d in observations))

    def test_invalid_box_is_unclear_not_normal(self):
        self.result.boxes.xyxy[0] = Tensor([float('nan'), 0, 100, 200])
        d = detections_from_result(self.result, self.rules.pose_features)[0]
        self.assertFalse(d.valid_box)
        self.assertIsNone(d.features)

    def test_native_uses_source_index_not_output_order(self):
        native = Mock()
        native.update.return_value = [[400,0,600,100,42,.9,0,1], [0,0,100,200,11,.9,0,0]]
        adapter = NativeTracker(native)
        hints = adapter.ids(self.result)
        self.assertEqual(hints, {1: 42, 0: 11})
        detections = detections_from_result(self.result, self.rules.pose_features)
        out = MultiPersonMonitor(self.rules.update_status).update(detections, 0, hints)
        self.assertEqual([(p.native_id, p.status) for p in out.visible], [(11, 'Normal'), (42, 'Checking')])

    def test_unconfirmed_native_detection_is_still_assessed(self):
        native = Mock(); native.update.return_value = []
        out = MultiPersonMonitor(self.rules.update_status).update(
            detections_from_result(self.result, self.rules.pose_features), 0, NativeTracker(native).ids(self.result))
        self.assertEqual(len(out.visible), 2)
        self.assertEqual(out.status, 'Checking')

    def test_native_failure_falls_back_once_without_losing_detections(self):
        native = Mock(); native.update.side_effect = TypeError('changed API')
        report = Mock(); adapter = NativeTracker(native, report)
        self.assertEqual(adapter.ids(self.result), {})
        self.assertEqual(adapter.ids(self.result), {})
        native.update.assert_called_once()
        report.assert_called_once()

    def test_invalid_native_mapping_rejected(self):
        for rows in [
            [[0,0,100,200,1,.9,0,9]],
            [[0,0,100,200,1,.9,0,0], [400,0,600,100,1,.9,0,1]],
            [[0,0,100,200,1,.9,0,.5]],
            [[0,0,100,200,1]],
            [[0,0,100,200,float('inf'),.9,0,0]],
        ]:
            native = Mock(); native.update.return_value = rows
            adapter = NativeTracker(native, Mock())
            self.assertEqual(adapter.ids(self.result), {})
            self.assertIsNone(adapter.tracker)

    def test_optional_dependency_absent_uses_fallback_without_import(self):
        with patch('multi_person.importlib.util.find_spec', return_value=None):
            adapter = NativeTracker.create(Mock())
        self.assertIsNone(adapter.tracker)

    def test_native_factory_supports_old_and_new_constructor_signatures(self):
        class OldTracker:
            def __init__(self, args, frame_rate=30):
                self.args, self.frame_rate = args, frame_rate
        class NewTracker:
            def __init__(self, args):
                self.args = args
        for tracker_type in (OldTracker, NewTracker):
            modules = {
                'ultralytics': types.SimpleNamespace(__file__='/fake/ultralytics/__init__.py', __version__='test'),
                'ultralytics.trackers.byte_tracker': types.SimpleNamespace(BYTETracker=tracker_type),
                'yaml': types.SimpleNamespace(safe_load=lambda _: {'track_buffer': 30}),
            }
            with patch.dict(sys.modules, modules), patch('multi_person.importlib.util.find_spec', return_value=object()), patch('multi_person.Path.read_text', return_value='test'):
                adapter = NativeTracker.create(Mock())
            self.assertIsInstance(adapter.tracker, tracker_type)
            self.assertEqual(adapter.tracker.args.track_buffer, 30)


if __name__ == '__main__':
    unittest.main()
