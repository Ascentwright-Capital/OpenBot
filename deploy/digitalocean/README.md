# Digital factory on DigitalOcean

AP Venture runs this fork of OpenBot on one DigitalOcean droplet in Singapore. People reach the
Bots in Slack and in the web app. Linear tracks the work: project Digital factory, AP-84 and its
sub-issues; the platform choice is D-67.

| Piece | What it is |
| --- | --- |
| `compose.yaml` | The all-in-one OpenBot image with its own PostgreSQL, the Claude harness, and Caddy for TLS |
| `setup.sh` | One-time hardening and Docker install for a fresh Ubuntu 24.04 droplet |
| `sweeps.sh` | Fires due routines and culls unsent attachments; host cron runs it |
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
   check **Bot Token Scopes** has `chat:write`, `chat:write.customize`, `channels:read` and
   `groups:read`; add any that are missing and **Reinstall to Workspace**.
3. `docker compose --env-file .env --profile slack up -d --build`. The first build takes a few
   minutes: OpenTag is built from our copy of its `openbot-pairing` branch
   (Ascentwright-Capital/OpenTag), because no release has the pairing yet.
4. In Slack, `/invite @Factory` to the channels it should work in.
5. Each person opens the Orchestrator's page in OpenBot, **Reaching you**, **Connect**, and sends the
   `link <code>` it shows to @Factory in a direct message within ten minutes.
   If the dialog says "Failed to fetch", a browser ad or privacy blocker stopped the request
   (`net::ERR_BLOCKED_BY_CLIENT`): allow the site or use a private window.

Check it from a real account: a mention gets a reply, a follow-up in that thread gets a reply, an
unmentioned message in a new conversation gets silence.

**Where answers go.** In a direct message with @Factory, the answer comes back in the DM. In a
channel, OpenBot keeps the answer out of the channel, because it may draw on the person's private
Bot, and sends it to their DM instead; the channel gets a one-line notice. Replies after an
approval, a Bot's questions and routine results also arrive by DM. All of these come through our
OpenTag's `/openbot/deliver`, so they need `OPENTAG_SLACK_BOT_TOKEN`; without it they show only in
the OpenBot app and fail visibly in its delivery outbox.

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

## Update

```sh
cd /opt/digital-factory && git pull
# Edit OPENBOT_VERSION in deploy/digitalocean/.env to the release you want.
cd deploy/digitalocean && docker compose --env-file .env pull && docker compose --env-file .env up -d
```

Read the release's `CHANGELOG.md` entry first. Upstream is alpha and says so.

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
- **Slack answers privately.** Answers asked for in a channel go to the asker's DM, not the
  channel (see "Slack"). Shared coworkers that answer in the channel are AP-92.
- **One Slack identity.** Every coworker answers through @Factory, under its own name. A Slack
  app and @handle per coworker is AP-92.
