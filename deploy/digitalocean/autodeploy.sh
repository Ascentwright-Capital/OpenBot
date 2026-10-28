#!/bin/sh
# Deploys main when it moves. Host cron runs it every two minutes (see setup.sh):
#   fetch origin/main; if it is not what was last deployed, fast-forward and rebuild.
# Pull, not push: nothing outside the droplet can reach it or holds a key to it, and a merge to main
# is live within a few minutes. A build that fails leaves the running containers as they were, and
# the same commit is tried again, up to three times, until it deploys or main moves on.
set -eu
cd "$(dirname "$0")"
exec 9>/tmp/digital-factory-autodeploy.lock
flock -n 9 || exit 0

repo=$(git rev-parse --show-toplevel)
state="$HOME/.digital-factory-deployed"
failed="$HOME/.digital-factory-failed"
git -C "$repo" fetch -q origin main
target=$(git -C "$repo" rev-parse origin/main)
deployed=$(cat "$state" 2>/dev/null || true)
[ "$deployed" = "$target" ] && exit 0
# A build takes minutes of the droplet's CPU, so a commit that keeps failing is left alone after
# three tries. The next merge, or deleting the file, tries again.
tries=$(sed -n "s/^$target //p" "$failed" 2>/dev/null || true)
[ "${tries:-0}" -ge 3 ] && exit 0
echo "$target $((${tries:-0} + 1))" > "$failed"

echo "$(date -u +%FT%TZ) deploying $target"
# Only a fast-forward. A droplet with its own commits stops here and says so in the log.
git -C "$repo" merge --ff-only -q origin/main
# Every service, so a change to OPENBOT_REF, OPENTAG_REF or compose.yaml lands. Images whose source
# did not change are reused from the build cache. `--wait` holds until every service is healthy, so a
# deploy that starts but never comes up is not recorded and is tried again.
docker compose --env-file .env --profile slack up -d --build --wait --wait-timeout 300
# The coworkers and the Caddyfile are mounted, not built, so `up` does not see them change.
changed=$(git -C "$repo" diff --name-only "${deployed:-$target}" "$target" -- . 2>/dev/null ||
  echo "tenant/ Caddyfile")
if echo "$changed" | grep -q "tenant/"; then
  docker compose --env-file .env restart openbot
  docker compose --env-file .env --profile slack up -d --wait --wait-timeout 300
fi
if echo "$changed" | grep -q "Caddyfile"; then
  docker compose --env-file .env exec -T caddy caddy reload --config /etc/caddy/Caddyfile
fi
echo "$target" > "$state"
rm -f "$failed"
echo "$(date -u +%FT%TZ) deployed $target"
