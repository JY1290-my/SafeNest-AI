"""Per-person state around the unchanged fall rules; no camera/model imports.

Tracker IDs are temporary associations, not identities. Ambiguous associations
discard old confirmation history rather than transferring it to another person.
"""
from dataclasses import dataclass
import importlib.util
import inspect
import math
from pathlib import Path
from types import SimpleNamespace


TRACK_TTL_SECONDS = 2.0
MATCH_MARGIN = 0.15
PRIORITY = {"Normal": 0, "Pose Unclear": 1, "Checking": 2, "Suspected Fall": 3}


@dataclass
class Detection:
    index: int
    box: tuple
    features: object = None
    valid_box: bool = True
    points: object = None
    confidences: object = None


@dataclass
class Person:
    number: int
    box: tuple
    last_seen: float
    native_id: object = None
    status: str = "Starting"
    since: object = None
    features: object = None
    visible: bool = True
    points: object = None
    confidences: object = None
    paused_at: object = None
    display_status: object = None

    @property
    def label(self):
        return f"Person {self.number}"


@dataclass
class Event:
    status: str
    features: object = None
    reason: str = ""


@dataclass
class FrameState:
    status: str
    visible: list
    missing: list
    events: list
    should_alarm: bool
    features: object = None


def _values(value):
    if hasattr(value, "cpu"):
        value = value.cpu()
    if hasattr(value, "numpy"):
        value = value.numpy()
    return value


def detections_from_result(result, feature_function):
    """Use original detection indices, never indices from filtered tracker rows."""
    boxes = result.boxes
    if boxes is None:
        return []
    keypoints = result.keypoints
    aligned = keypoints is not None and len(keypoints) == len(boxes)
    detections = []
    for index in range(len(boxes)):
        box = tuple(float(v) for v in _values(boxes.xyxy[index]))
        valid = (len(box) == 4 and all(math.isfinite(v) for v in box)
                 and box[2] > box[0] and box[3] > box[1])
        features = None
        saved_points = saved_confidences = None
        if valid and aligned:
            try:
                points = _values(keypoints.xy[index])
                confidences = (_values(keypoints.conf[index])
                               if keypoints.conf is not None else None)
                # Invalid/misaligned tensors must fail closed, not mix people.
                if (confidences is not None and len(points) >= 17 and len(confidences) >= 17
                        and all(math.isfinite(float(v)) for p in points for v in p)
                        and all(math.isfinite(float(v)) for v in confidences)):
                    features = feature_function(points, confidences, box)
                    saved_points = tuple(tuple(float(v) for v in p) for p in points)
                    saved_confidences = tuple(float(v) for v in confidences)
            except (IndexError, TypeError, ValueError):
                features = None
        detections.append(Detection(index, box if valid else (0, 0, 1, 1), features, valid,
                                    saved_points, saved_confidences))
    return detections


class NativeTracker:
    """Optional built-in ByteTrack adapter, preserving ALL raw pose detections.

model.track() filters unconfirmed detections in some supported versions. We
instead run the installed BYTETracker after the existing model.predict(), use
its source-index/ID hints, and still assess every original detection. Native
IDs never directly index keypoints or own fall confirmation state.
"""
    def __init__(self, tracker=None, report=print):
        self.tracker = tracker
        self.report = report

    @classmethod
    def create(cls, report=print):
        try:
            # Older Ultralytics attempts to pip-install lapx on import if absent.
            # Check first; starting the detector must never install dependencies.
            if any(importlib.util.find_spec(n) is None for n in ("lap", "scipy", "numpy")):
                raise ImportError("optional lap/scipy/numpy tracker dependencies unavailable")
            import ultralytics
            import yaml
            from ultralytics.trackers.byte_tracker import BYTETracker
            path = Path(ultralytics.__file__).parent / "cfg" / "trackers" / "bytetrack.yaml"
            args = SimpleNamespace(**yaml.safe_load(path.read_text(encoding="utf-8")))
            # 8.3 accepts frame_rate; newer 8.4 releases use only args.
            kwargs = {"frame_rate": 30} if "frame_rate" in inspect.signature(BYTETracker).parameters else {}
            tracker = BYTETracker(args, **kwargs)
        except (ImportError, OSError, AttributeError, TypeError, ValueError, AssertionError) as exc:
            report(f"Tracking: conservative box association ({type(exc).__name__}).")
            return cls(report=report)
        report(f"Tracking: built-in ByteTrack (Ultralytics {ultralytics.__version__}).")
        return cls(tracker, report)

    def ids(self, result):
        if self.tracker is None or result.boxes is None:
            return {}
        try:
            rows = self.tracker.update(result.boxes.cpu().numpy())
            hints = {}
            used_ids = set()
            for row in rows:
                # Non-OBB pose output: x1,y1,x2,y2,track_id,score,class,source_index.
                if len(row) != 8:
                    raise ValueError("unsupported ByteTrack result layout")
                if not all(math.isfinite(float(row[i])) for i in (-1, 4)):
                    raise ValueError("non-finite ByteTrack association")
                index, native_id = int(row[-1]), int(row[4])
                if (index != row[-1] or native_id != row[4] or native_id <= 0
                        or not 0 <= index < len(result.boxes)
                        or index in hints or native_id in used_ids):
                    raise ValueError("invalid ByteTrack association")
                hints[index] = native_id
                used_ids.add(native_id)
            return hints
        except (ImportError, AttributeError, TypeError, ValueError, RuntimeError, AssertionError, IndexError) as exc:
            self.report(f"Tracking: ByteTrack unavailable ({type(exc).__name__}); using conservative box association.")
            self.tracker = None
            return {}


def _score(a, b):
    intersection = max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(0, min(a[3], b[3]) - max(a[1], b[1]))
    area_a = (a[2] - a[0]) * (a[3] - a[1])
    area_b = (b[2] - b[0]) * (b[3] - b[1])
    iou = intersection / max(area_a + area_b - intersection, 1)
    scale = max(a[2] - a[0], a[3] - a[1], b[2] - b[0], b[3] - b[1], 1)
    distance = math.hypot((a[0]+a[2]-b[0]-b[2])/2, (a[1]+a[3]-b[1]-b[3])/2) / scale
    if iou < 0.1 or distance > 0.75:
        return None
    return iou + 0.2 * (1 - distance)


def _unique_best(candidates):
    ordered = sorted(candidates, reverse=True)
    if not ordered or (len(ordered) > 1 and ordered[0][0] - ordered[1][0] < MATCH_MARGIN):
        return None
    return ordered[0][1]


class MultiPersonMonitor:
    def __init__(self, status_function, ttl=TRACK_TTL_SECONDS, preserve_occlusion=False):
        self.status_function = status_function
        self.ttl = ttl
        self.people = {}
        self.next_number = 1
        self.last_status = None
        self.alarm_active = False
        self.preserve_occlusion = preserve_occlusion

    def update(self, detections, now, native_ids=None):
        native_ids = native_ids or {}
        events = []
        for number, person in list(self.people.items()):
            if now - person.last_seen > self.ttl:
                events.append(Event(f"{person.label}: Track Expired"))
                del self.people[number]
        # A wholly new scene after TTL is a new alarm episode.
        if not self.people:
            self.alarm_active = False

        scores = {}
        for d in detections:
            if not d.valid_box:
                continue
            for number, p in self.people.items():
                score = _score(d.box, p.box)
                if score is not None:
                    scores[d.index, number] = score

        matches, retired = {}, set()
        column_best = {
            n: _unique_best([(s, i) for (i, number), s in scores.items() if number == n])
            for n in self.people
        }
        for d in detections:
            candidates = [(s, n) for (i, n), s in scores.items() if i == d.index]
            number = _unique_best(candidates)
            if number is None:
                if candidates:
                    best = max(s for s, _ in candidates)
                    # A new bystander may overlap existing people who each have
                    # a clearly better match. Do not retire those good matches.
                    retired.update(n for s, n in candidates if best-s < MATCH_MARGIN
                                   and column_best[n] in (None, d.index))
                continue
            if column_best[number] != d.index:
                if column_best[number] is None:
                    retired.add(number)
                continue
            previous_id = self.people[number].native_id
            current_id = native_ids.get(d.index)
            if previous_id is not None and current_id is not None and previous_id != current_id:
                retired.add(number)
                continue
            matches[d.index] = number

        for number in retired:
            events.append(Event(f"{self.people[number].label}: Track Reset"))
            del self.people[number]
        matches = {i: n for i, n in matches.items() if n not in retired}

        visible = []
        for d in detections:
            number = matches.get(d.index)
            if number is None:
                number = self.next_number
                self.next_number += 1
                self.people[number] = Person(number, d.box, now)
            person = self.people[number]
            # Neither absent frames nor ambiguous identity can confirm a fall.
            if self.preserve_occlusion:
                if d.features is None and getattr(person, "paused_at", None) is None:
                    person.paused_at = person.last_seen
                if person.paused_at is not None and now-person.paused_at > self.ttl:
                    # A box may remain visible while pose is unreliable for a
                    # long time. Old confirmation evidence must still expire.
                    person.since = None
                if d.features is not None and getattr(person, "paused_at", None) is not None:
                    # Exclude the entire unobserved interval, including unreliable
                    # keypoints; retain only previously observed confirmation time.
                    if person.since is not None:
                        person.since += max(0, now-person.paused_at)
                    person.paused_at = None
            elif not person.visible:
                person.since = None
            previous = person.status
            person.box, person.last_seen, person.visible = d.box, now, True
            person.native_id = native_ids.get(d.index, person.native_id)
            person.features = d.features
            person.points, person.confidences = d.points, d.confidences
            if self.preserve_occlusion and d.features is None:
                if person.status != "Suspected Fall":
                    person.status = "Pose Unclear"
            else:
                person.status, person.since = self.status_function(d.features, now, person.since)
            if person.status != previous:
                events.append(Event(f"{person.label}: {person.status}", person.features))
            visible.append(person)

        visible_ids = {p.number for p in visible}
        missing = []
        for p in self.people.values():
            if p.number not in visible_ids:
                if self.preserve_occlusion:
                    if p.visible:
                        events.append(Event(f"{p.label}: Tracking Lost", reason="Person no longer visible"))
                    if getattr(p, "paused_at", None) is None:
                        p.paused_at = p.last_seen
                    p.visible = False
                    missing.append(p)
                    continue
                if p.status != "Pose Unclear":
                    events.append(Event(f"{p.label}: Pose Unclear"))
                p.status, p.since, p.features, p.visible = "Pose Unclear", None, None, False
                missing.append(p)

        strongest = max(visible + missing, key=lambda p: PRIORITY[p.status], default=None)
        status = strongest.status if visible else "No Person"
        # The scalar feature display always belongs to the displayed overall state.
        features = strongest.features if visible and strongest else None
        if status != self.last_status:
            events.append(Event(status, features))
        self.last_status = status
        should_alarm = status == "Suspected Fall" and not self.alarm_active
        if should_alarm:
            self.alarm_active = True
        elif status == "Normal":
            self.alarm_active = False
        return FrameState(status, visible, missing, events, should_alarm, features)


def write_events(frame_state, timestamp, writer, log_file, bridge_state, context_log=None):
    """Keep the original four-column CSV and existing cloud event interface."""
    for event in frame_state.events:
        angle = f"{event.features[0]:.1f}" if event.features is not None else ""
        ratio = f"{event.features[1]:.2f}" if event.features is not None else ""
        writer.writerow([timestamp, event.status, angle, ratio])
        if event.reason:
            bridge_state.record_event(timestamp, event.status, angle, ratio, reason=event.reason)
            if context_log is not None:
                import json
                context_log.write(json.dumps({"time": timestamp, "status": event.status,
                                              "reason": event.reason},ensure_ascii=False)+"\n")
        else:
            bridge_state.record_event(timestamp, event.status, angle, ratio)
        print(f"{timestamp} | {event.status}")
    if frame_state.events:
        log_file.flush()
        if context_log is not None:
            context_log.flush()


def status_color(status):
    if status == "Suspected Fall":
        return (0, 0, 255)
    return (0, 200, 0) if status == "Normal" else (0, 200, 255)


def draw_people(cv, annotated, state, now, confirm_seconds):
    for person in state.visible:
        x, y = max(5, int(person.box[0])), max(115, int(person.box[1]) - 8)
        shown = person.display_status or person.status
        text = f"{person.label}: {shown}"
        if person.since is not None and person.status == "Checking":
            text += f" {now - person.since:.1f}/{confirm_seconds:.1f}s"
        cv.putText(annotated, text, (x, y), cv.FONT_HERSHEY_SIMPLEX, 0.55,
                   status_color(shown), 2)
    cv.putText(annotated, f"Status: {state.status}", (20, 35), cv.FONT_HERSHEY_SIMPLEX,
               0.8, status_color(state.status), 2)
    cv.putText(annotated, f"Visible: {len(state.visible)} | Temporarily missing: {len(state.missing)}",
               (20, 65), cv.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
    if state.features is not None:
        cv.putText(annotated, f"Angle: {state.features[0]:.0f} deg | W/H: {state.features[1]:.2f}",
                   (20, 90), cv.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
