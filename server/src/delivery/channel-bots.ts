/**
 * Which Bot a Slack channel belongs to.
 *
 * The tenant package names one conversation per Bot (`channels.yaml`), and the team keeps a Slack
 * channel of the same name for each. A message in that Slack channel is for that Bot, whichever Bot
 * the person linked: `#00-30-cto` reaches the Bot of the package channel named `00-30-cto`. A Slack
 * channel no package channel is named after belongs to nobody, and the person's linked Bot answers
 * there as before.
 *
 * The name comes from OpenTag, which holds the workspace token, and is kept for a few minutes: a
 * renamed channel is noticed late, never wrongly for long. A failed lookup is retried sooner, so an
 * OpenTag that was briefly away does not leave a channel with the wrong Bot.
 */
const NAME_TTL_MS = 5 * 60_000;
const UNKNOWN_TTL_MS = 30_000;
const CACHE_LIMIT = 2_000;

const normalised = (name: string) =>
  name.trim().replace(/^#/, "").toLowerCase();

export type ChannelBots = (input: {
  teamId: string;
  channelId: string;
}) => Promise<string | null>;

export function createChannelBots(deps: {
  /** The tenant package's channels. One with a single Bot gives its name to a Slack channel. */
  channels: readonly { name: string; permittedAgents: readonly string[] }[];
  nameOf(input: { teamId: string; channelId: string }): Promise<string | null>;
  now?: () => number;
}): ChannelBots {
  const now = deps.now ?? Date.now;
  const bots = new Map<string, string>();
  const shared = new Set<string>();
  for (const channel of deps.channels) {
    const name = normalised(channel.name);
    const [bot, ...others] = channel.permittedAgents;
    // Two package channels of one name, or one with several Bots, name no single Bot.
    if (!bot || others.length || bots.has(name)) shared.add(name);
    else bots.set(name, bot);
  }
  for (const name of shared) bots.delete(name);
  const names = new Map<string, { name: string | null; until: number }>();

  return async (input) => {
    if (bots.size === 0) return null;
    const key = `${input.teamId}:${input.channelId}`;
    let entry = names.get(key);
    if (!entry || entry.until <= now()) {
      let name: string | null = null;
      try {
        name = await deps.nameOf(input);
      } catch {}
      entry = { name, until: now() + (name ? NAME_TTL_MS : UNKNOWN_TTL_MS) };
      names.delete(key);
      names.set(key, entry);
      while (names.size > CACHE_LIMIT) {
        const oldest = names.keys().next().value;
        if (oldest === undefined) break;
        names.delete(oldest);
      }
    }
    return entry.name ? (bots.get(normalised(entry.name)) ?? null) : null;
  };
}
