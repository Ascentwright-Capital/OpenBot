#!/bin/sh
# Runs one sweep inside the openbot container. Host cron calls it (see setup.sh):
#   sweeps.sh routines      every minute: hand due routines to the server
#   sweeps.sh attachments   every hour:   delete unsent attachments older than 24 hours
# The embedded PostgreSQL writes its URL into the s6 environment, so the sweep reads it from there.
set -eu
cd "$(dirname "$0")"
case "${1:-}" in
  routines) script="fire-routines.ts" ;;
  attachments) script="cull-staged-attachments.ts" ;;
  *) echo "usage: $0 routines|attachments" >&2; exit 2 ;;
esac
exec docker compose --env-file .env exec -T openbot sh -c "
  export DATABASE_URL=\$(cat /run/s6/container_environment/DATABASE_URL)
  export SERVER_INTERNAL_URL=http://localhost:3001
  cd /app/server && bun scripts/$script"
