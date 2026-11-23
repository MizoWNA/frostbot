// Live record of every member's roles. Kept up to date on member updates, frozen
// while a nuke is being handled (so a nuker stripping roles doesn't overwrite it).

import { sql } from '../db.js';
import { getBool } from '../settings.js';
import { isFrozen } from './antinuke.js';

const roleIds = (member) => [...member.roles.cache.filter((r) => r.id !== member.guild.id && !r.managed).keys()];

const rowFor = (member) => ({
  guild_id: member.guild.id,
  user_id: member.id,
  user_tag: member.user.tag,
  roles: sql.json(roleIds(member)),
  updated_at: new Date(),
});

const UPSERT = (rows) => sql`
  insert into frostbot.member_roles ${sql(rows)}
  on conflict (guild_id, user_id) do update
    set user_tag = excluded.user_tag, roles = excluded.roles, updated_at = excluded.updated_at`;

export async function saveMember(member) {
  if (isFrozen(member.guild.id)) return;
  await UPSERT([rowFor(member)]).catch((e) => console.error('[memberRoles]', e.message));
}

/** Bulk-sync everyone currently in the server (run on startup). */
export async function syncAll(guild) {
  if (isFrozen(guild.id)) return;
  const rows = [...guild.members.cache.values()].map(rowFor);
  for (let i = 0; i < rows.length; i += 500) await UPSERT(rows.slice(i, i + 500));
}

export async function savedRoles(guildId, userId) {
  const [row] = await sql`select roles from frostbot.member_roles where guild_id = ${guildId} and user_id = ${userId}`;
  return row?.roles ?? null;
}

/** Rejoin → give saved roles back (if rolepersist is on). Skips roles the bot can't assign. */
export async function onRejoin(member) {
  if (!getBool(member.guild.id, 'rolepersist')) return 0;
  const ids = await savedRoles(member.guild.id, member.id);
  if (!ids?.length) return 0;
  const me = member.guild.members.me;
  const roles = ids
    .map((id) => member.guild.roles.cache.get(id))
    .filter((r) => r && !r.managed && r.position < me.roles.highest.position);
  if (!roles.length) return 0;
  await member.roles.add(roles, 'Role persistence: rejoined').catch(() => {});
  return roles.length;
}
