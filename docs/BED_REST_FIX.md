# Bed-edge entry and risk-source correction v5 — 2026-10-18

## Problems addressed

The newly supplied recording, approximately 18 seconds long, shows the empty-bed calibration staying verified. At about 9–10 seconds, the person sits on the bed edge with Bed: boundary. At about 10.5 seconds, lying down produces Checking; at about 12.2 seconds, the status becomes Suspected Fall. Bed later changes to inside, but the reason remains Fall-like posture outside the verified bed interior. This recording follows a different path from the earlier photographs showing a red outline and invalid calibration.

The previous code recorded boundary as sustained outside-bed risk, and later conditions could overwrite the original risk reason. Version 5 separates risk sources and addresses ordinary bed entry across the boundary becoming permanently latched as risk. It retains v3 temporary-occlusion handling and v4 independent background verification. New tests use synthetic keypoint trajectories to represent the sequence observed in the recording; they do not reconstruct precise keypoints from the overlaid recording or rerun its model inference. Real-camera validation is still required.

## Version 5 bed-edge and risk rules

| Source | Behavior and clearing conditions |
|---|---|
| boundary | Partial shoulder/hip overlap with the bed edge means location is ambiguous. A lying pose produces Check Person rather than confirmed outside-bed fall risk. This hint is removed after entering inside. |
| rotation | Records rotation separately using the existing angular-speed and angle-change values; rotation is not actual descent. It interrupts evidence of smooth bed entry. When it is the only evidence in a reliable bed interior/boundary, request a check; subsequent stillness alone cannot confirm rest. |
| descent | Retains the original actual hip-descent conditions and values, recording the first time and location separately. Later movement inside the bed does not clear it. |
| outside | Retains risk when all four reliable shoulder/hip points are outside the bed and the original rules reach Checking/Suspected Fall. Later inside positioning or B confirmation does not clear it. |
| exit | Retains bed-exit risk after previously verified rest when all shoulders/hips move out, or when both hips move outside after crossing the bed edge. Ordinary entry across the bed edge is distinct from leaving a previously resting position. |
| pose | Temporary fallback to the original posture result when location cannot be verified. A restored location interpretation may refine this to a check request, but cannot erase actual descent, outside-bed or bed-exit risk. |

Sustained risks still require the original posture confirmation conditions before showing Suspected Fall or sounding the alert. They clear after the original reliable-upright recovery observation, or when the old track expires. Another person’s suspected fall retains highest priority. Verification changes, missed detections and new tracking IDs do not transfer bed-entry evidence or risk to another person.

A seated pose with both hips reliably inside the bed can still start bed-entry evidence; shoulders may be outside the bed edge. A continuous, smooth transition through the boundary into inside no longer automatically creates outside-bed risk. Resting in Bed still requires a complete, reliable sequence from the same person: at least 1 second, at least 6 samples, at least 30° of angle change, no abnormal descent or sustained risk, then both shoulders and hips inside the bed followed by approximately 3 seconds of stable observation. All values are unchanged. Missing entry history, abrupt rotation or an occluded sequence can only produce Check Person. Hip overlap alone or remaining at the boundary cannot confirm rest.

## Independent verification introduced in v4

- Divide the fixed background into an 8×6 tile grid and apply the combined bed/person exclusion mask. Flat or occluded pixels are not verification evidence. At least 6 textured, spatially distributed tiles are required for possible appearance support.
- When brightness-normalized appearance at the original position is highly consistent (median correlation at least .92; at least 80% of tiles at .8), retain verified. This can reject a false displacement explanation caused by repeated features.
- When feature displacement exceeds the existing limits, align the current background using the fitted transformation. Independent appearance support is required (median at least .8; at least 75% of tiles at .8), with at least .15 improvement over the original position, before accumulating movement evidence. Two consecutive mutually consistent displacements are still required before the outline turns red. Insufficient evidence means uncertainty, rather than confirmed movement or safety.
- Lightly smooth background appearance and, after displacement alignment, search at most ±2 pixels per tile to tolerate resizing and fitting residuals. Downsample the mask consistently; the search cannot use bed/person pixels.
- These numbers are interpretable prototype heuristics, not dataset-validated accuracy measurements. They affect view verification only; fall angles, confirmation duration and motion-risk thresholds are unchanged.
- Retain only one low-resolution masked grayscale background reference and mask in RAM. No images or videos are saved or uploaded. The original reference is not replaced automatically.

## Behavior at this stage

| Calibration state | Outline and location evidence | Behavior |
|---|---|---|
| verified | Blue in this historical version; the manually confirmed bed zone may be used | Resting in Bed requires complete smooth bed entry and approximately 3 seconds of stable observation. Missing history produces Check Person. |
| verified + boundary | The blue bed zone remains valid, but shoulders/hips partly overlap its edge | Start with Check Person. A complete entry into inside may continue stability checks; boundary does not latch outside risk. |
| occluded, first 2 seconds | Yellow; only a low-confidence estimate from the old bed zone, while trusted zone remains unknown | Cannot confirm rest. An inside-bed estimate without observed risk produces Check Person. |
| occluded, after 2 seconds | Yellow; the old polygon is no longer used for location decisions | The same track, previously inside without abnormal evidence, remains Check Person with current location explicitly unknown. Timeout alone does not create a new fall. |
| possible movement | Yellow; immediately disable the old location estimate | Wait for the original reference to match again or a second consistent displacement. Cannot confirm rest. |
| view changed / dimensions changed | Red; old calibration disabled | Rebuild view association and require confirmation/recalibration. Do not keep using the old bed zone. |
| unconfirmed / editing | Yellow; the current scene has not been confirmed | Cannot determine rest. Evaluate through the original posture flow. |

Background checks continue to use fixed features outside the bed, its margin and person boxes, without automatically replacing the reference. Bidirectional consistent matching, spatial support, independent background-alignment verification and consecutive displacement consistency jointly inform view decisions. Too few features mean verification is unavailable, not that the camera has moved. Repeated failures do not extend the 2-second grace period; suspected displacement is not cleared by later weak matches to re-enable location estimates.

Background-verification fluctuations interrupt bed-entry/rest evidence but preserve motion history, existing risks and the original confirmation timer. Abnormal descent observed during occlusion therefore remains relevant. Background recovery restores location verification only; rest requires a new continuous bed-entry sequence.

Previously inside-bed information belongs only to the same temporary track. It supports a request to check, not confirmation of current position. It is not transferred after track expiry or ID reconstruction. New people appearing after the grace period and people without a bed-zone association are evaluated through the original rules; another person’s suspected fall always takes priority.

## Risk handling retained

- Observed actual descent, an outside-bed suspected pose with all shoulders/hips outside, and exit risk after previous rest are not erased by a yellow outline, reconfirmation or later movement onto the bed. Pure rotation and boundary overlap are separate hints and must not be described as actual descent or the whole body being outside the bed.
- The original pose_features, update_status, keypoint confidence, angle/box-ratio/lower-limb thresholds, 1.5-second timer and model inference parameters are unchanged. The original state can still be Suspected Fall while the final contextual state is Check Person or Resting in Bed.
- The Windows MessageBeep call and once-per-device-episode sound mechanism are unchanged. This stage adjusts the final-state/sound-trigger conditions; it should not be described as having no effect at all on alert behavior.
- Lost keypoints/tracks produce Tracking Lost, not normal or recovered. Temporary IDs are not personal identities; no recognition or permanent profiles are added.
- Historical CSV / JSONL / Supabase events are not modified or deleted. CSV retains its original four columns and continues appending.

## New diagnostics

The local preview displays beside each person:

- Bed: inside / outside / boundary / unknown; a temporary estimate also says recent inside estimate.
- Pose: original posture state -> final state, for example Suspected Fall -> Check Person.
- The reason for the current state, for example Bed view unverified; current location unknown; check person.
- Evidence: the first time and then-current location for boundary/rotation/descent/outside/exit/pose. For example, descent@+0.3s/boundary means descent was first observed 0.3 seconds after this temporary track began, while at boundary; it does not describe the current position. Repeated evidence of the same source does not overwrite the first observation. Sustained-risk reasons include observed at ...; read Bed separately for current location.

The bottom of the preview displays Calibration: verified / occluded / possible movement / view changed, retaining the detailed background-matching reason. Yellow means uncertainty; red means confirmed view invalidation. English text accompanies both colors.

Version 4 also displays Background: identity (appearance correlation at the original position) and the usable tile count. Displacement candidates display Shift (normalized displacement), inliers (feature inliers), alignment (appearance scores after displacement alignment versus the original position), and checks (consecutive support count). These are diagnostic clues, not fall probabilities. Red-outline evidence is written into the existing Bed Calibration reason. Text wraps automatically and no longer retains an old Outline confirmed message.

Calibration and grace-period-expiry transitions are appended to context_events.jsonl through existing Bed Calibration events. Person-state events include full Evidence; changes in sources or removal of a boundary hint generate one event rather than per-frame countdown logs, without deleting old risk events. The preview shows only the first 110 characters; inspect local JSONL for full evidence. Cloud handling retains existing permissions and the 160-character reason limit. Original and final states use existing snapshot fields; no database fields, bed coordinates, images or keypoints are added.

## Updating and demonstrating

1. Fully exit the old monitor and back up the project. Extract SafeNest_AI_Bed_Rest_Fix.zip into the project root, overwriting matching files; do not extract into web/. The patch contains no .env, web configuration, models, logs or camera profiles.
2. Run in the existing virtual environment:

   ```bat
   python fall_detection.py
   ```

3. Check that Evidence: ... now appears beside each person and Background: identity ... is still present. Let camera exposure/focus stabilize at startup. Position the camera, then use B / Enter / the top Confirm control to verify the bed outline, or C to redraw an inaccurate outline. Keep the frame empty for approximately 5–10 seconds and confirm calibration stays verified before testing. If it turns red before anyone enters, retain the displacement diagnostics or Bed Calibration reason from context_events.jsonl; do not test rest against an invalid bed zone. Confirmation verifies the bed zone, not that a person is safe.
4. Safely simulate sitting on the bed edge → smoothly lying down across the boundary → shoulders and hips all entering the bed zone → staying stable. Crossing the boundary may produce Check Person; only a complete reliable sequence can produce Resting in Bed. Fast lying down, an incompletely observed sequence or staying at boundary should produce Check Person. Do not enlarge the bed zone to include the floor just to obtain rest. Temporary background-verification failure alone does not create a new fall, but someone must still check.
5. Occlusion lasting over 2 seconds should show unknown location and Check Person. Background recovery does not automatically restore rest. Someone already lying down or missing entry history should also require a check; a single horizontal pose cannot confirm sleep.
6. If Suspected Fall remains, inspect Evidence for descent, outside, exit or pose and the observed at ... location. Boundary alone cannot leave outside risk, but previously recorded all-shoulders/hips outside posture or actual descent cannot be erased by later inside positioning. Do not repeatedly confirm or lower thresholds to clear observed risk. Version 5 does not treat pure rotation as descent; hip-keypoint jitter during ordinary movement may still be recorded as descent and needs further evaluation using continuous posture evidence.
7. Press R before moving the camera and recalibrate after changing its angle. Do not continue using the old outline during camera movement. Never ask an older adult to fall for testing.

This stage requires no Supabase SQL, Edge Function changes, Vercel publication, credential changes or new dependencies. It updates local Python modules, tests and documentation only. Nothing was deployed.

## Changed files and tests

| File | Change at this stage |
|---|---|
| room_calibration.py | Retained unchanged from v4; included in the cumulative patch so the background fix is preserved |
| context_monitor.py | Version 5 bed-edge entry rules; six evidence sources with first time/location; separate rotation and descent; risk logging and local Evidence diagnostics |
| tests/test_context.py | Two previous expectations updated: pure rotation/boundary alone requests a check and cannot confirm rest. Other existing tests retained. |
| tests/test_bed_entry.py | 18 new regressions for boundary entry, descent/outside/exit counterexamples, multiple people, verification/occlusion/expiry, recovery and logging |
| README.md | Current version and operation entry points |
| docs/CONTEXT_MONITORING.md | Verification, states, logs and installation steps |
| docs/BED_REST_FIX.md | This document |

```text
python -m unittest discover -s tests -v
138 tests passed

npm --prefix video_frontend test
116 tests passed, 0 failed, 0 skipped
```

Tests require no real cameras, model weights or cloud credentials. Synthetic sequence tests use real OpenCV ORB: an inside-bed seated pose gradually lies down → background becomes completely unverifiable beyond the grace period → the original-position background recovers. There are no false final fall events/sounds, while the original horizontal-pose conditions and confirmation timing remain intact. Tests also cover rapid descent during verification interruption, an independent outside-bed fall, track expiry, new IDs, displacement candidates and consistency, dimension changes, diagnostics, and logging grace-period expiry only once. Existing algorithm AST, multi-person, media, authorization and PostgreSQL tests continue to pass.

Version 4 coverage includes an empty fixed view with brightness changes followed by gradual bed entry; original-position appearance rejecting false displacement in repeated textures; unsupported transformations not accumulating evidence; masked pixels excluded from verification; bed/person regions zeroed in the RAM reference; supported real image displacement still turning red with evidence; clearing stale confirmation text; and diagnostic wrapping on small frames. A single screenshot was not treated as reproduction of the actual false positive, and user photographs were not used as synthetic sequences.

Version 5 adds synthetic trajectories covering the observed recording sequence. The original state may still reach Suspected Fall, but the complete normal entry across the boundary produces no final fall event/sound and does not clear the original confirmation start. Further tests retain the first boundary timestamp of actual descent after moving inside, prevent risk sources overwriting each other, prevent B clearing confirmed outside risk, check both hips leaving after rest, another person falling, missed detections/new IDs, background pauses, upright recovery, full JSONL sources and four-column CSV. No model was retrained, no model/dependency was added, and the user recording was not rerun through inference.

## Practical limitations

This is a heuristic RGB, two-dimensional bed-zone and temporary-tracking prototype. Insufficient background cannot prove the camera is stationary; two consistent displacement estimates do not guarantee correctness, and retained location estimates are not reliable positioning. During prolonged uncertainty, an unobserved incident involving the same previously inside-bed track may remain Check Person without an automatic fall sound. A new ID after the grace period can also return to the original horizontal-pose alert. Borrowing another ID’s bed state is not a safe solution.

Reducing false positives has a tradeoff: actual falls with an unobserved descent, only partial bed-zone overlap, or a bed incident without obvious descent may produce only Check Person without a fall sound. A two-dimensional bed polygon may overlap the projected floor beside the bed. Neither inside nor boundary confirms safety. Check Person requires an actual check, and Resting in Bed does not indicate medical safety. Posture/hip jitter may still trigger descent risk; thresholds must not be relaxed merely to pass a demonstration. Validate ordinary lying down, fast lying down, turning, occlusion, sliding from the bed and outside-bed sequences in the real view, recording false positives and missed events. This stage passes synthetic-trajectory and mocked tests and makes no real-world accuracy claim.
