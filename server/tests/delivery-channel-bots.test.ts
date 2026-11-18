import { expect, test } from "bun:test";
import { createChannelBots } from "../src/delivery/channel-bots";

const channels = [
  { name: "00-00-factory-master", permittedAgents: ["orchestrator"] },
  { name: "00-30-cto", permittedAgents: ["cto"] },
  { name: "war-room", permittedAgents: ["cto", "analytics"] },
  { name: "twice", permittedAgents: ["cto"] },
  { name: "Twice", permittedAgents: ["analytics"] },
  { name: "empty", permittedAgents: [] },
];
const ask = (channelId: string) => ({ teamId: "T1", channelId });

test("a Slack channel named after a package channel belongs to that channel's Bot", async () => {
  const names: Record<string, string | null> = {
    C1: "00-30-cto",
    C2: "#00-00-Factory-Master",
    C3: "random",
    C4: "war-room",
    C5: "twice",
    C6: "empty",
    D1: null,
  };
  const bot = createChannelBots({
    channels,
    nameOf: async ({ channelId }) => names[channelId] ?? null,
  });
  expect(await bot(ask("C1"))).toBe("cto");
  expect(await bot(ask("C2"))).toBe("orchestrator");
  // Nobody's: no package channel of that name, several Bots, a name used twice, no Bot, no name.
  for (const id of ["C3", "C4", "C5", "C6", "D1"])
    expect(await bot(ask(id))).toBeNull();
});

test("a name is kept for a few minutes, and a failed lookup is retried sooner", async () => {
  let now = 0;
  let name: string | null = "00-30-cto";
  let fails = false;
  const asked: string[] = [];
  const bot = createChannelBots({
    channels,
    now: () => now,
    nameOf: async ({ channelId }) => {
      asked.push(channelId);
      if (fails) throw new Error("OpenTag is away");
      return name;
    },
  });
  expect(await bot(ask("C1"))).toBe("cto");
  name = "random";
  now = 4 * 60_000;
  expect(await bot(ask("C1"))).toBe("cto");
  expect(asked).toHaveLength(1);
  // The channel was renamed: noticed once the name is asked for again.
  now = 6 * 60_000;
  expect(await bot(ask("C1"))).toBeNull();
  expect(asked).toHaveLength(2);

  fails = true;
  expect(await bot(ask("C9"))).toBeNull();
  now += 10_000;
  expect(await bot(ask("C9"))).toBeNull();
  expect(asked.filter((id) => id === "C9")).toHaveLength(1);
  fails = false;
  name = "00-30-cto";
  now += 30_000;
  expect(await bot(ask("C9"))).toBe("cto");
  // Another workspace's channel of the same id is its own entry.
  expect(await bot({ teamId: "T2", channelId: "C9" })).toBe("cto");
  expect(asked.filter((id) => id === "C9")).toHaveLength(3);
});

test("a package without single-Bot channels never asks OpenTag", async () => {
  let asked = 0;
  const bot = createChannelBots({
    channels: [{ name: "war-room", permittedAgents: ["a", "b"] }],
    nameOf: async () => {
      asked += 1;
      return "war-room";
    },
  });
  expect(await bot(ask("C1"))).toBeNull();
  expect(asked).toBe(0);
});
