# Multi-person detection update (2026-10-15)

## Problem addressed

In the uploaded `source_only.zip`, the `count > 1` branch in `fall_detection.py` set `Multiple People` and cleared confirmation timing; subsequent posture analysis used only person index 0. This version processes every original detection separately, with independent state, confirmation timing and last-seen time.

The original `pose_features`, `update_status`, four thresholds and `model.predict(conf=0.5, iou=0.5)` are unchanged, as are model weights. The camera still opens once, and the video publisher reuses the frame annotated with skeletons and person labels.

## Updating and running

1. Stop detection and back up the current project.
2. Extract **SafeNest_AI_MultiPerson_Update.zip** at the original project root so its `fall_detection.py` replaces the original at the same location. Confirm the new `multi_person.py` is also at the root.
3. The update contains no real `.env`, device token, `web/config.js`, `web/vercel.json`, model or historical CSV. Preserve your existing files; no credential rotation or reinstall of the GPU environment is needed.
4. Activate the existing Windows virtual environment and start:

```bat
cd /d C:\Users\Default.DESKTOP-QHM9VSV\Desktop\elderly_fall_ai
.venv\Scripts\activate.bat
python fall_detection.py
```

Press Q to exit. The local browser still uses `http://127.0.0.1:8765`. Existing family sign-in, invitations, monitored-device switching, notes and on-demand LiveKit continue using their original configuration.

**Supabase: no new SQL or Edge Function redeployment is required for this stage.** The original publishing RPC receives the aggregate device state, with person IDs in event text. A device can monitor multiple people in one view; permission remains scoped to the device/monitoring area, without separate per-person access.

**Vercel: multi-person detection runs in local Python.** The deployed website can read new event text. To color `Person 2: Suspected Fall` red as well, update the website’s `web/dashboard.js` and publish `web/` using the existing process. This delivery did not deploy anything.

## Tracking and compatibility

The uploaded dependency requirement is `ultralytics>=8.3,<9`, without the exact installed version recorded. At startup, this version prefers the installed package’s `bytetrack.yaml` and built-in `BYTETracker`, printing the actual version.

To preserve inference parameters and avoid `model.track()` filtering unconfirmed new people in some versions, the original `model.predict()` runs first and its person boxes are then passed to ByteTrack. The original detection index in each returned row associates temporary IDs; skeletons always use original detection indices, never tracker-return order. People without a tracker ID also receive immediate independent analysis.

If optional `lap`/`scipy` dependencies are missing or the tracker interface is incompatible, report this and use the project’s conservative box-association fallback. Tracking dependencies are not installed automatically; no new mandatory dependency or retraining is required. Fallback ID continuity is weaker during fast motion and occlusion.

References: [Ultralytics tracking](https://docs.ultralytics.com/modes/track/), [BYTETracker API](https://docs.ultralytics.com/reference/trackers/byte_tracker/).

## States and alert sound

Each person follows the original rules; a suspicious pose must still last 1.5 seconds to reach `Suspected Fall`. Aggregate device priority is:

`Suspected Fall` → `Checking` → `Pose Unclear` → `Normal`。

- No current detections: aggregate `No Person`, which does not establish safety.
- Someone briefly disappears while others remain: retain that person as `Pose Unclear` for up to 2 seconds, preventing another person’s normal state from immediately hiding uncertainty.
- Brief disappearance clears that person’s confirmation timer; invisible time does not count toward 1.5 seconds after reappearance. Clear spatial association may retain the displayed ID.
- Crossing, merging or conflict between native ID and spatial association: abandon uncertain old records, allocate new IDs and restart confirmation. An old person’s timer cannot trigger an alert for a newcomer.
- Records expire after over 2 seconds unseen. IDs are not reused within one run; restarting begins at Person 1.

Sound remains `winsound.MessageBeep(MB_ICONEXCLAMATION)`. The earlier code called it on every suspected-fall frame; this version deduplicates as requested: **one sound per device-level alert episode**. Simultaneous suspected falls sound once but are logged separately. Sound can rearm after everyone returns to `Normal`, or all old-scene tracks time out. Brief `Checking`, `Pose Unclear` or `No Person` does not immediately rearm it, avoiding repeated sounds from occlusion.

## Logging and cloud compatibility

Continue appending `events.csv` with its original four columns, `time,status,angle_deg,width_height_ratio`, without rewriting old rows or changing the header incompatibly.

New event examples:

```text
Person 1: Normal
Person 2: Checking
Person 2: Suspected Fall
Suspected Fall
Person 2: Pose Unclear
Person 2: Track Reset
Person 2: Track Expired
```

Person and aggregate events are logged only on change. `Track Reset` means uncertain association; `Track Expired` means an expired temporary record. Neither is a fall decision. The most recent 30 events still publish through the original interface, and the website renders them as safe text. Old CSV history and event-ID handling remain compatible.

## Automated verification and local demonstration

Rerun in the environment with existing dependencies:

```bat
python -m unittest discover -s tests -v
npm ci --prefix video_frontend
npm test --prefix video_frontend
```

Python tests use mocked cameras and pose results without real hardware or model weights. Existing media tests use LiveKit SDK and OpenCV, so the project’s original dependencies are still required.

You can also verify the real ByteTrack interface in an existing YOLO environment without loading a model or camera:

```bat
python tests/check_native_tracker.py
```

This script explicitly reports unavailable native dependencies rather than counting fallback tracking as a successful native test. Detection can still use fallback association.

Manual demonstration sequence:

| Scenario | Expected result |
|---|---|
| Two people standing separately | Separate temporary IDs and Normal states; aggregate Normal |
| One stays normal while another safely lies on a soft mat | That person goes Checking → Suspected Fall; aggregate follows, with one sound |
| Two people retain suspected-fall poses | Both person events are logged; sound does not repeat per frame |
| Recover normally, then simulate again | A new episode can sound again |
| Briefly obscure one person while the other is normal | Aggregate does not immediately become Normal; reappearance requires posture confirmation again |
| People cross or overlap heavily | Old timers are not transferred; ID resets and confirmation delay are acceptable |
| Everyone leaves the view | No Person, without confirming that nobody is at risk |
| A family member views video on demand | The same annotated frame with person IDs is visible |

Never demonstrate actual falls. Use safe poses or prerecorded clips.

## Limitations

Temporary IDs are not names or permanent identities and cannot guarantee continuity after crossings/occlusion. Replacement at the same location, severe occlusion, small distant people, low light, fast motion or low frame rates may cause misses, ID changes and confirmation delays. Fallback box association is especially conservative.

The existing algorithm detects sustained fall-like posture. This update does not fully distinguish sleeping from falling and adds no action prediction or medical diagnosis. Multi-person support does not guarantee accuracy. A camera assesses only its field of view; multiple rooms require their own monitoring equipment.

Automated tests cannot replace real Windows camera/audio, people moving and occluding each other, network or LiveKit acceptance checks. See `MULTI_PERSON_CHANGES.md` in this directory for stage-specific results and changed files.
