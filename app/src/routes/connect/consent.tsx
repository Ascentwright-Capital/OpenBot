import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import AgentOrb from "@/components/agents/orb/agent-orb";
import { Button } from "@/components/ui/button";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { appConfig } from "@/lib/generated/application-config";
import { answerConsent } from "@/lib/oauth/consent";
import { oauthClientQueryOptions } from "@/lib/oauth/queries";

/**
 * Where an app asking to manage OpenBot as this person (Claude, Claude Code) is approved or refused.
 *
 * The server sends the person here mid-authorization with a signed query string. Outside the
 * `_authed` layout on purpose: nothing here needs the runtime, and onboarding must not swallow the
 * redirect. Somebody signed out goes to sign in first and comes back through the authorize request.
 */
export const Route = createFileRoute("/connect/consent")({
  beforeLoad: async ({ context }) => {
    const user = await context.queryClient.ensureQueryData(
      currentUserQueryOptions(),
    );
    if (!user) throw redirect({ to: "/sign" });
  },
  component: ConsentScreen,
});

/** What each scope lets the app do, in the person's words. */
const SCOPE_WORDS: Record<string, string> = {
  "openbot:read":
    "See your Bots, Team Bots, apps and, if you're an admin, people and settings.",
  "openbot:manage":
    "Make changes for you: create and edit Bots, share Team Bots, and give Bots apps. If you're an admin, it can also change roles and settings.",
};

function hostOf(uri: string | undefined) {
  if (!uri) return undefined;
  try {
    return new URL(uri).host;
  } catch {
    return undefined;
  }
}

function ConsentScreen() {
  const oauthQuery = window.location.search.replace(/^\?/, "");
  const params = new URLSearchParams(oauthQuery);
  const clientId = params.get("client_id") ?? "";
  const scopes = (params.get("scope") ?? "").split(" ").filter(Boolean);
  const app = useQuery({
    ...oauthClientQueryOptions(clientId),
    enabled: Boolean(clientId),
  });
  const [sending, setSending] = useState<"allow" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function answer(accept: boolean) {
    setError(null);
    setSending(accept ? "allow" : "deny");
    try {
      window.location.assign(await answerConsent({ accept, oauthQuery }));
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Couldn't send your answer. Try again.",
      );
      setSending(null);
    }
  }

  const name = app.data?.client_name?.trim() || "An app";
  const returnsTo = hostOf(app.data?.redirect_uris?.[0]);
  const described = scopes.filter((scope) => SCOPE_WORDS[scope]);

  return (
    <div className="flex h-dvh w-full flex-col items-center justify-center p-4">
      <div className="flex w-full max-w-96 flex-col items-center gap-6">
        <AgentOrb size="48px" />
        {!clientId ? (
          <p className="text-destructive text-sm text-center" role="alert">
            This link is missing its app. Start connecting again from the app.
          </p>
        ) : app.isPending ? null : app.error ? (
          <p className="text-destructive text-sm text-center" role="alert">
            {app.error.message}
          </p>
        ) : (
          <>
            <div className="flex flex-col gap-2 text-center">
              <h1 className="text-2xl font-medium tracking-tight">
                Connect {name} to {appConfig.brand.productName}
              </h1>
              <p className="text-muted-foreground text-sm">
                It will act as you, with your permissions.
              </p>
            </div>
            {described.length ? (
              <ul className="flex w-full flex-col gap-2 text-sm">
                {described.map((scope) => (
                  <li className="rounded-lg border px-3 py-2" key={scope}>
                    {SCOPE_WORDS[scope]}
                  </li>
                ))}
              </ul>
            ) : null}
            {returnsTo ? (
              <p className="text-muted-foreground text-xs text-center">
                You'll go back to {returnsTo}. Only allow this if you started
                connecting from there.
              </p>
            ) : null}
            {error ? (
              <p className="text-destructive text-sm text-center" role="alert">
                {error}
              </p>
            ) : null}
            <div className="flex w-full gap-2">
              <Button
                className="flex-1"
                disabled={sending !== null}
                onClick={() => answer(false)}
                size="lg"
                variant="outline"
              >
                {sending === "deny" ? "Cancelling…" : "Don't allow"}
              </Button>
              <Button
                className="flex-1"
                disabled={sending !== null}
                onClick={() => answer(true)}
                size="lg"
              >
                {sending === "allow" ? "Connecting…" : "Allow"}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
