// `frst mc ...`: Matchbox (Minecraft) linking, gamemaster channel and game control.
import { ChannelType } from 'discord.js';
import { reply } from '../util.js';
import { isAdmin } from '../perms.js';
import {
  claimChannel, releaseChannel, gameChannelId, currentGame, releaseAll,
  redeemLinkCode, unlink, listLinks, runServerCommand,
} from '../features/matchbox.js';

const NAME = /^[A-Za-z0-9_-]{1,32}$/;
// Game control commands, forwarded to the Minecraft server's console as "matchbox <verb> <name>".
const SERVER_VERBS = new Set(['create', 'start', 'forcestart', 'stop', 'skip']);
const stripColors = (s) => s.replace(/§./g, '');

const USAGE = [
  '`mc link <code>` link your Minecraft player (get the code with `/matchbox link` in game)',
  '`mc unlink` · `mc status`',
  '**Admins:** `mc here` (from a voice channel: becomes the Matchbox channel) · `mc leave`',
  '`mc create|start|stop|skip <name>` · `mc forcestart <name>` (too few players, testing)',
  '`mc links` · `mc unmute` (unmute everyone the bot muted)',
].join('\n');

async function run(ctx) {
  const [sub = 'status', arg] = ctx.args.map((a, i) => (i === 0 ? a.toLowerCase() : a));
  const admin = isAdmin(ctx.member);
  const needAdmin = () => reply(ctx.msg, 'bad', 'Only admins can do that.');

  if (sub === 'link') {
    if (!arg) return reply(ctx.msg, 'warn', 'Type `/matchbox link` in Minecraft first, then use the code it gives you here.');
    const name = await redeemLinkCode(arg, ctx.member.id);
    return name
      ? reply(ctx.msg, 'ok', `Linked to **${name}** in Minecraft.`)
      : reply(ctx.msg, 'bad', "That code is wrong or expired (they last 10 minutes). Get a new one with `/matchbox link` in game.");
  }
  if (sub === 'unlink') {
    const name = await unlink(ctx.member.id);
    return reply(ctx.msg, name ? 'ok' : 'warn', name ? `Unlinked from **${name}**.` : "You weren't linked.");
  }
  if (sub === 'status') {
    const ch = gameChannelId();
    const g = currentGame();
    return reply(ctx.msg, 'frost', [
      `**Matchbox channel:** ${ch ? `<#${ch}>` : 'none (an admin runs `mc here` from a voice channel)'}`,
      `**Game:** ${g ? `\`${g.session}\`, ${g.phase === 'play' ? 'round in progress (muted)' : 'meeting'}` : 'none running'}`,
    ].join('\n'), 'Matchbox');
  }

  if (!admin) return sub === 'help' ? reply(ctx.msg, 'frost', USAGE, 'Matchbox') : needAdmin();

  if (sub === 'here') {
    const channel = ctx.member.voice?.channel;
    if (!channel || channel.guild.id !== ctx.guild.id || channel.type !== ChannelType.GuildVoice) {
      return reply(ctx.msg, 'warn', 'Join the voice channel you want to use first, then run this.');
    }
    await claimChannel(channel);
    return reply(ctx.msg, 'ok', `${channel} is now the Matchbox channel. I'll control mutes there while a game runs.`);
  }
  if (sub === 'leave') {
    await releaseChannel();
    return reply(ctx.msg, 'ok', "Left the Matchbox channel and unmuted everyone I'd muted.");
  }
  if (sub === 'unmute') {
    await releaseAll();
    return reply(ctx.msg, 'ok', "Unmuted everyone I'd muted and forgot any running game state.");
  }
  if (sub === 'links') {
    const rows = await listLinks();
    return reply(ctx.msg, 'frost', rows.length ? rows.map((r) => `**${r.mc_name}** → <@${r.discord_id}>`).join('\n').slice(0, 4000) : 'Nobody is linked yet.', 'Matchbox links');
  }
  if (SERVER_VERBS.has(sub)) {
    if (!arg || !NAME.test(arg)) return reply(ctx.msg, 'warn', `Usage: \`${ctx.prefix} mc ${sub} <name>\` (letters, numbers, - and _).`);
    const res = await runServerCommand(`matchbox ${sub} ${arg}`, ctx.member.id);
    if (!res) return reply(ctx.msg, 'warn', "The Minecraft server didn't answer within 10 seconds. Is it running? (The command was dropped.)");
    const text = stripColors(res.result).trim() || 'Done.';
    return reply(ctx.msg, res.ok ? 'ok' : 'bad', '```\n' + text.slice(0, 1900) + '\n```');
  }
  return reply(ctx.msg, 'frost', USAGE, 'Matchbox');
}

export default [
  {
    name: 'mc',
    aliases: ['matchbox'],
    perm: null, // linking is for everyone; admin subcommands check inside
    desc: 'Matchbox (Minecraft): link your player, gamemaster voice channel, game control',
    usage: 'mc <link|unlink|status|here|leave|create|start|stop|skip|links|unmute> [args]',
    run,
  },
];
