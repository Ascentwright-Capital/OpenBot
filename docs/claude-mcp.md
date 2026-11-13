# Managing OpenBot from Claude

OpenBot is an MCP server at `/api/mcp`. Connect it to claude.ai, the Claude app or Claude Code, and
Claude can manage OpenBot as you: your Bots, Team Bots and who they are shared with, which apps each
Bot may use, and, if you are an admin, people, roles, capability switches and the audit trail.

Claude signs in through OpenBot's own sign-in. Nothing is configured per client: Claude registers
itself, you sign in with your usual identity provider, and you approve it on a consent screen.

## Connect

The server URL is your OpenBot address followed by `/api/mcp`, for example
`https://factory.ascentwright.com/api/mcp`.

**claude.ai and the Claude app.** Settings → Connectors → Add custom connector. Paste the URL and
leave the OAuth client fields empty. Choose Connect, sign in to OpenBot, and choose Allow.

**Claude Code.**

```bash
claude mcp add --transport http openbot https://factory.ascentwright.com/api/mcp
```

Then run `/mcp` in Claude Code, pick `openbot` and authenticate. A browser opens on OpenBot's sign-in
and consent screens.

## What Claude can do

Two OAuth scopes, chosen on the consent screen by what the client asks for:

| Scope            | Allows                                                                         |
| ---------------- | ------------------------------------------------------------------------------ |
| `openbot:read`   | Read tools only. Any request other than GET is refused.                        |
| `openbot:manage` | Read and change, within what you could already change in the browser.          |

A scope never adds a permission. Every tool call is an in-memory request to an existing `/api`
route, admitted as you, so it meets the same admin and owner checks, the same capability switches
and writes the same audit rows as your browser. An ordinary member asking for an admin tool gets the
route's own refusal.

Named tools:

| Tool                                            | Scope  | Route                                         |
| ----------------------------------------------- | ------ | --------------------------------------------- |
| `whoami`                                        | read   | `GET /api/me`                                 |
| `list_bots`, `get_bot`                          | read   | `GET /api/agents[/:id]`                       |
| `create_bot`, `update_bot`                      | manage | `POST /api/agents`, `PATCH /api/agents/:id`   |
| `list_team_bots`                                | read   | `GET /api/team-bots`                          |
| `publish_team_bot`, `unpublish_team_bot`        | manage | `PUT`/`DELETE /api/team-bots/:id/publication` |
| `assign_team_bot`, `unassign_team_bot` (admin)  | manage | `/api/team-bots/:id/assignments`              |
| `list_plugins`, `get_bot_grants`                | read   | `GET /api/plugins`, `/api/plugins/for/:id`    |
| `grant_to_bot`, `revoke_from_bot`               | manage | `/api/plugins/grants`                         |
| `list_people` (admin)                           | read   | `GET /api/admin/people`                       |
| `set_role` (admin)                              | manage | `POST /api/admin/people/:id/role`             |
| `get_controls` (admin)                          | read   | `GET /api/admin/enterprise`                   |
| `set_capability` (admin)                        | manage | `PUT /api/admin/enterprise/capabilities`      |
| `audit_events` (admin)                          | read   | `GET /api/admin/audit-events`                 |
| `openbot_api`                                   | either | any other `/api` route                        |

`openbot_api` covers every other screen (routines, conversations, approvals, computers). It cannot
reach `/api/auth`, `/api/mcp`, `/api/events` or `/api/delivery/webhooks`.

## How it works

- `server/src/auth/oauth.ts`: OpenBot as an OAuth 2.1 authorization server
  (`@better-auth/oauth-provider` with Better Auth's `jwt` plugin). Issuer `<origin>/api/auth`, one
  resource `<origin>/api/mcp`. Open dynamic client registration (RFC 7591); a client whose every
  callback is on `localhost` is registered as a native app, which is how Claude Code registers.
- Discovery: `/.well-known/oauth-protected-resource/api/mcp` (RFC 9728) and
  `/.well-known/oauth-authorization-server/api/auth` (RFC 8414), also at the bare prefixes.
- Access tokens are JWTs for the MCP resource, good for one hour. Refresh tokens last 30 days.
- `server/src/mcp/`: the endpoint (Streamable HTTP, stateless) and the tool list.
- `server/src/auth/guards.ts`: a token is admitted on `/api` routes only for requests carrying the
  process's internal-call secret, which only `/api/mcp` sets. The same token sent straight to any
  other route is ignored. A person who has been removed is refused on their next call.
- App: `/sign` resumes the authorization after sign-in, and `/connect/consent` is the consent screen.

## Limits and operations

- Only deployments that sign people in themselves (Google, Microsoft, Okta, SSO). A deployment signed
  in by an organization authority (`OPENBOT_ORGANIZATION_AUTH_URL`) or in single-user mode has no MCP
  endpoint.
- Registration is open, so any MCP client can ask. Nothing is granted until a signed-in person
  approves it by name, and the consent screen shows where it will send them back.
- Removing somebody refuses their next call through Claude: every call re-checks that they are
  still a member with a role, whatever token they hold.
- The JWT signing keys in `jwks` are encrypted with `BETTER_AUTH_SECRET`. After changing the secret,
  delete the rows in `jwks`; new keys are created on the next sign-in, and connected clients sign in
  again.
- OAuth tables: `oauth_clients`, `oauth_consents`, `oauth_access_tokens`, `oauth_refresh_tokens`,
  `oauth_resources`, `oauth_client_resources`, `oauth_client_assertions`, `jwks` (migration
  `0089_oauth_provider`).
