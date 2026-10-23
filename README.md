# SafeNest AI — Multi-person monitoring and shared family care

## 2026-10-23 English source and documentation edition

All Chinese prose in the README, project guides, Python comments and console messages has been translated into English. The Unicode note-length test uses an equivalent Unicode escape, preserving its multibyte test case. Existing configuration values, SQL migrations, detection logic, thresholds, tracking, calibration behavior and alarms are unchanged.

Checks for this edition:

- All 150 original source-package files are retained, with no Chinese characters remaining in their text.
- All Python sources compile. Their executable ASTs match the 2026-10-22 baseline except for four translated console messages in `live_pose.py`.
- Markdown link targets, code fences and executable command blocks are preserved.
- `python -m unittest discover -s tests -p "test_*.py"`: **207 passed, 0 failed**.
- `npm --prefix video_frontend test`: **273 passed, 0 failed, 0 skipped**.

No Supabase, LiveKit or Vercel account was accessed, no real emails or notifications were sent, and nothing was deployed. Existing public project configuration is preserved; review deployment-specific values before sharing a submission copy. Historical release notes below retain their stage-specific test results and limitations.

## 2026-10-22 Local bed-zone Reset fix (latest functional update)

- In the local camera window, press **R** or click **Reset [R]** to immediately clear the current camera/view’s bed outline, draft points and saved geometry, showing **Needs calibration**. Mark 3–12 new points and press **Enter** to save. Reopening preview or monitoring does not restore the old outline.
- Verified outlines are green; unsaved drafts are yellow. Confirmed view changes still invalidate old calibration and display red. Reset is no longer treated as camera movement. After each restart, a newly saved outline still requires visual checking and confirmation; it does not automatically become Verified.
- Clearing writes an empty record only at the current calibration path, preventing repeated camera registration from reimporting legacy outlines. Other cameras, configuration, models, logs and events are unaffected. Original fall rules, thresholds, tracking, bed-zone decisions, ViewGuard and sound remain unchanged.
- Exit the old preview/monitor, back up the project and apply the update at the existing project root, preserving `.env`, models, settings and logs. **No Supabase SQL, cloud settings, Vercel publication or new dependencies are required.** Nothing was deployed.

See **[docs/BED_ZONE_RESET.md](docs/BED_ZONE_RESET.md)** for controls and test details.

**Acceptance: all 9 new Reset-specific tests and all 207 Python tests passed.** The ASTs of `pose_features`, `update_status`, polygon validation and ViewGuard are unchanged; seven other detection/state/video/setup core files were byte-identical at this stage. Automated tests use no real camera or model. Windows key focus and rendering still require local checks. This functional update changed no website files and did not rerun website/database tests.

## 2026-10-19 Password recovery, phone-notification diagnostics and Settings dialog fixes (previous stage)

- **Forgot password?** separates request, verification, new-password, failure and completion screens. Failed links offer **Enter email to request another link**. A `type=recovery` access token in the default Supabase callback is verified with the same Supabase Auth service before its account may update a password. Another stored account’s session is never borrowed. The callback URL is cleaned after processing.
- **Manual password-recovery setup:** in Supabase **Authentication → URL Configuration**, set **Site URL** to `https://elderlyfall.vercel.app` and add the exact **Redirect URL** `https://elderlyfall.vercel.app/?recovery=1`. Keep the existing default **Reset password** template and SMTP; this fix does not require Custom SMTP or template editing. Request a fresh email after publishing. Expired/used links need replacement. `cloud/reset_password_email.html.example` is an optional token-hash template only if template editing is available and that route is desired.
- **Browser notifications** separately report permission, phone/browser subscription, service configuration, unknown background sending and unconfirmed phone display. Alerts also show a notification summary. **Check notification setup** only queries; it requests no permission and sends nothing. `Subscription saved; delivery has not been verified` does not mean a phone received it. Each family member must subscribe on their own phone/browser/site origin. Logout cancels that browser’s subscription; old alerts are not backfilled.
- **Camera Settings** is now a backdrop dialog, centered on desktop and a bottom panel on phones, supporting Close, Esc, focus trapping/return and background scroll lock. Notification settings reuse it without reconnecting video or Presence. Physical camera selection and bed calibration remain in local Camera setup.
- **No new migration, secrets or dependencies.** Existing `fall_notifications.sql`, push functions/VAPID/Vault/background wake-up remain prerequisites. Completed installations need not rerun old SQL. Enhanced safe diagnostics in `family-push-config` can be redeployed manually with existing configuration. A first Push installation still needs the entire previous-stage setup; publishing the website cannot install server sending. New **`cloud/diagnose_fall_push.sql.example`** is read-only and sends nothing.

**Stage tests: all 196 Python and 272 website/database tests passed; frontend build and local Edge bundling checks passed.** Nothing was deployed, no cloud settings changed, and no email/push was sent. Real Gmail, Supabase, Vercel Service Worker, phone systems and responsive appearance still need manual acceptance. See **[docs/RECOVERY_PUSH_SETTINGS.md](docs/RECOVERY_PUSH_SETTINGS.md)** and **[docs/RECOVERY_PUSH_SETTINGS_ACCEPTANCE.md](docs/RECOVERY_PUSH_SETTINGS_ACCEPTANCE.md)**. Preserve configuration, models, calibration and logs.

## 2026-10-19 Family alerts, shared acknowledgements and optional Web Push (previous stage)

- **Family safety alerts**: the server persistently records each distinct suspected-fall alert, showing the selected Home’s latest 30 and unviewed count. AI events still show the latest 10 without deleting history.
- **Acknowledge** now records the authenticated account’s safe nickname/time server-side and shares it with family. It does not change detection state, events or local sound, or confirm safety. The current alert card must match a server record before acknowledgement.
- **Settings → Browser notifications**: permission is requested only after the family member clicks, with a per-Home/current-browser subscription. The server selects recipients from current membership; revocation cancels pending notifications and permission is rechecked before sending.
- Push contains generic text and a random deduplication key, without screenshots, video, identities or device credentials. Clicking revalidates the account/Home; camera viewing remains manual. Closing the page preserves subscription; logout cancels this browser’s subscription. Uncertain network outcomes are not blindly retried.
- **No email, SMS, WhatsApp, automatic calls, escalation or cloud recordings.** Nothing was deployed and no real notification was sent. Detection, thresholds, tracking, calibration, sound and video/Presence core were retained.

**Manual upgrade:** back up and apply the update, preserving configuration, models, calibration and logs. Run new **`cloud/fall_notifications.sql`** after `multi_camera_homes.sql`, then publish `web/` yourself. In-app alerts do not require Push configuration. Web Push additionally needs private local VAPID generation, `family-push-config` / `dispatch-fall-push` deployment, Vault and pg_net/Cron setup, and permission on each family browser. The two existing video functions need no redeployment for this stage.

See **[docs/FAMILY_NOTIFICATIONS.md](docs/FAMILY_NOTIFICATIONS.md)** for exact SQL order, English UI behavior, secret generation, manual Supabase/Vercel steps, browser limits and revocation boundaries. **All 196 Python and 250 website/database tests passed** at this stage, alongside frontend build and new Edge syntax checks. Details: **[docs/NOTIFICATION_ACCEPTANCE.md](docs/NOTIFICATION_ACCEPTANCE.md)**. Below are historical records; earlier page-only acknowledgement/no-background-push descriptions are superseded by this section.

## 2026-10-19 Fall prompts and factual storage information (previous stage)

- An inline English **Suspected Fall — Please check** prompt beside the camera lists cameras currently reporting suspected falls, Home/room, latest observation time and temporary Person IDs actually provided by context. The latest recorded suspected-fall event time is shown separately. Historical events do not create a live alert or identify the current person.
- At this historical stage, **Acknowledge** marked viewed in page memory only, without notifying others, writing the database, changing AI state/events or stopping local sound. New event/person evidence, offline recovery or scope changes reset it. **View camera** remains explicit and reuses existing authorization/single-stream LiveKit without automatically connecting every camera.
- **Settings & privacy → Storage & downloads** shows sizes of screenshots, completed clips and recording chunks actually retained by this page, not disk capacity, whole-browser memory or cloud storage. Filenames and Replay clips identify the current Home/Camera. Screenshots/recordings are not uploaded; download them to retain them.
- Page exit clears media, alerts and old content and invalidates late requests. Return reloads permissions/data without auto-reconnecting video. Ordinary disconnection on the same camera retains completed or normally stopped clips for download. Home/Camera changes, refresh and logout clear temporary media. Downloaded files are outside page control.
- This stage added no future-action prediction, automatic calls/SMS/email, background push, cloud recording, microSD formatting or voice control. It provides no invented capacity, fake switches or remote disk operations.

**Upgrade for this stage:** back up and merge the update into the previous multi-camera project, preserving `.env`, `web/config.js`, models, settings, bed zones and logs, then publish `web/` manually. **No new SQL, Supabase setting, Edge deployment or dependency is required for this stage.** If multi-camera setup is incomplete, first follow the next section. Restart the monitor normally when convenient if using its built-in local website, so its static allowlist includes new modules. Cloud-page-only users need not restart detection for this change.

**Stage tests: all 196 Python and 223 website/database tests passed; frontend build succeeded.** No deployment or notification sending occurred. **[docs/ALERT_STORAGE.md](docs/ALERT_STORAGE.md)** covers storage locations, acknowledgement meaning, files and real-device limits. Earlier versions follow.

## 2026-10-18 One Home, multiple monitoring computers and cameras (previous stage)

After selecting an authorized Home, the family website automatically lists every linked Camera with independent state. No separate family invitation is needed per camera, and cameras are not separate Homes. Select one and click **View camera**; this version views one stream at a time. Home aggregate state and latest 10 source-labeled events are added. Notes, online family and permissions remain Home-scoped.

Local **Camera setup** adds one-time pairing into an existing Home, registration of the selected actual camera and **Start all registered cameras**. Each camera runs a separate process reusing detection, tracking, calibration and sound. Different computers keep independent device credentials. Managers use the existing **Manage family** dialog to generate/revoke pairing codes and enable/disable camera expectation. No remote physical-camera control is added.

**Upgrade steps:**

1. Preserve `.env`, `web/config.js`, models, settings, bed zones and logs, then apply the update.
2. In SQL Editor, run **`cloud/multi_camera_homes.sql`** after `cloud/home_identity.sql`. Do not rerun old migrations in reverse order. Existing numbers, members, managers and history are retained.
3. Redeploy `video-token` and `device-video-token` with the original configuration, then publish `web/` manually. The rebuilt browser client is included; no new dependency is needed.
4. Stop the original monitoring computer, open Camera setup, save and **Register selected camera to this Home**, check preview, then restart. Register additional local cameras individually before **Start all registered cameras**.
5. Give a new computer independent credentials through existing device registration, then join the existing Home with the manager’s **camera setup code** and register its cameras. Do not generate a new-Home claim code for that computer.

**Full procedure, exact SQL order, compatibility and limitations: [docs/MULTI_CAMERA_HOMES.md](docs/MULTI_CAMERA_HOMES.md). Files/tests: [docs/MULTI_CAMERA_ACCEPTANCE.md](docs/MULTI_CAMERA_ACCEPTANCE.md).** No deployment or emails. Only real local OpenCV cameras are supported; RTSP/ONVIF/PTZ and simultaneous multi-stream viewing are not implemented. Later sections are historical; follow the current guides above.


## 2026-10-18 Fixed Home numbers, recovery and monitoring layout (previous stage)

Five improvements implemented with English UI:

1. **Forgot password?**: recovery email → verified recovery session → new password/confirmation → return to sign-in. Recovery tokens stay in memory; old-account monitoring/video/Presence are cleared rather than borrowing another account’s saved login.
2. **Manage family**: in-page dialog preserving the monitoring page/video, with Close, Esc, focus trapping/return and existing server-side manager checks.
3. Desktop camera and **Shared care notes** use approximately 2:1 columns. Small screens use **Care notes** to expand the same panel and reuse posting/deletion.
4. **Family online** moves into the camera title bar, showing count, a short nickname and +N. Click for the full authorized roster; disconnects do not leave old names definitely online.
5. Fixed **Home-001**-style numbers are database-generated and separate from editable room labels. Dashboard, monitoring, management and local setup show the same number, retaining device_id and authorization relationships.

**Manual update:** merge files while preserving `.env`, models, web/config.js, calibration and logs. Run **`cloud/home_identity.sql`** after `care_note_management.sql` in Supabase SQL Editor. In Authentication URL Configuration, set production Site URL and the exact recovery callback, such as `https://elderlyfall.vercel.app/?recovery=1`, and check Reset password/SMTP settings. Follow the latest recovery fix above for template requirements: verified default recovery callbacks are supported, and `cloud/reset_password_email.html.example` is optional. Publish the updated `web/` manually and reopen local Camera setup to check the number.

No new dependencies, SDK build or Edge deployment are required for this stage. Detection, tracking, bed verification, thresholds, model parameters, local alarms and media-core files are retained. No deployment or email sending occurred.

See **[docs/WEBSITE_FIVE_IMPROVEMENTS.md](docs/WEBSITE_FIVE_IMPROVEMENTS.md)** for files, SQL order, templates, browser/local limits and acceptance. **All 184 Python and 195 frontend/database tests passed** using mocks/local SQL. Real Windows, SMTP, cloud connections and appearance need local acceptance; browser download failed in that stage’s environment, so no screenshot or real-browser visual check was claimed.


## 2026-10-18 Care-note management and integrated acceptance (previous stage)

- Notes show server-derived safe author nicknames and times. Email-like, UUID-like or missing names use **Family member**. Nicknames are not verified identities; names/bodies render as plain text.
- **Delete my note** deletes the caller’s note. Existing managers can use **Delete note · Device manager** for that device’s notes. The English confirmation defaults focus to **Cancel**; deletion sends only after confirmation, with server permission checks each time.
- Deletion affects only the specified note, not AI status, detection events, video or local alarms. It is permanent; undo, trash and edit history are not provided.
- Device switching clears old notes, events, video and confirmations before stopping old video/Presence. Late old-device responses cannot populate the new page.

**Update:** preserve `.env`, models, public website configuration, bed zones and logs, then merge the update. Run **`cloud/care_note_management.sql`** after installed `device_claim.sql` in SQL Editor and publish the updated `web/` manually. No new secrets, Realtime settings, Edge deployment or SDK build are required; nothing was deployed. This stage changes no Python runtime files and needs no detection restart/recalibration.

**Stage acceptance: all 180 Python and 181 frontend/database tests passed.** Checks covered authorized devices, local Camera setup, calibration isolation, claims, invitation/binding restoration/revocation, on-demand video, latest 10 events and original detection. Nineteen related core files were byte-identical to the previous version. Mocks, synthetic data and local SQL were used; Windows hardware/cameras and real cloud networks still require validation.

See **[docs/CARE_NOTES_ACCEPTANCE.md](docs/CARE_NOTES_ACCEPTANCE.md)** for files, SQL order, commands, limits and manual acceptance. Following sections are earlier records.

## 2026-10-18 Claiming Home management locally (previous stage)

For an **unclaimed new device**, manually entering a family Auth UUID is no longer necessary:

1. Run **`cloud/device_claim.sql`** after installed `family_management.sql` in SQL Editor. Do not rerun old migrations in reverse order.
2. On the monitoring computer, open **Start_Camera_Setup.cmd → Generate device claim code**. The device must be registered and local configuration valid; stop preview/detection first. The claim lasts **10 minutes and can be successfully redeemed once**.
3. Sign in on the family website → **Set up a monitoring device** → enter claim code → **Become device manager**. Select that Home → **Open monitoring → Manage family** to invite relatives.
4. Refresh, later logins and another computer restore manager/device bindings from Supabase. Ordinary family invitations grant viewing only. Merely clicking Camera setup neither grants management nor opens the family member’s own camera.

Only claim hashes are stored. Local setup can revoke/regenerate a claim. A device with an existing manager cannot be claimed again, even after the last manager is removed. A trusted project owner still handles account recovery with the original SQL template.

**Full steps, files, failures and limits: [docs/DEVICE_CLAIM.md](docs/DEVICE_CLAIM.md).** All **180 Python and 163 frontend/database tests passed** at this stage, without new dependencies or deployment. Detection, bed zones, tracking, sound and video-core files were unchanged. Earlier records follow.

## 2026-10-18 Family invitation and binding management (previous stage)

A device-authorized English **Manage family** panel lets managers generate expiring/quota-limited invitations, list members and revoke invitations/ordinary family bindings. Existing follows restore from the backend without reentering codes. Device switching, video, notes and online family reuse existing systems.

**Existing installations must first:**

1. Run `cloud/family_management.sql` after existing migrations such as `context_monitoring.sql` in Supabase SQL Editor. Do not overwrite new RPCs by rerunning old migrations.
2. Use the latest claim flow above for first ownership. For account recovery/additional managers on existing devices, a trusted project owner verifies identity and uses `cloud/grant_device_manager.sql.example`. Ordinary family do not automatically become managers. No secrets need to be provided to the assistant or placed in the website.
3. Update the website, sign in → **Choose home / Refresh list** → select device → **Open monitoring → Manage family**. Invitations default to 7 days and 5 new members, with plaintext shown only on successful creation.

**Revoking a member also disables all still-open invitations for that device**, preventing rejoining with an old code. A clear confirmation precedes it. Other devices’ bindings, historical notes and events remain. The project owner adjusts manager/self roles through SQL Editor.

Server-side manager relationships and strict RPC checks prevent escalation through button changes or Auth nickname/metadata edits. Existing RLS, private Presence and LiveKit authorization remain. Connected video is revoked through short authorization checks, without claiming to recall already received content.

**English guide, SQL order, boundaries, files and tests: [docs/FAMILY_MANAGEMENT.md](docs/FAMILY_MANAGEMENT.md).** Stage results: **169** Python and **147** website/database tests passed. No new dependency/SDK build, no deployment. Publish manually after SQL. This stage does not change detection, calibration, tracking, model parameters or local alarms.

## 2026-10-18 Visual local Device setup (previous stage)

On the **Windows monitoring computer**, double-click **Start_Camera_Setup.cmd** at the project root. The English setup window provides real camera scanning/preview, room/camera naming, bed drawing and vertex adjustment, without editing command-line arguments.

1. Press **Q** to exit old detection. Open setup, click **Scan cameras**, select an index and fill **View profile / Room name / Camera name**.
2. **Preview & calibrate** shows the real frame. **AI NOT RUNNING** means no monitoring/alarms at this step. C draws, E adjusts vertices, B / Enter confirms, R clears the current camera’s saved bed zone for remarking, and Q closes preview. Keep people out while confirming background.
3. **Start monitoring** launches the original detector. On reopening the camera, saved outlines always require confirmation in the current live window; verified status is not restored from disk.
4. During detection, use its existing calibration controls. Local locks coordinate setup, preview and detector to avoid opening the same project’s camera twice. Stop detection before changing settings. Closing setup does not stop an already running detector or alarm.

Names are saved in local `device_settings.json`. Bed zones are isolated under `camera_profiles/devices/` by **device_id (or local identity if unconfigured), camera index and view profile**. Raw background references remain in memory without image saving/upload. Legacy outlines without device association are retained as files but require one-time redrawing after upgrade. Hardware reconnection can change camera indices; check the actual preview.

Family access remains **Family Dashboard → Followed homes → Open monitoring**, with on-demand video. Open **Add a home / device** only for a new binding. Accounts, devices, room labels and temporary Person IDs remain distinct; the website has no remote camera-setup permission.

**No SQL, credential changes or SDK rebuild were needed at this stage; nothing was deployed.** Fall functions, thresholds, model parameters, tracking/context, sound and cloud authorization are retained. Local setup selects only camera source, labels and calibration files.

English guide, files, privacy and hardware limits: [docs/DEVICE_SETUP.md](docs/DEVICE_SETUP.md). Entry boundaries: [docs/FAMILY_DEVICE_ENTRY.md](docs/FAMILY_DEVICE_ENTRY.md). Stage tests: **169** Python and **122** frontend/database passed; real Windows UI/hardware still need local acceptance.

The launcher prefers the project’s `.venv\Scripts\python.exe`. If the working environment is elsewhere, activate it and run `python camera_setup.py`; do not reinstall working PyTorch. The GUI requires tkinter and graphical OpenCV. `python fall_detection.py` remains available and uses the same saved settings.

## 2026-10-18 Bed-edge entry and separate risk sources v5 (previous stage)

An approximately 18-second recording showed calibration remaining verified while a person lying inside retained earlier outside risk. The fix separates boundary from outside instead of latching both as outside risk. Partial shoulder/hip bed-edge overlap produces `Check Person`; pure boundary risk clears inside. `Resting in Bed` requires complete, continuous, smooth entry with both hips inside, ending with both shoulders/hips inside and approximately 3 seconds stable. Missing history or fast lying down still requests a check rather than confirming rest.

Record the first time/location of `boundary`, `rotation`, `descent`, `outside`, `exit` and original-pose fallback `pose` separately. Pure rotation is not actual descent. Observed descent, suspected all-shoulders/hips outside posture and hips sliding out after rest retain priority despite later inside positioning/confirmation. Current Bed location is separate from historical risk. Local preview adds `Evidence:` and existing context_events.jsonl retains full sources. Version 4 background verification remains.

**[Update/test guide](docs/BED_REST_FIX.md)**: apply the cumulative local patch, stop/restart and confirm the bed zone. All 138 Python and 116 website/database tests passed. No new dependency, SQL, website publication or deployment. Synthetic trajectories cover the observed recording sequence without rerunning its model. Ambiguous boundary locations or bed incidents missing their sequence may produce only Check Person and require an actual check. Original posture functions/thresholds, 1.5-second timer, prediction parameters, association and sound call remain; final-state/sound conditions follow the context rules above.

## 2026-10-18 Independent view-invalidation checks v4

Feedback showed the bed outline turning from blue to red before anyone entered. Screenshots showed `view changed; recalibrate`, `Bed: unknown` and a separate person reason `Rapid descent/posture change`. This stage strengthens evidence before red: consistent original-position background appearance retains verified; a proposed transformation requires distributed background-tile appearance support and significantly improved alignment, followed by two consistent checks. Lighting changes or unsupported erroneous transformations do not directly mean camera movement; insufficient evidence stays uncertain rather than falsely verified.

The preview adds `Background: identity ...` or `Shift ...; inliers ...; alignment ...; checks ...`. Confirmed invalidation evidence is retained in local calibration events. Stale Outline confirmed text is removed on failure, and diagnostics wrap on small frames. A single low-resolution background reference excluding bed/people stays in RAM, without disk saving/upload.

**[Update/demonstration guide](docs/BED_REST_FIX.md)**: apply the local patch, restart, confirm the outline and observe an empty frame for 5–10 seconds before entering and smoothly lying down. If it turns red while empty, retain/check displacement metrics and do not test rest with invalid calibration. No new SQL/dependencies/website publication. All 120 Python and 116 website/database tests passed; nothing was deployed. Rapid posture-change logic, fall algorithm and thresholds were unchanged. Fast ordinary lying down is not guaranteed to classify as rest; real continuous-video validation remains necessary.

## 2026-10-17 Bed-zone occlusion and false-positive correction v3

Addresses lying on the bed → yellow outline → horizontal-pose fall fallback. Insufficient background does not mean movement; calibration separates verified, occluded, possible movement and view changed. Occlusion retains a **low-confidence location estimate for at most 2 seconds**, never sufficient for rest; afterward location remains unknown. The same track previously inside without observed abnormal risk produces `Check Person`, not a new fall solely because verification pauses or the grace period expires. Observed descent/outside risk or another person’s suspected fall retains priority. Confirmed movement disables old calibration.

Background recovery does not restore rest automatically; observe the full entry again. Verification fluctuations interrupt rest evidence without clearing motion history, so rapid descent is still evaluated during occlusion. The local preview shows original pose → final state, bed-zone evidence and calibration reasons. Historical colors were blue for verified, yellow for unconfirmed/uncertain and red for confirmed view invalidation. Original posture functions, thresholds, 1.5-second timing, model and Windows sound call remain; final-state/sound conditions follow the context rules above.

B and Enter both save a draft while drawing and confirm an existing outline otherwise. The top **Confirm [B / Enter]** control does the same with textual feedback. They confirm the bed zone, not the person’s health.

**Update, tests and demonstration: [docs/BED_REST_FIX.md](docs/BED_REST_FIX.md).** Restart and reconfirm after applying local files. No new SQL, secrets, dependencies or website publication. `Check Person` requires a real check and does not confirm safety. Bed incidents missing their sequence or prolonged unverifiable bed views may have no automatic fall sound, a tradeoff for fewer static-lying false positives. Earlier statements that the original suspected-fall result always overrides rest are superseded.

## 2026-10-17 Mobile monitoring page

The English mobile-first page adds **Camera screenshots, Record manual video, Replay local clips, Settings** and a textual state legend. It reuses status, multi-person skeleton video, PiP, latest 10 events, family authorization, notes and online presence.

**Feature mapping, usage and limits: [docs/MOBILE_MONITOR.md](docs/MOBILE_MONITOR.md)**. Files/verification: [docs/MOBILE_CHANGES.md](docs/MOBILE_CHANGES.md).

No new Supabase SQL, secrets or Edge deployment were required; preserve configuration. Screenshots/recording stay in the current browser for local download without upload. Recording requires a supported LiveKit stream/browser; local JPEG preview supports screenshots only. Switching monitors, logout or refresh clears undownloaded clips; backgrounding stops recording. PTZ/prediction models are not configured, so no fake switches appear. Detection, tracking, context states and local sound were unchanged. **Nothing was deployed.**

## 2026-10-16 Context monitoring

Adds local polygon bed calibration, camera-view checks, per-person motion history, resting/check-person/tracking-lost states and website person explanations. **Usage/limits: [docs/CONTEXT_MONITORING.md](docs/CONTEXT_MONITORING.md)**; files/tests: [docs/CONTEXT_CHANGES.md](docs/CONTEXT_CHANGES.md).

Existing cloud users append **`cloud/context_monitoring.sql`** after earlier migrations and use the delivered Python/website files. Local-only use needs no SQL. No new dependency, LiveKit credential change or Edge redeployment is needed. Website publication remains manual; nothing was deployed.

After `python fall_detection.py`, click **Calibrate room** above the camera or press **C**, click the boundary in order and press **Enter** to save. Right-click undoes; Esc cancels. On each startup, visually check and press **B** to confirm, or C to redraw. **R** persistently clears the current bed zone for remarking. Recalibrate after camera movement; inference continues during calibration.

**Historical limitation, now addressed:** the original horizontal-pose rules previously overrode rest and sounded even for lying in bed. The current version adds strict continuous-entry evidence; see the latest fix above for conditions and remaining limits.

The current main program retains observed confirmation time and pauses invisible time during brief occlusion, rather than treating a missed detection as recovery or clearing the timer. Earlier statements about occlusion resets/no new SQL are historical; follow this section and the context guide.

## 2026-10-16 Website update

Adds camera PiP/draggable mini-player, binding-restoration guidance, latest 10 events, note nicknames/editing and an authorized per-monitor online-family roster.

**Update/demonstration: [docs/WEBSITE_IMPROVEMENTS.md](docs/WEBSITE_IMPROVEMENTS.md).** Run `cloud/website_improvements.sql`, disable Realtime Allow public access, run `python configure_web.py` at the local project root for WSS CSP, then publish `web/` manually. Frontend bundles are included.

**Files/verification: [docs/WEBSITE_CHANGES.md](docs/WEBSITE_CHANGES.md).** The following multi-person description is historical; its no-new-SQL claim applies only to that detection stage. Online family requires the migration above.

The 2026-10-15 `source_only.zip` was extended with same-camera multi-person tracking, separate posture decisions and person-labeled events. Original functions, thresholds, models and inference parameters were retained. Windows sound is deduplicated per device-level episode. Family registration, invitations, device switching and notes remain.

## Multi-person update: start here

**Update/run/demo: [docs/MULTI_PERSON.md](docs/MULTI_PERSON.md)**. Files/results: [docs/MULTI_PERSON_CHANGES.md](docs/MULTI_PERSON_CHANGES.md).

Extract the multi-person update at the existing root, preserving configuration, models and CSV. Activate the original environment and run `python fall_detection.py`. This stage needs no new SQL or cloud-permission changes. Its person-fall event highlighting can be published with the website using the original process.

The family/deployment sections below remain for first installation. Configured users need not rerun migrations or recreate invitations.

## Existing UI: F5 session restoration and account entry page

Refresh restores the current tab’s Supabase session and rechecks membership. Tokens refresh on expiry; invalid sessions prompt sign-in. Passwords are not stored. Sign out clears the saved session.

Followed homes and invitations are on the account entry page: sign in → select a monitor → **Open monitoring**. **Choose home** returns there and stops old video. F5 restores the selected monitor but viewing still requires a click.

Users with family access and `family_schema.sql` already installed need not rerun SQL, recreate codes or change cloud keys. Multi-person updates require the new Python main program as described above.

## First installation of family access

**Full guide: [docs/FAMILY_ACCESS.md](docs/FAMILY_ACCESS.md)**.

1. Back up and copy update files to matching paths, preserving `.env`, `web/config.js`, `web/vercel.json`, models and logs.
2. Run `cloud/family_schema.sql` after the base/video schemas in SQL Editor, retaining existing data.
3. Enable Email registration and configure Confirm email as required. Set Site URL to the production Vercel HTTPS address; configure SMTP for verification mail to real family users.
4. Generate an expiring invitation for an existing device using `cloud/create_family_invite.sql.example`, then privately share it for registration/binding.
5. Publish manually with `npx vercel@58.7.1 --prod` in the existing `web` folder. This family stage does not need video-function redeployment or key rotation.

Family users self-register without manually created administrator accounts. Notes are visible only to bound members and cannot change AI status or act as emergency alarms/medical diagnoses. Invitations default to 7 days/5 members with 10 redemption attempts/account/minute. Notes contain 1–1,000 characters, limited to 5/account/minute.

Historical family changes: [docs/FAMILY_CHANGES.md](docs/FAMILY_CHANGES.md). Original local/remote-video instructions follow.

## Source review and changes

The main program uses `conf=0.5 / iou=0.5`, shoulder/hip angles, person-box ratio and hip–ankle bending exclusion. Each person independently accumulates suspicious posture for 1.5 seconds before Suspected Fall, and aggregate state follows highest priority. CSV retains four columns with appended person events; sound is deduplicated per aggregate episode.

The earlier video version added MonitorBridge status/event/frame integration and startup/shutdown, with model paths relative to the script. Multi-person changes process each detection while preserving status/video interfaces. `pose_features`, `update_status`, thresholds and predict parameters remain unchanged. Single-person AST regression baseline is in `original_source/fall_detection_before_video.py`; historical backups are retained.

The main program opens the camera once. Website/video publishing reuse its skeleton-annotated frame without opening another webcam.

## Implemented capabilities

| Feature | Implementation status |
|---|---|
| Multiple people in one camera | Independent timers, temporary IDs, conservative occlusion handling and aggregate state |
| Phone page, actual state, connection, time and events | Latest 10 events displayed; device snapshots retain the recent 30 |
| Password-protected on-demand local JPEG preview | Retained, sharing the capture source with remote media |
| Two video Supabase Edge Functions | Family JWT/membership checks, device-secret hash checks, fixed room/identity and rate limits |
| Family WebRTC | Subscribe only to the authorized camera track; show Live only after real frames |
| Monitoring-computer WebRTC | Separate thread, 640px/10FPS, at most one latest frame, no video upload without authorized viewers |
| Revocation/lease expiry | Server removes participants plus computer-side subscription allowlist; authorization/network failure stops sending |
| Disconnection/stale-frame cleanup | Status expires at 15 seconds; video stops displaying after over 2 seconds without fresh frames |
| Actual Supabase/LiveKit/Vercel connectivity | Requires your configuration, deployment and practical testing; no account was accessed here |
| Campus Wi-Fi/TURN path | Requires on-site testing; cannot be verified in this environment |

There is no safe-person confirmation or automatic calling. Later sections above document persistent viewed acknowledgements and optional Web Push. User-triggered recordings can be downloaded locally; no cloud video files are created. Checking remains the original sustained-posture assessment.

## Windows: start locally first

Extract this ZIP into a separate **SafeNest_AI_Remote_Video** folder and preserve the old project/`.env`. Do not overwrite historical CSV before verifying the version.

Use CMD and adjust the first path to your extraction location. The commands reuse your working YOLO virtual environment:

```bat
cd /d C:\Users\Default.DESKTOP-QHM9VSV\Desktop\SafeNest_AI_Remote_Video
C:\Users\Default.DESKTOP-QHM9VSV\Desktop\elderly_fall_ai\.venv\Scripts\activate.bat
python -m pip install -r requirements-dashboard.txt
python -m pip install -r requirements-video.txt
```

Copy the old `.env` to the new project root and add video settings using `.env.example`. For first-time local-password setup:

```bat
copy .env.example .env
python -c "import secrets; print(secrets.token_urlsafe(24))"
notepad .env
```

**Do not run copy to overwrite an existing .env.** Put the generated random text in SAFENEST_LOCAL_PASSWORD (at least 12 characters). Initially keep `SAFENEST_VIDEO_ENABLED=0`, then start:

```bat
python fall_detection.py
```

Open http://127.0.0.1:8765 on the computer and sign in with the local password. View camera starts local preview; Q stops detection. Once dependencies/model are installed, local detection/CSV/sound need no internet.

If no old virtual environment exists, create one (64-bit Windows Python 3.11 recommended):

```bat
py -3.11 -m venv .venv
.venv\Scripts\activate.bat
python -m pip install -r requirements.txt
```

Do not replace a working GPU PyTorch environment with a full reinstall. Keep graphical opencv-python on Windows rather than headless.

Reactivate .venv after reopening CMD. In PowerShell, call the environment’s `python.exe` directly or use CMD activation.

## Enable remote video

**Read `docs/REMOTE_VIDEO.md` in order for exact deployment commands:**

1. Retain existing Supabase status bridge / device / family members configuration.
2. Append `cloud/video_schema.sql` in SQL Editor.
3. Store LiveKit key/secret only in **Supabase Edge Function secrets**.
4. Deploy `video-token` and `device-video-token`, with the exact allowed Vercel Origin.
5. Set `SAFENEST_VIDEO_ENABLED=1` and the public LIVEKIT_URL in the computer’s `.env`.
6. Run `python configure_web.py` for public configuration/exact CSP, then deploy `web/`.
7. Run the new fall_detection.py, sign in on the phone and click View camera.

The ZIP includes built `web/video-client.js`; deployment needs no frontend dependency reinstall. After source changes, run:

```bat
npm ci --prefix video_frontend
npm run build --prefix video_frontend
```

Deploy only the web folder to Vercel. Python and LiveKit media remain with their respective services.

## Main files

- `fall_detection.py`: current detection and status-bridge integration.
- `monitor_bridge.py`: status, events, single latest-frame entry, local authentication and cloud metadata sync.
- `video_publisher.py`: device-authenticated short-lived publish tokens, background authorization sync and on-demand media.
- `supabase/functions/`: video and notification Edge Functions with shared authorization logic.
- `cloud/video_schema.sql`: session leases, database rate limits and device-scoped authorization.
- `video_frontend/`: rebuildable LiveKit browser modules and package-lock.
- `web/`: phone website and bundled clients, without server secrets.
- `.env.example`: monitoring-computer configuration, without LiveKit API secrets.
- `supabase/.env.functions.example`: server-secret template without real credentials.
- `docs/TEST_CHECKLIST.md`: test records, manual acceptance and network checks.

## Verification scope

Historical family-stage commands/results are in `docs/FAMILY_CHANGES.md`; current results appear above. Existing regressions are retained, with real PostgreSQL RPC/authorization and website-interaction tests. Source reads explicitly use UTF-8 to avoid Windows cp1252 decoding failures.

No Supabase, LiveKit or Vercel account was connected and nothing was deployed for you. Real email delivery, Windows cameras and phone networks need post-deployment acceptance following `docs/FAMILY_ACCESS.md` and the later guides above.

## Operational boundaries

- No viewers means no video track/encoding/media sending. Lightweight signaling, status sync and cloud calls may still incur costs.
- 640px width, 10FPS and a single-frame slot discard old frames rather than accumulating a queue that slows detection.
- Family admission tokens last 60 seconds; leases last 25 seconds and renew every 8 seconds. After membership deletion, approximately 3-second device sync/renewal stops access rather than instantaneous propagation. Publishing stops if authorization has not refreshed for 5 seconds.
- No continuous static-frame sending without viewers or after camera disconnect. The phone clears video after over 2 seconds without a newly decoded frame.
- Multi-camera mode retains each Camera’s latest snapshot and appends received event metadata, displaying only the Home’s latest 10. Each device still uploads its most recent 30 events, so earlier events during a long outage may be missed; full originals remain in local logs. There is no cloud-recording repository.
- Local detection/sound continue during network loss; the website shows Connection Lost/not connected. Status retries after recovery; video requires an explicit viewing click.
- Camera Offline retains the original exit behavior; rerun after reconnecting. A final offline state is sent best effort, otherwise heartbeat expiry is the fallback.
- Built-in local HTTP is for trusted personal networks only. Real cross-network access uses Vercel HTTPS + authenticated WebRTC. School networks may impose client isolation or TURN-domain restrictions.
- Preserve original local models/logs; deliveries exclude historical CSV. Exclude `.env`, `.env.functions` and SQL containing real tokens from future source uploads.
