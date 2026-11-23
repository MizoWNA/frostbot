# Frostbot ❄️

Custom moderation + anti-nuke bot. Prefix commands (`frst <command>`), Supabase Postgres for state, one Node process + one Supabase Edge Function for dumps.

- **Message mirror**: every message (text + media) in the main server is copied 1:1 into a private sister server through webhooks (author name + avatar). Message content is never stored in the DB, only short-lived id links so edits/deletes can sync. Deleted messages are marked 🗑️ in the mirror instead of removed, so a nuker mass-deleting can't wipe the archive.
- **Anti-nuke**: watches the audit log. One account deleting channels/roles, mass-banning/kicking, spamming channels/webhooks, or giving roles dangerous perms too fast gets stripped/kicked/banned. The bot then deletes their webhooks, reverses their bans, and DMs the owner.
- **Structure dumps**: roles + perms, channels + permission overwrites, every member's roles, server settings. Generated **on request** (Supabase Edge Function API or `frst backup`) as `.json` (for restore) and `.txt` (readable). Only the latest one is cached. No messages, no media.
- **Restore**: rebuilds roles/channels/perms/member roles from a dump, then refills recreated channels from the mirror via webhooks.
- **Warning board**: a sticky panel (stays the last message in its channel); members who reach `warn_flag` (default 3) warnings jump to the top under 🚨 *Needs action*.
- **New account kicker**: accounts younger than `min_age_days` (default 2) get a DM + kick.
- Usual moderation: kick, ban, timeout, purge, lock, lockdown, slowmode, nick, role, whois.

## Setup

### 1. Discord application
1. <https://discord.com/developers/applications> → New Application → **Bot** → Reset Token → put it in `.env` as `DISCORD_TOKEN`.
2. Same page, enable **Server Members Intent** and **Message Content Intent**.
3. Invite to **both** servers with Administrator:
   `https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot&permissions=8`
4. Main server → Server Settings → Roles → drag the bot's role **to the very top**. It can only act on (and protect against) roles below its own.
5. Mirror server: a fresh private server only you trust is in. The bot creates the channels itself.

### 2. Config
```sh
cp .env.example .env    # fill in token, guild ids (right-click server → Copy Server ID), DATABASE_URL
openssl rand -hex 32    # → API_TOKEN
npm install
npm run migrate         # creates the `frostbot` schema in Supabase (safe to re-run)
npm start
```
Then in Discord: `frst set modlog #mod-log`, `frst warnboard #warnings`, `frst mirror history start` (copies all old messages, resumable), `frst config`.

### 3. Hosting the bot (Bot-Hosting free plan)
Free plan: 256 MB RAM, 25% CPU, **must be renewed manually every 4 days** (set a reminder, or the bot gets suspended and anti-nuke is off).
1. New deployment → **From GitHub** (private repo is fine) → Node.js.
2. Start command: `npm start` (runs with a 150 MB heap cap; media transfers are limited to 2 at a time to stay under 256 MB).
3. Put the `.env` values in the panel's environment variables (or upload a `.env`; never commit it).
4. No port needed: the bot only makes outbound connections.

The bot writes nothing to disk; all state is in Supabase. To move hosts, start it anywhere else with the same env vars.

### Moving the bot from your machine to Bot-Hosting
Only one copy can be active (Supabase instance lock), so the switch is safe:
1. In the Bot-Hosting panel (Node.js server), set the **Git repo** to this private GitHub repo, add a GitHub token (read-only, this repo) as the git password/token, and turn on **auto update** so every start runs `git pull` + install. Start command `npm start`.
2. Env vars: `DISCORD_TOKEN`, `MAIN_GUILD_ID`, `MIRROR_GUILD_ID`, `PREFIX`, `DATABASE_URL`, plus `HISTORY_CONCURRENCY=2` and `MEDIA_CONCURRENCY=1` for the 256 MB plan.
3. Start it there. It logs `[lock] another FrostBot is running… Waiting` and does nothing else.
4. Stop the local one (`kill $(cat /tmp/frostbot.pid)`). Within ~15 s the hosted copy logs `[lock] this instance is active` and picks up everything, including an unfinished history copy.
If a copy crashes without releasing the lock, the other takes over after 90 s.

### Shipping updates (after the move)
Edit here, then:
```sh
npm run ship -- "what changed"
```
It syntax-checks, commits, pushes to GitHub and restarts the hosted bot through the panel API; on start the panel pulls the new code. Set `PANEL_SERVER_ID` and `PANEL_API_KEY` in `.env` once (panel → Account → API Credentials); without them it just pushes and you hit Restart in the panel.

Testing locally while the hosted bot runs: a local `npm start` waits on the lock and does nothing. Stop the hosted one in the panel first (it resumes the history copy where it left off), or test with a separate bot + test server.

### 4. Dump API (Supabase Edge Function)
Dumps are built by a Supabase Edge Function straight from Discord's API, so they work **even while the bot is offline**.
```sh
npx supabase login     # one time
npm run deploy:dump    # pushes DISCORD_TOKEN / MAIN_GUILD_ID / API_TOKEN from .env as secrets + deploys
```
Base URL: `https://eafrclfpywnpblssswgo.supabase.co/functions/v1/frostbot-dump`. Header: `Authorization: Bearer <API_TOKEN>`.

| Path | |
|---|---|
| `/dump.json` · `/dump.txt` | build a fresh dump (also becomes the cached latest) |
| `/latest.json` · `/latest.txt` | last generated dump, no rebuild |
| `/health` | no auth |

Right after anti-nuke fires (30 min), fresh dumps are still returned but **don't** replace the cached `latest`.

### 5. Pulling dumps onto your own machines
```sh
install -m755 deploy/pull-dump.sh ~/.local/bin/frostbot-pull-dump
printf 'FROSTBOT_TOKEN=<API_TOKEN>\n' > ~/.config/frostbot-dump.env && chmod 600 ~/.config/frostbot-dump.env
cp deploy/frostbot-dump.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now frostbot-dump.timer
loginctl enable-linger "$USER"
```
Saves `~/frostbot-dumps/YYYY-MM-DD-dump.{json,txt}`. Change `OnCalendar=weekly` to `daily` if you want.

`deploy/frostbot.service` is a systemd unit in case you ever move the bot to a VPS.

## Commands
`frst help` lists only what you can use; `frst help <command>` shows usage.

| | |
|---|---|
| **Moderation** | `kick` `ban` (`ban @u 1d reason` also deletes 1d of msgs) `unban` `timeout`/`mute` `untimeout` `purge` `slowmode` `lock` `unlock` `lockdown on/off` `nick` `role` `whois` |
| **Warnings** | `warn @u reason` `warns @u` `unwarn <#>` `clearwarns @u` `warnboard #channel` |
| **Protection** | `backup [txt/json]` `restore` `mirror status/sync` `mirror history [start/stop]` `trust`/`untrust` (owner) `trusted` `allow <id>` `unallow` `status` |
| **Settings** | `config`, `set <key> <value>`: `modlog`, `warn_flag`, `newacct`, `min_age_days`, `antinuke`, `antinuke_window`, `antinuke_limit`, `antinuke_punish` (strip/kick/ban), `mirror`, `mirror_map_days`, `rolepersist` |

## If the server gets nuked
1. Anti-nuke should already have punished the account; check the owner DM / mod log. If it couldn't (role too low), remove their perms by hand **first**.
2. **Don't** run `frst backup force`. Your dated files on your machines never overwrite each other, and the cached `latest` is protected for 30 min after detection.
3. In any surviving channel, **or in the mirror server**: `frst restore` with your last good `dump.json` attached (or `frst restore latest` if the cached one is from before the nuke). Review the preview, type `confirm`.
   Partial restores: `frst restore latest roles channels`. Parts: `settings roles channels members messages`.
4. Owner or `trust`ed users only.

## Limits / notes
- Threads and forum posts aren't mirrored yet; emojis/stickers aren't restored.
- The mirror server is read-only for everyone (webhooks still post). `#mirror-chat` is for **Mirror Mod**/**Mirror Master**; channels only roles above `mirror_mod_role` (default: Moderators) can see in main are visible to **Mirror Master** only.
- Replayed messages show as webhook (APP) messages with the restore time, not the original timestamp.
- Files bigger than the mirror server's upload limit (10 MB unboosted) are skipped with a note.
- Edits/deletes only sync for messages newer than `mirror_map_days` (default 30).
- Restoring Announcement/Stage/Forum channels needs Community enabled; otherwise they come back as text/voice.
- Nothing stops a compromised **owner** account; use 2FA.
