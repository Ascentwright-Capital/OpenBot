import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Database } from "../db/client";
import { agents, users } from "../db/schema";
import {
  accessRoleBots,
  accessRolePeople,
  accessRoles,
} from "../db/schema/access-roles";
import { PACKAGE_GRANT } from "../tenant-package";
import { MAX_ACCESS_ROLE_NAME } from "./access";

export type AccessRole = {
  id: string;
  name: string;
  /** agents.yaml names it, so it is renamed and deleted there. */
  declared: boolean;
  people: { id: string; email: string; name: string | null }[];
  bots: { id: string; name: string; fromAgentsYaml: boolean }[];
};

/** A request the admin can fix: an empty or taken name. `taken` is a 409, anything else a 400. */
export class AccessRoleRefusedError extends Error {
  constructor(
    message: string,
    readonly taken = false,
  ) {
    super(message);
    this.name = "AccessRoleRefusedError";
  }
}

export class AccessRoleDeclaredError extends Error {
  constructor() {
    super("agents.yaml names this access role. Rename or remove it there.");
    this.name = "AccessRoleDeclaredError";
  }
}

export class AccessRoleNotFoundError extends Error {
  constructor(message = "That access role doesn't exist.") {
    super(message);
    this.name = "AccessRoleNotFoundError";
  }
}

/** The trimmed name, or a refusal saying what is wrong with it. */
export function accessRoleName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name) throw new AccessRoleRefusedError("Name the access role.");
  if (name.length > MAX_ACCESS_ROLE_NAME)
    throw new AccessRoleRefusedError(
      `An access role name can be at most ${MAX_ACCESS_ROLE_NAME} characters.`,
    );
  return name;
}

/** Bun's driver puts the SQLSTATE in `errno`; drizzle wraps the driver error as `cause`. */
function isUniqueViolation(error: unknown): boolean {
  type Driver = { errno?: unknown };
  return [
    error as Driver | null | undefined,
    (error as { cause?: Driver } | null | undefined)?.cause,
  ].some((candidate) => candidate?.errno === "23505");
}

export function createAccessRoleStore(database: Database) {
  async function read(ids?: string[]): Promise<AccessRole[]> {
    const rows = await database
      .select({ id: accessRoles.id, name: accessRoles.name })
      .from(accessRoles)
      .where(ids ? inArray(accessRoles.id, ids) : undefined)
      .orderBy(asc(accessRoles.name));
    if (!rows.length) return [];
    const roleIds = rows.map((row) => row.id);
    const [people, bots] = await Promise.all([
      database
        .select({
          roleId: accessRolePeople.roleId,
          id: users.id,
          email: users.email,
          name: users.name,
        })
        .from(accessRolePeople)
        .innerJoin(users, eq(users.id, accessRolePeople.userId))
        .where(inArray(accessRolePeople.roleId, roleIds))
        .orderBy(asc(users.email)),
      database
        .select({
          roleId: accessRoleBots.roleId,
          id: agents.id,
          name: agents.name,
          grantedBy: accessRoleBots.grantedBy,
        })
        .from(accessRoleBots)
        .innerJoin(agents, eq(agents.id, accessRoleBots.agentId))
        .where(inArray(accessRoleBots.roleId, roleIds))
        .orderBy(asc(agents.name)),
    ]);
    return rows.map((row) => {
      const roleBots = bots.filter((bot) => bot.roleId === row.id);
      return {
        id: row.id,
        name: row.name,
        declared: roleBots.some((bot) => bot.grantedBy === PACKAGE_GRANT),
        people: people
          .filter((member) => member.roleId === row.id)
          .map(({ id, email, name }) => ({ id, email, name })),
        bots: roleBots.map(({ id, name, grantedBy }) => ({
          id,
          name,
          fromAgentsYaml: grantedBy === PACKAGE_GRANT,
        })),
      };
    });
  }

  async function get(id: string) {
    return (await read([id]))[0] ?? null;
  }

  async function existing(id: string) {
    const role = await get(id);
    if (!role) throw new AccessRoleNotFoundError();
    return role;
  }

  const taken = (name: string) =>
    new AccessRoleRefusedError(
      `There's already an access role called ${name}.`,
      true,
    );

  return {
    list: () => read(),
    get,

    async create(rawName: unknown, createdBy: string): Promise<AccessRole> {
      const name = accessRoleName(rawName);
      const id = randomUUID();
      try {
        await database.insert(accessRoles).values({ id, name, createdBy });
      } catch (error) {
        if (isUniqueViolation(error)) throw taken(name);
        throw error;
      }
      return existing(id);
    },

    async rename(id: string, rawName: unknown): Promise<AccessRole> {
      const name = accessRoleName(rawName);
      if ((await existing(id)).declared) throw new AccessRoleDeclaredError();
      try {
        await database
          .update(accessRoles)
          .set({ name })
          .where(eq(accessRoles.id, id));
      } catch (error) {
        if (isUniqueViolation(error)) throw taken(name);
        throw error;
      }
      return existing(id);
    },

    /** People and Bots leave it with it: the foreign keys cascade. */
    async remove(id: string): Promise<AccessRole> {
      const role = await existing(id);
      if (role.declared) throw new AccessRoleDeclaredError();
      await database.delete(accessRoles).where(eq(accessRoles.id, id));
      return role;
    },

    /** Whether this added them; false when they were already in it. */
    async addPerson(id: string, userId: string): Promise<boolean> {
      await existing(id);
      const [person] = await database
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!person)
        throw new AccessRoleNotFoundError(
          "That person hasn't signed in to OpenBot yet.",
        );
      const added = await database
        .insert(accessRolePeople)
        .values({ roleId: id, userId })
        .onConflictDoNothing()
        .returning({ userId: accessRolePeople.userId });
      return added.length > 0;
    },

    /** Whether this removed them; false when they were not in it. */
    async removePerson(id: string, userId: string): Promise<boolean> {
      await existing(id);
      const removed = await database
        .delete(accessRolePeople)
        .where(
          and(
            eq(accessRolePeople.roleId, id),
            eq(accessRolePeople.userId, userId),
          ),
        )
        .returning({ userId: accessRolePeople.userId });
      return removed.length > 0;
    },
  };
}

export type AccessRoleStore = ReturnType<typeof createAccessRoleStore>;
