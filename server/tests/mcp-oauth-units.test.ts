import { describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  createOAuthTokenVerifier,
  mcpResource,
  normalizeRegistration,
  OAuthTokenError,
  oauthIssuer,
  scopesAllow,
} from "../src/auth/oauth";
import { reachable, TOOLS } from "../src/mcp/tools";

const register = (body: unknown) =>
  new Request("http://openbot.test/api/auth/oauth2/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("normalizeRegistration", () => {
  test("a client called back only on this machine registers as native", async () => {
    const request = await normalizeRegistration(
      register({ redirect_uris: ["http://localhost:6274/callback"] }),
    );
    expect(
      ((await request.json()) as Record<string, unknown>).application_type,
    ).toBe("native");
  });

  test("a web callback, or a type the client chose, is left alone", async () => {
    for (const body of [
      { redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] },
      { redirect_uris: ["http://localhost:1/cb", "https://evil.test/cb"] },
      { redirect_uris: ["http://localhost:1/cb"], application_type: "web" },
    ]) {
      const request = await normalizeRegistration(register(body));
      expect(await request.json()).toEqual(body);
    }
  });
});

describe("scopes", () => {
  test("read looks, manage changes", () => {
    expect(scopesAllow(["openbot:read"], "GET")).toBe(true);
    expect(scopesAllow(["openbot:read"], "POST")).toBe(false);
    expect(scopesAllow(["openbot:manage"], "DELETE")).toBe(true);
    expect(scopesAllow(["openid"], "GET")).toBe(false);
  });
});

describe("tools", () => {
  test("every named tool reaches an allowed path", () => {
    for (const tool of TOOLS.filter((t) => t.name !== "openbot_api")) {
      const request = tool.request({
        botId: "b1",
        userId: "u1",
        group: "Finance",
        kind: "mcp",
        ref: "r",
      });
      expect(reachable(request.path)).toBe(true);
    }
  });

  test("sign-in, webhooks, this endpoint and traversal are out of reach", () => {
    for (const path of [
      "/api/auth/oauth2/token",
      "/api/mcp",
      "/api/events/github",
      "/api/delivery/webhooks/x",
      "/api/agents/../auth/x",
      "/health",
    ]) {
      expect(reachable(path)).toBe(false);
    }
  });

  test("changes need the manage scope", () => {
    for (const tool of TOOLS) {
      if (tool.name === "openbot_api") continue;
      const method = tool.request({
        botId: "b",
        userId: "u",
        group: "g",
      }).method;
      expect(tool.access).toBe(method === "GET" ? "read" : "manage");
    }
  });
});

/*
 * What a refused token is allowed to say about itself on the audit trail: who it names and which
 * client it was issued to, but only once this deployment's own signature on it has verified.
 */
describe("why a token was refused", async () => {
  const BASE = "https://bot.test";
  const ours = await generateKeyPair("EdDSA", { extractable: true });
  const theirs = await generateKeyPair("EdDSA", { extractable: true });
  const verify = createOAuthTokenVerifier({
    baseUrl: BASE,
    jwks: async () => ({
      keys: [{ ...(await exportJWK(ours.publicKey)), kid: "k1", alg: "EdDSA" }],
    }),
  });
  const mint = (
    key: CryptoKey,
    options: { audience?: string; expiresIn?: string | number } = {},
  ) =>
    new SignJWT({ scope: "openbot:manage", azp: "client-1" })
      .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
      .setIssuer(oauthIssuer(BASE))
      .setSubject("person-1")
      .setAudience(options.audience ?? mcpResource(BASE))
      .setIssuedAt()
      .setExpirationTime(options.expiresIn ?? "1h")
      .sign(key);
  const refusal = async (token: string) => {
    try {
      await verify(token);
    } catch (error) {
      if (error instanceof OAuthTokenError) return error;
      throw error;
    }
    throw new Error("expected a refusal");
  };

  test("a good token names its person, scopes and client", async () => {
    expect(await verify(await mint(ours.privateKey))).toEqual({
      userId: "person-1",
      scopes: ["openbot:manage"],
      clientId: "client-1",
    });
  });

  test("an expired token is still one this deployment signed, so it says whose it was", async () => {
    const error = await refusal(
      await mint(ours.privateKey, {
        expiresIn: Math.floor(Date.now() / 1000) - 60,
      }),
    );
    expect(error.reason).toBe("expired");
    expect(error.proven).toEqual({ userId: "person-1", clientId: "client-1" });
  });

  test("a token for another audience says so, and whose it was", async () => {
    const error = await refusal(
      await mint(ours.privateKey, { audience: "https://elsewhere.test" }),
    );
    expect(error.reason).toBe("wrong_audience");
    expect(error.proven).toEqual({ userId: "person-1", clientId: "client-1" });
  });

  test("a token signed by anybody else proves nothing about anybody", async () => {
    const error = await refusal(await mint(theirs.privateKey));
    expect(error.reason).toBe("invalid");
    expect(error.proven).toEqual({});
  });

  test("an opaque token proves nothing either", async () => {
    const error = await refusal("not-a-jwt");
    expect(error.reason).toBe("invalid");
    expect(error.proven).toEqual({});
  });
});
