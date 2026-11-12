import { z } from "zod";

/**
 * What Claude can do to OpenBot, as tools.
 *
 * EVERY TOOL IS A REQUEST TO AN EXISTING ROUTE, made in memory as the person who connected Claude.
 * Nothing here decides who may do what: the route already does, with the same admin and owner checks,
 * the same capability switches and the same audit rows as that person's own browser. A tool an
 * ordinary member calls on an admin route gets the route's own refusal back, word for word.
 *
 * `access` says which OAuth scope a tool needs. A token with `openbot:read` is offered only the
 * `read` tools, and the request guard refuses any non-GET it makes anyway, so the two cannot drift.
 */

export type ToolAccess = "read" | "manage";

export type ApiRequest = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string>;
  body?: unknown;
};

export type ToolDefinition = {
  name: string;
  title: string;
  description: string;
  access: ToolAccess;
  /** Destructive: removes access or data somebody else may rely on. Shown to the person by Claude. */
  destructive?: boolean;
  input: z.ZodRawShape;
  request: (args: Record<string, unknown>) => ApiRequest;
};

const id = (label: string) => z.string().trim().min(1).describe(label);
const segment = (value: unknown) => encodeURIComponent(String(value));
const botId = id("The Bot's id, from list_bots.");

/**
 * Paths the generic tool may not reach.
 *
 * Sign-in and token endpoints, this endpoint itself, and the public webhooks (which authenticate by
 * signature, not as a person). Everything else under /api is a route the person's browser could call.
 */
const UNREACHABLE = [
  /^\/api\/auth(\/|$)/,
  /^\/api\/mcp(\/|$)/,
  /^\/api\/events(\/|$)/,
  /^\/api\/delivery\/webhooks(\/|$)/,
];

export function reachable(path: string): boolean {
  if (!path.startsWith("/api/") || path.includes("..")) return false;
  return !UNREACHABLE.some((pattern) => pattern.test(path));
}

export const TOOLS: ToolDefinition[] = [
  {
    name: "whoami",
    title: "Who am I",
    description:
      "The person Claude is acting as on OpenBot: name, email and role (admin or user). Call this first: what the other tools allow depends on the role.",
    access: "read",
    input: {},
    request: () => ({ method: "GET", path: "/api/me" }),
  },
  {
    name: "list_bots",
    title: "List Bots",
    description:
      "Every Bot this person can see: their own, public Bots, Team Bots published to them, and every Bot for an admin. Each has an id, name, title, description, visibility (public or private) and owner.",
    access: "read",
    input: {
      hidden: z
        .boolean()
        .optional()
        .describe("True to list the Bots this person has hidden instead."),
    },
    request: (args) => ({
      method: "GET",
      path: "/api/agents",
      ...(args.hidden ? { query: { hidden: "true" } } : {}),
    }),
  },
  {
    name: "get_bot",
    title: "Get a Bot",
    description: "One Bot's profile.",
    access: "read",
    input: { botId },
    request: (args) => ({
      method: "GET",
      path: `/api/agents/${segment(args.botId)}`,
    }),
  },
  {
    name: "create_bot",
    title: "Create a Bot",
    description:
      "Create a Bot owned by this person. It runs on the built-in model with the description as its standing instructions. Private Bots are only for their owner until published as a Team Bot; public Bots are for everyone who signs in.",
    access: "manage",
    input: {
      name: id("What the Bot is called."),
      title: id("Its job title, e.g. 'Finance analyst'."),
      roleDescription: id(
        "What it does and how, in plain words. This is what it runs on.",
      ),
      visibility: z.enum(["private", "public"]).default("private"),
    },
    request: (args) => ({ method: "POST", path: "/api/agents", body: args }),
  },
  {
    name: "update_bot",
    title: "Update a Bot",
    description:
      "Change a Bot's name, title, description or visibility. Only its owner or an admin can.",
    access: "manage",
    input: {
      botId,
      name: z.string().trim().min(1).optional(),
      title: z.string().trim().min(1).optional(),
      roleDescription: z.string().trim().min(1).optional(),
      visibility: z.enum(["private", "public"]).optional(),
    },
    request: ({ botId: target, ...fields }) => ({
      method: "PATCH",
      path: `/api/agents/${segment(target)}`,
      body: fields,
    }),
  },
  {
    name: "list_team_bots",
    title: "List Team Bots",
    description:
      "Published Team Bots this person can use or manage, with who each is published to (the whole team, or named people and groups) and which groups an admin assigned it to.",
    access: "read",
    input: {},
    request: () => ({ method: "GET", path: "/api/team-bots" }),
  },
  {
    name: "publish_team_bot",
    title: "Publish a Team Bot",
    description:
      "Publish a Bot this person owns to the team, or only to named people (emails) and groups. Group names must match the identity provider's exactly; they are case-sensitive. The Bot needs a real name and a description first. Publishing again replaces the audience.",
    access: "manage",
    input: {
      botId,
      audience: z
        .enum(["team", "people"])
        .describe(
          "'team' for everyone, 'people' for only the emails and groups given.",
        ),
      emails: z.array(z.string().trim()).max(200).default([]),
      groups: z.array(z.string().trim()).max(100).default([]),
    },
    request: ({ botId: target, ...body }) => ({
      method: "PUT",
      path: `/api/team-bots/${segment(target)}/publication`,
      body,
    }),
  },
  {
    name: "unpublish_team_bot",
    title: "Unpublish a Team Bot",
    description:
      "Take a Team Bot away from everyone it was published to. Its owner keeps it. Admin assignments are kept but do nothing until it is published again.",
    access: "manage",
    destructive: true,
    input: { botId },
    request: (args) => ({
      method: "DELETE",
      path: `/api/team-bots/${segment(args.botId)}/publication`,
    }),
  },
  {
    name: "assign_team_bot",
    title: "Assign a Team Bot to a group",
    description:
      "Admins only. Pin a published Team Bot at the top of every member's Bots list in a group. Assigning also gives that group access. Use '*' for the whole team.",
    access: "manage",
    input: { botId, group: id("The group name, or * for everyone.") },
    request: (args) => ({
      method: "POST",
      path: `/api/team-bots/${segment(args.botId)}/assignments`,
      body: { group: args.group },
    }),
  },
  {
    name: "unassign_team_bot",
    title: "Remove a Team Bot assignment",
    description: "Admins only. Remove a group assignment from a Team Bot.",
    access: "manage",
    destructive: true,
    input: { botId, group: id("The group name, or *.") },
    request: (args) => ({
      method: "DELETE",
      path: `/api/team-bots/${segment(args.botId)}/assignments/${segment(args.group)}`,
    }),
  },
  {
    name: "list_plugins",
    title: "List apps and skills",
    description:
      "The apps (MCP servers) and skills added to this deployment, and which Bots may use each.",
    access: "read",
    input: {},
    request: () => ({ method: "GET", path: "/api/plugins" }),
  },
  {
    name: "get_bot_grants",
    title: "What a Bot can use",
    description: "The apps, skills and Bots one Bot has been given.",
    access: "read",
    input: { botId },
    request: (args) => ({
      method: "GET",
      path: `/api/plugins/for/${segment(args.botId)}`,
    }),
  },
  {
    name: "grant_to_bot",
    title: "Give a Bot an app or skill",
    description:
      "Let a Bot use an app (kind 'mcp', ref = the server id), a skill (kind 'skill', ref = its slug) or another Bot (kind 'bot', ref = that Bot's id). Ids are in list_plugins.",
    access: "manage",
    input: {
      botId,
      kind: z.enum(["mcp", "skill", "bot"]),
      ref: id("The app's server id, the skill's slug, or the Bot's id."),
    },
    request: (args) => ({
      method: "POST",
      path: "/api/plugins/grants",
      body: { kind: args.kind, ref: args.ref, agentId: args.botId },
    }),
  },
  {
    name: "revoke_from_bot",
    title: "Take an app or skill from a Bot",
    description: "Stop a Bot using an app, skill or Bot it was given.",
    access: "manage",
    destructive: true,
    input: {
      botId,
      kind: z.enum(["mcp", "skill", "bot"]),
      ref: id("The app's server id, the skill's slug, or the Bot's id."),
    },
    request: (args) => ({
      method: "DELETE",
      path: "/api/plugins/grants",
      query: {
        kind: String(args.kind),
        ref: String(args.ref),
        agentId: String(args.botId),
      },
    }),
  },
  {
    name: "list_people",
    title: "List people",
    description:
      "Admins only. Everybody who has signed in: id, email, role, groups, last sign-in, and whether they were removed.",
    access: "read",
    input: {},
    request: () => ({ method: "GET", path: "/api/admin/people" }),
  },
  {
    name: "set_role",
    title: "Change somebody's role",
    description:
      "Admins only. Make somebody an admin or an ordinary user. Addresses in INITIAL_ADMIN_EMAILS stay admins.",
    access: "manage",
    input: {
      userId: id("The person's id, from list_people."),
      role: z.enum(["admin", "user"]),
    },
    request: (args) => ({
      method: "POST",
      path: `/api/admin/people/${segment(args.userId)}/role`,
      body: { role: args.role },
    }),
  },
  {
    name: "get_controls",
    title: "Read admin controls",
    description:
      "Admins only. The capability switches (organization, per role, per group), settings and network policies that decide what people and their Bots may do.",
    access: "read",
    input: {},
    request: () => ({ method: "GET", path: "/api/admin/enterprise" }),
  },
  {
    name: "set_capability",
    title: "Set a capability switch",
    description:
      "Admins only. Turn a capability on or off for the organization, a role ('admin' or 'user') or a group. A group switch can only widen: false on a group changes nothing. allowed null clears the switch. Capabilities: useBots, cloudBrowser, cloudNetwork, cloudComputer, localComputer, customRules, passwordManager, slackTeams, teamBots, ownerApps.",
    access: "manage",
    input: {
      scopeKind: z.enum(["organization", "role", "group"]),
      scopeId: z
        .string()
        .trim()
        .default("")
        .describe(
          "Empty for organization, 'admin'/'user' for a role, the group name for a group.",
        ),
      capability: id("One of the capability names above."),
      allowed: z.boolean().nullable(),
    },
    request: (args) => ({
      method: "PUT",
      path: "/api/admin/enterprise/capabilities",
      body: args,
    }),
  },
  {
    name: "audit_events",
    title: "Read the audit trail",
    description:
      'Admins only. Recent audit events: who did what, to what, when. Filters are passed as query parameters, e.g. {"limit": "50"}.',
    access: "read",
    input: {
      query: z
        .record(z.string(), z.string())
        .optional()
        .describe("Query parameters for /api/admin/audit-events."),
    },
    request: (args) => ({
      method: "GET",
      path: "/api/admin/audit-events",
      query: {
        ...((args.query as Record<string, string>) ?? {}),
        format: "json",
      },
    }),
  },
  {
    name: "openbot_api",
    title: "Call the OpenBot API",
    description:
      "Any other OpenBot screen's API, for what the named tools do not cover: /api/channels, /api/routines, /api/approvals, /api/computers, /api/admin/... and so on. Runs as this person with their permissions, exactly as their browser would. Prefer a named tool when one fits. Sign-in, webhook and this endpoint's own paths are not reachable.",
    access: "read",
    input: {
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
      path: z
        .string()
        .describe(
          "An absolute API path starting with /api/, e.g. /api/routines.",
        ),
      query: z.record(z.string(), z.string()).optional(),
      body: z
        .unknown()
        .optional()
        .describe("JSON body for POST, PUT, PATCH, DELETE."),
    },
    request: (args) => ({
      method: (args.method as ApiRequest["method"]) ?? "GET",
      path: String(args.path),
      ...(args.query ? { query: args.query as Record<string, string> } : {}),
      ...(args.body !== undefined ? { body: args.body } : {}),
    }),
  },
];
