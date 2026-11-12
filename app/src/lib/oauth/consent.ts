import { client } from "@/lib/client";

/**
 * Answer the consent screen.
 *
 * A plain function: the answer sends the browser away, so there is no cache to invalidate. The
 * signed query the server sent the person here with goes back unchanged; it is how the server knows
 * which request is being answered.
 */
export async function answerConsent(input: {
  accept: boolean;
  oauthQuery: string;
}): Promise<string> {
  const body = (await (
    await client("/api/auth/oauth2/consent", {
      method: "POST",
      body: { accept: input.accept, oauth_query: input.oauthQuery },
      fallback: "Couldn't send your answer. Try again.",
    })
  ).json()) as { url?: string; redirect_uri?: string };
  const url = body.url ?? body.redirect_uri;
  if (!url) throw new Error("Couldn't send your answer. Try again.");
  return url;
}
