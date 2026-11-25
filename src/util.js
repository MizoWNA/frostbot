import { EmbedBuilder } from 'discord.js';
import { getSetting } from './settings.js';

export const COLORS = { ok: 0x57f287, warn: 0xfee75c, bad: 0xed4245, info: 0x5865f2, frost: 0x7dd3fc };

export const embed = (color, description, title) => {
  const e = new EmbedBuilder().setColor(COLORS[color] ?? color).setDescription(description);
  if (title) e.setTitle(title);
  return e;
};

export const reply = (msg, color, text, title) =>
  msg.reply({ embeds: [embed(color, text, title)], allowedMentions: { repliedUser: false } });

/** Parse "10m", "1h30m", "2d", "45s" → milliseconds. Returns null if invalid. */
/** Plain decimal digits only (no 0x13, 1e3, 1.8e308, -1, " 5"…); null otherwise. */
export const parseIntStrict = (s) => (/^\d{1,9}$/.test(s ?? '') ? Number(s) : null);

export function parseDuration(str) {
  if (!str) return null;
  const re = /(\d+)\s*(w|d|h|m|s)/gi;
  const mult = { w: 604_800_000, d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };
  let total = 0;
  let matched = '';
  for (const m of str.matchAll(re)) {
    total += Number(m[1]) * mult[m[2].toLowerCase()];
    matched += m[0];
  }
  if (!total || matched.replace(/\s/g, '') !== str.replace(/\s/g, '')) return null;
  return total;
}

export function fmtDuration(ms) {
  const parts = [];
  for (const [u, n] of [['d', 86_400_000], ['h', 3_600_000], ['m', 60_000], ['s', 1000]]) {
    if (ms >= n) {
      parts.push(`${Math.floor(ms / n)}${u}`);
      ms %= n;
    }
  }
  return parts.join(' ') || '0s';
}

const idFrom = (s) => s?.match(/^<@!?(\d{17,20})>$|^(\d{17,20})$/)?.slice(1).find(Boolean) ?? null;

/** Resolve a member from a mention, id, or (partial) name. */
export async function resolveMember(guild, arg) {
  if (!arg) return null;
  const id = idFrom(arg);
  if (id) return guild.members.fetch(id).catch(() => null);
  const q = arg.toLowerCase();
  const found = await guild.members.fetch({ query: arg, limit: 10 }).catch(() => null);
  return (
    found?.find((m) => m.user.username.toLowerCase() === q || m.displayName.toLowerCase() === q) ??
    found?.first() ??
    null
  );
}

/** Resolve a user (doesn't have to be in the server). */
export async function resolveUser(client, arg) {
  const id = idFrom(arg);
  return id ? client.users.fetch(id).catch(() => null) : null;
}

export function resolveChannel(guild, arg) {
  const id = arg?.match(/^<#(\d+)>$|^(\d{17,20})$/)?.slice(1).find(Boolean);
  return id ? guild.channels.cache.get(id) ?? null : null;
}

export function resolveRole(guild, arg) {
  if (!arg) return null;
  const id = arg.match(/^<@&(\d+)>$|^(\d{17,20})$/)?.slice(1).find(Boolean);
  if (id) return guild.roles.cache.get(id) ?? null;
  const q = arg.toLowerCase();
  return guild.roles.cache.find((r) => r.name.toLowerCase() === q) ?? null;
}

/**
 * Can `mod` act on `target`? Checks role hierarchy for both the moderator and the bot.
 * Returns an error string, or null if OK.
 */
export function hierarchyError(mod, target) {
  const guild = mod.guild;
  if (target.id === mod.id) return "You can't do that to yourself.";
  if (target.id === guild.ownerId) return "You can't do that to the server owner.";
  if (target.id === guild.members.me.id) return 'Nice try.';
  if (mod.id !== guild.ownerId && target.roles.highest.position >= mod.roles.highest.position)
    return `${target} has a role equal to or higher than yours.`;
  if (target.roles.highest.position >= guild.members.me.roles.highest.position)
    return `My highest role is below ${target}'s. Move my role higher in Server Settings → Roles.`;
  return null;
}

/** Post to the configured mod-log channel (silently does nothing if unset). */
/** Post to the mod-log channel (optionally with files). Returns the message, or null if unset. */
export async function modlog(guild, e, files = []) {
  const id = getSetting(guild.id, 'modlog');
  if (!id) return null;
  const ch = guild.channels.cache.get(id);
  if (!ch?.isTextBased()) return null;
  return ch.send({ embeds: [e], files, allowedMentions: { parse: [] } }).catch(() => null);
}

export { permNames } from '../supabase/functions/_shared/dumpCore.js';

export const truncate = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s ?? '');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Strip a trailing "confirm" flag off args. */
export function takeFlag(args, flag) {
  const i = args.findIndex((a) => a.toLowerCase() === flag);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}
