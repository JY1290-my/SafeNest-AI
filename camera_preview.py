"""Explicit local camera scan/preview; no model, network, events or alarms."""
import json
from pathlib import Path
import sys
import time
from device_settings import CaptureLease, SettingsStore, DeviceSetupError
from room_calibration import RoomCalibration, CalibrationUI

ROOT = Path(__file__).resolve().parent


def scan_cameras(cv, indices=range(10)):
    available = []
    for index in indices:
        cap = None
        try:
            cap = cv.VideoCapture(index)
            if cap.isOpened():
                ok, frame = cap.read()
                if ok and frame is not None: available.append(index)
        except Exception:
            pass
        finally:
            if cap is not None: cap.release()
    return available


def preview(cv, root=ROOT):
    settings = SettingsStore(root).ensure().current()
    cap = cv.VideoCapture(settings.source)
    try:
        if not cap.isOpened(): raise DeviceSetupError('Selected camera could not be opened.')
        calibration = RoomCalibration(settings.calibration_path(root), source=str(settings.source),
                                      profile=settings.profile, device_scope=settings.scope)
        window = 'SafeNest - Setup preview (AI not running)'
        ui = CalibrationUI(cv, window, calibration)
        while True:
            ok, frame = cap.read()
            if not ok or frame is None: raise DeviceSetupError('Camera disconnected during preview.')
            # A setup preview has no model. Keep people out of view while confirming.
            # Monitoring later captures its own reference using actual person boxes.
            ui.observe(frame, [], time.monotonic())
            visible = frame.copy()
            ui.overlay(visible)
            cv.putText(visible, 'SETUP ONLY - AI NOT RUNNING | Q: close', (10, 24),
                       cv.FONT_HERSHEY_SIMPLEX, .5, (0,220,255), 1)
            cv.imshow(window, ui.local_view(visible))
            key = cv.waitKey(1) & 0xff
            if key in (ord('q'), ord('Q')) or cv.getWindowProperty(window, cv.WND_PROP_VISIBLE) < 1: break
            ui.handle(key, frame, [])
    finally:
        cap.release()
        cv.destroyAllWindows()


def main():
    import cv2
    try:
        with CaptureLease(ROOT):
            if sys.argv[1:] == ['--scan']:
                print(json.dumps({'available':scan_cameras(cv2)}))
            elif not sys.argv[1:]:
                preview(cv2)
            else: return 2
        return 0
    except DeviceSetupError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    except Exception:
        print('Camera setup failed. Check camera access and the local desktop environment.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
