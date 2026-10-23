# Recovery, push and settings fixes: acceptance and manual steps

Implemented against the previously delivered family-notification source-only package. No deployment, Supabase/Vercel settings changes, real email/Web Push sending or account-secret access/request occurred.

## Implemented changes

1. Recovery has separate request / verifying / ready / failed / complete states. Failed links no longer show an email form under the Reset password heading; the button says **Enter email to request another link**. Callback handling pauses video/Presence and clears other-account sessions. URL cleanup occurs after verification; passwords and recovery credentials remain in memory, with recovery tokens limited to 15 minutes.
2. Supabase’s default implicit recovery may issue OTP AMR. The flow now accepts only callback credentials explicitly carrying `type=recovery`, then validates the URL token and server-returned account with the same Supabase Auth service. It does not borrow a stored ordinary login session. A URL marker alone, untyped OTP, password AMR or invalid/expired token cannot open the new-password form. Default email templates and Custom SMTP need no change for this supported flow; the optional token-hash template remains available.
3. Notification summaries/settings distinguish browser support, permission, this browser’s subscription, service signing/authorization checks, unverified background sending and unconfirmed phone delivery. Missing functions/schema, network failures and revoked access do not appear as success. Check only queries state; Enable requests permission/registers the existing Service Worker.
4. Camera Settings uses ModalSurface: centered on desktop and a scrollable bottom panel below 599px. It includes a backdrop, Close/Esc, focus trapping/return and scroll locking. Opening/closing or notification-setting operations do not add/stop video or Presence. Home/Camera switches, logout, revocation and page exit close it and clear the old scope.
5. A read-only notification diagnostic SQL example does not call the sender or read endpoints/secrets/Vault plaintext. No new migration, database permissions, dependency or credentials are required.

## Changed files (22)

- `README.md`
- `cloud/diagnose_fall_push.sql.example`
- `cloud/reset_password_email.html.example`
- `docs/FAMILY_NOTIFICATIONS.md`
- `docs/RECOVERY_PUSH_SETTINGS.md`
- `docs/RECOVERY_PUSH_SETTINGS_ACCEPTANCE.md`
- `docs/WEBSITE_FIVE_IMPROVEMENTS.md`
- `supabase/functions/_shared/push-core.js`
- `supabase/functions/_shared/push-runtime.js`
- `tests/camera-tools.test.mjs`
- `tests/fall-notifications-database.test.mjs`
- `tests/fall-push.test.mjs`
- `tests/family-notifications-ui.test.mjs`
- `tests/family-ui.test.mjs`
- `web/camera-tools.js`
- `web/dashboard.js`
- `web/family-alerts.js`
- `web/index.html`
- `web/password-recovery.js`
- `web/push-notifications.js`
- `web/styles.css`
- `web/ui-overlays.js`

## Actual test results at this stage

Run at the project root:

```console
python -m unittest discover -s tests -p "test_*.py"
npm --prefix video_frontend ci
npm --prefix video_frontend test
npm --prefix video_frontend run build
video_frontend/node_modules/.bin/esbuild supabase/functions/family-push-config/index.ts supabase/functions/dispatch-fall-push/index.ts --bundle --external:npm:* --platform=neutral --outdir=../edge-syntax-check
```

- Python 3.12.14: 196 passed, 0 failed, approximately 3.34 seconds. Detection, multi-person, calibration, sound, logging, local-device and media tests continued to pass.
- Node 24.19.0: 272 website/SQL tests passed, 0 failed/skipped, approximately 11.03 seconds; 22 new results compared with the previous version. JSDOM, mocks, PGlite and offline Web Push encryption were used without sending notifications.
- Frontend build passed; generated LiveKit/Presence clients and third-party notices matched the previous version byte for byte.
- Local esbuild syntax/import checks passed for both Push Edge entry points, with npm imports externalized. This is not real hosted Deno/Supabase validation.
- All existing Python files, original SQL migrations, device credentials/authorization, thresholds/model calls, calibration, video publishing, original Service Worker, public frontend configuration and Vercel configuration were unchanged. No files were deleted.

## Manual steps required

1. Back up the current project. Existing users merge the update at the project root, preserving configuration, models, calibration and logs. The full source-only ZIP can be extracted separately; do not use it to overwrite private user configuration.
2. In Supabase Authentication → URL Configuration, use the stable production Site URL and add the frontend’s exact callback to Redirect URLs, such as `https://elderlyfall.vercel.app/?recovery=1`.
3. The default supported recovery flow does not require a custom template. If using the optional token-hash route, Authentication → Email Templates → Reset password can use `cloud/reset_password_email.html.example`, preserving template variables. Request a fresh email after publishing/configuring; existing emails do not change. Recovery mail configuration does not add alert-email notifications.
4. No new migration is needed for this stage. If the prior notification migration is missing, run `fall_notifications.sql` after `multi_camera_homes.sql` in the original order. Do not rerun old SQL in reverse order.
5. If push does not arrive, run the read-only `cloud/diagnose_fall_push.sql.example`. Check the existing family-push-config / dispatch-fall-push functions, VAPID/server secrets and Vault/pg_net/Cron wake-up setup. Publishing web/ alone cannot configure these services.
6. This stage enhances family-push-config diagnostics; redeploy that function manually using the existing project configuration. The dispatcher and video functions need no redeployment if already deployed from the previous stage. If background sending was never configured, follow `docs/FAMILY_NOTIFICATIONS.md`; nothing was configured on your behalf.
7. Publish all of web/, including /sw.js, manually to the HTTPS Vercel site, excluding Python source and server secrets. Each family member signs in on their own phone/browser and site origin, selects the Home and explicitly enables notifications. iPhone needs a supported Home Screen web app. Subscribing on a computer does not subscribe the phone. Logout cancels that browser’s subscription; old alerts are not backfilled.

## Real-device checks and unsupported capabilities

- No real Supabase project was accessed, so function, migration, secret and Cron configuration cannot be claimed. The website cannot confirm actual lock-screen display; provider accepted does not mean delivered or viewed.
- Real Gmail callbacks/templates, email rate limits, hosted Edge/Deno, pg_net/Cron/Vault, Vercel HTTP/CSP, Windows/physical cameras, mobile permissions, network loss, power-saving/focus modes and responsive appearance still need manual acceptance.
- Revocation blocks future/pending work and rechecks click access; generic notifications already handed to a push service/OS cannot be recalled.
- No alert email, SMS/WhatsApp, calls, escalation, emergency-service contact, cloud recording, remote physical-camera configuration or delivery guarantee. Physical-camera/bed-zone settings remain in the monitoring computer’s local Camera setup.

See `docs/RECOVERY_PUSH_SETTINGS.md` for the detailed English guide and setup order.
