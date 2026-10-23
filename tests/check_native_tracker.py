"""Optional real ByteTrack smoke test: existing YOLO env, no weights/camera.

Run from the project root: python tests/check_native_tracker.py
An unavailable optional tracker is reported explicitly, not called a pass.
"""
import os
from pathlib import Path
import sys

os.environ["YOLO_AUTOINSTALL"] = "false"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from multi_person import Detection, MultiPersonMonitor, NativeTracker


def main():
    adapter = NativeTracker.create()
    if adapter.tracker is None:
        raise SystemExit("Native smoke test unavailable. The detector can still use its box-association fallback.")
    import numpy as np
    from ultralytics.engine.results import Boxes
    from types import SimpleNamespace

    def rule(features, now, since):
        if features == "normal":
            return "Normal", None
        since = now if since is None else since
        return ("Suspected Fall" if now-since >= 1.5 else "Checking"), since

    monitor = MultiPersonMonitor(rule)
    a, b = [0, 0, 100, 200, .9, 0], [400, 0, 600, 100, .9, 0]
    original_ids = None
    for now, rows in [(0, [a, b]), (.5, [b, a]), (1, [a, b]), (1.5, [b, a])]:
        result = SimpleNamespace(boxes=Boxes(np.asarray(rows, dtype=np.float32), (480, 800)))
        hints = adapter.ids(result)
        assert len(hints) == 2 and adapter.tracker is not None, "Native tracker did not map both detections"
        detections = [Detection(i, tuple(row[:4]), "normal" if row[0] == 0 else "fall")
                      for i, row in enumerate(rows)]
        out = monitor.update(detections, now, hints)
        identities = {p.box[0]: (p.number, p.native_id) for p in out.visible}
        if original_ids is None:
            original_ids = identities
        assert identities == original_ids, "Reordered detections exchanged IDs"
    assert out.status == "Suspected Fall" and out.should_alarm
    assert [p.status for p in out.visible] == ["Suspected Fall", "Normal"]

    # New tracks may be withheld by ByteTrack until activated; the wrapper must
    # still assess the original new detection on its very first frame.
    rows = [a, b, [650, 0, 750, 200, .9, 0]]
    result = SimpleNamespace(boxes=Boxes(np.asarray(rows, dtype=np.float32), (480, 800)))
    hints = adapter.ids(result)
    out = monitor.update([Detection(i, tuple(row[:4]), "normal") for i, row in enumerate(rows)], 1.6, hints)
    assert len(out.visible) == 3
    assert out.status == "Normal"
    print("PASS: real ByteTrack IDs, source-index mapping, two-person state, and new detection retention.")


if __name__ == "__main__":
    main()
