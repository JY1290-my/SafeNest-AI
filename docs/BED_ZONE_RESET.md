# Bed-zone Reset — local Camera setup

## Cause and fix

Previously, R called `invalidate(..., view_changed=True)`. This disabled the bed context but retained the polygon in memory and on disk. The overlay therefore drew the old polygon in red, and reopening setup loaded it again.

R and the existing Reset button now use the same persistent clear operation. Only the selected camera/device/view profile's calibration JSON is replaced by a scoped empty record. This also prevents `CameraCatalog.register` from copying a legacy outline back over the reset. Other cameras, settings, credentials, event history and logs are unchanged. No SQL migration, cloud setting, deployment or new runtime dependency is required.

The existing polygon validation, background verification algorithm, detection functions, thresholds, tracking, context decisions and sound calls are unchanged. Calibration revision changes still clear the existing bed-specific context history; Reset does not claim that the camera moved or reset baseline tracking/confirmation timers.

## Use it

1. Stop the old preview/detector, apply the update in the project root, and retain your `.env`, model weights, configuration, camera profiles and logs.
2. On the monitoring computer, open **Start_Camera_Setup.cmd**, select the correct camera/view, then **Preview & calibrate**. These controls are also available in the detector's local OpenCV window.
3. Give that camera window keyboard focus and press **R**, or click its **Reset [R]** control. Draft points and the saved border disappear. The status is **Needs calibration**.
4. The prompt is **Bed zone cleared — mark 3–12 points, then press Enter to save.** OpenCV's Hershey font displays the dashes as ordinary hyphens.
5. Click 3–12 corners in boundary order. The draft is yellow and unverified. Press **Enter** to validate the polygon and capture the existing masked, in-memory background reference. Fixed background outside the bed must be visible; keep people out of setup preview while confirming.
6. A successfully verified outline is green. Closing and reopening setup loads the new outline as unconfirmed; visually check it and press **B / Enter** again, as before.

Repeated R is safe. Enter with no replacement points cannot restore a cleared outline. Esc after Reset leaves the bed zone cleared. Text fields in the separate Tk setup window have no global R shortcut. If the calibration write fails, an error is shown and calibration is disabled; it does not claim persistence succeeded.

Actual supported camera movement/dimension changes still invalidate an old outline and can show it in red. Such geometry is not used as verified bed context. R removes it; it never changes an invalid zone to Verified. Bed location remains auxiliary and cannot permanently suppress new fall evidence.

## Automated checks

Actual results on 2026-10-22: **9 Reset-specific tests passed; all 207 Python tests passed** (3.164 seconds). The full suite includes the original detection/threshold, tracking, context, calibration, alarm, local setup and video tests. The isolated test environment used Python 3.12, OpenCV headless 4.10.0.84, NumPy 1.26.4 and the project's pinned LiveKit 1.1.20; project requirements were not changed.

Run from the source root using the existing project virtual environment:

```bash
python -m unittest discover -s tests -p 'test_bed_zone_reset.py' -v
python -m unittest discover -s tests -p 'test_*.py' -v
```

Tests use mocked window controls, synthetic images and temporary files; no camera, model weights, network accounts or notifications are used. Coverage includes both R cases and the mouse button; drafts and saved geometry; empty reopen and repeated registration; new 3/5/12-point polygons; correct overlay states/colors; device/camera/profile isolation; unchanged logs/settings; idempotence; view-change protection; write failures; and text-field shortcut isolation. The existing context, multi-person, alarm and original-algorithm tests are included in the full Python suite.

Actual Windows focus, camera hardware, live background detail and native window appearance still require a physical check. No real camera window or model inference was run in the automated environment.

The ASTs of `pose_features`, `update_status`, `validate_polygon` and `ViewGuard` match the input archive. `context_monitor.py`, `multi_person.py`, `monitor_bridge.py`, `video_publisher.py`, `device_settings.py`, `camera_catalog.py` and `camera_preview.py` are byte-identical to it. No website/database files were changed, so JavaScript/database tests were not rerun for this local-only fix.

## Changed files

| File | Change |
| --- | --- |
| `room_calibration.py` | Persistent scoped clear record, shared R/Reset behavior, cleared/editing labels, green/yellow/red overlays and supported dash rendering; original validation/ViewGuard unchanged. |
| `fall_detection.py` | Startup shortcut description only. |
| `device_setup_ui.py` | Preview shortcut description only. |
| `tests/test_bed_zone_reset.py` | Nine new reset/persistence/overlay/error/isolation tests. |
| `tests/test_context.py` | Updated reset/redraw expectation; a cleared outline cannot be reconfirmed. |
| `tests/test_camera_catalog.py` | Legacy reimport after reset regression. |
| `tests/test_device_setup_ui.py` | Text fields have no global reset binding. |
| `README.md`, `docs/DEVICE_SETUP.md`, `docs/CONTEXT_MONITORING.md`, `docs/MOBILE_MONITOR.md`, `docs/BED_ZONE_RESET.md` | Current behavior, update steps and test results. |
