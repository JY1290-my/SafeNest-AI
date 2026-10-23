# Home identity, account recovery and the family monitoring interface

Recovery correction: see [RECOVERY_PUSH_SETTINGS.md](RECOVERY_PUSH_SETTINGS.md). The default Supabase recovery callback can carry a URL access token whose AMR is `otp`. SafeNest now requires the callback's `type=recovery`, validates that exact bearer against the configured Supabase Auth `/user` endpoint, and uses the server-returned account. It never falls back to a saved login session; the URL flag by itself does not enable password changes. The optional token-hash template remains available but is not required and does not require Custom SMTP.

This release implements five website improvements on the preceding care-note-management delivery. It adds no runtime dependency, deploys nothing, sends no test email and preserves the current camera/detection/video pipeline.

## Review before implementation

| Existing area | Finding and implementation |
| --- | --- |
| Auth | The static frontend uses `CloudClient` with public-key Auth REST calls and tab-scoped normal sessions. It previously stripped all mail-link parameters and only displayed a confirmation message. Recovery now has a separate controller, verified recovery credentials and memory-only temporary state; normal login/session restoration remain intact. |
| Devices and roles | `members` and `device_managers` already persist authorized devices and management roles. Existing claim/invite/revocation RPCs are retained. Home codes are new immutable labels on the existing device rows. |
| Local setup | Camera selection, labels and scoped calibration already exist in Tk/OpenCV. The setup window now reads its Home code using the configured device credential; it does not acquire a camera for this lookup or grant account permissions. |
| Family management | Existing device-checked RPCs are reused inside a modal dialog. Invitation plaintext still clears on close/switch/logout/access loss. |
| Care notes | Existing server-derived author names, author/manager deletion and English confirmation are retained. The same single notes section moves beside the camera on wide screens and expands under it on smaller screens. |
| Presence | Existing private channel and checked roster are reused. Only the presentation changes: a compact camera-header entry and an expandable family list. |
| Media | Existing LiveKit controller, leases, tokens, screenshots, manual recording and PiP are reused. Opening interface panels does not request a second connection. |

Family accounts identify relatives; the device UUID identifies an installation; Home codes are fixed display labels; room names are editable labels; Person numbers remain temporary tracks.

## Manual installation

1. Back up your project. Copy this update into the existing project root while keeping `.env`, model weights, `web/config.js`, local settings, calibration and event files. The complete source-only archive omits model weights; retain your working `yolo11n-pose.pt`.
2. In Supabase **SQL Editor**, run **`cloud/home_identity.sql`** after the previously installed `care_note_management.sql`. Existing installations need only the new migration. The complete order is:

   ```text
   cloud/schema.sql
   cloud/video_schema.sql
   cloud/family_schema.sql
   cloud/website_improvements.sql
   cloud/context_monitoring.sql
   cloud/family_management.sql
   cloud/device_claim.sql
   cloud/care_note_management.sql
   cloud/home_identity.sql
   ```

   Do not run older migrations after newer ones; older definitions can replace newer RPC behavior. The new migration is rerunnable and preserves all devices, memberships, roles, notes and snapshots/events. It adds a private sequence/number column and checked metadata RPC, without public device search or additional RLS policies.
3. In Supabase **Authentication → URL Configuration**, keep the stable production site as **Site URL**. For example: `https://elderlyfall.vercel.app`. Add the exact recovery redirect used by the page to **Redirect URLs**, for example `https://elderlyfall.vercel.app/?recovery=1`. Add only exact development/preview origins you actually use. If serving from another path, allow that path with `?recovery=1` instead. Requests construct this URL from the current origin/path; arbitrary return/next query parameters are not used.
4. Keep Supabase's existing/default **Reset password** template and email configuration. The updated frontend accepts its normal verified ConfirmationURL callback without requiring Custom SMTP or template edits. A default callback is accepted only with its recovery type and its own URL bearer, which is verified against Auth before the new-password form appears.
5. Optional: if template editing is available and desired, **`cloud/reset_password_email.html.example`** uses `{{ .RedirectTo }}#token_hash=…&type=recovery` for explicit one-use recovery verification. This is not required for the default flow. Never place SMTP or other secrets in frontend files. After publishing the frontend, request a fresh email; expired/used emails cannot be revived.
6. Update all shipped `web/` files together, review and publish them yourself with the existing Vercel workflow. No new frontend SDK build, new environment key, Realtime change or Edge Function deployment is required. This delivery has not published anything or changed your Supabase account.
7. Reopen **Start_Camera_Setup.cmd** on the monitoring computer to load the new metadata display. A configured cloud device performs a background Home-ID lookup after the UI opens; **Refresh Home ID** retries it explicitly. Local-only/unregistered/offline installations show **Home ID unavailable**. No code/label is guessed or cached to disk. Existing monitoring may keep running; camera selection/calibration changes still require stopping detection as before.

## Fixed Home codes

Every existing/new registered device gets one server-generated number, displayed as `Home-001`, `Home-002`, … `Home-1000`. Backfill occurs once; sequence values are never rewound or reused on migration reruns. Gaps are allowed. A database unique index and sequence enforce uniqueness. A trigger fills new-device numbers through the existing registration INSERT and prevents changing an assigned number.

The account device selector displays **Home-001 · Bedroom**. The monitor header shows the Home code with the current room title; the Manage family dialog shows both. The local setup window shows the same server code beside the existing room/camera fields. An offline initial/failed lookup shows Home ID unavailable while local fields remain usable. A previously verified label exists only in RAM, tied to device_id until setup closes; it is an identity label, not a continuous online-status claim.

Refreshing, restarting, renaming the room or changing the local camera index does not alter the code. A newly registered device UUID gets a new code and does not inherit old membership or calibration. One device still corresponds to one monitored Home in this MVP; there is no new multi-camera Home model.

`list_my_monitors()` adds `home_code` while retaining existing parameters/fields and current enabled-device/membership checks. The local-only `device_setup_info(p_device,p_token)` returns that device's ID and Home code only after existing credential verification. Browser accounts cannot invoke it with their user role or directly access the private table/sequence. Home codes are labels, never authorization credentials; no public code-to-device lookup or list exists. A trusted SQL operator can still perform exceptional maintenance, but clients cannot rename or edit these codes.

## Password recovery behavior and security

- **Forgot password?** opens a separate form. A successful request gives the same message for account existence: **If an account exists for this email, you’ll receive a reset link.** The UI has a one-minute resend cooldown; Supabase's server-side rate/email limits remain authoritative.
- The email returns to the same page. The recovery controller handles relevant credentials in memory and removes URL parameters after verification/error handling, or on cancellation. It clears the previous tab's normal session/device selection and stops video/Presence before verifying anything. No device list is restored while recovering.
- Default implicit fragment recovery requires `type=recovery` plus the access token carried in that callback. SafeNest verifies that exact token with `GET /auth/v1/user` on the configured Supabase project, checks subject/issuer/expiry against the returned account, and accepts the expected `otp` or `recovery` AMR. It never adopts a token from CloudClient's saved login. A URL flag alone, a normal password token, or an untyped OTP grants nothing.
- Token-hash recovery uses `POST /auth/v1/verify` with `type: recovery` and then verifies the resulting user/token. Signup hashes or arbitrary identities cannot select the account. The new password request contains only the password, authenticated with the verified recovery token; no client-provided user ID or email chooses the target.
- The recovery session lasts at most 15 minutes or until its access token expires. It is not refreshed or saved in cookies/localStorage/sessionStorage. Back, page teardown and completion discard temporary credentials and attempt to revoke only that temporary recovery session with local scope. A late verified session received after cancellation is also cleaned up when possible.
- New/confirm passwords must match and have at least eight characters; Supabase enforces the configured full policy. The UI handles rate errors, weak/same password, expired links and connection failures without exposing tokens or raw server errors. Inputs clear after an update attempt or when leaving the flow.
- Successful recovery offers **Back to sign in**. It never assigns a Home or modifies any binding, manager role or invitation. Stored normal sessions in other tabs/browsers follow Supabase's own session-revocation policy; the app does not rewrite their account data.

This app's sender uses the existing REST/implicit approach and supports the standard fragment and token-hash email links above. PKCE `code` callbacks initiated by another app/SDK are not exchanged here because this frontend has no matching verifier; they show an invalid/unsupported-link message instead of adopting an unrelated session. Do not change the frontend to trust a callback flag or a token decoded without server verification. Projects using custom access-token hooks, MFA/secure-password-change policies or email providers that prefetch/alter links need to validate their policy in a real deployment. Email delivery and account recovery cannot work offline.

Primary references used: [Supabase password recovery](https://supabase.com/docs/reference/javascript/auth-resetpasswordforemail), [email templates and token-hash verification](https://supabase.com/docs/guides/auth/auth-email-templates), [JWT authentication-method reference](https://supabase.com/docs/guides/auth/jwt-fields), [redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls). No emails were sent during development.

## Responsive monitoring and family controls

- At widths of 1000 CSS pixels and above, a two-column workspace allocates roughly two-thirds to the camera and one-third to care notes. The notes panel can scroll independently. Smaller widths keep the camera full width, with a **Care notes** button to expand the same notes/form underneath. No duplicate video, notes or submit handler is created.
- **Manage family** opens a native modal dialog where supported, with a fixed overlay fallback, focus trap, inert background, scrollable content, Close/Escape and focus return. It leaves the underlying monitor and video active. Selection/logout/permission loss clears it and invitation codes. This is account-access management; it does not remotely operate the camera.
- The camera title contains a family icon and **Family · N**, one short name when space allows and **+N** for the remainder. Opening it expands a compact roster beneath the header, in document flow, so it does not cover PiP/video controls. Close/Escape and outside-click dismissal are supported. It is a disclosure rather than another modal.
- Online names still come from the authorized roster RPC. Loading, zero members and unavailable are distinct states. Stale/unavailable states clear names and counts rather than claiming the old members remain online. “Recently connected” never claims that someone is watching the camera or available to respond.
- View camera still starts only after a click. Family/notes panels neither stop nor create LiveKit/Presence connections. Device changes clear old notes/drafts/confirmations and stop old media/subscriptions before loading the newly authorized Home. Latest-event display stays at 10 and note display at 30.

## Automated validation and remaining manual checks

Run from the project root, using the existing Python environment:

```text
python -m unittest discover -s tests -p "test_*.py"
npm --prefix video_frontend test
```

A clean test checkout first uses `npm --prefix video_frontend ci` for existing pinned test dependencies. No dependency versions changed.

**Final results: 184 Python tests passed; 195 frontend/database tests passed; zero failures.** All previous tests ran. This release adds four Python cases and fourteen frontend/SQL test results to the preceding delivery. Tests cover all existing behavior plus Home backfill/rerun/uniqueness/rollback gaps/1000+ formatting, local credential isolation, offline/stale Home-ID results, recovery generic responses/rates/weak-password/errors/expiry/cancellation/wrong-account protection, modal focus/Escape/cleanup, compact Presence states and single-media/panel behavior. The all-migrations SQL integration test now also applies home_identity.sql before exercising notes and revocation.

SQL tests execute PostgreSQL functions in PGlite with mocked Auth/Realtime structures. UI tests use JSDOM, mocked network and media. Python uses synthetic data/mocks. Queued inserts test sequence/index behavior; independent concurrent production PostgreSQL sessions were not load-tested. Fourteen detector, calibration, tracking, alert, Auth client and media/Presence core files were byte-compared to the preceding delivery and remain unchanged. Only the local setup UI/client and web static allowlist change outside the web/database layer.

A native browser visual check was attempted, but this environment has no installed browser executable and its browser download failed. No screenshot or real-browser layout pass is claimed. JSDOM interaction/structure tests passed; actual browser appearance, native dialog/PiP/recording behavior, Windows Tk/clipboard/camera drivers, SMTP delivery and live Supabase/LiveKit still require local acceptance.

After your own setup/publication:

1. Check the same Home code in Family Dashboard, the monitor header, Manage family and the local device window. Rename the room and restart/refresh; the code must stay fixed. An unbound account must see no such Home.
2. On phone and computer, verify one player/form, wide-screen notes beside video and phone notes opening underneath without horizontal overflow. Open/close management and Presence while viewing; the video should continue. Switch Homes: old data clears and the next video stays off until requested.
3. With a designated test account, request a real recovery email yourself. Open it with another account already signed in, verify the old monitor disappears, reset only the intended account and sign in again. Check invalid/used links and configured password policy. Do not share the link/tokens/password in logs or screenshots.
4. Verify existing invitation/claim/revocation and note deletion flows, including revocation during viewing. Presence remains private. Actual fall-detection quality and camera-movement calibration require the original physical scenarios, not a browser UI test.

Unsupported: remote camera startup/calibration/PTZ, permanent Person identity, predictive fall models, automatic cloud recording, note editing/undo/history pagination, offline password recovery and arbitrary external PKCE flows. Existing browser limitations and privacy constraints remain.

## Files changed

| File | Purpose |
| --- | --- |
| `cloud/home_identity.sql` | Incremental immutable Home numbers and authorization-checked metadata/list RPC. |
| `cloud/reset_password_email.html.example` | Optional recovery token-hash email template. |
| `device_claim.py`, `device_setup_ui.py` | Reuse local credential checks for safe asynchronous Home-ID display. |
| `monitor_bridge.py` | Allow serving the two new local frontend modules; no new camera endpoint. |
| `web/password-recovery.js` | Memory-only, verified recovery session and English forms. |
| `web/ui-overlays.js`, `web/family-management.js` | Accessible management modal lifecycle and existing manager operations. |
| `web/dashboard.js`, `web/index.html`, `web/styles.css` | Home labels, recovery routing, two-column/mobile notes and compact family Presence. |
| `tests/home-identity-database.test.mjs` | Home identity, permissions, migration and preservation tests. |
| `tests/care-note-management-database.test.mjs` | Extends integration acceptance through the latest migration. |
| `tests/family-ui.test.mjs` | Recovery/account isolation, modal, notes and Presence interactions. |
| `tests/test_device_claim.py`, `tests/test_device_setup_ui.py` | Local Home-ID client/UI and stale-device safety. |
| `video_frontend/package.json` | Includes Home-ID tests, no dependency change. |
| `README.md`, `docs/WEBSITE_FIVE_IMPROVEMENTS.md` | Installation, email URLs, operation, verification and limits. |
