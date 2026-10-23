# Supabase status bridge and Vercel deployment

## Architecture

- Computer: camera 0 → original YOLO detection → local CSV and alert sound.
- Independent background thread: status + recent events → outbound HTTPS → Supabase RPC.
- Phone: Vercel static website → Supabase Auth sign-in → authorized status-read RPC.
- Video: separate from the status database. The local preview remains available; remote LiveKit video requires the two Edge Functions described in REMOTE_VIDEO.md.

Local mode works without cloud credentials. Never place Supabase `service_role` or `sb_secret_...` keys in the browser or this project’s configuration.

## A. Create a Supabase project

1. Create a project at https://supabase.com/dashboard and wait for the database to become ready.
2. In Project Settings / API (or the Connect dialog), copy the Project URL and **publishable key**. Legacy project `anon` keys are also supported. Do not copy a service_role / secret key.
3. Open SQL Editor and run all of `cloud/schema.sql`. It creates private tables and two RPCs in the public schema, not a Storage bucket.
4. In CMD on the monitoring computer, with the environment activated, generate a device identifier and write token:

```bat
python -c "import uuid; print(uuid.uuid4())"
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

5. Open `cloud/register_device.sql.example`, replace the placeholders with the device UUID and long random token, and run its first `insert into ...devices` section in SQL Editor. The database stores only the token’s SHA-256 hash. Never commit SQL containing a real token.
6. Configure the video schema following `docs/REMOTE_VIDEO.md`, then run `cloud/family_schema.sql`.
7. Follow `docs/FAMILY_ACCESS.md` to enable email registration/verification, configure Site URL and create invitations. Family members obtain membership after registering and redeeming an invitation.
8. Existing manually created accounts and `members` rows remain valid; no deletion or rebinding is required. Registration alone does not grant device access.

Email verification links use the production website address; see the family-access guide for full setup. This historical deployment stage did not include password reset; current recovery instructions are in the README and recovery guides.

## B. Configure the monitoring computer

Open `.env` at the project root (first run `copy .env.example .env` if it does not exist):

```dotenv
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLIC_PUBLISHABLE_KEY
SAFENEST_DEVICE_ID=YOUR_DEVICE_UUID
SAFENEST_DEVICE_TOKEN=YOUR_LONG_RANDOM_SECRET
```

Retain your existing room name and local password. Restart detection:

```bat
python fall_detection.py
```

On the local website, `Cloud bridge` should become Connected when the network is available. Missing configuration shows Disabled; request failure shows Disconnected. These do not change local detection states.

Use SQL Editor to check for new server-side heartbeats:

```sql
select device_id, received_at, payload->>'status' as status
from safenest_private.snapshots;
```

There is one row per device. Recent events update with the snapshot; no frames or recordings are stored.

## C. Generate public frontend configuration

From the project root with Python’s environment activated, run:

```bat
python configure_web.py
```

This generates `web/config.js` containing only `mode`, project URL, public publishable key, device UUID and public video configuration. The multi-device UI selects from the authorized list; a static device UUID grants no read access. These values may appear in the browser. Access boundaries are authentication, membership and the private device-write token. Device tokens and local passwords must never appear here.

The script rejects `sb_secret_...` and checks that legacy JWT keys use the `anon` role.

## D. Deploy to Vercel (web folder only)

### Option 1: Windows CLI

Install Node.js LTS (https://nodejs.org/), reopen CMD and run from the project root:

```bat
cd web
npx vercel login
npx vercel --prod
```

On first use, npx asks to install Vercel CLI. Select your Vercel account/team and create a project such as `safenest-monitor`.

- Select the current `./` deployment directory because you are already inside `web`.
- Framework Preset：**Other**。
- No dependency installation or build is required; `vercel.json` specifies an empty buildCommand and output directory `.`.
- Do not configure Python Functions or upload the project root.
- Open the resulting HTTPS production URL in the phone browser.
- After later website edits, run `npx vercel --prod` again from the same `web` directory.

### Option 2: Import a Git repository

1. Place the project in your private repository and ensure `.env` is not committed. `web/config.js` contains deliberately public frontend configuration and may be committed.
2. Vercel Import Project，**Root Directory = web**，Framework = Other。
3. Leave Build Command empty/disabled, set Output Directory to `.`, and use no Install Command.
4. Open the HTTPS URL after deployment. Public configuration changes require redeployment; this static website does not automatically read Vercel environment variables.

**Deploy only web/.** Python, models, CSV, original source and `.env` do not belong in the website’s public directory. Do not publish the whole project as static output.

If using a custom Supabase domain, also add your **exact HTTPS API domain** to CSP `connect-src` in `web/vercel.json`, then redeploy. Generated configuration uses exact Supabase/LiveKit domains.

## E. First phone verification

1. Run `python fall_detection.py` on the monitoring computer and ensure cloud heartbeats update.
2. Open the Vercel URL on the phone and sign in using a family email/password with assigned membership.
3. Compare room name, status, time and events with the computer.
4. Check **Camera stream not connected**: this appears if media is not configured. Supabase status configuration does not replace remote-media setup.
5. Disconnect the computer’s network while keeping the phone online. After the last heartbeat is over 15 seconds old, the phone must show Connection Lost. Reconnection may require up to approximately 30 seconds of background backoff plus website polling time.

## F. Authorization model and verification

- The private schema is unavailable to anon/authenticated. All three tables have RLS enabled and no direct client table privileges.
- `publish_monitor` is a narrowly scoped security-definer RPC granted only to anon. It verifies the device UUID, long random token hash and enabled flag. Family accounts cannot write directly to tables.
- `read_monitor` is granted only to authenticated and rechecks `auth.uid()`, members and enabled internally.
- Both functions are created and owned by the database administrator, use an empty search_path and fully qualify every non-built-in object.
- Publishing reconstructs allowlisted fields, caps the payload at 20 KB and 30 events, and rejects DEMO publishing. Extra JSON fields are not stored.
- Login tokens are stored in the current tab’s sessionStorage. Refresh restores them and revalidates membership. Passwords are not saved and localStorage is not used for sessions. Tokens refresh during login. Logout clears saved tokens/device selection and attempts server-side sign-out.
- The device token is a single-device write credential, not a video-read credential. A leak permits false status publishing for that device and requires revocation/rotation.

After deployment, test that unauthenticated reads fail, another account without members access is denied, publishing with an incorrect device token fails, and a valid family account reads only assigned devices. SQL syntax checks cannot replace these tests.

You can remove family access in SQL Editor:

```sql
-- Replace placeholders with real UUIDs before running.
delete from safenest_private.members
where device_id = 'DEVICE_UUID'::uuid and user_id = 'AUTH_USER_UUID'::uuid;
```

Device-disable and token-rotation examples are in `cloud/register_device.sql.example`.

## G. Troubleshooting

| Symptom | Check |
|---|---|
| Website says it is unconfigured | Run configure_web.py, then deploy web/ |
| Sign-in succeeds but access is denied | Check family UUID, device UUID, members row and enabled |
| Cloud bridge: Disconnected | Check HTTPS URL, public key, device token, successful schema SQL, and whether the school blocks the domain |
| Cloud website opens but remains Connection Lost | Confirm detection is running and snapshots.received_at updates. demo_status.py does not publish cloud data. |
| Local website fails on the same Wi-Fi | 127.0.0.1 is local to each computer. Check bind address, LAN IP, firewall and campus client isolation. |
| Remote video is not connected | Configure Edge/LiveKit following REMOTE_VIDEO.md and run the current main program |

Initial dependency installation, downloads and Vercel/Supabase setup require internet. Offline local operation does not. Phone access to cloud status across networks requires internet.

Official references (follow the actual dashboard options when deploying):
- https://supabase.com/docs/guides/database/functions
- https://supabase.com/docs/guides/database/postgres/row-level-security
- https://supabase.com/docs/guides/api/api-keys
- https://vercel.com/docs/builds/configure-a-build
- https://vercel.com/docs/project-configuration/vercel-json
