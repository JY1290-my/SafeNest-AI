# Verification and manual acceptance checklist

## Automated verification for this stage

Full stage-specific results are in [MULTI_PERSON_CHANGES.md](MULTI_PERSON_CHANGES.md). Verification includes existing Python regressions and multi-person state/tracking tests, website state/authentication/media-lifecycle tests, and PGlite execution of the actual SQL for status-publishing and membership compatibility.

Real Windows camera/audio, multi-person occlusion, LiveKit cloud connections, campus networks and TURN still require practical acceptance checks. Unit tests are not real camera or phone tests.

Rerun tests in the activated environment:

```bat
python -m unittest discover -s tests -v
npm ci --prefix video_frontend
npm test --prefix video_frontend
```

Python media tests require requirements-video.txt and the existing opencv-python; they do not open a real camera. Database tests use the PGlite devDependency to simulate Supabase Auth schemas/roles locally. The real cloud project must also be checked.

## Required checks after deployment

| Scenario | Expected result |
|---|---|
| One person standing/walking normally | Computer and phone show Normal with continuous updates |
| Bending to pick something up / sitting | Original hip–ankle exclusion logic continues working; record actual false positives for the camera angle |
| Multiple people | Independent IDs/states; any suspected fall produces aggregate alert |
| Brief occlusion / empty view | Pose Unclear / No Person; missed detections are not normal evidence, and confirmation restarts after recovery |
| Crossing / merging | Reset temporary records when association is uncertain; never transfer confirmation time to another person |
| Safe simulated fall pose | Original thresholds produce Checking → Suspected Fall; CSV identifies the person; one sound per aggregate episode, rearmed after recovery |
| Signed out / forged JWT | video-token issues no token; no video |
| Account without members access | Both status and video denied |
| Family media permissions | Subscribe only to the assigned device; cannot publish video/data or select an unauthorized room |
| Wrong device secret | device-video-token rejects it; local detection continues |
| First viewing | Show Connecting/not connected until a real frame decodes, then Live |
| Stop / Sign out / phone background | Clear video srcObject and disconnect the room; the computer stops sending without viewers |
| Delete a members row | The next device sync/browser renewal removes that identity under normal networking; playback is not permanent |
| Abrupt page close / network loss | Remove the identity no later than lease expiry; stop publishing when the computer’s authorization result expires |
| Unplug camera / freeze detection | Do not loop old frames; after 2 seconds without a new decoded frame, stop showing phone video; stale status becomes Connection Lost |
| Monitoring computer loses internet | Detection/CSV/sound continue; remote status expires and video stops; after recovery, click to view again |
| Phone reconnects and returns to foreground | Clear the old frame; require fresh status and a new video start |
| No viewers | No LiveKit camera track; only small signaling/status requests remain, without continuous media bandwidth |
| Rate limits | Rapid repeated requests return 429; wait a minute rather than continually retrying |

SQL for testing membership removal (use real UUIDs; restore members afterward if needed):

```sql
delete from safenest_private.members
where device_id='DEVICE_UUID'::uuid and user_id='USER_UUID'::uuid;
```

Inspect active leases only with SQL Editor administrator privileges:

```sql
select device_id,user_id,identity,expires_at from safenest_private.video_sessions;
```

Do not print JWTs, device tokens or LiveKit secrets in debug logs/screenshots.

## Campus network checks

1. Connect the computer to school Wi-Fi and the phone to cellular data; verify HTTPS status and WebRTC separately.
2. Repeat using a personal hotspot to determine whether only the school network fails.
3. Inspect relay/TURN through LiveKit Dashboard/ICE statistics. If UDP is blocked, validate TURN/TLS on TCP 443. Seeing video alone does not prove a specific TURN path passed.
4. Test disconnect/recovery, computer sleep/wake and phone background/foreground, checking frozen-frame handling and reconnection.
5. Measure local YOLO FPS and CPU/bandwidth after View camera. Check the account’s LiveKit quotas/costs.
6. Confirm recording/Egress is disabled and Supabase contains no images, video files or storage bucket.

Do not promise recognition accuracy, notification reliability or a percentage reduction in falls without real test statistics.
