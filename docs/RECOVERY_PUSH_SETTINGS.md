# Password recovery, phone Push diagnosis and Camera Settings

This maintenance update follows the family-notification release. It changes website recovery/diagnostics/layout, not detection, authorization rules or notification delivery semantics. No deployment, cloud setting change, real email or Push was performed. UI is English.

## What the source inspection established

| Area | Finding | Change |
| --- | --- | --- |
| Password recovery | `CloudClient` uses public-key Auth REST. Recovery has its own memory-only bearer and never borrows the stored sign-in. `/recover` sends no PKCE challenge, so this app has no PKCE verifier. | Keep that architecture; explicitly handle request, verification, ready, failed and completed states. |
| Default recovery email | The old fragment path required AMR `recovery`. Supabase's default implicit recovery can return AMR `otp`, which made a valid Gmail link fail. | Accept the default callback only when it includes `type=recovery` and its own URL access token, then validate that exact token with this Supabase project's Auth `/user` endpoint and match the server-returned user to the signed token claims. A URL flag alone, an untyped OTP, or a stored login token is rejected. |
| Recovery routing | Failures all became “invalid, expired or unsupported” under a Reset password heading, with the request-email form immediately shown. URL parameters were removed before the Auth request finished. | Failed links have their own screen and **Enter email to request another link** action. Missing credentials, unrelated PKCE, expired/used links and network/service failure are distinct. URL cleanup follows verification/error handling; cancelling also cleans it. |
| Push | The source contains the migration, consent/subscription RPCs, private job queue, two Edge Functions and optional wake/Cron setup. A source archive cannot prove those are deployed/configured on your actual project or subscribed on a phone. | Show permission, this-browser subscription, service access/configuration and unknown background/phone delivery separately. Never claim delivered. Add a safe read-only operator SQL checklist. |
| Alerts and recipients | Device-authenticated fresh snapshots create stable per-Camera episodes; unique alert/subscription jobs prevent heartbeat re-sends. Current Home membership remains the recipient authority; queued work is cancelled/rechecked on revocation. | No change to SQL, recipients, alert history, shared acknowledgement, retries, payload or Service Worker click handling. |
| Settings | `CameraTools.openPanel` simply revealed a section and scrolled to it. | One responsive dialog using the existing `ModalSurface`. Reuse existing controls and media; no second connection. |

Primary implementation reference for the AMR compatibility finding: [Supabase Auth implicit verification source](https://github.com/supabase/auth/blob/master/internal/api/verify.go), where implicit verification calls `issueRefreshToken(..., models.OTP, ...)`. See also [password recovery](https://supabase.com/docs/guides/auth/passwords), [email templates](https://supabase.com/docs/guides/auth/auth-email-templates) and [PKCE browser/device limitations](https://supabase.com/docs/guides/auth/sessions/pkce-flow). The exact production failure cannot be conclusively reconstructed from a screenshot; expired links or a mismatched template/return URL can also fail.

## Manual password-recovery setup

1. Set Supabase **Authentication → URL Configuration → Site URL** to the stable production origin, for example `https://elderlyfall.vercel.app`.
2. Add one exact SafeNest callback under **Redirect URLs**: `https://elderlyfall.vercel.app/?recovery=1`. `Site URL` and `Redirect URLs` are separate fields. If the app is served from another origin/path, allow that exact equivalent. The sender builds `location.origin + location.pathname + '?recovery=1'`; it does not accept arbitrary return URLs or hard-code a preview deployment.
3. Keep the current/default Supabase **Reset password** email template and existing email delivery settings. This recovery fix supports Supabase's normal ConfirmationURL redirect, so it does **not** require Custom SMTP or an edited template. Do not copy the three callback URLs from another app; this SafeNest flow needs the one address above. After publishing the frontend manually, request a fresh link. A previously expired or used link remains expired/used.
4. Optional only: if the project allows editing the Reset password template and you prefer one-use token-hash verification, use the HTML in **`cloud/reset_password_email.html.example`**. Only change the Reset password template, not signup/confirmation templates. Keep the Go template placeholders intact. The link is:

   ```html
   <a href="{{ .RedirectTo }}#token_hash={{ .TokenHash }}&amp;type=recovery">Reset password</a>
   ```

   The hash is a one-use Auth credential, not a database password or API key. Putting it in the fragment keeps it out of HTTP request URLs. Do not add analytics, logs, screenshots or third-party forwarding that capture the full link. Legacy query token-hash links remain supported for compatibility.
5. The default callback is handled as follows: the page requires the Supabase redirect's `type=recovery` marker plus the access token carried in that callback fragment; it calls `/auth/v1/user` with that exact bearer, checks the returned account against token subject/issuer/expiry, and uses only that bearer for the password update. Supabase can mark this default implicit session with AMR `otp`; the flow does not require a custom `recovery` AMR. A URL marker by itself or an OTP without a recovery marker is rejected. The normal saved login session is cleared before recovery and never used as a fallback. The optional token-hash template instead asks Auth to verify the one-use hash explicitly with `type: recovery`.
6. In either flow, the server-derived account is the only password target. Success returns to sign in. Passwords and temporary recovery bearers are never placed in browser storage; verification expires after at most 15 minutes or token expiry.

Standard fragment links with a server-validated, signed `recovery` authentication method and Supabase's default `otp` recovery callback are supported. Unsupported external PKCE links are never exchanged using another account's session; the UI explains the original-browser/verifier limitation. This sender does not start PKCE, so adding `?type=recovery` cannot repair an unrelated code. Do not extend link expiry to make an old email work.

Invalid/used links show **Reset link unavailable** and an explicit new-link action, not the email request form under a successful reset heading. Network failures do not get mislabeled as definite expiry. Account-existence request feedback remains generic. Recovery clears old Home, Camera, alerts and Presence and pauses video; it changes no binding or role.

## Phone notifications: what is actually known

The alert card proves that an in-app alert exists; Acknowledge proves viewing was recorded. Neither proves Push was sent or displayed.

The alert list now shows the same notification summary as Settings. **Camera Settings → Browser notifications → Check notification setup** reads configuration and this browser's existing subscription; it does not register a worker, ask permission, create an alert or send a notification. Only the explicit **Enable browser notifications** action requests permission and registers `/sw.js` with root scope `/` over a secure context. Registration bypasses the worker script's HTTP cache. There is no new worker or second subscription system.

| Status | Meaning/action |
| --- | --- |
| Browser notifications are not supported | This context lacks the required secure/browser APIs. In-app alerts still work. On supported iPhone/iPad systems, add the site to the Home Screen and open that app first. |
| Notification permission not decided | Click Enable on that phone/browser to decide. Nothing prompts on page load. |
| Notification permission denied | Change this site's browser/phone notification setting yourself. The site cannot override it. |
| This device is not subscribed | Permission alone is insufficient. Enable for the current authorized Home on this browser. |
| Push service is not configured | Configuration function/schema/signing setup is missing or incomplete. A Home manager/operator must check setup. |
| Subscription saved; delivery has not been verified | Current Home opt-in is saved for this browser. This page cannot prove worker deployment/wake-up or OS display. |
| Push request failed | The request/subscription attempt could not be confirmed. No fake success. Existing in-app alerts remain independent. |

The detail checklist distinguishes browser support, permission, device subscription, Push service, unverified background sending and unconfirmed phone display. The Edge configuration response only confirms its own signing configuration and current authenticated database access. It never invokes a worker or claims that Cron, another Edge deployment or phone delivery was checked. Older configuration responses remain compatible. Missing functions/schema and authorization failures are handled without printing endpoints, tokens or backend error contents.

### Operator checks (manual, no automatic sending)

- This fix adds **no SQL migration** and no new environment variable/dependency. Do not rerun old migrations out of order. The earlier notification release still requires `cloud/fall_notifications.sql` **after** `cloud/multi_camera_homes.sql`; if already installed, it is unchanged.
- Run **`cloud/diagnose_fall_push.sql.example`** in SQL Editor to check catalog objects, notification/revocation/wake triggers and optional extension presence. It is read-only, returns no subscriptions/secrets and cannot send. Optional commented queries count job states and check the named Cron schedule only; run them separately after the relevant objects exist. Presence of a catalog object is not a working-delivery guarantee.
- In Supabase check **family-push-config** and **dispatch-fall-push** deployments and server-only configuration from [FAMILY_NOTIFICATIONS.md](FAMILY_NOTIFICATIONS.md). The public VAPID key must match each current browser subscription. Private VAPID/dispatch/service credentials remain server-only.
- `family-push-config` gains safe diagnostic metadata/schema-error classification in this update. You may manually redeploy that function with the existing configuration. `dispatch-fall-push`, all queue SQL and both video functions are unchanged; no redeploy is required for them **if the preceding release was already installed**. If the original Push sender was never set up, follow that release's complete manual instructions instead of assuming publishing `web/` deploys it.
- Optional `setup_fall_push.sql.example`, Vault and pg_net/Cron wake-up are separate prior-release operator setup. Installing/activating them can enable real sends for consenting members; do not run them merely for automated tests. No such setup was run here.
- Review only safe function counters/status codes and aggregated job states. Do not export subscription rows, pg_net authorization headers, full request bodies or decrypted Vault values. Pending/expired jobs can indicate a missing wake/worker, but are not by themselves proof of one specific cause. Accepted by a provider is not OS delivered/read.
- Confirm each family member is currently authorized for the Home and opted in on **their own phone/browser and site origin**. Opt-in on your laptop does not subscribe their phone. Signing out disables this browser subscription. A later subscription never replays an old alert; an already displayed alert is not a new Push test.
- After all manual setup, real end-to-end verification needs a consenting test member, supported phone/browser and a new controlled alert. No real notification was sent during this task. Never ask an elderly person to fall for a test.

### Browser/deployment boundaries

Vercel must serve the complete `web/` folder over HTTPS, including the same-origin `/sw.js` JavaScript and existing manifest. Existing `web/vercel.json` CSP and public configuration are preserved. Publish manually through your existing workflow; no server Push credentials belong in Vercel static files. Changing from a preview origin to the production origin requires opting in there separately. A Service Worker has no private-data fetch cache and clicks only open the authenticated alert page, never LiveKit.

On iOS/iPadOS, Web Push requires a supported Home Screen web app (iOS/iPadOS 16.4+), explicit user permission and OS notification settings. On Android use a compatible browser/Push provider with system notifications allowed. Feature detection remains authoritative; in-app email browsers, private/managed environments, unsupported endpoint providers or school networks can prevent Push. Installation alone does not subscribe an account. Battery policies, focus modes and provider/network failures can affect presentation. See [Apple/WebKit guidance](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/) and [MDN Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API).

No public diagnostic endpoint or recipient/subscription enumeration was added. Revoked Home access still cancels/rechecks pending work and denies alert/click access. A notification already handed to a provider/OS cannot be recalled. Unknown outcomes are not blindly replayed.

## Settings dialog

Desktop uses a centered, fixed dialog with a backdrop. At 599px and below it becomes a scrollable bottom sheet (maximum 94dvh) with a persistent Close header. The existing modal component provides native top-layer behavior or an inert/focus-trapped fallback, Escape, background scroll lock and focus return to the actual activating control. The alert's notification-settings link opens this same dialog and focuses the notification section. There is one settings DOM tree, one video and one set of event handlers.

Opening/closing Settings or checking/subscribing to notifications does not reconnect video/Presence, start recording or change alert polling. Home/Camera switch, logout, authorization loss and page teardown close it and clear the old media/settings scope. Preferences, real session media-byte inventory and privacy/local setup explanations are reused; no physical-camera controls are invented. Selection/preview/bed calibration remain on the monitoring computer's Camera setup. PTZ, cloud storage, microSD and prediction are still not configured.

## Verification and limitations

Run from the project root using the existing Python environment:

```console
python -m unittest discover -s tests -p "test_*.py"
npm --prefix video_frontend ci
npm --prefix video_frontend test
npm --prefix video_frontend run build
```

Mocks/PGlite verify callback formats, server-derived identity, cross-browser token-hash/OTP compatibility, invalid/used/ambiguous links, cleanup order, unrelated PKCE refusal, rate/network/policy errors, truthful Push state, revocation/duplicate protection, safe diagnostics and modal focus/media preservation. Existing detection/threshold, tracking, calibration, sound, authorization, notes, Presence, LiveKit and event-limit tests remain required. No real Gmail, Push endpoint or cloud account is used.

Still manual: actual Gmail/email-template/redirect behavior, hosted Edge/Deno configuration, pg_net/Cron/Vault transport, Vercel Service Worker HTTP/CSP behavior, phone permissions/OS display, real-browser responsive appearance and Windows/device media. This release adds no email/SMS/WhatsApp/calls/escalation, no remote hardware controls and no delivery/read receipt guarantee.
