# Claim an unassigned monitoring device

A logged-in family account can become a home's **Device manager** by redeeming a one-use code explicitly generated in **Camera setup on the monitoring computer**. Opening a webpage or the local setup window alone grants no rights. This update does not deploy anything.

## Update an existing installation

1. Keep a backup. Copy the update into the existing project root, retaining `.env`, model weights, public web configuration, calibration, settings and event history. Do not delete the original project folder. The source-only archive omits model weights; retain your existing `yolo11n-pose.pt`. No model is downloaded by this update.
2. In **Supabase → SQL Editor**, run **`cloud/device_claim.sql`**. It is an incremental migration after `family_management.sql`. If earlier migrations are already installed, run only `device_claim.sql`. The full order for a fresh database is:

   ```text
   cloud/schema.sql
   cloud/video_schema.sql
   cloud/family_schema.sql
   cloud/website_improvements.sql
   cloud/context_monitoring.sql
   cloud/family_management.sql
   cloud/device_claim.sql
   ```

   Do not rerun older migrations after newer ones; they may replace current RPC definitions. The new migration is rerunnable, preserves existing devices/members/history and marks existing managers' devices as already assigned. No Realtime changes, Storage buckets, Edge Function deployment or new dependencies are needed.
3. Restart the local Camera setup application to load the updated Python files. The original detector, calibration, multi-person tracking, thresholds, sound and on-demand LiveKit code are unchanged.
4. Review locally, then publish the updated `web/` files yourself using the existing Vercel workflow. There is no new frontend bundle/build dependency. This delivery has not published the site or executed SQL on your project.

## First manager: no manual Auth UUID assignment

This claims an **already-registered** monitoring device; it does not provision an unknown camera. The existing device row and matching local `SAFENEST_DEVICE_ID`, `SAFENEST_DEVICE_TOKEN`, `SUPABASE_URL` and public `SUPABASE_PUBLISHABLE_KEY` must already be configured by the trusted installer. Keep the device token on the monitoring computer. No secrets are entered into the family website.

1. On that computer, stop monitoring with **Q** before editing setup. Open **Start_Camera_Setup.cmd** (or `python camera_setup.py` in the existing environment). Select/preview the real camera and save its room/camera labels as usual. Close setup preview before generating a code.
2. Under **Claim this home**, click **Generate device claim code**. A network request verifies that computer's existing device credential. It does not start a camera or a second detector. Only an enabled device that has never been assigned since this migration can issue a code.
3. **Copy claim code**, or select/copy the displayed text. It starts with `sn-claim-`, expires after **10 minutes**, and can grant management to **one account only**. Treat it as a temporary management credential: share only with the intended primary caregiver. Clipboard history is outside app control.
4. On the family website, register/sign in to the intended account and finish email verification if enabled. In **Family Dashboard**, choose **Set up a monitoring device**. Paste the code into **Device claim code**, then click **Become device manager**.
5. The server inserts the existing account/device membership and manager relationship atomically, consumes the code, then the page reloads the authorized device list. Choose the home → **Open monitoring → Manage family** to invite relatives. No camera stream starts automatically.
6. Subsequent refreshes, logins and other browsers restore the relationship from Supabase. No claim code or family invitation is needed again. Friendly names come from the detector's existing snapshot; before it first publishes, a device can appear as **Monitored home** with its short ID.

A normal family member uses **Add a home / device → Follow home** with a family invitation. That code never grants management rights. Account identity, physical monitoring device, room label and temporary Person tracking numbers remain separate concepts.

## Existing managers and account recovery

Already-managed devices cannot generate a claim code. Sign in with the assigned manager account. For a lost account, another intended manager or a trusted project operator must arrange recovery; the operator can use the existing **`cloud/grant_device_manager.sql.example`** after verifying the caregiver and device. The old manual-grant workflow remains supported, but is no longer required for a new unclaimed device.

A durable `assigned_at` marker blocks re-claim even after all managers or their Auth accounts have been removed. Do not clear that marker or delete/recreate a device as a recovery shortcut. Grant a verified replacement manager using the operator workflow. Role removal still revokes management; deleting membership invokes the existing full family-access cleanup. The marker can preserve assignment history only from migration installation onward; it cannot reconstruct roles that were deleted before it existed.

## Code lifecycle and errors

- Generating another code replaces the outstanding one immediately. The database stores only SHA-256 hashes, never plaintext. There is no retrieval RPC.
- **Revoke claim code** cancels only the currently displayed code if it is still outstanding; a late revoke cannot cancel a newer replacement. Revoking a code does not undo a successful claim or remove a manager.
- Closing setup, starting preview/monitoring, expiry or a detected local identity change clears the displayed code. **Hiding/closing is not server revocation**; an outstanding code remains valid until consumed, explicitly revoked, replaced or expired. Generate a new code to replace a lost one. Closing during an in-flight generation may leave a valid unseen code until expiry/replacement.
- The website clears the input when submitting and when cancelling, switching devices, logging out, hiding the page or leaving it. It stores no raw claim code in browser storage. Account/device bindings are server-side; UI role flags are never authoritative.
- If a claim request times out, click **Refresh list** first: the server may already have assigned your account. Do not automatically resend or assume failure. Cancelling a pending form only hides it; it cannot undo a request already received by the server.
- Wrong/expired/replaced/consumed/disabled-device codes share `invalid_claim`, without device details. Redemption is limited to 10 attempts/account/minute. Issuance is limited to 5/device/minute after device authentication; rate counters commit on denials.
- If the local app says claiming is not installed, run the incremental SQL in the same Supabase project configured locally. Authorization errors require checking the existing local registration, not supplying secrets to an assistant or pasting them into the website.

## Security implementation

`device_claims` is private, RLS enabled and inaccessible to browser roles directly. The private `lock_claim_device` verifies the local token and locks the enabled device. `issue_device_claim` / `cancel_device_claim` are available only through the public/anon-key device path with the private token; `redeem_device_claim` is available only to signed-in, active Auth users. Neither code type accepts a client-supplied manager user ID or role.

Device-first row locks serialize issuance, redemption and manager assignment. A trigger records assignment and invalidates outstanding claim codes for both RPC and operator grants. The frontend derives management availability only from `list_my_monitors`; existing manager RPCs keep their independent permission checks. A physical setup user with access to the configured device credential is trusted to nominate the first manager. Protect that computer and its configuration; possession of a short-lived claim code is sufficient to perform the initial claim.

The local client uses HTTPS, disables redirects, uses bounded timeouts, does not retry automatically and never shows raw upstream errors/credentials. Only the public key and authenticated family session are in the browser. No new HTTP control of the monitoring camera, face recognition, permanent Person identity or cloud footage upload is added.

## Files and verification

| Files | Purpose |
| --- | --- |
| `cloud/device_claim.sql` | Hash-only claim storage, durable assignment marker, permission-checked RPCs and assignment trigger. |
| `device_claim.py` | Local credential validation and safe explicit HTTPS issue/revoke requests. |
| `device_setup_ui.py` | English generation/copy/revoke controls, worker-thread network operations, expiry/identity cleanup. |
| `web/index.html`, `web/dashboard.js` | Separate authenticated claim form, backend-authorized restoration and stale-response cleanup. |
| `tests/test_device_claim.py`, `tests/test_device_setup_ui.py` | Local API safety and mocked desktop lifecycle tests. |
| `tests/device-claim-database.test.mjs`, `tests/family-ui.test.mjs` | Real SQL permission/lifecycle tests and mocked webpage claim/restore/race tests. |
| `video_frontend/package.json` | Includes the new SQL test suite; dependency versions unchanged. |
| `README.md`, `docs/DEVICE_CLAIM.md`, `docs/DEVICE_SETUP.md`, `docs/FAMILY_DEVICE_ENTRY.md`, `docs/FAMILY_MANAGEMENT.md` | Current setup, recovery and migration instructions. |
| `cloud/register_device.sql.example`, `cloud/grant_device_manager.sql.example` | Clarify optional initial family binding and trusted recovery. |

Run from the project root in your existing Python environment:

```text
python -m unittest discover -s tests -p "test_*.py"
npm --prefix video_frontend test
```

For a fresh test checkout, `npm --prefix video_frontend ci` installs the existing pinned test dependencies first. There are no new pip requirements or model downloads.

**Results: 180 Python tests passed; 163 frontend/database tests passed.** This includes all previous tests plus 11 Python and 16 frontend/SQL test results for claiming. SQL tests run actual migrations/RPCs/roles in PGlite with mocked Supabase Auth/Realtime schemas. Tests cover expiry, invalid codes, replacement, cancellation, hash-only storage, limits, replay/second-account denial, grant restoration, cross-device access, prior-manager protection, operator grants, page/account switch cleanup and desktop failures. Concurrency is protected by row-lock ordering; simultaneous independent production PostgreSQL sessions have not been load-tested.

No real camera/model, Supabase/LiveKit service or production credentials were used. Native Windows GUI/clipboard and production network behavior require local acceptance. On an unclaimed test device, generate → redeem with account A → verify management → invite B → verify B has viewing only. Re-login A without a code. Try the old claim with B and verify denial. Existing manager devices should report claiming unavailable, while their original management remains usable.
