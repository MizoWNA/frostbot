// Rebuild the main server from a snapshot, then repopulate recreated channels from the
// mirror server via webhooks (author name + avatar preserved).

import { ChannelType, GuildFeature } from 'discord.js';
import { savedRoles } from './memberRoles.js';
import { getMirrorRow, getMirrorGuild, mirrorHistory, remapMainChannel, addRestoreHook, downloadAttachments, uploadLimit, safeName, withMediaSlot, toMainMentions, embedToMain, TRASH } from './mirror.js';

export const PARTS = ['settings', 'roles', 'channels', 'members', 'messages'];

let running = false;
export const restoreRunning = () => running;

/**
 * @param guild   the main guild
 * @param snap    snapshot data (from snapshot.js)
 * @param parts   Set of PARTS to run
 * @param log     async (line) => void  progress reporter
 */
export async function restore(guild, snap, parts, log) {
  if (running) throw new Error('A restore is already running.');
  running = true;
  const stats = { rolesMade: 0, rolesSynced: 0, chansMade: 0, chansSynced: 0, membersFixed: 0, messages: 0, errors: [] };
  const err = (what, e) => {
    stats.errors.push(`${what}: ${e.message ?? e}`);
    console.error('[restore]', what, e.message ?? e);
  };
  try {
    await guild.roles.fetch();
    await guild.channels.fetch();
    const me = guild.members.me;
    const roleMap = new Map([[snap.guild.id, guild.id]]);
    const chanMap = new Map();

    // ---------- roles ----------
    // Always build the map; only create/edit if 'roles' was requested.
    const snapRoles = [...snap.roles].sort((a, b) => b.position - a.position);
    if (parts.has('roles')) await log('Restoring roles…');
    for (const r of snapRoles) {
      if (r.isEveryone) {
        if (parts.has('roles')) {
          await guild.roles.everyone
            .setPermissions(BigInt(r.permissions), 'Restore')
            .then(() => stats.rolesSynced++)
            .catch((e) => err('@everyone perms', e));
        }
        continue;
      }
      let role = guild.roles.cache.get(r.id);
      if (!role && r.managed) role = guild.roles.cache.find((x) => x.managed && x.name === r.name); // bot roles come back with the bot
      if (role) {
        roleMap.set(r.id, role.id);
        if (parts.has('roles') && role.editable && role.permissions.bitfield.toString() !== r.permissions) {
          await role.setPermissions(BigInt(r.permissions), 'Restore: reset perms').then(() => stats.rolesSynced++).catch((e) => err(`role ${r.name}`, e));
        }
        continue;
      }
      if (r.managed || !parts.has('roles')) continue;
      try {
        const created = await guild.roles.create({
          name: r.name,
          colors: { primaryColor: r.colors?.primary ?? 0 },
          hoist: r.hoist,
          mentionable: r.mentionable,
          permissions: BigInt(r.permissions),
          reason: 'Restore',
        });
        roleMap.set(r.id, created.id);
        stats.rolesMade++;
        if (r.colors?.secondary) {
          await created.setColors({ primaryColor: r.colors.primary, secondaryColor: r.colors.secondary, tertiaryColor: r.colors.tertiary ?? undefined }).catch(() => {});
        }
        if (r.unicodeEmoji) await created.setUnicodeEmoji(r.unicodeEmoji).catch(() => {});
        else if (r.iconURL) await created.setIcon(r.iconURL).catch(() => {});
      } catch (e) {
        err(`create role ${r.name}`, e);
      }
    }
    if (parts.has('roles')) {
      // Re-order: snapshot order, only roles the bot is allowed to move.
      const order = [...snap.roles]
        .filter((r) => !r.isEveryone)
        .sort((a, b) => a.position - b.position)
        .map((r) => guild.roles.cache.get(roleMap.get(r.id)))
        .filter((role) => role && role.position < me.roles.highest.position);
      if (order.length) {
        await guild.roles
          .setPositions(order.map((role, i) => ({ role, position: i + 1 })))
          .catch((e) => err('role order', e));
      }
      await log(`Roles: ${stats.rolesMade} created, ${stats.rolesSynced} perms reset.`);
    }

    // ---------- channels ----------
    const mapOverwrites = (ows, includeMembers = true) =>
      ows
        .filter((o) => (o.type === 0 ? roleMap.has(o.id) : includeMembers))
        .map((o) => ({ id: o.type === 0 ? roleMap.get(o.id) : o.id, type: o.type, allow: BigInt(o.allow), deny: BigInt(o.deny) }));

    const community = guild.features.includes(GuildFeature.Community);
    const fallbackType = (t) => {
      if (community) return t;
      if (t === ChannelType.GuildAnnouncement || t === ChannelType.GuildForum || t === ChannelType.GuildMedia) return ChannelType.GuildText;
      if (t === ChannelType.GuildStageVoice) return ChannelType.GuildVoice;
      return t;
    };

    const ordered = [
      ...snap.channels.filter((c) => c.type === ChannelType.GuildCategory),
      ...snap.channels.filter((c) => c.type !== ChannelType.GuildCategory),
    ];
    if (parts.has('channels')) await log('Restoring channels…');
    for (const c of ordered) {
      const existing = guild.channels.cache.get(c.id);
      if (existing) {
        chanMap.set(c.id, c.id);
        if (parts.has('channels') && !c.permissionsLocked) {
          await existing.permissionOverwrites.set(mapOverwrites(c.overwrites), 'Restore: reset perms').then(() => stats.chansSynced++).catch((e) => err(`perms #${c.name}`, e));
        }
        continue;
      }
      if (!parts.has('channels')) continue;
      const parent = c.parentId ? chanMap.get(c.parentId) : undefined;
      const type = fallbackType(c.type);
      const base = { name: c.name, type, parent, reason: 'Restore' };
      const full = {
        ...base,
        topic: c.topic ?? undefined,
        nsfw: c.nsfw,
        rateLimitPerUser: c.rateLimitPerUser || undefined,
        bitrate: c.bitrate ? Math.min(c.bitrate, guild.maximumBitrate) : undefined,
        userLimit: c.userLimit ?? undefined,
        rtcRegion: c.rtcRegion ?? undefined,
        defaultAutoArchiveDuration: c.defaultAutoArchiveDuration ?? undefined,
        availableTags: type === ChannelType.GuildForum || type === ChannelType.GuildMedia ? c.availableTags ?? undefined : undefined,
        permissionOverwrites: mapOverwrites(c.overwrites),
      };
      let created = await guild.channels.create(full).catch(() => null);
      // Member overwrites for people who left can fail; retry with roles only, then bare.
      created ??= await guild.channels.create({ ...full, permissionOverwrites: mapOverwrites(c.overwrites, false) }).catch(() => null);
      created ??= await guild.channels.create(base).catch((e) => (err(`create #${c.name}`, e), null));
      if (created) {
        chanMap.set(c.id, created.id);
        stats.chansMade++;
        if (c.permissionsLocked && parent) await created.lockPermissions().catch(() => {});
      }
    }
    if (parts.has('channels')) {
      const positions = snap.channels
        .map((c) => ({ channel: chanMap.get(c.id), position: c.position, parent: c.parentId ? chanMap.get(c.parentId) ?? null : null }))
        .filter((p) => p.channel);
      await guild.channels.setPositions(positions).catch((e) => err('channel order', e));
      await log(`Channels: ${stats.chansMade} created, ${stats.chansSynced} perms reset.`);
    }

    // ---------- server settings ----------
    if (parts.has('settings')) {
      const g = snap.guild;
      const edit = {
        name: g.name,
        verificationLevel: g.verificationLevel,
        explicitContentFilter: g.explicitContentFilter,
        defaultMessageNotifications: g.defaultMessageNotifications,
        afkTimeout: g.afkTimeout,
        afkChannel: g.afkChannelId ? chanMap.get(g.afkChannelId) ?? null : null,
        systemChannel: g.systemChannelId ? chanMap.get(g.systemChannelId) ?? null : null,
        reason: 'Restore',
      };
      await guild.edit(edit).catch((e) => err('server settings', e));
      if (g.iconURL && guild.iconURL({ extension: 'png', size: 1024 }) !== g.iconURL) await guild.setIcon(g.iconURL).catch(() => {});
      await log('Server settings restored.');
    }

    // ---------- member roles ----------
    if (parts.has('members')) {
      await log('Giving members their roles back…');
      const members = await guild.members.fetch();
      const snapMembers = new Map(snap.members.map((m) => [m.id, m.roles]));
      for (const m of members.values()) {
        // Prefer the live record (newer), fall back to the snapshot.
        const saved = (await savedRoles(guild.id, m.id)) ?? snapMembers.get(m.id);
        if (!saved?.length) continue;
        const missing = saved
          .map((id) => guild.roles.cache.get(roleMap.get(id) ?? id))
          .filter((r) => r && !r.managed && r.position < me.roles.highest.position && !m.roles.cache.has(r.id));
        if (!missing.length) continue;
        await m.roles.add(missing, 'Restore').then(() => stats.membersFixed++).catch((e) => err(`roles for ${m.user.tag}`, e));
      }
      await log(`Members: ${stats.membersFixed} got roles back.`);
    }

    // ---------- messages (from the mirror) ----------
    if (parts.has('messages')) {
      const mg = getMirrorGuild();
      if (!mg) {
        err('messages', new Error('Mirror server not available'));
      } else {
        const remap = (text) =>
          text
            ?.replace(/<#(\d+)>/g, (s, id) => (chanMap.has(id) ? `<#${chanMap.get(id)}>` : s))
            .replace(/<@&(\d+)>/g, (s, id) => (roleMap.has(id) ? `<@&${roleMap.get(id)}>` : s));

        // Only repopulate channels that were recreated (old id ≠ new id), so nothing gets duplicated.
        const targets = snap.channels.filter((c) => chanMap.has(c.id) && chanMap.get(c.id) !== c.id && getMirrorRow(c.id));
        await log(`Repopulating ${targets.length} channel(s) from the mirror…`);
        for (const c of targets) {
          const newCh = guild.channels.cache.get(chanMap.get(c.id));
          const mirrorCh = mg.channels.cache.get(getMirrorRow(c.id).mirror_channel_id);
          if (!newCh?.isTextBased() || !mirrorCh) continue;
          // Point the mirror link at the new channel first, so live messages sent while we
          // replay keep going into the same mirror channel instead of a new one.
          await remapMainChannel(c.id, newCh.id);
          let hook;
          try {
            hook = await newCh.createWebhook({ name: 'Frost Restore', reason: 'Restore' });
            await addRestoreHook(hook.id);
            let n = 0;
            for await (const m of mirrorHistory(mirrorCh)) {
              if (m.reactions.cache.has(TRASH)) continue; // was deleted in main before the nuke
              const replay = async () => {
                const { files, skipped } = await downloadAttachments(m.attachments, uploadLimit(guild));
                // mirror ids → original main ids → (possibly recreated) new main ids
                let content = remap(toMainMentions(m.content)) ?? '';
                if (skipped.length) content += `\n-# [attachment lost: ${skipped.map((a) => a.name).join(', ')}]`;
                const embeds = m.embeds.filter((e) => e.data.type === 'rich').map((e) => JSON.parse(remap(JSON.stringify(embedToMain(e.toJSON())))));
                if (!content.trim() && !files.length && !embeds.length) return;
                await hook
                  .send({
                    content: content.slice(0, 2000) || undefined,
                    username: safeName(m.author.username),
                    avatarURL: m.author.displayAvatarURL({ extension: 'png', size: 256 }),
                    files,
                    embeds,
                    allowedMentions: { parse: [] },
                  })
                  .then(() => n++)
                  .catch((e) => err(`message in #${c.name}`, e));
              };
              await (m.attachments.size ? withMediaSlot(replay) : replay());
            }
            stats.messages += n;
            await log(`#${newCh.name}: ${n} messages restored.`);
          } catch (e) {
            err(`repopulate #${c.name}`, e);
          } finally {
            await hook?.delete('Restore finished').catch(() => {});
          }
        }
      }
    }
    // Channels that came back with new ids but had nothing to replay still need their mirror link moved.
    for (const [oldId, newId] of chanMap) if (oldId !== newId && getMirrorRow(oldId)) await remapMainChannel(oldId, newId);
    return stats;
  } finally {
    running = false;
  }
}
