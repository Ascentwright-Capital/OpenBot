import { expect, test } from "bun:test";
import { createDeliveryRouter } from "../src/delivery/router";
import {
  type DeliveryBinding,
  type DeliveryInbox,
  type DeliveryOutbox,
  DeliveryProviderError,
} from "../src/delivery/types";

const scope = {
  ownerUserId: "owner",
  channelId: "channel",
  agentId: "bot",
  threadId: "canonical",
};
const binding: DeliveryBinding = {
  ...scope,
  id: "binding",
  transport: "slack",
  realm: "T",
  identity: "U",
  address: "D",
  enabled: true,
};
function fixture(
  override: Partial<DeliveryBinding> = {},
  turnHook?: (router: ReturnType<typeof createDeliveryRouter>) => Promise<void>,
) {
  const ownedBinding = { ...binding, ...override };
  const inbox: DeliveryInbox = {
    ...scope,
    id: "in",
    bindingId: "binding",
    source: "slack",
    externalId: "event",
    text: "Hi",
    state: "queued",
    error: null,
  };
  const outbound: DeliveryOutbox = {
    ...scope,
    id: "out",
    bindingId: "binding",
    deviceId: null,
    transport: "slack",
    text: "Reply",
    kind: "reply",
    requestId: null,
    state: "queued",
    error: null,
    providerId: null,
  };
  const offered: unknown[] = [];
  const statuses: unknown[] = [];
  const calls: unknown[] = [];
  let live = true;
  const store = {
    findBinding: async (
      _source: string,
      realm: string,
      identity: string,
      address?: string,
    ) =>
      realm === ownedBinding.realm &&
      identity === ownedBinding.identity &&
      (!address || address === ownedBinding.address)
        ? ownedBinding
        : null,
    binding: async () => ownedBinding,
    bindingsFor: async () => [ownedBinding],
    devices: async () => [],
    offerInbox: async (input: unknown) => {
      offered.push(input);
      return { queued: true, id: "in" };
    },
    inbox: async () => inbox,
    setInbox: async (_id: string, state: string, error?: string | null) => {
      statuses.push({ state, error });
    },
    offerOutbox: async (input: unknown) => {
      offered.push(input);
      return outbound;
    },
    outbox: async () => outbound,
    startOutbox: async () => outbound,
    setOutbox: async (
      _id: string,
      state: string,
      error?: string | null,
      providerId?: string,
    ) => {
      statuses.push({ state, error, providerId });
    },
    offerReceipt: async () => {},
    removeDevice: async () => {},
    device: async () => null,
    recordInbox: async (input: Record<string, unknown>) => {
      offered.push({ recorded: input });
      return input.externalId === "seen" ? null : { ...inbox, id: "in2" };
    },
    setSmsOptOut: async (...input: unknown[]) => {
      calls.push({ optOut: input });
      return [{ id: "binding", ownerUserId: "owner", channelId: "channel" }];
    },
    botIdentity: async (agentId: string) => ({ agentId, name: "Research Bot" }),
  };
  const queue = {
    claim: async ({ kind }: { kind: string }) => [
      {
        kind,
        key: kind === "delivery.inbound" ? "in" : "out",
        payload: {},
        attempts: 1,
      },
    ],
    renew: async () => live,
    finish: async () => true,
    release: async () => true,
  };
  const router = createDeliveryRouter({
    store,
    queue,
    owner: "worker",
    authoriseScope: async () => live,
    runTurn: async (input) => {
      calls.push(input);
      await turnHook?.(router);
      return { replyText: "Reply" };
    },
    providers: {
      slack: {
        send: async (input) => {
          calls.push(input);
          return { id: "ts", status: "sent" };
        },
      },
    },
  });
  return {
    router,
    store,
    queue,
    inbox,
    outbound,
    offered,
    statuses,
    calls,
    revoke: () => {
      live = false;
    },
  };
}
test("verified identity resolves canonical scope and suppresses echoes", async () => {
  const f = fixture();
  expect(
    await f.router.receive({
      source: "sms",
      realm: "T",
      identity: "U",
      address: "D",
      externalId: "e",
      text: "Hi",
      echo: true,
    }),
  ).toEqual({ queued: false });
  expect(f.offered).toHaveLength(0);
  await f.router.receive({
    source: "sms",
    realm: "T",
    identity: "U",
    address: "D",
    externalId: "e",
    text: "Hi",
  });
  expect(f.offered[0]).toMatchObject({
    ...scope,
    source: "sms",
    bindingId: "binding",
  });
});
test("queue invokes selected Bot and original conversation, emits durable async reply", async () => {
  const f = fixture();
  await f.router.sweep("delivery.inbound");
  expect(f.calls[0]).toMatchObject({ ...scope, runId: "in", text: "Hi" });
  expect(f.offered[0]).toMatchObject({
    ...scope,
    bindingId: "binding",
    transport: "slack",
    text: "Reply",
    kind: "reply",
  });
  expect(f.statuses.at(-1)).toMatchObject({ state: "sent" });
});
test("revoked source ownership and lost lease cannot execute turns or sends", async () => {
  const f = fixture();
  f.revoke();
  await f.router.sweep("delivery.inbound");
  await f.router.sweep("delivery.outbound");
  expect(f.calls).toHaveLength(0);
});
test("uncertain recovered outbound is never silently resent", async () => {
  const f = fixture();
  f.outbound.state = "running";
  f.store.startOutbox = async () => null;
  await f.router.sweep("delivery.outbound");
  expect(f.calls).toHaveLength(0);
  expect(f.statuses).toContainEqual({
    state: "unknown",
    error:
      "Previous delivery stopped after sending began; inspect provider history before retrying.",
    providerId: undefined,
  });
});
test("provider refusal persists failure while uncertain network persists unknown", async () => {
  const f = fixture();
  const router = createDeliveryRouter({
    store: f.store,
    queue: f.queue,
    owner: "w",
    authoriseScope: async () => true,
    runTurn: async () => ({ replyText: "" }),
    providers: {
      slack: {
        send: async () => {
          throw new DeliveryProviderError("Slack", "network_error", true);
        },
      },
    },
  });
  await router.sweep("delivery.outbound");
  expect(f.statuses.at(-1)).toMatchObject({
    state: "unknown",
    error: "Slack delivery failed (network_error).",
  });
});

test("paired chat turn runs inline, is recorded once, and keeps its own approvals and questions", async () => {
  const f = fixture({}, async (router) => {
    await router.notify(scope, {
      id: "a1",
      text: "asks for approval",
      kind: "approval",
      requestId: "a1",
    });
    await router.notify(scope, {
      id: "q1",
      text: "Bot asks: which repo?",
      kind: "question",
      requestId: "q1",
    });
  });
  const result = await f.router.converse({
    transport: "slack",
    realm: "T",
    identity: "U",
    externalId: "m1",
    text: "Hi",
    signal: new AbortController().signal,
  });
  expect(result).toMatchObject({
    kind: "waiting",
    inboxId: "in2",
    replyText: "Reply",
    extras: {
      approvals: ["a1"],
      questions: [{ id: "q1", text: "Bot asks: which repo?" }],
    },
  });
  expect(f.calls[0]).toMatchObject({ ...scope, runId: "in2", text: "Hi" });
  // Neither the approval nor the question became a second, proactive Slack message.
  expect(f.offered.filter((o) => (o as { kind?: string }).kind)).toHaveLength(
    0,
  );
  expect(f.statuses.at(-1)).toMatchObject({ state: "sent" });
  // Once the turn ends, notifications go through the outbox again.
  await f.router.notify(scope, { id: "r", text: "Later", kind: "question" });
  expect(f.offered.at(-1)).toMatchObject({
    kind: "question",
    transport: "slack",
  });
  expect(
    await f.router.converse({
      transport: "slack",
      realm: "T",
      identity: "U",
      externalId: "seen",
      text: "Hi",
      signal: new AbortController().signal,
    }),
  ).toMatchObject({ kind: "duplicate" });
  expect(
    await f.router.converse({
      transport: "slack",
      realm: "T",
      identity: "STRANGER",
      externalId: "m2",
      text: "Hi",
      signal: new AbortController().signal,
    }),
  ).toEqual({ kind: "unbound" });
  expect(f.calls).toHaveLength(1);
});
test("a suspended governed turn reports its pending approval", async () => {
  const f = fixture();
  const suspended = Object.assign(new Error("waiting"), {
    name: "HeadlessToolSuspension",
    waiting: { kind: "approval", approvalId: "a9", requestId: "a9" },
  });
  const router = createDeliveryRouter({
    store: f.store,
    queue: f.queue,
    owner: "w",
    authoriseScope: async () => true,
    runTurn: async () => {
      throw suspended;
    },
    providers: {},
  });
  expect(
    await router.converse({
      transport: "slack",
      realm: "T",
      identity: "U",
      externalId: "m3",
      text: "go",
      signal: new AbortController().signal,
    }),
  ).toMatchObject({ kind: "waiting", extras: { approvals: ["a9"] } });
  expect(f.statuses.at(-1)).toMatchObject({ state: "accepted" });
});
test("a second paired message waits for the first turn instead of colliding with it", async () => {
  const f = fixture();
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const started: string[] = [];
  const router = createDeliveryRouter({
    store: f.store,
    queue: f.queue,
    owner: "w",
    authoriseScope: async () => true,
    runTurn: async (input) => {
      started.push(input.text);
      if (input.text === "first") await gate;
      return { replyText: `re: ${input.text}` };
    },
    providers: {},
  });
  const message = (text: string, signal = new AbortController().signal) =>
    router.converse({
      transport: "slack",
      realm: "T",
      identity: "U",
      externalId: text,
      text,
      signal,
    });
  const first = message("first");
  const second = message("second");
  const gaveUp = new AbortController();
  const third = message("third", gaveUp.signal);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(started).toEqual(["first"]);
  gaveUp.abort();
  expect(await third).toMatchObject({
    kind: "failed",
    message:
      "I'm still working on your previous message. Send this one again once I've answered.",
  });
  open();
  expect(await first).toMatchObject({
    kind: "replied",
    replyText: "re: first",
  });
  expect(await second).toMatchObject({
    kind: "replied",
    replyText: "re: second",
  });
  expect(started).toEqual(["first", "second"]);
});
test("chat sends carry the Bot's identity; SMS after STOP is recorded opted out, not sent", async () => {
  const f = fixture();
  await f.router.sweep("delivery.outbound");
  expect(f.calls[0]).toMatchObject({
    address: "D",
    transport: "slack",
    sender: { agentId: "bot", name: "Research Bot" },
  });
  const sms = fixture({ transport: "sms", optedOutAt: new Date() });
  sms.outbound.transport = "sms";
  await sms.router.sweep("delivery.outbound");
  expect(sms.calls).toHaveLength(0);
  expect(sms.statuses.at(-1)).toMatchObject({ state: "opted_out" });
  expect(
    await sms.router.receive({
      source: "sms",
      realm: "T",
      identity: "U",
      externalId: "x",
      text: "hello",
    }),
  ).toEqual({ queued: false });
  const refused = fixture({ transport: "sms" });
  refused.outbound.transport = "sms";
  const router = createDeliveryRouter({
    store: refused.store,
    queue: refused.queue,
    owner: "w",
    authoriseScope: async () => true,
    runTurn: async () => ({ replyText: "" }),
    audit: async (event) => {
      refused.calls.push({ audit: event });
    },
    providers: {
      sms: {
        send: async () => {
          throw new DeliveryProviderError("Twilio", "21610");
        },
      },
    },
  });
  await router.sweep("delivery.outbound");
  expect(refused.calls).toContainEqual({ optOut: ["T", "U", true] });
  expect(refused.calls).toContainEqual({
    audit: {
      ownerUserId: "owner",
      channelId: "channel",
      id: "binding",
      kind: "sms_opt_out",
      state: "opted_out",
    },
  });
  expect(refused.statuses.at(-1)).toMatchObject({ state: "opted_out" });
});

test("the person's update routing decides which transports carry each kind", async () => {
  const f = fixture();
  const devices = [
    {
      id: "d1",
      ownerUserId: "owner",
      token: "t",
      projectId: "p",
      platform: "ios" as const,
      enabled: true,
    },
  ];
  f.store.devices = async () => devices;
  const kinds: string[] = [];
  const router = createDeliveryRouter({
    store: f.store,
    queue: f.queue,
    owner: "w",
    authoriseScope: async () => true,
    runTurn: async () => ({ replyText: "" }),
    providers: {},
    routeFor: async ({ kind }) => {
      kinds.push(kind);
      return {
        kind: kind === "reply" ? "progress" : "question",
        notify: true,
        allows: (transport) =>
          kind === "reply" ? transport === "push" : transport === "slack",
      };
    },
  });
  await router.notify(scope, { id: "r1", text: "progress", kind: "reply" });
  await router.notify(scope, { id: "q1", text: "question", kind: "question" });
  expect(kinds).toEqual(["reply", "question"]);
  expect(
    f.offered.map((row) => {
      const r = row as { kind: string; transport: string };
      return `${r.kind}:${r.transport}`;
    }),
  ).toEqual(["reply:push", "question:slack"]);
});
test("a reply awaited by an approval card's turn goes there, not to the outbox", async () => {
  const f = fixture();
  const waiting = f.router.awaitReply(binding.threadId, 5_000);
  await f.router.notify(scope, { id: "r1", text: "Posted.", kind: "reply" });
  expect(await waiting).toBe("Posted.");
  expect(f.offered).toEqual([]);
  // Only the next reply: the one after it goes out as usual.
  await f.router.notify(scope, { id: "r2", text: "Later.", kind: "reply" });
  expect(f.offered).toHaveLength(1);
  // Unanswered in time, the card's turn moves on and nothing is held back.
  expect(await f.router.awaitReply(binding.threadId, 5)).toBeNull();
  await f.router.notify(scope, { id: "r3", text: "Late.", kind: "reply" });
  expect(f.offered).toHaveLength(2);
});
test("a hand-off made during a paired chat turn is counted on that turn only", async () => {
  const f = fixture({}, async (router) => {
    router.noteHandoff(scope.threadId);
    router.noteHandoff("some-other-thread");
  });
  const result = await f.router.converse({
    transport: "slack",
    realm: "T",
    identity: "U",
    externalId: "handoff-1",
    text: "Ask Software factory",
    signal: new AbortController().signal,
  });
  expect(result).toMatchObject({ extras: { handoffs: 1 } });
});
test("a message in a shared chat thread runs in that thread's own conversation", async () => {
  const f = fixture();
  const turns: unknown[] = [];
  const asked: unknown[] = [];
  const router = createDeliveryRouter({
    store: f.store,
    queue: f.queue,
    owner: "w",
    authoriseScope: async () => true,
    threadBinding: async (person, thread) => {
      asked.push(thread);
      return {
        ...person,
        identity: `${person.identity}#${thread.key}`,
        channelId: "thread-channel",
        threadId: "thread-conversation",
      };
    },
    runTurn: async (input) => {
      turns.push(input);
      return { replyText: "Reply" };
    },
    providers: {},
  });
  const converse = (externalId: string, thread?: string) =>
    router.converse({
      transport: "slack",
      realm: "T",
      identity: "U",
      externalId,
      text: "Hi",
      signal: new AbortController().signal,
      ...(thread ? { thread: { key: thread, title: "Hi" } } : {}),
    });
  expect(await converse("t1", "slack-thread-1")).toMatchObject({
    binding: { threadId: "thread-conversation" },
  });
  expect(turns[0]).toMatchObject({
    channelId: "thread-channel",
    threadId: "thread-conversation",
  });
  expect(asked).toEqual([{ key: "slack-thread-1", title: "Hi" }]);
  // A direct message names no thread and stays in the person's own conversation.
  await converse("t2");
  expect(turns[1]).toMatchObject(scope);
});
