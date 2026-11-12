import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { createApp } from "../src/app";
import { createAuth } from "../src/auth";
import { createRoleRepository } from "../src/auth/guards";
import {
  mcpResource,
  OAUTH_CONSENT_PAGE,
  OAUTH_LOGIN_PAGE,
} from "../src/auth/oauth";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { jwks, oauthClients, userRoles, users } from "../src/db/schema";
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
const app = createApp(
  config,
  auth,
  roleRepository,
  ...(Array.from({ length: 35 }) as never[]),
  // The 39th argument, `oauth`. Cast like the positional padding before it.
  {
    jwks: () => auth.api.getJwks() as Promise<{ keys: unknown[] }>,
    findPerson: async (userId: string) => {
      const [row] = await database
        .select()
        .from(users)
        .where(eq(users.id, userId));
      return row
        ? {
            id: row.id,
            email: row.email,
            name: row.name,
            image: row.image,
            revoked: false,
          }
        : undefined;
    },
  } satisfies Parameters<typeof createApp>[38] as never,
);
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
async function connect(scope: string) {
  const { client_id } = await register();
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
