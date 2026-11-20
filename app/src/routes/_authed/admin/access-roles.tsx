import {
  IconChevronRight,
  IconPlus,
  IconUsersGroup,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { PageEmpty, PageRows, PageShell } from "@/components/layout/page-shell";
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
import { createAccessRoleMutationOptions } from "@/lib/access-roles/mutations";
import {
  accessRoleListQueryOptions,
  accessRoleSummary,
} from "@/lib/access-roles/queries";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/admin/access-roles")({
  component: AccessRolesPage,
});

/**
 * Who may use which Bots (AP-280). One section, so it has no title of its own: the page title names
 * it. A role opens its own page, where its people are added and removed.
 */
function AccessRolesPage() {
  const roles = useQuery(accessRoleListQueryOptions());
  const [creating, setCreating] = React.useState(false);

  const newRole = (variant: "ghost" | "outline") => (
    <Button onClick={() => setCreating(true)} size="sm" variant={variant}>
      <IconPlus />
      New access role
    </Button>
  );

  return (
    <PageShell
      action={newRole("ghost")}
      description="A Bot that isn't open to everyone can be used by the people who share an access role with it. Admins can use every Bot."
      title="Access roles"
    >
      {roles.isPending ? null : roles.error ? (
        <p className="text-destructive text-sm" role="alert">
          Couldn't load access roles. Reload the page.
        </p>
      ) : roles.data.length === 0 ? (
        <PageEmpty
          action={newRole("outline")}
          icon={IconUsersGroup}
          title="No access roles yet"
        >
          Make one, add people to it, and name it on a Bot in agents.yaml.
        </PageEmpty>
      ) : (
        <PageRows>
          {roles.data.map((role, index) => (
            <React.Fragment key={role.id}>
              <Item
                render={
                  <Link
                    params={{ roleId: role.id }}
                    to="/admin/access-roles/$roleId"
                  />
                }
                size="sm"
              >
                <ItemMedia variant="icon">
                  <IconUsersGroup />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{role.name}</ItemTitle>
                  <ItemDescription>
                    {accessRoleSummary(role)}
                    {role.declared ? " · Named in agents.yaml" : ""}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <IconChevronRight className="size-4 text-muted-foreground" />
                </ItemActions>
              </Item>
              {index !== roles.data.length - 1 && <Separator />}
            </React.Fragment>
          ))}
        </PageRows>
      )}

      <NewAccessRoleDialog onOpenChange={setCreating} open={creating} />
    </PageShell>
  );
}

function NewAccessRoleDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const [name, setName] = React.useState("");
  const create = useMutation(createAccessRoleMutationOptions(queryClient));

  const close = (next: boolean) => {
    if (!next) {
      setName("");
      create.reset();
    }
    onOpenChange(next);
  };
  // Create, in the footer, submits the form by its id; Enter in the field does too.
  const submit = () =>
    create.mutate(name, {
      onSuccess: (role) => {
        close(false);
        void navigate({
          params: { roleId: role.id },
          to: "/admin/access-roles/$roleId",
        });
      },
    });

  return (
    <Dialog onOpenChange={close} open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New access role</DialogTitle>
          <DialogDescription>
            Name it after the people it is for, such as Nusa Auto or Finance.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="mt-4">
          {/* The form lives inside the body: DialogBody must stay a direct child of DialogContent. */}
          <form
            id="new-access-role"
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim()) submit();
            }}
          >
            <Field>
              <FieldLabel htmlFor="access-role-name">Name</FieldLabel>
              <Input
                autoFocus
                id="access-role-name"
                maxLength={100}
                onChange={(event) => setName(event.target.value)}
                value={name}
              />
            </Field>
          </form>
          {create.error ? (
            <p className="mt-3 text-destructive text-sm" role="alert">
              {create.error.message}
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
            disabled={!name.trim() || create.isPending}
            form="new-access-role"
            size="sm"
            type="submit"
          >
            {create.isPending ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
