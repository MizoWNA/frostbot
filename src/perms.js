// Staff levels by role position: "mod" = the Moderators role or anything above it,
// "admin" = the Admins role or anything above it. Administrator permission and the owner
// always count. Override the roles with `frst set mirror_mod_role @role` / `admin_role @role`.

import { PermissionsBitField } from 'discord.js';
import { getSetting } from './settings.js';
import { modRoleOf } from './features/mirror.js';

export function adminRoleOf(guild) {
  const id = getSetting(guild.id, 'admin_role');
  return (id && guild.roles.cache.get(id)) || guild.roles.cache.find((r) => /^admins?$/i.test(r.name)) || null;
}

function atLeast(member, role, fallbackPerm) {
  if (member.id === member.guild.ownerId) return true;
  if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
  return role ? member.roles.highest.position >= role.position : member.permissions.has(fallbackPerm);
}

export const isMod = (member) => atLeast(member, modRoleOf(member.guild), PermissionsBitField.Flags.ModerateMembers);
export const isAdmin = (member) => atLeast(member, adminRoleOf(member.guild), PermissionsBitField.Flags.ManageGuild);
