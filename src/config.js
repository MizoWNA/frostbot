import './env.js';
export const PREFIX = (process.env.PREFIX ?? 'frst').toLowerCase();
export const TOKEN = process.env.DISCORD_TOKEN;
/** The server being protected. */
export const MAIN_GUILD_ID = process.env.MAIN_GUILD_ID;
/** The sister server that holds the 1:1 message mirror (text + media). */
export const MIRROR_GUILD_ID = process.env.MIRROR_GUILD_ID;

/**
 * Per-guild settings (stored in SQLite). These are the defaults;
 * change them in Discord with `frst set <key> <value>`.
 */
export const DEFAULTS = {
  modlog: null,               // channel id for mod/anti-nuke logs
  warnboard_channel: null,
  warnboard_message: null,
  warn_flag: '3',             // members with MORE than this many warnings get flagged
  newacct: 'on',              // kick brand-new accounts
  min_age_days: '2',          // accounts younger than this get kicked
  antinuke: 'on',
  antinuke_window: '15',      // seconds
  antinuke_limit: '3',        // destructive actions per window before we punish
  antinuke_punish: 'strip',   // strip (remove all roles) | kick | ban
  mirror: 'on',               // copy messages (incl. media) into the mirror server
  mirror_map_days: '30',
  mirror_mod_role: null,      // main-server role that counts as "mod"; channels only roles ABOVE it can see are hidden in the mirror      // keep main↔mirror message id links this long (for edit/delete sync)
  rolepersist: 'off',         // give saved roles back when someone rejoins
};

export const SETTING_HELP = {
  modlog: 'log channel (#channel / off)',
  warn_flag: 'flag members with more than N warnings',
  newacct: 'kick new accounts (on/off)',
  min_age_days: 'minimum account age in days',
  antinuke: 'anti-nuke detection (on/off)',
  antinuke_window: 'detection window in seconds',
  antinuke_limit: 'destructive actions allowed per window',
  antinuke_punish: 'strip / kick / ban',
  mirror: 'mirror messages to the sister server (on/off)',
  mirror_map_days: 'days to keep message id links for edit/delete sync',
  mirror_mod_role: 'main role that counts as mod (@role); staff-only channels above it are hidden in the mirror',
  rolepersist: 'give saved roles back when members rejoin (on/off)',
};
