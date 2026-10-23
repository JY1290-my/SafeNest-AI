# Multi-camera Home delivery and acceptance

## Implementation results

- One Home links multiple monitoring computers and Cameras. Family members selecting the Home automatically see all linked cameras without binding a separate Home per camera.
- A new computer keeps independent device credentials and joins using an expiring, single-use pairing code created by an existing Home manager. Only code hashes are stored; the server checks permissions and rate limits.
- Local scanning, real preview and bed-zone settings reuse Camera setup, extended with Camera registration and separate processes for multiple cameras.
- The family website views one stream on demand using one video element. Camera switches within a Home do not recreate Home Presence or clear shared notes.
- Home aggregate and selected-camera states are separate. Missing expected cameras prevent aggregate Normal/No Person. The Home’s latest 10 events name their source Camera.
- Existing note permissions, author names, deletion confirmation, family invitations, private Presence, recovery and PiP/screenshot/recording reuse their original implementation and authorization.
- The incremental migration backfills existing Homes/default Cameras while preserving numbers, members, managers, notes and history. Reruns do not recreate Homes/Cameras.

## Baseline review and compatibility decisions

The previous version scoped family authorization and Home numbers to device_id. Local setup could save multiple sources/profiles, but each run selected one input. LiveKit already had on-demand tracks, 25-second viewing leases, 8-second renewal and a device-side allowlist.

This version adds Home/device/Camera mappings while retaining the original device UUID as a stable Home authorization anchor and reusing members/managers/notes/Presence. Each existing device gets one Home/default camera; existing Homes are not merged automatically. Legacy prototype default video rooms remain compatible; registered cameras use separate Camera rooms after restart.

`device_id` identifies device authentication; the Home number is a fixed server-generated display identifier; the room/Home name is an editable label; Camera UUID is the server’s camera identifier; Person N is valid only within one camera’s tracking session. The website does not scan, start or configure the family member’s own camera.

## Actual automated test results at this stage

Run at the project root:

```text
python -m unittest discover -s tests -p "test_*.py"
Ran 196 tests — OK

npm --prefix video_frontend test
210 tests — 210 pass, 0 fail, 0 skipped

npm --prefix video_frontend run build
Built pinned LiveKit and Realtime browser clients
```

The final Python run took approximately 4.55 seconds and website/database tests 6.67 seconds. This stage used Linux Python 3.12, numpy, OpenCV headless 4.14, Flask, requests, python-dotenv, waitress and LiveKit 1.1.20. Production Windows should retain its existing graphical OpenCV and working PyTorch environment; do not replace the GPU environment based on these test versions.

Tests use mocks, synthetic trajectories, JSDOM, PGlite and local signing with the real LiveKit token SDK. They do not access real monitoring cameras, model weights, email, Supabase/LiveKit accounts or deployments. PGlite queues concurrent requests through one local connection; tests check single-use behavior and constraints, not production multi-connection lock load.

New coverage includes Camera registration/calibration/log/device isolation, independent workers, explicit pairing/start, automatic Home camera lists, single-stream switches/cleanup, conservative aggregation, cross-Home/Camera authorization, pairing expiry/rate/single use, old-Home backfill/reruns, all-camera denial after revocation and preventing old video sessions renewing new Camera sessions. All existing tests continued to pass.

Byte comparisons also verified that `multi_person.py`, `context_monitor.py`, `room_calibration.py`, `camera_preview.py`, recovery and core PiP/screenshot/recording/Presence modules were unchanged at this stage. The pose_features/update_status AST and four detection constants in `fall_detection.py` matched the prior version. Changes affected only camera selection, window identity, log destination and timezone-aware new-event timestamps; original prediction parameters, confirmation duration and winsound calls were retained.

## Manual steps

1. Exit the old monitor and back up the working project. Merge the update into the previous version, preserving `.env`, `web/config.js`, models, `device_settings.json`, bed zones and logs.
2. In Supabase SQL Editor, run `cloud/multi_camera_homes.sql` after `home_identity.sql`. See `MULTI_CAMERA_HOMES.md` for the full fresh-install order.
3. Redeploy `video-token` and `device-video-token` with the existing Supabase project configuration; their shared authorization code changed. No new secrets, public channels or Auth/SMTP changes are required.
4. On the original monitoring computer: Camera setup → save the real camera index, label and view → Register selected camera to this Home → Preview & calibrate → restart monitoring.
5. Register/calibrate additional cameras on the same computer, then use Start all registered cameras. A different computer first receives independent device credentials, then joins the existing Home using a camera setup code from its Home manager’s Manage family panel, and registers/starts its cameras. Do not create a new-Home claim code for a computer joining an existing Home.
6. Publish `web/` manually using the original workflow. The rebuilt video-client.js is included; no extra frontend build is required. Nothing was deployed for you.
7. Family members select a Home, check its full camera list, select a camera and click View camera. Existing Home membership grants access to all enabled cameras within it.

## Real-device acceptance and unsupported capabilities

- Use two computers/two local cameras to check labels, Home numbers, independent bed zones, FPS and local sounds. Disconnect one Camera; the Home must not remain Normal.
- Use two family accounts to verify restored invitation bindings, cross-Home denial, manager permissions and all-camera/note/Presence/video denial after revocation. Propagation uses existing network polling and an allowlist lifetime of at most 5 seconds; downloaded content cannot be recalled.
- Check real phone/desktop layouts, keyboard dialogs, PiP, recording, screenshots, network loss and Camera/Home cleanup. This stage’s environment had no browser executable, so real-browser visual acceptance was not completed.
- Real Windows OpenCV/Tk, hosted Supabase RLS/Realtime, LiveKit/TURN, network isolation, clocks and concurrent load still require practical validation.
- Only actual local integer OpenCV inputs are implemented. No RTSP/ONVIF, network-CCTV credential form, PTZ, permanent identities or cross-camera tracking is provided.
- All cameras are listed, but only one live stream is viewed on demand; there is no all-stream grid. Each worker loads a model and consumes CPU/GPU/RAM/USB resources. No maximum count or FPS is promised.
- Two independently created Homes are not automatically merged and their members are not migrated. Pairing accepts only unassigned new computers. Device deletion/moves and manager-role recovery still require a trusted project owner.
- The original Home authorization anchor must not be deleted. Disabling that anchor device retains the old whole-Home access-disable semantics. To retire one camera, use Disable expectation. Removing it from the local run list does not delete its cloud record/history.
- A fall visible in two views produces separate events and possibly separate sounds; no cross-camera identity/event deduplication exists. Legacy timezone-free timestamps remain unchanged and cannot guarantee absolute ordering across timezones. New logs include timezone information.

## Changed files

- `.gitignore`
- `README.md`
- `camera_catalog.py`
- `camera_setup.py`
- `cloud/multi_camera_homes.sql`
- `device_claim.py`
- `device_settings.py`
- `device_setup_ui.py`
- `docs/MULTI_CAMERA_ACCEPTANCE.md`
- `docs/MULTI_CAMERA_HOMES.md`
- `fall_detection.py`
- `monitor_bridge.py`
- `multi_camera_runner.py`
- `supabase/functions/_shared/runtime.js`
- `supabase/functions/_shared/video-core.js`
- `tests/family-ui.test.mjs`
- `tests/home-camera-status.test.mjs`
- `tests/multi-camera-database.test.mjs`
- `tests/test_camera_catalog.py`
- `tests/test_device_setup_ui.py`
- `tests/video-client.test.mjs`
- `tests/video-core.test.mjs`
- `video_frontend/camera-controller.js`
- `video_frontend/package.json`
- `video_publisher.py`
- `web/cloud-client.js`
- `web/dashboard.js`
- `web/family-management.js`
- `web/home-cameras.js`
- `web/index.html`
- `web/styles.css`
- `web/video-client.js`
