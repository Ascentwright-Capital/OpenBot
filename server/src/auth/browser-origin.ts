import type { MiddlewareHandler } from "hono";
import type { DeploymentConfig } from "../config";

/**
 * Where a browser request came from, read from the headers a page cannot set for itself.
 *
 * A browser attaches `Origin` and `Sec-Fetch-Site` to what a page sends, and the page's own script
 * can change neither. A caller that is not a page (the CLI, an MCP client, another server) sends
 * neither, so these checks say nothing about it and let it through.
 */

const LOOPBACK_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "[::1]"];

/**
 * Each origin, and each loopback one under all three of its spellings.
 *
 * `localhost`, `127.0.0.1` and `[::1]` are one machine. A browser sends whichever spelling it was
 * pointed at, and the app's dev server answers on more than one, so trusting a single spelling
 * refuses the same page reached another way. A value that is not an origin is dropped.
 */
export function withLoopbackSpellings(
  origins: Iterable<string | undefined>,
): Set<string> {
  const trusted = new Set<string>();
  for (const value of origins) {
    let url: URL;
    try {
      url = new URL(value ?? "");
    } catch {
      continue;
    }
    if (url.origin === "null") continue;
    trusted.add(url.origin);
    if (!LOOPBACK_HOSTS.includes(url.hostname)) continue;
    for (const host of LOOPBACK_HOSTS)
      trusted.add(`${url.protocol}//${host}${url.port ? `:${url.port}` : ""}`);
  }
  return trusted;
}

/** Whether `origin` is the request's own origin or one of the trusted ones. */
export function isTrustedOrigin(
  request: Request,
  origin: string,
  trusted: Iterable<string>,
): boolean {
  if (origin === new URL(request.url).origin) return true;
  for (const entry of trusted) if (entry === origin) return true;
  return false;
}

/**
 * Whether a page this server trusts sent the request, or no page did.
 *
 * Origin decides when the browser sent one. Without it, a request the browser marks cross-site is
 * refused and anything else passes.
 */
export function fromTrustedPage(
  request: Request,
  trusted: Iterable<string>,
): boolean {
  const origin = request.headers.get("origin");
  return origin
    ? isTrustedOrigin(request, origin, trusted)
    : request.headers.get("sec-fetch-site") !== "cross-site";
}

/**
 * A link or a redirect opening a page, such as a provider sending somebody back to a callback.
 * It carries no body and the page that started it cannot read what comes back.
 */
function isTopLevelNavigation(request: Request) {
  return (
    (request.method === "GET" || request.method === "HEAD") &&
    request.headers.get("sec-fetch-mode") === "navigate" &&
    request.headers.get("sec-fetch-dest") === "document"
  );
}

/**
 * Whether single-user mode may answer this request.
 *
 * With no sign-in, every request is the admin and nothing in it says who sent it. Any other site the
 * person has open could otherwise act as them: post to the API, or open the live screen of a Bot.
 * So a request whose Origin is not trusted is refused, and so is one the browser marks cross-site,
 * apart from a top-level navigation. A request with neither header is not from a page and passes.
 */
export function singleUserAdmits(
  request: Request,
  trusted: Iterable<string>,
): boolean {
  const origin = request.headers.get("origin");
  if (origin && !isTrustedOrigin(request, origin, trusted)) return false;
  return (
    request.headers.get("sec-fetch-site") !== "cross-site" ||
    isTopLevelNavigation(request)
  );
}

/**
 * The pages single-user mode answers besides the server's own: where the app is served from
 * (TRUSTED_ORIGINS, or the app's local address when that is unset), OPENBOT_APP_URL, and
 * OPENBOT_PUBLIC_URL. Single-user mode refuses public addresses, so these are this machine or its
 * network.
 */
export function singleUserTrustedOrigins(
  config: Pick<DeploymentConfig, "trustedOrigins" | "appUrl" | "publicUrl">,
): Set<string> {
  return withLoopbackSpellings([
    ...config.trustedOrigins,
    config.appUrl,
    config.publicUrl,
  ]);
}

/** What a person sees when single-user mode refuses a request from another site. */
export const CROSS_SITE_REFUSAL =
  "OpenBot refused a request from another site. Open OpenBot at its own address, or add that address to TRUSTED_ORIGINS.";

/** {@link singleUserAdmits} in front of `/api`. Only ever mounted in single-user mode. */
export function createSingleUserOriginGuard(
  trusted: ReadonlySet<string>,
): MiddlewareHandler {
  return async (context, next) => {
    if (!singleUserAdmits(context.req.raw, trusted))
      return context.json({ error: CROSS_SITE_REFUSAL }, 403);
    await next();
  };
}
