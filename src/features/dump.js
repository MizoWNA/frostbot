// Bot-side wrapper around the shared dump core (also used by the Supabase Edge Function).
import { sql } from '../db.js';
import { isFrozen } from './antinuke.js';
import { buildDump, saveLatest, latestDump as latestFromDb } from '../../supabase/functions/_shared/dumpCore.js';

export { dumpToText, parseDump, dumpSummary, dumpFileName } from '../../supabase/functions/_shared/dumpCore.js';

/** discord.js REST → the core's `api(path, query)` shape. */
const restApi = (rest) => (path, query) => rest.get(path, query ? { query: new URLSearchParams(query) } : undefined);

/**
 * Build a fresh dump and make it the cached "latest". Right after a detected nuke the
 * cache is left alone (unless save=true) so `latest` keeps the pre-nuke state.
 */
export async function generateDump(rest, guildId, source, { save = !isFrozen(guildId) } = {}) {
  const dump = await buildDump(restApi(rest), sql, guildId);
  if (save) await saveLatest(sql, dump, source);
  return dump;
}

export const latestDump = (guildId) => latestFromDb(sql, guildId);
