# Local visual device setup

For the latest one-use manager claim controls and required incremental SQL, see [DEVICE_CLAIM.md](DEVICE_CLAIM.md). The camera/calibration workflow below is unchanged.

The earlier device-setup update adds local camera selection, labels and bed-area editing to the existing monitoring program. It does not change family authorization, prediction rules, multi-person tracking or local alerts. It does not deploy anything or require a database migration.

## Before you start

Use the Windows computer physically connected to the monitoring camera. Keep your existing working virtual environment, model, `.env`, event history and calibration files. Stop the old detector with **Q** before updating or selecting another camera.

Double-click **Start_Camera_Setup.cmd** in the project folder. It uses that folder's `.venv\Scripts\python.exe` when available, otherwise Python from PATH. If your working environment is elsewhere, activate it once and run:

```bat
python camera_setup.py
```

There are no new pip dependencies. The desktop interface needs tkinter, a desktop session and the existing graphical OpenCV package. The detector still uses its existing Windows `winsound` behavior. **Start monitoring** is disabled on other operating systems; this update does not port the detector or replace its alarm implementation. The model is only needed for monitoring, not for scanning or setup preview. A missing model produces an error instead of an automatic download.

## Setup workflow

1. **Scan cameras** checks local OpenCV indices 0–9 for a readable frame. This action can briefly activate camera indicator lights. It runs separately from the UI and stops after a 25-second timeout. You can also enter an index from 0 to 31 manually. A scanner cannot identify the camera's manufacturer or permanent hardware identity.
2. Select an index. Set **View profile**, **Room name** and **Camera name**. Profiles use 1–64 letters, digits, underscores or hyphens, such as `bedroom_front`. Labels use 1–80 printable characters. Use another profile for another angle. **Load labels for selected camera / view** retrieves existing labels; **Save device settings** selects that setup for the next detector run.
3. Click **Preview & calibrate**. The settings are saved and a separate local OpenCV window shows the actual selected camera. The banner says **SETUP ONLY – AI NOT RUNNING**. There is no fall detection, alarm, cloud publishing or family livestream in this preview. Opening the settings window alone does not open any camera.
4. Keep people out of the preview while confirming the background. Click **Camera setup [C]** or press **C**, then click around the visible mattress edge. Use 3–12 non-intersecting points; avoid including the floor as a bed. Right-click or Backspace undoes a point. Press **B / Enter**, or click **Confirm**, to validate and save.
5. To adjust an existing outline, click **Edit [E]**, then drag its corner dots. **B / Enter** saves; **Esc** cancels editing and keeps calibration inactive. Cancelling never silently restores an old trusted bed area. An invalid polygon, insufficient fixed background or save error keeps calibration inactive and shows a message.
   To remove the outline, press **R** or click **Reset [R]**. This clears both draft points and the current camera/view's saved bed geometry. The border disappears and **Needs calibration** is shown. You can immediately click 3–12 new points and press **Enter**; pressing Enter without new points cannot restore the deleted outline. Reopening setup keeps the zone empty.
6. Press **Q**, close the preview window or click **Close setup preview** in settings. Then click **Start monitoring**. Monitoring opens the selected camera and uses the saved labels and outline. Check the actual image and confirm the outline again with **B / Enter**, or redraw it with **C**. A saved outline is never automatically verified on reopening.
7. In the detector, use the same original calibration controls. Stop with **Q** before changing camera settings. Closing the settings window leaves an already-running detector and its alerts running; a message explains this.

The setup preview deliberately does not load a second pose model. Its background capture relies on an empty view and the original bed mask. Monitoring captures a fresh in-memory reference with the original person masks when you confirm there. Preview calibration therefore never bypasses the detector's live confirmation or background checks.

## Calibration states

The authoritative calibration state appears on the live OpenCV image. The settings window describes the saved outline as **Needs confirmation** because it has no live background reference of its own.

| Live state | Meaning and action |
| --- | --- |
| `verified` | The current view has been confirmed and its background check is usable. It is not confirmation of the person's safety. |
| `needs calibration` | No saved bed zone, including after Reset. Mark 3–12 points and confirm. No border is displayed until points are added. |
| `editing; not saved` | Yellow draft points/outline; not a verified bed zone. Enter validates and saves. |
| `unconfirmed` / Needs confirmation | A saved outline in a new session. Review the actual image and confirm; it is not trusted automatically. |
| `occluded; location unknown` | There is not enough background evidence. Preserve the existing uncertain-context behavior; do not claim a safe bed location. |
| `possible movement; location unknown` | Background movement evidence is being checked. Bed position is uncertain. |
| `view changed; recalibrate` | Supported view change or changed image dimensions invalidated the old calibration. Recheck and redraw the bed for the new view. |

**R** clears the current camera/view's saved bed zone. It is not a camera-movement signal. A small, scoped JSON record with an empty polygon preserves this choice and prevents legacy-outline reimport on repeated camera registration. Other profiles, cameras, device settings and event history are untouched. If the write fails, setup reports the failure and disables the current calibration rather than claiming it was cleared.

Green means verified; yellow means editing/unconfirmed; red means the existing ViewGuard invalidated a saved outline after supported movement or changed dimensions. ViewGuard still checks masked fixed-background features and image evidence; it does not follow a moving camera or reanchor the bed. A view change remains invalid even if background evidence later looks usable, until the correct geometry is confirmed. Its thresholds and short uncertain-location grace period are unchanged. Press **R** to remove that inactive red outline.

Keyboard shortcuts are confined to the OpenCV preview/monitor window. The separate Tk room/name text fields have no global R binding. OpenCV's built-in font displays the clear prompt's dashes as ASCII hyphens: **Bed zone cleared - mark 3-12 points, then press Enter to save.**

Confirm only when the outline matches the mattress in the current image. Do not use **B** merely to silence a warning. Bed location is auxiliary context: the existing new-descent, bed-exit and other risk evidence continues to apply. This update does not change those decision rules or associate Person numbers with names.

## Storage, isolation and privacy

| Local item | Stored content / scope |
| --- | --- |
| `device_settings.json` | Selected setup and friendly labels per configured device UUID; camera index and view profile; a local-only installation UUID when no valid cloud device ID is configured. No tokens or keys. |
| `camera_profiles/devices/<hash>.json` | Version 2 normalized bed polygon, resolution, device scope, camera source and view profile. The filename hashes that scope. Loaded geometry always needs live confirmation. |
| `camera_profiles/<old-profile>.json` | Existing unscoped version 1 outlines remain untouched. They are not automatically imported or trusted for a different identity. Redraw once after this update. |
| `camera_capture.lock` | A one-byte local capture lock. No credentials, images or user identity. The OS releases it when a process exits. |
| Background reference | Existing masked grayscale/features in RAM only. Not saved in settings, calibration or Supabase. |

Labels and bed geometry are isolated by **device scope + camera index + view profile**. A configured valid `SAFENEST_DEVICE_ID` is the scope. Without it, the settings file persists a local installation UUID. Adding or changing a cloud ID creates a separate selection scope and cannot inherit the previous identity's calibration. A malformed ID is shown as local-only, not as an authenticated device. This UI does not register a device or edit `.env`.

The status label shows only a shortened device ID and whether a local credential is present in a plausible length. **This is not an online authentication check.** It never displays the credential. Existing cloud publishing reports its own connection errors. Names enter the existing status snapshot when monitoring starts; a stopped detector does not publish them immediately.

Camera numbers can change after USB reconnection or a system restart. OpenCV indices are not durable hardware serial numbers. The actual preview and mandatory live confirmation are therefore essential; choose the matching camera/profile and check labels whenever hardware or viewpoint changes. Automatic physical-camera identity matching and PTZ position mapping are outside this update.

The capture lock prevents simultaneous scanner, preview and detector processes from this project folder. It does not take over cameras used by other applications or another copy of the project. Those can cause camera-open errors; close the competing application and retry. Do not run several project copies against the same camera/device ID.

Settings are written atomically. Invalid settings are rejected without overwriting them; keep a backup and repair or rename `device_settings.json` before retrying. Renaming it creates a fresh local identity if no cloud ID exists, so old local-only outlines will not be silently reused. Invalid calibration files are treated as uncalibrated. Existing event files are never deleted or rewritten by setup.

## Family and device boundaries

- Family members use Supabase Auth and their server-authorized device list. Invitations still bind accounts to existing devices.
- The monitoring device is the local Python process plus its camera and configured device ID.
- Room/camera names are labels, not accounts or people.
- `Person 1`, `Person 2`, etc. remain temporary tracks, not lasting identities.
- The family and local-password webpages do not gain camera-control, calibration or device-registration HTTP endpoints. Existing LiveKit viewing is still on demand and uses the same authorization and connection lifecycle.

## Changed files

| File | Change |
| --- | --- |
| `camera_setup.py` | Explicit scanner/preview/detector process launching, mutual-exclusion checks and safe setup-only cancellation. |
| `device_setup_ui.py` | English Tk settings UI, selection, labels, actions and error/status feedback. |
| `device_settings.py` | Credential-free scoped settings, validation, atomic saves and capture lease. |
| `camera_preview.py` | Actual local camera scan and preview, reusing CalibrationUI without a model or cloud connection. |
| `room_calibration.py` | Device-aware profile format and corner dragging; original validation/background algorithm retained. |
| `fall_detection.py` | Selected capture source, scoped calibration path and process capture lease. |
| `monitor_bridge.py` | Saved labels in existing snapshots. |
| `web/index.html` | Updated local setup guidance only. |
| `tests/test_device_settings.py` | Storage, isolation, camera lifecycle, calibration and integration regressions. |
| `tests/test_device_setup_ui.py` | Mocked UI action tests, including first local-only save and identity-change rejection. |
| `.gitignore`, `README.md`, `docs/FAMILY_DEVICE_ENTRY.md`, `docs/DEVICE_SETUP.md` | Local-runtime exclusions and current instructions. |

No changes to `context_monitor.py`, `multi_person.py`, `video_publisher.py`, model weights, cloud SQL/RPCs, Edge Functions or frontend SDK dependencies. The original `pose_features`, `update_status`, threshold assignments, model prediction arguments and local sound call are retained.

## Tests and local acceptance

```text
python -m unittest discover -s tests -v
npm --prefix video_frontend test
```

Results: **169 Python tests passed** (145 existing plus 24 new); **122 frontend/database tests passed**. The frontend suite uses the existing pinned dependencies. If installing those test dependencies in a clean development checkout, run `npm --prefix video_frontend ci` first. A frontend SDK build is not required for this update.

New tests cover settings persistence; two device IDs; local-only to cloud identity transitions; camera/profile isolation; invalid settings and atomic-write failures; device-aware and legacy calibration files; view-change invalidation; polygon editing/cancellation/errors; readable-camera scanning; capture release; explicit launch; process lock; settings/preview UI actions; and selected source/names reaching the original runtime. Existing tests cover context rules, original algorithm/threshold equality, multi-person tracking, alarms, family authorization, device switching, notes, presence and video cleanup.

Tests use synthetic frames and mocks; PGlite checks existing SQL behavior. No real camera, production credentials, model inference or cloud services were needed. Native Windows GUI/driver behavior has not been tested in this environment.

Before relying on the update on the monitoring computer:

1. Open settings; verify no camera turns on until Scan or Preview is clicked. Scan, select and preview each intended camera. Confirm the actual image, not just its index.
2. Save distinct labels/profiles, close settings and reopen; verify the saved selection. Switching cameras/profiles must not copy another outline. Preview must state AI is not running.
3. Draw/edit a bed outline and confirm; close preview, start detection and confirm again. Observe the live calibration state. Move the camera: expect uncertainty or confirmed view-change invalidation, never automatic trust of the old geometry. Recalibrate for the new angle.
4. Verify camera disconnect/error handling and Q shutdown. While preview/monitoring is running, a second instance from the same project must not start another capture. Closing settings must not stop an active detector.
5. Check the original normal-pose, bed-entry and multi-person scenarios; verify existing local alarms and authorized, on-demand family video. Use safe simulated motions, not actual falls.

The original camera-only setup required no Supabase changes. The newer manager claim feature requires `cloud/device_claim.sql` and the updated webpage; see DEVICE_CLAIM.md. Apply the update files to the project root while retaining local configuration/data; do not replace the entire directory in a way that deletes those files. No deployment has been performed.
