import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { type AccessRole, accessRoleKeys } from "./queries";

const FALLBACK = "Could not update that access role";

function invalidateAccessRoles(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: accessRoleKeys.all });
}

const rolePath = (roleId: string) =>
  `/api/admin/access-roles/${encodeURIComponent(roleId)}`;

export function createAccessRoleMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (name: string): Promise<AccessRole> =>
      client("/api/admin/access-roles", "role", {
        method: "POST",
        body: { name },
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateAccessRoles(queryClient),
  });
}

export function renameAccessRoleMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (variables: {
      roleId: string;
      name: string;
    }): Promise<AccessRole> =>
      client(rolePath(variables.roleId), "role", {
        method: "PATCH",
        body: { name: variables.name },
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateAccessRoles(queryClient),
  });
}

export function deleteAccessRoleMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (roleId: string): Promise<void> => {
      await client(rolePath(roleId), { method: "DELETE", fallback: FALLBACK });
    },
    onSuccess: () => invalidateAccessRoles(queryClient),
  });
}

const personPath = (roleId: string, userId: string) =>
  `${rolePath(roleId)}/people/${encodeURIComponent(userId)}`;

/** What adding somebody re-approved: the shared apps of the role's Bots, by Bot. */
export type SharedAppsReapproved = {
  botId: string;
  approved: { serverId: string; title: string }[];
  needsApproval: { serverId: string; title: string }[];
}[];

export function addAccessRolePersonMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      roleId: string;
      userId: string;
    }): Promise<{ role: AccessRole; sharedApps: SharedAppsReapproved }> =>
      (
        await client(personPath(variables.roleId, variables.userId), {
          method: "PUT",
          fallback: FALLBACK,
        })
      ).json(),
    onSuccess: () => invalidateAccessRoles(queryClient),
  });
}

export function removeAccessRolePersonMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: (variables: {
      roleId: string;
      userId: string;
    }): Promise<AccessRole> =>
      client(personPath(variables.roleId, variables.userId), "role", {
        method: "DELETE",
        fallback: FALLBACK,
      }),
    onSuccess: () => invalidateAccessRoles(queryClient),
  });
}
