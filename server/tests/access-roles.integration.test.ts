import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { Hono, type MiddlewareHandler } from "hono";
import {
  AccessRoleDeclaredError,
  AccessRoleRefusedError,
  createAccessRoleStore,
} from "../src/access-roles/store";
import { createAccessRoleRoutes } from "../src/access-roles/routes";
import { computerAccessCheck } from "../src/agents/computer-access";
import { canAccessAgent } from "../src/agents/profile-policy";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import { createRuntimeAgentLoader } from "../src/agents/runtime-agents";
import { createAuditStore } from "../src/audit";
import type { AppVariables } from "../src/auth/guards";
import { createDatabase } from "../src/db/client";
import {
  accessRoles,
  agentProfiles,
  agents,
  auditEvents,
  deploymentPackages,
  mcpServers,
  mcpTools,
  pluginGrants,
  users,
} from "../src/db/schema";
import { exposureOf } from "../src/plugins/shared-use";
import { createSharedUseStore } from "../src/plugins/shared-use-store";
import {
  type LoadedTenantPackage,
  synchronizeTenantPackage,
  validateTenantPackage,
} from "../src/tenant-package";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * AP-280: access roles. People and Bots share a role; a Bot that is not open to everyone is used
 * only by the people in its roles, and by admins. Needs a database at the current TS schema.
 */
const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const profiles = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const roles = createAccessRoleStore(database);
const auditStore = createAuditStore(database);
const sharedUse = createSharedUseStore(database, "composio");
const suite = randomUUID().slice(0, 8);
const createdUsers: string[] = [];
const createdAgents: string[] = [];
const createdTenants: string[] = [];
const createdRoleNames: string[] = [];
const createdServers: string[] = [];

afterEach(async () => {
  for (const id of createdServers.splice(0))
    await database.delete(mcpServers).where(eq(mcpServers.id, id));
  if (createdRoleNames.length) {
    await database
      .delete(accessRoles)
      .where(inArray(accessRoles.name, createdRoleNames.splice(0)));
  }
  const agentIds = createdAgents.splice(0);
  if (agentIds.length) {
    await database
      .delete(agentProfiles)
      .where(inArray(agentProfiles.agentId, agentIds));
    await database.delete(agents).where(inArray(agents.id, agentIds));
  }
  for (const tenantId of createdTenants.splice(0)) {
    await database
      .delete(deploymentPackages)
      .where(eq(deploymentPackages.tenantId, tenantId));
  }
  // Audit rows are append-only, so they stay: each test's actor ids are unique to this run.
  const userIds = createdUsers.splice(0);
  if (userIds.length)
    await database.delete(users).where(inArray(users.id, userIds));
});
afterAll(async () => {
  await database.$client.close();
});

async function person(
  role: AgentActor["role"] = "user",
): Promise<AgentActor & { email: string }> {
  const id = `access-roles-${suite}-${randomUUID()}`;
  const email = `${id}@example.test`;
  await database.insert(users).values({ id, email, name: "Access Role Test" });
  createdUsers.push(id);
  return { id, role, email };
}

function roleName(label: string) {
  const name = `${label} ${suite} ${randomUUID().slice(0, 6)}`;
  createdRoleNames.push(name);
  return name;
}

type PackageAgent = LoadedTenantPackage["agents"][number];

function coworker(overrides: Partial<PackageAgent> = {}): PackageAgent {
  const agent: PackageAgent = {
    id: `access-roles-${suite}-${randomUUID()}`,
    name: "00-20 Recruitment",
    title: "People and talent",
    roleDescription: "Runs hiring.",
    type: "built_in",
    configuration: { systemPrompt: "Help with hiring." },
    skills: [],
    accessRoles: [],
    openToEveryone: true,
    ...overrides,
  };
  createdAgents.push(agent.id);
  return agent;
}

/** One tenant, deployed as many times as a test needs, like a merge to main redeploys it. */
function tenant() {
  const tenantId = `access-roles-${suite}-${randomUUID()}`;
  createdTenants.push(tenantId);
  return (...packageAgents: PackageAgent[]) =>
    synchronizeTenantPackage(database, {
      tenantId,
      productName: "Access Role Test",
      stylesheet: null,
      agents: packageAgents,
      omittedAgentIds: [],
      channels: [],
      model: {
        provider: "openai",
        credentialSecretRef: "openai-key",
        defaultModel: "gpt-5.6-terra",
      },
      knowledgeSources: [],
      skills: [],
      themeCss: "",
      sourcePath: `/test/${randomUUID()}`,
      checksum: randomUUID(),
    });
}

async function roleNamed(name: string) {
  const found = (await roles.list()).find((role) => role.name === name);
  if (!found) throw new Error(`Expected an access role called ${name}.`);
  return found;
}

const agentsYaml = (agent: string) =>
  validateTenantPackage({
    brand: "tenant: { id: fintech, product_name: Ledgerline }",
    agents: `agents: [${agent}]`,
    channels: "channels: []",
    model:
      "model: { provider: openai, credential_secret_ref: openai-key, default_model: gpt-5.6-terra }",
    knowledge: "sources: []",
    themeCss: "",
  }).agents[0];

const recruitment =
  "id: recruitment, name: Recruitment, title: Hiring, role_description: Runs hiring., type: built-in, system_prompt: Help with hiring.";

describe("access roles in agents.yaml", () => {
  test("a coworker names its access roles and whether it is open to everyone", () => {
    const agent = agentsYaml(
      `{ ${recruitment}, access_roles: [People team, Founders], open_to_everyone: false }`,
    );
    expect(agent?.accessRoles).toEqual(["People team", "Founders"]);
    expect(agent?.openToEveryone).toBe(false);
  });

  test("a coworker without the fields is open to everyone and in no access role", () => {
    const agent = agentsYaml(`{ ${recruitment} }`);
    expect(agent?.accessRoles).toEqual([]);
    expect(agent?.openToEveryone).toBe(true);
  });

  test("the same access role twice, in any case, is refused", () => {
    expect(() =>
      agentsYaml(`{ ${recruitment}, access_roles: [Founders, founders] }`),
    ).toThrow('agent "recruitment" names access role "founders" twice');
  });

  test("open_to_everyone must be true or false", () => {
    expect(() =>
      agentsYaml(`{ ${recruitment}, open_to_everyone: "no" }`),
    ).toThrow("agent.open_to_everyone must be true or false");
  });
});

describe("who may use a coworker limited to access roles", () => {
  test("only the people in its access roles, and admins, on every path", async () => {
    const name = roleName("People team");
    const bot = coworker({ accessRoles: [name], openToEveryone: false });
    await tenant()(bot);
    const admin = await person("admin");
    const member = await person();
    const outsider = await person();
    await roles.addPerson((await roleNamed(name)).id, member.id);

    // The Bot list and every single-Bot check (hand-offs, Slack, routines) ask the profile store.
    expect(await profiles.get(member, bot.id)).not.toBeNull();
    expect(await profiles.get(admin, bot.id)).not.toBeNull();
    expect(await profiles.get(outsider, bot.id)).toBeNull();
    expect((await profiles.list(outsider)).map(({ id }) => id)).not.toContain(
      bot.id,
    );

    // What a person may run.
    const runnable = createRuntimeAgentLoader(database);
    expect((await runnable(member)).map(({ id }) => id)).toContain(bot.id);
    expect((await runnable(outsider)).map(({ id }) => id)).not.toContain(
      bot.id,
    );

    // The coworker router filters the list again in memory, and must keep the Bot.
    const seen = await profiles.get(member, bot.id);
    expect(seen && canAccessAgent(member, seen)).toBe(true);

    // A coworker from agents.yaml has no owner's browser to protect, so its people share its computer.
    const mayUseComputer = computerAccessCheck(profiles);
    expect(await mayUseComputer(member, bot.id)).toBe(true);
    expect(await mayUseComputer(outsider, bot.id)).toBe(false);
  });

  test("leaving the access role takes the Bot away", async () => {
    const name = roleName("Founders");
    const bot = coworker({ accessRoles: [name], openToEveryone: false });
    await tenant()(bot);
    const member = await person();
    const role = await roleNamed(name);
    await roles.addPerson(role.id, member.id);
    expect(await profiles.get(member, bot.id)).not.toBeNull();

    await roles.removePerson(role.id, member.id);
    expect(await profiles.get(member, bot.id)).toBeNull();
  });

  test("a coworker without the new fields behaves exactly as today", async () => {
    const bot = coworker();
    await tenant()(bot);
    const outsider = await person();

    expect(await profiles.get(outsider, bot.id)).toMatchObject({
      visibility: "public",
    });
  });

  test("a coworker in an access role but open to everyone stays open to everyone", async () => {
    const bot = coworker({ accessRoles: [roleName("Marketing")] });
    await tenant()(bot);
    const outsider = await person();

    expect(await profiles.get(outsider, bot.id)).not.toBeNull();
  });
});

describe("a redeploy and the people an admin added", () => {
  test("a redeploy keeps the people in an access role", async () => {
    const name = roleName("People team");
    const bot = coworker({ accessRoles: [name], openToEveryone: false });
    const deploy = tenant();
    await deploy(bot);
    const member = await person();
    await roles.addPerson((await roleNamed(name)).id, member.id);

    await deploy(bot);

    expect(await profiles.get(member, bot.id)).not.toBeNull();
    expect((await roleNamed(name)).people.map(({ id }) => id)).toEqual([
      member.id,
    ]);
  });

  test("a coworker agents.yaml opens again is open to everyone, and leaves its access roles", async () => {
    const name = roleName("People team");
    const bot = coworker({ accessRoles: [name], openToEveryone: false });
    const deploy = tenant();
    await deploy(bot);
    const outsider = await person();
    expect(await profiles.get(outsider, bot.id)).toBeNull();

    await deploy({ ...bot, accessRoles: [], openToEveryone: true });

    expect(await profiles.get(outsider, bot.id)).not.toBeNull();
    const role = await roleNamed(name);
    expect(role.bots).toEqual([]);
    expect(role.declared).toBe(false);
  });
});

describe("managing access roles", () => {
  test("names are unique whatever their case", async () => {
    const admin = await person("admin");
    const name = roleName("Cilook");
    await roles.create(name, admin.id);

    await expect(roles.create(name.toUpperCase(), admin.id)).rejects.toThrow(
      AccessRoleRefusedError,
    );
  });

  test("an access role agents.yaml names can't be renamed or deleted here", async () => {
    const name = roleName("People team");
    await tenant()(coworker({ accessRoles: [name], openToEveryone: false }));
    const role = await roleNamed(name);
    expect(role.declared).toBe(true);

    await expect(roles.rename(role.id, `${name} 2`)).rejects.toThrow(
      AccessRoleDeclaredError,
    );
    await expect(roles.remove(role.id)).rejects.toThrow(
      AccessRoleDeclaredError,
    );
  });

  test("deleting an access role takes its people out of it", async () => {
    const admin = await person("admin");
    const member = await person();
    const role = await roles.create(roleName("Nusa Auto"), admin.id);
    await roles.addPerson(role.id, member.id);

    await roles.remove(role.id);

    expect(await roles.get(role.id)).toBeNull();
  });
});

describe("the access role routes", () => {
  function appFor(actor: AgentActor & { email: string }) {
    const app = new Hono<{ Variables: AppVariables }>();
    const requireUser: MiddlewareHandler<{ Variables: AppVariables }> = async (
      context,
      next,
    ) => {
      context.set("actor", actor);
      await next();
    };
    app.route(
      "/api/admin/access-roles",
      createAccessRoleRoutes(roles, requireUser, auditStore, sharedUse),
    );
    return app;
  }

  const send = (
    app: Hono<{ Variables: AppVariables }>,
    method: string,
    path: string,
    body?: unknown,
  ) =>
    app.request(`/api/admin/access-roles${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  test("only an admin may manage access roles, and each change is audited", async () => {
    const admin = await person("admin");
    const member = await person();
    const asAdmin = appFor(admin);
    const name = roleName("Founders");

    expect((await send(appFor(member), "GET", "")).status).toBe(403);
    expect((await send(appFor(member), "POST", "", { name })).status).toBe(403);

    const created = await send(asAdmin, "POST", "", { name });
    expect(created.status).toBe(201);
    const { role } = (await created.json()) as { role: { id: string } };

    expect(
      (await send(asAdmin, "PUT", `/${role.id}/people/${member.id}`)).status,
    ).toBe(200);
    const listed = (await (await send(asAdmin, "GET", "")).json()) as {
      roles: { id: string; people: { id: string }[] }[];
    };
    expect(
      listed.roles.find(({ id }) => id === role.id)?.people.map(({ id }) => id),
    ).toEqual([member.id]);

    expect(
      (await send(asAdmin, "DELETE", `/${role.id}/people/${member.id}`)).status,
    ).toBe(200);
    const renamed = `${name} renamed`;
    createdRoleNames.push(renamed);
    expect(
      (await send(asAdmin, "PATCH", `/${role.id}`, { name: renamed })).status,
    ).toBe(200);
    expect((await send(asAdmin, "DELETE", `/${role.id}`)).status).toBe(204);

    const trail = await database
      .select({ eventType: auditEvents.eventType })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.actorUserId, admin.id),
          eq(auditEvents.targetId, role.id),
        ),
      );
    expect(trail.map(({ eventType }) => eventType).sort()).toEqual([
      "access_role.created",
      "access_role.deleted",
      "access_role.person_added",
      "access_role.person_removed",
      "access_role.renamed",
    ]);
  });

  test("adding somebody who has never signed in is refused", async () => {
    const admin = await person("admin");
    const asAdmin = appFor(admin);
    const role = await roles.create(roleName("Founders"), admin.id);

    const response = await send(
      asAdmin,
      "PUT",
      `/${role.id}/people/nobody-${randomUUID()}`,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "That person hasn't signed in to OpenBot yet.",
    });
  });

  test("a name that is taken or empty is refused with a reason", async () => {
    const admin = await person("admin");
    const asAdmin = appFor(admin);
    const name = roleName("Cilook");
    await roles.create(name, admin.id);

    const taken = await send(asAdmin, "POST", "", { name });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual({
      error: `There's already an access role called ${name}.`,
    });
    expect((await send(asAdmin, "POST", "", { name: "  " })).status).toBe(400);
  });

  test("adding somebody re-approves the shared accounts the role's Bots use", async () => {
    const name = roleName("People team");
    const bot = coworker({ accessRoles: [name], openToEveryone: false });
    await tenant()(bot);
    const admin = await person("admin");
    const first = await person();
    const second = await person();
    const role = await roleNamed(name);
    await roles.addPerson(role.id, first.id);

    // A Linear the whole company shares, given to the Bot and approved for who reaches it today.
    const serverId = `composio-linear-${suite}-${randomUUID().slice(0, 6)}`;
    createdServers.push(serverId);
    await database.insert(mcpServers).values({
      id: serverId,
      title: "Linear",
      vendor: "Composio",
      url: `composio://linear-${serverId}`,
      provenance: "composio",
      authScheme: "OAUTH2",
      accountMode: "shared",
      sharedVendorUserId: `openbot-deployment:${suite}`,
    });
    await database.insert(mcpTools).values({
      serverId,
      name: "LIST_ISSUES",
      description: "List issues.",
      inputSchema: {},
    });
    await database
      .insert(pluginGrants)
      .values({ kind: "mcp", ref: `${serverId}/LIST_ISSUES`, agentId: bot.id });
    await sharedUse.setApproval({
      botId: bot.id,
      serverId,
      approval: exposureOf(await sharedUse.botFacts(bot.id)),
      by: admin.id,
    });
    expect(await sharedUse.shortfall(bot.id)).toEqual([]);

    const response = await send(
      appFor(admin),
      "PUT",
      `/${role.id}/people/${second.id}`,
    );

    expect(response.status).toBe(200);
    expect(
      ((await response.json()) as { sharedApps: unknown }).sharedApps,
    ).toEqual([
      {
        botId: bot.id,
        approved: [{ serverId, title: "Linear" }],
        needsApproval: [],
      },
    ]);
    // The approval now reaches the person just added.
    expect(await sharedUse.shortfall(bot.id)).toEqual([]);
    expect(
      (await sharedUse.approvalFor(bot.id, serverId))?.members.map(
        ({ value }) => value,
      ),
    ).toContain(second.id);
  });
});
