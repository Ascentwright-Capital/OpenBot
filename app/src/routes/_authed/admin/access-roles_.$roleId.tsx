import {
  IconChevronRight,
  IconPencil,
  IconPlus,
  IconRobot,
  IconSearch,
  IconTrash,
  IconUser,
  IconUsers,
} from "@tabler/icons-react";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import * as React from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  addAccessRolePersonMutationOptions,
  deleteAccessRoleMutationOptions,
  removeAccessRolePersonMutationOptions,
  renameAccessRoleMutationOptions,
} from "@/lib/access-roles/mutations";
import {
  type AccessRole,
  accessRoleListQueryOptions,
} from "@/lib/access-roles/queries";
import { peopleListQueryOptions } from "@/lib/people/queries";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/admin/access-roles_/$roleId")({
  component: AccessRolePage,
});

const BACK = {
  label: "Access roles",
  linkProps: { to: "/admin/access-roles" as const },
};

/**
 * One access role: who is in it, which Bots it opens, and its name.
 *
 * Read out of the list rather than fetched alone: a deployment has a handful of roles, and the list
 * is the query every write already invalidates.
 */
function AccessRolePage() {
  const { roleId } = Route.useParams();
  const roles = useQuery(accessRoleListQueryOptions());
  const role = roles.data?.find((candidate) => candidate.id === roleId);

  // Pending draws the frame and nothing under it: no placeholder, per the data-access rules.
  if (roles.isPending)
    return (
      <PageShell backButton={BACK} title="Access role">
        {null}
      </PageShell>
    );
  if (roles.error || !role) {
    return (
      <PageShell backButton={BACK} title="Access role">
        <p className="text-destructive text-sm" role="alert">
          {roles.error
            ? "Couldn't load this access role. Reload the page."
            : "This access role doesn't exist anymore."}
        </p>
      </PageShell>
    );
  }
  return <AccessRoleDetail role={role} />;
}

function AccessRoleDetail({ role }: { role: AccessRole }) {
  const [adding, setAdding] = React.useState(false);
  const [renaming, setRenaming] = React.useState(false);
  const remove = useMutation(
    removeAccessRolePersonMutationOptions(queryClient),
  );
  const add = useMutation(addAccessRolePersonMutationOptions(queryClient));
  const reapproved = [
    ...new Set(
      (add.data?.sharedApps ?? []).flatMap((bot) =>
        bot.approved.map((app) => app.title),
      ),
    ),
  ];

  const addPerson = (variant: "ghost" | "outline") => (
    <Button onClick={() => setAdding(true)} size="sm" variant={variant}>
      <IconPlus />
      Add person
    </Button>
  );

  return (
    <PageShell
      backButton={BACK}
      description="The people here can use this role's Bots, even the ones that aren't open to everyone."
      title={role.name}
    >
      <PageSection action={addPerson("ghost")} title="People">
        {remove.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            {remove.error.message}
          </p>
        ) : null}
        {reapproved.length > 0 ? (
          <p className="mt-4 text-muted-foreground text-sm" role="status">
            {reapproved.join(", ")} {reapproved.length === 1 ? "is" : "are"} now
            approved for them through this role's Bots.
          </p>
        ) : null}
        {role.people.length === 0 ? (
          <PageEmpty
            action={addPerson("outline")}
            icon={IconUsers}
            title="Nobody here yet"
          >
            People you add can use this role's Bots.
          </PageEmpty>
        ) : (
          <PageRows>
            {role.people.map((person, index) => (
              <React.Fragment key={person.id}>
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconUser />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{person.name ?? person.email}</ItemTitle>
                    {person.name ? (
                      <ItemDescription>{person.email}</ItemDescription>
                    ) : null}
                  </ItemContent>
                  <ItemActions>
                    <Button
                      disabled={remove.isPending}
                      onClick={() =>
                        remove.mutate({ roleId: role.id, userId: person.id })
                      }
                      size="sm"
                      variant="ghost"
                    >
                      Remove
                    </Button>
                  </ItemActions>
                </Item>
                {index !== role.people.length - 1 && <Separator />}
              </React.Fragment>
            ))}
          </PageRows>
        )}
      </PageSection>

      <PageSection
        description="Bots join an access role in agents.yaml, under access_roles."
        title="Bots"
      >
        {role.bots.length === 0 ? (
          <PageEmpty icon={IconRobot} title="No Bots yet">
            Name this role on a Bot in agents.yaml to add it.
          </PageEmpty>
        ) : (
          <PageRows>
            {role.bots.map((bot, index) => (
              <React.Fragment key={bot.id}>
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconRobot />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{bot.name}</ItemTitle>
                  </ItemContent>
                  {bot.fromAgentsYaml ? (
                    <ItemActions>
                      <span className="text-muted-foreground text-xs">
                        From agents.yaml
                      </span>
                    </ItemActions>
                  ) : null}
                </Item>
                {index !== role.bots.length - 1 && <Separator />}
              </React.Fragment>
            ))}
          </PageRows>
        )}
      </PageSection>

      <PageSection
        description={
          role.declared
            ? "agents.yaml names this role. Rename or delete it there."
            : undefined
        }
        title="This access role"
      >
        <PageRows>
          {role.declared ? (
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconPencil />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>Name</ItemTitle>
              </ItemContent>
              <ItemActions>
                <span className="text-muted-foreground text-sm">
                  {role.name}
                </span>
              </ItemActions>
            </Item>
          ) : (
            <>
              <Item
                render={
                  <button onClick={() => setRenaming(true)} type="button" />
                }
                size="sm"
              >
                <ItemMedia variant="icon">
                  <IconPencil />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>Name</ItemTitle>
                  <ItemDescription>{role.name}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <IconChevronRight className="size-4 text-muted-foreground" />
                </ItemActions>
              </Item>
              <Separator />
              <DeleteRow role={role} />
            </>
          )}
        </PageRows>
      </PageSection>

      <AddPersonDialog
        error={add.error?.message ?? null}
        onOpenChange={(next) => {
          if (!next) add.reset();
          setAdding(next);
        }}
        onPick={(userId) =>
          add.mutate(
            { roleId: role.id, userId },
            { onSuccess: () => setAdding(false) },
          )
        }
        open={adding}
        pending={add.isPending}
        role={role}
      />
      <RenameDialog onOpenChange={setRenaming} open={renaming} role={role} />
    </PageShell>
  );
}

function DeleteRow({ role }: { role: AccessRole }) {
  const navigate = useNavigate();
  const [confirming, setConfirming] = React.useState(false);
  const remove = useMutation(deleteAccessRoleMutationOptions(queryClient));
  return (
    <>
      <Item size="sm">
        <ItemMedia variant="icon">
          <IconTrash />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>Delete this access role</ItemTitle>
          <ItemDescription>
            Its people lose the Bots they could only use through it.
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <Button
            onClick={() => setConfirming(true)}
            size="sm"
            variant="destructive"
          >
            Delete
          </Button>
        </ItemActions>
      </Item>
      <Dialog
        onOpenChange={(next) => {
          if (!next) remove.reset();
          setConfirming(next);
        }}
        open={confirming}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {role.name}?</DialogTitle>
            <DialogDescription>
              {role.people.length === 0
                ? "Nobody is in it."
                : `${role.people.length} ${role.people.length === 1 ? "person loses" : "people lose"} the Bots they could only use through it.`}
            </DialogDescription>
          </DialogHeader>
          {remove.error ? (
            <p className="mt-4 text-destructive text-sm" role="alert">
              {remove.error.message}
            </p>
          ) : null}
          <DialogFooter className="mt-4">
            <Button
              onClick={() => setConfirming(false)}
              size="sm"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              disabled={remove.isPending}
              onClick={() =>
                remove.mutate(role.id, {
                  onSuccess: () => void navigate({ to: "/admin/access-roles" }),
                })
              }
              size="sm"
              variant="destructive"
            >
              {remove.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** A picker: the page owns the write, so the note about re-approved apps outlives the dialog. */
function AddPersonDialog({
  error,
  open,
  onOpenChange,
  onPick,
  pending,
  role,
}: {
  error: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (userId: string) => void;
  pending: boolean;
  role: AccessRole;
}) {
  const [search, setSearch] = React.useState("");
  const [query, setQuery] = React.useState("");
  React.useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const people = useInfiniteQuery({
    ...peopleListQueryOptions(query),
    enabled: open,
  });
  const inRole = new Set(role.people.map((person) => person.id));
  const candidates = (people.data?.pages.flatMap((page) => page.people) ?? [])
    .filter((person) => !person.revoked && !inRole.has(person.id))
    .slice(0, 8);

  const close = (next: boolean) => {
    if (!next) setSearch("");
    onOpenChange(next);
  };

  return (
    <Dialog onOpenChange={close} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add somebody to {role.name}</DialogTitle>
          <DialogDescription>
            Only people who have signed in to OpenBot are listed.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4 overflow-y-auto">
          <Input
            aria-label="Search people"
            autoFocus
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by name or address"
            value={search}
          />
          {error ? (
            <p className="mt-3 text-destructive text-sm" role="alert">
              {error}
            </p>
          ) : null}
          {people.isPending ? null : people.error ? (
            <p className="mt-3 text-destructive text-sm" role="alert">
              Couldn't load people. Try again.
            </p>
          ) : candidates.length === 0 ? (
            <PageEmpty icon={IconSearch} title="No matches">
              {query
                ? `Nobody else matches "${query}".`
                : "Everybody who has signed in is already here."}
            </PageEmpty>
          ) : (
            <div className="mt-3 flex flex-col gap-1">
              {candidates.map((person) => (
                <Item
                  key={person.id}
                  render={
                    <button
                      disabled={pending}
                      onClick={() => onPick(person.id)}
                      type="button"
                    />
                  }
                  size="sm"
                  variant="muted"
                >
                  <ItemMedia variant="icon">
                    <IconUser />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{person.name ?? person.email}</ItemTitle>
                    {person.name ? (
                      <ItemDescription>{person.email}</ItemDescription>
                    ) : null}
                  </ItemContent>
                </Item>
              ))}
            </div>
          )}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button onClick={() => close(false)} size="sm" variant="ghost">
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RenameDialog({
  open,
  onOpenChange,
  role,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  role: AccessRole;
}) {
  const [name, setName] = React.useState(role.name);
  const rename = useMutation(renameAccessRoleMutationOptions(queryClient));
  React.useEffect(() => {
    if (open) setName(role.name);
  }, [open, role.name]);

  const close = (next: boolean) => {
    if (!next) rename.reset();
    onOpenChange(next);
  };
  const unchanged = !name.trim() || name.trim() === role.name;
  // Save, in the footer, submits the form by its id; Enter in the field does too.
  const submit = () =>
    rename.mutate({ roleId: role.id, name }, { onSuccess: () => close(false) });

  return (
    <Dialog onOpenChange={close} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename {role.name}</DialogTitle>
          <DialogDescription>
            Its people and Bots stay as they are.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4">
          <form
            id="rename-access-role"
            onSubmit={(event) => {
              event.preventDefault();
              if (!unchanged) submit();
            }}
          >
            <Field>
              <FieldLabel htmlFor="access-role-rename">Name</FieldLabel>
              <Input
                autoFocus
                id="access-role-rename"
                maxLength={100}
                onChange={(event) => setName(event.target.value)}
                value={name}
              />
            </Field>
          </form>
          {rename.error ? (
            <p className="mt-3 text-destructive text-sm" role="alert">
              {rename.error.message}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter className="mt-4">
          <Button
            onClick={() => close(false)}
            size="sm"
            type="button"
            variant="ghost"
          >
            Cancel
          </Button>
          <Button
            disabled={unchanged || rename.isPending}
            form="rename-access-role"
            size="sm"
            type="submit"
          >
            {rename.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
