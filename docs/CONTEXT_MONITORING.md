# Context monitoring: bed zones, motion history and movable cameras

## What this version implements

An independent context layer extends the existing multi-person/website version while preserving `pose_features`, `update_status`, the 0.4 keypoint confidence, 60° torso threshold, 1.0 bounding-box ratio, 50° lower-limb exclusion threshold, 1.5-second confirmation period and `predict(conf=0.5, iou=0.5)`.

**The current version interprets the original horizontal-pose result using strict, continuous bed-zone evidence.** The original posture functions and thresholds still return their original results, retained as `baseline_status`; final states and sounds aggregate the same person’s context evidence. `Resting in Bed` requires a calibrated bed zone that can currently be verified, reliable continuity of the same track, an initially more upright/seated pose with both hips in the bed (torso angle <35°; seated shoulders may project above the bed surface), followed by a continuous smooth transition to lying down (at least 1 second, 6 samples and 30° of angle change), no rapid descent or existing risk, and 3 seconds of stable observation. Smooth bed entry awaiting stability produces `Checking` / `Check Person`, without sounding solely for the original horizontal pose. Body/bed overlap alone does not satisfy these conditions.

A person already lying down at startup, an occluded entry sequence or unreliable tracking cannot automatically establish rest. **When the current bed zone is verified, both shoulders and hips are inside, and no risk has been observed, show `Check Person`; retain the original posture result without creating a final fall event/sound solely because bed-entry history is missing.** This requests a check rather than confirming safety. A temporarily lost person recently inside the bed without abnormal risk produces Tracking Lost; track interruption alone does not create a new fall. Reappearance may produce Check Person but cannot invent a complete bed-entry sequence.

Version 5 separates boundary (shoulders/hips partly across the bed edge) from outside (all four reliable shoulder/hip points outside). Boundary alone does not latch outside-bed risk. An ambiguous lying location produces Check Person; the boundary hint clears after entering inside. A seated sequence with both hips continuously inside may continue collecting rest evidence, but both shoulders and hips must eventually be inside and stable for 3 seconds. Starting at boundary, missing history, abrupt rotation or missed detections cannot establish rest solely through subsequent stillness.

Rapid rotation and actual descent are also recorded separately. The original angular-speed condition is a rotation hint; it cannot alone remove the bed-zone interpretation or count as hip descent, although it still interrupts reliable smooth-entry evidence. The original actual-descent conditions and values are retained. Descent, a suspected pose with all shoulders/hips outside, and leaving the bed after verified rest (or both hips outside after continuous boundary crossing) remain sustained risks. Reaching the original conditions still produces Suspected Fall; later inside positioning or B confirmation cannot clear them.

Temporary background uncertainty is not equivalent to leaving the bed. A track previously inside, or with a bed-edge location hint and no observed abnormality, produces Check Person rather than a new fall caused only by yellow calibration or grace-period expiry. Confirmed view changes disable the old calibration and bed zone. Unconfirmed scenes and new people without bed-zone association follow the original evaluation. Each source retains its first time/location; later boundary/outside conditions cannot overwrite the earliest descent evidence. Sustained risk clears only after the original upright-recovery observation or track expiry, without transfer between people. These are context heuristics, not clinically or representative-dataset validated assessments of sleep or safety. See [BED_REST_FIX.md](BED_REST_FIX.md) for the full update.

Sound follows the final aggregate state. Sufficient continuous rest evidence for the same person prevents sounding solely for the original horizontal-pose result. The sound remains `winsound.MessageBeep(MB_ICONEXCLAMATION)`, once per device-level suspected-fall episode. It can rearm after everyone returns to reliable non-risk states (including verified rest), or all old tracks expire.

## Updating and running

For an existing context-enabled installation, v5 only requires applying the local patch and restarting, without new SQL, website publication or dependencies. The SQL/website instructions below describe the initial context-feature installation.

1. Preserve `.env`, `web/config.js`, `web/vercel.json`, models, logs and the virtual environment. Apply the update package at the project root, preserving relative paths.
2. Cloud users run `cloud/context_monitoring.sql` in Supabase SQL Editor. The initial installation order is `schema.sql` → `video_schema.sql` → `family_schema.sql` → `website_improvements.sql` → `context_monitoring.sql`. Existing migrations do not need to be rerun; in particular, do not overwrite later function definitions with the base schema.
3. Start in the existing virtual environment:

   ```bat
   python fall_detection.py
   ```

4. The local website uses the updated `web/` directly. Publish the updated `web/` yourself for the remote website. SQL, Python and frontend updates are all needed for full support of the new states; an older frontend may display an unfamiliar state as Connection Lost.
5. This version does not change video tokens, LiveKit connections, registration, invitation codes, notes or online-member permissions. Accounts, invitations and device credentials do not need to be recreated.

## Calibration controls (in the computer’s camera window)

| Action | Result |
|---|---|
| Click the top Calibrate room control / press C | Immediately disable the old bed zone and start drawing; inference continues |
| Click 3–12 points in boundary order | Mark the bed-surface projection in the current image, excluding adjacent floor |
| Right-click / Backspace | Undo the last point |
| B / Enter while drawing | Validate the current draft, record background features and save, with confirmation feedback |
| Esc | Cancel drawing without automatically enabling the old bed zone |
| B / Enter / top Confirm control when not drawing | After visually checking the saved outline, confirm it applies to the current frame; this confirms only the bed zone |
| R / Reset control | Persistently clear this camera/view’s bed zone and draft points. The outline disappears; mark new points directly and press Enter to save. |
| Q | Exit and release the camera |

Keyboard shortcuts require focus on the computer’s OpenCV camera window; do not press B in the terminal or phone browser. You can also click Confirm / Reset above the preview. Mouse and keyboard confirmation share the same validation path and do not bypass draft/background checks.

Coordinates refer to the original camera frame without the top toolbar. Green marks the currently verified bed zone; yellow means drawing, unconfirmed or temporarily unverifiable background, not a detected fall. Red means invalidation by a confirmed view/dimension change. R removes the outline and shows Needs calibration. English reasons accompany the colors. A yellow outline cannot confirm rest, although the first 2 seconds of occlusion may supply a low-confidence location hint. Calibration can only be changed in the local window; the family website explains this without remotely controlling camera settings.

Calibration is saved under `camera_profiles/<profile>.json`. The default profile is `default`, and the existing camera source is `0`. Set `SAFENEST_CAMERA_PROFILE=bedroom_demo` in `.env` to distinguish installations. Files store only the camera source, setup name, resolution and normalized polygon, not images, video, keypoints or identities. **Saved outlines always start disabled and require B confirmation or C redrawing on every startup.** Changing profiles does not automatically load another scene’s outline.

Saving requires a non-self-intersecting, non-duplicated boundary covering at least 0.5% of the image, plus sufficient spatially distributed fixed background features outside the bed. Three image quadrants are no longer mandatory. The bed, its margin and person boxes are excluded from background matching. If fixed background is insufficient, reposition the camera to include bed frames, doorframes or furniture details, then redraw/confirm. Original posture detection continues. Plain walls and bedsheet texture should not be the main reference.

## Camera movement and calibration invalidation

- Press R before moving to clear the current bed zone. After repositioning, mark points again and press Enter. B alone cannot restore an outline cleared by R. If an outline was retained, visually verify it truly matches the new view before confirming.
- A change in image width/height disables calibration and requires confirmation even if aspect ratio is unchanged. Normalized coordinates facilitate redisplaying the outline; they do not compensate for angle, cropping, mirroring or zoom.
- Approximately every 0.5 seconds, OpenCV ORB/Hamming and homography compare against the fixed background reference, excluding the bed, its margin and detected people. Version 4 adds independent appearance checks: highly consistent distributed textured tiles at the original position can verify no change. Proposed displacement must significantly improve background alignment with enough supporting tiles, followed by two consecutive consistent estimates to invalidate calibration and rebuild temporary IDs. Sparse repeated displacement alone is insufficient. The first independently supported candidate enters `possible movement` and disables old bed-zone location estimates; later insufficient features cannot silently restore them. Recovery of the original reference match is required to return to verified.
- Insufficient features/occlusion produces `occluded`. Keep checking against the original reference rather than describing missing evidence as camera movement. The old polygon may provide a low-confidence location hint for at most 2 seconds; trusted `zone` remains unknown and cannot confirm rest. Repeated failures do not reset the grace period; after expiry the polygon is not used for location decisions.
- A temporary track previously reliably inside, or having only a recent inside estimate during the grace period and no observed motion/outside risk, produces Check Person while lying down. Grace-period expiry does not itself create a fall; current position becomes unknown. This memory is not identity and does not cross expiry/new IDs. New people cannot borrow someone else’s bed state. People appearing after the grace period or without bed-zone association follow the original rules.
- Soft verification fluctuations immediately interrupt rest evidence while preserving motion samples, existing risks and original confirmation timing. Matching recovery can restore location verification automatically, but not Resting in Bed; the entry sequence must be observed again. Observed rapid descent/outside risk or another person’s suspected fall retains priority.
- Editing or confirming a polygon clears context history without clearing the original fall timer. Confirmed camera movement/dimension changes clear unreliable person associations. The new view requires reconfirmation and may introduce delay.
- Background features and one low-resolution grayscale reference with bed/person pixels masked remain in RAM only; they are not uploaded or written as image files. Appearance comparison normalizes brightness offset/gain; light blur and at most 2 pixels of residual tolerance accommodate resampling without relaxing posture/fall thresholds. Background verification is auxiliary: repeated texture, flat backgrounds, occlusion, lighting changes and small movement can cause missed changes or unnecessary recalibration. Not all camera movement can be detected; manually check the view before every test.
- The local preview displays `Background: identity ...; ... tiles`; displacement candidates show `Shift ...; inliers ...; alignment ... vs ...; checks .../2`. Insufficient independent appearance evidence cannot confirm displacement. When a red outline is reached, evidence is appended to the existing Bed Calibration reason for diagnosis in context_events.jsonl. Confirmation feedback disappears when verification fails, avoiding simultaneous success and invalid-state messages.

OpenCV API reference: <https://docs.opencv.org/4.x/d7/dff/tutorial_feature_homography.html>. This project uses ORB from the existing main package, not SURF requiring contrib.

## Per-person states

| Context state | Meaning / device state |
|---|---|
| ACTIVE | Original rules report Normal; the pose is visible and upright. The aggregate may be Normal. |
| LOWERING | Lowering the body or observing a bed-zone pose; Check Person |
| RESTING_IN_BED | Reliable bed zone, continuously observed smooth entry and 3 seconds of stability; Resting in Bed, with monitoring continuing |
| POSSIBLE_FALL | Original confirmation without a rest/uncertain-inside-bed explanation, or with existing clear motion/outside risk; Suspected Fall, highest priority |
| CHECK_PERSON | Bed-edge overlap, lying inside with missing history/abrupt rotation, temporarily uncertain bed zone, low posture, motion risk below the original fall conditions or recovery observation; Check Person |
| TRACKING_LOST | A recently seen person disappears or keypoints are unreliable; Tracking Lost |
| RECOVERED | Briefly indicates observed upright recovery after sustained observation following an abnormal state; does not confirm absence of injury |

Inside-bed decisions require both shoulders and hips to be reliable and inside. Partial overlap is boundary and alone cannot confirm bed exit or a fall. Outside means two-dimensional image location, not proof that the body is on the floor. Approximately 3 seconds of history supplies hip movement, torso rotation and bed entry/exit evidence. Rapid descent requests a check and does not independently create a new sound condition. Previously resting people are reassessed at the boundary; both hips moving outside continuously, or all shoulders/hips outside, retains exit risk. Slow sliding does not automatically become normal.

A single horizontal frame, lying down at startup or an entry sequence missing due to occlusion cannot establish rest through continued lying alone. A reliable bed zone without observed risk produces Check Person rather than a fall solely for static horizontal posture. Known inside-bed people also produce Check Person during background-verification pauses, with unknown location requiring an actual check. During brief person occlusion, previously observed confirmation time is retained and the entire unobserved gap is paused; disappearance time is not counted toward 1.5 seconds. Contextual entry/rest evidence is invalidated by occlusion and requires a complete new smooth-entry sequence. If a person box remains visible but keypoints are unreliable for over 2 seconds, stale fall-confirmation time is discarded and confirmation restarts after recovery. Ambiguous association or expiry of the original 2-second track-retention period deletes that track; it cannot be transferred to a newcomer. Timers, histories and risks are independent per person. IDs may change during crossing, rapid displacement or occlusion.

Aggregate priority: Suspected Fall → Checking → Tracking Lost → Check Person → Resting in Bed → Normal. Resting in Bed requires everyone to be resting in bed; a mix of reliable activity and rest may produce Normal, with per-person explanations retained. A normal person cannot hide a recently lost track within its retention period. After all tracks expire and nobody is visible, show No Person. A confirmed suspected-fall track briefly disappearing retains suspected-fall priority with unreliable-tracking text. Camera Offline / Connection Lost means a device/connection problem, not No Person.

## Configuration and records

No new dependencies are required. Copy `context_config.example.json` to `context_config.json` to adjust new context parameters; this does not change original posture thresholds/timing. Missing files use defaults. Invalid configuration reports a message and falls back to defaults.

Main defaults: 3 seconds of history; approximately 0.1 seconds between samples and at most 200 per person; restart rest-evidence collection after reliable-sample gaps over 0.6 seconds; 3 seconds of stable-rest observation; 1 second of upright-recovery observation. Rapid-descent heuristics use hip displacement relative to person-box height and torso-angle change, not physical speed. The example lists low-posture image thresholds, stable speed and rotation thresholds; these are demonstration parameters without validated accuracy.

- `events.csv`: retains the original four columns and appends without changing the old header or historical rows.
- `context_events.jsonl`: appends context-transition times, temporary IDs/states and reasons, including calibration transitions and Evidence sources. `descent@+0.3s/boundary` means descent was first recorded 0.3 seconds after the temporary track began, while at boundary; it does not mean the current position is boundary. Repeated evidence retains its first timestamp; distinct sources remain separate and source changes append one person event rather than per-frame countdowns. Pure boundary clears after inside positioning without deleting old events. Full evidence remains in local reasons; cloud handling retains the 160-character limit with no schema extension or keypoint/bed-zone uploads. Original `baseline_status` and final states use existing fields; the local preview displays `Pose: original state -> final state` and `Evidence:` (truncated when long, with full local JSONL).
- Supabase: preserves device-token and member checks, adding state names and bounded `context` / event `reason` fields. No raw trajectories, bed coordinates, background descriptors, images or secrets are uploaded. Summaries currently show at most 16 people, but all detected people participate in aggregate risk calculation.
- Website: adds People in view with IDs, states and explanations. The section is hidden for older devices without context. Clear old summaries on device switch, logout or status-connection loss. All text is rendered safely.

## Automated tests and demonstration

```bat
python -m unittest discover -s tests -v
npm ci --prefix video_frontend
npm test --prefix video_frontend
```

These tests use mocked poses, synthetic images, mocked video and local PostgreSQL WASM, without a camera, model inference or real cloud credentials. Existing test dependencies (OpenCV, Flask, LiveKit, etc.) are still required. This stage does not replace or rebuild bundled video/Presence SDKs; only directly loaded website sources change.

For a demonstration, position the camera and mark the bed first, then have team members safely sit/pose or use an existing test clip. Do not have older adults actually fall:

1. **Smooth bed entry**: observe the same person seated/more upright inside a verified bed zone, then continuously lying down slowly and remaining stable for about 3 seconds. Check for Resting in Bed without a sound caused by the original horizontal-pose result. Also test someone already lying down at startup: a reliable bed zone should produce Check Person rather than inventing rest or a fall. Test rapid descent, an outside-bed fall and moving inside after existing risk to confirm suspected falls remain possible.
2. **Outside-bed posture**: safely hold a previously triggering pose on a soft mat: Checking → Suspected Fall, with one sound. Low posture/bending without sufficient evidence may produce Check Person without adding a sound condition.
3. **Moving off the bed edge**: slowly move from the bed zone into a low outside position and observe reassessment. The alert follows if the original suspected-fall conditions are subsequently reached; an actual fall is unnecessary.
4. **Occlusion and two people**: briefly obscure one person while another stays normal. Check Tracking Lost, separate histories and resumed timing. Crossing may reset IDs, a conservative response to unreliable association.
5. **Moving the camera**: press R, move, then C, checking that the old zone is not used. Slight movement can test automatic background checks, but these cannot be assumed reliable every time.

This version has not been validated on your real Windows camera, speakers, rooms, Supabase, LiveKit or Vercel. Ordinary RGB images have projection overlap, blanket occlusion, low light and temporary-ID changes. States cannot confirm sleep, injury or that nobody is at risk.
