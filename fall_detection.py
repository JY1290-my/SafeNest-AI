import csv
import math
import os
import time
import winsound
from datetime import datetime
from pathlib import Path

import cv2
os.environ.setdefault("YOLO_AUTOINSTALL", "false")
from ultralytics import YOLO
from monitor_bridge import MonitorBridge
from multi_person import (MultiPersonMonitor, NativeTracker, detections_from_result,
                          draw_people, write_events, Event)
from room_calibration import RoomCalibration, CalibrationUI
from context_monitor import ContextMonitor, ContextConfig
from device_settings import SettingsStore, CameraSettings, CaptureLease, DeviceSetupError


# Initial demonstration thresholds; evaluate changes through testing.
KEYPOINT_CONF = 0.4
ANGLE_LIMIT = 60.0
RATIO_LIMIT = 1.0
CONFIRM_SECONDS = 1.5


def pose_features(points, confidences, box):
    if confidences is None or len(points) < 17:
        return None

    # Shoulders and hips must be clearly visible.
    if any(
        float(confidences[i]) < KEYPOINT_CONF
        for i in (5, 6, 11, 12)
    ):
        return None

    # Shoulder midpoint
    sx = float(points[5][0] + points[6][0]) / 2
    sy = float(points[5][1] + points[6][1]) / 2

    # Hip midpoint
    hx = float(points[11][0] + points[12][0]) / 2
    hy = float(points[11][1] + points[12][1]) / 2

    dx, dy = sx - hx, sy - hy

    if math.hypot(dx, dy) < 5:
        return None

    # Torso angle relative to vertical
    angle = math.degrees(
        math.atan2(abs(dx), abs(dy))
    )

    # Person bounding-box width-to-height ratio
    x1, y1, x2, y2 = map(float, box)
    ratio = max(x2 - x1, 1.0) / max(y2 - y1, 1.0)

    # Approximate lower-limb direction using the hip-to-ankle line.
    leg_angles = []

    for hip, ankle in ((11, 15), (12, 16)):
        if (
            float(confidences[hip]) < KEYPOINT_CONF
            or float(confidences[ankle]) < KEYPOINT_CONF
        ):
            continue

        lx = float(points[ankle][0] - points[hip][0])
        ly = float(points[ankle][1] - points[hip][1])

        if math.hypot(lx, ly) < 5:
            continue

        leg_angles.append(
            math.degrees(
                math.atan2(abs(lx), abs(ly))
            )
        )

    # Exclude horizontal lying when either reliable lower-limb line is near vertical.
    leg_angle = min(leg_angles) if leg_angles else None

    return angle, ratio, leg_angle


def update_status(features, now, since):
    if features is None:
        return "Pose Unclear", None

    angle, ratio, leg_angle = features

    # The torso or bounding box does not meet the suspicious-posture conditions.
    if angle < ANGLE_LIMIT or ratio < RATIO_LIMIT:
        return "Normal", None

    # For suspicious posture with no visible ankles, pause assessment and reset the timer.
    if leg_angle is None:
        return "Pose Unclear", None

    # A near-vertical lower-limb line may indicate standing while bending.
    if leg_angle < 50.0:
        return "Normal", None

    if since is None:
        since = now

    if now - since < CONFIRM_SECONDS:
        return "Checking", since

    return "Suspected Fall", since


def run_detector(bridge):
    root = Path(__file__).resolve().parent
    device_setup = getattr(bridge, 'device_setup', None)
    if not isinstance(device_setup, CameraSettings):
        device_setup = SettingsStore(root).ensure().current()
    profile = device_setup.profile
    model = YOLO(str(Path(__file__).resolve().with_name("yolo11n-pose.pt")))
    cap = cv2.VideoCapture(device_setup.source)

    if not cap.isOpened():
        print("Cannot open camera.")
        bridge.state.update("Camera Offline", False)
        cap.release()
        return

    monitor = MultiPersonMonitor(update_status, preserve_occlusion=True)
    tracker = NativeTracker.create()

    # Store logs in the program directory.
    log_path = getattr(bridge, "log_path", None)
    if not isinstance(log_path, (str, os.PathLike)):
        log_path = Path(__file__).resolve().with_name("events.csv")
    log_path = Path(log_path)
    context_log_path = getattr(bridge, "context_log_path", None)
    if not isinstance(context_log_path, (str, os.PathLike)):
        context_log_path = Path(__file__).resolve().with_name("context_events.jsonl")
    window = "Elderly Fall AI - " + device_setup.camera_name
    root = Path(__file__).resolve().parent
    calibration = RoomCalibration(device_setup.calibration_path(root), source=str(device_setup.source),
                                  profile=profile, device_scope=device_setup.scope)
    context = ContextMonitor(calibration, ContextConfig.load(root / "context_config.json"), KEYPOINT_CONF)
    setup = None
    setup_revision = calibration.view_revision
    previous_size = None

    print("Monitoring started. C: calibrate bed | B: confirm saved outline | R: clear saved bed zone | Q: exit.")
    print(f"Event log: {log_path}")

    try:
        setup = CalibrationUI(cv2, window, calibration)
        needs_header = (
            not log_path.exists()
            or log_path.stat().st_size == 0
        )

        with log_path.open(
            "a", newline="", encoding="utf-8"
        ) as log_file, Path(context_log_path).open("a", encoding="utf-8") as context_log:
            writer = csv.writer(log_file)

            if needs_header:
                writer.writerow([
                    "time",
                    "status",
                    "angle_deg",
                    "width_height_ratio",
                ])

            while True:
                success, frame = cap.read()

                if not success:
                    print("Cannot read camera frame.")
                    bridge.state.update("Camera Offline", False)
                    break
                result = model.predict(
                    source=frame,
                    conf=0.5,
                    iou=0.5,
                    verbose=False,
                )[0]
                annotated = result.plot()
                now = time.monotonic()
                detections = detections_from_result(result, pose_features)
                size = (frame.shape[1], frame.shape[0])
                boxes = [d.box for d in detections if d.valid_box]
                setup.observe(frame, boxes, now)
                reset_events = []
                # A changed setup cannot transfer identity/timing to a new view.
                if setup_revision != calibration.view_revision or previous_size not in (None, size):
                    reset_events = [Event(f"{p.label}: Track Reset", reason="Camera setup changed; new track history")
                                    for p in monitor.people.values()]
                    monitor.people.clear()
                    tracker = NativeTracker.create()
                setup_revision, previous_size = calibration.view_revision, size
                base_state = monitor.update(detections, now, tracker.ids(result))
                base_state.events[:0] = reset_events
                state = context.update(base_state, now, size)
                write_events(state, datetime.now().astimezone().isoformat(timespec="seconds"),
                             writer, log_file, bridge.state, context_log)

                # Same Windows system sound, once per overall fall episode.
                if state.should_alarm:
                    try:
                        winsound.MessageBeep(winsound.MB_ICONEXCLAMATION)
                    except RuntimeError:
                        print("Warning: system sound unavailable.")

                draw_people(cv2, annotated, state, now, CONFIRM_SECONDS)
                context.draw(cv2, annotated, state)
                setup.overlay(annotated)
                bridge.state.update(state.status, True, state.features, annotated, context=context.metadata)
                cv2.imshow(window, setup.local_view(annotated))

                key = cv2.waitKey(1) & 0xFF
                if key in (ord("q"), ord("Q")):
                    break
                setup.handle(key, frame, boxes)

    finally:
        cap.release()
        cv2.destroyAllWindows()


def _main_locked():
    bridge = MonitorBridge(Path(__file__).resolve().with_name("events.csv"))
    bridge.start()
    try:
        run_detector(bridge)
    finally:
        bridge.close()


def main():
    try:
        with CaptureLease(Path(__file__).resolve().parent):
            _main_locked()
    except DeviceSetupError as exc:
        print(str(exc))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
