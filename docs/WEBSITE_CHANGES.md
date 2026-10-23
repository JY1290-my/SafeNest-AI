# Website changes and test record — 2026-10-16

The baseline was the inspected `SafeNest_AI_MultiPerson.zip`. All five website requirements were implemented; no cloud migration or deployment was performed.

## Changed files

| File | Change |
|---|---|
| `web/index.html` | Picture-in-Picture at the camera’s top right, draggable mini-player toolbar, nickname editing, Latest 10 and online-family section |
| `web/styles.css` | Mini-player, drag toolbar, button and online-member styles |
| `web/camera-window.js` (new) | Native PiP for the original video element, in-page draggable fallback, keyboard support and asynchronous cleanup |
| `web/family-view.js` (new) | Safe-name fallback and event sorting/latest 10 without mutating the source array |
| `web/dashboard.js` | Mini-player, nicknames, selected-monitor online list, device/logout/disconnect cleanup and periodic membership checks on the entry page |
| `web/cloud-client.js` | Read/save the caller’s nickname using the existing Auth session; cleanup bound to the old account/device Presence session |
| `web/app.js` | Inject the new Presence factory |
| `web/presence-client.js` (new bundle) | Pinned Supabase Realtime browser client |
| `web/THIRD_PARTY_NOTICES.txt` | Added Realtime dependency licenses |
| `web/vercel.json` | Supabase WSS added to the existing precise CSP; regenerate with configure_web.py for your own configuration |
| `video_frontend/presence-client.js` (new) | RealtimeClient wrapper reusing the existing Auth token |
| `video_frontend/presence-controller.js` (new) | Private channels, short-lived session renewal, roster freshness, reconnection and stale-callback isolation |
| `video_frontend/build.mjs` | Build both video and online-member modules plus third-party notices |
| `video_frontend/package.json`, `package-lock.json` | Pin `@supabase/realtime-js` 2.117.3 and extend test commands |
| `cloud/website_improvements.sql` (new) | Private short-lived presence sessions/channels, strict RPCs, Realtime RLS, channel rotation on membership changes and a consistent safe-name fallback |
| `configure_web.py` | Include Supabase WSS in public CSP even when remote video is disabled |
| `monitor_bridge.py` | Extend only the local static-resource allowlist for new JS. Detection/alert/publishing logic unchanged. |
| `tests/camera-window.test.mjs` (new) | Native/fallback PiP, dragging/closing, logout and late asynchronous results |
| `tests/presence-client.test.mjs` (new) | Private channels, minimal payload, access denial, rotation, disconnect, timeout and logout |
| `tests/presence-database.test.mjs` (new) | Actual PostgreSQL RPC/RLS, cross-device/anonymous denial, revocation, expiry, nicknames, rate limiting and migration reruns |
| `tests/family-ui.test.mjs` | Existing signup regressions plus one-time redemption restored after F5/new login, latest 10 events, nicknames, revocation and camera/presence cleanup |
| `tests/test_monitor.py` | Verify the local server loads the new static modules |
| `tests/test_web_config.py` (new) | Isolated configuration generation checks for Realtime/LiveKit CSP and exclusion of the device token |
| `README.md` | Updated entry points, setup links and historical notes |
| `docs/WEBSITE_IMPROVEMENTS.md`, this file (new) | Manual Supabase/Vercel steps, usage, limitations and verification record |

## Test results at this stage

- `npm run build --prefix video_frontend`: succeeded using pinned local dependencies without a CDN.
- `npm test --prefix video_frontend`: **93/93 passed**, including previous state, video JWT/lease, invitation, note and Auth/F5 regressions plus new website/online-member tests.
- `python -m unittest discover -s tests -p "test_*.py"`: **39/39 passed** in Python 3.12 with existing test dependencies. No real camera or model download was used.
- Original `fall_detection.py`, `multi_person.py`, `video_publisher.py`, `yolo11n-pose.pt` and the three base schemas were **byte-for-byte identical** to the stage’s ZIP baseline. Original single-person algorithm AST/threshold, multi-person timing/occlusion/sound regressions passed.
- SQL tests execute migrations, functions and RLS in local PGlite PostgreSQL with minimal Auth/Realtime service-table mocks, without connecting to Supabase.
- Native PiP, browser events and LiveKit playback lifecycles use mocks. Real operating-system floating windows, private Realtime WebSockets and cross-network video still require the post-deployment manual demonstrations.

## Update packages

- The full source package retains the `source_only/` structure and original model.
- `SafeNest_AI_Website_Update.zip` contains only this stage’s changed files at project-root-relative paths. Merge it into the existing root, then follow the guide to run new SQL and `python configure_web.py`.
- The small update excludes `web/config.js`, `web/vercel.json`, `.env`, models, CSV and old schemas. Preserve your configuration and use the updated generator to add CSP entries for the current project.
- For local preview, restart `python fall_detection.py` after copying files so the HTTP server loads the new static-resource allowlist.
