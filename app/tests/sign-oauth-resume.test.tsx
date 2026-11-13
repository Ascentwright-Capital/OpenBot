import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { authKeys } from "@/lib/auth/queries";

/*
 * The sign-in screen handing an interrupted Claude authorization back to the server.
 *
 * When an MCP client sends a signed-out person to authorize, the server sends them to `/sign` with
 * the request's own parameters. Whichever way they sign in, the browser must come back to
 * `/api/auth/oauth2/authorize` with those parameters, or they sign in and land on the home screen
 * with Claude still waiting. `oauth-resume.test.ts` pins the path that is built; this pins that the
 * screen uses it. The Better Auth client is replaced at the module boundary, as in
 * `sign-resume.test.tsx`.
 */
type Starter = (
  subject: string,
  start: unknown,
  callbackURL?: string,
) => Promise<void>;

const realAuthClient = { ...(await import("@/lib/auth/client")) };
let signInSpy: Starter = async () => {};
let domainSignInSpy: Starter = async () => {};

mock.module("@/lib/auth/client", () => ({
  providerName: () => "Google",
  signInWith: (...args: Parameters<Starter>) => signInSpy(...args),
  signInWithEmailDomain: (...args: Parameters<Starter>) =>
    domainSignInSpy(...args),
}));

const { Route } = await import("@/routes/sign");

const ORIGIN = "http://localhost:3010";
// As the server sends it: the authorization request, plus `prompt` and its own signature.
const ARRIVED =
  "?response_type=code&client_id=c1&redirect_uri=http%3A%2F%2Flocalhost%3A6274%2Fcallback&scope=openbot%3Amanage&state=s1&code_challenge=x&code_challenge_method=S256&resource=http%3A%2F%2Flocalhost%3A3010%2Fapi%2Fmcp&prompt=login&exp=1&sig=abc";
const RESUME =
  "/api/auth/oauth2/authorize?response_type=code&client_id=c1&redirect_uri=http%3A%2F%2Flocalhost%3A6274%2Fcallback&scope=openbot%3Amanage&state=s1&code_challenge=x&code_challenge_method=S256&resource=http%3A%2F%2Flocalhost%3A3010%2Fapi%2Fmcp";

function setUrl(url: string) {
  (
    window as unknown as { happyDOM: { setURL(url: string): void } }
  ).happyDOM.setURL(url);
}

beforeAll(() => {
  GlobalRegistrator.register();
  setUrl(`${ORIGIN}/sign${ARRIVED}`);
});

afterEach(() => {
  cleanup();
});

afterAll(() => {
  // Module mocks are process-wide in bun: hand the real client back to whatever runs next.
  mock.module("@/lib/auth/client", () => realAuthClient);
  GlobalRegistrator.unregister();
});

function renderSignScreen(options: {
  providers: string[];
  sso: boolean;
  ssoRequired: boolean;
}) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(authKeys.providers(), options);
  queryClient.setQueryData(authKeys.currentUser(), null);
  const root = createRootRoute();
  const sign = Route.update({
    id: "/sign",
    path: "/sign",
    getParentRoute: () => root,
  } as never);
  // The route tree is assembled by hand, so its types cannot describe it.
  const router = createRouter({
    routeTree: root.addChildren([sign]),
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [`/sign${ARRIVED}`] }),
  } as never) as never;
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return {
    view,
    user: userEvent.setup({ document: view.container.ownerDocument }),
  };
}

test("somebody already signed in is sent straight back to the authorization, as a document navigation", async () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(authKeys.currentUser(), { id: "u1" });
  const beforeLoad = Route.options.beforeLoad as (a: unknown) => Promise<void>;
  let thrown: { options: { href?: string; reloadDocument?: boolean } } = {
    options: {},
  };
  try {
    await beforeLoad({ context: { queryClient }, search: {} });
  } catch (redirect) {
    thrown = redirect as typeof thrown;
  }
  expect(thrown.options.href).toBe(RESUME);
  // An API path is not a route in this app: only leaving the app reaches it.
  expect(thrown.options.reloadDocument).toBe(true);
});

test("a provider button returns the browser to the authorization", async () => {
  const asked: string[] = [];
  signInSpy = async (_provider, _start, callbackURL) => {
    asked.push(callbackURL ?? "");
  };
  const { view, user } = renderSignScreen({
    providers: ["google"],
    sso: false,
    ssoRequired: false,
  });
  await user.click(await view.findByText(/Continue with Google/));
  await waitFor(() => expect(asked).toHaveLength(1));
  expect(asked[0]).toBe(`${ORIGIN}${RESUME}`);
});

test("the company-account form returns the browser to the authorization", async () => {
  const asked: string[] = [];
  domainSignInSpy = async (_email, _start, callbackURL) => {
    asked.push(callbackURL ?? "");
  };
  const { view, user } = renderSignScreen({
    providers: [],
    sso: true,
    ssoRequired: false,
  });
  await user.type(
    await view.findByPlaceholderText("you@company.com"),
    "someone@company.com",
  );
  await user.click(await view.findByText(/Continue with your company account/));
  await waitFor(() => expect(asked).toHaveLength(1));
  expect(asked[0]).toBe(`${ORIGIN}${RESUME}`);
});

test("an ordinary arrival still returns to the origin", async () => {
  setUrl(`${ORIGIN}/sign`);
  const asked: string[] = [];
  signInSpy = async (_provider, _start, callbackURL) => {
    asked.push(callbackURL ?? "");
  };
  const { view, user } = renderSignScreen({
    providers: ["google"],
    sso: false,
    ssoRequired: false,
  });
  await user.click(await view.findByText(/Continue with Google/));
  await waitFor(() => expect(asked).toHaveLength(1));
  expect(asked[0]).toBe(ORIGIN);
});
