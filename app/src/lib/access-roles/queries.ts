import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * A named set of people and Bots (AP-280). A person may use a Bot that isn't open to everyone when
 * they share an access role with it.
 */
export type AccessRole = {
  id: string;
  name: string;
  /**
   * The server's verdict that agents.yaml names this role. It is then renamed and deleted there, so
   * the screen offers neither.
   */
  declared: boolean;
  people: { id: string; email: string; name: string | null }[];
  bots: { id: string; name: string; fromAgentsYaml: boolean }[];
};

export const accessRoleKeys = {
  all: ["access-roles"] as const,
  list: () => ["access-roles", "list"] as const,
};

/** Every access role, with its people and its Bots. Admins only. */
export function accessRoleListQueryOptions() {
  return queryOptions({
    queryKey: accessRoleKeys.list(),
    queryFn: (): Promise<AccessRole[]> =>
      client("/api/admin/access-roles", "roles", {
        fallback: "Could not load access roles",
      }),
  });
}

/** "3 people · 2 Bots", for a role's row. */
export function accessRoleSummary(role: AccessRole): string {
  const people = role.people.length;
  const bots = role.bots.length;
  return [
    people === 0
      ? "No people"
      : `${people} ${people === 1 ? "person" : "people"}`,
    bots === 0 ? "no Bots" : `${bots} ${bots === 1 ? "Bot" : "Bots"}`,
  ].join(" · ");
}
