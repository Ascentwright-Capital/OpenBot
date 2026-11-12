import { expect, test } from "bun:test";
import { oauthResumePath } from "../src/lib/auth/resume";

test("an interrupted Claude sign-in resumes at this deployment's authorize endpoint", () => {
  const path = oauthResumePath(
    "?response_type=code&client_id=c1&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcb&scope=openbot%3Amanage&state=s&code_challenge=x&code_challenge_method=S256&resource=https%3A%2F%2Fbot.test%2Fapi%2Fmcp&prompt=login&exp=1&sig=abc",
  );
  expect(path?.startsWith("/api/auth/oauth2/authorize?")).toBe(true);
  const query = new URLSearchParams(path?.split("?")[1]);
  expect(query.get("client_id")).toBe("c1");
  expect(query.get("resource")).toBe("https://bot.test/api/mcp");
  expect(query.has("sig")).toBe(false);
  expect(query.has("prompt")).toBe(false);
});

test("an ordinary sign-in has nothing to resume", () => {
  expect(oauthResumePath("")).toBeNull();
  expect(oauthResumePath("?flow_id=abc")).toBeNull();
});
