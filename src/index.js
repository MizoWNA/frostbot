import './env.js';
import { Client, GatewayIntentBits as I, Partials, Events, Options, ActivityType } from 'discord.js';
import { TOKEN, PREFIX, MAIN_GUILD_ID, MIRROR_GUILD_ID } from './config.js';
import { sql } from './db.js';
import { loadSettings, getNum } from './settings.js';
import { handleCommand } from './commands/index.js';
import * as mirror from './features/mirror.js';
import { onAuditEntry, loadTrusted } from './features/antinuke.js';
import { checkNewAccount } from './features/newAccounts.js';
import { saveMember, syncAll, onRejoin } from './features/memberRoles.js';
import { refreshBoard } from './features/warnings.js';
import { embed, modlog } from './util.js';
import { acquireLock, releaseLock } from './lock.js';
import { resumeHistoryIfNeeded, haltHistoryForShutdown } from './features/history.js';
import { onStickyChannelMessage } from './features/sticky.js';

if (!TOKEN) throw new Error('DISCORD_TOKEN is not set (see .env.example)');
if (!MAIN_GUILD_ID) throw new Error('MAIN_GUILD_ID is not set (see .env.example)');

const client = new Client({
  intents: [
    I.Guilds,
    I.GuildMembers, // privileged: joins, role tracking
    I.GuildMessages,
    I.MessageContent, // privileged: prefix commands + mirror
    I.GuildModeration, // audit log events for anti-nuke
    I.GuildWebhooks,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
  // Keep memory low (small VM): only a few recent messages per channel, no presences.
  makeCache: Options.cacheWithLimits({
    ...Options.DefaultMakeCacheSettings,
    MessageManager: 50,
    PresenceManager: 0,
    GuildStickerManager: 0,
    GuildScheduledEventManager: 0,
    VoiceStateManager: 0,
  }),
  sweepers: {
    ...Options.DefaultSweeperSettings,
    messages: { interval: 900, lifetime: 1800 },
  },
  allowedMentions: { parse: ['users'], repliedUser: false },
});

const isMain = (g) => g?.id === MAIN_GUILD_ID;

client.once(Events.ClientReady, async () => {
  console.log(`[ready] logged in as ${client.user.tag}`);
  client.user.setActivity(`${PREFIX} help`, { type: ActivityType.Watching });

  const main = client.guilds.cache.get(MAIN_GUILD_ID);
  if (!main) console.warn(`[ready] not in the main server (${MAIN_GUILD_ID}) yet, invite me!`);
  if (MIRROR_GUILD_ID && !client.guilds.cache.has(MIRROR_GUILD_ID)) console.warn(`[ready] not in the mirror server (${MIRROR_GUILD_ID}) yet`);

  await mirror.initMirror(client);
  if (!main) return;

  await main.members.fetch();
  await syncAll(main).catch((e) => console.error('[memberRoles] sync failed:', e.message));
  if (mirror.mirrorEnabled()) {
    const r = await mirror.syncRoles(main).catch((e) => console.error('[mirror] roles:', e.message));
    const c = await mirror.syncStructure(main).catch((e) => console.error('[mirror] channels:', e.message));
    const a = await mirror.syncMirrorAccess(main).catch((e) => console.error('[mirror] access:', e.message));
    console.log('[mirror] synced', { roles: r, channels: c, access: a });
    resumeHistoryIfNeeded(main);
  }
  await refreshBoard(main).catch(() => {});

  // Forget old main↔mirror message links (they only exist so edits/deletes can sync).
  const prune = () =>
    mirror
      .pruneMessageLinks(getNum(MAIN_GUILD_ID, 'mirror_map_days') || 30)
      .then((n) => n && console.log(`[mirror] pruned ${n} old message link(s)`))
      .catch((e) => console.error('[mirror] prune failed:', e.message));
  prune();
  setInterval(prune, 6 * 3_600_000).unref();
  console.log(`[ready] watching ${main.name} (${main.memberCount} members)`);
});

client.on(Events.MessageCreate, (msg) => {
  handleCommand(msg).catch((e) => console.error('[command]', e));
  mirror.onMessage(msg);
  onStickyChannelMessage(msg);
});
client.on(Events.MessageUpdate, (o, n) => mirror.onEdit(o, n));
client.on(Events.MessageDelete, (m) => mirror.onDelete(m));
client.on(Events.MessageBulkDelete, (msgs) => msgs.forEach((m) => mirror.onDelete(m)));

client.on(Events.ChannelCreate, async (ch) => {
  if (!isMain(ch.guild) || !mirror.mirrorEnabled() || !mirror.MESSAGE_TYPES.has(ch.type)) return;
  await mirror.ensureMirrorChannel(ch).catch(() => {});
  mirror.scheduleAccessSync(ch.guild);
});
client.on(Events.ChannelUpdate, (o, n) => {
  if (!isMain(n.guild) || !mirror.mirrorEnabled() || !mirror.MESSAGE_TYPES.has(n.type)) return;
  if (o.name !== n.name || o.nsfw !== n.nsfw || o.parentId !== n.parentId) mirror.ensureMirrorChannel(n, { rename: o.name !== n.name }).catch(() => {});
  if (!o.permissionOverwrites.cache.equals(n.permissionOverwrites.cache) || o.parentId !== n.parentId) mirror.scheduleAccessSync(n.guild);
});
client.on(Events.GuildRoleCreate, (r) => {
  if (isMain(r.guild) && mirror.mirrorEnabled()) mirror.syncOneRole(r).catch((e) => console.error('[mirror] role:', e.message));
});
client.on(Events.GuildRoleUpdate, (o, n) => {
  if (!isMain(n.guild) || !mirror.mirrorEnabled()) return;
  if (o.name !== n.name || o.hoist !== n.hoist || o.color !== n.color) mirror.syncOneRole(n).catch((e) => console.error('[mirror] role:', e.message));
  if (o.permissions.bitfield !== n.permissions.bitfield || o.position !== n.position) mirror.scheduleAccessSync(n.guild);
});

client.on(Events.GuildMemberAdd, async (member) => {
  if (!isMain(member.guild)) return;
  if (await checkNewAccount(member).catch((e) => (console.error('[newacct]', e), false))) return;
  const given = await onRejoin(member);
  if (given) await modlog(member.guild, embed('info', `🔁 ${member} rejoined and got **${given}** saved role(s) back.`));
  await saveMember(member);
});
client.on(Events.GuildMemberUpdate, (o, n) => {
  if (isMain(n.guild) && !o.roles.cache.equals(n.roles.cache)) saveMember(n);
});

client.on(Events.GuildAuditLogEntryCreate, (entry, guild) => {
  if (isMain(guild)) onAuditEntry(entry, guild).catch((e) => console.error('[antinuke]', e));
});

client.on(Events.Error, (e) => console.error('[client]', e));
// discord.js waits out rate limits silently; surface the long ones so a "stuck" sync is explainable.
client.rest.on('rateLimited', (i) => {
  if (i.timeToReset >= 5000) console.warn(`[ratelimit] ${i.method} ${i.route} → waiting ${Math.round(i.timeToReset / 1000)}s${i.global ? ' (GLOBAL)' : ''} (scope: ${i.scope ?? '?'})`);
});
process.on('unhandledRejection', (e) => console.error('[unhandled]', e));

async function shutdown(sig) {
  console.log(`[exit] ${sig}, shutting down`);
  haltHistoryForShutdown();
  await client.destroy().catch(() => {});
  await releaseLock();
  await sql.end({ timeout: 5 }).catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await acquireLock(); // waits if another copy (e.g. on Bot-Hosting) is already running
await loadSettings();
await loadTrusted();
await client.login(TOKEN);
