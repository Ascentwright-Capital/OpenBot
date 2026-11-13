import { eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { withAuditOAuthClient } from "../audit";
import type { Database } from "../db/client";
import { userRoles } from "../db/schema";
import { OAuthTokenError, type TokenRefusal } from "./oauth";
import type { OpenBotRole } from "./roles";

export type AuthenticatedActor = {
  id: string;
  email: string;
  name?: string | null;
  image?: string | null;
  role: OpenBotRole;
};

export type AuthService = {
  handler: (request: Request) => Response | Promise<Response>;
  api: {
    getSession: (input: {
      headers: Headers;
      query?: { disableCookieCache: boolean };
    }) => Promise<{
      user: {
        id: string;
        email: string;
        name?: string | null;
        image?: string | null;
        /** Set only by a server-verified organization authority. */
        role?: OpenBotRole;
      };
    } | null>;
  };
};

export type RoleRepository = {
  rolesForUser: (userId: string) => Promise<OpenBotRole[]>;
};

export type AppVariables = {
  actor: AuthenticatedActor;
};

export function createRoleRepository(database: Database): RoleRepository {
  return {
    rolesForUser: async (userId) => {
      const records = await database
        .select({ role: userRoles.role })
        .from(userRoles)
        .where(eq(userRoles.userId, userId));

      return records.map((record) => record.role);
    },
  };
}

/**
 * How a call the MCP endpoint makes on somebody's behalf is admitted. See `mcp/`.
 *
 * Only for requests carrying the process's own `secret` in {@link INTERNAL_CALL_HEADER}, which only
 * the MCP endpoint sets, on requests it hands straight to this app in memory. A token presented to
 * any `/api` route from outside is ignored here, so the one place a Claude token works is
 * `/api/mcp`, and what it reaches through there is the same route, the same checks and the same
 * audit rows as the person's own browser.
 */
export const INTERNAL_CALL_HEADER = "x-openbot-mcp-call";

export type InternalBearer = {
  secret: string;
  /** Who a verified token names, and with which scopes. Throws when it is not good. */
  verify: (
    token: string,
  ) => Promise<{ userId: string; scopes: string[]; clientId?: string }>;
  findPerson: (userId: string) => Promise<
    | {
        id: string;
        email: string;
        name: string | null;
        image: string | null;
        revoked: boolean;
      }
    | undefined
  >;
  /** Whether these scopes may make a request with this method. */
  allows: (scopes: readonly string[], method: string) => boolean;
  /** What the OAuth client called itself when it registered, for the audit trail. */
  clientName?: (clientId: string) => Promise<string | undefined>;
  /** Told about every call refused here, so it reaches the audit trail. Must not throw. */
  refused?: (refusal: TokenRefusal) => Promise<void>;
};

function bearerOf(context: Context) {
  const header = context.req.header("authorization") ?? "";
  return header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : undefined;
}

function sameSecret(a: string | undefined, b: string) {
  if (!a || a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

export function createRequireUser(
  auth: AuthService,
  roleRepository: RoleRepository,
  internalBearer?: InternalBearer,
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (context, next) => {
    const token = bearerOf(context);
    if (
      internalBearer &&
      token &&
      sameSecret(
        context.req.header(INTERNAL_CALL_HEADER),
        internalBearer.secret,
      )
    ) {
      let identity: { userId: string; scopes: string[]; clientId?: string };
      const refused = (refusal: Omit<TokenRefusal, "method" | "path">) =>
        internalBearer.refused?.({
          ...refusal,
          method: context.req.method,
          path: context.req.path,
        });
      try {
        identity = await internalBearer.verify(token);
      } catch (error) {
        await refused(
          error instanceof OAuthTokenError
            ? { reason: error.reason, ...error.proven }
            : { reason: "invalid" },
        );
        return context.json({ error: "Authentication required." }, 401);
      }
      const proven = {
        userId: identity.userId,
        ...(identity.clientId ? { clientId: identity.clientId } : {}),
      };
      if (!internalBearer.allows(identity.scopes, context.req.method)) {
        await refused({ reason: "read_only", ...proven });
        return context.json(
          {
            error:
              "Claude was connected to look, not to change. Reconnect it with permission to manage.",
          },
          403,
        );
      }
      const person = await internalBearer.findPerson(identity.userId);
      const roles =
        person && !person.revoked
          ? await roleRepository.rolesForUser(person.id)
          : [];
      const role = roles.includes("admin")
        ? "admin"
        : roles.includes("user")
          ? "user"
          : undefined;
      if (!person || !role) {
        await refused({
          reason: !person || person.revoked ? "person_removed" : "no_role",
          ...proven,
        });
        return context.json({ error: "Authorization required." }, 403);
      }
      context.set("actor", {
        id: person.id,
        email: person.email,
        name: person.name,
        image: person.image,
        role,
      });
      if (!identity.clientId) {
        await next();
        return;
      }
      // Every audit row written while this request is handled says which client it came through.
      const name = await internalBearer.clientName?.(identity.clientId);
      await withAuditOAuthClient(
        { id: identity.clientId, ...(name ? { name } : {}) },
        () => next(),
      );
      return;
    }

    const session = await auth.api.getSession({
      headers: context.req.raw.headers,
      query: { disableCookieCache: true },
    });

    if (!session) {
      return context.json({ error: "Authentication required." }, 401);
    }

    const roles = session.user.role
      ? [session.user.role]
      : await roleRepository.rolesForUser(session.user.id);
    const role = roles.includes("admin")
      ? "admin"
      : roles.includes("user")
        ? "user"
        : undefined;

    if (!role) {
      return context.json({ error: "Authorization required." }, 403);
    }

    context.set("actor", {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      image: session.user.image,
      role,
    });
    await next();
  };
}

export function requireAdmin(context: Context<{ Variables: AppVariables }>) {
  if (context.var.actor.role !== "admin") {
    return context.json({ error: "Only an admin can do this." }, 403);
  }

  return undefined;
}
