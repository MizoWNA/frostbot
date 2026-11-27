// Prefix command router: "frst <command> [args]".
import { PermissionsBitField } from 'discord.js';
import { PREFIX, MAIN_GUILD_ID, MIRROR_GUILD_ID } from '../config.js';
import { embed, reply } from '../util.js';
import { isTrusted } from '../features/antinuke.js';
import { modRoleOf } from '../features/mirror.js';
import { isMod, isAdmin, adminRoleOf } from '../perms.js';
import moderation from './moderation.js';
import warnings from './warnings.js';
import admin from './admin.js';
import info from './info.js';
import matchbox from './matchbox.js';

const GROUPS = [
  ['🔨 Moderation', moderation],
  ['⚠️ Warnings', warnings],
  ['📄 Info', info],
  ['🎮 Matchbox', matchbox],
  ['🛡️ Protection, backups & settings', admin],
];

const commands = new Map();
for (const [, list] of GROUPS) {
  for (const c of list) {
    commands.set(c.name, c);
    for (const a of c.aliases ?? []) commands.set(a, c);
  }
}

const help = {
  name: 'help',
  aliases: ['commands', 'h'],
  perm: null,
  fromMirror: true,
  usage: 'help [command]',
  async run(ctx) {
    const c = ctx.args[0] && commands.get(ctx.args[0].toLowerCase());
    if (c) {
      return reply(ctx.msg, 'frost', [
        c.desc ?? '',
        `**Usage:** \`${PREFIX} ${c.usage}\``,
        c.aliases?.length ? `**Aliases:** ${c.aliases.map((a) => `\`${a}\``).join(', ')}` : '',
      ].filter(Boolean).join('\n'), `${PREFIX} ${c.name}`);
    }
    const e = embed('frost', `Prefix: \`${PREFIX} \` · \`${PREFIX} help <command>\` for details`, '❄️ Frostbot commands');
    for (const [title, list] of GROUPS) {
      const visible = list.filter((c) => canUse(ctx, c));
      if (visible.length) e.addFields({ name: title, value: visible.map((c) => `\`${c.name}\` ${c.desc}`).join('\n').slice(0, 1024) });
    }
    return ctx.msg.reply({ embeds: [e], allowedMentions: { repliedUser: false } });
  },
};
commands.set('help', help);
for (const a of help.aliases) commands.set(a, help);

function canUse(ctx, cmd) {
  const m = ctx.member;
  if (!cmd.perm) return true;
  if (m.id === ctx.guild.ownerId) return true;
  if (cmd.perm === 'owner') return false;
  if (cmd.perm === 'trusted') return isTrusted(ctx.guild, m.id);
  if (cmd.perm === 'mod') return isMod(m);
  if (cmd.perm === 'admin') return isAdmin(m);
  return m.permissions.has(cmd.perm);
}

const permLabel = (perm, guild) =>
  perm === 'owner' ? 'the server owner'
  : perm === 'trusted' ? 'the owner or a trusted user'
  : perm === 'mod' ? `the **${modRoleOf(guild)?.name ?? 'Moderators'}** role or higher`
  : perm === 'admin' ? `the **${adminRoleOf(guild)?.name ?? 'Admins'}** role or higher`
  : `the **${new PermissionsBitField(perm).toArray()[0]}** permission`;

export async function handleCommand(msg) {
  if (msg.author.bot || !msg.guild) return;
  const lower = msg.content.toLowerCase();
  if (lower !== PREFIX && !lower.startsWith(PREFIX + ' ')) return;

  const inMain = msg.guild.id === MAIN_GUILD_ID;
  const inMirror = msg.guild.id === MIRROR_GUILD_ID;
  if (!inMain && !inMirror) return;

  const args = msg.content.slice(PREFIX.length).trim().split(/\s+/).filter(Boolean);
  const name = (args.shift() ?? 'help').toLowerCase();
  const cmd = commands.get(name);
  if (!cmd) return;
  if (inMirror && !cmd.fromMirror) return reply(msg, 'warn', `\`${name}\` only works in the main server.`);

  // Commands always act on the MAIN server; from the mirror server we check the
  // caller's permissions in the main server (useful when main is nuked).
  const guild = inMain ? msg.guild : msg.client.guilds.cache.get(MAIN_GUILD_ID);
  if (!guild) return reply(msg, 'bad', "I'm not in the main server.");
  const member = inMain ? msg.member : await guild.members.fetch(msg.author.id).catch(() => null);
  if (!member) return reply(msg, 'bad', "You're not in the main server.");

  const ctx = { msg, args, guild, member, client: msg.client, prefix: PREFIX, usage: `${PREFIX} ${cmd.usage}` };
  if (!canUse(ctx, cmd)) return reply(msg, 'bad', `You need ${permLabel(cmd.perm, ctx.guild)} to use \`${name}\`.`);

  try {
    await cmd.run(ctx);
  } catch (e) {
    console.error(`[cmd ${name}]`, e);
    const hint = e.code === 50013 ? "I'm missing permissions for that (or my role is too low)." : e.message;
    await reply(msg, 'bad', `Something went wrong: ${hint}`).catch(() => {});
  }
}
