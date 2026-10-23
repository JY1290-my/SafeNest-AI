// Run from the project root after npm --prefix video_frontend ci.
// Writes a NEW private file; never prints keys or overwrites an existing file.
import {writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import webpush from '../video_frontend/node_modules/web-push/src/index.js';
const keys=webpush.generateVAPIDKeys();
const output=new URL('../supabase/.env.push.local',import.meta.url);
await writeFile(output,`SAFENEST_VAPID_PUBLIC_KEY=${keys.publicKey}\nSAFENEST_VAPID_PRIVATE_KEY=${keys.privateKey}\nSAFENEST_PUSH_DISPATCH_SECRET=${randomBytes(32).toString('hex')}\nSAFENEST_VAPID_SUBJECT=https://REPLACE_WITH_YOUR_WEBSITE\n`,{flag:'wx',mode:0o600});
console.log('Created supabase/.env.push.local. Edit the HTTPS subject locally; keep this file private. No keys were printed.');
