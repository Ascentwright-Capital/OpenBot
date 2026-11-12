/**
 * Where somebody goes once they are signed in, when they were sent to sign-in carrying a handle.
 *
 * This is the return half of the decision `signInUrlFor` makes on the way out (server/src/plugins/
 * routes.ts): the verifier sends a browser with no session here carrying its `flow_id`, and this is
 * what lets signing back in as the same person pick that flow up where it was left.
 *
 * THE HANDLE IS A VALUE, NEVER A DESTINATION. `flow_id` arrives in a URL and is therefore somebody
 * else's input. It is encoded into a path this code builds, on an origin this code was given. It is
 * never used as a redirect target, never concatenated into one, and there is no `next=`: a return
 * address somebody else gets a say in is an open redirect, and a handle that can only ever be a
 * query value on this deployment's own verifier cannot be pointed anywhere else.
 */

/** The route that resumes a flow. This deployment's own, on its own origin. */
const VERIFIER_PATH = "/api/plugins/arcade/verify";

/**
 * Longer than any handle the server issues, short enough that a crafted link cannot make the
 * callback URL arbitrarily large. Over the cap the value is not truncated: a truncated handle is a
 * different handle, so it is treated as no handle at all.
 */
const MAX_FLOW_ID_LENGTH = 256;

function usable(flowId: string | undefined): flowId is string {
  return (
    typeof flowId === "string" &&
    flowId.length > 0 &&
    flowId.length <= MAX_FLOW_ID_LENGTH
  );
}

/** The verifier's path with the handle as a query value, or null when there is no usable handle. */
export function verifierPathFor(flowId: string | undefined): string | null {
  return usable(flowId)
    ? `${VERIFIER_PATH}?flow_id=${encodeURIComponent(flowId)}`
    : null;
}

/**
 * Where sign-in should send the browser back to: the verifier carrying the handle, or the origin
 * itself when there is none. Pure, so the resume is pinned without a DOM, a router or Better Auth.
 */
export function resumeUrlFor(
  origin: string,
  flowId: string | undefined,
): string {
  const path = verifierPathFor(flowId);
  return path === null ? origin : `${origin}${path}`;
}

/**
 * The OAuth authorization request this sign-in interrupted, to send the browser back to once signed in.
 *
 * When Claude (or another MCP client) asks this deployment to authorize somebody who is not signed
 * in, the server sends them here with the request's own parameters on the query string. After
 * sign-in the request is simply made again, now with a session, and continues to the consent screen.
 *
 * Only the standard authorization parameters are carried, and only to this deployment's own
 * authorize endpoint: never an address taken from the query. The signature the server added for its
 * own use is dropped, and so is `prompt`, which would ask for sign-in again and loop.
 */
const OAUTH_AUTHORIZE_PATH = "/api/auth/oauth2/authorize";
const OAUTH_PARAMS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "scope",
  "state",
  "code_challenge",
  "code_challenge_method",
  "resource",
  "nonce",
] as const;

export function oauthResumePath(search: string): string | null {
  const incoming = new URLSearchParams(search);
  if (!incoming.get("client_id") || !incoming.get("response_type")) {
    return null;
  }
  const carried = new URLSearchParams();
  for (const name of OAUTH_PARAMS) {
    for (const value of incoming.getAll(name)) carried.append(name, value);
  }
  return `${OAUTH_AUTHORIZE_PATH}?${carried.toString()}`;
}
