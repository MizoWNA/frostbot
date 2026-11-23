// Anti-nuke: watches the audit log. If one account does too many destructive things
// (deleting channels/roles, banning/kicking, spamming channels/webhooks) inside the
// window, it gets punished, its webhooks get deleted, and the owner is alerted.

import { AuditLogEvent, PermissionFlagsBits } from 'discord.js';
import { sql } from '../db.js';
import { getBool, getNum, getSetting, setSetting } from '../settings.js';
import { embed, modlog } from '../util.js';
import { PREFIX } from '../config.js';

const WEIGHTS = {
  [AuditLogEvent.ChannelDelete]: 1,
  [AuditLogEvent.RoleDelete]: 1,
  [AuditLogEvent.MemberBanAdd]: 1,
  [AuditLogEvent.MemberKick]: 1,
  [AuditLogEvent.MemberPrune]: 3,
  [AuditLogEvent.ChannelCreate]: 0.5,
  [AuditLogEvent.RoleCreate]: 0.5,
  [AuditLogEvent.WebhookCreate]: 0.5,
  [AuditLogEvent.EmojiDelete]: 0.5,
  [AuditLogEvent.StickerDelete]: 0.5,
};

const DANGEROUS = PermissionFlagsBits.Administrator | PermissionFlagsBits.ManageGuild | PermissionFlagsBits.ManageRoles |
  PermissionFlagsBits.ManageChannels | PermissionFlagsBits.BanMembers | PermissionFlagsBits.KickMembers | PermissionFlagsBits.ManageWebhooks;

// Trusted users (besides owner + the bot) the anti-nuke ignores. Small → cached in memory.
const trusted = new Map(); // guildId → Set(userId)
export async function loadTrusted() {
  trusted.clear();
  for (const r of await sql`select guild_id, user_id from frostbot.trusted`) {
    if (!trusted.has(r.guild_id)) trusted.set(r.guild_id, new Set());
    trusted.get(r.guild_id).add(r.user_id);
  }
}
export async function setTrusted(guildId, userId, on) {
  if (!trusted.has(guildId)) trusted.set(guildId, new Set());
  if (on) {
    trusted.get(guildId).add(userId);
    await sql`insert into frostbot.trusted (guild_id, user_id) values (${guildId}, ${userId}) on conflict do nothing`;
  } else {
    trusted.get(guildId).delete(userId);
    await sql`delete from frostbot.trusted where guild_id = ${guildId} and user_id = ${userId}`;
  }
}
export const trustedList = (guildId) => [...(trusted.get(guildId) ?? [])];

const activity = new Map(); // `${guild}:${user}` → [{ t, w, action, targetId }]
const punished = new Map(); // `${guild}:${user}` → timestamp

const FREEZE_MS = 30 * 60_000;
// Stored as a setting so the Supabase dump function sees it too (it won't overwrite `latest` while active).
export const isFrozen = (guildId) => getNum(guildId, 'nuke_freeze_until') > Date.now();

export function isTrusted(guild, userId) {
  return userId === guild.ownerId || userId === guild.client.user.id || Boolean(trusted.get(guild.id)?.has(userId));
}

export async function onAuditEntry(entry, guild) {
  if (!getBool(guild.id, 'antinuke')) return;
  const executorId = entry.executorId;
  if (!executorId || isTrusted(guild, executorId)) return;

  let weight = WEIGHTS[entry.action] ?? 0;

  // A role suddenly getting dangerous perms counts too.
  if (entry.action === AuditLogEvent.RoleUpdate) {
    const perm = entry.changes.find((c) => c.key === 'permissions');
    if (perm) {
      const gained = BigInt(perm.new ?? 0) & ~BigInt(perm.old ?? 0);
      if (gained & DANGEROUS) weight = 1;
    }
  }
  // Adding a bot is how most nukes start; count it.
  if (entry.action === AuditLogEvent.BotAdd) weight = 1;
  if (!weight) return;

  const key = `${guild.id}:${executorId}`;
  const windowMs = getNum(guild.id, 'antinuke_window') * 1000;
  const now = Date.now();
  const list = (activity.get(key) ?? []).filter((a) => now - a.t < windowMs);
  list.push({ t: now, w: weight, action: entry.action, targetId: entry.targetId });
  activity.set(key, list);

  const score = list.reduce((s, a) => s + a.w, 0);
  if (score < getNum(guild.id, 'antinuke_limit')) return;
  if (now - (punished.get(key) ?? 0) < 60_000) return; // already handled
  punished.set(key, now);
  await setSetting(guild.id, 'nuke_freeze_until', now + FREEZE_MS).catch((e) => console.error('[antinuke] freeze flag:', e.message));

  await punish(guild, executorId, list);
}

async function punish(guild, userId, list) {
  const mode = getSetting(guild.id, 'antinuke_punish');
  const member = await guild.members.fetch(userId).catch(() => null);
  const reason = 'Anti-nuke: too many destructive actions';
  let result;

  try {
    if (!member) {
      await guild.bans.create(userId, { reason });
      result = 'banned (not in server)';
    } else if (mode === 'ban' || member.user.bot) {
      await member.ban({ reason });
      result = 'banned';
    } else if (mode === 'kick') {
      await member.kick(reason);
      result = 'kicked';
    } else {
      await member.roles.set(member.roles.cache.filter((r) => r.managed), reason);
      result = 'stripped of all roles';
    }
  } catch (e) {
    result = `**COULD NOT PUNISH** (${e.message}). My role must be above theirs. Fix it by hand right now.`;
  }

  // Remove webhooks they created during the spree.
  let hooksDeleted = 0;
  for (const a of list.filter((a) => a.action === AuditLogEvent.WebhookCreate)) {
    const hook = await guild.client.fetchWebhook(a.targetId).catch(() => null);
    if (hook) await hook.delete(reason).then(() => hooksDeleted++).catch(() => {});
  }

  // Undo the bans they handed out during the spree.
  let unbanned = 0;
  for (const a of list.filter((a) => a.action === AuditLogEvent.MemberBanAdd && a.targetId)) {
    await guild.bans.remove(a.targetId, 'Anti-nuke: reversing ban by nuker').then(() => unbanned++).catch(() => {});
  }

  const counts = {};
  for (const a of list) counts[AuditLogEvent[a.action]] = (counts[AuditLogEvent[a.action]] ?? 0) + 1;
  const desc = [
    `**Who:** <@${userId}> (\`${userId}\`)`,
    `**Done:** ${result}${hooksDeleted ? `, ${hooksDeleted} webhook(s) deleted` : ''}${unbanned ? `, ${unbanned} of their ban(s) reversed` : ''}`,
    `**Activity:** ${Object.entries(counts).map(([k, v]) => `${k} ×${v}`).join(', ')}`,
    '',
    `Role tracking is paused for 30 min so the damage doesn't get saved over the good copy.`,
    `**Don't run \`${PREFIX} backup\` now** (it would replace the cached dump with the nuked state).`,
    `To rebuild: \`${PREFIX} restore\` with your last good dump.json attached (or \`latest\` if it's pre-nuke), works from the mirror server too.`,
  ].join('\n');
  const e = embed('bad', desc, '🚨 Possible nuke detected');
  await modlog(guild, e);
  const owner = await guild.fetchOwner().catch(() => null);
  await owner?.send({ content: `Anti-nuke triggered in **${guild.name}**`, embeds: [e] }).catch(() => {});
  console.warn(`[antinuke] ${guild.name}: ${userId} → ${result}`);
}
