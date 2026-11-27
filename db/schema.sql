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

-- ===================== Matchbox (Minecraft) bridge =====================
-- The Minecraft plugin (M4TCHBOX, on another machine behind a tunnel) and the bot talk
-- through these tables; neither needs an inbound port. The plugin logs in as the
-- restricted role `matchbox_plugin` (scripts/mc-role.js), which can only touch mc_*.

-- Minecraft account <-> Discord account
create table if not exists frostbot.mc_links (
  mc_uuid    text primary key,
  mc_name    text not null,
  discord_id text not null unique,
  linked_at  timestamptz not null default now()
);

-- short-lived codes shown in game by `/matchbox link`, redeemed with `frst mc link <code>`
create table if not exists frostbot.mc_link_codes (
  code       text primary key,
  mc_uuid    text not null,
  mc_name    text not null,
  expires_at timestamptz not null
);

-- current state of each game, written by the plugin; the bot mutes/unmutes from it.
-- phase: 'play' (everyone muted), 'meeting' (alive unmuted, dead muted), 'ended'.
create table if not exists frostbot.mc_games (
  session    text primary key,
  phase      text not null,
  alive      text[] not null default '{}',
  dead       text[] not null default '{}',
  updated_at timestamptz not null default now()
);

-- admin commands from Discord (`frst mc start test`), run by the plugin as console
create table if not exists frostbot.mc_commands (
  id           bigserial primary key,
  command      text not null,
  requested_by text,
  created_at   timestamptz not null default now(),
  done_at      timestamptz,
  ok           boolean,
  result       text
);
create index if not exists mc_commands_pending_idx on frostbot.mc_commands (id) where done_at is null;

-- members the bot server-muted for a game, so it only ever unmutes its own mutes
create table if not exists frostbot.mc_muted (
  discord_id text primary key,
  muted_at   timestamptz not null default now()
);

-- instant wake-ups: the bot LISTENs on mc_games, the plugin on mc_commands
create or replace function frostbot.mc_games_notify() returns trigger language plpgsql as $$
begin
  perform pg_notify('mc_games', new.session);
  return new;
end $$;
drop trigger if exists mc_games_notify on frostbot.mc_games;
create trigger mc_games_notify after insert or update on frostbot.mc_games
  for each row execute function frostbot.mc_games_notify();

create or replace function frostbot.mc_commands_notify() returns trigger language plpgsql as $$
begin
  perform pg_notify(case when new.done_at is null then 'mc_commands' else 'mc_results' end, new.id::text);
  return new;
end $$;
drop trigger if exists mc_commands_notify on frostbot.mc_commands;
create trigger mc_commands_notify after insert or update on frostbot.mc_commands
  for each row execute function frostbot.mc_commands_notify();

-- the plugin's restricted login (created with a password by scripts/mc-role.js)
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'matchbox_plugin') then
    grant usage on schema frostbot to matchbox_plugin;
    grant select on frostbot.mc_links to matchbox_plugin;
    grant select, insert, delete on frostbot.mc_link_codes to matchbox_plugin;
    grant select, insert, update, delete on frostbot.mc_games to matchbox_plugin;
    grant select, update on frostbot.mc_commands to matchbox_plugin;
  end if;
end $$;
