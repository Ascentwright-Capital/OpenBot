import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AccessRole } from "@/lib/access-roles/queries";
import { accessRoleSummary } from "@/lib/access-roles/queries";
import { Route as AccessRolesRoute } from "@/routes/_authed/admin/access-roles";
import { Route as AccessRoleRoute } from "@/routes/_authed/admin/access-roles_.$roleId";
import { Route as PeopleRoute } from "@/routes/_authed/admin/people";

/**
 * The Access roles screens (AP-280): the list, one role's page, and the writes each makes. The
 * server is a fake that records what it is sent.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  await GlobalRegistrator.unregister();
});

type Routed = { options: object };
const routes = [
  AccessRolesRoute,
  AccessRoleRoute,
  PeopleRoute,
] as unknown as Routed[];
const pristine = routes.map((route) => ({
  ...route,
  options: { ...route.options },
}));
beforeEach(() => {
  routes.forEach((route, index) => {
    for (const key of Object.keys(route))
      if (!(key in pristine[index]!))
        delete (route as Record<string, unknown>)[key];
    Object.assign(route, pristine[index], {
      options: { ...pristine[index]!.options },
    });
  });
});

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const ALEX = { id: "u-alex", email: "alex@example.test", name: "Alex" };
const SAM = { id: "u-sam", email: "sam@example.test", name: null };

const role = (over: Partial<AccessRole> = {}): AccessRole => ({
  id: "r-people",
  name: "People team",
  declared: false,
  people: [ALEX],
  bots: [
    { id: "recruitment", name: "00-20 Recruitment", fromAgentsYaml: true },
  ],
  ...over,
});

const writes: string[] = [];
function serving(roles: AccessRole[]) {
  writes.length = 0;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    if (method !== "GET")
      writes.push(`${method} ${path} ${init?.body ?? ""}`.trim());
    if (path === "/api/me")
      return Response.json({
        user: { id: "me", role: "admin", email: "me@example.test" },
      });
    if (path.startsWith("/api/admin/people"))
      return Response.json({
        people: [
          {
            ...ALEX,
            image: null,
            role: "user",
            providers: ["google"],
            lastSignedInAt: null,
            revoked: false,
            configuredAdmin: false,
          },
          {
            ...SAM,
            image: null,
            role: "user",
            providers: ["google"],
            lastSignedInAt: null,
            revoked: false,
            configuredAdmin: false,
          },
        ],
        nextCursor: null,
      });
    if (path === "/api/admin/access-roles" && method === "GET")
      return Response.json({ roles });
    if (path === "/api/admin/access-roles" && method === "POST")
      return Response.json(
        { role: role({ id: "r-new", name: "Finance", people: [], bots: [] }) },
        { status: 201 },
      );
    if (path.includes("/people/") && method === "PUT")
      return Response.json({
        role: role({ people: [ALEX, SAM] }),
        sharedApps: [
          {
            botId: "recruitment",
            approved: [{ serverId: "linear", title: "Linear" }],
            needsApproval: [],
          },
        ],
      });
    if (path.includes("/people/") && method === "DELETE")
      return Response.json({ role: role({ people: [] }) });
    if (method === "DELETE") return new Response(null, { status: 204 });
    return Response.json({ error: "unexpected" }, { status: 404 });
  }) as typeof fetch;
}

function open(path: string) {
  const root = createRootRoute({ component: Outlet });
  const authed = createRoute({
    id: "/_authed",
    getParentRoute: () => root,
    component: Outlet,
  });
  const admin = createRoute({
    path: "/admin",
    getParentRoute: () => authed,
    component: Outlet,
  });
  const wire = (route: unknown, id: string, at: string) =>
    (route as { update: (options: unknown) => never }).update({
      id,
      path: at,
      getParentRoute: () => admin,
    });
  const router = createRouter({
    routeTree: root.addChildren([
      authed.addChildren([
        admin.addChildren([
          wire(AccessRolesRoute, "/access-roles", "/access-roles"),
          wire(PeopleRoute, "/people", "/people"),
          wire(
            AccessRoleRoute,
            "/access-roles_/$roleId",
            "/access-roles/$roleId",
          ),
        ]),
      ]),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const view = render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return { view, router };
}

test("a role's summary counts its people and Bots", () => {
  expect(accessRoleSummary(role())).toBe("1 person · 1 Bot");
  expect(accessRoleSummary(role({ people: [ALEX, SAM], bots: [] }))).toBe(
    "2 people · no Bots",
  );
  expect(accessRoleSummary(role({ people: [] }))).toBe("No people · 1 Bot");
});

test("the list shows each role with its counts, and says when agents.yaml names it", async () => {
  serving([
    role({ declared: true }),
    role({ id: "r-fin", name: "Finance", people: [], bots: [] }),
  ]);
  const { view } = open("/admin/access-roles");

  expect(await view.findByText("People team")).toBeTruthy();
  expect(
    view.getByText("1 person · 1 Bot · Named in agents.yaml"),
  ).toBeTruthy();
  expect(view.getByText("No people · no Bots")).toBeTruthy();
});

test("with no roles it says so, and a new role opens its own page", async () => {
  serving([]);
  const { view, router } = open("/admin/access-roles");

  expect(await view.findByText("No access roles yet")).toBeTruthy();
  fireEvent.click(view.getAllByRole("button", { name: "New access role" })[0]!);
  const user = userEvent.setup({ document });
  await user.type(
    await view.findByRole("textbox", { name: "Name" }),
    "Finance",
  );
  // happy-dom does not submit through a button's `form` attribute, so submit the form itself.
  // form-submit-controls.test.ts checks that Create names this form.
  const field = view.getByRole("textbox", { name: "Name" });
  fireEvent.submit(field.closest("form") as HTMLFormElement);

  await waitFor(() =>
    expect(writes).toEqual(['POST /api/admin/access-roles {"name":"Finance"}']),
  );
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/admin/access-roles/r-new"),
  );
});

test("adding somebody puts them in the role and names the apps re-approved for them", async () => {
  serving([role()]);
  const { view } = open("/admin/access-roles/r-people");

  fireEvent.click(await view.findByRole("button", { name: "Add person" }));
  // Alex is already in the role, so only Sam is offered.
  fireEvent.click(await view.findByText("sam@example.test"));

  await waitFor(() =>
    expect(writes).toEqual([
      "PUT /api/admin/access-roles/r-people/people/u-sam",
    ]),
  );
  expect(
    await view.findByText(
      "Linear is now approved for them through this role's Bots.",
    ),
  ).toBeTruthy();
});

test("removing somebody takes them out of the role", async () => {
  serving([role()]);
  const { view } = open("/admin/access-roles/r-people");

  fireEvent.click(await view.findByRole("button", { name: "Remove" }));

  await waitFor(() =>
    expect(writes).toEqual([
      "DELETE /api/admin/access-roles/r-people/people/u-alex",
    ]),
  );
});

test("a role agents.yaml names can't be renamed or deleted here", async () => {
  serving([role({ declared: true })]);
  const { view } = open("/admin/access-roles/r-people");

  expect(
    await view.findByText(
      "agents.yaml names this role. Rename or delete it there.",
    ),
  ).toBeTruthy();
  expect(view.queryByRole("button", { name: "Delete" })).toBeNull();
});

test("deleting asks first, then returns to the list", async () => {
  serving([role()]);
  const { view, router } = open("/admin/access-roles/r-people");

  fireEvent.click(await view.findByRole("button", { name: "Delete" }));
  expect(writes).toEqual([]);
  expect(await view.findByText("Delete People team?")).toBeTruthy();
  const buttons = view.getAllByRole("button", { name: "Delete" });
  fireEvent.click(buttons[buttons.length - 1]!);

  await waitFor(() =>
    expect(writes).toEqual(["DELETE /api/admin/access-roles/r-people"]),
  );
  await waitFor(() =>
    expect(router.state.location.pathname).toBe("/admin/access-roles"),
  );
});

test("the People page lists each person's access roles", async () => {
  serving([role(), role({ id: "r-fin", name: "Finance", bots: [] })]);
  const { view } = open("/admin/people");

  expect(
    await view.findByText(/alex@example\.test · .* · In People team, Finance$/),
  ).toBeTruthy();
  // Sam is in no role, so only Alex's row ends with "In …".
  expect(view.getAllByText(/ · In /)).toHaveLength(1);
});
