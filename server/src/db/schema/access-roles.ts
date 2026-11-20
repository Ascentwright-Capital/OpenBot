/**
 * Access roles: named sets of people and Bots (AP-280, D-86).
 *
 * A person may use a Bot that is not open to everyone when they share an access role with it. Not
 * `user_roles`, which holds the admin and user account types, and not `users.groups`, which only a
 * SCIM directory writes and would overwrite.
 */
import { sql } from "drizzle-orm";
import {
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { agents, users } from "./core";

const at = (name: string) =>
  timestamp(name, { withTimezone: true }).notNull().defaultNow();

export const accessRoles = pgTable(
  "access_roles",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** Null when agents.yaml named it first. */
    createdBy: text("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: at("created_at"),
  },
  (table) => [
    uniqueIndex("access_roles_name_key").on(sql`lower(${table.name})`),
  ],
);

export const accessRolePeople = pgTable(
  "access_role_people",
  {
    roleId: text("role_id")
      .notNull()
      .references(() => accessRoles.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    addedAt: at("added_at"),
  },
  (table) => [
    primaryKey({ columns: [table.roleId, table.userId] }),
    index("access_role_people_user_idx").on(table.userId),
  ],
);

export const accessRoleBots = pgTable(
  "access_role_bots",
  {
    roleId: text("role_id")
      .notNull()
      .references(() => accessRoles.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** `tenant-package` for a row agents.yaml wrote; a redeploy rewrites only those. */
    grantedBy: text("granted_by").notNull(),
    addedAt: at("added_at"),
  },
  (table) => [
    primaryKey({ columns: [table.roleId, table.agentId] }),
    index("access_role_bots_agent_idx").on(table.agentId),
  ],
);
