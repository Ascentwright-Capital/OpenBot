# AscentWright coworkers

The tenant package the digital factory runs instead of `examples/fintech`. compose.yaml mounts this
directory read-only at `/tenant` and points `TENANT_PACKAGE_DIR` at it, so a change here reaches the
deployment with `git pull` and `docker compose --env-file .env up -d`.

| File | What it holds |
| --- | --- |
| `agents.yaml` | The coworkers, named `CC-DS Name` (company, department, seat) to match their Slack channel `#cc-ds-name`. Lineup and roles: the Linear document "Coworker roles v2" (AP-106). |
| `channels.yaml` | One starting conversation per coworker, named like its Slack channel. |
| `skills.yaml` | Copied from `examples/fintech`, unchanged, so `bot-creator` and `skill-creator` exist. |
| `model.yaml` | Copied unchanged. With `CLAUDE_CODE_OAUTH_TOKEN` set, built-in Bots run on the Claude plan through the harness and this file's model is not used. |
| `brand.yaml`, `knowledge.yaml` | Product name; no document sources yet. |

A role here grants nothing. What a coworker may call (Linear, the browser, another coworker) is
granted on its profile in the app by an administrator. Linear stays the source of truth for the
role texts: change the document first, then this file. Company knowledge is not here: it lives in the Linear
project "00 AscentWright knowledge" (KB documents), and each coworker's prompt lists the ones it reads.
