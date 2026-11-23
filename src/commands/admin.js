import { PermissionFlagsBits as P, AttachmentBuilder, GuildFeature } from 'discord.js';
import { MAIN_GUILD_ID, MIRROR_GUILD_ID, SETTING_HELP, DEFAULTS } from '../config.js';
import { embed, reply, resolveMember, resolveUser, resolveChannel, resolveRole, fmtDuration, modlog, parseIntStrict } from '../util.js';
import { getSetting, setSetting } from '../settings.js';
import { addBypass, removeBypass } from '../features/newAccounts.js';
import { setTrusted, trustedList, isFrozen } from '../features/antinuke.js';
import { generateDump, latestDump, dumpToText, parseDump, dumpSummary, dumpFileName } from '../features/dump.js';
import { restore, PARTS, restoreRunning } from '../features/restore.js';
import { mirrorStats, mirrorEnabled, syncStructure, syncRoles, syncMirrorAccess, getMirrorRow, pendingJobs } from '../features/mirror.js';
import { startHistory, stopHistory, historyStatus, setSkipped, setPacked, refreshHistoryPanel } from '../features/history.js';
import { refreshBoard } from '../features/warnings.js';

const ONOFF = new Set(['newacct', 'antinuke', 'mirror', 'rolepersist']);
const NUMS = { warn_flag: [1, 100], min_age_days: [0, 365], antinuke_window: [3, 600], antinuke_limit: [1, 50], mirror_map_days: [1, 365] };

const dumpFiles = (d, which = 'both') => [
  ...(which !== 'json' ? [new AttachmentBuilder(Buffer.from(dumpToText(d)), { name: dumpFileName(d, 'txt') })] : []),
  ...(which !== 'txt' ? [new AttachmentBuilder(Buffer.from(JSON.stringify(d, null, 2)), { name: dumpFileName(d, 'json') })] : []),
];

export default [
  // ---------------- settings ----------------
  {
    name: 'set',
    perm: P.Administrator,
    usage: 'set <setting> <value>',
    desc: 'Change a setting (see `config`)',
    async run(ctx) {
      const key = ctx.args[0]?.toLowerCase();
      let value = ctx.args.slice(1).join(' ').trim();
      if (!key || !(key in SETTING_HELP) || !value) {
        return reply(ctx.msg, 'bad', `Usage: \`${ctx.usage}\`\n\n${Object.entries(SETTING_HELP).map(([k, v]) => `\`${k}\`: ${v}`).join('\n')}`);
      }
      if (key === 'mirror_mod_role') {
        const role = resolveRole(ctx.guild, value);
        if (!role) return reply(ctx.msg, 'bad', 'Mention a role from the main server.');
        value = role.id;
      } else if (key === 'modlog') {
        if (value.toLowerCase() === 'off') value = null;
        else {
          const ch = resolveChannel(ctx.guild, value);
          if (!ch?.isTextBased()) return reply(ctx.msg, 'bad', 'Mention a text channel, or `off`.');
          value = ch.id;
        }
      } else if (ONOFF.has(key)) {
        value = value.toLowerCase();
        if (value !== 'on' && value !== 'off') return reply(ctx.msg, 'bad', `\`${key}\` is \`on\` or \`off\`.`);
      } else if (key === 'antinuke_punish') {
        value = value.toLowerCase();
        if (!['strip', 'kick', 'ban'].includes(value)) return reply(ctx.msg, 'bad', '`strip`, `kick` or `ban`.');
      } else if (NUMS[key]) {
        const n = parseIntStrict(value) ?? NaN;
        const [lo, hi] = NUMS[key];
        if (!Number.isFinite(n) || n < lo || n > hi) return reply(ctx.msg, 'bad', `\`${key}\` must be a number from ${lo} to ${hi}.`);
        value = String(n);
      }
      await setSetting(ctx.guild.id, key, value);
      await reply(ctx.msg, 'ok', `\`${key}\` → **${value === null ? 'off' : key === 'modlog' ? `<#${value}>` : key === 'mirror_mod_role' ? `<@&${value}>` : value}**`);
      if (key === 'mirror_mod_role') await syncMirrorAccess(ctx.guild).catch(() => {});
      if (key === 'warn_flag') await refreshBoard(ctx.guild).catch(() => {});
    },
  },
  {
    name: 'config',
    aliases: ['settings'],
    perm: P.Administrator,
    usage: 'config',
    desc: 'Show all settings',
    async run(ctx) {
      const show = (k) => {
        const v = getSetting(ctx.guild.id, k);
        if (k === 'modlog') return v ? `<#${v}>` : 'off';
        if (k === 'mirror_mod_role') return v ? `<@&${v}>` : 'auto (role named Moderators)';
        return v ?? 'off';
      };
      const lines = Object.keys(SETTING_HELP).map((k) => `\`${k}\` = **${show(k)}**${getSetting(ctx.guild.id, k) !== (DEFAULTS[k] ?? null) ? ' *(changed)*' : ''}\n-# ${SETTING_HELP[k]}`);
      const board = getSetting(ctx.guild.id, 'warnboard_channel');
      lines.push(`warning board: ${board ? `<#${board}>` : `not set up (\`${ctx.prefix} warnboard #channel\`)`}`);
      await reply(ctx.msg, 'info', lines.join('\n'), '⚙️ Frostbot settings');
    },
  },

  // ---------------- trust / bypass ----------------
  {
    name: 'trust',
    perm: 'owner',
    usage: 'trust @user',
    desc: 'Anti-nuke ignores this user; they can also run restore',
    async run(ctx) {
      const u = (await resolveMember(ctx.guild, ctx.args[0]))?.user ?? (await resolveUser(ctx.client, ctx.args[0]));
      if (!u) return reply(ctx.msg, 'bad', `Usage: \`${ctx.usage}\``);
      await setTrusted(ctx.guild.id, u.id, true);
      await reply(ctx.msg, 'ok', `🛡️ ${u} is now trusted. The anti-nuke ignores them and they can run restores.`);
    },
  },
  {
    name: 'untrust',
    perm: 'owner',
    usage: 'untrust @user',
    desc: 'Remove a trusted user',
    async run(ctx) {
      const id = ctx.args[0]?.replace(/\D/g, '');
      if (!id) return reply(ctx.msg, 'bad', `Usage: \`${ctx.usage}\``);
      await setTrusted(ctx.guild.id, id, false);
      await reply(ctx.msg, 'ok', `<@${id}> is no longer trusted.`);
    },
  },
  {
    name: 'trusted',
    perm: P.Administrator,
    usage: 'trusted',
    desc: 'List trusted users',
    async run(ctx) {
      const ids = trustedList(ctx.guild.id);
      await reply(ctx.msg, 'info', [`👑 <@${ctx.guild.ownerId}> (owner)`, ...ids.map((id) => `🛡️ <@${id}>`)].join('\n'), 'Trusted');
    },
  },
  {
    name: 'allow',
    perm: P.KickMembers,
    usage: 'allow <user id>',
    desc: 'Let a too-new account join anyway',
    async run(ctx) {
      const id = ctx.args[0]?.replace(/\D/g, '');
      if (!id || id.length < 17) return reply(ctx.msg, 'bad', `Usage: \`${ctx.usage}\``);
      await addBypass(ctx.guild.id, id);
      await reply(ctx.msg, 'ok', `✅ <@${id}> can join even though their account is new.`);
    },
  },
  {
    name: 'unallow',
    perm: P.KickMembers,
    usage: 'unallow <user id>',
    desc: 'Undo allow',
    async run(ctx) {
      const id = ctx.args[0]?.replace(/\D/g, '');
      if (!id) return reply(ctx.msg, 'bad', `Usage: \`${ctx.usage}\``);
      const removed = await removeBypass(ctx.guild.id, id);
      await reply(ctx.msg, removed ? 'ok' : 'warn', removed ? `Removed <@${id}> from the allow list.` : "They weren't on it.");
    },
  },

  // ---------------- backups ----------------
  {
    name: 'backup',
    aliases: ['dump'],
    perm: P.Administrator,
    fromMirror: true,
    usage: 'backup [txt|json] [force]',
    desc: 'Generate a fresh structure dump (roles, perms, channels, member roles) and send it',
    async run(ctx) {
      const force = ctx.args.some((a) => a.toLowerCase() === 'force');
      if (isFrozen(MAIN_GUILD_ID) && !force) {
        return reply(ctx.msg, 'bad', `A nuke was detected in the last 30 min. A backup now would replace the cached \`latest\` dump with the damaged server.\nIf you're sure, run \`${ctx.prefix} backup force\`.`);
      }
      const which = ctx.args.find((a) => ['txt', 'json'].includes(a.toLowerCase()))?.toLowerCase() ?? 'both';
      await ctx.msg.channel.sendTyping().catch(() => {});
      const d = await generateDump(ctx.client.rest, MAIN_GUILD_ID, `command:${ctx.msg.author.tag}`, { save: true });
      await ctx.msg.reply({
        content: `📦 Fresh dump: ${dumpSummary(d)}\n-# Also cached as \`latest\` (replaces the previous one).`,
        files: dumpFiles(d, which),
        allowedMentions: { repliedUser: false },
      });
    },
  },
  {
    name: 'restore',
    perm: 'trusted',
    fromMirror: true,
    usage: `restore [latest] [${PARTS.join('|')}…]  (attach a dump .json, or say latest)`,
    desc: 'Rebuild the server from a dump, then refill recreated channels from the mirror',
    async run(ctx) {
      if (restoreRunning()) return reply(ctx.msg, 'bad', 'A restore is already running.');
      const args = ctx.args.map((a) => a.toLowerCase());

      // Which dump?
      let dump;
      const file = ctx.msg.attachments.find((a) => a.name.endsWith('.json'));
      try {
        if (file) dump = parseDump(await (await fetch(file.url)).text());
        else if (args.includes('latest')) dump = await latestDump(MAIN_GUILD_ID);
      } catch (e) {
        return reply(ctx.msg, 'bad', e.message);
      }
      if (!dump) {
        return reply(ctx.msg, 'bad', `Attach one of your saved \`dump.json\` files, or use \`${ctx.prefix} restore latest\` for the last dump the bot generated.\nUsage: \`${ctx.usage}\``);
      }

      const picked = PARTS.filter((p) => args.includes(p));
      const parts = new Set(picked.length ? picked : PARTS);
      const g = ctx.guild;
      await g.roles.fetch();
      await g.channels.fetch();
      const missingRoles = dump.roles.filter((r) => !r.isEveryone && !r.managed && !g.roles.cache.has(r.id));
      const missingChans = dump.channels.filter((c) => !g.channels.cache.has(c.id));
      const refill = missingChans.filter((c) => getMirrorRow(c.id));

      const preview = [
        `**Dump:** ${dumpSummary(dump)}`,
        `**Will run:** ${[...parts].join(', ')}`,
        dump.guild.id !== MAIN_GUILD_ID && `⚠️ This dump is from a **different server** (\`${dump.guild.id}\`), so everything gets created fresh here.`,
        '',
        parts.has('roles') && `• Recreate **${missingRoles.length}** missing role(s), reset perms on existing ones`,
        parts.has('channels') && `• Recreate **${missingChans.length}** missing channel(s), reset overwrites on existing ones`,
        parts.has('members') && `• Give members back the roles they're missing`,
        parts.has('messages') && `• Refill **${refill.length}** recreated channel(s) from the mirror${mirrorEnabled() ? '' : ' ⚠️ mirror server unavailable'}`,
        parts.has('settings') && `• Reset server name/icon/verification/system channel`,
        '',
        `Type **\`confirm\`** within 60s to start, or \`cancel\`.`,
      ].filter((l) => l !== false);
      await reply(ctx.msg, 'warn', preview.join('\n'), '♻️ Restore preview');

      const answer = await ctx.msg.channel
        .awaitMessages({ filter: (m) => m.author.id === ctx.msg.author.id && /^(confirm|cancel)$/i.test(m.content.trim()), max: 1, time: 60_000 })
        .then((c) => c.first()?.content.trim().toLowerCase());
      if (answer !== 'confirm') return reply(ctx.msg, 'info', 'Restore cancelled.');

      // Progress: one message, edited as we go.
      const lines = [];
      const status = await ctx.msg.channel.send({ embeds: [embed('info', 'Starting…', '♻️ Restoring')] });
      let lastEdit = 0;
      const log = async (line) => {
        lines.push(line);
        if (Date.now() - lastEdit < 1500) return;
        lastEdit = Date.now();
        await status.edit({ embeds: [embed('info', lines.slice(-15).join('\n'), '♻️ Restoring')] }).catch(() => {});
      };

      const started = Date.now();
      try {
        const s = await restore(g, dump, parts, log);
        const summary = [
          ...lines.slice(-10),
          '',
          `**Done in ${fmtDuration(Date.now() - started)}.** Roles +${s.rolesMade} (${s.rolesSynced} reset) · Channels +${s.chansMade} (${s.chansSynced} reset) · Members fixed ${s.membersFixed} · Messages ${s.messages}`,
          s.errors.length ? `\n⚠️ **${s.errors.length} problem(s):**\n${s.errors.slice(0, 8).map((e) => `• ${e}`).join('\n')}` : '',
        ].join('\n');
        await status.edit({ embeds: [embed(s.errors.length ? 'warn' : 'ok', summary.slice(0, 4000), '♻️ Restore finished')] }).catch(() =>
          ctx.msg.channel.send({ embeds: [embed('ok', summary.slice(0, 4000), '♻️ Restore finished')] }),
        );
        await modlog(g, embed('info', `Restore run by ${ctx.msg.author} (${[...parts].join(', ')}).`, '♻️ Restore'));
      } catch (e) {
        await status.edit({ embeds: [embed('bad', `Restore failed: ${e.message}\n\n${lines.slice(-8).join('\n')}`, '♻️ Restore failed')] }).catch(() => {});
      }
    },
  },

  // ---------------- mirror ----------------
  {
    name: 'mirror',
    perm: P.Administrator,
    fromMirror: true,
    usage: 'mirror <status|sync|history [start|stop|panel [off]|skip #ch|unskip #ch|first #ch|pack #ch|unpack #ch]>',
    desc: 'Mirror status, sync roles/channels/access into it, or copy the full message history',
    async run(ctx) {
      const sub = ctx.args[0]?.toLowerCase() ?? 'status';
      if (!MIRROR_GUILD_ID) return reply(ctx.msg, 'bad', 'Set `MIRROR_GUILD_ID` in `.env` first.');
      if (!ctx.client.guilds.cache.has(MIRROR_GUILD_ID)) return reply(ctx.msg, 'bad', "I'm not in the mirror server. Invite me there with Administrator.");

      if (sub === 'status') {
        const s = await mirrorStats();
        return reply(ctx.msg, 'info', [
          `**Mirroring:** ${mirrorEnabled() ? '🟢 on' : '🔴 off'}`,
          `**Mirror server:** ${ctx.client.guilds.cache.get(MIRROR_GUILD_ID).name}`,
          `**Channels linked:** ${s.channels}`,
          `**Message links kept:** ${s.linkedMessages} (last ${getSetting(MAIN_GUILD_ID, 'mirror_map_days')} days, for edit/delete sync)`,
          `**Queue:** ${pendingJobs()} channel(s) busy`,
        ].join('\n'), '🪞 Mirror');
      }
      if (sub === 'sync') {
        const status = await ctx.msg.reply({ embeds: [embed('info', 'Syncing roles…', '🪞 Mirror sync')], allowedMentions: { repliedUser: false } });
        const progress = (line) => status.edit({ embeds: [embed('info', line, '🪞 Mirror sync')] }).catch(() => {});
        const r = await syncRoles(ctx.guild, progress);
        await progress('Syncing channels…');
        const c = await syncStructure(ctx.guild, progress);
        await progress('Syncing access…');
        const a = await syncMirrorAccess(ctx.guild);
        return status.edit({ embeds: [embed(r.failed || c.failed ? 'warn' : 'ok', [
          `**Roles:** ${r.made} created, ${r.updated} updated, ${r.same} already matched${r.failed ? `, ⚠️ ${r.failed} failed` : ''} (no permissions copied)`,
          `**Channels:** ${c.made} created${c.failed ? `, ⚠️ ${c.failed} failed` : ''}, ${c.ordered ? `${c.ordered} reordered` : 'order already right'}`,
          `**Access:** read-only for everyone, ${a.hidden} staff-only channel(s) visible to Mirror Master only (mod line: ${a.modRole}), staff chat <#${a.chat}>`,
          '-# Only the mirror server was changed.',
        ].join('\n'), '🪞 Mirror sync done')] });
      }
      if (sub === 'history' || sub === 'backfill') {
        const action = ctx.args[1]?.toLowerCase() ?? 'status';
        if (action === 'start') {
          const started = await startHistory(ctx.guild);
          return reply(ctx.msg, started ? 'ok' : 'warn', started ? `📜 Full-history copy started in the background. Check with \`${ctx.prefix} mirror history\`.` : 'It is already running.');
        }
        if (action === 'stop') {
          await stopHistory();
          return reply(ctx.msg, 'ok', `Stopping after the current batch. Resume any time with \`${ctx.prefix} mirror history start\`.`);
        }
        if (action === 'panel') {
          if (ctx.msg.guild?.id !== MAIN_GUILD_ID) return reply(ctx.msg, 'bad', 'Run this in the main server, in the channel the panel should live in.');
          const oldCh = ctx.guild.channels.cache.get(getSetting(MAIN_GUILD_ID, 'history_panel_channel'));
          const oldMsg = getSetting(MAIN_GUILD_ID, 'history_panel_message');
          if (oldCh && oldMsg) await oldCh.messages.delete(oldMsg).catch(() => {});
          await setSetting(MAIN_GUILD_ID, 'history_panel_message', null);
          if (ctx.args[2]?.toLowerCase() === 'off') {
            await setSetting(MAIN_GUILD_ID, 'history_panel_channel', null);
            return reply(ctx.msg, 'ok', 'Rebuild panel removed.');
          }
          await setSetting(MAIN_GUILD_ID, 'history_panel_channel', ctx.msg.channel.id);
          refreshHistoryPanel(ctx.guild);
          return ctx.msg.react('📜').catch(() => {});
        }
        if (action === 'pack' || action === 'unpack') {
          const ch = resolveChannel(ctx.guild, ctx.args[2]);
          if (!ch) return reply(ctx.msg, 'bad', `Usage: \`${ctx.prefix} mirror history ${action} #channel\``);
          await setPacked(ch.id, action === 'pack');
          return reply(ctx.msg, 'ok', action === 'pack'
            ? `${ch}: old text messages will be copied 10 per post (about 10× faster). Files still go one by one. Applies from the next batch after a restart of the copy.`
            : `${ch}: old messages will be copied one by one again.`);
        }
        if (action === 'skip' || action === 'unskip' || action === 'first') {
          const ch = resolveChannel(ctx.guild, ctx.args[2]);
          if (!ch) return reply(ctx.msg, 'bad', `Usage: \`${ctx.prefix} mirror history ${action} #channel\``);
          if (action === 'first') {
            await setSetting(MAIN_GUILD_ID, 'history_first', ch.id);
            return reply(ctx.msg, 'ok', `${ch} goes first from the next start (\`${ctx.prefix} mirror history stop\` then \`start\` to apply now).`);
          }
          await setSkipped(ch.id, action === 'skip');
          refreshHistoryPanel(ctx.guild);
          return reply(ctx.msg, 'ok', action === 'skip'
            ? `${ch}: no old history will be copied, only new messages from now on.`
            : `${ch} will be copied from the very start on the next run.`);
        }
        const h = await historyStatus(ctx.guild);
        const lines = [
          `**State:** ${h.state}${h.running ? ' (running)' : ''}`,
          `**Channels finished:** ${h.channelsDone}/${h.channelsTotal}${h.skipped.length ? ` (+${h.skipped.length} live-only)` : ''}`,
          `**Messages:** ${h.messages.toLocaleString()} copied, ${h.seen.toLocaleString()} / ${h.total.toLocaleString()} looked at`,
          ...h.active.map((a) => `⏳ #${a.name}: ${a.pct != null ? `${a.pct.toFixed(1)}%` : '?'} (up to <t:${Math.floor(a.at / 1000)}:d>), ${a.rate == null ? 'measuring' : `${Math.round(a.rate)}/min`}${a.failed ? `, ⚠️ ${a.failed} failed` : ''}`),
          `-# Live panel: \`${ctx.prefix} mirror history panel\` in any channel`,
        ];
        return reply(ctx.msg, 'info', lines.join('\n'), '📜 History copy');
      }
      return reply(ctx.msg, 'bad', `Usage: \`${ctx.usage}\``);
    },
  },
  {
    name: 'status',
    aliases: ['ping'],
    perm: P.ModerateMembers,
    fromMirror: true,
    usage: 'status',
    desc: 'Bot health',
    async run(ctx) {
      const mem = process.memoryUsage().rss / 1024 / 1024;
      await reply(ctx.msg, 'info', [
        `**Gateway ping:** ${ctx.client.ws.ping} ms`,
        `**Uptime:** ${fmtDuration(process.uptime() * 1000)}`,
        `**Memory:** ${mem.toFixed(0)} MB`,
        `**Anti-nuke:** ${getSetting(MAIN_GUILD_ID, 'antinuke') === 'on' ? '🟢' : '🔴'}${isFrozen(MAIN_GUILD_ID) ? ' (⚠️ nuke detected recently)' : ''}`,
        `**Mirror:** ${mirrorEnabled() ? '🟢' : '🔴'}`,
        `**Community server:** ${ctx.guild.features.includes(GuildFeature.Community) ? 'yes' : 'no'}`,
      ].join('\n'), '❄️ Frostbot');
    },
  },
];
