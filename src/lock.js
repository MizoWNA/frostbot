// Only one FrostBot may run at a time (two copies would mirror every message twice).
// A heartbeat row in Supabase: a second copy waits until the first stops (or goes silent
// for 90s), then takes over. Handy when moving from the local machine to Bot-Hosting.

import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { sql } from './db.js';

const ME = `${os.hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`;
const STALE = '90 seconds';
let timer = null;

export const lockHolderId = ME;

/** Is a process with this pid running on this machine? */
function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // exists but isn't ours
  }
}

export async function acquireLock() {
  let warned = false;
  for (;;) {
    const got = await sql`
      insert into frostbot.instance_lock (name, holder, heartbeat) values ('bot', ${ME}, now())
      on conflict (name) do update set holder = excluded.holder, heartbeat = now()
      where frostbot.instance_lock.heartbeat < now() - ${STALE}::interval or frostbot.instance_lock.holder = ${ME}
      returning holder`;
    if (got.length) break;
    const [cur] = await sql`select holder, heartbeat from frostbot.instance_lock where name = 'bot'`;
    // Our own previous run on this same machine/container that died without releasing the lock
    // (e.g. a panel restart killed it): take over right away instead of waiting 90 s.
    const [host, pid] = (cur?.holder ?? '').split(':');
    // (Containers reuse pids: same pid as ours but a different holder id means it's a dead run.)
    if (host === os.hostname() && (Number(pid) === process.pid || !alive(Number(pid)))) {
      const took = await sql`update frostbot.instance_lock set holder = ${ME}, heartbeat = now()
                             where name = 'bot' and holder = ${cur.holder} returning 1`;
      if (took.length) {
        console.log(`[lock] previous run here (${cur.holder}) is gone, taking over`);
        break;
      }
    }
    if (!warned) console.warn(`[lock] another FrostBot is running (${cur?.holder}, last heartbeat ${cur?.heartbeat?.toISOString()}). Waiting for it to stop…`);
    warned = true;
    await new Promise((r) => setTimeout(r, 15_000));
  }
  console.log(`[lock] this instance is active (${ME})`);
  timer = setInterval(async () => {
    try {
      const r = await sql`update frostbot.instance_lock set heartbeat = now() where name = 'bot' and holder = ${ME} returning 1`;
      if (!r.length) {
        console.error('[lock] another instance took over, shutting this one down');
        process.exit(1);
      }
    } catch (e) {
      console.error('[lock] heartbeat failed (will retry):', e.message);
    }
  }, 30_000);
}

export async function releaseLock() {
  clearInterval(timer);
  await sql`delete from frostbot.instance_lock where name = 'bot' and holder = ${ME}`.catch(() => {});
}
