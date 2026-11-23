// 1:1 message mirror: every message in the main server is copied into a matching
// channel in the sister (mirror) server via a webhook that uses the author's
// name + avatar. After a nuke, restore.js replays the mirror back into the main server.

import { ChannelType, WebhookClient, PermissionFlagsBits as P } from 'discord.js';
import { sql } from '../db.js';
import { MAIN_GUILD_ID, MIRROR_GUILD_ID } from '../config.js';
import { getBool, getSetting, setSetting } from '../settings.js';

export const TRASH = '🗑️';
const MIRROR_HOOK_NAME = 'Frost Mirror';

/** Channel types that carry messages and get a mirror channel. */
export const MESSAGE_TYPES = new Set([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildVoice,
  ChannelType.GuildStageVoice,
]);

// mirror_channels + restore webhooks are small → kept in memory, written through to Postgres.
const chans = new Map(); // main_channel_id → { main_channel_id, mirror_channel_id, webhook_id, webhook_token }
const restoreHooks = new Set();

async function putChan(mainId, mirrorId, hookId, hookToken) {
  const row = { main_channel_id: mainId, mirror_channel_id: mirrorId, webhook_id: hookId, webhook_token: hookToken };
  chans.set(mainId, row);
  await sql`insert into frostbot.mirror_channels ${sql(row)}
    on conflict (main_channel_id) do update set mirror_channel_id = excluded.mirror_channel_id,
      webhook_id = excluded.webhook_id, webhook_token = excluded.webhook_token`;
}
async function setHook(mainId, hookId, hookToken) {
  const row = chans.get(mainId);
  if (row) Object.assign(row, { webhook_id: hookId, webhook_token: hookToken });
  await sql`update frostbot.mirror_channels set webhook_id = ${hookId}, webhook_token = ${hookToken} where main_channel_id = ${mainId}`;
}
const getMsg = async (mainId) => (await sql`select * from frostbot.mirror_messages where main_id = ${mainId}`)[0];
const putMsg = (mainId, mirrorId, chanId) =>
  sql`insert into frostbot.mirror_messages (main_id, mirror_id, main_channel_id) values (${mainId}, ${mirrorId}, ${chanId})
      on conflict (main_id) do nothing`;

export const getMirrorRow = (mainChannelId) => chans.get(mainChannelId);
export async function remapMainChannel(oldId, newId) {
  const row = chans.get(oldId);
  if (!row) return;
  chans.delete(oldId);
  chans.set(newId, { ...row, main_channel_id: newId });
  await sql`update frostbot.mirror_channels set main_channel_id = ${newId} where main_channel_id = ${oldId}`;
}
export async function addRestoreHook(id) {
  restoreHooks.add(id);
  await sql`insert into frostbot.restore_webhooks (webhook_id) values (${id}) on conflict do nothing`;
}
export async function mirrorStats() {
  const [{ n }] = await sql`select count(*)::int as n from frostbot.mirror_messages`;
  return { linkedMessages: n, channels: [...chans.values()].filter((r) => r.webhook_id).length };
}
/** Forget message id links older than `days` (they only exist to sync edits/deletes). */
export async function pruneMessageLinks(days) {
  const r = await sql`delete from frostbot.mirror_messages where created_at < now() - make_interval(days => ${days})`;
  return r.count;
}

let client;
export async function initMirror(c) {
  client = c;
  for (const r of await sql`select * from frostbot.mirror_channels`) chans.set(r.main_channel_id, r);
  await loadRoleMap();
  for (const r of await sql`select webhook_id from frostbot.restore_webhooks`) restoreHooks.add(r.webhook_id);
}
const mirrorGuild = () => client.guilds.cache.get(MIRROR_GUILD_ID);
export const mirrorEnabled = () => Boolean(MIRROR_GUILD_ID && mirrorGuild() && getBool(MAIN_GUILD_ID, 'mirror'));

// ---------- ordering: one promise chain per channel so messages never arrive out of order ----------
const queues = new Map();
export function enqueue(key, fn) {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(fn).catch((e) => console.error('[mirror]', e.message ?? e));
  queues.set(key, next);
  next.finally(() => queues.get(key) === next && queues.delete(key));
  return next;
}
export const pendingJobs = () => queues.size;

// ---------- structure ----------

/** Webhook usernames can't contain "discord"/"clyde" and max out at 80 chars. */
export function safeName(name) {
  let n = (name ?? '').replace(/discord/gi, 'disc\u200bord').replace(/clyde/gi, 'cly\u200bde').trim();
  if (!n || /^(everyone|here)$/i.test(n)) n = `${n || 'unknown'}\u200b`;
  return n.slice(0, 80);
}

// ---------- safety: structure writes only ever touch the MIRROR server ----------
function assertMirror(guild) {
  if (!guild || guild.id !== MIRROR_GUILD_ID || guild.id === MAIN_GUILD_ID) {
    throw new Error(`refusing to modify ${guild?.name ?? 'unknown server'}: not the mirror server`);
  }
  return guild;
}
const isVoice = (c) => c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice;

const categoryLocks = new Map();
/** Find/create the mirror category that matches a main-server category. */
async function ensureMirrorCategory(mainCategory, { rename = false } = {}) {
  if (!mainCategory) return null;
  if (categoryLocks.has(mainCategory.id)) return categoryLocks.get(mainCategory.id);
  const p = (async () => {
    const mg = assertMirror(mirrorGuild());
    const row = chans.get(mainCategory.id);
    const existing = row && mg.channels.cache.get(row.mirror_channel_id);
    if (existing) {
      if (rename && existing.name !== mainCategory.name) await existing.setName(mainCategory.name).catch(() => {});
      return existing;
    }
    const cat = await mg.channels.create({ name: mainCategory.name, type: ChannelType.GuildCategory, reason: 'Mirror sync' });
    await putChan(mainCategory.id, cat.id, null, null);
    return cat;
  })();
  categoryLocks.set(mainCategory.id, p);
  try {
    return await p;
  } finally {
    categoryLocks.delete(mainCategory.id);
  }
}

const channelLocks = new Map();
/**
 * Find/create the mirror channel + webhook for a main-server channel.
 * Renames only when `rename` is set (a real rename in main). Discord allows 2 renames
 * per 10 min per channel, and fancy names never compare equal after Discord normalises them.
 */
export async function ensureMirrorChannel(mainChannel, { rename = false } = {}) {
  if (channelLocks.has(mainChannel.id)) return channelLocks.get(mainChannel.id);
  const p = (async () => {
    const mg = assertMirror(mirrorGuild());
    let row = chans.get(mainChannel.id);
    let mirrorCh = row && mg.channels.cache.get(row.mirror_channel_id);
    const parent = await ensureMirrorCategory(mainChannel.parent);
    const voice = isVoice(mainChannel);
    const wantType = voice ? ChannelType.GuildVoice : ChannelType.GuildText; // stage → voice (no Community needed)
    const wantName = mainChannel.name;
    const nsfw = Boolean(mainChannel.nsfw);

    // Wrong type (e.g. an old text copy of a voice channel)? Replace it, but only if it's
    // still empty, so archived messages are never thrown away.
    if (mirrorCh && mirrorCh.type !== wantType && !mirrorCh.lastMessageId) {
      await mirrorCh.delete('Mirror sync: recreating with the right channel type');
      await setHook(mainChannel.id, null, null);
      mirrorCh = null;
    }

    if (!mirrorCh) {
      mirrorCh = await mg.channels.create({
        name: wantName,
        type: wantType,
        parent: parent ?? undefined,
        nsfw,
        ...(voice ? {} : { topic: `Mirror of #${mainChannel.name} (${mainChannel.id})` }),
        reason: 'Mirror sync',
      });
      await putChan(mainChannel.id, mirrorCh.id, null, null);
      row = chans.get(mainChannel.id);
    } else {
      const edit = {};
      if (rename) edit.name = wantName;
      if (mirrorCh.nsfw !== nsfw) edit.nsfw = nsfw;
      if (parent && mirrorCh.parentId !== parent.id) edit.parent = parent.id;
      if (Object.keys(edit).length) await mirrorCh.edit({ ...edit, reason: 'Mirror sync' }).catch((e) => console.error('[mirror] edit', mirrorCh.name, e.message));
    }

    if (!row.webhook_id || !row.webhook_token) {
      const hook = await mirrorCh.createWebhook({ name: MIRROR_HOOK_NAME });
      await setHook(mainChannel.id, hook.id, hook.token);
      row = chans.get(mainChannel.id);
    }
    return { hook: hookClient(row.webhook_id, row.webhook_token), mirrorCh };
  })();
  channelLocks.set(mainChannel.id, p);
  try {
    return await p;
  } finally {
    channelLocks.delete(mainChannel.id);
  }
}

/** Put mirror categories/channels in the same order as the main server (skipped if already right). */
async function syncChannelOrder(mainGuild) {
  const mg = assertMirror(mirrorGuild());
  const pairs = [];
  for (const c of [...mainGuild.channels.cache.values()].filter((c) => !c.isThread())) {
    const row = chans.get(c.id);
    const mc = row && mg.channels.cache.get(row.mirror_channel_id);
    if (mc) pairs.push({ main: c, mc });
  }
  // Discord orders categories, text and voice separately inside each parent; check each group.
  const groups = new Map();
  for (const p of pairs.sort((a, b) => a.main.rawPosition - b.main.rawPosition)) {
    const kind = p.mc.type === ChannelType.GuildCategory ? 'cat' : isVoice(p.mc) ? 'voice' : 'text';
    const key = `${p.mc.parentId ?? 'root'}:${kind}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p.mc.rawPosition);
  }
  const inOrder = [...groups.values()].every((pos) => pos.every((v, i) => i === 0 || v > pos[i - 1]));
  if (inOrder) return 0;
  // Positions only: Discord allows one parent change per request, and parents are already
  // fixed one-by-one in ensureMirrorChannel.
  await mg.channels.setPositions(pairs.map((p) => ({ channel: p.mc.id, position: p.main.rawPosition })));
  return pairs.length;
}

/**
 * Create mirror categories + channels for everything in the main server, fix NSFW flags
 * and parents, then match the order. Never deletes anything.
 */
export async function syncStructure(mainGuild, log = () => {}) {
  const mg = assertMirror(mirrorGuild());
  await mg.channels.fetch();
  const all = [...mainGuild.channels.cache.values()].filter((c) => !c.isThread()).sort((a, b) => a.rawPosition - b.rawPosition);
  let made = 0;
  let failed = 0;
  for (const cat of all.filter((c) => c.type === ChannelType.GuildCategory)) {
    if (!chans.has(cat.id)) made++;
    await ensureMirrorCategory(cat).catch((e) => (failed++, console.error(`[mirror] category ${cat.name}:`, e.message)));
  }
  const msgChans = all.filter((c) => MESSAGE_TYPES.has(c.type));
  for (const [i, ch] of msgChans.entries()) {
    if (!chans.get(ch.id)?.webhook_id) made++;
    await ensureMirrorChannel(ch).catch((e) => (failed++, console.error(`[mirror] #${ch.name}:`, e.message)));
    if ((i + 1) % 10 === 0) await log(`channels ${i + 1}/${msgChans.length}`);
  }
  const ordered = await syncChannelOrder(mainGuild).catch((e) => (console.error('[mirror] order:', e.message), 0));
  return { made, failed, ordered };
}

// ---------- roles: cosmetic copies (name, color, hoist, order), never any permissions ----------

const roleMap = new Map(); // main role id → mirror role id
async function loadRoleMap() {
  roleMap.clear();
  for (const r of await sql`select * from frostbot.mirror_roles`) roleMap.set(r.main_role_id, r.mirror_role_id);
}
const putRole = async (mainId, mirrorId) => {
  roleMap.set(mainId, mirrorId);
  await sql`insert into frostbot.mirror_roles (main_role_id, mirror_role_id) values (${mainId}, ${mirrorId})
    on conflict (main_role_id) do update set mirror_role_id = excluded.mirror_role_id`;
};
const copyable = (r) => r.id !== r.guild.id && !r.managed; // skip @everyone + bot/integration roles

// ---------- mention ids: main ↔ mirror (role/channel mentions are ids, so they need translating) ----------

const swapIds = (text, roleIds, chanIds) =>
  text
    ?.replace(/<@&(\d+)>/g, (m, id) => (roleIds.has(id) ? `<@&${roleIds.get(id)}>` : m))
    .replace(/<#(\d+)>/g, (m, id) => (chanIds.has(id) ? `<#${chanIds.get(id)}>` : m));

const mainToMirrorChan = () => new Map([...chans.values()].map((r) => [r.main_channel_id, r.mirror_channel_id]));

/** Main-server role/channel mentions → the mirror's copies (so they don't show as @unknown-role). */
export const toMirrorMentions = (text) => swapIds(text, roleMap, mainToMirrorChan());

/** Mirror role/channel mentions → back to the main server's ids (used by restore). */
export function toMainMentions(text) {
  const roles = new Map([...roleMap].map(([main, mir]) => [mir, main]));
  const chanIds = new Map([...chans.values()].map((r) => [r.mirror_channel_id, r.main_channel_id]));
  return swapIds(text, roles, chanIds);
}

/** Same, for embed objects (descriptions, fields, footers…). */
const mapEmbed = (e, fn) => JSON.parse(fn(JSON.stringify(e)));
export const embedToMirror = (e) => mapEmbed(e, toMirrorMentions);
export const embedToMain = (e) => mapEmbed(e, toMainMentions);
const primaryColor = (r) => r.colors?.primaryColor ?? r.color ?? 0;

/** Create/update one mirror role to match a main role. Returns 'made' | 'updated' | 'same'. */
export async function syncOneRole(mainRole) {
  if (!copyable(mainRole)) return 'same';
  const mg = assertMirror(mirrorGuild());
  const existing = roleMap.has(mainRole.id) && mg.roles.cache.get(roleMap.get(mainRole.id));
  const want = { name: mainRole.name, colors: { primaryColor: primaryColor(mainRole) }, hoist: mainRole.hoist };
  if (!existing) {
    const made = await mg.roles.create({ ...want, mentionable: false, permissions: 0n, reason: 'Mirror sync' });
    await putRole(mainRole.id, made.id);
    return 'made';
  }
  if (existing.name !== want.name || primaryColor(existing) !== want.colors.primaryColor || existing.hoist !== want.hoist || existing.permissions.bitfield !== 0n) {
    await existing.edit({ ...want, permissions: 0n, reason: 'Mirror sync' });
    return 'updated';
  }
  return 'same';
}

/** Copy every main role into the mirror (no permissions), then match the order. Never deletes. */
export async function syncRoles(mainGuild, log = () => {}) {
  const mg = assertMirror(mirrorGuild());
  await mg.roles.fetch();
  await mainGuild.roles.fetch();
  const roles = [...mainGuild.roles.cache.values()].filter(copyable).sort((a, b) => b.position - a.position);
  const counts = { made: 0, updated: 0, same: 0, failed: 0 };
  for (const [i, r] of roles.entries()) {
    try {
      counts[await syncOneRole(r)]++;
    } catch (e) {
      counts.failed++;
      console.error(`[mirror] role ${r.name}:`, e.message);
      if (e.code === 30005) break; // max roles reached
    }
    if ((i + 1) % 20 === 0) await log(`roles ${i + 1}/${roles.length}`);
  }
  // Order: same as main, all below the bot's own role.
  await mg.roles.fetch();
  const top = mg.members.me.roles.highest.position;
  const order = roles
    .map((r) => mg.roles.cache.get(roleMap.get(r.id)))
    .filter((r) => r && r.position < top)
    .reverse(); // bottom → top
  const alreadyOrdered = order.every((r, i) => i === 0 || r.position > order[i - 1].position);
  if (order.length && !alreadyOrdered) {
    await mg.roles
      .setPositions(order.map((role, i) => ({ role: role.id, position: i + 1 })))
      .catch((e) => console.error('[mirror] role order:', e.message));
  }
  return { ...counts, total: roles.length };
}

// ---------- messages ----------

// One client per webhook, reused: each client tracks Discord's rate limits for its webhook. A
// fresh client per message knew nothing, kept hitting 429s (slow, and too many get the IP banned).
const hookClients = new Map(); // webhook id → { token, client }
export const hookStats = { sent: 0, rateLimitedMs: 0, rateLimits: 0, buildMs: 0, sendMs: 0, dbMs: 0, delMs: 0 };
function hookClient(id, token) {
  const have = hookClients.get(id);
  if (have?.token === token) return have.client;
  have?.client.destroy();
  const client = new WebhookClient({ id, token });
  client.rest.on('rateLimited', (i) => {
    hookStats.rateLimits++;
    hookStats.rateLimitedMs += i.timeToReset;
    if (i.timeToReset >= 5000) console.warn(`[ratelimit] webhook ${i.route} → waiting ${Math.round(i.timeToReset / 1000)}s${i.global ? ' (GLOBAL)' : ''}`);
  });
  hookClients.set(id, { token, client });
  return client;
}

// ---------- memory guard: only a couple of messages' files held in RAM at once ----------
const MEDIA_SLOTS = Number(process.env.MEDIA_CONCURRENCY ?? 2);
let mediaBusy = 0;
const mediaWaiters = [];
/** Run fn while holding one of the few media slots (files are buffered in memory). */
export async function withMediaSlot(fn) {
  if (mediaBusy >= MEDIA_SLOTS) await new Promise((r) => mediaWaiters.push(r));
  mediaBusy++;
  try {
    return await fn();
  } finally {
    mediaBusy--;
    mediaWaiters.shift()?.();
  }
}

/** Max upload size (bytes) for a guild based on boost tier. */
export const uploadLimit = (guild) => [10, 10, 50, 100][guild?.premiumTier ?? 0] * 1024 * 1024;

export async function downloadAttachments(attachments, limit) {
  const files = [];
  const skipped = [];
  for (const a of attachments.values()) {
    if (a.size > limit) {
      skipped.push(a);
      continue;
    }
    try {
      const res = await fetch(a.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      files.push({ attachment: Buffer.from(await res.arrayBuffer()), name: a.name, description: a.description ?? undefined });
    } catch {
      skipped.push(a);
    }
  }
  return { files, skipped };
}

/** Turn a main-server message into a webhook payload. */
async function buildPayload(message, uploadMax) {
  let content = message.content ?? '';

  // Forwarded messages have empty content; pull the forwarded text in.
  const snap = message.messageSnapshots?.first?.();
  if (!content && snap?.content) content = `-# ↪ forwarded\n${snap.content}`;

  if (message.stickers?.size) content += `${content ? '\n' : ''}-# [sticker: ${message.stickers.map((s) => s.name).join(', ')}]`;

  const { files, skipped } = await downloadAttachments(message.attachments, uploadMax);
  if (skipped.length) content += `\n-# [file too big to mirror: ${skipped.map((a) => a.name).join(', ')}]`;

  const embeds = message.author.bot ? message.embeds.filter((e) => e.data.type === 'rich').map((e) => embedToMirror(e.toJSON())) : [];

  if (!content.trim() && !files.length && !embeds.length) return null;
  return {
    content: toMirrorMentions(content).slice(0, 2000) || undefined,
    username: safeName(message.member?.displayName ?? message.author.displayName),
    avatarURL: (message.member ?? message.author).displayAvatarURL({ extension: 'png', size: 256 }),
    files,
    embeds: embeds.slice(0, 10),
    allowedMentions: { parse: [] },
  };
}

// ---------- packed history: up to 10 old messages per post (one card each) ----------
// Discord allows ~30 webhook posts/min per channel, so a huge channel (general) copied 1:1
// would take weeks. Old text messages are packed instead; files still go 1:1.

export const PACK_MAX = 10;
export const PACK_CHARS = 5800; // Discord: all embeds in one message ≤ 6000 characters

/** User mentions → plain @names (those users usually aren't in the mirror). */
const nameUsers = (text, message) =>
  text.replace(/<@!?(\d+)>/g, (m, id) => {
    const name = message.mentions?.members?.get(id)?.displayName ?? message.mentions?.users?.get(id)?.displayName;
    return name ? `@${name}` : m;
  });

/** One old message as an archive card, or null if there's nothing to show. */
export function packEntry(message) {
  let text = message.content ?? '';
  const snap = message.messageSnapshots?.first?.();
  if (!text && snap?.content) text = `-# ↪ forwarded\n${snap.content}`;
  if (message.stickers?.size) text += `${text ? '\n' : ''}-# [sticker: ${message.stickers.map((s) => s.name).join(', ')}]`;
  const replied = message.reference?.messageId && message.mentions?.repliedUser;
  if (replied) text = `-# ↪ replying to ${replied.displayName}\n${text}`;
  text = toMirrorMentions(nameUsers(text, message)).slice(0, 4000);
  if (!text.trim()) return null;
  const who = message.member ?? message.author;
  const name = safeName(message.member?.displayName ?? message.author.displayName).slice(0, 256);
  return {
    size: name.length + text.length,
    embed: {
      author: { name, icon_url: who.displayAvatarURL({ extension: 'png', size: 64 }) },
      description: text,
      timestamp: message.createdAt.toISOString(),
      color: message.member?.displayColor || 0x7dd3fc,
    },
  };
}

/** Post a pack of archive cards to a channel's mirror. */
export async function sendPack(mainChannel, embeds) {
  const { hook } = await ensureMirrorChannel(mainChannel);
  const t = Date.now();
  await hook.send({ username: 'Frost Archive', avatarURL: client.user.displayAvatarURL({ extension: 'png' }), embeds, allowedMentions: { parse: [] } });
  hookStats.sent++;
  hookStats.sendMs += Date.now() - t;
}

export function shouldMirror(message) {
  if (!message.guild || message.guild.id !== MAIN_GUILD_ID) return false;
  if (!mirrorEnabled()) return false;
  if (message.system) return false;
  if (message.author?.id === client.user.id) return false;
  if (message.webhookId && restoreHooks.has(message.webhookId)) return false; // our own replays
  if (message.channel.isThread()) return false; // threads aren't mirrored (yet)
  return MESSAGE_TYPES.has(message.channel.type);
}

async function sendToMirror(message) {
  if (await getMsg(message.id)) return false; // already mirrored (backfill overlap)
  return message.attachments.size ? withMediaSlot(() => doSend(message)) : doSend(message);
}

async function doSend(message) {
  let t = Date.now();
  const payload = await buildPayload(message, uploadLimit(mirrorGuild()));
  hookStats.buildMs += Date.now() - t;
  if (!payload) return false;
  t = Date.now();
  let { hook } = await ensureMirrorChannel(message.channel);
  let sent;
  try {
    sent = await hook.send(payload);
  } catch (e) {
    if (e.code !== 10015) throw e; // Unknown Webhook → someone deleted it, make a new one
    await setHook(message.channel.id, null, null);
    ({ hook } = await ensureMirrorChannel(message.channel));
    sent = await hook.send(payload);
  }
  hookStats.sent++;
  hookStats.sendMs += Date.now() - t;
  t = Date.now();
  await putMsg(message.id, sent.id, message.channel.id);
  hookStats.dbMs += Date.now() - t;
  return true;
}

export function onMessage(message) {
  if (!shouldMirror(message)) return;
  enqueue(message.channel.id, () => sendToMirror(message));
}

export function onEdit(oldMsg, newMsg) {
  if (!newMsg.guild || newMsg.guild.id !== MAIN_GUILD_ID || !mirrorEnabled()) return;
  enqueue(newMsg.channel.id, async () => {
    const row = await getMsg(newMsg.id);
    if (!row) return;
    if (newMsg.partial) newMsg = await newMsg.fetch().catch(() => null);
    if (!newMsg || oldMsg.content === newMsg.content) return; // embed-unfurl updates, not real edits
    const { hook } = await ensureMirrorChannel(newMsg.channel);
    await hook.editMessage(row.mirror_id, { content: toMirrorMentions(newMsg.content) || '\u200b', allowedMentions: { parse: [] } });
  });
}

/** Deleted in main → mark with 🗑️ in the mirror (never delete; a nuke can't wipe the archive). */
export function onDelete(message) {
  if (!message.guild || message.guild.id !== MAIN_GUILD_ID || !mirrorEnabled()) return;
  enqueue(message.channel.id, async () => {
    const row = await getMsg(message.id);
    if (!row) return;
    const chanRow = chans.get(row.main_channel_id);
    const mirrorCh = chanRow && mirrorGuild().channels.cache.get(chanRow.mirror_channel_id);
    const m = await mirrorCh?.messages.fetch(row.mirror_id).catch(() => null);
    await m?.react(TRASH).catch(() => {});
  });
}

/** main message ids → existing mirror links, for one batch (one query instead of 100). */
export async function linksFor(mainIds) {
  if (!mainIds.length) return new Map();
  const rows = await sql`select main_id, mirror_id from frostbot.mirror_messages where main_id in ${sql(mainIds)}`;
  return new Map(rows.map((r) => [r.main_id, r.mirror_id]));
}

/**
 * Mirror a message at the END of its mirror channel, used by the history backfill (the caller
 * holds the channel's queue). If it was already mirrored out of order (e.g. live, before the
 * backfill reached it), the old copy is deleted first so the mirror stays chronological.
 */
export async function mirrorInOrder(message, existingMirrorId) {
  if (existingMirrorId) {
    const t = Date.now();
    const { hook } = await ensureMirrorChannel(message.channel);
    await hook.deleteMessage(existingMirrorId).catch(() => {});
    await sql`delete from frostbot.mirror_messages where main_id = ${message.id}`;
    hookStats.delMs += Date.now() - t;
  }
  return message.attachments.size ? withMediaSlot(() => doSend(message)) : doSend(message);
}

/** Iterate a mirror channel's history, oldest → newest. */
export async function* mirrorHistory(mirrorCh) {
  let after = '0';
  for (;;) {
    const batch = await mirrorCh.messages.fetch({ limit: 100, after });
    if (!batch.size) return;
    const sorted = [...batch.values()].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    yield* sorted;
    after = sorted.at(-1).id;
  }
}

// ---------- mirror access: read-only for everyone, staff-only channels hidden ----------

const EVERYONE_PERMS = P.ViewChannel | P.ReadMessageHistory; // read-only, no chat/reactions/voice
const STAFF_CHAT_PERMS = P.ViewChannel | P.ReadMessageHistory | P.SendMessages | P.EmbedLinks | P.AttachFiles | P.AddReactions | P.UseExternalEmojis;

/** The main-server role that counts as "mod" (setting mirror_mod_role, else a role named Moderators). */
export function modRoleOf(mainGuild) {
  const id = getSetting(MAIN_GUILD_ID, 'mirror_mod_role');
  return (id && mainGuild.roles.cache.get(id)) || mainGuild.roles.cache.find((r) => /^moderators?$/i.test(r.name)) || null;
}

/**
 * Staff-only = no human role at or below the mod role (incl. @everyone) can see it in main.
 * Bot roles are ignored (they often have Administrator). Member-only overwrites (tickets etc.)
 * don't count as visible, so those get hidden too.
 */
export function isStaffOnly(channel, modRole) {
  const g = channel.guild;
  const roles = [...g.roles.cache.values()].filter((r) => !r.managed && (r.id === g.id || (modRole && r.position <= modRole.position)));
  return !roles.some((r) => channel.permissionsFor(r)?.has(P.ViewChannel));
}

async function ensureSpecialRole(mg, key, name, color) {
  const id = getSetting(MIRROR_GUILD_ID, key);
  let role = id && mg.roles.cache.get(id);
  if (!role) {
    role = await mg.roles.create({ name, colors: { primaryColor: color }, hoist: true, permissions: 0n, reason: 'Mirror access' });
    await setSetting(MIRROR_GUILD_ID, key, role.id);
  }
  return role;
}

const sameOverwrites = (ch, want) => {
  const cur = ch.permissionOverwrites.cache;
  return cur.size === want.length && want.every((w) => {
    const o = cur.get(w.id);
    return o && o.allow.bitfield === (w.allow ?? 0n) && o.deny.bitfield === (w.deny ?? 0n);
  });
};

/**
 * Lock the mirror down: @everyone read-only, a staff chat for Mirror Mod/Master, and every
 * channel that's staff-only in main hidden from everyone without Mirror Master.
 */
export async function syncMirrorAccess(mainGuild) {
  const mg = assertMirror(mirrorGuild());
  await mg.roles.fetch();
  await mg.channels.fetch();
  const master = await ensureSpecialRole(mg, 'mirror_master_role', 'Mirror Master', 0x7dd3fc);
  const mod = await ensureSpecialRole(mg, 'mirror_staff_role', 'Mirror Mod', 0x5865f2);

  // Keep the two staff roles right under the bot. New roles land at position 1 tied with
  // others, and Discord refuses to move tied roles one by one, so send the whole order at once
  // (same as dragging in Discord's app does). Ties: the lower id ranks higher.
  await mg.roles.fetch();
  const top = mg.members.me.roles.highest.position;
  if (master.position !== top - 1 || mod.position !== top - 2) {
    const others = [...mg.roles.cache.values()]
      .filter((r) => r.id !== mg.id && !r.managed && r.id !== master.id && r.id !== mod.id && r.position < top)
      .sort((a, b) => a.position - b.position || (BigInt(a.id) < BigInt(b.id) ? 1 : -1)); // bottom → top
    await mg.roles
      .setPositions([...others, mod, master].map((r, i) => ({ role: r.id, position: i + 1 })))
      .catch((e) => console.warn(`[mirror] couldn't move Mirror Master/Mod under the bot (${e.message}); drag them there once in the mirror's Roles settings`));
  }

  if (mg.roles.everyone.permissions.bitfield !== EVERYONE_PERMS) {
    await mg.roles.everyone.setPermissions(EVERYONE_PERMS, 'Mirror is read-only');
  }

  // Staff chat: the bot never mirrors into or reads from it.
  const chatId = getSetting(MIRROR_GUILD_ID, 'mirror_chat_channel');
  let chat = chatId && mg.channels.cache.get(chatId);
  const chatOverwrites = [
    { id: mg.id, deny: P.ViewChannel },
    { id: master.id, allow: STAFF_CHAT_PERMS },
    { id: mod.id, allow: STAFF_CHAT_PERMS },
  ];
  if (!chat) {
    chat = await mg.channels.create({ name: 'mirror-chat', type: ChannelType.GuildText, position: 0, topic: 'Staff chat for the mirror. FrostBot ignores this channel.', permissionOverwrites: chatOverwrites, reason: 'Mirror access' });
    await setSetting(MIRROR_GUILD_ID, 'mirror_chat_channel', chat.id);
  } else if (!sameOverwrites(chat, chatOverwrites)) {
    await chat.permissionOverwrites.set(chatOverwrites, 'Mirror access');
  }

  // Hide staff-only channels.
  const modRole = modRoleOf(mainGuild);
  let hidden = 0;
  let changed = 0;
  for (const c of mainGuild.channels.cache.values()) {
    if (c.isThread()) continue;
    const row = chans.get(c.id);
    const mc = row && mg.channels.cache.get(row.mirror_channel_id);
    if (!mc) continue;
    const staffOnly = isStaffOnly(c, modRole);
    if (staffOnly) hidden++;
    const want = staffOnly ? [{ id: mg.id, deny: P.ViewChannel }, { id: master.id, allow: P.ViewChannel }] : [];
    if (!sameOverwrites(mc, want)) {
      await mc.permissionOverwrites.set(want, 'Mirror access').then(() => changed++).catch((e) => console.error('[mirror] access', mc.name, e.message));
    }
  }
  return { hidden, changed, modRole: modRole?.name ?? '(none found: only @everyone-visible channels are public)', chat: chat.id };
}

let accessTimer = null;
/** Re-check access after permission changes in main (debounced). */
export function scheduleAccessSync(mainGuild) {
  clearTimeout(accessTimer);
  accessTimer = setTimeout(() => {
    syncMirrorAccess(mainGuild).then((r) => r.changed && console.log('[mirror] access updated', r)).catch((e) => console.error('[mirror] access:', e.message));
  }, 10_000);
}

export const getMirrorGuild = mirrorGuild;
