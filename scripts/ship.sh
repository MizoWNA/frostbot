#!/bin/sh
# Ship an update: syntax-check, commit everything, push to GitHub, then restart the hosted bot
# (its panel pulls the latest code from GitHub on every start).
#   npm run ship -- "what changed"
set -e
cd "$(dirname "$0")/.."
[ -f .env ] && { set -a; . ./.env; set +a; }

for f in $(find src scripts supabase/functions/_shared -name '*.js'); do node --check "$f"; done

if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -q -m "${1:-update}"
fi
git push -q
echo "pushed $(git rev-parse --short HEAD) to GitHub"

if [ -n "$PANEL_API_KEY" ] && [ -n "$PANEL_SERVER_ID" ]; then
  curl -fsS -X POST "${PANEL_URL:-https://control.bot-hosting.net}/api/client/servers/$PANEL_SERVER_ID/power" \
    -H "Authorization: Bearer $PANEL_API_KEY" -H "Content-Type: application/json" -H "Accept: application/json" \
    -d '{"signal":"restart"}'
  echo "hosted bot restarting, it pulls the update on start"
else
  echo "PANEL_API_KEY / PANEL_SERVER_ID not set in .env: restart the bot in the panel to load the update"
fi
