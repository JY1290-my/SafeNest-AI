# Family access changes and test results

Baseline: the latest uploaded `source_only(1).zip`. This is an incremental update; no external service was deployed.

Follow-up fix: F5 restores sign-in and the selected device through tab-scoped sessionStorage. Followed homes and invitation entry moved to the sign-in landing page. Open monitoring enters the dashboard; Choose home returns to the landing page. Projects that already ran the previous migration need no additional Supabase SQL for this fix.

## File list

| File | Change |
|---|---|
| `cloud/family_schema.sql` | Add private invitation, rate-limit and note tables plus four authorized RPCs; retain existing data |
| `cloud/create_family_invite.sql.example` | Administrator creates expiry/use-limited invitations; persist only hashes; include a revocation example |
| `web/index.html` | Sign-up/sign-in toggle and display name; followed list/invitation entry on the landing page; return button, notes form and empty states on the monitoring page |
| `web/styles.css` | Responsive styles for new forms, device selection and notes |
| `web/app.js` | Frontend startup entry |
| `web/cloud-client.js` | Supabase Auth sign-up/sign-in, tab-scoped sessionStorage/expiry recovery, one concurrent refresh, RPCs and device-scoped video requests |
| `web/dashboard.js` | Selected-device status/events/notes, invitation binding, stale-response rejection, video teardown and isolated media elements; retain local mode |
| `monitor_bridge.py` | Add only `dashboard.js` and `cloud-client.js` to the static-file allowlist; status/frame/alarm logic unchanged |
| `tests/family-database.test.mjs` | Execute actual SQL for authorization, invitations, notes and administrator examples |
| `tests/family-ui.test.mjs` | Sign-up branches, error/empty states, invitation binding, safe text, device switching, refresh races and local mode |
| `tests/test_monitor.py` | Explicit UTF-8 source comparison fixes Windows cp1252 decoding; verify local serving of the new modules |
| `video_frontend/package.json`, `video_frontend/package-lock.json` | Add pinned jsdom test dependency and test commands; retain the runtime LiveKit version |
| `README.md` | Features, upgrade steps and validation entry points |
| `docs/CLOUD_AND_VERCEL.md` | Update earlier instructions that disabled self-registration; link the new flow |
| `docs/FAMILY_ACCESS.md` | Supabase registration/verification/Site URL, incremental SQL, invitations, publishing and acceptance steps |
| `docs/FAMILY_CHANGES.md` | This file |

## Test results

| Command/check | Result |
|---|---|
| `python -m unittest discover -s tests -v` | 12 passed, 0 failed |
| `npm test --prefix video_frontend`: status tests | 9 passed, 0 failed |
| Same command: Node test report | 59 passed, 0 failed; includes existing video tests and new family database/UI tests (Node counts a database parent test) |
| Byte comparison with uploaded source | `fall_detection.py`, `video_publisher.py`, original base/video schemas, video frontend bundle/controller, Edge runtime and other existing video core files match |
| `monitor_bridge.py` versus uploaded version | Only two static-module allowlist entries added |

There are 12 new family database cases plus a parent test, and 27 new UI/Auth cases. PostgreSQL tests use PGlite to run three migrations and actual PL/pgSQL rather than only matching SQL text. Row locks protect invitation use counts. Local single-connection PGlite verifies use limits; production multi-connection load was not simulated.

UI tests use jsdom with actual HTML and website modules, mocking Auth/RPC responses to verify sign-up, invitations, authorization errors, device switches, late requests, safe text rendering and session refresh. This does not verify real email delivery or video playback on a phone browser.

Python tests retain controlled-input regression of the actual detection loop, checking unchanged `pose_features`, `update_status`, thresholds and predict parameters, plus one local alarm, a single camera open and state publishing. Installing test dependencies did not change the project Windows detection requirements.

## Refresh and landing-page regression

Added tests cover F5 sign-in recovery, selected monitor/landing-page recovery, expired-token refresh and storage updates, invalid-session clearing, rejection of unauthorized device preferences, no sign-in restoration after logout and F5, returning to the landing page stopping video and pausing polling, disabled browser storage, temporary network errors retaining the session, local HttpOnly-cookie recovery, and late refreshes unable to restore a logged-out account. F5 tests recreate the page runtime while retaining same-tab storage. Recovery must pass the membership RPC again; older-adult data is not cached.

## Delivery boundaries

- Detection algorithms, thresholds, models, sound and CSV behavior were not changed.
- Device/LiveKit credentials were not replaced; Supabase and Vercel were not deployed.
- The existing public `web/config.js` and CSP configuration are retained. The update package excludes them to avoid overwriting local configuration.
- The complete source archive excludes real `.env`/`.env.functions`, deployment links, caches, node_modules and historical CSV data.
- After deployment, manually verify Supabase email confirmation, SMTP delivery, LiveKit, Windows cameras and phone networks using `FAMILY_ACCESS.md`.
