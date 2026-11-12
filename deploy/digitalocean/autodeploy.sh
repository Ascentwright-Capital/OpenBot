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
#
# /health does not touch the database (AP-126). On 12 Nov it answered 200 for hours while database
# connections sat idle in a transaction and every signed-in request hung until Bun closed it, which
# Caddy logs and returns as its own 502. So five or more of those in the last two minutes also
# count as a failed check. A 502 that OpenBot sends itself reaches the browser as 424 (Caddyfile)
# and is not counted.
#
# A restart of OpenBot makes Caddy answer 502 for a few seconds, and those are not a hang (AP-136).
# On 12 Nov two deploys 18 minutes apart each left one such miss, the count was never cleared in
# between because no check runs during a deploy, and the watchdog restarted an OpenBot that had
# just started. So a deploy and a watchdog restart both write the time to $restarted and clear the
# count, and 502s are not counted for three minutes after it: the two minutes of log this reads,
# and one more for the cron run to come round. A failed /health counts at any time.
unhealthy="$HOME/.digital-factory-unhealthy"
restarted="$HOME/.digital-factory-restarted"
reason=""
if ! docker compose --env-file .env exec -T caddy wget -q -T 10 -O /dev/null http://openbot:3001/health >/dev/null 2>&1; then
  reason="failed /health"
elif [ $(( $(date +%s) - $(cat "$restarted" 2>/dev/null || echo 0) )) -ge 180 ]; then
  gateway=$(docker compose --env-file .env logs --since 2m caddy 2>&1 | grep -c '"status":502' || true)
  [ "${gateway:-0}" -ge 5 ] && reason="behind ${gateway} Caddy 502s in 2 minutes"
fi
if [ -z "$reason" ]; then
  rm -f "$unhealthy"
else
  misses=$(( $(cat "$unhealthy" 2>/dev/null || echo 0) + 1 ))
  echo "$misses" > "$unhealthy"
  echo "$(date -u +%FT%TZ) watchdog: openbot ${reason} (miss ${misses})"
  if [ "$misses" -ge 2 ]; then
    stamp=$(date -u +%Y%m%dT%H%M%SZ)
    echo "$(date -u +%FT%TZ) watchdog: openbot unhealthy ${misses} times, restarting (logs in ~/openbot-hang-$stamp.log)"
    docker compose --env-file .env logs --tail 300 openbot > "$HOME/openbot-hang-$stamp.log" 2>&1 || true
    docker compose --env-file .env restart openbot || true
    rm -f "$unhealthy"
    date +%s > "$restarted"
    # Say so in Slack #00-digital-factory through the Factory app, so nobody has to log in to notice.
    # Only this notice is posted; the log lines stay on the droplet.
    token=$(sed -n 's/^OPENTAG_SLACK_BOT_TOKEN=//p' .env | head -n 1 | tr -d '"')
    if [ -n "$token" ]; then
      curl -s -m 10 -X POST https://slack.com/api/chat.postMessage \
        -H "Authorization: Bearer $token" -H "Content-type: application/json; charset=utf-8" \
        -d "{\"channel\":\"C0CGRELFAMT\",\"text\":\"Watchdog: the factory stopped answering for about 4 minutes and was restarted at $(date -u +%H:%M) UTC. Logs are on the server in ~/openbot-hang-$stamp.log.\"}" \
        >/dev/null 2>&1 || true
    fi
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
# From here on OpenBot may be restarted, whether or not the deploy then succeeds. Whenever this run
# ends, note the time and clear the watchdog's count, so those 502s are not read as a hang (AP-136).
trap 'date +%s > "$restarted"; rm -f "$unhealthy"' EXIT
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
