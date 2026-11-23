// Frostbot dump API (Supabase Edge Function). Builds structure dumps straight from
// Discord's REST API, so it works even while the bot itself is offline.
//
//   GET .../functions/v1/frostbot-dump/dump.json    fresh dump (also becomes the cached latest)
//   GET .../functions/v1/frostbot-dump/dump.txt     fresh dump, human-readable
//   GET .../functions/v1/frostbot-dump/latest.json  last generated dump, no rebuild
//   GET .../functions/v1/frostbot-dump/latest.txt
//   GET .../functions/v1/frostbot-dump/health       no auth
//   Header: Authorization: Bearer <API_TOKEN>
//
// Secrets (supabase secrets set ...): DISCORD_TOKEN, MAIN_GUILD_ID, API_TOKEN.
// SUPABASE_DB_URL is provided by Supabase automatically.

// Deno-native build: the npm build garbles large rows on the hosted Edge runtime.
import postgres from 'https://deno.land/x/postgresjs@v3.4.5/mod.js';
import { buildDump, dumpToText, saveLatest, latestDump, nukeFreezeActive, dumpFileName } from '../_shared/dumpCore.js';

const env = (k: string) => Deno.env.get(k) ?? '';
const DISCORD_TOKEN = env('DISCORD_TOKEN');
const GUILD_ID = env('MAIN_GUILD_ID');
const API_TOKEN = env('API_TOKEN');

const sql = postgres(env('SUPABASE_DB_URL'), { prepare: false, max: 1, idle_timeout: 10 });

/** Minimal Discord REST client with 429 handling. */
async function api(path: string, query?: Record<string, string>) {
  const url = new URL(`https://discord.com/api/v10${path}`);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bot ${DISCORD_TOKEN}`, 'User-Agent': 'DiscordBot (frostbot, 1.0)' } });
    if (res.status === 429) {
      const body = await res.json().catch(() => ({}));
      await new Promise((r) => setTimeout(r, Math.ceil((body.retry_after ?? 1) * 1000)));
      continue;
    }
    if (!res.ok) throw new Error(`Discord ${res.status} on ${path}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
  throw new Error(`Discord kept rate limiting ${path}`);
}

const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
async function authed(req: Request) {
  const got = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const [a, b] = await Promise.all([digest(got), digest(API_TOKEN)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0 && API_TOKEN.length > 0;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

Deno.serve(async (req) => {
  if (req.method !== 'GET') return json(405, { error: 'GET only' });
  const path = new URL(req.url).pathname.replace(/\/+$/, '');

  if (path.endsWith('/health')) return json(200, { ok: true, configured: Boolean(DISCORD_TOKEN && GUILD_ID && API_TOKEN) });

  const m = path.match(/\/(dump|latest)\.(json|txt)$/);
  if (!m) return json(404, { error: 'not found', try: ['/dump.json', '/dump.txt', '/latest.json', '/latest.txt'] });
  if (!(await authed(req))) return json(401, { error: 'bad or missing token' });
  if (!DISCORD_TOKEN || !GUILD_ID) return json(500, { error: 'DISCORD_TOKEN / MAIN_GUILD_ID secrets not set' });

  try {
    const [, kind, ext] = m;
    let dump;
    if (kind === 'dump') {
      dump = await buildDump(api, sql, GUILD_ID);
      // Right after a detected nuke, don't overwrite the (good) cached copy with the damage.
      if (!(await nukeFreezeActive(sql, GUILD_ID))) await saveLatest(sql, dump, 'api');
    } else {
      dump = await latestDump(sql, GUILD_ID);
      if (!dump) return json(404, { error: 'no dump generated yet, hit /dump.json first' });
    }
    const headers = {
      'Content-Type': ext === 'txt' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${dumpFileName(dump, ext)}"`,
      'Cache-Control': 'no-store',
    };
    return new Response(ext === 'txt' ? dumpToText(dump) : JSON.stringify(dump, null, 2), { status: 200, headers });
  } catch (e) {
    console.error(e);
    return json(500, { error: 'dump failed', detail: String((e as Error).message ?? e) });
  }
});
