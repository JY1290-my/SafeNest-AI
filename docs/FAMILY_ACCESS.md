# Family registration, device following and shared care notes

Updated entry flow: after sign-in, open **Family Dashboard → Followed homes**.
The invitation form is collapsed by default. To add a binding, click **Add a home / device**, enter the code and click **Follow home**.
Existing devices need no further invitation entry. Device setup is on the monitoring computer through `Start_Camera_Setup.cmd`; the family website does not provide physical camera-management access.
See [FAMILY_DEVICE_ENTRY.md](FAMILY_DEVICE_ENTRY.md). This entry-flow update requires no new SQL.

This stage reuses `device_id` and `safenest_private.members`. Existing family access remains valid; new accounts have no device access. Each device_id represents a monitoring device/area, and one account can follow several devices. The multi-person version monitors several people in one view while permissions remain device-scoped. Temporary person IDs are not identities or authorization. Original single-person posture decisions, status publishing and LiveKit token/media flows are retained; sound is deduplicated at the aggregate alert level as described in MULTI_PERSON.md. This guide records the original family-access stage; see the current README for later Home/Camera extensions.

## Updating an existing project

1. Back up the project. Prefer extracting `SafeNest_AI_Family_Update.zip` and copying its files to matching paths at the existing project root. It contains no `.env`, device token, `web/config.js`, `web/vercel.json`, Vercel project link or models and does not replace your configuration.
2. Run **all of** the new `cloud/family_schema.sql` in Supabase SQL Editor. If base/video schemas are already installed, run only this new migration. Do not delete data or recreate devices.
3. Enable email registration, configure verification/Site URL and generate an invitation as described below.
4. Deploy the updated `web/`, restart local Python so new static modules are available, and follow the acceptance checklist.

The full `SafeNest_AI_Family.zip` is suitable for a separate folder; preserve/migrate your original `.env` and local configuration yourself. It excludes real server-secret files, historical CSV, dependency caches and deployment associations. Existing installations should prefer the update package.

## 1. Supabase migration

For a new installation, the order at this stage is:

1. `cloud/schema.sql`
2. `cloud/video_schema.sql`
3. `cloud/family_schema.sql`

Existing installations append only the third file. The new migration creates tables/RPCs in one transaction, supports reruns and retains devices, members and snapshots. SQL Editor showing `Success. No rows returned` means it ran successfully; it is not the invitation-generation step.

New private tables: `family_invites` (hash/expiry/quota), `family_limits` (rate limiting) and `care_notes` (notes). All have RLS enabled and direct access revoked from `anon`, `authenticated` and `public`. Do not add public-read policies or expose the private schema through the API.

Signed-in clients can call only these authorization-checked RPCs:

| RPC | Behavior |
|---|---|
| `list_my_monitors()` | Lists only the caller’s bound, enabled devices |
| `redeem_family_invite(p_code)` | Redeems a code and creates membership |
| `list_care_notes(p_device)` | Checks membership, then reads the latest 30 notes |
| `add_care_note(p_device,p_body)` | Checks membership, body length and rate limit before posting |

Status/events continue through `read_monitor`; video uses the existing `video-token` Edge Function. The page sends the selected device UUID. Changing it client-side cannot bypass server membership checks.

## 2. Enable email registration and verification

In Supabase Dashboard **Authentication** settings:

1. Enable **Allow new users to sign up** and the Email provider.
2. Decide whether to enable **Confirm email**. Enable it for production family use and configure your own SMTP service. Supabase’s default mail service is for testing, with recipient and rate limits; consult the dashboard and official documentation.
3. In **URL Configuration**, set **Site URL** to the stable production Vercel HTTPS root, such as `https://YOUR-PROJECT.vercel.app/`, rather than a temporary preview deployment.
4. Add exact HTTPS addresses to Redirect URLs for extra domains/redirects. At this stage registration does not override redirect URL and defaults to Site URL. Arbitrary domain wildcards are unnecessary.

With email confirmation enabled, the page asks users to check email; after verification opens the website, sign in with email/password. With confirmation disabled, a returned session goes directly to the account page. Both flows still require invitation redemption before showing devices. For an existing account, Supabase may return a generic privacy-preserving signup response; the page does not claim an account was certainly created.

The login session is saved in the current tab’s `sessionStorage`. F5 restores it and rechecks membership RPCs; access/refresh tokens update on expiry, and invalid sessions are cleared with a sign-in prompt. Sign out clears saved tokens and device selection. Passwords, monitoring states, events and notes are not saved in browser storage or localStorage. Closing the tab normally requires signing in again, although browser tab restoration may preserve the session; use Sign out on shared computers. Sign-in still works when storage is blocked, but refresh restoration is not guaranteed. Session parameters are removed from email-verification URLs. Password recovery was not included at this historical stage; use the current recovery documentation for the later implementation.

Existing LiveKit API Secrets, device tokens and Edge Function secrets need no change and must not enter the browser. The website uses only the existing Supabase URL, publishable/anon key and public LiveKit URL.

## 3. Administrator creates an invitation

1. Find the target device UUID in local `.env` as `SAFENEST_DEVICE_ID`. This is **not the Supabase Project Reference ID**. Do not copy the device token.
2. Open `cloud/create_family_invite.sql.example` and replace only `REPLACE_DEVICE_UUID` with that UUID.
3. Run its CTE query in SQL Editor. Defaults are 7 days and at most 5 new family members. Adjust `interval '7 days'` and `5` as needed (maximum 100).
4. Copy `invitation_code` from the result and privately share it with the family. This query creates and returns plaintext once; the database stores only a SHA-256 hash and cannot recover the original code later. Create another if lost. Do not commit the result or SQL filled with private values.
5. After registration/sign-in, family members see **Followed homes** on the account entry page. Enter the code under **Invitation code → Follow home**. After binding another invitation, use **Monitoring home** to select it and **Open monitoring** to enter the dashboard.
6. **Choose home** returns to the entry page to manage follows or select another monitor. Returning stops old video and clears old status/notes; the entry page does not poll monitoring data. F5 restores the previous entry page or selected monitor, but **View camera** must be clicked again. Follows load only after login and are not public.

At this original stage, invitation creation is administrator SQL only, without a browser management entry or public person/device search. Primary caregivers can privately forward administrator-provided codes; ordinary members cannot obtain codes for other devices. Later management features are documented in FAMILY_MANAGEMENT.md.

Redemption permits at most 10 attempts per account per minute, including malformed input. Invalid, expired, disabled, device-disabled and exhausted invitations all return the same `invalid_invite` without device details. Excess attempts return `rate_limited`. Errors use ordinary JSON so failed-attempt counters are not rolled back with SQL exceptions. Row locking protects use quotas. Rejoining an already-bound device consumes no extra use, provided the invitation remains valid and has remaining quota.

Revoking an invitation prevents future bindings without removing existing members. To revoke family access at this stage, an administrator deletes the corresponding `members` row in SQL Editor using the example commands. Subsequent status/note/video checks reject the account; the browser clears device content and refreshes its list on authorization failure. Information already read or copied cannot be remotely recovered.

## 4. Shared care notes

- Each note contains 1–1,000 characters; whitespace-only input is rejected. An account may successfully post at most 5 per minute across devices.
- Show the latest 30 notes, author display name and time. Names originate from registration and may repeat; they are not verified identities. Times use the viewer’s local timezone.
- Only currently bound members can read/write. Anonymous, unbound and cross-device access is denied. Notes cannot change detection states, events or device permissions.
- Notes contain observations, care suggestions or false-alarm explanations, not emergency alarms or medical diagnoses. They refresh automatically approximately every 15 seconds and when the page becomes visible again.
- Display names, device names and notes are rendered as text. HTML/scripts appear as ordinary text and do not execute.
- This initial MVP had no editing, deletion, notifications or full-history pagination. Later note-deletion and alert features are documented separately. The database retains notes; the list shows the latest 30.

## 5. Publish the website manually

Preserve working `web/config.js`, `web/vercel.json` and the `web/.vercel` project link. The page selects devices from the authorized list rather than relying on `config.deviceId` for permission.

No configuration regeneration is required if project URL, public key and LiveKit URL are unchanged. If they changed, run `python configure_web.py` at the **project root** before publication.

```bat
cd /d C:\Users\Default.DESKTOP-QHM9VSV\Desktop\elderly_fall_ai
cd web
npx vercel@58.7.1 --prod
```

Publish only `web`. Keep the existing Vercel project and production domain. This stage does not require redeploying the two video Edge Functions. If the production domain changes, update both Supabase Site URL and the video functions’ allowed Origin settings.

New directly loaded frontend modules need no build; `web/video-client.js` remains the existing bundle. `video_frontend` npm dependencies are only for development/testing and future video-module rebuilds. Do not upload node_modules.

## 6. Tests and acceptance

After installing the existing project dependencies in the Python environment, run:

```bat
python -m unittest discover -s tests -v
npm ci --prefix video_frontend
npm test --prefix video_frontend
```

Automated coverage includes signup responses with email verification on/off, errors, empty accounts, valid/invalid/expired/exhausted/rate-limited invitations, hash-only storage, cross-device status/video/notes denial, RLS/direct-table privileges, note length/rate, revocation, safe HTML text rendering, stale responses/video on switches and session-refresh races. Database tests run the three SQL files in PGlite PostgreSQL; Auth network responses are mocked. They do not access your cloud account.

Manual checks after deployment:

1. Register a new email and verify the prompts with email confirmation on/off. An unbound account has an empty list and sees no devices.
2. Test valid, expired and exhausted codes separately. Successful binding reveals the corresponding status/events.
3. Bind two devices. While viewing A, click Choose home, choose B and Open monitoring. Old video stops immediately; B requires another explicit viewing click.
4. Two accounts bound to the same device can read each other’s notes; a third unbound account cannot. Notes do not change AI status.
5. Remove the test account’s membership and confirm subsequent status/note/video access is denied.
6. Press F5 on the monitoring page to retain login and selection. After Sign out, F5 should show the login form.
7. Verify video on a real phone, Windows camera and the intended network. Automated tests cannot replace real Supabase email, Vercel and LiveKit end-to-end acceptance.

Official configuration references:

- https://supabase.com/docs/guides/auth/general-configuration
- https://supabase.com/docs/guides/auth/passwords
- https://supabase.com/docs/guides/auth/redirect-urls
- https://supabase.com/docs/reference/javascript/auth-signup

## Entry-page update for installations with family access already enabled

Copy the new update files to matching paths, then run `npx vercel@58.7.1 --prod` inside `web`. This entry-page stage changes neither `family_schema.sql`, video functions nor invitation format; already applied migrations do not need rerunning.

Supabase session reference: https://supabase.com/docs/guides/auth/sessions
