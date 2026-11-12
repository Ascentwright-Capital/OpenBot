import { describe, expect, test } from "bun:test";
import { normalizeRegistration, scopesAllow } from "../src/auth/oauth";
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
