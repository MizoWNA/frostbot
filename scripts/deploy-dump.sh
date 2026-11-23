#!/bin/sh
# Push secrets from .env to the Supabase Edge Function and deploy it.
# One-time: `npx supabase login`. Re-run after changing the token/guild or the code.
set -eu
# Pass --yes to skip the CLI's confirmation prompt: npm run deploy:dump -- --yes
YES="${1:-}"
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
REF=eafrclfpywnpblssswgo
: "${API_TOKEN:?API_TOKEN missing in .env}"
if [ -n "${DISCORD_TOKEN:-}" ] && [ -n "${MAIN_GUILD_ID:-}" ]; then
  npx -y supabase secrets set --remote="$REF" $YES \
    DISCORD_TOKEN="$DISCORD_TOKEN" MAIN_GUILD_ID="$MAIN_GUILD_ID" API_TOKEN="$API_TOKEN"
else
  echo "DISCORD_TOKEN/MAIN_GUILD_ID not in .env yet, setting only API_TOKEN (re-run later)"
  npx -y supabase secrets set --remote="$REF" $YES API_TOKEN="$API_TOKEN"
fi
npx -y supabase functions deploy frostbot-dump --remote="$REF" $YES --no-verify-jwt --use-api
echo "→ https://$REF.supabase.co/functions/v1/frostbot-dump/health"
