# Family Dashboard and local Camera setup

## Scope of this stage

Family accounts use Supabase Auth and receive device access through `members(device_id,user_id)`.
Room and camera names are display labels. Person 1 / Person 2 are temporary tracking numbers, not accounts or permanent older-adult identities.
The latest version supports a one-use claim code generated locally. A signed-in account redeems it to manage an unclaimed device; see [DEVICE_CLAIM.md](DEVICE_CLAIM.md). Existing family-access management RPCs remain; see [FAMILY_MANAGEMENT.md](FAMILY_MANAGEMENT.md). No HTTP controls for physical cameras were added.

## Family website

1. Register/sign in on the family website. Complete email verification first when required.
2. After sign-in, the **Family Dashboard** lists authorized devices under **Followed homes**.
3. Click **Open monitoring**. Status, events, care notes and online members use the selected device_id.
4. Click **View camera** when video is needed. It requests the original detector stream and does not open the family member phone/computer camera. Stopping viewing does not stop local detection.
5. Only when linking another registered device, click **Add a home / device**, enter an administrator invitation code and click **Follow home**. The input starts collapsed and clears on cancellation or success.
6. **Choose home** returns to the Family Dashboard. Bindings are stored in the database and reloaded after refresh, new sign-in or a different browser; raw invitation codes are not stored in the browser.

No linked devices shows **No homes linked yet**. Loading failure shows an error and **Refresh list**, never a false empty list. A stored device preference must still match the server-authorized list. Switching, logout and revocation clear video, temporary recordings, status, events, notes and Presence. An unfinished old invitation request cannot switch back to an old device or restore an old account UI.

Registration grants no management rights. Initial device management can be claimed using a locally generated one-use code; account recovery for an existing device is handled by a trusted project operator. Only device managers can create/revoke invitations or remove ordinary members through Manage family; RPCs independently enforce authorization. **About camera setup** explains the local-only boundary and provides no cross-device localhost control link.

## Local setup entry

Use the **Windows computer** physically connected to the monitoring camera:

1. Stop the old detector, or use its already-running monitoring window. Do not start multiple detector copies.
2. Copy update files into the existing project root, retaining `.env`, `yolo11n-pose.pt`, logs and `camera_profiles/`.
3. Double-click `Start_Camera_Setup.cmd`. It prefers this project `.venv\Scripts\python.exe`, otherwise Python on PATH.
4. If the working virtual environment is elsewhere, run this from a terminal where that environment is activated:

```bat
python camera_setup.py
```

5. Click **Scan cameras**, choose an available index and enter **View profile / Room name / Camera name**. **Preview & calibrate** shows the actual picture: C draws, E drags corners, B / Enter confirms and R clears the current bed zone.
6. Preview does not run AI; keep people out of view while confirming. Q closes preview, then **Start monitoring** starts detection. After reopening the camera, visually check and reconfirm the saved bed outline.
7. **Q** in the monitoring window stops detection. Closing settings does not stop an existing detector or local alarm. Stop detection before changing cameras or labels.

Labels and selection are stored locally in `device_settings.json`; calibration is isolated by device_id, camera index and profile. No remote controls, device-registration permissions or access to a family browser camera are added. A process lock prevents scanning, preview and detection in the same project from using the camera simultaneously.

See [DEVICE_SETUP.md](DEVICE_SETUP.md) for the full workflow, storage and hardware limits. No pip dependencies were added; tkinter, graphical OpenCV and a desktop session are required. Existing command-line startup still works and reads the same settings.

## Local-password webpage

The existing `http://127.0.0.1:8765` page keeps local-password authentication and displays **Local monitoring**.
After sign-in, **Camera setup on the monitoring computer** explains the actual OpenCV controls.
It does not execute local commands through HTTP or treat the local-password identity as a Supabase family account/device manager.
The website service starts/stops with the detector. The separate desktop entry is `camera_setup.py`.

## Data and delivery

Local settings need no database change. Family management needs family_management.sql, followed by device_claim.sql for one-use claiming; see DEVICE_CLAIM.md. No Edge Function or key change is required, and this stage was not deployed.

`fall_detection.py` uses the selected camera and device-scoped calibration path; `monitor_bridge.py` uses saved labels. `room_calibration.py` adds calibration scope and corner editing while retaining background verification. `multi_person.py`, `context_monitor.py`, `video_publisher.py`, `cloud/`, `supabase/functions/` and the video/Presence SDK are unchanged in this stage.

The source package excludes user environments, runtime logs, local settings and personal calibration. Retain those files in the working project. See [DEVICE_SETUP.md](DEVICE_SETUP.md) for the complete file list and tests.

## Automated tests and manual acceptance

```text
python -m unittest discover -s tests -v
npm --prefix video_frontend test
```

Results at this stage: 169 Python and 147 frontend/database tests passed. Camera, model, desktop and cloud interactions use mocks; database tests use PGlite. No production accounts or real cameras were used.

On Windows, follow DEVICE_SETUP.md to check camera selection, saved labels, bed-outline editing, view movement, restart confirmation and Q exit. Check website sign-in, on-demand video, device switching and revocation through the original flow; existing tests retain these authorization boundaries.
