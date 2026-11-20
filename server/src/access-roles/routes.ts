import { Hono, type MiddlewareHandler } from "hono";
import {
  type AuditEventType,
  type AuditStore,
  recordAuditEvent,
} from "../audit";
import { type AppVariables, requireAdmin } from "../auth/guards";
import {
  afterExposureChange,
  type SharedAppsAfterChange,
} from "../plugins/exposure-change";
import type { SharedUseStore } from "../plugins/shared-use-store";
import {
  type AccessRole,
  AccessRoleDeclaredError,
  AccessRoleNotFoundError,
  AccessRoleRefusedError,
  type AccessRoleStore,
} from "./store";

type AccessRoleEvent = Extract<AuditEventType, `access_role.${string}`>;

/** The Roles page's API, under /api/admin/access-roles. Every route is for admins only. */
export function createAccessRoleRoutes(
  store: AccessRoleStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  auditStore?: AuditStore,
  sharedUse?: SharedUseStore,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser);
  routes.use("*", async (context, next) => {
    const denied = requireAdmin(context);
    if (denied) return denied;
    await next();
  });
  routes.onError((error, context) => {
    if (error instanceof AccessRoleNotFoundError)
      return context.json({ error: error.message }, 404);
    if (error instanceof AccessRoleDeclaredError)
      return context.json({ error: error.message }, 409);
    if (error instanceof AccessRoleRefusedError)
      return context.json({ error: error.message }, error.taken ? 409 : 400);
    throw error;
  });

  const record = (
    actorUserId: string,
    eventType: AccessRoleEvent,
    role: Pick<AccessRole, "id" | "name">,
    payload: Record<string, unknown> = {},
  ) =>
    auditStore
      ? recordAuditEvent(auditStore, {
          eventType,
          targetType: "access_role",
          targetId: role.id,
          actorUserId,
          payload: { name: role.name, ...payload },
        })
      : Promise.resolve();

  const nameIn = async (request: Request) =>
    ((await request.json().catch(() => null)) as { name?: unknown } | null)
      ?.name;

  routes.get("/", async (context) =>
    context.json({ roles: await store.list() }),
  );

  routes.post("/", async (context) => {
    const actor = context.var.actor;
    const role = await store.create(await nameIn(context.req.raw), actor.id);
    await record(actor.id, "access_role.created", role);
    return context.json({ role }, 201);
  });

  routes.patch("/:roleId", async (context) => {
    const actor = context.var.actor;
    const before = await store.get(context.req.param("roleId"));
    const role = await store.rename(
      context.req.param("roleId"),
      await nameIn(context.req.raw),
    );
    if (before && before.name !== role.name)
      await record(actor.id, "access_role.renamed", role, {
        from: before.name,
      });
    return context.json({ role });
  });

  routes.delete("/:roleId", async (context) => {
    const role = await store.remove(context.req.param("roleId"));
    await record(context.var.actor.id, "access_role.deleted", role, {
      people: role.people.map((person) => person.id),
    });
    return context.body(null, 204);
  });

  /*
   * Adding somebody widens who reaches the role's Bots, and so who steers the shared accounts those
   * Bots use. Only an admin gets here, and an admin's change is its own approval: see
   * `afterExposureChange`. The response names what was re-approved, as publishing a Team Bot does.
   */
  routes.put("/:roleId/people/:userId", async (context) => {
    const actor = context.var.actor;
    const roleId = context.req.param("roleId");
    const userId = context.req.param("userId");
    const added = await store.addPerson(roleId, userId);
    const role = (await store.get(roleId)) as AccessRole;
    const sharedApps: ({ botId: string } & SharedAppsAfterChange)[] = [];
    if (added) {
      await record(actor.id, "access_role.person_added", role, { userId });
      for (const bot of role.bots) {
        const change = await afterExposureChange(sharedUse, actor, bot.id);
        if (change.approved.length || change.needsApproval.length)
          sharedApps.push({ botId: bot.id, ...change });
      }
    }
    return context.json({ role, sharedApps });
  });

  routes.delete("/:roleId/people/:userId", async (context) => {
    const roleId = context.req.param("roleId");
    const userId = context.req.param("userId");
    const removed = await store.removePerson(roleId, userId);
    const role = (await store.get(roleId)) as AccessRole;
    if (removed)
      await record(context.var.actor.id, "access_role.person_removed", role, {
        userId,
      });
    return context.json({ role });
  });

  return routes;
}
