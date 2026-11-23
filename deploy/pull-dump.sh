#!/bin/sh
# Pull a fresh Frostbot structure dump (json + txt) onto THIS machine.
# FROSTBOT_URL defaults to the Supabase Edge Function; FROSTBOT_TOKEN = the API_TOKEN.
set -eu
: "${FROSTBOT_TOKEN:?set FROSTBOT_TOKEN}"
URL="${FROSTBOT_URL:-https://eafrclfpywnpblssswgo.supabase.co/functions/v1/frostbot-dump}"
DIR="${FROSTBOT_DUMP_DIR:-$HOME/frostbot-dumps}"
mkdir -p "$DIR"
day=$(date -I)
get() { # $1 = remote path, $2 = local file
  curl -fsS --retry 3 --max-time 180 -H "Authorization: Bearer $FROSTBOT_TOKEN" "$URL/$1" -o "$2.part"
  mv "$2.part" "$2"
}
get dump.json   "$DIR/$day-dump.json"   # builds a fresh dump
get latest.txt  "$DIR/$day-dump.txt"    # same dump, readable (no second rebuild)
echo "saved $DIR/$day-dump.{json,txt}"
