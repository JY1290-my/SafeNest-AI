# Shared care-note management and integration acceptance

This update adds deletion with an English confirmation to the existing family care notes. The detector, calibration, multi-person tracking, alarm, publishing and on-demand video algorithms are unchanged. Nothing has been deployed.

## What changed

- Every note shows the author's safe display name and server timestamp. Times are displayed in the browser's local timezone. Empty, non-string, email-like or UUID-containing display names use **Family member**. Names are labels selected by account holders, not verified personal identities.
- `add_care_note(p_device,p_body)` derives the author ID from the authenticated Supabase session. It accepts no author name, user ID or role arguments. `list_care_notes` derives names from the Auth account referenced by that stored author ID; it does not return author UUIDs or emails. Changing a display name updates how existing notes appear.
- A currently bound author may delete their own notes. An existing, server-verified **device manager** may delete notes for that same device. Management of another home, editable Auth metadata, UI flags and ordinary family membership confer no right to delete other authors' notes.
- **Delete my note** / **Delete note · Device manager** opens an inline English confirmation showing the selected author, time and note. Focus goes to **Cancel**. Cancel or Escape dismisses without sending a deletion. Only **Delete note** confirms the request.
- Deletion is permanent for that note. There is no undo, recycling bin or edit history. It does not alter detection status, events, video sessions or local alerts. Notes remain observations and care suggestions, not emergency alerts or medical diagnoses.
- Notes, names and confirmation previews use `textContent`. No user-supplied HTML is inserted. A note's internal action ID is not displayed as an author identity.
- Buttons use the server-provided `can_delete` capability. The deletion RPC independently rechecks device membership, device enabled status, authorship and same-device manager authority on every operation.
- Existing limits remain: latest 30 notes displayed, 1–1,000 characters per note, 5 posts/account/minute. Deletion allows 20 attempts/account/minute. Rate-limit denials commit their counters. Missing, already-deleted, mismatched-device or unauthorized note targets share the same generic `note_unavailable` result.
- Device switching invalidates old request generations and clears notes, event content, confirmation and camera view before old media/Presence cleanup. A late list/deletion response cannot revive a deleted note or update another device/account.

Deleting another user's note is intentionally restricted to the existing `device_managers` relationship. No new administrator role or automatic promotion is introduced. A removed member, even the original author, cannot read/post/delete notes for that device until legitimately reauthorized. Revoking a member does not erase their remaining historical notes.

## Manual update steps

1. Back up the current project and database as appropriate. Copy the update files into the existing project root. Keep `.env`, model weights, `web/config.js`, calibration, local settings and event history. The source-only archive contains no model weights; keep your working `yolo11n-pose.pt`.
2. In **Supabase → SQL Editor**, open a new query, paste the complete contents of **`cloud/care_note_management.sql`**, and run it. For installations on the immediately preceding delivery, this is the only new migration. It follows `device_claim.sql`:

   ```text
   cloud/schema.sql
   cloud/video_schema.sql
   cloud/family_schema.sql
   cloud/website_improvements.sql
   cloud/context_monitoring.sql
   cloud/family_management.sql
   cloud/device_claim.sql
   cloud/care_note_management.sql
   ```

   Apply missing prerequisites in that order. Do not rerun earlier migrations after newer ones: old `CREATE OR REPLACE` definitions could remove current permissions/features. The new migration itself is rerunnable and preserves existing rows. It enables RLS and revokes client table privileges again, adds the checked delete RPC, and updates existing note RPCs and the shared safe-name helper. The table stays `safenest_private.care_notes`; no public notes table is created.
3. Update the website's `web/dashboard.js`, `web/family-view.js`, `web/index.html` and `web/styles.css` together. Review locally, then publish `web/` yourself with the existing Vercel process. This delivery has not deployed anything. No Supabase Auth configuration, new secrets, Realtime setting, Storage bucket or Edge Function deployment is required. No frontend SDK rebuild or new dependency is needed.
4. Refresh the website. Open an authorized home and its **Shared care notes**. Existing sessions/bindings are reused. If no delete controls appear, check that the new SQL and all four web files are installed. An older notes RPC does not return `can_delete`, so the new page deliberately omits delete controls rather than pretending permission exists.
5. This patch changes no Python monitoring file. It does not require restarting detection, changing thresholds or recalibrating the bed. Local camera changes still belong in **Start_Camera_Setup.cmd** on the monitoring computer. Never substitute a family browser camera for the actual device.

For an unclaimed registered device, the previous **local claim code → Set up a monitoring device** flow remains as documented in [DEVICE_CLAIM.md](DEVICE_CLAIM.md). Existing managers continue using **Manage family**; ordinary relatives use family invitations. No secrets or passwords need to be supplied to an assistant.

## Code and mock acceptance results

| Area | Inspection and verification | Result / scope |
| --- | --- | --- |
| Family Dashboard / Auth | Devices come from `list_my_monitors` and current database membership. Stored selections are validated against that list. Tests cover register/verify/login/refresh/another browser and unauthorized cached preferences. | Passed. No public device search or browser-only grants. |
| Local camera setup | `camera_setup.py`, `device_setup_ui.py`, `camera_preview.py` and `device_settings.py` operate on the monitoring computer. Web guidance and claim redemption do not expose remote hardware-control endpoints. | Passed using mocked UI/capture; native Windows hardware still needs local acceptance. |
| Device switching | Dashboard invalidates old generations, clears private UI, resets capture/PiP, stops old camera/Presence and loads only the selected device. Late callbacks cannot overwrite the new home. | Passed, including pending note deletion and synchronous disconnect callbacks. |
| Bed calibration | `RoomCalibration` validates device scope, camera source and view profile. Saved outlines always need live confirmation. View change invalidates old calibration. | Existing isolation/view-change/error tests passed; original algorithm unchanged. |
| First manager / family invitations | Local credentialed one-use claiming, durable no-reclaim marker, hash-only family invites, generic denials, expiry/use limits and backend binding restoration remain intact. | Existing claim/invitation tests passed; new full-stack SQL test uses claiming and invitation redemption to create its roles/bindings. |
| Revocation | Checked RPCs deny reads/writes after membership removal. Private Presence topic/leases and viewer leases are invalidated by existing cleanup. Other homes and note/event history survive. | Passed, including inability to delete one's old notes after revocation and inability to use an old family code to rejoin. |
| LiveKit / local preview | Family video connects only after View camera, uses the authorized selected device and existing short-lived token/lease flow. No second connection for PiP/capture. | Existing token, permission, renewal, disconnect, media-cleanup tests passed; no live network test. |
| Care notes | Auth-derived authors, safe labels/plain text, author vs manager permissions, English confirmation, expiry of UI permission, replay/errors/rates and stale responses. | New SQL and UI tests passed. Deletion leaves snapshots/events/video unchanged. |
| Fall detection and events | Compared delivered baseline files byte-for-byte; existing AST/threshold, multi-person, context and alert tests run unchanged. Recent event display remains newest 10 without truncating storage. | Passed; no detector/threshold/model/tracking/alert or existing event-meaning change in this update. |

Nineteen core files were byte-compared against the preceding delivery: `fall_detection.py`, `multi_person.py`, `context_monitor.py`, `room_calibration.py`, `device_settings.py`, `camera_setup.py`, `camera_preview.py`, `device_setup_ui.py`, `device_claim.py`, `monitor_bridge.py`, `video_publisher.py`, `video_frontend/camera-controller.js`, `video_frontend/presence-controller.js`, `web/video-client.js`, `web/presence-client.js`, `supabase/functions/_shared/video-core.js`, `cloud/family_management.sql` and `cloud/device_claim.sql`, plus `web/cloud-client.js` for Auth/session handling. All are unchanged.

The full-stack SQL test runs every migration through this version, checks anonymous/authenticated permissions and RLS, then exercises claim → invitation → notes → member revocation → denial of notes/Presence/video. PostgreSQL execution uses PGlite with mocked Auth/Realtime structures. UI tests use JSDOM/mocked fetch/media; Python tests use synthetic data and mocks. No camera, model weights, live Supabase/LiveKit account or production credentials were used. These results validate code behavior, not production hardware/network latency or fall-detection accuracy in a real home. Independent simultaneous PostgreSQL connections were not load-tested; device-first locking coordinates cooperating production mutations.

## Test commands and results

From the project root, in the existing Python environment:

```text
python -m unittest discover -s tests -p "test_*.py"
npm --prefix video_frontend test
```

Results: **180 Python tests passed; 181 frontend/database tests passed; zero failures**. All previous tests ran. This update adds 18 frontend/SQL test results (7 UI tests and the 10-case SQL suite plus its enclosing test). No new Python test is needed for unchanged monitoring files; all 180 existing Python cases were run. On a clean development checkout, `npm --prefix video_frontend ci` installs the existing pinned dependencies before the tests.

## Remaining limitations and real-device checks

- Notes are refreshed by the existing polling flow, approximately every 15 seconds. Other viewers may briefly see a deleted note until refresh. Revocation blocks subsequent server requests; UI, existing video and private Presence clean up through their existing short-lived checks. Previously received content or downloaded media cannot be erased from someone else's computer.
- A network timeout can occur after the database commits. The UI refreshes notes and explains that deletion may have succeeded. It does not auto-retry a destructive operation. Closing/switching away cannot cancel a request already accepted by the server.
- Latest 30 notes are shown; older-history pagination, editing, attachments, deletion audit trail and restoring deleted notes are not implemented. There is no cloud recording or urgent/medical notification from notes.
- Windows Tk/OpenCV/clipboard, USB camera indexing, lighting/occlusion and actual calibration require physical checks. Browser PiP/recording/download support varies; the existing in-page mini-player fallback and feature detection remain. The family site still cannot remotely start/configure hardware or control PTZ without a real authorized interface. No predictive model or permanent Person identity is added.
- After migration and your own website update, use two or three test accounts: author A, ordinary relative B, device manager M. Check A can cancel/delete their own note; B cannot delete A's; M can delete only within a managed home. Remove A's binding and verify the home disappears and further note/video actions fail, while another authorized home still works. Switch homes while video is active and while a note confirmation is open: old content/confirmation must clear and the new video must remain off until explicitly requested.

## Changed files

| File | Change |
| --- | --- |
| `cloud/care_note_management.sql` | New incremental migration, safe labels, membership checks and note deletion RPC. |
| `web/dashboard.js` | Delete confirmation/lifecycle, stale response protection, clear-before-disconnect switching. |
| `web/family-view.js` | Safe author-name fallback for email/UUID/non-string values. |
| `web/index.html` | Accessible English confirmation, permissions and non-emergency guidance. |
| `web/styles.css` | Touch-sized delete controls and wrapping confirmation text. |
| `tests/care-note-management-database.test.mjs` | All-migrations SQL permission/integration acceptance. |
| `tests/family-ui.test.mjs` | Deletion/confirmation/text safety/race and cleanup regressions. |
| `video_frontend/package.json` | Includes the new test suite; dependency versions unchanged. |
| `README.md` | Current feature summary and manual migration steps. |
| `docs/CARE_NOTES_ACCEPTANCE.md` | This acceptance record, limitations and update guide. |
