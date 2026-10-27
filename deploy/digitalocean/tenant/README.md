# AP Venture coworkers

The tenant package the digital factory runs instead of `examples/fintech`. compose.yaml mounts this
directory read-only at `/tenant` and points `TENANT_PACKAGE_DIR` at it, so a change here reaches the
deployment with `git pull` and `docker compose --env-file .env up -d`.

| File | What it holds |
| --- | --- |
| `agents.yaml` | The coworkers. Role texts come from the Linear document "Coworker roles v1" (AP-89, AP-90). |
| `channels.yaml` | One starting conversation per coworker. |
| `skills.yaml` | Copied from `examples/fintech`, unchanged, so `bot-creator` and `skill-creator` exist. |
| `model.yaml` | Copied unchanged. With `CLAUDE_CODE_OAUTH_TOKEN` set, built-in Bots run on the Claude plan through the harness and this file's model is not used. |
| `brand.yaml`, `knowledge.yaml` | Product name; no document sources yet. |

A role here grants nothing. What a coworker may call (Linear, the browser, another coworker) is
granted on its profile in the app by an administrator. Linear stays the source of truth for the
role texts: change the document first, then this file.
