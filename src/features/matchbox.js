// Matchbox (Minecraft social deduction) voice control: "gamemaster mode".
//
// An admin runs `frst mc here` from a voice channel; the bot joins it and that channel
// becomes the Matchbox channel (setting `mc_channel`, rejoined after restarts). While a
// game is running, the bot controls mutes for the people IN THAT CHANNEL only:
//   play     everyone muted (players talk with signs in game)
//   meeting  alive linked players unmuted; dead players and unlinked people stay muted
//   no game  nobody muted by the bot
// Leaving the channel unmutes you right away (a Discord server mute follows you into every
// channel otherwise). The bot only ever unmutes people it muted itself (frostbot.mc_muted),
// so a moderator's own server mute is never undone.
//
// The Minecraft plugin writes each game's state to frostbot.mc_games (phase + alive/dead
// Minecraft UUIDs) and NOTIFYs; it's state, not events, so after a restart the bot simply
// re-reads it and fixes everyone. Linking: `/matchbox link` in game → `frst mc link CODE`.

import { ChannelType } from 'discord.js';
import { sql } from '../db.js';
import { MAIN_GUILD_ID, PREFIX } from '../config.js';
import { getSetting, setSetting } from '../settings.js';

const REASON = 'Matchbox gamemaster: game voice control';
const STALE_MS = 90_000;

let client = null;
let linksByUuid = new Map(); // mc uuid -> discord id
let game = null; // { session, phase, alive: Set<discordId>, linkedPlayers: Set<discordId> } or null
let mutedByUs = new Set(); // discord ids
let announced = new Set(); // sessions whose start was announced in the channel
let queue = Promise.resolve();

const mainGuild = () => client?.guilds.cache.get(MAIN_GUILD_ID);
export const gameChannelId = () => getSetting(MAIN_GUILD_ID, 'mc_channel');
export const currentGame = () => game;

/** Run one reconcile at a time, in order. */
const serial = (fn) => (queue = queue.then(fn).catch((e) => console.error('[matchbox]', e.message)));

// ---------- the bot's own presence in the channel ----------

/** Join (or leave, with null) a voice channel without an audio connection: just the gateway
 * voice-state update, so the bot shows up in the channel. Self-deafened; it never listens. */
function setBotVoice(guild, channelId) {
  guild.shard.send({ op: 4, d: { guild_id: guild.id, channel_id: channelId, self_mute: true, self_deaf: true } });
}

export async function claimChannel(channel) {
  await setSetting(MAIN_GUILD_ID, 'mc_channel', channel.id);
  setBotVoice(channel.guild, channel.id);
  await refresh();
}

export async function releaseChannel() {
  const guild = mainGuild();
  await setSetting(MAIN_GUILD_ID, 'mc_channel', null);
  if (guild) setBotVoice(guild, null);
  await refresh(); // nobody is in "the channel" any more → unmute everyone we muted
}

// ---------- desired state ----------

/** Should this member be muted right now? Only people in the Matchbox channel during a game. */
function wantMuted(member) {
  const channelId = gameChannelId();
  if (!game || !channelId || member.voice?.channelId !== channelId || member.user.bot) return false;
  if (game.phase === 'play') return true;
  return !game.alive.has(member.id); // meeting: only alive linked players talk
}

async function applyMember(member) {
  if (!member?.voice?.channelId) return; // Discord can only (un)mute someone who is in voice
  const mutedNow = member.voice.serverMute;
  if (wantMuted(member)) {
    if (!mutedNow) {
      await member.voice.setMute(true, REASON);
      if (!mutedByUs.has(member.id)) {
        mutedByUs.add(member.id);
        await sql`insert into frostbot.mc_muted (discord_id) values (${member.id}) on conflict do nothing`;
      }
    }
    return;
  }
  if (mutedByUs.has(member.id)) {
    if (mutedNow) await member.voice.setMute(false, REASON);
    mutedByUs.delete(member.id);
    await sql`delete from frostbot.mc_muted where discord_id = ${member.id}`;
  }
}

async function loadState() {
  const links = await sql`select mc_uuid, discord_id from frostbot.mc_links`;
  linksByUuid = new Map(links.map((r) => [r.mc_uuid, r.discord_id]));

  const games = await sql`select session, phase, alive, dead, updated_at from frostbot.mc_games order by updated_at desc`;
  const ended = games.filter((g) => g.phase === 'ended').map((g) => g.session);
  // One game at a time per channel. The plugin re-sends its state every 30s; a game it hasn't
  // touched in 90s means the Minecraft server died, so nobody should stay muted for it.
  const live = games.find((g) => g.phase !== 'ended' && Date.now() - new Date(g.updated_at).getTime() < STALE_MS);
  if (live) {
    const ids = (uuids) => uuids.map((u) => linksByUuid.get(u)).filter(Boolean);
    game = {
      session: live.session,
      phase: live.phase,
      alive: new Set(ids(live.alive)),
      linkedPlayers: new Set([...ids(live.alive), ...ids(live.dead)]),
      unlinkedCount: [...live.alive, ...live.dead].filter((u) => !linksByUuid.has(u)).length,
    };
  } else {
    game = null;
  }
  for (const s of ended) announced.delete(s);
  if (ended.length) await sql`delete from frostbot.mc_games where phase = 'ended' and session in ${sql(ended)}`;
}

async function reconcile() {
  const guild = mainGuild();
  if (!guild) return;
  const channelId = gameChannelId();
  const channel = channelId ? guild.channels.cache.get(channelId) : null;

  // Everyone in the channel, plus anyone we muted who may have wandered off.
  const ids = new Set(mutedByUs);
  if (channel) for (const id of channel.members.keys()) ids.add(id);
  for (const id of ids) {
    const member = guild.members.cache.get(id) ?? (await guild.members.fetch(id).catch(() => null));
    await applyMember(member).catch((e) => console.error(`[matchbox] mute ${id}:`, e.message));
  }

  if (game && channel && !announced.has(game.session)) {
    announced.add(game.session);
    await announceStart(channel).catch(() => {});
  }
}

/** Voice channels have a text chat; tell people in it who still needs to link. */
async function announceStart(channel) {
  const unlinked = [...channel.members.values()].filter((m) => !m.user.bot && !game.linkedPlayers.has(m.id));
  const lines = [`🎮 **Matchbox game \`${game.session}\` started.** I'm muting this channel during rounds; alive players can talk in meetings.`];
  if (unlinked.length) {
    lines.push(
      `${unlinked.map((m) => `${m}`).join(' ')}: you're not linked to a player in this game, so you stay muted until it ends.`,
      `Playing? Type \`/matchbox link\` in Minecraft, then \`${PREFIX} mc link CODE\` here.`,
    );
  }
  if (game.unlinkedCount) lines.push(`⚠️ ${game.unlinkedCount} player(s) in the game have no linked Discord account.`);
  if (channel.type === ChannelType.GuildVoice) await channel.send({ content: lines.join('\n'), allowedMentions: { users: unlinked.map((m) => m.id) } });
}

export const refresh = () => serial(async () => {
  await loadState();
  await reconcile();
});

/** voiceStateUpdate: joining/leaving the Matchbox channel changes what a member should be. */
export function onVoiceState(oldState, newState) {
  if (newState.guild.id !== MAIN_GUILD_ID) return;
  if (oldState.channelId === newState.channelId) return;
  const channelId = gameChannelId();
  // The bot itself got moved/disconnected: go back to the Matchbox channel.
  if (newState.id === client.user.id) {
    if (channelId && newState.channelId !== channelId) setTimeout(() => setBotVoice(newState.guild, channelId), 3000);
    return;
  }
  const touchesChannel = oldState.channelId === channelId || newState.channelId === channelId;
  if (!touchesChannel && !mutedByUs.has(newState.id)) return;
  serial(() => applyMember(newState.member));
}

/** Forget all games and unmute everyone the bot muted (admin escape hatch). */
export const releaseAll = () => serial(async () => {
  await sql`delete from frostbot.mc_games`;
  game = null;
  await reconcile();
});

export async function initMatchbox(c) {
  client = c;
  mutedByUs = new Set((await sql`select discord_id from frostbot.mc_muted`).map((r) => r.discord_id));
  const guild = mainGuild();
  const channelId = gameChannelId();
  if (guild && channelId) setBotVoice(guild, channelId);
  await sql.listen('mc_games', () => refresh(), () => refresh()); // also runs once on (re)connect
  setInterval(refresh, 30_000).unref(); // missed notifications + noticing a crashed server's stale game
  console.log(`[matchbox] gamemaster ready${channelId ? ` in <#${channelId}>` : ' (no channel yet: frst mc here)'}`);
}

// ---------- links + server commands (used by commands/matchbox.js) ----------

export async function redeemLinkCode(code, discordId) {
  const [row] = await sql`
    delete from frostbot.mc_link_codes where code = ${code.toUpperCase()} and expires_at > now()
    returning mc_uuid, mc_name`;
  if (!row) return null;
  await sql`delete from frostbot.mc_links where discord_id = ${discordId} or mc_uuid = ${row.mc_uuid}`;
  await sql`insert into frostbot.mc_links (mc_uuid, mc_name, discord_id) values (${row.mc_uuid}, ${row.mc_name}, ${discordId})`;
  refresh();
  return row.mc_name;
}

export async function unlink(discordId) {
  const rows = await sql`delete from frostbot.mc_links where discord_id = ${discordId} returning mc_name`;
  refresh();
  return rows[0]?.mc_name ?? null;
}

export const listLinks = () => sql`select mc_name, discord_id from frostbot.mc_links order by lower(mc_name)`;

/**
 * Queue a console command for the plugin and wait (up to `timeoutMs`) for its output.
 * Returns { ok, result }, or null when the Minecraft server didn't answer in time.
 */
export async function runServerCommand(command, requestedBy, timeoutMs = 10_000) {
  const [{ id }] = await sql`
    insert into frostbot.mc_commands (command, requested_by) values (${command}, ${requestedBy}) returning id`;
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 500));
    const [row] = await sql`select done_at, ok, result from frostbot.mc_commands where id = ${id}`;
    if (row?.done_at) return { ok: row.ok, result: row.result ?? '' };
  }
  return null;
}
