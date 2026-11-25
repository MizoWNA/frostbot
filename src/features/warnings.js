// Warnings + the warning board (a sticky panel: stays the last message in its channel).

import { EmbedBuilder } from 'discord.js';
import { sql } from '../db.js';
import { getNum, getSetting, setSetting } from '../settings.js';
import { COLORS, truncate } from '../util.js';
import { registerSticky, updateSticky } from './sticky.js';

export async function addWarning(guild, user, modId, reason) {
  const [{ id }] = await sql`
    insert into frostbot.warnings (guild_id, user_id, user_tag, mod_id, reason)
    values (${guild.id}, ${user.id}, ${user.tag}, ${modId}, ${reason ?? null}) returning id`;
  return { id: Number(id), count: await warnCount(guild.id, user.id) };
}
/** Attach proof (links to the bot's messages holding the pictures) to a warning. */
export const addProof = (guildId, id, links) =>
  sql`update frostbot.warnings set proof = trim(coalesce(proof, '') || ' ' || ${links.join(' ')}) where guild_id = ${guildId} and id = ${id}`;

/** "📎 proof" links for a warning, for messages. */
// Proof pictures go to the private Supabase bucket `warn-proof` through the frostbot-proof
// edge function (it holds the service key; the bot only has API_TOKEN). Each file gets a
// permanent link that redirects to a short-lived signed URL.
const PROOF_URL = process.env.PROOF_URL || 'https://eafrclfpywnpblssswgo.supabase.co/functions/v1/frostbot-proof';
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', txt: 'text/plain' };

/** Upload downloaded files ({attachment: Buffer, name}) for a warning. Returns the links that worked. */
export async function storeProof(guildId, warnId, files) {
  if (!process.env.API_TOKEN) return [];
  const stamp = Date.now().toString(36);
  const out = [];
  for (const [i, f] of files.entries()) {
    const clean = f.name.replace(/[^\w.-]+/g, '_').replace(/^\.+/, '').slice(-80) || 'file';
    const path = `${guildId}/${warnId}/${stamp}-${i + 1}-${clean}`;
    try {
      const res = await fetch(`${PROOF_URL}/upload?path=${encodeURIComponent(path)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.API_TOKEN}`, 'Content-Type': MIME[clean.split('.').pop().toLowerCase()] ?? 'application/octet-stream' },
        body: f.attachment,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
      out.push((await res.json()).url);
    } catch (e) {
      console.error(`[proof] upload of ${f.name} for warning #${warnId} failed:`, e.message);
    }
  }
  return out;
}

export const proofLinks = (w) => (w.proof ? w.proof.split(/\s+/).map((u, i) => `[📎${w.proof.includes(' ') ? ` ${i + 1}` : ''}](${u})`).join(' ') : '');

export async function warnCount(guildId, userId) {
  const [{ n }] = await sql`select count(*)::int as n from frostbot.warnings where guild_id = ${guildId} and user_id = ${userId} and active`;
  return n;
}
export const listWarnings = (guildId, userId) =>
  sql`select * from frostbot.warnings where guild_id = ${guildId} and user_id = ${userId} and active order by created_at desc`;
export const getWarning = async (guildId, id) =>
  (await sql`select * from frostbot.warnings where guild_id = ${guildId} and id = ${id} and active`)[0];
export const removeWarning = async (guildId, id) =>
  (await sql`update frostbot.warnings set active = false where guild_id = ${guildId} and id = ${id} and active`).count > 0;
export const clearWarnings = async (guildId, userId) =>
  (await sql`update frostbot.warnings set active = false where guild_id = ${guildId} and user_id = ${userId} and active`).count;

const boardRows = (guildId) => sql`
  select w.user_id, max(w.user_tag) as user_tag, count(*)::int as n, max(w.created_at) as last,
    (select reason from frostbot.warnings x where x.guild_id = w.guild_id and x.user_id = w.user_id and x.active
       order by x.created_at desc limit 1) as last_reason
  from frostbot.warnings w where w.guild_id = ${guildId} and w.active
  group by w.guild_id, w.user_id order by n desc, last desc`;

export async function boardEmbed(guild) {
  const flag = getNum(guild.id, 'warn_flag');
  const all = await boardRows(guild.id);
  // Only people still in the server need action; banned/left members keep their history (frst warns).
  const rows = all.filter((r) => guild.members.cache.has(r.user_id));
  const gone = all.length - rows.length;
  const flagged = rows.filter((r) => r.n >= flag);
  const rest = rows.filter((r) => r.n < flag);

  const fmt = (r, hot) => {
    const dot = hot ? '🔴' : r.n === flag - 1 ? '🟠' : '🟡'; // 🟠 = one away from the limit
    // Links (e.g. "write-up: https://…") don't fit the board line; frst warns shows them in full.
    const text = r.last_reason?.replace(/\s*·?\s*(write-up:\s*)?https?:\/\/\S+/g, '').trim();
    const reason = text ? ` — ${truncate(text, 60)}` : '';
    const count = hot ? `**${r.n} warnings**` : `${r.n} warning${r.n === 1 ? '' : 's'}`;
    return `${dot} <@${r.user_id}> \`${r.user_tag ?? r.user_id}\` · ${count} · <t:${Math.floor(r.last.getTime() / 1000)}:R>${reason}`;
  };

  const lines = [];
  if (flagged.length) {
    lines.push(`## 🚨 Needs action (${flag}+ warnings)`);
    lines.push(...flagged.map((r) => fmt(r, true)));
    lines.push('');
  }
  if (rest.length) {
    lines.push('### Warned members');
    lines.push(...rest.map((r) => fmt(r, false)));
  }
  if (!rows.length) lines.push('No active warnings. ✨');
  if (gone) lines.push('', `-# + ${gone} warned user(s) no longer in the server (banned or left). Their history stays in \`frst warns\`.`);

  // Embed descriptions max out at 4096 chars.
  let desc = '';
  for (const [i, l] of lines.entries()) {
    if (desc.length + l.length + 40 > 4096) {
      desc += `\n…and ${lines.length - i} more`;
      break;
    }
    desc += (desc ? '\n' : '') + l;
  }

  return new EmbedBuilder()
    .setTitle('❄️ Warning Board')
    .setColor(flagged.length ? COLORS.bad : COLORS.frost)
    .setDescription(desc)
    .setFooter({ text: `${rows.length} member(s) with warnings · ${flagged.length} flagged · updated` })
    .setTimestamp();
}

registerSticky('warnboard', {
  chanKey: 'warnboard_channel',
  msgKey: 'warnboard_message',
  render: async (guild) => ({ embeds: [await boardEmbed(guild)] }),
});

/** Refresh the board in place (re-posts it if it was deleted). */
export const refreshBoard = (guild) => updateSticky(guild, 'warnboard');

export async function setupBoard(guild, channel) {
  const oldCh = guild.channels.cache.get(getSetting(guild.id, 'warnboard_channel'));
  const oldMsg = getSetting(guild.id, 'warnboard_message');
  if (oldCh && oldMsg) await oldCh.messages.delete(oldMsg).catch(() => {});
  await setSetting(guild.id, 'warnboard_channel', channel.id);
  await setSetting(guild.id, 'warnboard_message', null);
  return refreshBoard(guild);
}
