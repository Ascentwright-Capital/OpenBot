import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render } from "@testing-library/react";
import {
  type AuditEvent,
  decisionDetails,
  decisionText,
  searchTextOf,
  throughText,
  WhoCell,
  whatText,
} from "@/components/audit/audit-cells";
import { outcomeOf } from "@/lib/audit/outcome";

/*
 * What Claude does through /api/mcp, on the audit screen.
 *
 * A change made through Claude is recorded as the person's, like one made in their browser, and
 * the two could not be told apart. A token turned away there left no row at all. Both are on the
 * trail now: the row of a change names the OAuth client it came through, and a refused token is a
 * row of its own with its reason.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

function row(
  eventType: string,
  payload: Record<string, unknown>,
  actorUserId: string | null = "person-1",
): AuditEvent {
  return {
    id: "e1",
    actorUserId,
    initiatorKind: actorUserId ? "person" : "deployment",
    initiatorId: null,
    eventType,
    targetType: "bot",
    targetId: "bot-1",
    payload,
    createdAt: "2026-11-12T11:00:00Z",
  } as AuditEvent;
}

const nameFor = (id: string) => id;

test("a Bot created through Claude says which client it came through, under who started it", () => {
  const created = row("bot.created", {
    bot: "bot-1",
    oauthClient: { id: "client-1", name: "Claude Code" },
  });
  expect(throughText(created)).toBe("Through Claude Code");
  const view = render(<WhoCell event={created} nameFor={nameFor} />);
  expect(view.getByText("Started by a person")).toBeTruthy();
  expect(view.getByText("Through Claude Code")).toBeTruthy();
  // And the search box finds the row by it.
  expect(searchTextOf(created, nameFor)).toContain("through claude code");
});

test("the same row made in the browser says nothing about a client", () => {
  const created = row("bot.created", { bot: "bot-1" });
  expect(throughText(created)).toBe("");
  const view = render(<WhoCell event={created} nameFor={nameFor} />);
  expect(view.queryByText(/^Through /)).toBeNull();
});

test("a client that gave no name is still shown as not the browser, and a long name is cut", () => {
  expect(throughText(row("bot.created", { oauthClient: { id: "c" } }))).toBe(
    "Through a connected app",
  );
  expect(
    throughText(
      row("bot.created", { oauthClient: { id: "c", name: "x".repeat(500) } }),
    ).length,
  ).toBeLessThan(80);
});

test("a refused token is a blocked row that says what was tried and why", () => {
  const refused = row(
    "mcp.token_refused",
    { reason: "expired", method: "POST", path: "/api/mcp" },
    null,
  );
  expect(outcomeOf(refused)).toBe("refused");
  expect(whatText(refused)).toBe("Manage OpenBot from Claude");
  expect(decisionText(refused)).toBe("Sign-in not accepted");
  expect(decisionDetails(refused)).toContain("The sign-in had expired");
});

test("each reason the server records has words, and one it adds later is shown as stored", () => {
  for (const reason of [
    "missing",
    "invalid",
    "expired",
    "wrong_audience",
    "no_openbot_scope",
    "read_only",
    "person_removed",
    "no_role",
  ]) {
    const [line] = decisionDetails(row("mcp.token_refused", { reason }));
    expect(line).toBeTruthy();
    expect(line).not.toBe(reason);
  }
  expect(
    decisionDetails(row("mcp.token_refused", { reason: "something_new" })),
  ).toContain("something_new");
});
