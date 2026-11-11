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

# Watchdog (AP-124). OpenBot can stop answering without exiting, and `restart: unless-stopped`
# only catches an exit: on 11 Nov the API answered 502 for 25 minutes until a deploy restarted
# it. So every run first asks OpenBot's /health through Caddy's container (busybox wget). Two
# failures in a row (about four minutes) save the last 300 log lines next to the deploy log and
# restart openbot. A deploy in progress holds the lock above, so it never races this.
unhealthy="$HOME/.digital-factory-unhealthy"
if docker compose --env-file .env exec -T caddy wget -q -T 10 -O /dev/null http://openbot:3001/health >/dev/null 2>&1; then
  rm -f "$unhealthy"
else
  misses=$(( $(cat "$unhealthy" 2>/dev/null || echo 0) + 1 ))
  echo "$misses" > "$unhealthy"
  if [ "$misses" -ge 2 ]; then
    stamp=$(date -u +%Y%m%dT%H%M%SZ)
    echo "$(date -u +%FT%TZ) watchdog: openbot failed /health ${misses} times, restarting (logs in ~/openbot-hang-$stamp.log)"
    docker compose --env-file .env logs --tail 300 openbot > "$HOME/openbot-hang-$stamp.log" 2>&1 || true
    docker compose --env-file .env restart openbot || true
    rm -f "$unhealthy"
  fi
fi

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
