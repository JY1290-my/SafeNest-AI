"""Scene context with narrowly evidenced, continuous bed-entry arbitration.

No image/model/cloud imports. Temporary track numbers are owned by multi_person,
never matched here. Bed location is a 2-D projection, not a depth/floor estimate.
"""
from collections import deque
from dataclasses import dataclass, field, fields
import json
import math
from pathlib import Path

from multi_person import Event, FrameState


@dataclass(frozen=True)
class ContextConfig:
    history_seconds: float = 3.0
    sample_seconds: float = .1
    max_gap_seconds: float = .6
    rest_seconds: float = 3.0
    recovery_seconds: float = 1.0
    recline_angle: float = 60.0
    low_hip_y: float = .72
    low_torso_angle: float = 35.0
    descent_speed: float = .7  # hip displacement / body height / second
    descent_distance: float = .18  # body heights
    rotation_speed: float = 75.0  # degrees/second, with downward movement
    stable_speed: float = .2  # body heights/second
    stable_rotation: float = 25.0

    @classmethod
    def load(cls, path, report=print):
        try:
            p = Path(path)
            if p.stat().st_size > 8192:
                raise ValueError("oversized context config")
            values = json.loads(p.read_text(encoding="utf-8"))
            names = {f.name for f in fields(cls)}
            if not isinstance(values,dict) or set(values)-names:
                raise ValueError("unknown setting")
            for v in values.values():
                if isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) or v <= 0:
                    raise ValueError("settings must be positive finite numbers")
            config = cls(**values)
            if not (1 <= config.history_seconds <= 10 and .05 <= config.sample_seconds <= .5
                    and config.sample_seconds < config.max_gap_seconds <= 2
                    and 1 <= config.rest_seconds <= 30 and config.recline_angle <= 90
                    and config.low_torso_angle <= 90 and config.low_hip_y <= 1):
                raise ValueError("settings outside supported ranges")
            return config
        except FileNotFoundError:
            return cls()
        except (OSError,ValueError,TypeError):
            report("Context config invalid; using documented defaults. Baseline fall rules unchanged.")
            return cls()


@dataclass
class Observation:
    time: float
    hip: tuple
    shoulder: tuple
    height: float
    angle: float
    zone: str


@dataclass(frozen=True)
class RiskEvidence:
    time: float
    zone: str


# Boundary overlap and rotation alone are caution, not persistent fall evidence.
# All thresholds stay in ContextConfig; this only separates their meanings.
PERSISTENT_RISKS = {"descent", "outside", "exit"}
RISK_PRIORITY = {"descent":4, "exit":3, "outside":2, "pose":1}
RISK_MESSAGES = {
    "descent":"Rapid descent observed; check person",
    "exit":"Observed bed exit; reassessing posture",
    "outside":"Earlier outside fall-like posture; retained concern",
    "pose":"Sustained fall-like pose; bed context unavailable or unverified",
}


@dataclass
class ContextTrack:
    samples: deque = field(default_factory=lambda: deque(maxlen=200))
    state: str = "CHECK_PERSON"
    reason: str = "Observing posture"
    zone: str = "unknown"
    last_reliable: object = None
    stable_since: object = None
    recovery_since: object = None
    recovered_until: float = 0
    risk: bool = False
    risk_evidence: bool = False
    risk_reason: str = ""
    was_resting: bool = False
    entry_anchor: object = None
    entry_proven: bool = False
    entry_note: str = "Entry not observed for this track"
    bed_observed: bool = False
    bed_warning: bool = False
    location_hint: str = "unknown"
    started_at: object = None
    evidence: dict = field(default_factory=dict)
    exit_pending: bool = False
    # Human-readable explanation is logged on transitions, never per frame.
    logged: object = None

    def clear_entry(self, reason="Bed-entry history interrupted"):
        self.entry_anchor, self.entry_proven = None, False
        self.entry_note = reason
        self.stable_since = None

    def remember(self, source, now, zone):
        # The first observation remains attributable even when another source
        # appears later or the current location becomes inside.
        self.evidence.setdefault(source,RiskEvidence(now,zone))
        self.refresh_risk()

    def forget(self, *sources):
        for source in sources:
            self.evidence.pop(source,None)
        self.refresh_risk()

    def refresh_risk(self):
        self.risk_evidence = bool(PERSISTENT_RISKS.intersection(self.evidence))
        primary = max((s for s in self.evidence if s in RISK_PRIORITY),
                      key=lambda s:RISK_PRIORITY[s],default=None)
        self.risk = primary is not None
        self.risk_reason = (RISK_MESSAGES[primary] + " (observed at " + self.evidence[primary].zone + ")"
                            if primary else "")

    def evidence_summary(self):
        if not self.evidence:
            return "Evidence: none"
        origin = self.started_at if self.started_at is not None else min(e.time for e in self.evidence.values())
        return "Evidence: " + "; ".join(f"{s}@+{max(0,e.time-origin):.1f}s/{e.zone}"
            for s,e in sorted(self.evidence.items(),key=lambda item:(item[1].time,item[0])))


DISPLAY = {
    "ACTIVE": "Normal", "RECOVERED": "Normal", "LOWERING": "Check Person",
    "CHECK_PERSON": "Check Person", "RESTING_IN_BED": "Resting in Bed",
    "POSSIBLE_FALL": "Suspected Fall", "TRACKING_LOST": "Tracking Lost",
}
PRIORITY = {"Normal":0, "Resting in Bed":1, "Check Person":2,
            "Pose Unclear":2, "Tracking Lost":3, "Checking":4, "Suspected Fall":5}


class ContextMonitor:
    def __init__(self, calibration, config=None, keypoint_conf=.4):
        self.calibration, self.config = calibration, config or ContextConfig()
        self.keypoint_conf = keypoint_conf
        self.tracks = {}
        self.revision = calibration.revision
        self.last_status = None
        self.alarm_active = False
        self.metadata = {}
        self.last_calibration = None

    def observation(self, person, now, size, zone):
        points, confidence = person.points, person.confidences
        if person.features is None or points is None or confidence is None:
            return None
        try:
            if any(confidence[i] < self.keypoint_conf for i in (5,6,11,12)):
                return None
            w,h = size
            hip = ((points[11][0]+points[12][0])/(2*w),(points[11][1]+points[12][1])/(2*h))
            shoulder = ((points[5][0]+points[6][0])/(2*w),(points[5][1]+points[6][1])/(2*h))
            if any(not math.isfinite(v) or not 0 <= v <= 1 for v in hip+shoulder):
                return None
            return Observation(now,hip,shoulder,max((person.box[3]-person.box[1])/h,.02),
                               float(person.features[0]),zone)
        except (ValueError,IndexError,TypeError,ZeroDivisionError):
            return None

    def assess(self, p, t, now, size):
        c = self.config
        previous_bed_warning = t.bed_warning
        t.bed_warning = False
        if t.started_at is None:
            t.started_at = now
        zone = self.calibration.zone(p.points,p.confidences,size,self.keypoint_conf) if p.visible else "unknown"
        t.zone = zone
        t.location_hint = self.calibration.held_zone(p.points,p.confidences,size,now,
                                                   self.keypoint_conf) if p.visible else "unknown"
        soft_uncertainty = self.calibration.active and not self.calibration.verified
        hip_zone = self.calibration.zone(p.points,p.confidences,size,self.keypoint_conf,
                                         indices=(11,12)) if p.visible else "unknown"
        o = self.observation(p,now,size,zone) if p.visible else None
        if o is None:
            last_seen_in_bed = (t.bed_observed or previous_bed_warning) and not t.risk_evidence
            t.clear_entry("Keypoints or track temporarily lost")
            t.recovery_since = None
            t.was_resting = False
            if p.status == "Suspected Fall" and not last_seen_in_bed:
                t.remember("pose",now,"unknown")
                return "POSSIBLE_FALL", t.risk_reason + "; tracking now unreliable"
            t.bed_warning = previous_bed_warning and last_seen_in_bed
            return ("TRACKING_LOST" if t.last_reliable is not None or not p.visible else "CHECK_PERSON",
                    "Person no longer visible" if not p.visible else "Keypoints unreliable; cannot assess posture")
        gap = t.last_reliable is None or now-t.last_reliable > c.max_gap_seconds or t.state == "TRACKING_LOST"
        if gap:
            t.samples.clear()
            t.clear_entry("Entry not observed for this track" if t.last_reliable is None
                          else "Bed-entry history interrupted by a sample gap")
            t.recovery_since = None
            t.was_resting = False
        t.last_reliable = now
        while t.samples and now-t.samples[0].time > c.history_seconds:
            t.samples.popleft()
        recent = [s for s in t.samples if c.sample_seconds*.8 <= now-s.time <= c.max_gap_seconds]
        prior = recent[0] if recent else None
        speed = rotation = descent = 0.
        if prior:
            dt = now-prior.time
            descent = (o.hip[1]-prior.hip[1])/prior.height
            speed = math.hypot((o.hip[0]-prior.hip[0])*size[0]/size[1],o.hip[1]-prior.hip[1])/prior.height/dt
            rotation = abs(o.angle-prior.angle)/dt
            rapid_descent = (descent >= c.descent_distance and descent/dt >= c.descent_speed
                            or descent >= .06 and o.angle-prior.angle >= 25 and rotation >= c.rotation_speed)
            rapid_rotation = not t.was_resting and o.angle-prior.angle >= 25 and rotation >= c.rotation_speed
            if rapid_descent:
                t.remember("descent",now,zone)
            if rapid_rotation:
                t.remember("rotation",now,zone)
        reclined = o.angle >= c.recline_angle
        low = reclined or (o.hip[1] >= c.low_hip_y and o.angle >= c.low_torso_angle)
        if t.was_resting and zone == "boundary":
            t.exit_pending = True
        if (t.was_resting or t.exit_pending) and (zone == "outside" or
                                                 zone == "boundary" and hip_zone == "outside"):
            t.remember("exit",now,zone)
        if zone == "outside" and p.status in {"Checking","Suspected Fall"}:
            t.remember("outside",now,zone)
        if zone == "boundary" and (low or p.status in {"Checking","Suspected Fall"}):
            t.remember("boundary",now,zone)
        if zone == "inside":
            t.forget("boundary")
            t.exit_pending = False
        # Resolving a previously unknown bed location refines an ambiguous raw
        # pose into a warning. It cannot erase observed motion/outside evidence.
        bed_uncertain = soft_uncertainty and (t.bed_observed or previous_bed_warning or t.location_hint == "inside")
        if zone in {"inside","boundary"} or bed_uncertain:
            t.forget("pose")
        if self.calibration.verified:
            t.bed_observed = zone == "inside" and not t.risk
        elif not self.calibration.active:
            t.bed_observed = False
        elif t.location_hint == "inside" and not t.risk:
            t.bed_observed = True
        if not t.samples or now-t.samples[-1].time >= c.sample_seconds:
            t.samples.append(o)

        # Trusted REST requires this track's continuous seated-to-reclined
        # transition supported by a verified bed. Unknown history stays a warning.
        # Seated shoulders can project above the mattress; both hips must remain
        # on it during entry, then both shoulders AND hips must be inside to rest.
        # Unknown startup posture, missing samples, abrupt motion and risk erase it.
        if hip_zone != "inside" or t.risk:
            t.clear_entry(t.risk_reason if t.risk else "Hips outside or bed not verified during entry")
            t.was_resting = False
        elif o.angle < c.low_torso_angle and p.status == "Normal":
            t.forget("rotation")
            t.entry_anchor = o
            t.entry_proven = False
            t.entry_note = "Seated pose seen; complete recline not yet verified"
        elif prior and rotation > c.rotation_speed and not t.was_resting:
            t.clear_entry("Abrupt rotation interrupted bed-entry evidence")
        if (not t.risk and zone == "inside" and reclined and t.entry_anchor is not None
                and now-t.entry_anchor.time >= 1.0 and o.angle-t.entry_anchor.angle >= 30
                and sum(s.time >= t.entry_anchor.time for s in t.samples) >= 6):
            t.entry_proven = True
            t.entry_note = "Gradual bed entry verified"
        trusted_entry = t.entry_proven and zone == "inside" and not t.risk and low
        if trusted_entry and p.status in {"Normal","Checking","Suspected Fall"}:
            stable = prior is not None and speed <= c.stable_speed and rotation <= c.stable_rotation
            if not stable:
                t.stable_since = None
                return "LOWERING", "Observed gradual bed entry; posture still moving"
            if t.stable_since is None:
                t.stable_since = now
            if now-t.stable_since >= c.rest_seconds:
                t.was_resting = True
                return "RESTING_IN_BED", "Observed gradual bed entry and stable rest"
            return "LOWERING", "Observed gradual bed entry; checking stability"

        # A background-check interruption is not evidence that this person fell.
        # The held polygon expires after 2s; beyond that, only remember that this
        # same track was recently in bed, never claim its current location/rest.
        # Positive descent/outside/exit concern always takes priority. An unseen
        # floor track cannot borrow another person's bed observation.
        if (low and bed_uncertain and not t.risk_evidence
                and p.status in {"Normal","Checking","Suspected Fall"}):
            t.bed_warning = True
            t.stable_since = t.recovery_since = None
            return "CHECK_PERSON", ("Bed view unverified; recent bed estimate only; check person"
                                    if t.location_hint == "inside" else
                                    "Bed view unverified; current location unknown; check person")

        # A normal bed entry crosses the polygon while shoulders are still above
        # it. Partial overlap alone never becomes an irreversible outside fall.
        # Actual descent, a verified outside pose or established bed exit remain.
        if low and zone == "boundary" and not t.risk_evidence:
            t.bed_warning = True
            t.stable_since = t.recovery_since = None
            return "CHECK_PERSON", ("Bed entry overlaps boundary; checking position" if t.entry_anchor is not None
                                    else "Bed boundary overlap; location uncertain; check person")

        # Horizontal posture in a currently verified bed, without observed risk,
        # is ambiguous when entry history was missed. Request a check; do not
        # manufacture either a confirmed fall or trusted rest from that absence.
        if low and zone == "inside" and not t.risk and p.status in {"Normal","Checking","Suspected Fall"}:
            t.bed_warning = True
            t.stable_since = t.recovery_since = None
            return "CHECK_PERSON", "In-bed posture; " + t.entry_note.lower() + "; check person"

        # Outside that narrow uncertain-bed case, retain the raw confirmation
        # duration and any positively observed concern.
        if p.status == "Suspected Fall":
            if not t.risk_evidence:
                t.remember("pose",now,zone)
            t.stable_since = t.recovery_since = None
            return "POSSIBLE_FALL", t.risk_reason
        if p.status == "Checking":
            t.stable_since = t.recovery_since = None
            return "CHECK_PERSON", (t.risk_reason + "; confirming posture" if t.risk_evidence
                                    else "Original detector is confirming fall-like posture")
        if p.status != "Normal":
            t.clear_entry()
            t.recovery_since = None
            return "CHECK_PERSON", "Original detector cannot assess posture"

        upright = o.angle < c.low_torso_angle and not low
        if upright and speed <= c.descent_speed:
            t.stable_since = None
            t.was_resting = False
            if t.risk or t.state in {"POSSIBLE_FALL","CHECK_PERSON","LOWERING"} and t.samples and len(t.samples)>1:
                if t.recovery_since is None:
                    t.recovery_since = now
                if now-t.recovery_since < c.recovery_seconds:
                    return "CHECK_PERSON", "Upright again; observing recovery"
                t.evidence.clear()
                t.refresh_risk()
                t.exit_pending = False
                t.recovered_until = now + 1.
            t.recovery_since = None
            return ("RECOVERED", "Returned to upright posture") if now < t.recovered_until else ("ACTIVE","No fall condition detected")
        t.recovery_since = None
        if t.risk:
            t.stable_since = None
            return "CHECK_PERSON", t.risk_reason
        t.stable_since = None
        if low:
            return "CHECK_PERSON", {"inside":"Bed entry not observed reliably; check person",
                                    "outside":"Low posture outside bed area; cause unknown",
                                    "boundary":"Bed boundary overlaps body; location uncertain"}.get(zone,
                                    "Low posture; bed area unavailable or unverified")
        if prior and descent > .03:
            return "LOWERING", "Gradual lowering; continue observing"
        if not upright:
            return "CHECK_PERSON", "Ambiguous posture; check person"
        return "ACTIVE", "No fall condition detected"

    def update(self, base, now, size):
        people = base.visible + base.missing
        live = {p.number for p in people}
        self.tracks = {n:t for n,t in self.tracks.items() if n in live}
        if self.revision != self.calibration.revision:
            # Hard geometry/setup changes discard context history. Soft background
            # uncertainty is handled in assess, preserving samples for motion risk.
            for t in self.tracks.values():
                t.samples.clear()
                t.last_reliable = t.stable_since = t.recovery_since = None
                t.was_resting = t.bed_observed = False
                t.bed_warning = False
                t.location_hint = "unknown"
                t.exit_pending = False
                t.forget("boundary","rotation")
                t.clear_entry("Bed verification changed; observe entry again")
            self.revision = self.calibration.revision
        events = [e for e in base.events if e.status.startswith("Person ")]
        labels = []
        for p in people:
            t = self.tracks.setdefault(p.number,ContextTrack())
            t.state,t.reason = self.assess(p,t,now,size)
            display = DISPLAY[t.state]
            if (p.status == "Checking" and p.visible and t.state in {"CHECK_PERSON","LOWERING"}
                    and not t.bed_warning):
                display = "Checking"
            p.display_status = display
            labels.append((display,p,t))
            # Retain tracking/reset events, but never publish a raw pose transition
            # as a final fall event when bed context has explained that posture.
            raw_event = f"{p.label}: {p.status}"
            if display != p.status:
                events = [e for e in events if e.status != raw_event]
            evidence_summary = t.evidence_summary()
            changed = (t.state,t.reason,t.zone,evidence_summary)
            if t.logged != changed:
                status = f"{p.label}: {display}"
                # Enrich existing baseline events instead of duplicating them.
                event = next((e for e in events if e.status == status),None)
                detail = t.reason + " | " + evidence_summary
                if event: event.reason = detail
                else: events.append(Event(status,p.features,detail))
                t.logged = changed
        strongest = max(labels,key=lambda row:PRIORITY[row[0]],default=None)
        status = strongest[0] if strongest else "No Person"
        if status == "Resting in Bed" and any(s != "Resting in Bed" for s,_,_ in labels):
            status = "Normal"  # Mixed active/resting, all reliably non-concerning.
        feature = strongest[1].features if strongest and strongest[1].visible else None
        if status != self.last_status:
            events.append(Event(status,feature,strongest[2].reason if strongest else "No visible or recently lost tracks"))
            self.last_status = status
        calibration_summary = self.calibration.describe(now)
        if calibration_summary != self.last_calibration:
            events.append(Event("Bed Calibration",reason=calibration_summary))
            self.last_calibration = calibration_summary
        alarm = status == "Suspected Fall" and not self.alarm_active
        if alarm: self.alarm_active = True
        elif status in {"Normal","Resting in Bed"} or not people: self.alarm_active = False
        self.metadata = {"calibration":calibration_summary,
                         "visible_count":len(base.visible),"missing_count":len(base.missing),
                         "people":[{"person_number":p.number,"state":t.state,"baseline_status":p.status,
                                    "zone":t.zone,"reason":t.reason,"visible":p.visible}
                                   for _,p,t in labels[:16]]}
        return FrameState(status,base.visible,base.missing,events,alarm,feature)

    def draw(self, cv, frame, state):
        from multi_person import status_color
        for p in state.visible:
            t = self.tracks[p.number]
            hint = " (recent inside estimate)" if t.location_hint == "inside" else ""
            label = f"Bed: {t.zone}{hint} | Pose: {p.status} -> {p.display_status}"
            text_width = cv.getTextSize(t.reason,cv.FONT_HERSHEY_SIMPLEX,.36,1)[0][0]
            x = max(5,min(int(p.box[0]),frame.shape[1]-text_width-5))
            y = min(frame.shape[0]-75,max(140,int(p.box[1])+18))
            cv.putText(frame,label,(x,y),cv.FONT_HERSHEY_SIMPLEX,.36,status_color(DISPLAY[t.state]),1)
            cv.putText(frame,t.reason,(x,y+18),cv.FONT_HERSHEY_SIMPLEX,.36,(255,255,255),1)
            # Full source history is in JSONL; keep the local first line readable.
            cv.putText(frame,t.evidence_summary()[:110],(5,y+36),cv.FONT_HERSHEY_SIMPLEX,.32,(255,255,255),1)
