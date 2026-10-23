# Website update: floating camera, persistent follows, events, names and online family

## Existing users: update in this order

1. Back up the project. Merge updated sources at matching paths, preserving `.env`, `web/config.js`, models and CSV. No model retraining is required.
2. In **Supabase → SQL Editor → New query**, paste and run **all of** `cloud/website_improvements.sql`. It follows `schema.sql` → `video_schema.sql` → `family_schema.sql`. If those three are already installed, run only the new file. Old notes, members and events are preserved.
3. In Supabase **Realtime Settings**, disable **Allow public access** to enforce private-channel authorization. The migration adds SafeNest Presence-scoped RLS policies to `realtime.messages`; do not manually ALTER that service table. Presence does not require database replication for snapshots or notes.
4. In the original virtual environment at the project root, run:

   ```bat
   python configure_web.py
   ```

   This generates public website configuration from local `.env` and adds the exact Supabase `wss://` address to CSP. Do this before publication so old CSP does not block the Presence WebSocket. Device tokens are still not exported.
5. The ZIP includes built `web/video-client.js` and `web/presence-client.js`. Applying delivery files needs no Node dependency install. After changing browser-module source, rebuild with Node.js 22 or newer:

   ```bat
   npm ci --prefix video_frontend
   npm run build --prefix video_frontend
   npm test --prefix video_frontend
   ```

6. When ready, publish manually, still deploying only `web/`:

   ```bat
   cd web
   npx vercel@58.7.1 --prod
   ```

For local preview, restart `python fall_detection.py` after copying files so new static resources are served.

No cloud migrations, account settings or deployments were performed for you. Existing Supabase/LiveKit credentials need no rotation, and the video Edge Functions need no redeployment for this stage.

## Family usage

### Floating camera window

Click **View camera**, wait for live video, then select **Picture-in-Picture** at the top right.

- Supported browsers put the original video element into system PiP so you can work in Word, Excel or other applications. Keep the original browser tab open.
- If unsupported or rejected, use the draggable in-page mini-player. Drag its toolbar, or focus the toolbar and use arrow keys. **Return to page** or Esc restores its original position.
- The in-page fallback stays inside the current page and cannot float above other applications. Local JPEG preview uses this fallback.
- Standard video PiP contains video only; status cards, notes and custom page buttons do not automatically appear in the system window.
- PiP reuses the original LiveKit connection without requesting another room. Changing monitors, signing out, stale status or video disconnection closes the floating view and clears old video. Refresh still requires View camera.
- System PiP may continue when changing tabs. Ordinary preview/in-page fallback still pauses on hidden tabs under the existing rules. Closing the page stops video.
- Permissions, background sleep or network loss may stop playback. Follow the page’s prompts to view again after recovery. Mobile and browser PiP support varies.

### Redeem an invitation only once

First registration/sign-in → enter invitation → membership stored in Supabase → later logins show **Followed homes** directly.

Invitations authorize initial binding and are never stored in the browser. Later expiry/exhaustion does not delete established membership. One account can follow several monitors. F5 restores the current tab’s Auth session and rechecks server permissions. Signing into the same account on another browser/computer restores follows without redeeming again. Sign out clears the tab session, not Supabase membership.

After an administrator removes the corresponding `safenest_private.members` relationship, the server denies status, video, notes and online-roster requests. The page leaves that monitor and refreshes the list on its next check. At this historical stage, administration remains backend/SQL-based rather than browser member management.

### Recent events

The page sorts valid event timestamps newest first and shows at most 10. Legacy events or invalid timestamps keep their relative order after timestamped events. CSV, uploaded data and the server’s recent-30 snapshot retention are unchanged. Times continue using the original monitoring computer’s local clock interpretation.

### Note author names

In **Choose home → Your display name**, enter a nickname and select **Save name**. New accounts may use their signup name; existing accounts can add one here.

The server derives note authors from `auth.uid()` and Auth `display_name`; the browser sends only body and current device. Names and notes render as plain text. Empty or email-like names use **Family member**. Emails and user UUIDs are not shown.

The current nickname also labels historical notes by that account. A nickname is a display label, not a verified real name, and never grants permissions.

### Who is online

**Family online** shows family for the selected monitor only. No Presence channel is joined until one is selected.

- Pinned `@supabase/realtime-js` **2.117.3** is bundled separately into `web/presence-client.js`, reusing the existing Auth token without another Auth store or CDN dependency.
- The authorization-checked `family_presence` RPC renews the current tab’s short-lived session every 15 seconds. The server ignores sessions not renewed for 45 seconds. If roster verification has not succeeded for over 30 seconds, the client clears the online display and marks it unavailable.
- The roster deduplicates accounts: two tabs do not appear as two people. Family from other monitors is excluded.
- Presence sends only `{online:true}` and a random session key, without names, Auth user IDs, emails, notes or monitor states. Displayed names come from the server-authorized short-lived session roster, so forged Presence payloads cannot impersonate another family name.
- Only current members can join private channels. Membership/device-enable changes rotate channel identifiers. Remaining members change channels on the next renewal; revoked members cannot fetch the new channel/roster. Realtime caches authorization at join, so revocation propagation/channel changes take a short interval. Old channels contain no names or monitoring content.
- Logout, monitor switches and page exit clean up channels and the caller’s short-lived session. Server expiry is the fallback when network loss or abrupt browser closure prevents a leave request.
- Online means recently connected to that monitoring page, not necessarily watching video, available to respond immediately or aware of a particular event. Browser sleep, throttled background timers and network loss may delay updates. It is not an emergency-response mechanism.

If only online family is unavailable while status/video work, check the new SQL, private Realtime settings and Supabase WSS CSP entry, then refresh.

## Verification commands and post-deployment demonstration

```bat
npm test --prefix video_frontend
python -m unittest discover -s tests -p "test_*.py"
```

Automated tests use mocked media/network and a local PostgreSQL engine for RPC/RLS; no camera, model download or real service credentials are required.

Manual demonstration: sign in two accounts bound to the same device and open that monitor. Set their nicknames, verify online roster and note authors, then sign one out and check roster updates. Run the original monitoring program, view its camera in a desktop browser, enable PiP and open an office application. Switching monitors closes old video. Refresh restores linked monitors without starting video automatically. Confirm an unbound account cannot read device data or join the private channel.

Original fall detection, multi-person tracking, sound and model files remain unchanged for this stage. Only the website, configuration generator, frontend build, incremental SQL, documentation and related tests change.

Implementation references:
- https://supabase.com/docs/guides/realtime/authorization
- https://supabase.com/docs/guides/realtime/presence
- https://developer.mozilla.org/en-US/docs/Web/API/Picture-in-Picture_API
