# OpenBot (Ascentwright fork)

Our fork of CopilotKit OpenBot. It runs the digital factory at factory.ascentwright.com.

Shared Ascentwright rules live in [`.agents/shared/`](.agents/shared/README.md), the `agent-harness` submodule. If that folder is empty, run `git submodule update --init` first. This file wins where the two differ.

- Upstream docs are in [`docs/`](docs/README.md). For deploying the factory droplet, see [`deploy/digitalocean/`](deploy/digitalocean/README.md): a merge to `main` deploys within about two minutes (D-68).
- The project skills under `.claude/skills` cover user-facing copy, data access and screen layout in `app/`.
