/**
 * The access role rule as SQL, free of anything heavier than the schema so the profile store and the
 * runtime loader can import it without a cycle. The same shape as `teamBotAccess`.
 */
import { type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { accessRoleBots, accessRolePeople } from "../db/schema/access-roles";

/** The longest name an access role may have, on the Roles page and in agents.yaml. */
export const MAX_ACCESS_ROLE_NAME = 100;

/** Whether this person shares an access role with the Bot in `agentId`. */
export function accessRoleAccess(actorId: string, agentId: AnyPgColumn): SQL {
  return sql`exists (
    select 1 from ${accessRoleBots}
    inner join ${accessRolePeople} on ${accessRolePeople.roleId} = ${accessRoleBots.roleId}
    where ${accessRoleBots.agentId} = ${agentId}
      and ${accessRolePeople.userId} = ${actorId}
  )`;
}
