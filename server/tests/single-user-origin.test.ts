import { afterAll, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { createApp } from "../src/app";
import {
  CROSS_SITE_REFUSAL,
  withLoopbackSpellings,
} from "../src/auth/browser-origin";
import { loadConfig } from "../src/config";
import { startHttpServer } from "../src/http-server";
import { testEnvironment } from "./support/environment";

/**
 * Single-user mode, asked from another site.
 *
 * With no sign-in, every request is the admin, so the request itself is the only thing that tells
 * the person's own OpenBot pages from any other page they have open. A browser marks what a page
 * sends with `Origin` and `Sec-Fetch-Site`, and the page cannot change either. A caller that is not
 * a page (the CLI, an MCP client, another server) sends neither and must still get through.
 */

const SINGLE_USER = {
  OPENBOT_SINGLE_USER: "true",
  GOOGLE_OAUTH_CLIENT_ID: undefined,
  GOOGLE_OAUTH_CLIENT_SECRET: undefined,
  BETTER_AUTH_URL: undefined,
  BETTER_AUTH_SECRET: undefined,
  INITIAL_ADMIN_EMAILS: undefined,
};
const SERVER = "http://127.0.0.1:3001";
const ATTACKER = {
  origin: "https://attacker.example",
  "sec-fetch-site": "cross-site",
};

function singleUserApp(overrides: Record<string, string | undefined> = {}) {
  return createApp(
    loadConfig(testEnvironment({ ...SINGLE_USER, ...overrides })),
  );
}

/** A state-changing route that answers 503 here: past the guard, the store is simply absent. */
const onboarding = (headers: Record<string, string>) =>
  singleUserApp().request(`${SERVER}/api/me/onboarding`, {
    method: "POST",
    headers: { "content-type": "text/plain", ...headers },
    body: "{}",
  });

describe("single-user mode refuses another site's pages", () => {
  test("a cross-site POST is refused before it reaches the route", async () => {
    const response = await onboarding(ATTACKER);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: CROSS_SITE_REFUSAL });
  });

  test("an untrusted Origin is refused even when the browser says same-site", async () => {
    const response = await onboarding({
      origin: "http://evil.localhost:3001",
      "sec-fetch-site": "same-site",
    });

    expect(response.status).toBe(403);
  });

  test("a cross-site request is refused even with no Origin", async () => {
    const response = await singleUserApp().request(`${SERVER}/api/me`, {
      headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors" },
    });

    expect(response.status).toBe(403);
  });

  test("a same-origin POST reaches the route", async () => {
    const response = await onboarding({
      origin: SERVER,
      "sec-fetch-site": "same-origin",
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Onboarding is not available.",
    });
  });

  test("the app's own pages are trusted under every loopback spelling", async () => {
    // The app is on its own port and its sockets call this one directly. TRUSTED_ORIGINS names one
    // spelling; the page may have been opened under either of the other two.
    for (const origin of [
      "http://localhost:3010",
      "http://127.0.0.1:3010",
      "http://[::1]:3010",
    ]) {
      const response = await singleUserApp({
        TRUSTED_ORIGINS: "http://localhost:3010",
      }).request(`${SERVER}/api/me`, {
        headers: { origin, "sec-fetch-site": "same-site" },
      });
      expect(response.status).toBe(200);
    }
  });

  test("a request with neither header is not from a page and gets through", async () => {
    const response = await singleUserApp().request(`${SERVER}/api/me`);

    expect(response.status).toBe(200);
    expect((await response.json()).user.role).toBe("admin");
  });

  test("a provider's redirect back to a callback is a navigation and gets through", async () => {
    const response = await singleUserApp().request(`${SERVER}/api/me`, {
      headers: {
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
      },
    });

    expect(response.status).toBe(200);
  });

  test("a deployment with sign-in is unaffected", async () => {
    const app = createApp(loadConfig(testEnvironment()));
    const response = await app.request(`${SERVER}/api/capabilities`, {
      headers: ATTACKER,
    });

    expect(response.status).toBe(200);
  });

  test("loopback origins are trusted under all three spellings, and junk is dropped", () => {
    expect(
      withLoopbackSpellings([
        "http://127.0.0.1:3010/path",
        "http://192.168.1.10:3010",
        "not an origin",
        undefined,
      ]),
    ).toEqual(
      new Set([
        "http://127.0.0.1:3010",
        "http://localhost:3010",
        "http://[::1]:3010",
        "http://192.168.1.10:3010",
      ]),
    );
  });
});

describe("single-user mode refuses another site's computer stream", () => {
  // A stand-in for agent-computer: one frame per viewer, and a count of who connected.
  let viewers = 0;
  const computer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request, server) {
      return server.upgrade(request)
        ? undefined
        : new Response("upgrade", { status: 400 });
    },
    websocket: {
      open(ws) {
        viewers++;
        ws.send("frame-of-the-bot-screen");
      },
      message() {},
    },
  });
  const actors: string[] = [];
  const front = startHttpServer({
    port: 0,
    config: loadConfig(
      testEnvironment({
        ...SINGLE_USER,
        AGENT_COMPUTER_URL: `http://127.0.0.1:${computer.port}`,
        AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS: "true",
        COMPUTER_TOKEN: "computer-token-fixture",
      }),
    ),
    resolveRequestActor: async () => {
      actors.push("dev-local-user");
      return { id: "dev-local-user", name: "dev", role: "admin" };
    },
    agentProfileStore: {
      get: async () => ({
        visibility: "private",
        ownerUserId: "dev-local-user",
      }),
    } as never,
    computerGateway: {
      locate: async () => `http://127.0.0.1:${computer.port}`,
    } as never,
    demonstrationStore: { active: async () => null } as never,
    demonstrationRecorder: {} as never,
    app: { fetch: () => new Response("the app") },
  });

  afterAll(() => {
    front.stop(true);
    computer.stop(true);
  });

  /** A raw upgrade, so the status line is readable whether or not it switches protocols. */
  function upgrade(headers: Record<string, string>) {
    return new Promise<string>((resolve, reject) => {
      const socket = connect(front.port as number, "127.0.0.1");
      let received = "";
      const done = () => {
        socket.destroy();
        resolve(received);
      };
      const timer = setTimeout(done, 1500);
      socket.on("error", reject);
      socket.on("data", (chunk) => {
        received += chunk.toString("latin1");
        if (
          !received.startsWith("HTTP/1.1 101") ||
          received.includes("frame-of")
        ) {
          clearTimeout(timer);
          done();
        }
      });
      socket.write(
        [
          "GET /api/computers/general-assistant/stream HTTP/1.1",
          `Host: 127.0.0.1:${front.port}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version: 13",
          ...Object.entries(headers).map(
            ([name, value]) => `${name}: ${value}`,
          ),
          "",
          "",
        ].join("\r\n"),
      );
    });
  }

  test("a cross-site upgrade is refused and never reaches the Bot's screen", async () => {
    const before = viewers;
    const received = await upgrade({
      Origin: ATTACKER.origin,
      "Sec-Fetch-Site": "cross-site",
      "Sec-Fetch-Mode": "websocket",
    });

    expect(received.split("\r\n")[0]).toBe("HTTP/1.1 403 Forbidden");
    expect(received).toContain(CROSS_SITE_REFUSAL);
    expect(received).not.toContain("frame-of");
    expect(actors).toEqual([]);
    expect(viewers).toBe(before);
  });

  test("the app's own page opens the stream on the server's port", async () => {
    // What the dev server and the desktop's window do: the page is on the app's port, and its
    // socket goes straight to the server's.
    const received = await upgrade({
      Origin: "http://127.0.0.1:3010",
      "Sec-Fetch-Site": "same-site",
      "Sec-Fetch-Mode": "websocket",
    });

    expect(received.split("\r\n")[0]).toBe("HTTP/1.1 101 Switching Protocols");
    expect(received).toContain("frame-of-the-bot-screen");
  });
});
