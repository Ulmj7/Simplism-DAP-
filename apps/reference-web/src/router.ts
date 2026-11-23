/** A hash router over a fixed set of routes. Anything else is the dashboard. The admin routes are listed in navigation order: Applications | Workflows (route `walkthroughs`) | Targets | Editor | Analytics. */
export const ADMIN_ROUTES = ["applications", "walkthroughs", "targets", "editor", "analytics"] as const;
export const ROUTES = ["dashboard", "profile", "settings", ...ADMIN_ROUTES] as const;
export const isAdminRoute = (route: Route): route is (typeof ADMIN_ROUTES)[number] => (ADMIN_ROUTES as readonly Route[]).includes(route);
export type Route = (typeof ROUTES)[number];

/** A navigation guard: called with the route being left for and a `proceed` that completes it. Returning `true` BLOCKS the navigation (the page stays where it was until `proceed` is called). */
export type NavigationGuard = (to: Route, proceed: () => void) => boolean;
export interface Router {
  current(): Route;
  navigate(route: Route): void;
  subscribe(callback: (route: Route) => void): () => void;
  /** At most one guard (the editor's dirty guard); `undefined` removes it. */
  setGuard?(guard: NavigationGuard | undefined): void;
}

export function createRouter(win: Window): Router {
  const current = (): Route => {
    const name = win.location.hash.replace(/^#\/?/, "");
    return (ROUTES as readonly string[]).includes(name) ? (name as Route) : "dashboard";
  };
  let guard: NavigationGuard | undefined;
  let settled = current();
  let restoring = false;
  return {
    current,
    navigate(route) { win.location.hash = `#/${route}`; },
    setGuard(next) { guard = next; },
    subscribe(callback) {
      const listener = (): void => {
        if (restoring) { restoring = false; return; }
        const next = current();
        if (guard !== undefined && next !== settled) {
          const stay = settled;
          const proceed = (): void => { guard = undefined; win.location.hash = `#/${next}`; };
          // Blocked: the address goes back to the page that is still shown, and the guard decides what happens next.
          if (guard(next, proceed)) { restoring = true; win.location.hash = `#/${stay}`; return; }
        }
        settled = next;
        callback(next);
      };
      win.addEventListener("hashchange", listener);
      return () => win.removeEventListener("hashchange", listener);
    },
  };
}
