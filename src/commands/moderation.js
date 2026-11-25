import { PermissionFlagsBits as P, ChannelType } from 'discord.js';
import { isAdmin } from '../perms.js';
import { embed, reply, modlog, parseDuration, fmtDuration, resolveMember, resolveUser, resolveChannel, resolveRole, hierarchyError, parseIntStrict } from '../util.js';
import { getSetting, setSetting } from '../settings.js';

const MAX_TIMEOUT = 28 * 86_400_000;

/** Common "resolve target member + check hierarchy" step. Replies with an error and returns null on failure. */
/** Rename the bot itself (Admins role or higher). */
async function setBotNick(ctx, name) {
  if (!isAdmin(ctx.member)) return reply(ctx.msg, 'bad', 'Only **Admins** or higher can rename me.');
  if (!name) return reply(ctx.msg, 'bad', `Usage: \`${ctx.prefix} botnick <new name|reset>\``);
  const nick = name.toLowerCase() === 'reset' ? null : name.slice(0, 32);
  await ctx.guild.members.me.setNickname(nick, `by ${ctx.member.user.tag}`);
  await reply(ctx.msg, 'ok', nick ? `✏️ I'm now **${nick}** here.` : '✏️ Nickname reset.');
  await log(ctx, 'info', 'Bot nickname changed', [`**New:** ${nick ?? '(reset)'}`]);
}

async function target(ctx, usage, { allowSelf = false } = {}) {
  const m = await resolveMember(ctx.guild, ctx.args[0]);
  if (!m) {
    await reply(ctx.msg, 'bad', `Couldn't find that member.\nUsage: \`${usage}\``);
    return null;
  }
  const self = allowSelf && m.id === ctx.member.id;
  // Acting on yourself (e.g. your own nickname): only Discord's own limits on the bot apply.
  const err = self
    ? m.id === ctx.guild.ownerId
      ? "Discord doesn't let bots change the server owner."
      : m.roles.highest.position >= ctx.guild.members.me.roles.highest.position
        ? `My highest role is below yours. Move my role higher in Server Settings → Roles.`
        : null
    : hierarchyError(ctx.member, m);
  if (err) {
    await reply(ctx.msg, 'bad', err);
    return null;
  }
  return m;
}

const log = (ctx, color, title, lines) =>
  modlog(ctx.guild, embed(color, [...lines, `**Mod:** ${ctx.member} (\`${ctx.member.id}\`)`, `**Where:** ${ctx.msg.channel}`].join('\n'), title));

const dm = (user, text) => user.send(text).catch(() => false);

export default [
  {
    name: 'kick',
    perm: P.KickMembers,
    usage: 'kick @user [reason]',
    desc: 'Kick a member',
    async run(ctx) {
      const m = await target(ctx, ctx.usage);
      if (!m) return;
      const reason = ctx.args.slice(1).join(' ') || 'No reason given';
      await dm(m, `You were kicked from **${ctx.guild.name}**: ${reason}`);
      await m.kick(`${ctx.member.user.tag}: ${reason}`);
      await reply(ctx.msg, 'ok', `👢 Kicked **${m.user.tag}**. ${reason}`);
      await log(ctx, 'warn', 'Member kicked', [`**User:** ${m.user.tag} (\`${m.id}\`)`, `**Reason:** ${reason}`]);
    },
  },
  {
    name: 'ban',
    perm: P.BanMembers,
    usage: 'ban @user|id [1d (delete msgs)] [reason]',
    desc: 'Ban a member (or any user id); optionally delete up to 7d of their messages',
    async run(ctx) {
      const member = await resolveMember(ctx.guild, ctx.args[0]);
      const user = member?.user ?? (await resolveUser(ctx.client, ctx.args[0]));
      if (!user) return reply(ctx.msg, 'bad', `Couldn't find that user.\nUsage: \`${ctx.usage}\``);
      if (member) {
        const err = hierarchyError(ctx.member, member);
        if (err) return reply(ctx.msg, 'bad', err);
      }
      let rest = ctx.args.slice(1);
      let deleteSecs = 0;
      const d = parseDuration(rest[0]);
      if (d) {
        deleteSecs = Math.min(Math.floor(d / 1000), 7 * 86400);
        rest = rest.slice(1);
      }
      const reason = rest.join(' ') || 'No reason given';
      if (member) await dm(user, `You were banned from **${ctx.guild.name}**: ${reason}`);
      await ctx.guild.bans.create(user.id, { reason: `${ctx.member.user.tag}: ${reason}`, deleteMessageSeconds: deleteSecs });
      await reply(ctx.msg, 'ok', `🔨 Banned **${user.tag}**. ${reason}${deleteSecs ? ` (deleted ${fmtDuration(deleteSecs * 1000)} of messages)` : ''}`);
      await log(ctx, 'bad', 'Member banned', [`**User:** ${user.tag} (\`${user.id}\`)`, `**Reason:** ${reason}`]);
    },
  },
  {
    name: 'unban',
    perm: P.BanMembers,
    usage: 'unban <user id> [reason]',
    desc: 'Unban a user',
    async run(ctx) {
      const id = ctx.args[0]?.replace(/\D/g, '');
      if (!id) return reply(ctx.msg, 'bad', `Usage: \`${ctx.usage}\``);
      const reason = ctx.args.slice(1).join(' ') || 'No reason given';
      const ban = await ctx.guild.bans.fetch(id).catch(() => null);
      if (!ban) return reply(ctx.msg, 'bad', "That user isn't banned.");
      await ctx.guild.bans.remove(id, `${ctx.member.user.tag}: ${reason}`);
      await reply(ctx.msg, 'ok', `✅ Unbanned **${ban.user.tag}**.`);
      await log(ctx, 'ok', 'Member unbanned', [`**User:** ${ban.user.tag} (\`${id}\`)`, `**Reason:** ${reason}`]);
    },
  },
  {
    name: 'timeout',
    aliases: ['mute', 'to'],
    perm: P.ModerateMembers,
    usage: 'timeout @user <10m|2h|1d> [reason]',
    desc: 'Time a member out (max 28d)',
    async run(ctx) {
      const m = await target(ctx, ctx.usage);
      if (!m) return;
      const ms = parseDuration(ctx.args[1]);
      if (!ms) return reply(ctx.msg, 'bad', `Give a duration like \`10m\`, \`2h\`, \`1d\`.\nUsage: \`${ctx.usage}\``);
      if (ms > MAX_TIMEOUT) return reply(ctx.msg, 'bad', 'Discord caps timeouts at 28 days.');
      const reason = ctx.args.slice(2).join(' ') || 'No reason given';
      await m.timeout(ms, `${ctx.member.user.tag}: ${reason}`);
      await dm(m, `You were timed out in **${ctx.guild.name}** for ${fmtDuration(ms)}: ${reason}`);
      await reply(ctx.msg, 'ok', `🔇 Timed out **${m.user.tag}** for **${fmtDuration(ms)}**. ${reason}`);
      await log(ctx, 'warn', 'Member timed out', [`**User:** ${m.user.tag} (\`${m.id}\`)`, `**For:** ${fmtDuration(ms)}`, `**Reason:** ${reason}`]);
    },
  },
  {
    name: 'untimeout',
    aliases: ['unmute', 'uto'],
    perm: P.ModerateMembers,
    usage: 'untimeout @user',
    desc: 'Remove a timeout',
    async run(ctx) {
      const m = await target(ctx, ctx.usage);
      if (!m) return;
      if (!m.isCommunicationDisabled()) return reply(ctx.msg, 'warn', `${m} isn't timed out.`);
      await m.timeout(null, `${ctx.member.user.tag}: timeout removed`);
      await reply(ctx.msg, 'ok', `🔊 Removed timeout from **${m.user.tag}**.`);
      await log(ctx, 'ok', 'Timeout removed', [`**User:** ${m.user.tag} (\`${m.id}\`)`]);
    },
  },
  {
    name: 'purge',
    aliases: ['clear', 'prune'],
    perm: P.ManageMessages,
    usage: 'purge <1-100> [@user]',
    desc: 'Bulk delete recent messages (optionally only from one user)',
    async run(ctx) {
      const n = parseIntStrict(ctx.args[0]);
      if (!Number.isInteger(n) || n < 1 || n > 100) return reply(ctx.msg, 'bad', `Usage: \`${ctx.usage}\``);
      const who = ctx.args[1] ? await resolveMember(ctx.guild, ctx.args[1]) : null;
      await ctx.msg.delete().catch(() => {});
      let msgs = await ctx.msg.channel.messages.fetch({ limit: who ? 100 : n });
      if (who) msgs = msgs.filter((m) => m.author.id === who.id).first(n);
      const deleted = await ctx.msg.channel.bulkDelete(msgs, true); // skips >14 day old messages
      const note = await ctx.msg.channel.send({ embeds: [embed('ok', `🧹 Deleted **${deleted.size}** message(s)${who ? ` from ${who}` : ''}.`)] });
      setTimeout(() => note.delete().catch(() => {}), 4000);
      await log(ctx, 'info', 'Messages purged', [`**Count:** ${deleted.size}${who ? ` (from ${who.user.tag})` : ''}`]);
    },
  },
  {
    name: 'slowmode',
    aliases: ['slow'],
    perm: P.ManageChannels,
    usage: 'slowmode <5s|1m|off> [#channel]',
    desc: 'Set channel slowmode (max 6h)',
    async run(ctx) {
      const ch = resolveChannel(ctx.guild, ctx.args[1]) ?? ctx.msg.channel;
      const raw = ctx.args[0]?.toLowerCase();
      const secs = raw === 'off' || raw === '0' ? 0 : Math.floor((parseDuration(raw) ?? -1000) / 1000);
      if (secs < 0 || secs > 21600) return reply(ctx.msg, 'bad', `Usage: \`${ctx.usage}\``);
      await ch.setRateLimitPerUser(secs, ctx.member.user.tag);
      await reply(ctx.msg, 'ok', secs ? `🐢 Slowmode in ${ch} set to **${fmtDuration(secs * 1000)}**.` : `Slowmode off in ${ch}.`);
    },
  },
  {
    name: 'lock',
    perm: P.ManageChannels,
    usage: 'lock [#channel] [reason]',
    desc: 'Stop @everyone from sending messages in a channel',
    async run(ctx) {
      const ch = resolveChannel(ctx.guild, ctx.args[0]) ?? ctx.msg.channel;
      const reason = ctx.args.slice(resolveChannel(ctx.guild, ctx.args[0]) ? 1 : 0).join(' ') || 'No reason given';
      await ch.permissionOverwrites.edit(ctx.guild.roles.everyone, { SendMessages: false, SendMessagesInThreads: false, CreatePublicThreads: false }, { reason });
      await reply(ctx.msg, 'ok', `🔒 Locked ${ch}. ${reason}`);
      await log(ctx, 'warn', 'Channel locked', [`**Channel:** ${ch}`, `**Reason:** ${reason}`]);
    },
  },
  {
    name: 'unlock',
    perm: P.ManageChannels,
    usage: 'unlock [#channel]',
    desc: 'Undo lock',
    async run(ctx) {
      const ch = resolveChannel(ctx.guild, ctx.args[0]) ?? ctx.msg.channel;
      await ch.permissionOverwrites.edit(ctx.guild.roles.everyone, { SendMessages: null, SendMessagesInThreads: null, CreatePublicThreads: null });
      await reply(ctx.msg, 'ok', `🔓 Unlocked ${ch}.`);
      await log(ctx, 'ok', 'Channel unlocked', [`**Channel:** ${ch}`]);
    },
  },
  {
    name: 'lockdown',
    perm: P.Administrator,
    usage: 'lockdown <on|off> [reason]',
    desc: 'Lock (or unlock) every text channel at once, e.g. during a raid',
    async run(ctx) {
      const mode = ctx.args[0]?.toLowerCase();
      const everyone = ctx.guild.roles.everyone;
      if (mode === 'on') {
        const reason = ctx.args.slice(1).join(' ') || 'Lockdown';
        const locked = [];
        for (const ch of ctx.guild.channels.cache.values()) {
          if (![ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum].includes(ch.type)) continue;
          if (ch.permissionsFor(everyone).has(P.SendMessages) === false) continue; // already closed, leave it alone
          await ch.permissionOverwrites.edit(everyone, { SendMessages: false, SendMessagesInThreads: false }, { reason }).then(() => locked.push(ch.id)).catch(() => {});
        }
        await setSetting(ctx.guild.id, 'lockdown_channels', JSON.stringify(locked));
        await reply(ctx.msg, 'bad', `🚨 Lockdown on: **${locked.length}** channels locked.\nUndo with \`${ctx.prefix} lockdown off\``);
        await log(ctx, 'bad', 'LOCKDOWN ON', [`**Channels:** ${locked.length}`, `**Reason:** ${reason}`]);
      } else if (mode === 'off') {
        const ids = JSON.parse(getSetting(ctx.guild.id, 'lockdown_channels') ?? '[]');
        let n = 0;
        for (const id of ids) {
          const ch = ctx.guild.channels.cache.get(id);
          if (ch) await ch.permissionOverwrites.edit(everyone, { SendMessages: null, SendMessagesInThreads: null }).then(() => n++).catch(() => {});
        }
        await setSetting(ctx.guild.id, 'lockdown_channels', null);
        await reply(ctx.msg, 'ok', `✅ Lockdown off: **${n}** channels unlocked.`);
        await log(ctx, 'ok', 'Lockdown off', [`**Channels:** ${n}`]);
      } else {
        await reply(ctx.msg, 'bad', `Usage: \`${ctx.usage}\``);
      }
    },
  },
  {
    name: 'nick',
    perm: P.ManageNicknames,
    usage: 'nick @user <new name|reset>',
    desc: "Change a member's nickname (yours too; the bot's needs Admins or higher)",
    async run(ctx) {
      if ((await resolveMember(ctx.guild, ctx.args[0]))?.id === ctx.guild.members.me.id) return setBotNick(ctx, ctx.args.slice(1).join(' '));
      const m = await target(ctx, ctx.usage, { allowSelf: true });
      if (!m) return;
      const name = ctx.args.slice(1).join(' ');
      if (!name) return reply(ctx.msg, 'bad', `Usage: \`${ctx.usage}\``);
      await m.setNickname(name.toLowerCase() === 'reset' ? null : name.slice(0, 32), ctx.member.user.tag);
      await reply(ctx.msg, 'ok', `✏️ Nickname updated for ${m}.`);
    },
  },
  {
    name: 'botnick',
    perm: 'admin',
    usage: 'botnick <new name|reset>',
    desc: "Change the bot's nickname in this server",
    run: (ctx) => setBotNick(ctx, ctx.args.join(' ')),
  },
  {
    name: 'role',
    perm: P.ManageRoles,
    usage: 'role @user <@role|role name>',
    desc: 'Give or take a role (toggles, yourself too; only roles below your highest)',
    async run(ctx) {
      const m = await target(ctx, ctx.usage, { allowSelf: true });
      if (!m) return;
      const role = resolveRole(ctx.guild, ctx.args.slice(1).join(' '));
      if (!role) return reply(ctx.msg, 'bad', `Couldn't find that role.\nUsage: \`${ctx.usage}\``);
      if (role.managed || !role.editable) return reply(ctx.msg, 'bad', "I can't manage that role (bot role or above mine).");
      if (ctx.member.id !== ctx.guild.ownerId && role.position >= ctx.member.roles.highest.position)
        return reply(ctx.msg, 'bad', 'That role is equal to or above your highest role.');
      const has = m.roles.cache.has(role.id);
      await (has ? m.roles.remove(role, ctx.member.user.tag) : m.roles.add(role, ctx.member.user.tag));
      await reply(ctx.msg, 'ok', `${has ? '➖ Removed' : '➕ Gave'} ${role} ${has ? 'from' : 'to'} ${m}.`);
      await log(ctx, 'info', has ? 'Role removed' : 'Role added', [`**User:** ${m.user.tag}`, `**Role:** ${role.name}`]);
    },
  },
  {
    name: 'whois',
    aliases: ['userinfo', 'ui'],
    perm: P.ModerateMembers,
    usage: 'whois [@user]',
    desc: 'Account age, join date, roles, warnings',
    async run(ctx) {
      const m = ctx.args[0] ? await resolveMember(ctx.guild, ctx.args[0]) : ctx.member;
      if (!m) return reply(ctx.msg, 'bad', "Couldn't find that member.");
      const { warnCount } = await import('../features/warnings.js');
      const t = (ms) => `<t:${Math.floor(ms / 1000)}:f> (<t:${Math.floor(ms / 1000)}:R>)`;
      const roles = m.roles.cache.filter((r) => r.id !== ctx.guild.id).sort((a, b) => b.position - a.position);
      const e = embed('info', [
        `**User:** ${m} \`${m.user.tag}\` (\`${m.id}\`)`,
        `**Created:** ${t(m.user.createdTimestamp)}`,
        `**Joined:** ${t(m.joinedTimestamp)}`,
        `**Warnings:** ${await warnCount(ctx.guild.id, m.id)}`,
        m.isCommunicationDisabled() ? `**Timed out until:** <t:${Math.floor(m.communicationDisabledUntilTimestamp / 1000)}:f>` : null,
        `**Roles (${roles.size}):** ${roles.map((r) => `${r}`).join(' ').slice(0, 900) || '—'}`,
      ].filter(Boolean).join('\n')).setThumbnail(m.displayAvatarURL());
      await ctx.msg.reply({ embeds: [e], allowedMentions: { repliedUser: false } });
    },
  },
];
