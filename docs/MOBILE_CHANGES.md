# Mobile monitor delivery — changes and verification

## Files

| File | Change |
|---|---|
| `web/index.html` | English mobile actions, textual pose/status guide, real local Replay area and Settings |
| `web/styles.css` | Mobile spacing, four-column touch controls, larger-text preference and accessible media/empty-state styles |
| `web/camera-tools.js` (new) | Local PNG capture, feature-detected manual recording, owned-track cleanup, bounded local clip URLs and panel controls |
| `web/dashboard.js` | Connect media tools to the existing live feed and device/session/page lifecycle |
| `monitor_bridge.py` | Serve `camera-tools.js` through the existing static allowlist; permit local blob media playback in CSP only |
| `tests/camera-tools.test.mjs` (new) | 14 media/accessibility tests using DOM/media mocks |
| `tests/family-ui.test.mjs` | Integration test for recording cleanup on device switch, revocation, pagehide and logout |
| `tests/test_monitor.py` | Verify the new local script route and media CSP alongside existing authorization tests |
| `video_frontend/package.json` | Include media tests in `npm test`; no dependency changes |
| `README.md` | Current version summary and update instructions |
| `docs/MOBILE_MONITOR.md` (new) | Concept-to-project inventory, operation, limitations, manual steps |
| `docs/MOBILE_CHANGES.md` (new) | This delivery record |

## Tests run

From the project root, with the existing test Python environment activated:

```text
python -m unittest discover -s tests
68 tests passed

npm --prefix video_frontend test
116 tests passed, 0 failed, 0 skipped
```

The original baseline passed 68 Python and 101 JavaScript tests before changes. The final suite adds 15 JavaScript tests and extends the existing local-server test. Python tests use camera/model stubs; JavaScript tests use mocked DOM/media/network and real in-process PGlite PostgreSQL authorization/RPC tests. No production credentials or actual camera/model weights are needed.

Coverage includes explicit-only capture/recording, unsupported browsers/JPEG recording, late screenshot callbacks, cloned-track ownership, stop/disconnect/hidden-page behavior, 5-minute and 64-MiB limits, bounded clips and URL revocation, empty Replay, textual status explanations, settings focus behavior, selected-device cleanup, revoked access, max 10 newest events, existing safe note rendering, Presence and PiP cleanup, Auth restoration, SQL permissions and invite limits.

Mobile verification here is DOM/accessibility structure and responsive CSS inspection, not an actual phone rendering or real codec test. A headless Chromium installation was attempted but the browser download was unavailable. Actual iOS/Android rendering, download behavior, native PiP and MediaRecorder codec compatibility still need the short device demonstration in `MOBILE_MONITOR.md`. No claim of production LiveKit/Supabase connectivity is made.

## Preservation checks

Compared to the latest delivered ZIP, these remain byte-for-byte unchanged:

- `fall_detection.py`, `multi_person.py`, `context_monitor.py`, `room_calibration.py`, `video_publisher.py`
- All cloud SQL migrations and Supabase Edge Functions
- LiveKit / Presence controllers and browser bundles, `web/cloud-client.js`, `web/camera-window.js`
- Frontend dependency lockfile and public deployment configuration

The only Python production edit is local HTTP static/CSP configuration. No fall thresholds, model parameters, person tracking, context logic, event meanings, local alarm behavior or event retention changed. No data migration is added and no stored events are removed.

## Intentionally unavailable

- PTZ: no real hardware/API authorization path in this project.
- Predictive AI: no validated runnable prediction model/input pipeline.
- Cloud/automatic/background recording, audio recording and browser pose inference: outside scope and not added.
- Recording on the local JPEG transport: no MediaStream; screenshots remain available.

## Apply

Use `SafeNest_AI_Mobile_Update.zip` for an existing installation: it contains the 12 changed/new files at project-relative paths. Back up first and extract at the project root. It does not include or overwrite `.env`, public web configuration, model weights, calibration or event logs. The full `SafeNest_AI_MultiPerson.zip` contains the complete source-only project under `source_only/`.

No new Supabase manual step is required if the preceding migrations are already installed. Restart the local Python program to pick up the static route update. Publish the changed webpage yourself when ready; this task did not deploy anything.
