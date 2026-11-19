# Digital factory on DigitalOcean

AP Venture runs this fork of OpenBot on one DigitalOcean droplet in Singapore. People reach the
Bots in Slack and in the web app. Linear tracks the work: project Digital factory, AP-84 and its
sub-issues; the platform choice is D-67.

| Piece | What it is |
| --- | --- |
| `compose.yaml` | The all-in-one OpenBot image with its own PostgreSQL, the Claude harness, and Caddy for TLS |
| `setup.sh` | One-time hardening and Docker install for a fresh Ubuntu 24.04 droplet |
| `sweeps.sh` | Fires due routines and culls unsent attachments; host cron runs it |
| `autodeploy.sh` | Deploys `main` when it moves; host cron runs it every two minutes |
| `Caddyfile` | HTTPS for `OPENBOT_DOMAIN`, certificates from Let's Encrypt |
| `.env.example` | Every setting this deployment needs, with where each value comes from |
| `opentag` service | Slack through CopilotKit OpenTag, started with `--profile slack` |

## Before you start

You need these accounts (AP-85), all owned by the company account, not a personal one:

1. A domain, and a DNS name for the factory, for example `factory.<company domain>`.
2. Google Workspace on that domain, and an OAuth client (Google Cloud console, "Web application")
   with redirect URI `https://<factory domain>/api/auth/callback/google`.
3. A Claude plan on the company account. On any machine with Claude Code, sign in as that account
   and run `claude setup-token`; the printed token is `CLAUDE_CODE_OAUTH_TOKEN`.
4. CopilotKit Intelligence, free plan: `npx --yes copilotkit@latest project select` prints the key.
5. A DigitalOcean account.

## 1. Create the droplet

Ubuntu 24.04, region SGP1, Basic, 8 GB / 4 vCPU (docs/deployment.md recommends 4 GB for a handful of
Bots; the extra room is for the browser). Add your SSH key and turn on backups. Point the DNS name
at the droplet's IP.

## 2. Harden it

```sh
scp deploy/digitalocean/setup.sh root@<ip>:
ssh root@<ip> "sh setup.sh '$(cat ~/.ssh/id_ed25519.pub)'"
```

After this, root cannot log in over SSH. Use `ssh factory@<ip>`.

## 3. Deploy

```sh
ssh factory@<ip>
git clone https://github.com/Ascentwright-Capital/OpenBot /opt/digital-factory
cd /opt/digital-factory/deploy/digitalocean
cp .env.example .env && chmod 600 .env
# Fill in .env. Generate each secret with: openssl rand -base64 32
docker compose --env-file .env up -d
docker compose --env-file .env logs -f openbot
```

The first start creates the database and runs migrations. Sign in at `https://<factory domain>`
with an address listed in `INITIAL_ADMIN_EMAILS`.

Cloning needs read access to this private repo: a deploy key (read-only) on the repo is enough.

## Claude: plan or key

`CLAUDE_CODE_OAUTH_TOKEN` runs the built-in Bots on the company Claude plan, through the
`agent-claude-sdk` harness. If Anthropic changes what a plan may be used for, switch to the key:
empty `CLAUDE_CODE_OAUTH_TOKEN`, set `BOT_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` (with a
spending cap in the Anthropic Console), and `docker compose --env-file .env up -d`. Never set both;
the harness refuses to start if you do.

## Slack (AP-88)

OpenTag sits between Slack and OpenBot. Slack's credentials live in CopilotKit Intelligence, and
OpenTag reaches it over an outbound connection, so the droplet publishes nothing new.

1. On a laptop, with the same Intelligence project as `INTELLIGENCE_API_KEY`:

   ```sh
   npx --yes copilotkit@latest project select
   npx --yes copilotkit@latest channels add --name digital-factory --display-name "Factory" --adapter slack --json
   ```

   It pauses with a `nextAction`: a prefilled Slack app link and a `resumeCommand`. Create the app
   in the AP Venture Slack workspace, leave **Socket Mode off**, choose **Reinstall to Workspace**
   under OAuth & Permissions, then run the `resumeCommand`.
2. In `.env`, set `OPENTAG_SHARED_SECRET` (at least 32 characters) and keep `OPENTAG_URL` and
   `INTELLIGENCE_CHANNEL_NAME=digital-factory` as they are. Set `OPENTAG_SLACK_BOT_TOKEN` to the
   app's **Bot User OAuth Token** (`xoxb-`, on the app's **OAuth & Permissions** page). While there,
   check **Bot Token Scopes** has `chat:write`, `im:write`, `chat:write.customize`,
   `channels:read` and `groups:read`; add any that are missing and **Reinstall to Workspace**.
3. `docker compose --env-file .env --profile slack up -d --build`. The first build takes a few
   minutes: OpenTag is built from our copy of its `openbot-pairing` branch
   (Ascentwright-Capital/OpenTag), because no release has the pairing yet.
4. In Slack, `/invite @Factory` to the channels it should work in, including every coworker's
   numbered channel.
5. Each person opens the Orchestrator's page in OpenBot, **Reaching you**, **Connect**, and sends the
   `link <code>` it shows to @Factory in a direct message within ten minutes.
   If the dialog says "Failed to fetch", a browser ad or privacy blocker stopped the request
   (`net::ERR_BLOCKED_BY_CLIENT`): allow the site or use a private window.

Check it from a real account: a mention gets a reply, a follow-up in that thread gets a reply, an
unmentioned message in a new conversation gets silence.

**Always tag @Factory, in a direct message too.** This is deliberate: @Factory answers a message
only when it is tagged, or when the message is a reply in a thread it already answers in. A direct
message without the tag gets no reply and no notice, and never reaches OpenBot. Start the direct
message with `@Factory`; replies in that thread then work without the tag.

**Link to the shared front desk, not a copy.** Connect from the page of the built-in front desk
Bot (`orchestrator`, shown as "00 Factory Master"). A private Bot with a similar name has none of
its apps or coworkers, so @Factory would answer but say it has no Linear tools and nobody to hand
work to. **Reaching you** shows which Bot an account is linked to; connecting again from the right
page moves the link.

**Where answers go.** In a direct message with @Factory, the answer comes back in the DM. In a
channel thread, with `OPENTAG_ANSWER_IN_CHANNELS=true` (our setting), the coworker answers in that
thread for everyone there to read; approval requests show there as Approve/Deny buttons only the asker can press. With it off,
OpenBot's default, the channel gets a one-line notice and the answer goes to the asker's DM. Replies
after an approval, a Bot's questions and routine results arrive by DM through our OpenTag's
`/openbot/deliver`, which needs `OPENTAG_SLACK_BOT_TOKEN`.

Only people who linked their Slack (step 5) get answers; anyone else is told how to link. One link
is enough for every coworker.

**Each numbered channel belongs to its coworker (D-75, AP-131).** A thread started in a Slack channel
with the same name as a channel in [`tenant/channels.yaml`](tenant/channels.yaml) is answered by
that channel's coworker: a mention in `#00-30-cto` reaches 00-30 CTO directly. The turn runs as the
person who asked, in a conversation of their own with that coworker. Direct messages,
`#00-00-factory-master` and every other channel reach the front desk the person linked. A thread
keeps the coworker it began with. To add a coworker's channel: add it to `channels.yaml`, create the
Slack channel with exactly that name, and invite @Factory. OpenBot asks OpenTag for the channel's
name and keeps it for five minutes, so a new or renamed channel can take that long to be noticed.

**Posts made through an app.** Slack marks a message an app posts for someone ("Sent using
Claude") as an app's, and OpenTag ignores those so a bot can never answer itself. The accounts in
`OPENTAG_TRUSTED_APP_SENDERS` are the exception: their app posts count as that person asking
(AP-119). The default in `compose.yaml` is the shared ascentwright account (`U0CD7JBKWP2`), which
Claude sessions post as. The account still has to link its Slack like anyone else.

## Coworkers (AP-89)

The coworkers live in [`tenant/`](tenant/README.md): Orchestrator (the front desk people reach in
Slack), Marketing, Analytics and Software factory, each a built-in Bot running on the Claude plan.
`compose.yaml` mounts the directory and points `TENANT_PACKAGE_DIR` at it, so changing a role is a
pull request, then `git pull` and `docker compose --env-file .env up -d` on the droplet.

A role grants nothing. After the first start, an administrator grants on each coworker's profile:

1. **Orchestrator:** the other three coworkers, so it can hand work to them.
2. **Every coworker:** Linear, once the Linear connector is added.
3. **Marketing:** the browser, for research.

Link Slack to the Orchestrator's **Front desk** conversation (see "Slack", step 5) so the team talks
to the front desk rather than to one person's private conversation.

## Deploys

A merge to `main` is live within a few minutes. Host cron runs [`autodeploy.sh`](autodeploy.sh)
every two minutes: it fetches `origin/main`, and when that is not the commit it last deployed, it
fast-forwards `/opt/digital-factory`, builds the images that are not on the droplet yet, and runs
`docker compose --env-file .env --profile slack up -d --no-build --wait`. So a pull request that moves `OPENBOT_REF` or `OPENTAG_REF` in `compose.yaml`, edits a
coworker under `tenant/`, or changes the Caddyfile deploys itself once merged.

- Pull, not push: GitHub holds no key to the droplet, and nothing new is opened to the internet.
- The coworkers (`tenant/`) and the Caddyfile are mounted rather than built, so when a merge
  changes them it restarts `openbot` or reloads Caddy.
- An image is built only when its tag is not on the droplet. The tag is the commit in `OPENBOT_REF`
  or `OPENTAG_REF`, so a merge that changes neither builds nothing. A new `OPENBOT_REF` still builds
  the OpenBot image with the stack running, which the 8 GB droplet cannot carry: build that image
  ahead with the stack stopped, or with `autodeploy.sh` paused.
- A failed build leaves the running containers as they were and is tried again, at most three
  times per commit, so a broken build does not keep the droplet's CPU busy. The next merge tries
  again, or delete `~/.digital-factory-failed`. Read `/var/log/digital-factory-deploy.log`.
- **A failed deploy is posted in Slack #00-digital-factory** (AP-270), through the Factory app with
  `OPENTAG_SLACK_BOT_TOKEN`: on its first try, when it stops after the third, and when a later try
  works. The second failed try posts nothing, so a broken commit gives at most two notices. A clean
  deploy posts nothing. Without the token in `.env`, nothing is posted.
- Only fast-forwards. Local commits on the droplet stop it, and the log says so.
- After a deploy that worked, it removes unused images built more than a week ago and build cache
  not used for a day (AP-242), so the disk does not fill with old builds. The log line starts with
  `cleanup:`. Volumes are never removed. A revert to a pin from the last week still finds its image
  and needs no build; an older one is rebuilt.
- `.env` is never touched. A change that needs a new setting still needs it added by hand first.
- To pause it, comment out the `autodeploy.sh` line in `/etc/cron.d/digital-factory`.
- **Watchdog:** each run first checks OpenBot's `/health` (through the Caddy container) and counts
  Caddy's own 502 errors over the last two minutes. A failed `/health`, or five or more 502s, is a miss.
  `/health` does not touch the database, so the 502 count catches an OpenBot whose signed-in requests
  hang while `/health` still answers. Two misses in a row, about four minutes, save the last 300 log
  lines to `~/openbot-hang-<time>.log` and restart `openbot`, because a hung OpenBot does not exit and
  so `restart: unless-stopped` never fires. In `/var/log/digital-factory-deploy.log`, the line
  `watchdog: openbot ... (miss <n>)` marks each miss and `watchdog: openbot unhealthy` marks each restart.
  Each restart is also posted in Slack #00-digital-factory. A deploy or a watchdog restart clears the count, and 502s are not counted for three minutes after
  either, because a restart itself makes Caddy answer 502 for a few seconds (AP-136).
- **Idle transactions:** PostgreSQL ends any session that sits inside a transaction for a minute
  without running a statement (`idle_in_transaction_session_timeout`, AP-127). That is what hung the
  signed-in requests on 11 November; the watchdog above stays as the backstop.

`setup.sh` installs the cron line. On a droplet set up before it existed, run as root:

```sh
echo '*/2 * * * * factory /opt/digital-factory/deploy/digitalocean/autodeploy.sh >> /var/log/digital-factory-deploy.log 2>&1' >> /etc/cron.d/digital-factory
touch /var/log/digital-factory-deploy.log && chown factory /var/log/digital-factory-deploy.log
```

## Update

```sh
cd /opt/digital-factory && git pull
# Edit OPENBOT_VERSION in deploy/digitalocean/.env to the release you want.
cd deploy/digitalocean && docker compose --env-file .env pull && docker compose --env-file .env up -d
```

Read the release's `CHANGELOG.md` entry first. Upstream is alpha and says so.

The `openbot` image is built here, not pulled: from our `factory/<version>` branch, which is the
release plus our own server changes (today answers in shared Slack threads and the MCP endpoint for
Claude). To move to a new release,
branch `factory/<new version>` from its tag, cherry-pick our changes onto it, point the `openbot`
build in `compose.yaml` at the new commit, and run `docker compose --env-file .env up -d --build`.

## Sync the fork with upstream

```sh
git remote add upstream https://github.com/CopilotKit/openbot   # once
git fetch upstream main
git checkout -b chore/sync-upstream-<date> && git merge upstream/main
# Open a PR into main. Our changes live under deploy/ and do not collide with upstream.
```

## Back up

- Droplet backups (weekly, DigitalOcean) cover the volumes.
- `KEY_ENCRYPTION_KEY` and `.env` go in the company password manager as well. Without the key,
  stored credentials cannot be decrypted, even from a backup.

## Known limits of v1

- **One shared browser.** Every Bot shares the browser, logins and files inside the openbot
  container. docs/deployment.md calls this fine for one team that trusts its own Bots. A computer per
  Bot needs the supervisor (or the Helm chart on a cluster), and is the next step once more than a
  few Bots or any untrusted Bot run here.
- **Answers come from the asker's own conversation.** A channel thread runs as the person who
  asked, with the coworker of that channel or, elsewhere, the Bot they linked. Coworkers do not
  share one conversation across the team.
- **One Slack identity.** Every coworker answers through @Factory (D-75). A thread starts with the
  @Factory tag, in a coworker's channel too. `@Factory <Coworker>: …` from another channel still
  goes through 00-00 Factory Master, which hands it over.
