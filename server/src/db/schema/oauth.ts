/**
 * The tables `@better-auth/oauth-provider` and Better Auth's `jwt` plugin keep, declared here so a
 * generated migration creates them.
 *
 * They make this deployment an OAuth authorization server for one resource: the MCP endpoint at
 * `/api/mcp`, which is how Claude (claude.ai, the Claude app, Claude Code) manages OpenBot as the
 * person who signed in. See `mcp/` for the endpoint and `auth/oauth.ts` for the policy.
 *
 * As with `scim.ts`: every property is spelled exactly as the plugin's own schema spells the field,
 * because Better Auth's drizzle adapter finds a column by its JavaScript property name, and a model by
 * its plural key in the schema object handed to it (`oauthClient` -> `oauthClients`). The SQL names
 * are ours and snake_case. Field list and flags copied from the plugins' `schema` blocks in
 * `@better-auth/oauth-provider@1.7.1` and `better-auth@1.7.1` (`plugins/jwt`).
 *
 * Owned by the plugins: nothing in OpenBot writes these directly. Tokens and client secrets are
 * stored hashed by the plugin; the JWT signing keys are encrypted with `BETTER_AUTH_SECRET`.
 */
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sessions, users } from "./core";

const at = (name: string) => timestamp(name, { withTimezone: true });

export const oauthClients = pgTable(
  "oauth_clients",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull().unique(),
    clientSecret: text("client_secret"),
    clientDiscoveryId: text("client_discovery_id"),
    disabled: boolean("disabled").default(false),
    skipConsent: boolean("skip_consent"),
    enableEndSession: boolean("enable_end_session"),
    subjectType: text("subject_type"),
    scopes: text("scopes").array(),
    clientCredentialsScopes: text("client_credentials_scopes")
      .array()
      .default([]),
    userId: text("user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    createdAt: at("created_at"),
    updatedAt: at("updated_at"),
    name: text("name"),
    uri: text("uri"),
    icon: text("icon"),
    contacts: text("contacts").array(),
    tos: text("tos"),
    policy: text("policy"),
    softwareId: text("software_id"),
    softwareVersion: text("software_version"),
    softwareStatement: text("software_statement"),
    redirectUris: text("redirect_uris").array().notNull(),
    postLogoutRedirectUris: text("post_logout_redirect_uris").array(),
    backchannelLogoutUri: text("backchannel_logout_uri"),
    backchannelLogoutSessionRequired: boolean(
      "backchannel_logout_session_required",
    ),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
    applicationType: text("application_type"),
    jwks: text("jwks"),
    jwksUri: text("jwks_uri"),
    grantTypes: text("grant_types").array(),
    responseTypes: text("response_types").array(),
    requirePKCE: boolean("require_pkce"),
    dpopBoundAccessTokens: boolean("dpop_bound_access_tokens").default(false),
    referenceId: text("reference_id"),
    metadata: jsonb("metadata"),
  },
  (table) => [index("oauth_clients_user_idx").on(table.userId)],
);

export const oauthResources = pgTable("oauth_resources", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull().unique(),
  name: text("name").notNull(),
  accessTokenTtl: integer("access_token_ttl"),
  refreshTokenTtl: integer("refresh_token_ttl"),
  signingAlgorithm: text("signing_algorithm"),
  signingKeyId: text("signing_key_id"),
  allowedScopes: text("allowed_scopes").array(),
  customClaims: jsonb("custom_claims"),
  dpopBoundAccessTokensRequired: boolean(
    "dpop_bound_access_tokens_required",
  ).default(false),
  disabled: boolean("disabled").default(false),
  createdAt: at("created_at"),
  updatedAt: at("updated_at"),
  policyVersion: integer("policy_version").default(1),
  metadata: jsonb("metadata"),
});

export const oauthClientResources = pgTable(
  "oauth_client_resources",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    resourceId: text("resource_id")
      .notNull()
      .references(() => oauthResources.identifier, { onDelete: "cascade" }),
    metadata: jsonb("metadata"),
    createdAt: at("created_at"),
  },
  (table) => [
    // One row per pair: the provider's linkage check and its idempotent link both assume it.
    uniqueIndex("oauth_client_resources_pair_idx").on(
      table.clientId,
      table.resourceId,
    ),
    index("oauth_client_resources_client_idx").on(table.clientId),
    index("oauth_client_resources_resource_idx").on(table.resourceId),
  ],
);

export const oauthRefreshTokens = pgTable(
  "oauth_refresh_tokens",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => sessions.id, {
      onDelete: "set null",
    }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    authorizationCodeId: text("authorization_code_id"),
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    expiresAt: at("expires_at"),
    createdAt: at("created_at"),
    revoked: at("revoked"),
    rotatedAt: at("rotated_at"),
    rotationReplayResponse: text("rotation_replay_response"),
    rotationReplayExpiresAt: at("rotation_replay_expires_at"),
    authTime: at("auth_time"),
    confirmation: jsonb("confirmation"),
    scopes: text("scopes").array().notNull(),
  },
  (table) => [
    index("oauth_refresh_tokens_client_idx").on(table.clientId),
    index("oauth_refresh_tokens_session_idx").on(table.sessionId),
    index("oauth_refresh_tokens_user_idx").on(table.userId),
    index("oauth_refresh_tokens_code_idx").on(table.authorizationCodeId),
  ],
);

export const oauthAccessTokens = pgTable(
  "oauth_access_tokens",
  {
    id: text("id").primaryKey(),
    token: text("token").unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => sessions.id, {
      onDelete: "set null",
    }),
    userId: text("user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    referenceId: text("reference_id"),
    authorizationCodeId: text("authorization_code_id"),
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    refreshId: text("refresh_id").references(() => oauthRefreshTokens.id, {
      onDelete: "cascade",
    }),
    expiresAt: at("expires_at"),
    createdAt: at("created_at"),
    revoked: at("revoked"),
    confirmation: jsonb("confirmation"),
    scopes: text("scopes").array().notNull(),
  },
  (table) => [
    index("oauth_access_tokens_client_idx").on(table.clientId),
    index("oauth_access_tokens_session_idx").on(table.sessionId),
    index("oauth_access_tokens_user_idx").on(table.userId),
    index("oauth_access_tokens_code_idx").on(table.authorizationCodeId),
    index("oauth_access_tokens_refresh_idx").on(table.refreshId),
  ],
);

export const oauthConsents = pgTable(
  "oauth_consents",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    referenceId: text("reference_id"),
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    scopes: text("scopes").array().notNull(),
    createdAt: at("created_at"),
    updatedAt: at("updated_at"),
  },
  (table) => [
    index("oauth_consents_client_idx").on(table.clientId),
    index("oauth_consents_user_idx").on(table.userId),
  ],
);

export const oauthClientAssertions = pgTable("oauth_client_assertions", {
  id: text("id").primaryKey(),
  expiresAt: at("expires_at").notNull(),
});

/** The JWT plugin's signing keys. Handed to the adapter as `jwkss`, the plural it looks for. */
export const jwks = pgTable("jwks", {
  id: text("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: at("created_at").notNull(),
  expiresAt: at("expires_at"),
  alg: text("alg"),
  crv: text("crv"),
});
