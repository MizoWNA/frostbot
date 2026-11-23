// Sticky panels: a bot message that stays the LAST message in its channel. When people chat
// under it, it's deleted and re-sent at the bottom once the chat pauses (or at most every
// minute in a busy channel). Not pinned: re-pinning would add a "pinned a message" notice
// every time. Used by the warning board and the history-rebuild panel.

import { getSetting, setSetting } from '../settings.js';

const QUIET_MS = 15_000; // re-stick after 15s without new messages…
const MAX_WAIT_MS = 60_000; // …or after a minute at most, even if the chat never stops

const panels = new Map(); // key → { chanKey, msgKey, render(guild) → payload }
const chains = new Map(); // key → promise (one update/repost at a time per panel)
const timers = new Map(); // key → { quiet, max }

/** key: unique name; chanKey/msgKey: setting names holding the channel id and message id. */
export function registerSticky(key, { chanKey, msgKey, render }) {
  panels.set(key, { chanKey, msgKey, render });
}

const serial = (key, fn) => {
  const p = (chains.get(key) ?? Promise.resolve()).then(fn, fn);
  chains.set(key, p.catch(() => {}));
  return p;
};

function target(guild, key) {
  const panel = panels.get(key);
  const ch = guild.channels.cache.get(getSetting(guild.id, panel.chanKey));
  return { panel, ch: ch?.isTextBased() ? ch : null, msgId: getSetting(guild.id, panel.msgKey) };
}

async function post(guild, panel, ch, payload) {
  const sent = await ch.send(payload);
  await setSetting(guild.id, panel.msgKey, sent.id);
  return sent;
}

/** Refresh the panel's content in place (posts it if it's missing). */
export function updateSticky(guild, key) {
  return serial(key, async () => {
    const { panel, ch, msgId } = target(guild, key);
    if (!ch) return null;
    const payload = { ...(await panel.render(guild)), allowedMentions: { parse: [] } };
    const existing = msgId ? await ch.messages.fetch(msgId).catch(() => null) : null;
    if (existing) return existing.edit(payload);
    return post(guild, panel, ch, payload);
  });
}

/** Move the panel back to the bottom: delete + re-send (skipped if it's already last). */
function bump(guild, key) {
  return serial(key, async () => {
    const { panel, ch, msgId } = target(guild, key);
    if (!ch || (msgId && ch.lastMessageId === msgId)) return;
    const payload = { ...(await panel.render(guild)), allowedMentions: { parse: [] } };
    if (msgId) await ch.messages.delete(msgId).catch(() => {});
    await post(guild, panel, ch, payload);
  });
}

/** Call for every new message: schedules a re-stick for panels in that channel. */
export function onStickyChannelMessage(msg) {
  // Bot replies count too (only the panel itself is ignored, by the "already last" check in bump).
  if (!msg.guild) return;
  for (const [key, panel] of panels) {
    if (getSetting(msg.guild.id, panel.chanKey) !== msg.channelId) continue;
    const t = timers.get(key) ?? {};
    const fire = () => {
      clearTimeout(t.quiet);
      clearTimeout(t.max);
      timers.delete(key);
      bump(msg.guild, key).catch((e) => console.error(`[sticky] ${key}:`, e.message));
    };
    clearTimeout(t.quiet);
    t.quiet = setTimeout(fire, QUIET_MS);
    t.max ??= setTimeout(fire, MAX_WAIT_MS);
    timers.set(key, t);
  }
}
