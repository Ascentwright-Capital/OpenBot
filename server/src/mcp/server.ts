import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Context } from "hono";
import {
  MCP_PATH,
  OPENBOT_MANAGE_SCOPE,
  OPENBOT_READ_SCOPE,
  type OAuthIdentity,
  oauthIssuer,
} from "../auth/oauth";
import { type ApiRequest, reachable, TOOLS } from "./tools";

/**
 * `/api/mcp`: OpenBot as an MCP server, so Claude can manage it.
 *
 * Streamable HTTP, stateless: every POST builds a server for that one request, because there is
 * nothing to keep between them. Each tool call is a request to an existing `/api` route, handed
 * straight to this app in memory with the person's token and the process's internal-call secret, so
 * the route's own guard admits it as that person (see `INTERNAL_CALL_HEADER` in auth/guards.ts).
 *
 * Without a good token the answer is a 401 with a `WWW-Authenticate` pointer to the protected
 * resource metadata (RFC 9728), which is how claude.ai and Claude Code discover where to sign in.
 */

/** Responses longer than this are cut, so one large listing cannot fill Claude's context. */
const MAX_RESULT_CHARACTERS = 60_000;

export type McpDependencies = {
  baseUrl: string;
  verify: (token: string) => Promise<OAuthIdentity>;
  /** Send a request to this app in memory as the token's person. */
  callApi: (token: string, request: ApiRequest) => Promise<Response>;
  version: string;
};

export function protectedResourceMetadataUrl(baseUrl: string) {
  return `${baseUrl.replace(/\/+$/, "")}/.well-known/oauth-protected-resource${MCP_PATH}`;
}

/** RFC 9728 protected resource metadata for `/api/mcp`. */
export function protectedResourceMetadata(baseUrl: string) {
  return {
    resource: `${baseUrl.replace(/\/+$/, "")}${MCP_PATH}`,
    resource_name: "OpenBot",
    authorization_servers: [oauthIssuer(baseUrl)],
    scopes_supported: [OPENBOT_READ_SCOPE, OPENBOT_MANAGE_SCOPE],
    bearer_methods_supported: ["header"],
  };
}

function challenge(context: Context, baseUrl: string, description: string) {
  context.header(
    "WWW-Authenticate",
    `Bearer resource_metadata="${protectedResourceMetadataUrl(baseUrl)}", scope="${OPENBOT_MANAGE_SCOPE}", error="invalid_token", error_description="${description}"`,
  );
  return context.json({ error: description }, 401);
}

async function resultText(response: Response) {
  const text = await response.text();
  let pretty = text;
  try {
    pretty = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    // Not JSON (a CSV, an empty 204): passed through as it came.
  }
  if (!pretty) pretty = response.ok ? "Done." : `HTTP ${response.status}`;
  return pretty.length > MAX_RESULT_CHARACTERS
    ? `${pretty.slice(0, MAX_RESULT_CHARACTERS)}\n… cut at ${MAX_RESULT_CHARACTERS} characters. Ask for less.`
    : pretty;
}

export function buildMcpServer(
  dependencies: McpDependencies,
  token: string,
  identity: OAuthIdentity,
) {
  const server = new McpServer(
    { name: "openbot", title: "OpenBot", version: dependencies.version },
    {
      instructions:
        "Manage this OpenBot deployment as the person who connected Claude: their Bots, Team Bots and who they are shared with, which apps each Bot may use, and, for admins, people, roles, capability switches and the audit trail. Call whoami first. Every change runs with that person's own permissions and is written to OpenBot's audit trail. Confirm with the person before anything marked destructive.",
    },
  );
  const manage = identity.scopes.includes(OPENBOT_MANAGE_SCOPE);

  for (const tool of TOOLS) {
    if (tool.access === "manage" && !manage) continue;
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: {
          title: tool.title,
          readOnlyHint: tool.access === "read" && tool.name !== "openbot_api",
          destructiveHint: tool.destructive === true,
          openWorldHint: false,
        },
      },
      async (args: Record<string, unknown>) => {
        const request = tool.request(args);
        if (!reachable(request.path)) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: `${request.path} is not reachable from Claude. Use a path under /api/ other than sign-in, webhooks and /api/mcp.`,
              },
            ],
          };
        }
        const response = await dependencies.callApi(token, request);
        return {
          isError: !response.ok,
          content: [
            { type: "text" as const, text: await resultText(response) },
          ],
        };
      },
    );
  }
  return server;
}

export function createMcpHandler(dependencies: McpDependencies) {
  return async (context: Context) => {
    const header = context.req.header("authorization") ?? "";
    const token = header.toLowerCase().startsWith("bearer ")
      ? header.slice(7).trim()
      : "";
    if (!token) {
      return challenge(context, dependencies.baseUrl, "Sign in to OpenBot.");
    }
    let identity: OAuthIdentity;
    try {
      identity = await dependencies.verify(token);
    } catch (error) {
      return challenge(
        context,
        dependencies.baseUrl,
        error instanceof Error ? error.message : "This token is not good.",
      );
    }
    if (
      !identity.scopes.includes(OPENBOT_READ_SCOPE) &&
      !identity.scopes.includes(OPENBOT_MANAGE_SCOPE)
    ) {
      context.header(
        "WWW-Authenticate",
        `Bearer error="insufficient_scope", scope="${OPENBOT_MANAGE_SCOPE}", resource_metadata="${protectedResourceMetadataUrl(dependencies.baseUrl)}"`,
      );
      return context.json(
        { error: "This token was not granted any OpenBot access." },
        403,
      );
    }

    const server = buildMcpServer(dependencies, token, identity);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    try {
      return await transport.handleRequest(context.req.raw);
    } finally {
      // Stateless: nothing outlives the request. Closed after the response body is produced, which
      // with JSON responses is before handleRequest resolves.
      void server.close();
    }
  };
}
