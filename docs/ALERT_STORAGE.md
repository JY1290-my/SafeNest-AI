# Fall prompts and truthful storage settings — 2026-10-19

## Baseline inspected

Based on the preceding multi-camera Home source-only release (version 7).

| Area | Existing capability / boundary | This change |
| --- | --- | --- |
| Detector | YOLO Pose, multi-person tracking, context/bed calibration, per-camera timers and original local sound | No detector changes |
| Authorization | Home authorization anchor, member/manager checks, Camera/host mapping, strict RLS and RPCs | Same RPCs, parameters and checks |
| Status / events | Per-Camera snapshots; conservative Home summary; newest 10 Home events | Clear current-observation scope, inline prompt and separate recorded-history labels |
| Video | User-requested single LiveKit stream, Camera-specific room/token/lease, PiP | Alert action reuses the existing selected-camera flow, never creates a second stream for a current camera |
| Family | Auth/session restore, bound Home list, invitations, management modal, notes, private Presence | Reused, with teardown request invalidation |
| Media | Browser canvas PNG; MediaRecorder video-only cloned tracks; temporary blobs; downloads | Add readable source labels/filenames and actual blob-byte inventory |
| Settings | Larger text, existing calibration/privacy guidance, unsupported PTZ/prediction explanations | Add accurate storage locations and unsupported feature explanations; Escape closes settings |
| Notifications / prediction | On-page states and unchanged local sound; no validated future prediction model or notification service | No automatic calls, emails, SMS, push, risk countdown or fake prediction switch |

The family webpage cannot select, open or configure a physical monitoring
camera, access the monitoring computer's disk, format microSD, or query cloud
video usage. Camera selection/preview/calibration remains in local Camera setup.

## Fall prompt behavior

The inline panel appears beside/above the video in normal document flow. It
does not cover the image or place a blocking modal over monitoring controls.
It lists **all currently fresh, enabled Cameras reporting `Suspected Fall`**
within the selected authorized Home, including an affected camera other than
the currently selected one. Single-camera/legacy and local pages remain supported.

- **Current Camera observation:** the main status card remains the selected
  Camera's actual state. The separate Home summary retains its conservative
  aggregation. Neither is changed by acknowledging a prompt.
- **Observed time:** comes from that camera snapshot's `observed_at`. Missing
  or invalid times show `Time unavailable` rather than a fabricated time.
- **Recorded event time:** the newest available suspected-fall event in that
  camera's existing recent payload, labeled as recorded history. It need not
  identify the start of the current episode. No matching event time is invented.
- **People:** labels come only from the current Camera context records whose
  state is `POSSIBLE_FALL`. Old event labels are not treated as current people.
  Missing context shows `Temporary person label unavailable`. These labels do
  not identify a relative or match people across cameras or days.
- **Acknowledge:** memory-only `Viewed on this page`; no shared response status,
  RPC, browser storage, AI command, notification, event deletion or sound change.
  The current warning remains visible. A new recorded fall event/person
  signature resets the mark. It also resets when the current warning ends,
  becomes stale/unavailable, or the Home/Camera/page scope changes. If the
  sender supplies no event identity, this mark covers only the continuous
  current report observed by this page; it is not an incident-management system.
- **View camera:** only a real user click initiates video, with current scope
  and freshness rechecked. Selecting another affected Camera clears/stops the
  old media first, uses the exact Camera/host token request, and keeps the same
  Home Presence and notes. It does not open the viewer's own webcam.
- **Unavailable observations:** stale, disconnected, disabled, unknown or
  demo observations cannot create a current fall prompt. Recorded history
  remains history. Home outage aggregation and current-state freshness checks
  continue to prevent an unavailable camera being presented as Normal/No Person.

Names and all metadata are rendered using text nodes/textContent. No user text
is interpolated as HTML. Keyboard focus on the acknowledgement button survives
heartbeats; the live announcement changes for new evidence rather than every
observation timestamp. No new audible browser alarm has been introduced.

## Actual saving locations

| Data | Actual location | Access / lifetime |
| --- | --- | --- |
| Screenshot | PNG blob in the family browser page; download to browser-selected location | One current download link. Page cannot verify successful disk save. Switching Home/Camera, refreshing or signing out removes temporary access |
| Manual recording | Video-only MediaRecorder blob in the family browser page; explicit Replay download | Up to 5 minutes or 64 MiB per clip; Replay keeps at most 3 clips / 64 MiB. Browser support is checked. No upload or continuous/background/cloud recording |
| Downloaded files | User's browser-selected downloads location | Persist until the user/browser removes them. This page cannot list, measure, delete or revoke them |
| Device detection logs | Primary Camera: project `events.csv` and `context_events.jsonl`; extra Cameras: `camera_logs/<device UUID>/<Camera UUID>/` | Existing local files and event meaning unchanged; no cleanup added |
| Local camera configuration | `device_settings.json` and `camera_sources.json` on the relevant monitoring computer | Existing device/source isolation; these files are not exposed by the family site |
| Bed/view calibration | Registered Cameras: `camera_profiles/cameras/<Camera UUID>/<source-profile key>.json`; legacy unregistered profiles: `camera_profiles/devices/<key>.json` | Existing device/Camera/view validation; transient background references remain in memory, not uploaded |
| Cloud status/events | Existing private Supabase snapshot/event metadata tables scoped through authorized Home/Camera RPCs | History not truncated or deleted; UI still displays latest 10. The device's recent 30-event transmission limit remains unchanged |
| Care notes | Existing private Supabase care-note table under Home authorization | Existing server-derived author and deletion permissions unchanged |
| Cloud video / microSD | Not implemented | No video archive, capacity meter, formatting or destructive controls |

Internal paths/UUIDs above describe the architecture; the family UI shows
human-readable Home/Camera labels, not filesystem paths, credentials or UUIDs.

### Storage & downloads panel

The four numbers are the real payload sizes of encoded blobs retained by this
page: screenshot, completed clips, recording chunks, and their sum. The size
of the current recorder's hidden internal buffer, decoder memory, browser
overhead, saved downloads and device/cloud disk capacity is not measured.
Zero retained blobs therefore displays `0 B`, never an invented percent or
claim of an empty disk. Oversized recording and clip-eviction rules are unchanged.

Names/filenames preserve the capture's Home and Camera source. Source changes
invalidate pending canvas and recorder callbacks, release cloned tracks,
revoke temporary object URLs and prevent an old camera's file appearing under
the new source. LiveKit's own input track is not stopped by the recorder.

A same-camera video disconnect stops recording and PiP and removes the live
image. Existing completed clips, and a recording that can finalize normally,
remain downloadable for that same Camera. An in-progress screenshot callback
is invalidated. Changing Home/Camera, logout, authorization loss or page
teardown discards temporary media. Page teardown invalidates late data requests;
returning via browser Back rechecks access and metadata without auto-starting video.

## Files changed

- `web/fall-alert.js` — current observation extraction and memory-only alert UI.
- `web/dashboard.js` — inline prompt integration, user-click video selection,
  source labels and page teardown/return guards.
- `web/index.html` — English inline prompt, current/history labels and storage content.
- `web/styles.css` — responsive in-flow prompt, storage layout and accessible live text.
- `web/camera-tools.js` — actual retained blob counts, source names/filenames and Escape.
- `web/logic.js` — cautious description; legacy Multiple People text no longer
  claims the modern detector evaluates one person at a time. State values unchanged.
- `monitor_bridge.py` — allow only the new public static JS asset; no status,
  publication, frame, alarm or authentication changes.
- `tests/fall-alert.test.mjs` — freshness, source association, safe rendering,
  independent acknowledgement and absence of side effects.
- `tests/family-ui.test.mjs` — Home/Camera/video integration, no automatic video,
  current versus recorded state, teardown races, acknowledgement and settings.
- `tests/camera-tools.test.mjs` — real byte counts, filenames, cleanup and no fake controls.
- `tests/test_monitor.py` — local static module served while private files stay protected.
- `video_frontend/package.json` — include the new tests, no dependency changes.
- `README.md` and this document — installation, saving locations and limitations.

## Tests actually run

From the source project root:

```text
python -m unittest discover -s tests -p "test_*.py"
Ran 196 tests — OK

npm --prefix video_frontend test
223 tests — 223 pass, 0 fail, 0 skipped

npm --prefix video_frontend run build
Built pinned LiveKit and Realtime browser clients (no CDN)
```

Previous release baseline: 196 Python / 210 JS-SQL tests, all passing. New
release: 13 additional JS interaction/unit tests, existing Python asset-access
test extended. Final runs took approximately 5.82 seconds (Python) and 8.08
seconds (JS/SQL). Python 3.12 with OpenCV 4 headless is used for synthetic tests;
JSDOM, mocks and PGlite exercise UI/database behavior. No camera, model weights,
email, SMS, phone call, Supabase/LiveKit account or cloud network is required.
No dependency was added. Rebuilt SDK bundles and notices are byte-identical.

Compared to the preceding source zip, 44 critical files were verified
byte-identical: detector, multi-person/context and calibration files, Camera
setup/catalog, all SQL and Edge Functions, LiveKit sender/controllers, PiP,
CloudClient, FamilyManagement, family-view, password recovery and Presence
modules. Detection parameters and local alerts therefore
retain their preceding implementation; this does not assert clinical accuracy.

## Installation / manual steps

1. Back up the existing project. Apply the update package to the preceding
   multi-camera version, preserving `.env`, `web/config.js`, models, saved setup,
   calibration and logs. No user files or downloaded media are deleted.
2. This update requires **no SQL migration, Supabase settings, SMTP change,
   Edge Function redeployment or new dependency**. If the preceding multi-camera
   release is not yet installed completely, finish its documented migration and
   function steps first; this update does not replace those prerequisites.
3. Publish updated `web/` using the existing Vercel procedure when you choose.
   Nothing was deployed by this work. Do not publish the Python project/secrets.
4. Cloud family UI changes do not require restarting the detector. If using
   its built-in local webpage, normally quit and restart at a suitable time
   so its static allowlist includes `fall-alert.js`. No recalibration needed
   solely for this update; existing view-validation rules still apply.
5. Refresh the webpage after publishing. No password, token, phone number or
   service key needs to be sent to the developer/assistant.

## Manual acceptance / limitations

- No browser executable is installed in this test environment. Automated UI
  tests verify DOM interactions, keyboard actions and responsive structure;
  actual narrow/wide layout, screen-reader announcements, native PiP, canvas
  downloads and MediaRecorder codecs need real browser/phone validation.
- Windows OpenCV/Tk/model/hardware, actual local sound and multi-camera CPU/GPU
  load require the existing safe real-device test procedure. Never use actual
  falls by older people as a test scenario.
- Test a current simulated suspected-fall metadata report in a controlled
  environment: camera list alone must not start video; acknowledge must leave
  AI state/history/local alert unchanged; a View camera click selects only the
  named Camera and reuses one authorized stream.
- Test two Homes/accounts and different cameras: no prior label, draft, clip,
  status or current-person identity survives a Home switch or permission loss.
  Current camera unknown/offline must not appear Normal or No Person.
- Verify same-camera disconnect allows available clips to be downloaded, then
  changing Camera clears temporary media; downloaded files are retained by the user.
- Cloud authorization, Realtime and LiveKit/TURN remain subject to their existing
  network checks and short lease lifetimes; no claim of instantaneous remote
  revocation or production multi-connection lock testing is added.
- No future-action prediction, confirmed-injury diagnosis, shared incident
  acknowledgement, automatic escalation/calls/messages, cloud video archive,
  microSD management, disk-capacity reporting, voice command, PTZ or cross-camera
  person identification was introduced.
