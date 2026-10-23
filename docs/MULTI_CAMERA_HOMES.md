# Multi-camera Homes — current release

## Before/after architecture

The inspected baseline used `device_id` for the Home number, family members,
manager roles, notes, private Presence, detector snapshot and LiveKit room.
Camera setup selected a local OpenCV index/view profile; one detector owned
one capture, tracking history and context calibration. Video was already
on demand, with short viewer leases and publisher-side allowlists. Auth,
registration, recovery and invitation redemption are reused in this release.

| Object | Current responsibility |
| --- | --- |
| Home | Fixed Home number, editable display label, family access, notes and Presence |
| Camera | Random server Camera UUID, display name, expected-online flag, one view |
| Monitoring computer | Independent device UUID and private credential; runs one or more Camera workers |
| Person N | Temporary, camera-local track; no identity matching between cameras |

New private tables: `homes`, `home_devices`, `cameras`, `camera_snapshots`,
`camera_events`, `camera_setup_codes`, and a one-time migration marker.
All enable RLS and grant no direct client access.

For compatibility, a Home's internal UUID is its original device UUID.
`members`, `device_managers`, `care_notes`, invitations and Presence keep that
immutable authorization anchor. This is NOT the physical host for newly
paired computers. New camera read/video RPCs resolve their host to this Home
before checking the existing member relationship. No second Auth, membership
or Presence system is introduced. Home numbers are labels, never credentials.

The migration backfills exactly one Home/default Camera for each existing
host, preserving its number and all existing rows. A marker prevents migration
reruns from creating unintended Homes for future unpaired computers. New
registered computers only get a new Home when explicitly generating their
first Home claim code, or when a trusted operator inserts their first legacy
membership. Joining an existing Home creates only a host relationship.

A previously created/claimed Home cannot be automatically moved or merged.
Use a newly registered, unclaimed computer for pairing; recovery/migration of
existing Homes remains a trusted operator task. Do not delete the original
Home anchor device row. Its `enabled=false` retains the old whole-Home access
shutdown behavior. To retire just a camera, use its expectation setting;
rotate an original host's token if it is compromised. A non-anchor host can be
disabled independently through the existing trusted device administration.

## Required Supabase changes

For an existing installation already at the preceding website release, run
ONLY `cloud/multi_camera_homes.sql` in SQL Editor. Full fresh-install order:

1. `cloud/schema.sql`
2. `cloud/video_schema.sql`
3. `cloud/family_schema.sql`
4. `cloud/website_improvements.sql`
5. `cloud/context_monitoring.sql`
6. `cloud/family_management.sql`
7. `cloud/device_claim.sql`
8. `cloud/care_note_management.sql`
9. `cloud/home_identity.sql`
10. `cloud/multi_camera_homes.sql`

Do not rerun older migrations after the newest one; older files contain old
RPC implementations. The new migration itself can be rerun without reassigning
Home/Camera IDs or replacing stored events. Sequence gaps are permitted.

Redeploy BOTH existing Edge Functions with the updated shared code, using your
existing Supabase CLI session and project reference:

```bat
npx supabase@2 functions deploy video-token --project-ref YOUR_PROJECT_REF --no-verify-jwt --use-api
npx supabase@2 functions deploy device-video-token --project-ref YOUR_PROJECT_REF --no-verify-jwt --use-api
```

`verify_jwt=false` is the existing design: the handlers themselves verify the
Auth user/device secret and checked RPC results before signing anything.
Keep the existing server-side LiveKit secrets and exact allowed website
Origins. No new secret is needed and none belongs in `web/`.

Realtime stays on the existing private family Presence configuration. No new
public channel or publication is needed. The camera inventory and events use
checked RPC polling, not public Realtime tables. Password recovery URL/email
settings from the previous release continue unchanged.

## Existing first computer / first Home

1. Stop the old detector with Q. Back up the working project, preserving `.env`,
   `web/config.js`, model weights, settings, calibration and logs.
2. Apply this update. Use the same working Windows virtual environment.
3. Open `Start_Camera_Setup.cmd`. Existing Home IDs/members already exist after
   migration. An entirely new FIRST computer can use **Generate device claim
   code** and the existing family website claim workflow to create/claim a Home.
4. Select the local camera index, view profile, room/Home display label and
   Camera name. Save settings, then **Register selected camera to this Home**.
5. Use **Preview & calibrate** to inspect the actual picture and bed outline.
   Closing/reopening a camera always requires live confirmation again.
6. **Start monitoring** starts the selected registered Camera. Direct
   `python fall_detection.py` also selects its registered Camera ID.

The default Camera can update the Home display label through explicit
registration on the first computer. Other cameras/computers change their own
Camera names, not the shared Home label. Merely receiving periodic detector
metadata from different cameras does not rename the Home.

Old, unregistered default publishers remain compatible via their legacy room;
the website recognizes that mode. Registering a Camera switches it to its
Camera-scoped room on the next detector restart. Restart that detector after
registration. Do not leave two copies of the same Camera publisher running.

## More cameras on the same computer

1. Stop its running detector(s).
2. Select a different real OpenCV camera index and give it its own name and view
   profile. Save, register and preview/calibrate it.
3. Repeat for each locally connected camera. No additional family invitation
   or camera pairing code is needed on an already paired computer.
4. Choose **Start all registered cameras**. A supervisor starts one independent
   detector process per Camera. Each process owns its capture/model/tracker,
   context, confirmation timers, video publisher and calibration state.
5. Use Q in each live window to stop that camera. Closing setup leaves active
   detection/alarms running. The supervisor exits after all workers exit;
   Ctrl+C in its console stops its child workers.

The project capture lease blocks scanning/editing during a supervised run.
One physical index cannot be registered twice under active local profiles.
If Windows renumbers cameras, inspect the actual preview, register the new
source/profile and disable the retired source in Home management. OpenCV
indices do not prove hardware identity. No model is retrained or downloaded.

The primary/default Camera keeps `events.csv` and `context_events.jsonl`.
Additional Cameras use `camera_logs/<device UUID>/<Camera UUID>/`. Original
files remain untouched. New event timestamps include the host UTC offset;
legacy rows without offsets are still accepted as supplied (the database
session timezone is used to sort those legacy timestamps). Set host clocks
and timezones correctly; no reliable cross-host ordering can be reconstructed
for old ambiguous timestamps without extra information.

Registered calibration geometry is under
`camera_profiles/cameras/<Camera UUID>/<source-profile key>.json`. Existing
matching device/profile geometry is copied once, not removed, and remains
unverified until live confirmation. Background reference images stay in RAM.

## Another computer joining this Home

1. Give the additional monitoring computer its OWN new device UUID/token and
   complete existing device registration with the trusted SQL template and
   local `.env`. Do not copy the first computer's device identity/credential.
2. On the family website, an existing Home manager opens that Home →
   **Manage family → Generate camera setup code**.
3. Copy the code once. It expires within 10 minutes and can pair one computer
   only. The manager can revoke unused codes in the same modal. Names/code
   hashes are not identity credentials and no secret token reaches the browser.
4. On the new computer, **Camera setup → Join an existing Home**: paste the
   setup code and choose **Join Home with camera setup code**. Do this BEFORE
   generating a new-Home claim code. Pairing clears the input immediately.
5. Refresh Home ID; it must match the original Home. Select/save/register the
   real camera(s), preview/calibrate, then start monitoring.
6. Existing family members automatically see these cameras in the same Home.
   They do not enter a new invitation for each camera and no extra Home appears.

Setup codes are random, hash-only, single-use, manager-authorized and limited
to 5 creations/user/minute, 10 active codes/Home. Redemption requires the exact
registered device credential and allows 10 attempts/device/minute. Invalid,
expired, revoked, consumed or already-assigned-device cases use generic errors.
The server rechecks the issuing manager's current role on redemption.

`camera_sources.json` is a device-scoped local Camera registry, not authority
for family access. It contains no passwords, tokens or pairing codes. The
server validates every publication, list, lease and metadata request. Home ID
refresh uses device authentication; a failed/other-device response is never
shown as a new confirmed Home. No disk cache is used as the setup Home label.

## Family website behavior

Select an already-authorized Home. Every associated Camera appears
individually with a safe name and state. **Select camera** changes the selected
view; **View camera** explicitly starts its one live connection. Selecting a
camera does not automatically start it. `+ Add Home` is not a camera action.
The existing invitation entry remains solely for joining a genuinely different
Home.

There is one video element, one notes form and one Home Presence controller.
Camera switches stop old video, recording and PiP and clear old frame/context
and temporary clips, while Home notes/drafts and Presence stay in their Home.
Switching Home/account clears all Home-specific lists, notes, drafts, media
and Presence before loading another Home. Server denial closes access and
reloads authorized Homes. Polling is about 3 seconds; Home capabilities are
rechecked every 15 seconds. No old token grants new access after revocation.

Home summary is a UI summary, never a replacement AI state: a current suspected
fall wins; offline/stale expected cameras make overall normal status
unavailable; all expected cameras must be working and Normal for Home Normal;
No Person requires all working expected cameras to report No Person. Mixed
Normal/No Person is uncertain. Disabled Cameras remain visible but do not count
as expected. Their history is kept. Manager **Disable expectation** blocks video
and cloud publication for that Camera; it does not remotely stop local AI.

Home notes, family invitations and online members are shared at Home scope.
Names come from the existing checked server roster/Auth path. Notes keep
server-derived authors and existing English delete confirmations. Replay
shows at most the Home's 10 newest timestamp-sorted events with source Camera
names. New `camera_events` stores received metadata append-only; no cloud
recording is added. The device still sends only its recent 30 transitions per
snapshot, so long offline periods can leave missing transitions; original
local logs remain the complete local record.

## Video/security and limitations

New camera rooms are `safenest-camera-<Camera UUID>` with distinct publishers.
Both camera and device association are checked by RPC before issuing tokens.
Camera viewer leases retain 25 seconds/8-second renewal, device allowlists
expire within 5 seconds, and device sync is about 3 seconds. Membership
revocation removes all host/camera leases; Presence rotates its private topic.
This does not erase already received/downloaded data or promise instantaneous
network propagation. Legacy device-room lease renewals cannot renew a new
camera-room lease. UI hints do not grant permission.

No new dependency. The pinned browser bundle is included. Contributors rebuild:

```bat
npm ci --prefix video_frontend
npm run build --prefix video_frontend
```

Publish ONLY `web/` using your existing Vercel workflow after the SQL and Edge
Function changes. `web/config.js` and its existing public CSP settings should
be preserved. No deployment was performed by this update.

Currently supported: real local integer OpenCV inputs. `source_type` is
explicitly local; there is NO RTSP URL/password field, ONVIF endpoint, PTZ
control or network CCTV adapter yet. Future adapters must run on the monitoring
computer and protect credentials locally. The family page cannot scan/open a
family member's webcam. One selected live stream is supported; there is no
all-stream live grid. Each Camera worker loads the existing pose model,
therefore CPU/GPU/RAM/USB bandwidth limit practical concurrency. Start testing
with two cameras; no FPS or maximum-camera performance claim is made.

Local Windows sound is independent per Camera episode. Different views of the
same fall may produce multiple source events/sounds; no cross-camera person
identity or event deduplication is claimed. Screenshots/recordings stay local.
PiP/MediaRecorder behavior remains browser-dependent. Tests use synthetic
inputs, JSDOM and PGlite; real Windows/OpenCV/Tk/LiveKit/Supabase and browser
visual checks remain manual. No real camera, email, account or deployment was
used in automatic tests.
