import { oauthProvider } from "@better-auth/oauth-provider";
import { jwt } from "better-auth/plugins";
import { createLocalJWKSet, errors, type JWTPayload, jwtVerify } from "jose";

/**
 * OpenBot as an OAuth authorization server, for exactly one resource: the MCP endpoint.
 *
 * WHY. Claude (claude.ai, the Claude app, Claude Code) manages OpenBot through `/api/mcp`. A
 * connector in claude.ai can only reach a remote MCP server through OAuth, so this deployment issues
 * the tokens itself: somebody adds the connector, signs in here with the same identity provider as
 * always, approves on the consent screen, and every tool call afterwards runs as them.
 *
 * WHAT A TOKEN IS. A JWT signed by the `jwt` plugin, whose audience is the MCP resource and whose
 * subject is the person. It carries one of two OpenBot scopes:
 *
 * - `openbot:read`: look, never change.
 * - `openbot:manage`: also change, within what that person may already change. A scope never adds a
 *   permission: an ordinary member with `openbot:manage` still cannot publish somebody else's Bot.
 *
 * REGISTRATION IS OPEN, because MCP clients register themselves (RFC 7591) and claude.ai cannot be
 * given a client id in advance. Open registration is safe only because it grants nothing on its own:
 * every token still needs a signed-in person of this deployment to approve that client by name on the
 * consent screen, and the redirect it goes back to is shown there.
 */

/** The two scopes OpenBot defines. Everything else on the list is the OIDC baseline. */
export const OPENBOT_READ_SCOPE = "openbot:read";
export const OPENBOT_MANAGE_SCOPE = "openbot:manage";

export const OAUTH_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  OPENBOT_READ_SCOPE,
  OPENBOT_MANAGE_SCOPE,
] as const;

/** Where the browser is sent to sign in, and to approve. Both are app routes. */
export const OAUTH_LOGIN_PAGE = "/sign";
export const OAUTH_CONSENT_PAGE = "/connect/consent";

/** Better Auth's mount point, which makes the issuer `<origin>/api/auth`. */
const AUTH_BASE_PATH = "/api/auth";
export const MCP_PATH = "/api/mcp";

export function oauthIssuer(baseUrl: string): string {
  return `${trimSlash(baseUrl)}${AUTH_BASE_PATH}`;
}

/** The resource identifier (RFC 8707) every MCP token is issued for. */
export function mcpResource(baseUrl: string): string {
  return `${trimSlash(baseUrl)}${MCP_PATH}`;
}

function trimSlash(value: string) {
  return value.replace(/\/+$/, "");
}

/**
 * The two Better Auth plugins, configured.
 *
 * `isAdmin` decides the client CRUD endpoints (`/oauth2/create-client` and friends). Self-registration
 * goes through `/oauth2/register` and does not ask it; the endpoints that list, edit or delete a
 * registered client are an administrator's.
 */
export function oauthPlugins(input: {
  baseUrl: string;
  isAdmin: (userId: string) => Promise<boolean>;
}) {
  const resource = mcpResource(input.baseUrl);
  const issuer = oauthIssuer(input.baseUrl);

  return [
    jwt({
      // The session endpoint would otherwise hand every browser a JWT on each read. Nothing uses it,
      // and a token nobody asked for is a token that can leak.
      disableSettingJwtHeader: true,
      jwt: { issuer },
    }),
    oauthProvider({
      loginPage: OAUTH_LOGIN_PAGE,
      consentPage: OAUTH_CONSENT_PAGE,
      scopes: [...OAUTH_SCOPES],
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      // Every self-registered client may ask for the one resource there is, and nothing else.
      clientRegistrationDefaultResources: [resource],
      resources: [
        {
          identifier: resource,
          name: "OpenBot",
          allowedScopes: [...OAUTH_SCOPES],
        },
      ],
      // An hour, so a person removed from the deployment loses Claude's access within one; the
      // refresh token is what keeps a connector working, and it is refused for a removed person.
      accessTokenExpiresIn: 60 * 60,
      clientPrivileges: async ({ action, user }) => {
        if (action === "create") return Boolean(user);
        return user ? input.isAdmin(user.id) : false;
      },
    }),
  ];
}

export type OAuthIdentity = {
  userId: string;
  scopes: string[];
  clientId: string | undefined;
};

/**
 * Why a token presented to `/api/mcp` was turned away, as the audit trail records it.
 *
 * The first five are the endpoint's own (mcp/server.ts). The last three are the request guard's,
 * for a token that was good and still could not make the call (auth/guards.ts).
 */
export type TokenRefusalReason =
  | "missing"
  | "invalid"
  | "expired"
  | "wrong_audience"
  | "no_openbot_scope"
  | "read_only"
  | "person_removed"
  | "no_role";

/** One refusal, for the trail. Never the token. */
export type TokenRefusal = {
  reason: TokenRefusalReason;
  /** Who the token names, only when this deployment's own signature on it verified. */
  userId?: string;
  /** The OAuth client the token was issued to, on the same condition. */
  clientId?: string;
  method: string;
  path: string;
};

export class OAuthTokenError extends Error {
  constructor(
    message: string,
    readonly reason: Extract<
      TokenRefusalReason,
      "invalid" | "expired" | "wrong_audience"
    > = "invalid",
    /** What the token says about itself, present only when its signature verified. */
    readonly proven: { userId?: string; clientId?: string } = {},
  ) {
    super(message);
  }
}

function clientOf(payload: JWTPayload): string | undefined {
  return typeof payload.azp === "string"
    ? payload.azp
    : typeof payload.client_id === "string"
      ? payload.client_id
      : undefined;
}

/**
 * Check an access token presented to the MCP endpoint, locally.
 *
 * Signature against this deployment's own keys, issuer, audience (the MCP resource and nothing else:
 * a JWT minted for any other audience is refused) and expiry. Opaque tokens, which the provider
 * issues when a client asks for no resource, are refused as well, because they were not issued for
 * this endpoint.
 */
export function createOAuthTokenVerifier(input: {
  baseUrl: string;
  jwks: () => Promise<{ keys: unknown[] }>;
}) {
  const issuer = oauthIssuer(input.baseUrl);
  const audience = mcpResource(input.baseUrl);

  return async (token: string): Promise<OAuthIdentity> => {
    if (token.split(".").length !== 3) {
      throw new OAuthTokenError("This token was not issued for OpenBot.");
    }
    const keys = createLocalJWKSet(
      (await input.jwks()) as Parameters<typeof createLocalJWKSet>[0],
    );
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, keys, { issuer, audience }));
    } catch (failure) {
      /*
       * jose checks the signature first and the claims after, and a claim failure carries the
       * payload it read. So an expired token, or one for another audience, is still one this
       * deployment signed, and who it names is known. Anything else proves nothing about anybody.
       */
      const claims =
        failure instanceof errors.JWTExpired ||
        failure instanceof errors.JWTClaimValidationFailed
          ? failure
          : undefined;
      const proven = claims
        ? {
            ...(typeof claims.payload.sub === "string" && claims.payload.sub
              ? { userId: claims.payload.sub }
              : {}),
            ...(clientOf(claims.payload)
              ? { clientId: clientOf(claims.payload) }
              : {}),
          }
        : {};
      throw new OAuthTokenError(
        "This token is invalid or has expired.",
        failure instanceof errors.JWTExpired
          ? "expired"
          : claims?.claim === "aud"
            ? "wrong_audience"
            : "invalid",
        proven,
      );
    }
    if (typeof payload.sub !== "string" || !payload.sub) {
      const clientId = clientOf(payload);
      throw new OAuthTokenError(
        "This token names nobody.",
        "invalid",
        clientId ? { clientId } : {},
      );
    }
    const scope = typeof payload.scope === "string" ? payload.scope : "";
    return {
      userId: payload.sub,
      scopes: scope.split(" ").filter(Boolean),
      clientId: clientOf(payload),
    };
  };
}

/** Whether these scopes may make a request with this method. */
export function scopesAllow(scopes: readonly string[], method: string) {
  if (scopes.includes(OPENBOT_MANAGE_SCOPE)) return true;
  const reading = method === "GET" || method === "HEAD";
  return reading && scopes.includes(OPENBOT_READ_SCOPE);
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Mark a self-registration whose every callback is on this machine as a native app.
 *
 * Claude Code (and most desktop MCP clients) register with `http://localhost:<port>/callback` and
 * send no `application_type`. RFC 7591 defaults that to `web`, and the provider rightly refuses a web
 * client a plain-http loopback callback, so Claude Code could never connect. A client that can only
 * be called back on the person's own machine is a native app by RFC 8252's definition, which is the
 * type that permits exactly those callbacks and nothing wider.
 *
 * Anything else passes through untouched, including a registration that names its own type.
 */
export async function normalizeRegistration(
  request: Request,
): Promise<Request> {
  const { pathname } = new URL(request.url);
  if (request.method !== "POST" || !pathname.endsWith("/oauth2/register")) {
    return request;
  }
  const body = (await request
    .clone()
    .json()
    .catch(() => null)) as Record<string, unknown> | null;
  if (!body || body.application_type !== undefined) return request;
  const uris = body.redirect_uris;
  const loopbackOnly =
    Array.isArray(uris) &&
    uris.length > 0 &&
    uris.every((uri) => {
      if (typeof uri !== "string") return false;
      try {
        const url = new URL(uri);
        return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
      } catch {
        return false;
      }
    });
  if (!loopbackOnly) return request;
  return new Request(request, {
    body: JSON.stringify({ ...body, application_type: "native" }),
  });
}
