// Human-readable info dumps as .txt attachments, for mods to read (not for parsing: the
// JSON dump / API is for that). Built from the bot's cache, so they're instant and free.

import { AttachmentBuilder, ChannelType, PermissionsBitField } from 'discord.js';
import { reply, resolveMember, resolveRole } from '../util.js';
import { listWarnings } from '../features/warnings.js';

const SECTIONS = ['server', 'roles', 'role', 'members', 'member', 'perms', 'channels', 'channelperms'];

// ---------- formatting ----------

const DAY = 86_400_000;
function ago(ms) {
  const d = Math.floor((Date.now() - ms) / DAY);
  if (d < 1) return 'today';
  if (d < 31) return `${d}d ago`;
  if (d < 365) return `${Math.floor(d / 30.4)}mo ago`;
  const y = Math.floor(d / 365);
  const mo = Math.floor((d % 365) / 30.4);
  return `${y}y${mo ? ` ${mo}mo` : ''} ago`;
}
const date = (ms) => (ms ? `${new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} (${ago(ms)})` : 'unknown');

/** "ManageGuild" → "Manage Server" */
const permWord = (p) => p.replace(/Guild/g, 'Server').replace(/([a-z])([A-Z])/g, '$1 $2').replace('VAD', 'Voice Activity');
const DANGER = new Set(['Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels', 'ManageWebhooks', 'BanMembers', 'KickMembers', 'MentionEveryone', 'ManageMessages', 'ModerateMembers']);
function permsText(bits) {
  const list = new PermissionsBitField(bits).toArray();
  if (list.includes('Administrator')) return '⚠️ ADMINISTRATOR (can do everything)';
  const risky = list.filter((p) => DANGER.has(p)).map(permWord);
  return risky.length ? `⚠️ ${risky.join(', ')}` : list.length ? 'normal member perms only' : 'no permissions';
}
/** Every permission in plain words, risky ones marked ⚠️. */
function allPerms(bits) {
  const list = new PermissionsBitField(bits).toArray();
  if (list.includes('Administrator')) return '⚠️ ADMINISTRATOR (every permission, ignores channel settings)';
  return list.length ? list.map((p) => (DANGER.has(p) ? `⚠️ ${permWord(p)}` : permWord(p))).join(', ') : 'none';
}
const hex = (n) => (n ? `#${n.toString(16).padStart(6, '0')}` : 'no color');
const who = (m) => `${m.displayName} (@${m.user.username})${m.user.bot ? ' [bot]' : ''}`;
const header = (guild, title) => {
  const line = '─'.repeat(64);
  return [line, `${title}`, `${guild.name} · made ${new Date().toUTCString()}`, line, ''];
};
const roleList = (m) =>
  m.roles.cache
    .filter((r) => r.id !== m.guild.id)
    .sort((a, b) => b.position - a.position)
    .map((r) => r.name)
    .join(', ') || '(no roles)';

// ---------- sections ----------

function server(g) {
  const members = [...g.members.cache.values()];
  const bots = members.filter((m) => m.user.bot).length;
  const chans = [...g.channels.cache.values()];
  const count = (...t) => chans.filter((c) => t.includes(c.type)).length;
  return [
    ...header(g, 'SERVER INFO'),
    `Name:          ${g.name}`,
    `Owner:         ${g.members.cache.get(g.ownerId) ? who(g.members.cache.get(g.ownerId)) : g.ownerId}`,
    `Created:       ${date(g.createdTimestamp)}`,
    `Members:       ${g.memberCount} (${g.memberCount - bots} people, ${bots} bots)`,
    `Boosts:        level ${g.premiumTier}, ${g.premiumSubscriptionCount ?? 0} boosts`,
    `Roles:         ${g.roles.cache.size - 1}`,
    `Channels:      ${count(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum)} text, ${count(ChannelType.GuildVoice, ChannelType.GuildStageVoice)} voice, ${count(ChannelType.GuildCategory)} categories`,
    `Verification:  ${['none', 'low (verified email)', 'medium (5 min on Discord)', 'high (10 min in server)', 'highest (verified phone)'][g.verificationLevel]}`,
    `2FA for mods:  ${g.mfaLevel ? 'required' : 'not required'}`,
  ];
}

function roles(g) {
  const out = header(g, 'ROLES (top → bottom)');
  for (const r of [...g.roles.cache.values()].sort((a, b) => b.position - a.position)) {
    if (r.id === g.id) continue;
    const notes = [r.managed && 'bot/integration role', r.hoist && 'shown separately', r.mentionable && 'anyone can @mention'].filter(Boolean);
    out.push(`${r.name}`);
    out.push(`    ${r.members.size} member(s) · ${hex(r.color)}${notes.length ? ` · ${notes.join(' · ')}` : ''}`);
    out.push(`    perms: ${allPerms(r.permissions.bitfield)}`);
  }
  const ev = g.roles.everyone;
  out.push('', `@everyone (all members)`, `    perms: ${allPerms(ev.permissions.bitfield)}`);
  return out;
}

function role(g, r) {
  const ms = [...r.members.values()].sort((a, b) => (a.joinedTimestamp ?? 0) - (b.joinedTimestamp ?? 0));
  return [
    ...header(g, `ROLE: ${r.name}`),
    `Members:     ${ms.length}`,
    `Color:       ${hex(r.color)}`,
    `Position:    ${r.position} of ${g.roles.cache.size - 1}`,
    `Created:     ${date(r.createdTimestamp)}`,
    `Permissions: ${allPerms(r.permissions.bitfield)}`,
    '',
    'MEMBERS (oldest join first)',
    ...ms.map((m) => `  ${who(m)}  · joined ${date(m.joinedTimestamp)}`),
  ];
}

function members(g) {
  const ms = [...g.members.cache.values()].sort((a, b) => (a.joinedTimestamp ?? 0) - (b.joinedTimestamp ?? 0));
  const out = header(g, `MEMBERS (${ms.length}, oldest join first)`);
  for (const m of ms) {
    out.push(who(m));
    out.push(`    joined ${date(m.joinedTimestamp)} · account made ${date(m.user.createdTimestamp)}`);
    out.push(`    roles: ${roleList(m)}`);
  }
  return out;
}

/** Each member's server-wide permissions. Members with only @everyone's perms are listed briefly. */
function perms(g) {
  const base = g.roles.everyone.permissions.bitfield;
  const ms = [...g.members.cache.values()].sort((a, b) => b.roles.highest.position - a.roles.highest.position || a.displayName.localeCompare(b.displayName));
  const extra = ms.filter((m) => m.permissions.bitfield !== base);
  const plain = ms.filter((m) => m.permissions.bitfield === base);
  const out = header(g, 'MEMBERS → PERMISSIONS (server-wide, from all their roles)');
  out.push(`${extra.length} member(s) with more than the default perms (highest role first):`, '');
  for (const m of extra) {
    out.push(who(m));
    out.push(`    top role: ${m.roles.highest.name}`);
    out.push(`    perms: ${allPerms(m.permissions.bitfield)}`);
    const added = new PermissionsBitField(m.permissions.bitfield & ~base).toArray();
    if (added.length && !m.permissions.has('Administrator')) out.push(`    on top of @everyone: ${added.map(permWord).join(', ')}`);
  }
  out.push('', `${plain.length} member(s) with only the default @everyone perms (${allPerms(base)}):`, '');
  out.push(...plain.map((m) => `  ${who(m)}`));
  out.push('', '-- Channel-specific overrides can add or remove perms in single channels; see "info channels".');
  return out;
}

async function member(g, m) {
  const warns = await listWarnings(g.id, m.id);
  return [
    ...header(g, `MEMBER: ${m.displayName}`),
    `Name:          ${who(m)}`,
    `ID:            ${m.id}`,
    `Joined:        ${date(m.joinedTimestamp)}`,
    `Account made:  ${date(m.user.createdTimestamp)}`,
    `Boosting:      ${m.premiumSince ? `since ${date(m.premiumSinceTimestamp)}` : 'no'}`,
    `Timed out:     ${m.isCommunicationDisabled() ? `until ${new Date(m.communicationDisabledUntilTimestamp).toUTCString()}` : 'no'}`,
    `Top role:      ${m.roles.highest.id === g.id ? '(none)' : m.roles.highest.name}`,
    `Roles:         ${roleList(m)}`,
    `Permissions:   ${allPerms(m.permissions.bitfield)}`,
    '',
    `WARNINGS (${warns.length} active)`,
    ...(warns.length
      ? warns.map((w) => `  #${w.id} · ${date(new Date(w.created_at).getTime())} · by ${g.members.cache.get(w.mod_id)?.displayName ?? w.mod_id} · ${w.reason ?? '(no reason)'}${w.proof ? `\n      proof: ${w.proof}` : ''}`)
      : ['  none']),
  ];
}

function channels(g) {
  const out = header(g, 'CHANNELS (as ordered in the sidebar)');
  const everyone = g.roles.everyone;
  const describe = (c) => {
    const icon = [ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(c.type) ? '🔊' : c.type === ChannelType.GuildForum ? '💬' : '#';
    const notes = [];
    if (!c.permissionsFor(everyone)?.has('ViewChannel')) {
      const can = g.roles.cache.filter((r) => r.id !== g.id && !r.managed && c.permissionsFor(r)?.has('ViewChannel')).sort((a, b) => a.position - b.position);
      notes.push(`hidden · visible to: ${can.size ? can.map((r) => r.name).slice(0, 6).join(', ') + (can.size > 6 ? ` +${can.size - 6} more` : '') : 'admins only'}`);
    } else if (c.isTextBased?.() && !c.permissionsFor(everyone)?.has('SendMessages')) notes.push('read-only for everyone');
    if (c.rateLimitPerUser) notes.push(`slowmode ${c.rateLimitPerUser}s`);
    if (c.nsfw) notes.push('NSFW');
    return `${icon} ${c.name}${notes.length ? `  (${notes.join(' · ')})` : ''}`;
  };
  const sorted = (list) => list.sort((a, b) => a.rawPosition - b.rawPosition);
  const all = [...g.channels.cache.values()].filter((c) => !c.isThread());
  for (const c of sorted(all.filter((c) => !c.parentId && c.type !== ChannelType.GuildCategory))) out.push(describe(c));
  for (const cat of sorted(all.filter((c) => c.type === ChannelType.GuildCategory))) {
    out.push('', `📁 ${cat.name}`);
    for (const c of sorted(all.filter((x) => x.parentId === cat.id))) out.push(`   ${describe(c)}`);
  }
  return out;
}

/**
 * Channel permission overwrites. Categories are listed in full; each channel says whether it's
 * synced with its category, and if not, only what differs from the category.
 */
function channelPerms(g) {
  const out = header(g, 'CHANNEL PERMISSIONS (categories in full, channels as differences)');
  out.push('Legend: ✔ allowed · ✘ denied · + only in this channel · − category has it, channel doesn\'t · ~ changed', '');
  const target = (o) =>
    o.type === 0
      ? o.id === g.id ? '@everyone' : `@${g.roles.cache.get(o.id)?.name ?? `deleted role ${o.id}`}`
      : `member ${g.members.cache.get(o.id) ? who(g.members.cache.get(o.id)) : o.id}`;
  const words = (bits) => new PermissionsBitField(bits).toArray().map(permWord).join(', ');
  const ow = (o) => [o.allow.bitfield && `✔ ${words(o.allow.bitfield)}`, o.deny.bitfield && `✘ ${words(o.deny.bitfield)}`].filter(Boolean).join('  ') || '(nothing set)';
  const full = (ch, indent) => {
    const list = [...ch.permissionOverwrites.cache.values()];
    if (!list.length) return out.push(`${indent}(no overrides: uses the server-wide role perms)`);
    for (const o of list) out.push(`${indent}${target(o)}: ${ow(o)}`);
  };
  const diff = (ch, cat, indent) => {
    if (ch.permissionsLocked) return out.push(`${indent}= synced with category`);
    const mine = ch.permissionOverwrites.cache;
    const theirs = cat.permissionOverwrites.cache;
    const lines = [];
    for (const [id, o] of mine) {
      const c = theirs.get(id);
      if (!c) lines.push(`+ ${target(o)}: ${ow(o)}`);
      else if (c.allow.bitfield !== o.allow.bitfield || c.deny.bitfield !== o.deny.bitfield) {
        const part = (now, was, sign) => {
          const add = now & ~was;
          const rem = was & ~now;
          return [add && `${sign} now ${words(add)}`, rem && `${sign} no longer ${words(rem)}`].filter(Boolean);
        };
        lines.push(`~ ${target(o)}: ${[...part(o.allow.bitfield, c.allow.bitfield, '✔'), ...part(o.deny.bitfield, c.deny.bitfield, '✘')].join(' · ')}`);
      }
    }
    for (const [id, c] of theirs) if (!mine.has(id)) lines.push(`− ${target(c)} (category: ${ow(c)})`);
    out.push(`${indent}≠ NOT synced${lines.length ? '' : ' (same overrides, just unlinked)'}`);
    for (const l of lines) out.push(`${indent}  ${l}`);
  };
  const icon = (c) => ([ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(c.type) ? '🔊' : c.type === ChannelType.GuildForum ? '💬' : '#');
  const sorted = (list) => list.sort((a, b) => a.rawPosition - b.rawPosition);
  const all = [...g.channels.cache.values()].filter((c) => !c.isThread());
  const loose = sorted(all.filter((c) => !c.parentId && c.type !== ChannelType.GuildCategory));
  if (loose.length) out.push('(no category)');
  for (const c of loose) {
    out.push(`  ${icon(c)} ${c.name}`);
    full(c, '      ');
  }
  for (const cat of sorted(all.filter((c) => c.type === ChannelType.GuildCategory))) {
    out.push('', `📁 ${cat.name}`);
    full(cat, '    ');
    for (const c of sorted(all.filter((x) => x.parentId === cat.id))) {
      out.push(`  ${icon(c)} ${c.name}`);
      diff(c, cat, '      ');
    }
  }
  return out;
}

// ---------- command ----------

export default [
  {
    name: 'info',
    perm: 'mod',
    fromMirror: true,
    usage: `info <${SECTIONS.join('|')}> [@role|@member]`,
    desc: 'Readable .txt: server, roles + perms, one role, members + roles, one member, members + perms, channels, channel perms vs category',
    async run(ctx) {
      const what = ctx.args[0]?.toLowerCase();
      const g = ctx.guild;
      let lines;
      let name = what;
      if (what === 'server') lines = server(g);
      else if (what === 'roles') lines = roles(g);
      else if (what === 'members') lines = members(g);
      else if (what === 'channels') lines = channels(g);
      else if (what === 'perms') lines = perms(g);
      else if (what === 'channelperms') lines = channelPerms(g);
      else if (what === 'role') {
        const r = resolveRole(g, ctx.args.slice(1).join(' '));
        if (!r) return reply(ctx.msg, 'bad', `Couldn't find that role. Usage: \`${ctx.prefix} info role @role\``);
        lines = role(g, r);
        name = `role-${r.name}`;
      } else if (what === 'member') {
        const m = await resolveMember(g, ctx.args[1]);
        if (!m) return reply(ctx.msg, 'bad', `Couldn't find that member. Usage: \`${ctx.prefix} info member @user\``);
        lines = await member(g, m);
        name = `member-${m.user.username}`;
      } else return reply(ctx.msg, 'bad', `Usage: \`${ctx.prefix} ${ctx.usage}\``);

      const file = `${name.replace(/[^\w.-]+/g, '_').slice(0, 40)}-${new Date().toISOString().slice(0, 10)}.txt`;
      return ctx.msg.reply({
        content: `📄 ${what === 'role' || what === 'member' ? lines[1] : `${what[0].toUpperCase()}${what.slice(1)}`} · ${lines.length} lines`,
        files: [new AttachmentBuilder(Buffer.from(lines.join('\n')), { name: file })],
        allowedMentions: { repliedUser: false },
      });
    },
  },
];
