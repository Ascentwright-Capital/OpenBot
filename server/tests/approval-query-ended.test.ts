import { describe, expect, it } from "bun:test";
import {
  approvalOutcomeNotice,
  QUERY_ENDED_ERROR,
  queryEnded,
} from "../src/approvals/query-ended";

describe("approval answered after its query ended", () => {
  it("recognises the harness signal through wrapped causes", () => {
    const harness = new Error("gone");
    harness.name = QUERY_ENDED_ERROR;
    const wrapped = new Error("RoutineTurnRunError", {
      cause: new AggregateError([new Error("other"), harness]),
    });
    expect(queryEnded(wrapped)).toBe(true);
    expect(
      queryEnded(
        new Error("run failed", {
          cause: new Error(
            "The Claude query for this tool result is no longer running. Start a new message.",
          ),
        }),
      ),
    ).toBe(true);
    expect(queryEnded(new Error("fetch failed"))).toBe(false);
    expect(queryEnded(undefined)).toBe(false);
  });

  it("tells only the outcome, never the action's output", () => {
    const done = approvalOutcomeNotice("composio-linear/CREATE_COMMENT", {
      content: '{"secret":"private body"}',
    });
    expect(done).toMatch(/^Done: composio-linear\/CREATE_COMMENT\./);
    expect(done).not.toContain("private body");
    expect(
      approvalOutcomeNotice("x/y", { content: "boom", error: "boom" }),
    ).toMatch(/^Not done: x\/y\. boom /);
  });
});
