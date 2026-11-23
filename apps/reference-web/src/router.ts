/** A hash router over a fixed set of routes. Anything else is the dashboard. The admin routes are listed in navigation order: Applications | Workflows (route `walkthroughs`) | Targets | Editor | Analytics. */
export const ADMIN_ROUTES = ["applications", "walkthroughs", "targets", "editor", "analytics"] as const;
export const ROUTES = ["dashboard", "profile", "settings", ...ADMIN_ROUTES] as const;
export const isAdminRoute = (route: Route): route is (typeof ADMIN_ROUTES)[number] => (ADMIN_ROUTES as readonly Route[]).includes(route);
export type Route = (typeof ROUTES)[number];

export interface Router {
  current(): Route;
  navigate(route: Route): void;
  subscribe(callback: (route: Route) => void): () => void;
}

export function createRouter(win: Window): Router {
  const current = (): Route => {
    const name = win.location.hash.replace(/^#\/?/, "");
    return (ROUTES as readonly string[]).includes(name) ? (name as Route) : "dashboard";
  };
  return {
    current,
    navigate(route) { win.location.hash = `#/${route}`; },
    subscribe(callback) {
      const listener = (): void => callback(current());
      win.addEventListener("hashchange", listener);
      return () => win.removeEventListener("hashchange", listener);
    },
  };
}
