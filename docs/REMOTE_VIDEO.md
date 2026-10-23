# SafeNest authenticated remote-video deployment

This version includes real WebRTC publishing/subscription code. Your own Supabase/LiveKit configuration and cloud deployment are required; missing credentials show not connected. LiveKit API secrets never need to be shared with the phone or monitoring computer.

## 1. Verify the status bridge first

Follow `CLOUD_AND_VERCEL.md` for the base Supabase schema, device registration and family members access. The website should sign in and show real status. Do not delete an existing database or reregister existing devices.

The source inspected for this original video stage had conf/iou=0.5 and hip–ankle logic but did not call MonitorBridge. This stage added that integration; use fall_detection.py and monitor_bridge.py from the delivered project.

## 2. Add the database migration

Run all of `cloud/video_schema.sql` in Supabase SQL Editor. This incremental migration retains devices, members and status data while adding video-session leases, rate-limit tables and RPCs. There are no video-data columns or Storage buckets.

Run `cloud/schema.sql` first, then this migration. Existing projects with the base schema append only video_schema.sql at this stage.

Video sessions store only a random session UUID, family UUID, device UUID, identity and expiry. **JWTs, raw device tokens, images and video are not stored.**

## 3. Configure LiveKit

Create a project at https://cloud.livekit.io and obtain these values from Settings / Keys:

- LIVEKIT_URL: `wss://YOUR-PROJECT.livekit.cloud`
- LIVEKIT_API_KEY
- LIVEKIT_API_SECRET

Confirm automatic recording/Egress is disabled. This code calls no recording API. The project URL must exactly match the later computer-side public configuration, without a trailing path.

## 4. Configure two Supabase Edge Functions

The functions are in `supabase/functions/`:

- `video-token`: family issue / renew / release.
- `device-video-token`: monitoring-computer issue / sync.

In CMD at the project root:

```bat
copy supabase\.env.functions.example supabase\.env.functions
notepad supabase\.env.functions
```

Fill the five settings in the example:

```dotenv
LIVEKIT_URL=wss://YOUR_PROJECT.livekit.cloud
LIVEKIT_API_KEY=YOUR_LIVEKIT_KEY
LIVEKIT_API_SECRET=YOUR_LIVEKIT_SECRET
SAFENEST_SUPABASE_PUBLISHABLE_KEY=
SAFENEST_ALLOWED_ORIGINS=["https://YOUR_PROJECT.vercel.app"]
```

Each Origin must be the production site’s exact `https://domain`, without a path or trailing `/`. Wildcards are not allowed. Add another exact address to the JSON array for an additional family-site domain. Computer requests have no Origin and authenticate separately using the device secret. Supabase injects SUPABASE_URL automatically; it need not be repeated in the secrets file.

This file contains a real LiveKit secret. Keep it only on your computer/in Edge secrets. Never package it, commit it to Git or place it in Vercel’s web directory.

After installing Node.js LTS, run the following at the same project root. Replace every `YOUR_PROJECT_REF` with the Supabase project ref (between https:// and .supabase.co in Project URL):

```bat
npx supabase@2 login
npx supabase@2 secrets set --env-file supabase/.env.functions --project-ref cbokebwmuaraoirkehaq
npx supabase@2 functions deploy video-token --project-ref cbokebwmuaraoirkehaq --no-verify-jwt --use-api
npx supabase@2 functions deploy device-video-token --project-ref cbokebwmuaraoirkehaq --no-verify-jwt --use-api
```
npx supabase@2 secrets set --env-file supabase/.env.functions --project-ref YOUR_PROJECT_REF

`--use-api` bundles in the cloud, avoiding a local Docker build requirement. npx asks to install the CLI on first use. If an option is unsupported, check `npx supabase@2 --version` and `npx supabase@2 functions deploy --help` to confirm a 2.x CLI.

**Why gateway verify_jwt is disabled:** publishable keys and custom device secrets cannot rely on the gateway’s legacy JWT-key check. The family function internally validates the user with Supabase `auth.getUser(jwt)`, then calls read_monitor/video-lease RPCs using that same JWT. The device function checks the secret hash in the database. Missing authentication never receives a token. Do not remove these checks.

Functions handle short requests, short-lived token issuance and participant management. LiveKit provides WebRTC video and persistent signaling.

## 5. Configure and start the monitoring computer

Preserve the existing `.env` and add/update these three settings (LiveKit URL is public):

```dotenv
SAFENEST_VIDEO_ENABLED=1
LIVEKIT_URL=wss://YOUR_PROJECT.livekit.cloud
SAFENEST_VIDEO_EXTRA_ORIGINS=[]
```

Keep existing SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY / SAFENEST_DEVICE_ID / SAFENEST_DEVICE_TOKEN. **Do not put LiveKit API key/secret in the computer’s .env.**

With the original virtual environment activated, run at the new project root:

```bat
python -m pip install -r requirements-dashboard.txt
python -m pip install -r requirements-video.txt
python configure_web.py
python fall_detection.py
```

`livekit==1.1.20` is the Python RTC SDK verified at this stage. Do not install opencv-python-headless on Windows; it was used only for headless tests. Retain the original graphical opencv-python on the real computer.

The video thread connects to lightweight LiveKit signaling. Without family viewers it creates/sends no video track and encodes no images. Network work runs in a separate thread, so cloud failure does not stop YOLO/CSV/Windows sound.

## 6. Build the website and deploy to Vercel

The ZIP includes built `web/video-client.js` with its SDK bundled, ready for deployment. Rebuild only after modifying video_frontend source:

```bat
npm ci --prefix video_frontend
npm run build --prefix video_frontend
```

The website remains static. With the CLI:

```bat
cd web
npx vercel login
npx vercel --prod
```

Deploy only `web/`, using Framework=Other, no build command and output directory `.`. Do not put Python or a video server in Vercel Functions. For Git imports, Root Directory is also web.

`python configure_web.py` generates public config.js and adds exact Supabase HTTPS/LiveKit WSS/HTTPS hosts to CSP, plus media-src blob for video elements. It does not add arbitrary domain wildcards.

If LiveKit failover uses another regional signaling domain, the browser Console reports the CSP-blocked URL. After verifying it belongs to your project’s LiveKit endpoints, add its exact HTTPS/WSS origin to `.env` as the `SAFENEST_VIDEO_EXTRA_ORIGINS` JSON array, regenerate configuration and redeploy. Do not use `connect-src *`.

If you do not yet have a Vercel URL, deploy once to obtain the production domain, update Edge Function SAFENEST_ALLOWED_ORIGINS, run secrets set, then test video.

## 7. View on a phone

1. Run the updated main program on the monitoring computer; real status heartbeats must be working.
2. Open the Vercel HTTPS website on the phone and sign in to a family account with membership.
3. Click **View camera** to request the device-scoped token and join its room.
4. **Live** appears only after a real video frame decodes. Missing frames, denied authorization or disconnection never use sample footage as a substitute.
5. Stop, Sign out or backgrounding the phone disconnects media and clears the frame.

The phone needs no permission to use its own camera/microphone, and neither is started. Frames come from the monitoring computer with its skeleton annotations.

## 8. Sessions, revocation and rate limits

- At this original stage, server-generated room names use device UUID: safenest-<device UUID>. Later registered-camera rooms are described in MULTI_CAMERA_HOMES.md.
- Family identity: family-<user UUID>-<random session UUID>. Subscribe only, without publishing video/data.
- Device identity: device-<device UUID>. Publish camera source only; no subscription/data sending.
- Admission JWTs last 60 seconds and remain in memory, not browser storage, logs or database.
- Active family leases last 25 seconds and renew every 8 seconds, rechecking login and membership.
- Approximately every 3 seconds, the computer syncs authorized identities from the server. Edge uses LiveKit management APIs to remove expired/unauthorized participants; the computer also applies a track-subscription allowlist.
- After the last viewer leaves, the send loop starts stopping its track within approximately 0.1 seconds; network buffers may retain a brief tail.
- After membership deletion, the next device sync/browser renewal stops video under normal networking; revocation is not instantaneous. Publishing stops if authorization has not refreshed for 5 seconds. Abrupt browser closure with no release is removed by sync after the 25-second lease expires.
- The phone clears old video after over 2 seconds without a newly decoded frame. The sender does not repeat camera frames that are over 2 seconds old.
- At most 12 active family leases per device. Database limits: family issue 10/minute, renewal 30/minute, device issue 10/minute and sync 60/minute. Edge also applies coarse per-isolate inbound limiting; authorized calls are rate-limited by the database.
- Without viewers, video is not uploaded. Lightweight signaling/cloud calls may still incur costs; check your own LiveKit/Supabase quotas.

## 9. School Wi-Fi / TURN checks

This environment lacks your school network/cloud credentials and cannot validate an actual TURN path. Test computer on school Wi-Fi + phone on cellular data, then compare using a personal hotspot.

LiveKit Cloud provides TURN/TLS. If school Wi-Fi blocks UDP, outbound TCP 443 to the actual LiveKit Cloud TURN domain must be allowed. Do not open inbound school-router ports. If the outbound domain is blocked entirely, involve school IT or use your own network.

Inspect LiveKit session Dashboard network/ICE metrics for direct versus TURN relay. Successful status HTTPS does not prove video connectivity; the website does not automatically claim TURN passed.

## 10. Troubleshooting

| Symptom | Check |
|---|---|
| View camera disabled | Valid status; regenerate config.js and redeploy after SAFENEST_VIDEO_ENABLED=1 |
| Click does not connect | Both Edge Functions deployed, video_schema applied, exact Origin match, livekit installed and current main program running |
| Edge 401/403 | Valid family session, members/device enabled, and device token matching its registered hash |
| Edge 429 | Rate limit reached. Wait a minute; avoid repeated clicks or multiple processes for the same device. |
| Edge 503 | Missing Edge secrets, failed migration or unreachable LiveKit management API. Never log token/body values to debug. |
| Never reaches Live | School media blocking, blocked CSP endpoint, no fresh camera frames or authorization sync failure |
| Website loses connection | Local sound and CSV should continue. After network recovery, explicitly view video again. |

Official references:
- https://supabase.com/docs/guides/functions/auth-legacy-jwt
- https://supabase.com/docs/guides/functions/secrets
- https://supabase.com/docs/guides/functions/function-configuration
- https://docs.livekit.io/frontends/reference/tokens-grants/
- https://docs.livekit.io/reference/python/livekit/rtc/video_source.html
- https://docs.livekit.io/deploy/admin/firewall/
