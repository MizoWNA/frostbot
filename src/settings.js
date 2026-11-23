// Per-guild settings: loaded into memory once, written through to Postgres.
import { sql } from './db.js';
import { DEFAULTS } from './config.js';

const cache = new Map(); // guildId → Map(key → value)

export async function loadSettings() {
  const rows = await sql`select guild_id, key, value from frostbot.settings`;
  cache.clear();
  for (const r of rows) {
    if (!cache.has(r.guild_id)) cache.set(r.guild_id, new Map());
    cache.get(r.guild_id).set(r.key, r.value);
  }
}

export function getSetting(guildId, key) {
  const v = cache.get(guildId)?.get(key);
  return v ?? DEFAULTS[key] ?? null;
}

export const getBool = (g, k) => getSetting(g, k) === 'on';
export const getNum = (g, k) => Number(getSetting(g, k)) || 0;

export async function setSetting(guildId, key, value) {
  if (!cache.has(guildId)) cache.set(guildId, new Map());
  if (value === null || value === undefined) {
    cache.get(guildId).delete(key);
    await sql`delete from frostbot.settings where guild_id = ${guildId} and key = ${key}`;
  } else {
    cache.get(guildId).set(key, String(value));
    await sql`
      insert into frostbot.settings (guild_id, key, value) values (${guildId}, ${key}, ${String(value)})
      on conflict (guild_id, key) do update set value = excluded.value`;
  }
}
