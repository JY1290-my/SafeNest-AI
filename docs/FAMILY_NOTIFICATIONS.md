# Family safety alerts and browser push

Maintenance follow-up: [RECOVERY_PUSH_SETTINGS.md](RECOVERY_PUSH_SETTINGS.md) documents the new Camera Settings modal, truthful per-browser setup checklist and read-only `cloud/diagnose_fall_push.sql.example`. No alert/queue/RLS migration or sending semantics changed. A source archive and a saved subscription cannot prove hosted background sending or phone display.

This release adds persistent Home safety alerts, shared viewing confirmations and optional standards-based Web Push. It does not send email, SMS, WhatsApp, calls or escalation reminders. No deployment or real push was performed during development.

## Architecture checked before implementation

| Existing capability | Finding and integration |
| --- | --- |
| Current alert card | `web/fall-alert.js` derives a live warning from fresh Camera state. Its previous Acknowledge was page memory only. Current warnings remain separate from recorded history; acknowledgement now uses the server record. |
| Device publisher | `MonitorState` emits UTC observations and deterministic recent-event hashes. `CloudPublisher` repeatedly uploads metadata through device-authenticated `publish_camera_monitor` or compatible `publish_monitor`. Neither inference nor publisher transport needs to change. |
| Event history | Recent arrays are repeatedly sent; `camera_events` is append-only and deduplicated. Old arrays cannot be used as new notification triggers. Existing history is untouched. |
| Home and family | Home is the existing immutable authorization anchor. Camera belongs to a Home and physical host. The existing `members` relationship, enabled Home and non-banned Auth user determine access. A display name is not authority. |
| RPC and RLS | Private tables have RLS and no anonymous/authenticated direct grants. New family RPCs use current Auth and `require_home_member`; workers have narrowly granted service-role queue RPCs. |
| Media and Presence | Existing private Home Presence and on-demand single-Camera LiveKit remain unchanged. Alerts, acknowledgement and push preference changes never start video. |
| Static website | The previous PWA manifest had no Service Worker. New `web/sw.js` handles push/click only, with no fetch cache, Auth session or video storage. Vercel serves it from the website root over HTTPS. |

## What family members see

- **Family safety alerts**: latest 30 server-recorded alerts for the selected authorized Home; all alert history remains in the database. The not-yet-viewed count covers all Home alerts, including older records outside that display window. There is no older-history pagination in this release.
- Each row shows Camera name, observed time, recorded/current classification and safe family viewing names/times. It says **Suspected Fall — Please check**, never confirmed injury or a forecast.
- **Acknowledge** records the current authenticated account and a server timestamp once. It changes no AI state, event, local sound, video or emergency-response status. Other family browsers see confirmations on their next refresh (normally within five seconds).
- **Camera settings & privacy → Browser notifications**: each member can opt in for the selected Home in this browser. Permission is requested only after clicking **Enable browser notifications**. Disabling this Home leaves other opted-in Homes unchanged. Settings opens as a modal; Check notification setup only reads status.
- The Authorized family members list remains the permission source. A manager cannot subscribe another person's browser. Members without push still have the Home's in-app alerts when they sign in.
- Closing the page keeps an opted-in browser subscription. Explicit sign-out removes that browser subscription across its Home preferences and unsubscribes locally. Session loss also attempts local unsubscribe. Switching Home does not silently enable push for the next Home.
- One push subscription belongs to one account per browser profile/site origin. A different account encountering an old subscription unsubscribes it rather than reusing the previous account's recipient identity. Separate browser profiles are suitable for separate accounts.

## Episode creation and duplicate suppression

`fall_notifications.sql` installs an AFTER INSERT/UPDATE trigger on the existing private Camera snapshot table. It runs inside the existing device-authenticated publisher transaction, not in a family browser.

1. Only non-demo, connected, explicitly non-stale `Suspected Fall` observations create an alert. Observations need a valid time-zone-aware timestamp no older than 15 seconds and no more than five seconds into the future, with an enabled Camera, host and Home.
2. A server UUID identifies the episode. Per-Camera state tracks the latest accepted observation and active alert. Repeated timestamps, heartbeats, resent old events, changed Person numbers, occlusion, `No Person`, `Checking`, uncertainty and offline periods do not create another alert for the same ongoing episode.
3. A new, fresh `Normal` or `Resting in Bed` observation re-arms notifications; a later fresh `Suspected Fall` creates a new server episode. This is notification grouping only and does not alter fall-detection criteria. Re-arm is not presented as medically confirmed recovery. Fast genuine status transitions may still create separate episodes. Episodes cover a Camera’s overall fall condition; a second temporary Person label during the same ongoing condition does not create another independent identity or push.
4. Migration does not replay old history. The first genuinely fresh fall observation after installation can record an already ongoing observation once. Exact-time matching event IDs are retained as optional provenance; absent or historical event IDs do not prevent a current, server-identified episode.
5. Eligible subscriptions at creation get one unique alert/subscription job. Enabling push later never replays old alerts. A newly joined member may read authorized Home history but is not automatically sent historical push.

Camera clocks must be synchronized. A badly wrong monitoring-computer clock can prevent new notifications; the server does not substitute a false observation time. Long offline gaps are not backfilled as fresh push alerts.

## Delivery and revocation semantics

- Only the server worker can read subscription endpoints/keys. User RPCs register/disable only the caller's subscription and current Home preference. A browser cannot submit a recipient user ID, sender name or recipient list.
- The worker needs a separate random dispatch secret and rejects browser-Origin requests. It rechecks live membership, account ban, Home/Camera/host enabled state, preference, subscription and VAPID key before beginning each send.
- Removing a Home member disables that Home's push preferences and cancels pending/preparing jobs. Renewed membership does not silently restore opt-in. Other Homes remain independent.
- A send already handed to a provider/OS cannot be recalled when a member is removed or signs out. Its content is generic; opening it always rechecks authentication and current Home membership. There is an unavoidable small interval between the final database check and external provider acceptance.
- Jobs expire after two minutes. Each invocation handles at most 20 jobs, up to four concurrently. An insert wake starts processing promptly; the optional one-minute Cron also drains eligible retries/backlog. Heavy backlogs can expire without sending; this prototype is not a guaranteed emergency-notification service.
- Only explicit HTTP 429/5xx rejection retries, up to three total attempts. HTTP 404/410 disables and clears a dead subscription. Ambiguous network timeout or interrupted send is **unknown**, with no blind resend. A preparing lease may be reclaimed because it has not started a send.
- The same opaque delivery key is used across retries. The worker and Service Worker coalesce duplicates; no exactly-once delivery claim is made. The Service Worker stores only bounded deduplication keys/times in IndexedDB (up to about 300 for one day), and uses a stable notification tag.
- A provider's HTTP success means **accepted**, not proof that a device displayed the notification or a family member responded. The webpage explicitly says real cloud delivery is not verified by this page.

Only a version and random delivery-deduplication key enter the encrypted push payload. Native notifications use **SafeNest safety alert** / **SafeNest has a safety alert. Sign in to review.** No Home/Camera label, Person label, email, user UUID, photo, video or credential is exposed on the lock screen. Clicking navigates to the same-origin app with an opaque key; the server resolves it only for its subscribed account with current membership. The website then opens the authorized Home, never its video automatically.

## Upgrade: in-app alerts first

1. Back up the previous source tree. Overlay the update into the immediately preceding alert/storage release (the preceding alert/storage source package). Retain `.env`, `web/config.js`, models, `device_settings.json`, `camera_sources.json`, `camera_profiles/`, calibration and logs. The patch does not contain replacement user configuration or models.
2. In Supabase SQL Editor run **`cloud/fall_notifications.sql`**, after these existing migrations in order:
   1. `schema.sql`
   2. `video_schema.sql`
   3. `family_schema.sql`
   4. `website_improvements.sql`
   5. `context_monitoring.sql`
   6. `family_management.sql`
   7. `device_claim.sql`
   8. `care_note_management.sql`
   9. `home_identity.sql`
   10. `multi_camera_homes.sql`
   11. **`fall_notifications.sql`**
3. Existing installations only run the new migration. Do not run older migrations again after newer ones. The new migration is repeatable and does not renumber Homes, recreate data or resend history.
4. Publish the updated `web/` yourself using your existing Vercel workflow. The Service Worker must be served as `/sw.js` from the same HTTPS origin, not rewritten to HTML. No site cache or offline shell is introduced. Existing user `config.js` stays unchanged; the public VAPID key comes from the authenticated configuration function.
5. In-app alerts and acknowledgement work without the optional push service. Until push is configured, the UI reports its unavailability and does not offer a fake enabled state.
6. If using the Python built-in local webpage, restart the monitor normally at a convenient time to load its expanded static module allowlist. Local-password mode does not provide family-account Web Push or shared acknowledgement. A detector used only with the cloud family website needs no detector restart or recalibration for this release.

## Optional Web Push setup (operator only)

Run commands from the project root containing `supabase/`, not from `web/`. No keys should be sent to chat or committed to source.

1. Install pinned tool/test dependencies and generate a new private local secrets file:

   ```console
   npm --prefix video_frontend ci
   node tools/generate_push_secrets.mjs
   ```

   This creates **`supabase/.env.push.local`** once (refuses overwrite), with VAPID keys and a random dispatch secret. No keys are printed. It is ignored by git and excluded from deliverables. Protect this file with the local OS account permissions; keep it outside shared folders. Edit its HTTPS `SAFENEST_VAPID_SUBJECT` to the stable production website, for example `https://elderlyfall.vercel.app`. It is a contact URL, not an email notification setting. Keep these keys stable across deployments; rotation requires browsers to renew subscriptions.

2. Keep the existing server `SAFENEST_ALLOWED_ORIGINS` exact HTTPS allowlist and public Supabase key configuration from the video setup. Ensure it includes the family website origin. Upload only the new push variables:

   ```console
   npx supabase@2 secrets set --env-file supabase/.env.push.local --project-ref YOUR_PROJECT_REF
   ```

   `SUPABASE_SERVICE_ROLE_KEY` is supplied by the hosted Edge environment and used only inside the secret-protected worker. Do not add it to frontend config, Python device config or the generated file.

3. Deploy the two **new** functions yourself:

   ```console
   npx supabase@2 functions deploy family-push-config --project-ref YOUR_PROJECT_REF --no-verify-jwt --use-api
   npx supabase@2 functions deploy dispatch-fall-push --project-ref YOUR_PROJECT_REF --no-verify-jwt --use-api
   ```

   Their handlers enforce Auth + Home membership or the server-only dispatch secret themselves. Preserve those checks. This release does not require redeploying the unchanged `video-token` or `device-video-token` functions.

4. Use Supabase's supported setup to enable **pg_net**, **pg_cron** and **Vault**. In the Vault UI create:

   | Vault name | Value supplied privately by operator |
   | --- | --- |
   | `safenest_push_project_url` | Your exact `https://PROJECT_REF.supabase.co` |
   | `safenest_push_dispatch_secret` | The exact `SAFENEST_PUSH_DISPATCH_SECRET` from the private local file |

   Then review and run **`cloud/setup_fall_push.sql.example`**. It installs a transaction-commit asynchronous insert wake and a named one-minute queue-processing Cron job. Both are trusted server operations. This optional step activates real sending when members opt in. Do not activate it just to run unit tests. Vault and the transient pg_net request queue remain inaccessible to anonymous/authenticated client roles. No raw secret is embedded in the Cron command or example SQL.

5. Each family member signs in, opens their Home → Settings → **Enable browser notifications**, and allows browser permission. An administrator cannot grant another browser's permission. The initial state is not subscribed, even if browser permission was granted for a previous account.
6. With consenting test recipients, perform a separate real-browser/cloud acceptance check. This development run did not do that or send a test notification. Use safe simulations and stop before triggering an actual notification if recipients have not agreed.

Cron is queue transport/retry infrastructure, not a recurring warning or escalation timer. Normal service quotas apply. To pause sending, unschedule `safenest-fall-push` and remove `wake_new_fall_alert` as shown in the example; in-app recording remains available. Pending jobs expire normally. Do not delete historical alert/event rows to pause delivery.

## Browser and runtime limits

- HTTPS, Service Workers, Notification permission and PushManager are required. Feature detection decides whether controls are usable. System focus modes, disabled background services, network restrictions, force-stopping browsers and OS policy can delay or suppress delivery.
- Apple's documented iPhone/iPad flow requires a supported Home Screen web app. Check real target devices; a normal browser tab may not offer PushManager. Desktop and Android behavior depends on browser and OS settings.
- This version accepts tested-format endpoints at `fcm.googleapis.com`, `updates.push.services.mozilla.com`, and `web.push.apple.com` only. Other providers, including some Windows/enterprise browser endpoints, remain unsupported until deliberately reviewed. Arbitrary URLs/IPs, custom ports and redirects are rejected to prevent server-side request abuse.
- `web-push` is pinned at **3.6.7**, for the Edge sender and local tests/key utility. It is not bundled into the website. Its offline request generator performs standards-based VAPID signing and aes128gcm encryption; the actual HTTP uses bounded native fetch with redirect rejection. Existing Supabase and LiveKit SDK versions are unchanged.
- Automatic tests execute SQL in PGlite and mock transport/browser APIs. They do not validate actual Supabase extensions, Vault/Cron, Deno hosted runtime, multiple Postgres connections, browser permission UI or device push delivery. Those require manual acceptance.
- There is no shared “incident resolved” workflow, guaranteed emergency response, alert deletion UI, old-alert pagination, delivery/read receipt from the OS, email, SMS, calls, escalation, voice command or medical prediction.

## Verification

Run from the project root:

```console
python -m unittest discover -s tests -p "test_*.py"
npm --prefix video_frontend ci
npm --prefix video_frontend test
npm --prefix video_frontend run build
```

Tests cover the real incremental SQL, repeatability, publisher-driven episodes, duplicate/history protection, current Home boundaries, server-derived acknowledgement names, subscription ownership, endpoint validation, bans/revocation, queue claims/attempts/expiry, browser feature/permission states, shared UI and stale response cleanup, notification click authorization, media/Presence preservation, and a genuine offline VAPID/encryption/decryption round trip. No live Push endpoint is contacted.

Manual acceptance should additionally verify: two consenting authorized family accounts on real phones, a third unbound account denied, notifications with the page closed, blocked permission and unsupported browsers, re-sign-in and multiple Home preferences, revocation with a queued message, Vercel `/sw.js` content type/CSP, optional Cron/Vault transport, and unchanged live detector/video behavior. Never demonstrate by having an elderly person actually fall.

Official references consulted:

- https://developer.mozilla.org/en-US/docs/Web/API/Push_API
- https://developer.mozilla.org/en-US/docs/Web/API/PushManager/subscribe
- https://supabase.com/docs/guides/functions/schedule-functions
- https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
- https://github.com/web-push-libs/web-push
