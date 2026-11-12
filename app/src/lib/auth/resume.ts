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
