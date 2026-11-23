// Server structure dumps, shared by the bot (Node) and the Supabase Edge Function (Deno).
// No dependencies: pass in `api(path, query)` → Discord REST JSON, and a postgres.js `sql`.
//
// A dump = roles (+perms), channels (+permission overwrites), every member's roles (incl.
// people who left, from frostbot.member_roles), core server settings. No messages, no media.
// Only the most recent dump is cached (frostbot.latest_dump).

import { PERMISSION_FLAGS } from './permissions.js';

export const CHANNEL = { text: 0, voice: 2, category: 4, announcement: 5, stage: 13, forum: 15, media: 16 };
const TYPE_NAMES = Object.fromEntries(Object.entries(CHANNEL).map(([k, v]) => [v, k]));

const cdn = (path) => `https://cdn.discordapp.com/${path}`;

/** Bitfield string → permission names. */
export function permNames(bits) {
  const b = BigInt(bits);
  if (b & BigInt(PERMISSION_FLAGS.Administrator)) return ['Administrator (everything)'];
  return Object.entries(PERMISSION_FLAGS)
    .filter(([, v]) => b & BigInt(v))
    .map(([k]) => k);
}

const sameOverwrites = (a, b) =>
  a.length === b.length && a.every((o) => b.some((p) => p.id === o.id && p.allow === o.allow && p.deny === o.deny));
const ow = (o) => ({ id: o.id, type: o.type, allow: String(o.allow), deny: String(o.deny) });

async function fetchAllMembers(api, guildId) {
  const out = [];
  let after = '0';
  for (;;) {
    const batch = await api(`/guilds/${guildId}/members`, { limit: '1000', after });
    out.push(...batch);
    if (batch.length < 1000) return out;
    after = batch.at(-1).user.id;
  }
}

export async function buildDump(api, sql, guildId) {
  const [g, rawRoles, rawChannels, rawMembers, saved] = await Promise.all([
    api(`/guilds/${guildId}`),
    api(`/guilds/${guildId}/roles`),
    api(`/guilds/${guildId}/channels`),
    fetchAllMembers(api, guildId),
    sql`select user_id, user_tag, roles from frostbot.member_roles where guild_id = ${guildId}`,
  ]);

  const managed = new Set(rawRoles.filter((r) => r.managed).map((r) => r.id));

  const roles = rawRoles
    .sort((a, b) => b.position - a.position || (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
    .map((r) => ({
      id: r.id,
      name: r.name,
      colors: {
        primary: r.colors?.primary_color ?? r.color ?? 0,
        secondary: r.colors?.secondary_color ?? null,
        tertiary: r.colors?.tertiary_color ?? null,
      },
      hoist: Boolean(r.hoist),
      mentionable: Boolean(r.mentionable),
      permissions: String(r.permissions),
      position: r.position,
      managed: Boolean(r.managed),
      isEveryone: r.id === guildId,
      unicodeEmoji: r.unicode_emoji ?? null,
      iconURL: r.icon ? cdn(`role-icons/${r.id}/${r.icon}.png`) : null,
    }));

  const byId = new Map(rawChannels.map((c) => [c.id, c]));
  const channels = rawChannels
    .sort((a, b) => a.position - b.position)
    .map((c) => {
      const overwrites = (c.permission_overwrites ?? []).map(ow);
      const parent = c.parent_id ? byId.get(c.parent_id) : null;
      return {
        id: c.id,
        name: c.name,
        type: c.type,
        parentId: c.parent_id ?? null,
        position: c.position,
        topic: c.topic ?? null,
        nsfw: c.nsfw ?? false,
        rateLimitPerUser: c.rate_limit_per_user ?? 0,
        bitrate: c.bitrate ?? null,
        userLimit: c.user_limit ?? null,
        rtcRegion: c.rtc_region ?? null,
        videoQualityMode: c.video_quality_mode ?? null,
        defaultAutoArchiveDuration: c.default_auto_archive_duration ?? null,
        availableTags:
          c.available_tags?.map((t) => ({
            name: t.name,
            moderated: t.moderated,
            emoji: t.emoji_id ? { id: t.emoji_id } : t.emoji_name ? { name: t.emoji_name } : null,
          })) ?? null,
        defaultReactionEmoji: c.default_reaction_emoji ?? null,
        permissionsLocked: parent ? sameOverwrites(overwrites, (parent.permission_overwrites ?? []).map(ow)) : null,
        overwrites,
      };
    });

  const members = new Map();
  for (const m of rawMembers) {
    members.set(m.user.id, {
      id: m.user.id,
      tag: m.user.discriminator && m.user.discriminator !== '0' ? `${m.user.username}#${m.user.discriminator}` : m.user.username,
      displayName: m.nick ?? m.user.global_name ?? m.user.username,
      bot: Boolean(m.user.bot),
      inServer: true,
      roles: m.roles.filter((id) => !managed.has(id)),
    });
  }
  // People who left (or got banned in a nuke) but whose roles we still know.
  for (const s of saved) {
    if (!members.has(s.user_id)) members.set(s.user_id, { id: s.user_id, tag: s.user_tag, inServer: false, roles: s.roles });
  }

  return {
    version: 1,
    takenAt: new Date().toISOString(),
    guild: {
      id: g.id,
      name: g.name,
      iconURL: g.icon ? cdn(`icons/${g.id}/${g.icon}.png?size=1024`) : null,
      verificationLevel: g.verification_level,
      explicitContentFilter: g.explicit_content_filter,
      defaultMessageNotifications: g.default_message_notifications,
      afkChannelId: g.afk_channel_id ?? null,
      afkTimeout: g.afk_timeout,
      systemChannelId: g.system_channel_id ?? null,
      systemChannelFlags: g.system_channel_flags,
      rulesChannelId: g.rules_channel_id ?? null,
      publicUpdatesChannelId: g.public_updates_channel_id ?? null,
    },
    roles,
    channels,
    members: [...members.values()],
  };
}

// ---------- the single cached "latest" dump ----------

export async function saveLatest(sql, dump, source) {
  await sql`
    insert into frostbot.latest_dump (guild_id, taken_at, source, data)
    values (${dump.guild.id}, ${dump.takenAt}, ${source}, ${sql.json(dump)})
    on conflict (guild_id) do update set taken_at = excluded.taken_at, source = excluded.source, data = excluded.data`;
}

export async function latestDump(sql, guildId) {
  const [row] = await sql`select data from frostbot.latest_dump where guild_id = ${guildId}`;
  return row?.data ?? null;
}

/** True while the anti-nuke's post-nuke freeze is active (set by the bot, stored in settings). */
export async function nukeFreezeActive(sql, guildId) {
  const [row] = await sql`select value from frostbot.settings where guild_id = ${guildId} and key = 'nuke_freeze_until'`;
  return Number(row?.value ?? 0) > Date.now();
}

// ---------- text + parsing ----------

export function dumpToText(s) {
  const out = [];
  const roleName = new Map(s.roles.map((r) => [r.id, r.isEveryone ? '@everyone' : `@${r.name}`]));
  const memberName = new Map(s.members.map((m) => [m.id, m.tag]));
  const hex = (n) => (n ? '#' + n.toString(16).padStart(6, '0') : 'none');
  const line = '='.repeat(72);

  out.push(line, `SERVER DUMP: ${s.guild.name} (${s.guild.id})`, `Taken: ${s.takenAt}`, line, '');
  out.push(`Roles: ${s.roles.length}   Channels: ${s.channels.length}   Members recorded: ${s.members.length}`, '');

  out.push(line, 'ROLES (top → bottom)', line);
  for (const r of s.roles) {
    const flags = [r.hoist && 'shown separately', r.mentionable && 'mentionable', r.managed && 'BOT/INTEGRATION ROLE'].filter(Boolean);
    out.push(`[${String(r.position).padStart(3)}] ${roleName.get(r.id)}  (${r.id})  color ${hex(r.colors.primary)}${flags.length ? '  · ' + flags.join(' · ') : ''}`);
    const perms = permNames(r.permissions);
    out.push(`      perms: ${perms.length ? perms.join(', ') : '(none)'}`);
  }
  out.push('');

  out.push(line, 'CHANNELS + PERMISSION OVERWRITES', line);
  const byParent = new Map();
  for (const c of s.channels) {
    if (c.type === CHANNEL.category) continue;
    const k = c.parentId ?? 'none';
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k).push(c);
  }
  const printOverwrites = (c, indent) => {
    if (c.permissionsLocked) return out.push(`${indent}(synced with category)`);
    for (const o of c.overwrites) {
      const who = o.type === 0 ? roleName.get(o.id) ?? `role ${o.id}` : `member ${memberName.get(o.id) ?? o.id}`;
      const allow = permNames(o.allow);
      const deny = permNames(o.deny);
      out.push(`${indent}${who}:`);
      if (allow.length) out.push(`${indent}   ✔ allow: ${allow.join(', ')}`);
      if (deny.length) out.push(`${indent}   ✘ deny:  ${deny.join(', ')}`);
    }
  };
  const printChannel = (c, indent) => {
    const extra = [c.topic && `topic: "${c.topic.replace(/\n/g, ' ')}"`, c.nsfw && 'NSFW', c.rateLimitPerUser && `slowmode ${c.rateLimitPerUser}s`].filter(Boolean);
    const icon = c.type === CHANNEL.voice || c.type === CHANNEL.stage ? '🔊' : '#';
    out.push(`${indent}${icon} ${c.name}  [${TYPE_NAMES[c.type] ?? c.type}] (${c.id})${extra.length ? '  ' + extra.join(' · ') : ''}`);
    printOverwrites(c, indent + '    ');
  };
  for (const c of byParent.get('none') ?? []) printChannel(c, '');
  for (const cat of s.channels.filter((c) => c.type === CHANNEL.category)) {
    out.push('', `📁 ${cat.name.toUpperCase()}  (${cat.id})`);
    printOverwrites(cat, '    ');
    for (const c of byParent.get(cat.id) ?? []) printChannel(c, '  ');
  }
  out.push('');

  out.push(line, 'MEMBERS → ROLES', line);
  const sorted = [...s.members].sort((a, b) => b.roles.length - a.roles.length || (a.tag ?? '').localeCompare(b.tag ?? ''));
  for (const m of sorted) {
    const names = m.roles.map((id) => roleName.get(id) ?? `(deleted role ${id})`);
    out.push(`${m.tag ?? m.id} (${m.id})${m.bot ? ' [BOT]' : ''}${m.inServer ? '' : ' [left server]'}: ${names.length ? names.join(', ') : '—'}`);
  }
  out.push('', line, 'END OF DUMP', line);
  return out.join('\n');
}

export function parseDump(text) {
  const d = typeof text === 'string' ? JSON.parse(text) : text;
  if (d?.version !== 1 || !d.guild?.id || !Array.isArray(d.roles) || !Array.isArray(d.channels) || !Array.isArray(d.members)) {
    throw new Error("That doesn't look like a Frostbot dump (.json).");
  }
  return d;
}

export const dumpSummary = (d) => {
  const t = Math.floor(Date.parse(d.takenAt) / 1000);
  return `**${d.guild.name}**, taken <t:${t}:f> (<t:${t}:R>): ${d.roles.length} roles, ${d.channels.length} channels, ${d.members.length} members`;
};

export const dumpFileName = (d, ext) => `${d.takenAt.slice(0, 10)}-dump.${ext}`;
