-- Frostbot schema. Lives in its own schema (not `public`) so Supabase's auto REST API
-- never exposes it. Message CONTENT is never stored here, only id mappings.

create schema if not exists frostbot;
revoke all on schema frostbot from anon, authenticated;

create table if not exists frostbot.settings (
  guild_id text not null,
  key      text not null,
  value    text,
  primary key (guild_id, key)
);

create table if not exists frostbot.warnings (
  id         bigserial primary key,
  guild_id   text not null,
  user_id    text not null,
  user_tag   text,
  mod_id     text not null,
  reason     text,
  created_at timestamptz not null default now(),
  active     boolean not null default true
);
create index if not exists warnings_user_idx on frostbot.warnings (guild_id, user_id) where active;
-- links to the bot's own messages holding the proof pictures (space-separated); files live on Discord
alter table frostbot.warnings add column if not exists proof text;

-- main channel <-> mirror channel, plus the webhook that posts into the mirror channel
create table if not exists frostbot.mirror_channels (
  main_channel_id   text primary key,
  mirror_channel_id text not null,
  webhook_id        text,
  webhook_token     text
);

-- main message id <-> mirror message id. Temporary: only kept so edits/deletes can be
-- synced to the mirror; rows older than `mirror_map_days` are pruned.
create table if not exists frostbot.mirror_messages (
  main_id         text primary key,
  mirror_id       text not null,
  main_channel_id text not null,
  created_at      timestamptz not null default now()
);
create index if not exists mirror_messages_age_idx on frostbot.mirror_messages (created_at);

-- live record of each member's roles (restore + role persistence + dumps include people who left)
create table if not exists frostbot.member_roles (
  guild_id   text not null,
  user_id    text not null,
  user_tag   text,
  roles      jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (guild_id, user_id)
);

create table if not exists frostbot.age_bypass (
  guild_id text not null,
  user_id  text not null,
  primary key (guild_id, user_id)
);

create table if not exists frostbot.trusted (
  guild_id text not null,
  user_id  text not null,
  primary key (guild_id, user_id)
);

-- webhooks the bot made in the MAIN server while replaying a restore (never re-mirror those)
create table if not exists frostbot.restore_webhooks (
  webhook_id text primary key
);

-- only the most recently generated structure dump, one row per guild
create table if not exists frostbot.latest_dump (
  guild_id  text primary key,
  taken_at  timestamptz not null,
  source    text,
  data      jsonb not null
);

-- main role <-> mirror role (mirror roles are cosmetic copies: same name/color/order, no permissions)
create table if not exists frostbot.mirror_roles (
  main_role_id   text primary key,
  mirror_role_id text not null
);

-- full-history backfill progress per main channel (resumable)
create table if not exists frostbot.history_state (
  main_channel_id text primary key,
  cursor          text not null default '0',   -- last main message id copied, in order
  count           integer not null default 0,
  done            boolean not null default false,
  updated_at      timestamptz not null default now()
);
-- messages looked at (copied + skipped bot posts), for the progress/ETA panel
alter table frostbot.history_state add column if not exists seen integer not null default 0;
-- channel size from Discord's search (refreshed every 30 min while the copy runs)
alter table frostbot.history_state add column if not exists total integer;

-- only one bot instance at a time (e.g. local machine vs Bot-Hosting)
create table if not exists frostbot.instance_lock (
  name      text primary key,
  holder    text not null,
  heartbeat timestamptz not null
);
