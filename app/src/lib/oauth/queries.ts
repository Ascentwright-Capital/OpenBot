import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * An app asking to connect to OpenBot as the signed-in person: Claude, Claude Code, or another MCP
 * client. Self-registered, so its name is its own claim. The consent screen shows where it will
 * send the person back to as well, which is the part it cannot fake.
 */
export type OAuthClientSummary = {
  client_id: string;
  client_name?: string;
  client_uri?: string;
  logo_uri?: string;
  redirect_uris?: string[];
};

export const oauthKeys = {
  all: ["oauth"] as const,
  client: (clientId: string) => ["oauth", "client", clientId] as const,
};

export function oauthClientQueryOptions(clientId: string) {
  return queryOptions({
    queryKey: oauthKeys.client(clientId),
    queryFn: async (): Promise<OAuthClientSummary> =>
      (
        await client(
          `/api/auth/oauth2/public-client?client_id=${encodeURIComponent(clientId)}`,
          { fallback: "Couldn't find the app asking to connect." },
        )
      ).json(),
  });
}
