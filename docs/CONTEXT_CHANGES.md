# Context monitoring delivery record — 2026-10-16

## Source inspection

The input was version 2 of `SafeNest_AI_MultiPerson.zip`, already containing the five website improvements. Detection applies `pose_features` and `update_status` to each person. Native ByteTrack provides association hints only; ambiguous spatial association resets the temporary track. The previous flow cleared confirmation time during occlusion. The updated main program explicitly pauses it instead, while the original default remains available for legacy regression tests.

The original angle, bounding-box ratio, ankle exclusion rules, confidence, 1.5-second confirmation, YOLO predict parameters and system sound are retained. A bed zone cannot cancel a suspected fall already confirmed by the baseline rules, so this version does not eliminate every sleeping-posture false alert.

## Test results

- Before changes: Python 39/39; JavaScript/PostgreSQL 93/93.
- After changes: `python -m unittest discover -s tests -v`: 68/68 passed.
- `npm test --prefix video_frontend`: 101/101 passed, including actual PGlite PostgreSQL migrations/RPC/RLS, frontend session/member revocation, PiP, Presence, LiveKit tokens and connection lifecycle tests.
- `python tests/check_native_tracker.py`: real ByteTrack interface tests passed in an existing Ultralytics 8.3.0 dependency environment, without model execution or camera access. The initial test environment correctly reported missing optional tracker dependencies; verification then reused installed native dependencies without adding an installation.
- Added synthetic OpenCV-frame tests for unchanged backgrounds, masked person regions, camera translation and insufficient texture for calibration.
- AST comparison: both original pose functions, key thresholds and the predict call match. Comparison with the input ZIP confirmed that the video publisher, video/Presence bundles, cloud Auth client, existing SQL, video Edge Functions and model files were retained.
- Synthetic-preview visual inspection completed; no real surveillance video was used.

Tests need no physical camera, model-weight inference or LiveKit/Supabase credentials. User services were not contacted or deployed. Windows audio, USB cameras and an on-site person demonstration still require user acceptance checks.

## Manual steps

1. When applying the update, retain your `.env`, `web/config.js`, `web/vercel.json`, model and logs.
2. Cloud users run `cloud/context_monitoring.sql` after the existing migrations. Local-only use does not require it.
3. Start `python fall_detection.py`, click Calibrate room or press C, mark the bed boundary in order and press Enter to save. After restart, check the outline and press B to confirm or C to redraw. Press R to clear the current bed zone before moving the camera, then recalibrate the new view.
4. Publish `web/` yourself for remote viewing. This delivery performs no deployment and requires no key replacement or video Edge Function update.

See [CONTEXT_MONITORING.md](CONTEXT_MONITORING.md) for detailed operation, heuristic parameters and limitations.

## Changed files (22 total)

- `.env.example`
- `.gitignore`
- `README.md`
- `cloud/context_monitoring.sql`
- `context_config.example.json`
- `context_monitor.py`
- `docs/CONTEXT_CHANGES.md`
- `docs/CONTEXT_MONITORING.md`
- `fall_detection.py`
- `monitor_bridge.py`
- `multi_person.py`
- `room_calibration.py`
- `tests/context-database.test.mjs`
- `tests/family-ui.test.mjs`
- `tests/presence-database.test.mjs`
- `tests/status.test.mjs`
- `tests/test_context.py`
- `tests/test_monitor.py`
- `video_frontend/package.json`
- `web/dashboard.js`
- `web/index.html`
- `web/logic.js`
