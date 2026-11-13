import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, gte, like } from "drizzle-orm";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createApp } from "../src/app";
import {
  auditEventsToCsv,
  createAuditReader,
  createAuditStore,
} from "../src/audit";
import { createAuth } from "../src/auth";
import { createRoleRepository } from "../src/auth/guards";
import {
  mcpResource,
  OAUTH_CONSENT_PAGE,
  OAUTH_LOGIN_PAGE,
} from "../src/auth/oauth";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  auditEvents,
  jwks,
  oauthClients,
  userRoles,
  users,
} from "../src/db/schema";
import { TEST_POOL, testDatabaseUrl } from "./support/database";
import { testEnvironment } from "./support/environment";

/*
 * Claude managing OpenBot, end to end, against Better Auth's own handler, the real app and a real
 * database: discovery, self-registration (as Claude Code does it, with a localhost callback),
 * sign-in redirect, consent, the token exchange, and MCP tool calls that reach the routes as the
 * person who approved. Nothing between the request and the row is stubbed.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const config = loadConfig(testEnvironment());
const BASE = config.auth?.baseUrl ?? "";
const SECRET = config.auth?.secret ?? "";
const suite = randomUUID().slice(0, 8);
const person = { id: `oauth-${suite}`, email: `oauth-${suite}@acme.test` };
const REDIRECT = "http://localhost:6274/callback";
const auth = createAuth(config, database);
const roleRepository = createRoleRepository(database);
const findPerson = async (userId: string) => {
  const [row] = await database.select().from(users).where(eq(users.id, userId));
  return row
    ? {
        id: row.id,
        email: row.email,
        name: row.name,
        image: row.image,
        revoked: false,
      }
    : undefined;
};
/*
 * `createApp` takes its collaborators by position. Only the ones this suite exercises are given:
 * the trail (read and written), the Bots a tool call creates, and `oauth`, its 40th argument.
 */
const collaborators: unknown[] = Array.from({ length: 40 });
collaborators[0] = config;
collaborators[1] = auth;
collaborators[2] = roleRepository;
collaborators[3] = createAuditReader(database);
collaborators[9] = createAgentProfileStore(database, undefined);
collaborators[12] = createAuditStore(database);
collaborators[39] = {
  jwks: () => auth.api.getJwks() as Promise<{ keys: unknown[] }>,
  findPerson,
  clientName: async (clientId: string) =>
    (
      await database
        .select({ name: oauthClients.name })
        .from(oauthClients)
        .where(eq(oauthClients.clientId, clientId))
    )[0]?.name ?? undefined,
} satisfies Parameters<typeof createApp>[39];
const app = createApp(...(collaborators as Parameters<typeof createApp>));
const startedAt = new Date();
let cookie = "";

function call(path: string, init: RequestInit = {}) {
  return app.request(`${BASE}${path}`, {
    ...init,
    headers: {
      origin: BASE,
      ...(typeof init.body === "string" && init.body.startsWith("{")
        ? { "content-type": "application/json" }
        : {}),
      ...(init.headers ?? {}),
    },
  });
}

beforeAll(async () => {
  // Signing keys are encrypted with the auth secret; one left by a run with another secret cannot
  // be read, so this suite starts from none.
  await database.delete(jwks);
  await database.insert(users).values({ ...person, name: "OAuth Person" });
  await database.insert(userRoles).values({ userId: person.id, role: "user" });
  const context = (await auth.$context) as {
    internalAdapter: {
      createSession: (userId: string) => Promise<{ token: string }>;
    };
  };
  const { token } = await context.internalAdapter.createSession(person.id);
  const signature = createHmac("sha256", SECRET).update(token).digest("base64");
  cookie = `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`;
});

afterAll(async () => {
  await database
    .delete(agentProfiles)
    .where(eq(agentProfiles.ownerUserId, person.id));
  await database
    .delete(oauthClients)
    .where(like(oauthClients.name, `%${suite}%`));
  await database.delete(users).where(eq(users.id, person.id));
  await database.$client.end({ timeout: 5 });
});

async function register() {
  const response = await call("/api/auth/oauth2/register", {
    method: "POST",
    // No application_type, exactly as Claude Code registers.
    body: JSON.stringify({
      client_name: `Claude ${suite}`,
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  expect(response.status).toBeLessThan(300);
  return (await response.json()) as { client_id: string };
}

function authorizeQuery(clientId: string, scope: string) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope,
    state: "s1",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: mcpResource(BASE),
  });
  return { query, verifier };
}

/** Register, approve on the consent screen, exchange: the tokens Claude ends up holding. */
async function connect(scope: string, registered?: { client_id: string }) {
  const { client_id } = registered ?? (await register());
  const { query, verifier } = authorizeQuery(client_id, scope);
  const authorize = await call(`/api/auth/oauth2/authorize?${query}`, {
    headers: { cookie },
  });
  const consentAt = authorize.headers.get("location") ?? "";
  expect(consentAt.startsWith(`${OAUTH_CONSENT_PAGE}?`)).toBe(true);
  const consent = await call("/api/auth/oauth2/consent", {
    method: "POST",
    headers: { cookie },
    body: JSON.stringify({
      accept: true,
      oauth_query: consentAt.split("?")[1],
    }),
  });
  const { url } = (await consent.json()) as { url: string };
  const token = await call("/api/auth/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: new URL(url).searchParams.get("code") ?? "",
      redirect_uri: REDIRECT,
      client_id,
      code_verifier: verifier,
      resource: mcpResource(BASE),
    }).toString(),
  });
  expect(token.status).toBe(200);
  return (await token.json()) as {
    access_token: string;
    refresh_token?: string;
  };
}

async function mcp(token: string, method: string, params: unknown = {}) {
  const response = await call("/api/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { result: Record<string, unknown> })
    .result;
}

const toolNames = async (token: string) =>
  ((await mcp(token, "tools/list")).tools as { name: string }[]).map(
    (tool) => tool.name,
  );

const toolText = (result: Record<string, unknown>) =>
  (result.content as { text: string }[])[0]?.text ?? "";

describe("discovery", () => {
  test("the MCP endpoint without a token points Claude at where to sign in", async () => {
    const response = await call("/api/mcp", { method: "POST", body: "{}" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      `resource_metadata="${BASE}/.well-known/oauth-protected-resource/api/mcp"`,
    );
  });

  test("protected resource metadata names this deployment's issuer", async () => {
    const response = await call(
      "/.well-known/oauth-protected-resource/api/mcp",
    );
    const metadata = (await response.json()) as Record<string, unknown>;
    expect(metadata.resource).toBe(mcpResource(BASE));
    expect(metadata.authorization_servers).toEqual([`${BASE}/api/auth`]);
  });

  test("authorization server metadata is served where MCP clients look", async () => {
    for (const path of [
      "/.well-known/oauth-authorization-server/api/auth",
      "/.well-known/oauth-authorization-server",
    ]) {
      const response = await call(path);
      expect(response.status).toBe(200);
      const metadata = (await response.json()) as Record<string, unknown>;
      expect(metadata.issuer).toBe(`${BASE}/api/auth`);
      expect(metadata.registration_endpoint).toBe(
        `${BASE}/api/auth/oauth2/register`,
      );
    }
  });

  test("somebody signed out is sent to the sign-in screen", async () => {
    const { client_id } = await register();
    const { query } = authorizeQuery(client_id, "openbot:read");
    const response = await call(`/api/auth/oauth2/authorize?${query}`);
    expect(response.status).toBe(302);
    expect(
      (response.headers.get("location") ?? "").startsWith(
        `${OAUTH_LOGIN_PAGE}?`,
      ),
    ).toBe(true);
  });
});

describe("Claude, connected", () => {
  test("a read connection sees read tools only, and acts as the person", async () => {
    const { access_token } = await connect("openbot:read");
    const names = await toolNames(access_token);
    expect(names).toContain("whoami");
    expect(names).toContain("list_bots");
    expect(names).not.toContain("create_bot");
    expect(names).not.toContain("publish_team_bot");

    const whoami = await mcp(access_token, "tools/call", {
      name: "whoami",
      arguments: {},
    });
    expect(whoami.isError).toBe(false);
    expect(toolText(whoami)).toContain(person.email);
  });

  test("a read connection cannot change anything, even through the generic tool", async () => {
    const { access_token } = await connect("openbot:read");
    const result = await mcp(access_token, "tools/call", {
      name: "openbot_api",
      arguments: {
        method: "PUT",
        path: "/api/settings/instructions",
        body: { instructions: "x" },
      },
    });
    expect(result.isError).toBe(true);
    expect(toolText(result)).toContain("look, not to change");
  });

  test("a manage connection is offered the changes, and keeps the person's own limits", async () => {
    const { access_token, refresh_token } = await connect(
      "openbot:manage offline_access",
    );
    expect(refresh_token).toBeTruthy();
    const names = await toolNames(access_token);
    expect(names).toContain("publish_team_bot");
    expect(names).toContain("set_role");

    // An ordinary member asking for an admin route gets the route's own refusal.
    const people = await mcp(access_token, "tools/call", {
      name: "list_people",
      arguments: {},
    });
    expect(people.isError).toBe(true);
    expect(toolText(people)).toContain("Only an admin");
  });

  test("sign-in, webhooks and the endpoint itself are out of reach", async () => {
    const { access_token } = await connect("openbot:manage");
    for (const path of [
      "/api/auth/oauth2/get-clients",
      "/api/mcp",
      "/health",
    ]) {
      const result = await mcp(access_token, "tools/call", {
        name: "openbot_api",
        arguments: { path },
      });
      expect(result.isError).toBe(true);
      expect(toolText(result)).toContain("not reachable");
    }
  });

  test("the token works on /api/mcp and nowhere else", async () => {
    const { access_token } = await connect("openbot:manage");
    const response = await call("/api/me", {
      headers: { authorization: `Bearer ${access_token}` },
    });
    expect(response.status).toBe(401);
  });

  test("a browser session's own JWT is refused by the MCP endpoint", async () => {
    const session = (await auth.api.getToken({
      headers: new Headers({ cookie }),
    })) as { token: string };
    const response = await call("/api/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}` },
      body: "{}",
    });
    expect(response.status).toBe(401);
  });
});

/** The refusals written since this suite began, newest first. */
async function refusals(reason: string) {
  const rows = await database
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.eventType, "mcp.token_refused"),
        gte(auditEvents.createdAt, startedAt),
      ),
    )
    .orderBy(desc(auditEvents.createdAt));
  return rows.filter((row) => row.payload.reason === reason);
}

describe("the audit trail", () => {
  test("a request with no token leaves a row that names nobody", async () => {
    const before = (await refusals("missing")).length;
    const response = await call("/api/mcp", { method: "POST", body: "{}" });
    expect(response.status).toBe(401);
    const rows = await refusals("missing");
    expect(rows.length).toBe(before + 1);
    expect(rows[0]).toMatchObject({
      targetType: "mcp_endpoint",
      targetId: "/api/mcp",
      actorUserId: null,
      initiatorKind: "deployment",
      payload: { reason: "missing", method: "POST", path: "/api/mcp" },
    });
  });

  test("a token nobody here signed leaves a row that names nobody, and never the token", async () => {
    const forged = [
      Buffer.from(JSON.stringify({ alg: "EdDSA", kid: "x" })).toString(
        "base64url",
      ),
      Buffer.from(
        JSON.stringify({ sub: person.id, azp: "claimed-client" }),
      ).toString("base64url"),
      "forged-signature",
    ].join(".");
    const before = (await refusals("invalid")).length;
    const response = await call("/api/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${forged}` },
      body: "{}",
    });
    expect(response.status).toBe(401);
    const rows = await refusals("invalid");
    expect(rows.length).toBe(before + 1);
    // What an unverified token says about itself is a claim, and is not written down.
    expect(rows[0]?.actorUserId).toBeNull();
    expect(rows[0]?.payload.oauthClient).toBeUndefined();
    expect(JSON.stringify(rows[0])).not.toContain("forged-signature");
    expect(JSON.stringify(rows[0])).not.toContain("claimed-client");
  });

  test("a read connection asked to change something is refused on the trail, by person and client", async () => {
    const registered = await register();
    const { access_token } = await connect("openbot:read", registered);
    const result = await mcp(access_token, "tools/call", {
      name: "openbot_api",
      arguments: {
        method: "PUT",
        path: "/api/settings/instructions",
        body: { instructions: "x" },
      },
    });
    expect(result.isError).toBe(true);
    const [row] = (await refusals("read_only")).filter(
      (candidate) =>
        (candidate.payload.oauthClient as { id?: string } | undefined)?.id ===
        registered.client_id,
    );
    expect(row).toMatchObject({
      actorUserId: person.id,
      initiatorKind: "person",
      payload: {
        reason: "read_only",
        method: "PUT",
        path: "/api/settings/instructions",
        oauthClient: { id: registered.client_id, name: `Claude ${suite}` },
      },
    });
    expect(JSON.stringify(row)).not.toContain(access_token);
  });

  test("somebody whose role was taken away is refused on the trail", async () => {
    const { access_token } = await connect("openbot:read");
    await database.delete(userRoles).where(eq(userRoles.userId, person.id));
    try {
      const whoami = await mcp(access_token, "tools/call", {
        name: "whoami",
        arguments: {},
      });
      expect(whoami.isError).toBe(true);
    } finally {
      await database
        .insert(userRoles)
        .values({ userId: person.id, role: "user" });
    }
    const [row] = await refusals("no_role");
    expect(row).toMatchObject({
      actorUserId: person.id,
      payload: { reason: "no_role", method: "GET", path: "/api/me" },
    });
  });

  test("a Bot created through Claude names the OAuth client on its row, on the screen's list and in the export", async () => {
    const registered = await register();
    const { access_token } = await connect("openbot:manage", registered);
    const created = await mcp(access_token, "tools/call", {
      name: "create_bot",
      arguments: {
        name: `Made by Claude ${suite}`,
        title: "Analyst",
        roleDescription: "Reads the numbers.",
      },
    });
    expect(created.isError).toBe(false);
    const botId = (JSON.parse(toolText(created)) as { agent: { id: string } })
      .agent.id;

    const [row] = await database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.eventType, "bot.created"),
          eq(auditEvents.targetId, botId),
        ),
      );
    expect(row?.actorUserId).toBe(person.id);
    expect(row?.payload.oauthClient).toEqual({
      id: registered.client_id,
      name: `Claude ${suite}`,
    });

    const reader = createAuditReader(database);
    const { events } = await reader.list({
      eventType: "bot.created",
      limit: 100,
    });
    const listed = events.find((event) => event.targetId === botId);
    expect(listed?.payload.oauthClient).toEqual({
      id: registered.client_id,
      name: `Claude ${suite}`,
    });
    expect(auditEventsToCsv(listed ? [listed] : [])).toContain(
      `Claude ${suite}`,
    );
  });

  test("the same change made in the browser names no client", async () => {
    const response = await call("/api/agents", {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({
        name: `Made by hand ${suite}`,
        title: "Analyst",
        roleDescription: "Reads the numbers.",
        visibility: "private",
      }),
    });
    expect(response.status).toBeLessThan(300);
    const { agent } = (await response.json()) as { agent: { id: string } };
    const [row] = await database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.eventType, "bot.created"),
          eq(auditEvents.targetId, agent.id),
        ),
      );
    expect(row?.actorUserId).toBe(person.id);
    expect(row?.payload.oauthClient).toBeUndefined();
  });
});
