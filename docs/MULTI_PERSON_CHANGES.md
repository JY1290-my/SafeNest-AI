# Multi-person detection: changes and validation

Baseline: the latest `source_only.zip` uploaded on 2026-10-15. This stage did not deploy or contact user cloud accounts.

## Changed files

| File | Change |
|---|---|
| `fall_detection.py` | Integrate per-person detection, tracking hints, person-state drawing and compatible event recording; deduplicate sound by overall alert episode |
| `multi_person.py` (new) | Original detection-index mapping, ByteTrack adapter, conservative fallback association, independent timers, occlusion/expiry handling, state aggregation, event and preview helpers |
| `web/dashboard.js` | Highlight per-person suspected-fall events in red; retain textContent rendering |
| `tests/test_monitor.py` | Retain original function/threshold/predict comparisons; update controlled multi-person inputs to the real main loop; ensure static serving excludes the new module |
| `tests/test_multi_person.py` (new) | 25 tests covering multi-person states, independent timers, association, occlusion, sound deduplication, native adapter, legacy CSV and metadata |
| `tests/check_native_tracker.py` (new) | Optional verification using real BYTETracker/Boxes without a model or camera |
| `tests/family-ui.test.mjs` | Test person-event highlighting and safe text rendering |
| `tests/video-database.test.mjs` | Extend actual SQL RPC tests for aggregate/person event round-trips, device tokens, membership and image-field filtering |
| `README.md` | Multi-person upgrade entry and current behavior; retain first-install instructions |
| `docs/MULTI_PERSON.md` (new) | Updating/running, native/fallback tracking, log compatibility, sound policy and demonstrations |
| `docs/MULTI_PERSON_CHANGES.md` (this file) | File list and validation results |
| `docs/FAMILY_ACCESS.md` | Clarify that membership grants device/monitoring-area access; person numbers are not identities |
| `docs/TEST_CHECKLIST.md` | Update multi-person and occlusion acceptance scenarios |

## Test results

| Check | Result |
|---|---|
| `python -m unittest discover -s tests -v` | **All 37 passed**: the original 12 regressions, including updated main-loop scenarios, plus 25 new tests |
| `npm test --prefix video_frontend` | **All 69 passed**: nine status tests and 60 in the Node report, including database child/parent tests |
| Native ByteTrack, Ultralytics **8.3.0** | Real CPU interface checks passed: two-person tracking, reversed detection order, original-index mapping and retention of new detections |
| Native ByteTrack, Ultralytics **8.4.177** | Same real interface checks passed; adapted to removal of the `frame_rate` constructor argument |
| Original decision functions/thresholds/inference parameters | AST comparison passed; retain `pose_features`, `update_status`, 0.4/60 degrees/1.0/1.5 seconds and predict conf/iou=0.5 |
| Cloud compatibility | PGlite executes the existing schemas/RPCs: aggregate status/person events can be published/read; unbound accounts still cannot read them |
| Historical logs | Tests passed for retaining the legacy CSV byte prefix, append/reload behavior, event IDs and four-column format |
| Original model and video/authorization core | Unchanged versus the uploaded package |

Tests ran in an isolated environment without replacing user Windows/GPU dependencies. Native tests used CPU PyTorch 2.5.1 and lap 0.5.12; these record the validation environment, not required reinstall versions. Project requirements were unchanged.

## Limits of physical validation

No real camera, Windows sound, YOLO inference or user Supabase/LiveKit/Vercel connection was used. Automated tests verify code flow, actual tracking interfaces and local database authorization; they do not establish real-world accuracy or frame rate.

Crossing/occlusion can make association ambiguous. This version conservatively discards old confirmation timing, which can delay confirmation. Temporary numbers are not names or permanent identities. One overall alert episode sounds once; additional people falling produce separate events without extra per-frame sound. See `MULTI_PERSON.md` for the full demonstration.

## Delivery archives

- `SafeNest_AI_MultiPerson_Update.zip`: only the 13 changed files above; extract directly into the original project root.
- `SafeNest_AI_MultiPerson.zip`: complete source under `source_only/`, retaining the model and public website configuration in that historical delivery.

Neither archive contains real environment secrets, existing event CSV data, local Vercel/Supabase linkage, caches or dependency directories. Preserve local configuration from the working project on first use of the full package; the update package does not overwrite it.
