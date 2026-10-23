import csv
import math
import time
import winsound
from datetime import datetime
from pathlib import Path

import cv2
from ultralytics import YOLO


# Initial demonstration thresholds; evaluate changes through testing.
KEYPOINT_CONF = 0.4
ANGLE_LIMIT = 60.0
RATIO_LIMIT = 1.0
CONFIRM_SECONDS = 1.5


def pose_features(points, confidences, box):
    # YOLO body keypoints: left/right shoulders and left/right hips.
    indices = (5, 6, 11, 12)

    if confidences is None or len(points) < 13:
        return None

    # Do not assess posture when shoulders or hips are unclear.
    if any(float(confidences[i]) < KEYPOINT_CONF for i in indices):
        return None

    # Midpoint of both shoulders
    sx = float(points[5][0] + points[6][0]) / 2
    sy = float(points[5][1] + points[6][1]) / 2

    # Midpoint of both hips
    hx = float(points[11][0] + points[12][0]) / 2
    hy = float(points[11][1] + points[12][1]) / 2

    dx, dy = sx - hx, sy - hy

    if math.hypot(dx, dy) < 5:
        return None

    # Torso angle from vertical: 0 degrees is upright, 90 degrees is horizontal.
    angle = math.degrees(math.atan2(abs(dx), abs(dy)))

    # Person bounding-box width-to-height ratio
    x1, y1, x2, y2 = map(float, box)
    ratio = max(x2 - x1, 1.0) / max(y2 - y1, 1.0)

    return angle, ratio


def update_status(features, now, since):
    if features is None:
        return "Pose Unclear", None

    angle, ratio = features

    # Both conditions must hold.
    if angle < ANGLE_LIMIT or ratio < RATIO_LIMIT:
        return "Normal", None

    if since is None:
        since = now

    # Suspicious posture must persist for the confirmation period.
    if now - since < CONFIRM_SECONDS:
        return "Checking", since

    return "Suspected Fall", since


def main():
    model = YOLO("yolo11n-pose.pt")
    cap = cv2.VideoCapture(0)

    if not cap.isOpened():
        print("Cannot open camera.")
        cap.release()
        return

    since = None
    last_status = None

    # Store logs in the program directory.
    log_path = Path(__file__).resolve().with_name("events.csv")
    window = "Elderly Fall AI - Status"

    print("Monitoring started. Press Q to exit.")
    print(f"Event log: {log_path}")

    try:
        needs_header = (
            not log_path.exists()
            or log_path.stat().st_size == 0
        )

        with log_path.open(
            "a", newline="", encoding="utf-8"
        ) as log_file:
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
                    break

                result = model.predict(
                    source=frame,
                    verbose=False,
                )[0]

                annotated = result.plot()
                now = time.monotonic()
                features = None

                count = (
                    len(result.boxes)
                    if result.boxes is not None
                    else 0
                )

                if count == 0:
                    status, since = "No Person", None

                elif count > 1:
                    # This original version assesses one person to avoid mixing different people poses.
                    status, since = "Multiple People", None

                else:
                    if (
                        result.keypoints is not None
                        and len(result.keypoints) == 1
                    ):
                        points = (
                            result.keypoints.xy[0].cpu().numpy()
                        )

                        conf = result.keypoints.conf
                        conf = (
                            conf[0].cpu().numpy()
                            if conf is not None
                            else None
                        )

                        box = (
                            result.boxes.xyxy[0].cpu().numpy()
                        )

                        features = pose_features(
                            points, conf, box
                        )

                    status, since = update_status(
                        features, now, since
                    )

                # Log only state changes to avoid repeated writes on every frame.
                if status != last_status:
                    timestamp = datetime.now().isoformat(
                        timespec="seconds"
                    )

                    angle_text = (
                        f"{features[0]:.1f}"
                        if features is not None
                        else ""
                    )

                    ratio_text = (
                        f"{features[1]:.2f}"
                        if features is not None
                        else ""
                    )

                    writer.writerow([
                        timestamp,
                        status,
                        angle_text,
                        ratio_text,
                    ])
                    log_file.flush()

                    print(f"{timestamp} | {status}")
                if status == "Suspected Fall":
                    try:
                        winsound.MessageBeep(winsound.MB_ICONEXCLAMATION)
                    except RuntimeError:
                        print("Warning: system sound unavailable.")

                last_status = status
                if status == "Suspected Fall":
                    color = (0, 1, 255)
                elif status == "Normal":
                    color = (0, 200, 0)
                else:
                    color = (0, 200, 255)

                cv2.putText(
                    annotated,
                    f"Status: {status}",
                    (20, 35),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.8,
                    color,
                    2,
                )

                if features is not None:
                    detail = (
                        f"Angle: {features[0]:.0f} deg"
                        f" | W/H: {features[1]:.2f}"
                    )

                    cv2.putText(
                        annotated,
                        detail,
                        (20, 65),
                        cv2.FONT_HERSHEY_SIMPLEX,
                        0.6,
                        (255, 255, 255),
                        2,
                    )

                if status == "Checking":
                    detail = (
                        f"Confirming: {now - since:.1f}"
                        f"/{CONFIRM_SECONDS:.1f}s"
                    )

                    cv2.putText(
                        annotated,
                        detail,
                        (20, 95),
                        cv2.FONT_HERSHEY_SIMPLEX,
                        0.6,
                        color,
                        2,
                    )

                cv2.imshow(window, annotated)

                key = cv2.waitKey(1) & 0xFF
                if key in (ord("q"), ord("Q")):
                    break

    finally:
        cap.release()
        cv2.destroyAllWindows()


if __name__ == "__main__":
    main()