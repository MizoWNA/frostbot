import { PermissionFlagsBits as P } from 'discord.js';
import { embed, reply, modlog, resolveMember, resolveUser, resolveChannel, truncate, parseIntStrict } from '../util.js';
import { getNum } from '../settings.js';
import { addWarning, listWarnings, getWarning, removeWarning, clearWarnings, refreshBoard, setupBoard } from '../features/warnings.js';

export default [
  {
    name: 'warn',
    perm: 'mod',
    usage: 'warn @user <reason>',
    desc: 'Warn a member (updates the warning board)',
    async run(ctx) {
      const m = await resolveMember(ctx.guild, ctx.args[0]);
      if (!m) return reply(ctx.msg, 'bad', `Couldn't find that member.\nUsage: \`${ctx.usage}\``);
      // No role-hierarchy / self check: a warning is just a record, so anyone with the
      // permission can warn anyone (themselves and higher staff included).
      const reason = ctx.args.slice(1).join(' ');
      if (!reason) return reply(ctx.msg, 'bad', `Give a reason.\nUsage: \`${ctx.usage}\``);

      const { id, count } = await addWarning(ctx.guild, m.user, ctx.member.id, reason);
      const flag = getNum(ctx.guild.id, 'warn_flag');
      await m.send(`⚠️ You were warned in **${ctx.guild.name}**: ${reason}\nYou now have ${count} warning(s).`).catch(() => {});
      await reply(ctx.msg, count >= flag ? 'bad' : 'warn', `⚠️ Warned ${m} (#${id}). They now have **${count}** warning(s).${count >= flag ? `\n🚨 **At the limit (${flag}), they need action.**` : ''}`);
      await refreshBoard(ctx.guild).catch((e) => console.error('[warnboard]', e.message));
      await modlog(
        ctx.guild,
        embed(count >= flag ? 'bad' : 'warn', [`**User:** ${m} \`${m.user.tag}\``, `**Reason:** ${reason}`, `**Total:** ${count}`, `**Mod:** ${ctx.member}`].join('\n'), count === flag ? '🚨 Warning limit reached, action needed' : `Warning #${id}`),
      );
    },
  },
  {
    name: 'warns',
    aliases: ['warnings'],
    perm: 'mod',
    usage: 'warns @user',
    desc: "List a member's warnings",
    async run(ctx) {
      const user = (await resolveMember(ctx.guild, ctx.args[0]))?.user ?? (await resolveUser(ctx.client, ctx.args[0]));
      if (!user) return reply(ctx.msg, 'bad', `Usage: \`${ctx.usage}\``);
      const list = await listWarnings(ctx.guild.id, user.id);
      if (!list.length) return reply(ctx.msg, 'ok', `${user} has no active warnings.`);
      const lines = list.map((w) => `**#${w.id}** · <t:${Math.floor(w.created_at.getTime() / 1000)}:R> by <@${w.mod_id}>: ${truncate(w.reason, 120)}`);
      await reply(ctx.msg, 'warn', lines.join('\n').slice(0, 4000), `${user.tag}: ${list.length} warning(s)`);
    },
  },
  {
    name: 'unwarn',
    aliases: ['delwarn'],
    perm: 'mod',
    usage: 'unwarn <warning #>',
    desc: 'Remove one warning by its number',
    async run(ctx) {
      const id = parseIntStrict(ctx.args[0]?.replace(/^#/, ''));
      const w = id && (await getWarning(ctx.guild.id, id));
      if (!w) return reply(ctx.msg, 'bad', `No active warning with that number. Check \`${ctx.prefix} warns @user\`.`);
      await removeWarning(ctx.guild.id, id);
      await reply(ctx.msg, 'ok', `Removed warning #${id} from <@${w.user_id}>.`);
      await refreshBoard(ctx.guild).catch(() => {});
      await modlog(ctx.guild, embed('ok', `Warning #${id} on <@${w.user_id}> removed by ${ctx.member}.`));
    },
  },
  {
    name: 'clearwarns',
    perm: 'mod',
    usage: 'clearwarns @user',
    desc: "Clear all of a member's warnings",
    async run(ctx) {
      const user = (await resolveMember(ctx.guild, ctx.args[0]))?.user ?? (await resolveUser(ctx.client, ctx.args[0]));
      if (!user) return reply(ctx.msg, 'bad', `Usage: \`${ctx.usage}\``);
      const n = await clearWarnings(ctx.guild.id, user.id);
      await reply(ctx.msg, 'ok', `Cleared **${n}** warning(s) from ${user}.`);
      await refreshBoard(ctx.guild).catch(() => {});
      await modlog(ctx.guild, embed('ok', `${ctx.member} cleared ${n} warning(s) from ${user}.`));
    },
  },
  {
    name: 'warnboard',
    perm: P.ManageGuild,
    usage: 'warnboard [#channel]',
    desc: 'Post the warning board in a channel; it stays the last message there (or refresh it)',
    async run(ctx) {
      const ch = resolveChannel(ctx.guild, ctx.args[0]) ?? ctx.msg.channel;
      if (!ch.isTextBased()) return reply(ctx.msg, 'bad', 'Pick a text channel.');
      const msg = await setupBoard(ctx.guild, ch);
      await reply(ctx.msg, 'ok', `📌 Warning board set up in ${ch}. It moves back to the bottom when people chat: ${msg.url}`);
    },
  },
];
