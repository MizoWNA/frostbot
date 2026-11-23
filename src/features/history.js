// Full-history backfill: copy every message from the start of each main channel into the
// mirror, oldest first. Resumable (progress in frostbot.history_state), memory-light
// (100 messages at a time, not cached), several channels in parallel.
//
// Each channel's backfill runs inside that channel's mirror queue, so live messages wait
// behind it and the mirror stays chronological. Messages already mirrored live (out of
// order) are re-posted in their right place.
//
// Old bot posts (pokedex etc.) are skipped. Channels in the `history_skip` setting aren't
// back-filled at all: they're only mirrored from the moment they were skipped on.
// The biggest channel (or `history_first`) goes first, and a live panel shows progress.

import { SnowflakeUtil, EmbedBuilder } from 'discord.js';
import { sql } from '../db.js';
import { MAIN_GUILD_ID } from '../config.js';
import { setSetting, getSetting } from '../settings.js';
import { COLORS } from '../util.js';
import { MESSAGE_TYPES, enqueue, shouldMirror, linksFor, mirrorInOrder, mirrorEnabled, hookStats, packEntry, sendPack, PACK_MAX, PACK_CHARS } from './mirror.js';
import { registerSticky, updateSticky } from './sticky.js';

const CONCURRENCY = Number(process.env.HISTORY_CONCURRENCY ?? 4);
const PANEL_EVERY_MS = 60_000;
const TOTALS_EVERY_MS = 30 * 60_000;

let running = false;
let stopRequested = false;
const live = new Map(); // channelId → { name, count, seen, cursor, failed, createdAt, samples: [[t, seen]] }

const listSetting = (key) => (getSetting(MAIN_GUILD_ID, key) ?? '').split(',').filter(Boolean);
export const skipList = () => listSetting('history_skip');
/** Channels whose old text messages are packed 10 per post (see mirror.js packEntry). */
export const packList = () => listSetting('history_pack');

/** A Discord 4xx (not rate limit / not missing access) means this message itself can't be sent. */
const isPermanent = (e) => typeof e?.status === 'number' && e.status >= 400 && e.status < 500 && e.status !== 429;

async function withRetry(fn, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (isPermanent(e) || i >= tries || stopRequested) throw e;
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
}

const saveState = (chId, cursor, count, seen, done) => sql`
  insert into frostbot.history_state (main_channel_id, cursor, count, seen, done, updated_at)
  values (${chId}, ${cursor}, ${count}, ${seen}, ${done}, now())
  on conflict (main_channel_id) do update set cursor = excluded.cursor, count = excluded.count, seen = excluded.seen,
    done = excluded.done, updated_at = now()`;

const loadRows = async () => new Map((await sql`select * from frostbot.history_state`).map((r) => [r.main_channel_id, r]));

/** Record each running channel's live progress (called every panel refresh, ~1/min). */
function sampleRates() {
  const now = Date.now();
  for (const p of live.values()) {
    p.samples.push([now, p.seen]);
    while (p.samples.length > 2 && now - p.samples[0][0] > 10 * 60_000) p.samples.shift();
  }
}

/** Messages looked at per minute over the last ~10 minutes; null until there's enough to tell. */
function rateOf(p) {
  const s = p.samples;
  if (s.length < 2) return null;
  const [t0, n0] = s[0];
  const [t1, n1] = s.at(-1);
  return t1 - t0 >= 30_000 ? ((n1 - n0) / (t1 - t0)) * 60_000 : null;
}

async function backfillChannel(ch, row) {
  let cursor = row?.cursor ?? '0';
  let count = row?.count ?? 0;
  let seen = row?.seen ?? 0;
  let failed = 0;
  const p = { name: ch.name, count, seen, cursor, failed, createdAt: ch.createdTimestamp, samples: [[Date.now(), seen]] };
  live.set(ch.id, p);

  const packing = packList().includes(ch.id);
  let pack = [];
  let packChars = 0;
  const flush = async () => {
    if (!pack.length) return;
    const embeds = pack;
    pack = [];
    packChars = 0;
    try {
      await withRetry(() => sendPack(ch, embeds));
      count += embeds.length;
    } catch (e) {
      if (!isPermanent(e)) throw e;
      // One card Discord didn't like: send them one by one so only that one is lost.
      for (const em of embeds) {
        try {
          await withRetry(() => sendPack(ch, [em]));
          count++;
        } catch (e2) {
          if (!isPermanent(e2)) throw e2;
          failed++;
          console.error(`[history] #${ch.name} skipped a packed message:`, e2.message);
        }
      }
    }
  };

  try {
    for (;;) {
      if (stopRequested) return;
      const batch = await ch.messages.fetch({ after: cursor, limit: 100, cache: false });
      if (!batch.size) {
        await saveState(ch.id, cursor, count, seen, true);
        console.log(`[history] #${ch.name} done (${count} copied, ${seen} looked at)`);
        return;
      }
      const sorted = [...batch.values()].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      const links = await linksFor(sorted.map((m) => m.id));
      for (const m of sorted) {
        if (stopRequested) return; // shutting down: don't advance past unsent messages
        seen++;
        const link = links.get(m.id);
        // Old bot/webhook posts (pokedex, games…) aren't worth the time. Ones already mirrored
        // live are still moved into place so they don't sit out of order.
        const wanted = shouldMirror(m) && (!m.author?.bot || link);
        if (wanted && packing && !link && !m.attachments.size) {
          const entry = packEntry(m);
          if (entry) {
            if (pack.length >= PACK_MAX || packChars + entry.size > PACK_CHARS) await flush();
            pack.push(entry.embed);
            packChars += entry.size;
          }
          cursor = m.id;
          continue;
        }
        if (wanted) await flush(); // keep order: earlier packed messages go out first
        if (wanted) {
          try {
            if (await withRetry(() => mirrorInOrder(m, link))) count++;
          } catch (e) {
            // Discord rejected THIS message (bad content etc.): skip it. Anything else
            // (connection drop, DB down): stop the channel; it resumes from the last saved batch.
            if (!isPermanent(e)) throw e;
            failed++;
            console.error(`[history] #${ch.name} skipped message ${m.id}:`, e.message);
          }
        }
        cursor = m.id;
        Object.assign(p, { count, seen, cursor, failed }); // live progress for the panel
      }
      await flush(); // never save a cursor past messages still waiting in a pack
      Object.assign(p, { count, seen, cursor, failed });
      await saveState(ch.id, cursor, count, seen, false);
    }
  } finally {
    live.delete(ch.id);
  }
}

// ---------- channel sizes (Discord search) ----------

let serverTotal = null;
let totalsBusy = false;

async function searchTotal(guild, channelId) {
  const query = new URLSearchParams({ limit: '1' });
  if (channelId) query.set('channel_id', channelId);
  const r = await guild.client.rest.get(`/guilds/${guild.id}/messages/search`, { query }).catch(() => null);
  return typeof r?.total_results === 'number' ? r.total_results : null; // null: index not ready yet
}

/** Ask Discord how many messages each channel has (one search per channel, spaced out). */
export async function refreshTotals(guild) {
  if (totalsBusy) return;
  totalsBusy = true;
  try {
    serverTotal = (await searchTotal(guild)) ?? serverTotal;
    for (const ch of guild.channels.cache.values()) {
      if (!MESSAGE_TYPES.has(ch.type)) continue;
      const total = await searchTotal(guild, ch.id);
      if (total != null) {
        await sql`insert into frostbot.history_state (main_channel_id, total) values (${ch.id}, ${total})
                  on conflict (main_channel_id) do update set total = excluded.total`;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  } finally {
    totalsBusy = false;
  }
}

const span = (c) => (c.lastMessageId ? Number(BigInt(c.lastMessageId) >> 22n) - Number(BigInt(c.id) >> 22n) : 0);

/** The channel the panel focuses on: `history_first`, else the biggest one. */
function focusId(guild, rows) {
  const set = getSetting(MAIN_GUILD_ID, 'history_first');
  if (set && guild.channels.cache.has(set)) return set;
  let best = null;
  for (const r of rows.values()) if (r.total != null && (!best || r.total > best.total) && guild.channels.cache.has(r.main_channel_id)) best = r;
  return best?.main_channel_id ?? null;
}

/** Start (or resume) the full-history backfill in the background. */
export async function startHistory(mainGuild) {
  if (running) return false;
  if (!mirrorEnabled()) throw new Error('Mirroring is off or the mirror server is unavailable.');
  running = true;
  stopRequested = false;
  await setSetting(MAIN_GUILD_ID, 'history_backfill', 'running');

  (async () => {
    let panelTimer;
    let totalsTimer;
    try {
      let rows = await loadRows();
      if (![...rows.values()].some((r) => r.total != null)) {
        console.log('[history] counting messages per channel first (~2 min)…');
        await refreshTotals(mainGuild);
        rows = await loadRows();
      }

      // Skipped channels: no back-fill, mirrored live from now on only.
      const now = SnowflakeUtil.generate().toString();
      for (const id of skipList()) {
        if (rows.get(id)?.done) continue;
        await saveState(id, now, 0, 0, true);
        console.log(`[history] #${mainGuild.channels.cache.get(id)?.name ?? id} skipped (live mirror only)`);
      }
      rows = await loadRows();

      const first = focusId(mainGuild, rows);
      const total = (c) => rows.get(c.id)?.total ?? -1;
      const todo = [...mainGuild.channels.cache.values()]
        .filter((c) => MESSAGE_TYPES.has(c.type) && !rows.get(c.id)?.done)
        // the focus channel (general) first, then the biggest: they decide when it's all done
        .sort((a, b) => (b.id === first) - (a.id === first) || total(b) - total(a) || span(b) - span(a));
      console.log(`[history] starting: ${todo.length} channel(s) to go, ${CONCURRENCY} at a time, #${todo[0]?.name ?? '-'} first`);

      panelTimer = setInterval(() => refreshHistoryPanel(mainGuild), PANEL_EVERY_MS);
      totalsTimer = setInterval(() => refreshTotals(mainGuild).catch(() => {}), TOTALS_EVERY_MS);
      refreshHistoryPanel(mainGuild);

      let last = { ...hookStats, t: Date.now() };
      const meter = setInterval(() => {
        const d = (k) => hookStats[k] - last[k];
        const n = Math.max(1, d('sent'));
        const rl = d('rateLimits');
        console.log(
          `[history] speed: ${Math.round(d('sent') / ((Date.now() - last.t) / 60000))} msg/min | per message: build ${Math.round(d('buildMs') / n)}ms, send ${Math.round(d('sendMs') / n)}ms, db ${Math.round(d('dbMs') / n)}ms, re-place ${Math.round(d('delMs') / n)}ms | ${rl} rate-limit wait(s)${rl ? ` avg ${Math.round(d('rateLimitedMs') / rl)}ms` : ''}`,
        );
        last = { ...hookStats, t: Date.now() };
      }, 300_000);

      // Discord's webhook limit (~30 posts/min) is per channel, so parallel channels don't slow
      // general down: general takes the first slot, the others share the rest.
      let next = 0;
      const worker = async () => {
        while (!stopRequested && next < todo.length) {
          const ch = todo[next++];
          await enqueue(ch.id, () => backfillChannel(ch, rows.get(ch.id)));
        }
      };
      try {
        await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      } finally {
        clearInterval(meter);
      }
      if (!stopRequested) {
        const left = (await sql`select count(*)::int n from frostbot.history_state where not done`)[0].n;
        if (!left) {
          await setSetting(MAIN_GUILD_ID, 'history_backfill', 'done');
          console.log('[history] all channels done');
        }
      }
    } catch (e) {
      console.error('[history] stopped by error:', e);
    } finally {
      clearInterval(panelTimer);
      clearInterval(totalsTimer);
      running = false;
      refreshHistoryPanel(mainGuild);
      if (!stopRequested && getSetting(MAIN_GUILD_ID, 'history_backfill') === 'running') {
        // Some channel stopped on a temporary error: try the remaining ones again in a minute.
        setTimeout(() => !running && startHistory(mainGuild).catch(() => {}), 60_000).unref();
      }
    }
  })();
  return true;
}

/** Bot shutting down: stop sending without touching the saved state (it resumes on next start). */
export function haltHistoryForShutdown() {
  stopRequested = true;
}

/** Ask the backfill to stop after the current batch (it can be resumed later). */
export async function stopHistory() {
  stopRequested = true;
  await setSetting(MAIN_GUILD_ID, 'history_backfill', 'stopped');
}

/** Resume on startup if it was running when the bot went down. */
export function resumeHistoryIfNeeded(mainGuild) {
  if (getSetting(MAIN_GUILD_ID, 'history_backfill') === 'running') {
    startHistory(mainGuild).catch((e) => console.error('[history] resume failed:', e.message));
  } else {
    refreshHistoryPanel(mainGuild);
  }
}

/** Pack a channel's old text messages 10 per post (much faster) or go back to 1:1. */
export async function setPacked(channelId, on) {
  const list = new Set(packList());
  if (on) list.add(channelId);
  else list.delete(channelId);
  await setSetting(MAIN_GUILD_ID, 'history_pack', [...list].join(',') || null);
}

/** Skip a channel's history (mirror it live only) or undo that. */
export async function setSkipped(channelId, skip) {
  const list = new Set(skipList());
  if (skip) list.add(channelId);
  else {
    list.delete(channelId);
    await sql`delete from frostbot.history_state where main_channel_id = ${channelId}`; // copy it from the start next run
  }
  await setSetting(MAIN_GUILD_ID, 'history_skip', [...list].join(',') || null);
  if (skip) {
    const row = (await loadRows()).get(channelId);
    if (!row?.done) await saveState(channelId, SnowflakeUtil.generate().toString(), 0, 0, true);
  }
}

export async function historyStatus(mainGuild) {
  const rows = await loadRows();
  const chans = [...mainGuild.channels.cache.values()].filter((c) => MESSAGE_TYPES.has(c.type));
  const skip = new Set(skipList());
  const seenOf = (id) => live.get(id)?.seen ?? rows.get(id)?.seen ?? 0;
  const counted = chans.filter((c) => !skip.has(c.id));
  const active = [...live.entries()].map(([id, p]) => {
    const tot = rows.get(id)?.total;
    const at = p.cursor === '0' ? p.createdAt : Number(SnowflakeUtil.timestampFrom(p.cursor));
    return { id, name: p.name, count: p.count, seen: p.seen, total: tot, failed: p.failed, rate: rateOf(p), at, pct: tot ? Math.min(100, (p.seen / tot) * 100) : null };
  });
  return {
    state: getSetting(MAIN_GUILD_ID, 'history_backfill') ?? 'never started',
    running,
    channelsDone: counted.filter((c) => rows.get(c.id)?.done).length,
    channelsTotal: counted.length,
    skipped: [...skip],
    messages: chans.reduce((s, c) => s + (live.get(c.id)?.count ?? rows.get(c.id)?.count ?? 0), 0),
    seen: counted.reduce((s, c) => s + seenOf(c.id), 0),
    total: counted.reduce((s, c) => s + (rows.get(c.id)?.total ?? 0), 0),
    serverTotal,
    focus: focusId(mainGuild, rows),
    rows,
    active,
    seenOf,
  };
}

// ---------- live panel (sticky message in the main server) ----------

const bar = (pct, n = 14) => {
  const full = Math.round((pct / 100) * n);
  return '▰'.repeat(full) + '▱'.repeat(n - full);
};
const ts = (ms, f = 'R') => `<t:${Math.floor(ms / 1000)}:${f}>`;
const num = (n) => Number(n ?? 0).toLocaleString('en-US');
const eta = (left, perMin) => (perMin == null ? 'measuring…' : perMin > 0.5 ? ts(Date.now() + (left / perMin) * 60_000) : '—');
const rate = (perMin) => (perMin == null ? 'measuring…' : `${Math.round(perMin)}/min`);

async function renderPanel(guild) {
  sampleRates();
  const h = await historyStatus(guild);
  const fid = h.focus;
  const lines = [];
  const state = h.running ? '🟢 running' : h.state === 'done' ? '✅ finished' : h.state === 'stopped' ? '⏸️ paused' : `⚪ ${h.state}`;
  lines.push(`**State:** ${state}${h.running ? ` · ${CONCURRENCY} channels at a time` : ''}`);

  if (fid) {
    const row = h.rows.get(fid);
    const a = h.active.find((x) => x.id === fid);
    const seen = h.seenOf(fid);
    const tot = row?.total ?? 0;
    const pct = tot ? Math.min(100, (seen / tot) * 100) : 0;
    lines.push('', `### <#${fid}>`);
    if (row?.done) lines.push('✅ Fully rebuilt');
    else {
      lines.push(`\`${bar(pct)}\` **${pct.toFixed(1)}%**`);
      lines.push(`${num(seen)} / ${num(tot)} messages${a ? ` · up to ${ts(a.at, 'D')}` : ''}`);
      lines.push(a ? `**${rate(a.rate)}** · done ${eta(tot - seen, a.rate)}` : h.running ? 'waiting for a free slot…' : 'not running');
    }
  }

  const others = h.active.filter((x) => x.id !== fid);
  const sum = (xs) => (xs.some((x) => x.rate == null) ? null : xs.reduce((s, x) => s + x.rate, 0));
  const rateAll = sum(h.active);
  const rateOthers = sum(others);
  const pctAll = h.total ? (h.seen / h.total) * 100 : 0;
  const skip = new Set(h.skipped);
  const leftOthers = [...h.rows.values()]
    .filter((r) => r.main_channel_id !== fid && !r.done && !skip.has(r.main_channel_id))
    .reduce((s, r) => s + Math.max(0, (r.total ?? 0) - h.seenOf(r.main_channel_id)), 0);

  lines.push('', '### Whole server');
  lines.push(`\`${bar(pctAll)}\` **${pctAll.toFixed(1)}%** · ${h.channelsDone}/${h.channelsTotal} channels done`);
  lines.push(`${num(h.seen)} / ${num(h.total)} looked at · **${num(h.messages)}** copied · ${num(Math.max(0, h.seen - h.messages))} bot posts skipped`);
  lines.push(`**Speed:** ${rate(rateAll)}${h.serverTotal ? ` · server has ${num(h.serverTotal)} messages and counting` : ''}`);
  if (others.length) {
    lines.push(`**Other channels:** done ${eta(leftOthers, rateOthers)}`);
    for (const x of others.slice(0, 6)) lines.push(`-# ⏳ <#${x.id}> ${x.pct != null ? `${x.pct.toFixed(0)}%` : ''} · ${rate(x.rate)}${x.failed ? ` · ⚠️ ${x.failed} failed` : ''}`);
  }
  if (h.skipped.length) lines.push(`-# Live-only (no history): ${h.skipped.map((id) => `<#${id}>`).join(' ')}`);

  return {
    embeds: [
      new EmbedBuilder()
        .setColor(h.running ? COLORS.frost : h.state === 'done' ? COLORS.ok : COLORS.warn)
        .setTitle('📜 Mirror rebuild')
        .setDescription(lines.join('\n').slice(0, 4000))
        .setFooter({ text: 'Updates every minute · channel sizes refresh every 30 min' })
        .setTimestamp(),
    ],
  };
}

registerSticky('history', { chanKey: 'history_panel_channel', msgKey: 'history_panel_message', render: renderPanel });

export function refreshHistoryPanel(guild) {
  if (!getSetting(MAIN_GUILD_ID, 'history_panel_channel')) return;
  updateSticky(guild, 'history').catch((e) => console.error('[history] panel:', e.message));
}
