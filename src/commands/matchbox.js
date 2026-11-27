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
  '`mc timer` show timers · `mc timer <play|meeting|first-meeting|swap|blind> <time>` e.g. `mc timer play 5m`',
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
  if (sub === 'timer' || sub === 'timers') {
    const [, name, time] = ctx.args;
    let command = 'matchbox timer';
    if (name || time) {
      if (!name || !time || !/^[a-z-]{1,16}$/i.test(name) || !/^[0-9ms]{1,8}$/i.test(time)) {
        return reply(ctx.msg, 'warn', `Usage: \`${ctx.prefix} mc timer <name> <time>\`, e.g. \`${ctx.prefix} mc timer play 5m\` (\`${ctx.prefix} mc timer\` lists them).`);
      }
      command += ` ${name.toLowerCase()} ${time.toLowerCase()}`;
    }
    return serverReply(ctx, command);
  }
  if (SERVER_VERBS.has(sub)) {
    if (!arg || !NAME.test(arg)) return reply(ctx.msg, 'warn', `Usage: \`${ctx.prefix} mc ${sub} <name>\` (letters, numbers, - and _).`);
    return serverReply(ctx, `matchbox ${sub} ${arg}`);
  }
  return reply(ctx.msg, 'frost', USAGE, 'Matchbox');
}

/** Runs a console command on the Minecraft server and posts its output. */
async function serverReply(ctx, command) {
  const res = await runServerCommand(command, ctx.member.id);
  if (!res) return reply(ctx.msg, 'warn', "The Minecraft server didn't answer within 10 seconds. Is it running? (The command was dropped.)");
  const text = stripColors(res.result).trim() || 'Done.';
  return reply(ctx.msg, res.ok ? 'ok' : 'bad', '```\n' + text.slice(0, 1900) + '\n```');
}

export default [
  {
    name: 'mc',
    aliases: ['matchbox'],
    perm: null, // linking is for everyone; admin subcommands check inside
    desc: 'Matchbox (Minecraft): link your player, gamemaster voice channel, game control',
    usage: 'mc <link|unlink|status|here|leave|create|start|stop|skip|timer|links|unmute> [args]',
    run,
  },
];
