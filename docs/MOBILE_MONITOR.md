# Mobile family monitor — 2026-10-17

The interface is English. This update builds on the delivered MultiPerson + context-monitoring source package. Nothing was deployed.

## Concept → existing capability → this update

| Concept | Existing project | Implementation |
|---|---|---|
| Room / home selector | Authenticated `list_my_monitors`, account membership and saved selection | Reused Choose home; no public device search |
| Live status / time | `read_monitor`, stale-state handling, local status endpoint | Reused status card, camera health, heartbeat age and observation time |
| Pose skeleton / multiple people | Python plots the pose and person labels before publishing annotated frames | Reused the same video; textual guide added; no browser model or uploaded keypoints |
| Camera preview | One authorized on-demand LiveKit room; local authenticated JPEG preview | Reused View camera / Stop camera view |
| Floating view | Native PiP with movable in-page fallback | Preserved top-right Picture-in-Picture |
| Camera | No screenshot action | Local PNG screenshot from decoded current video / JPEG frame |
| Record | No recorder | Manual video-only recording from clones of the existing live video track |
| Replay | Latest 10 authorized events; no video archive | Reuses that event list and shows actual in-memory manual clips |
| PTZ | Webcam capture; no authorized motor-control interface | No fake PTZ button; Settings explains unavailability |
| Settings | Home/name management in account chooser; laptop calibration | Real session text-size preference and links-by-instruction to existing flows; privacy/notification/calibration guidance |
| AI Prediction | No complete validated predictor, weights/input contract/tests | No switch; Settings says prediction model is not configured |
| Family / notes / presence | Membership-checked RPCs and private Presence | Preserved |

## Buttons and storage

1. Sign in, select a followed home, and choose **Open monitoring**. Camera viewing never starts automatically, including after refresh.
2. Select **View camera**. Wait until a real decoded frame arrives. The status connection and video connection remain separate.
3. **Camera** makes a PNG of the displayed annotated feed. It tries a browser download and also exposes **Download screenshot** for browsers that block asynchronous downloads. Only the most recent pending screenshot link is retained. Nothing is uploaded or put in browser storage.
4. **Record** starts a video-only recording. **Stop recording** ends it and exposes the real clip in **Replay → Local clips**. Choose **Download recording** to keep it. There is no audio capture or microphone request. The original LiveKit track is never stopped by the recorder; only the recorder's owned clones are released.
5. **Replay** focuses the existing newest-10 event list. Events are not video files. Local manual clips are separate and are not claimed to match a particular detection event. With no clip, the page explicitly says there are no saved video clips. Files downloaded earlier can be opened in the device's own player; the webpage does not scan the Downloads folder.
6. **Settings** opens a keyboard-focusable section. Larger text is a real preference for this page session. Account name, invitations and home selection remain in **Choose home**. No detector thresholds can be edited here.

Downloads go to the browser's chosen download location or mobile save/share flow. They contain the actual visible room/person imagery; manage and delete downloaded files on your device. Signing out clears temporary webpage media, but cannot erase an already downloaded file.

### Limits and cleanup

- Recording uses feature-detected `MediaRecorder` / `MediaStream`; tries supported WebM/MP4 formats. There is no new dependency.
- Maximum one recording at a time: 5 minutes or 64 MiB. A recording exceeding the byte limit is discarded with a message. Download completed clips promptly.
- At most 3 completed local clips with 64 MiB combined are retained in memory. Older clips are removed when a limit is reached. All blobs/object URLs are local to the page, not persistent browser storage.
- Switching homes, logout, lost authorization and page teardown discard in-progress recordings and clear clips/screenshot links. Late callbacks cannot recreate media for the old home. Stopping/disconnecting video stops recording; a completed clip can remain for that same authorized home until leaving it.
- Hiding the page stops recording even if native PiP keeps the live video visible. The recorder will not restart automatically. Browser/process termination may prevent finalization; unsaved clips can be lost. There is no background or continuous recording.
- Refresh clears temporary clips; it restores the authenticated selection only after a server membership check. A downloaded file persists independently.
- Local laptop JPEG preview supports screenshots, not recording. Use the configured LiveKit feed for recording. No second capture loop, room or camera permission request is introduced.
- Native PiP, download handling and recorder codecs depend on the browser/device. An unsupported recorder is disabled with an explanation. PiP keeps its existing draggable in-page fallback; that fallback cannot stay above other applications. Test actual target phones before a demonstration.
- The reference concept's purple skeleton and red “Emergency” legend were not copied as risk semantics. The real Python labels are green Normal, red Suspected Fall, amber other observations. Skeleton joint colors themselves are not risk categories. Suspected Fall remains an observation, not confirmed injury/emergency.

## PTZ, calibration and prediction

No PTZ hardware driver or authorized PTZ RPC/API was found. Controls are not invented. A future implementation needs a server/device-side authenticated command path, hardware support, and camera-view invalidation before calibration is reused. No camera credentials may enter the browser.

Calibration still runs on the laptop: **C** / Calibrate room draws the bed boundary; Enter saves; **B** confirms a visually checked unchanged view; **R** clears this camera/view's saved bed zone and draft points. Mark a new boundary after moving/rotating the camera. The mobile page does not remotely change calibration or detection thresholds.

No AlphaPose/LSTM, LightGBM or other validated prediction pipeline is enabled. Future work requires consented representative sequence data, labels, an explicit input/output contract, separated train/test identities and scenes, false-positive/missed-event evaluation, calibration and prospective validation. Experimental predictions must remain separate from detector status and local alarms. Temporary Person numbers are not stable identities or personal baselines.

## Update / local run

1. Back up your project. Apply the mobile update ZIP at the project root. Keep your `.env`, model files, calibration, CSV/JSONL logs, `web/config.js` and `web/vercel.json`.
2. **No new Supabase migration, Auth change, Realtime policy or Edge Function deployment is required by this mobile update.** Existing `schema.sql`, `video_schema.sql`, `family_schema.sql`, `website_improvements.sql`, `context_monitoring.sql` must already have been applied in their documented order. Do not rerun setup blindly or remove data.
3. Keep the existing pinned frontend bundles. New `web/camera-tools.js` is a plain module imported by `dashboard.js`; include it when copying website files. The local server allowlist now serves it and allows local blob video playback in CSP.
4. Activate your normal Python environment and run `python fall_detection.py` as before. Use your existing local address/password or configured hosted family webpage. This change does not modify detector startup, model settings or alarms.
5. For tests, install the existing pinned frontend dependencies with `npm ci` in `video_frontend/`. There are no added packages. Run `npm test`. `npm run build` is only needed if changing bundled LiveKit/Presence source; this update does not change those bundles.
6. Publish the updated `web/` yourself only when ready, using your existing Vercel process. This delivery did not deploy anything. No new secrets are needed.

## Demonstration

- At phone width, sign in and choose a home. Confirm status/heartbeat appear while Camera and Record remain disabled until View camera has live frames.
- Save a screenshot. Record a short clip, stop it, open Replay and download/play it. Verify no new upload request is made.
- Hide the page during recording: recording stops. Native PiP may keep viewing; recording must not continue or restart.
- Switch to a second authorized home: old camera, events, clips and screenshot link disappear. Its own events load. Sign out and confirm the same cleanup.
- Open Settings, change text size, and review PTZ/prediction/calibration limitations. Verify the laptop detection and sound still behave as before.
