#!/bin/sh
# Deploys main when it moves. Host cron runs it every two minutes (see setup.sh):
#   fetch origin/main; if it is not what was last deployed, fast-forward and rebuild.
# Pull, not push: nothing outside the droplet can reach it or holds a key to it, and a merge to main
# is live within a few minutes. A build that fails leaves the running containers as they were, and
# the same commit is tried again on the next run until it deploys or main moves on.
set -eu
cd "$(dirname "$0")"
exec 9>/tmp/digital-factory-autodeploy.lock
flock -n 9 || exit 0

repo=$(git rev-parse --show-toplevel)
state="$HOME/.digital-factory-deployed"
git -C "$repo" fetch -q origin main
target=$(git -C "$repo" rev-parse origin/main)
[ "$(cat "$state" 2>/dev/null || true)" = "$target" ] && exit 0

echo "$(date -u +%FT%TZ) deploying $target"
# Only a fast-forward. A droplet with its own commits stops here and says so in the log.
git -C "$repo" merge --ff-only -q origin/main
# Every service, so a change to OPENBOT_REF, OPENTAG_REF, the Caddyfile or the coworkers lands.
# Images whose source did not change are reused from the build cache. `--wait` holds until every
# service is healthy, so a deploy that starts but never comes up is not recorded and is tried again.
docker compose --env-file .env --profile slack up -d --build --wait --wait-timeout 300
echo "$target" > "$state"
echo "$(date -u +%FT%TZ) deployed $target"
