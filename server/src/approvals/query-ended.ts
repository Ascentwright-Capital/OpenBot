/**
 * When an approval is answered after the Claude query that asked for it has ended.
 *
 * The Claude harness holds each query open while it waits for a tool result, and only for its time
 * limit. An answer that arrives later, or after a restart, has nothing to resume: the harness says so
 * with `OPENBOT_QUERY_ENDED`, which the plan model raises as an error of this name.
 */
export const QUERY_ENDED_ERROR = "OpenBotQueryEndedError";
const QUERY_ENDED_TEXT = "is no longer running. Start a new message.";

/** Whether the continuation failed because the waiting query is gone, anywhere in the cause chain. */
export function queryEnded(error: unknown): boolean {
  const seen = new Set<unknown>();
  const pending = [error];
  while (pending.length) {
    const current = pending.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    if (current instanceof Error) {
      if (
        current.name === QUERY_ENDED_ERROR ||
        current.message.includes(QUERY_ENDED_TEXT)
      )
        return true;
      pending.push(current.cause);
      if (current instanceof AggregateError) pending.push(...current.errors);
    }
  }
  return false;
}

/**
 * What the person hears instead of the Bot's continued reply. Only the outcome: the action's own
 * output can hold private content, and this may land in a shared thread.
 */
export function approvalOutcomeNotice(
  toolRef: string,
  result: { content: string; error?: string },
): string {
  const ending =
    "My earlier turn had ended by the time this was answered, so I can't pick it up. Send me a new message if there's more to do.";
  if (result.error)
    return `Not done: ${toolRef}. ${result.error.slice(0, 300)} ${ending}`;
  return `Done: ${toolRef}. ${ending}`;
}
