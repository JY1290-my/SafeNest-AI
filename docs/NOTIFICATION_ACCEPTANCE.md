# Family suspected-fall notifications: implementation and acceptance

Persistent in-app alerts, shared family acknowledgements and optional Web Push are implemented. Nothing was deployed, and no real push, email, SMS or phone call was sent.

## Implemented capabilities

- The server creates separate per-camera alerts from device-authenticated live Camera reports, using stable server-generated IDs. Heartbeats, Person-label changes and retransmitted old events do not duplicate alerts.
- The selected Home shows the latest 30 in-app alerts and an unviewed count across all history. The existing latest-10 AI event list and stored history are preserved.
- Acknowledge records the authenticated account’s safe nickname and time, visible to other family after refresh. It cannot change AI status, original events or local sound, or confirm recovery.
- Each family member enables Web Push for the current Home/browser themselves. Recipients come from existing active membership and are rechecked server-side. Unsubscribed members can still read in-app alerts.
- Notifications contain only generic text and a random deduplication key. After a click, the server resolves access using the current account/Home permissions. Camera viewing still requires a separate explicit click.
- Revocation cancels unsent jobs; authorization is checked again before sending. Uncertain timeout outcomes remain Unknown rather than blindly resending. Explicit 429/5xx responses receive bounded retries; invalid endpoints are cleaned up.
- The push Service Worker caches no pages, Auth data, raw frames or recordings. It retains only bounded deduplication keys/times. Alert/notification settings do not recreate video or Presence.

## Actual test results at this stage

| Command / verification | Result |
| --- | --- |
| `python -m unittest discover -s tests -p "test_*.py"` | 196 passed, 0 failed, 5.960 seconds |
| `npm --prefix video_frontend test` | 250 passed, 0 failed/skipped, 8.879 seconds |
| `npm --prefix video_frontend run build` | Succeeded; pinned LiveKit/Realtime browser bundles and Notices matched the previous version byte for byte |
| esbuild bundling of the two new Edge entry points (npm runtime imports externalized) | Succeeded; syntax/local-module validation, not real hosted Deno acceptance |
| Source-protection checks | 39 key files unchanged byte for byte, including detection, tracking, context, calibration, device setup, old SQL/video functions, video/Presence/media core and public user configuration |
| Web Push encryption tests | Pinned web-push generated real VAPID / aes128gcm requests, decrypted and checked locally without network sending |
| Full / update packages | Applying the update to the previous version matched the full source file by file. No model, real environment values, user calibration or logs included. |

Tests use synthetic data, mocks, JSDOM and local PGlite, without real cameras, weights, email, Supabase/LiveKit accounts or Push services. PGlite is not multi-connection production PostgreSQL. Real Windows, phone notifications, Vercel HTTPS, Deno, Vault/pg_net/Cron still need practical acceptance. No real-browser visual or notification-delivery test is claimed.

## Manual steps required

1. Back up the previous project and apply the update at its root. Preserve `.env`, `web/config.js`, `web/vercel.json`, models, settings, bed zones and logs; the update excludes these user files.
2. In Supabase SQL Editor, run **`cloud/fall_notifications.sql`** after `multi_camera_homes.sql`. Do not delete data or rerun old migrations in reverse order. In-app alerts/shared acknowledgements become available after this migration and website publication.
3. For Web Push, run the local secret-generation tool and privately configure VAPID/random dispatcher secrets. Manually deploy **family-push-config** and **dispatch-fall-push**, configure Vault/pg_net/Cron and run the optional setup example. Existing video functions need no redeployment for this stage.
4. Publish `web/` manually. Confirm `/sw.js` serves same-origin JavaScript rather than rewritten HTML. Each family member signs in and enables notifications in their own browser.
5. For the Python-hosted local page, restart the monitor normally when convenient to load the new module allowlist. The cloud family page does not require detection restart or recalibration for this stage.

For the exact SQL order, commands, secret generation/storage, UI behavior and manual acceptance steps, see **[FAMILY_NOTIFICATIONS.md](FAMILY_NOTIFICATIONS.md)**.

## Capability limits

- No email, SMS, WhatsApp, calls, escalation, prediction, cloud recording or emergency-response guarantee.
- The OS, browser or network may block/delay push. Subscribed and provider accepted do not mean displayed on the phone or acted on by family.
- Messages already submitted to a push provider/OS cannot be recalled; clicks still recheck permission. A small unavoidable window exists between Home revocation and network sending, so lock-screen text stays generic.
- Each camera groups its overall suspected-fall episode without treating Person IDs as identities. A fresh explicit Normal/Resting in Bed observation is required before a separate episode; uncertainty, occlusion and an empty view do not prove recovery.
- Queue jobs expire and have bounded retries; high load may cause expiry. No old-alert pagination, alert-deletion UI, medical diagnosis, shared resolved-event workflow or real-notification test button is included.
- Only specified FCM, Mozilla and Apple Push endpoint formats are currently accepted; other services need separate review. Notifications require actual browser support and user permission.

## Changed files (29)

- `.gitignore`: ignore private local push configuration.
- `README.md`: latest capabilities, manual steps and guide links.
- `cloud/fall_notifications.sql`: incremental alerts, acknowledgements, subscriptions, queue and RLS/RPC.
- `cloud/setup_fall_push.sql.example`: optional Vault/pg_net/Cron wake-up setup.
- `docs/FAMILY_NOTIFICATIONS.md`: complete English architecture, usage, limitations and acceptance guide.
- `docs/NOTIFICATION_ACCEPTANCE.md`: this report.
- `monitor_bridge.py`: two new static-module allowlist entries only.
- `supabase/.env.functions.example`: new push-variable documentation without real secrets.
- `supabase/config.toml`: gateway configuration for two new functions, whose handlers validate requests.
- `supabase/functions/_shared/push-core.js`: protected dispatch, valid endpoints, minimal payload and encryption adapter.
- `supabase/functions/_shared/push-runtime.js`: pinned SDK and server-environment adapter.
- `supabase/functions/dispatch-fall-push/index.ts`: server-secret-protected sending entry point.
- `supabase/functions/family-push-config/index.ts`: Auth/Home-authorized public-key configuration entry point.
- `tests/fall-alert.test.mjs`: shared acknowledgements and current-alert compatibility.
- `tests/fall-notifications-database.test.mjs`: actual SQL, episodes, authorization, revocation and queue tests.
- `tests/fall-push.test.mjs`: dispatch, authorization, endpoint validation and real offline encryption.
- `tests/family-notifications-ui.test.mjs`: subscription/permission states, shared acknowledgement, SW and cleanup.
- `tests/family-ui.test.mjs`: integration, push-click authorization, late responses and video preservation.
- `tests/test_monitor.py`: new static-resource checks.
- `tools/generate_push_secrets.mjs`: create new private files locally without printing secrets or overwriting old files.
- `video_frontend/package-lock.json`: pin new server/test-tool dependencies.
- `video_frontend/package.json`: web-push 3.6.7, test entries and secret-generation command.
- `web/dashboard.js`: integrate alerts, notifications, sessions and Home lifecycle.
- `web/fall-alert.js`: use server acknowledgements for the current alert.
- `web/family-alerts.js`: persistent Home-alert list and acknowledgement interactions.
- `web/index.html`: English alert, acknowledgement and notification settings UI.
- `web/push-notifications.js`: browser subscription initiated only by user clicks, with account cleanup.
- `web/styles.css`: responsive alert-list styles.
- `web/sw.js`: generic push, deduplication and same-origin click navigation without page caching.
