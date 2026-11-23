import { createSemanticRegistry, createWalkthroughCatalog, createWalkthroughRuntime } from "@dap/walkthrough";
import type { EngineSnapshot, RouterPort, WalkthroughDef } from "@dap/walkthrough";
import { createAvailabilityFeed, createOverlay, createSemanticBridge, createTargets } from "@dap/walkthrough/dom";
import { createPresenter } from "../presenter.js";
import { createStatusDialog, resultKind } from "../status-dialog.js";
import { checkPostconditions } from "./checks.js";
import type { CheckDef } from "./checks.js";
import type { FailureCode, ManagedBundle, RunFailure, RunStatus } from "./protocol.js";

/** Hash-routed applications (V1B): a page is `pathname + hash`; navigating only sets the hash of a page on the current pathname. */
export function managedRouter(location: Pick<Location, "pathname" | "hash">, pages: Readonly<Record<string, string>>): RouterPort {
  const byPage = new Map(Object.entries(pages));
  const byRoute = new Map([...byPage].map(([page, route]) => [route, page]));
  return {
    current: () => byPage.get(location.pathname + location.hash) ?? "",
    navigate(route) {
      const page = byRoute.get(route);
      if (!page) return;
      const hash = page.indexOf("#");
      if ((hash < 0 ? page : page.slice(0, hash)) === location.pathname) location.hash = hash < 0 ? "" : page.slice(hash);
    },
  };
}

/** The page of a pathname: a trailing slash is not part of it (except for the root). Query and fragment are never looked at. */
export const historyPageOfPath = (pathname: string): string => (pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname);

/**
 * History-routed applications (Studio completion S1): a page is the PATHNAME. `navigate` uses `history.pushState` and then dispatches `popstate`, so the application's own router (which
 * listens for popstate) renders the page; `history` itself is never patched.
 */
export function historyRouter(win: Pick<Window, "location" | "history" | "dispatchEvent">, pages: Readonly<Record<string, string>>): RouterPort {
  const byPage = new Map(Object.entries(pages));
  const byRoute = new Map([...byPage].map(([page, route]) => [route, page]));
  return {
    current: () => byPage.get(historyPageOfPath(win.location.pathname)) ?? "",
    navigate(route) {
      const page = byRoute.get(route);
      if (!page || historyPageOfPath(win.location.pathname) === page) return;
      win.history.pushState(null, "", page);
      win.dispatchEvent(new PopStateEvent("popstate"));
    },
  };
}

export const POLL_MS = 250;
const active = (status: EngineSnapshot["status"]) => status === "RESOLVING" || status === "PRESENTING" || status === "WAITING" || status === "VERIFYING";

/**
 * Maps the engine's snapshot to the additive run diagnostics: step position, failure code and the NAMES involved (target id, routes, check). Never a value, text or any other content of the page.
 * The target is reported by its durable DAP id, not by the marker the page carries.
 */
export function diagnose(snapshot: EngineSnapshot, definition: WalkthroughDef, checks: readonly CheckDef[], currentRoute: string): RunStatus | null {
  if (snapshot.status === "IDLE") return null;
  const status = snapshot.status;
  const index = snapshot.stepId === null ? -1 : definition.steps.findIndex(step => step.id === snapshot.stepId);
  const position = index < 0 ? {} : { stepIndex: index, stepCount: definition.steps.length };
  if (status === "CANCELLED") return { status, ...position, failure: { code: "cancelled" } };
  if (status !== "FAILED") return { status, ...position };
  const step = index < 0 ? undefined : definition.steps[index];
  const named = (code: FailureCode, extra: Partial<RunFailure> = {}): RunStatus => ({ status, ...position, failure: { code, ...extra } });
  const here = currentRoute === "" ? {} : { currentRoute };
  switch (snapshot.failure) {
    case "target_unavailable": return named("target_unavailable", step?.kind === "guide" ? { targetId: step.target } : {});
    case "verification_failed": {
      const verify = step?.kind === "guide" ? step.verify : undefined;
      if (verify === undefined) return named("verification_failed");
      const check = checks.find(item => item.name === verify);
      if (verify.startsWith("route.")) return named("route_mismatch", { expectedRoute: verify.slice(6), ...here });
      if (check?.kind === "route.equals") return named("route_mismatch", { expectedRoute: check.route, check: verify, ...here });
      return named("verification_failed", { check: verify, ...(check === undefined ? {} : { targetId: check.targetId }) });
    }
    case "navigation_refused": return named("route_mismatch", step?.kind === "navigate" ? { expectedRoute: step.route, ...here } : here);
    case "max_attempts": return named("timeout");
    default: return named("invalid");
  }
}

export interface MountOptions {
  readonly window: Window;
  readonly bundle: ManagedBundle;
  readonly trustedEventsOnly?: boolean;
  /** Called when the status or the step changes (never for IDLE). */
  readonly onStatus: (status: RunStatus) => void;
  /** Called when the maintainer closes the result dialog of a finished run (standalone delivery uses it to tear the run down). */
  readonly onDismiss?: () => void;
  readonly onUnexpectedRoute?: () => void;
}

export function mountManagedRuntime({ window: win, bundle, trustedEventsOnly = true, onStatus, onDismiss, onUnexpectedRoute }: MountOptions) {
  const doc = win.document;
  const root = doc.body;
  if (!root) return { ok: false, reason: "invalid_bundle" } as const;
  const history = bundle.registry.routing === "history";
  const checks: readonly CheckDef[] = bundle.registry.checks ?? [];
  // The registry the engine and the DOM use is built over MARKERS (what the page carries in `data-ai-id`); the definition's durable DAP target ids are mapped to them locally. Stored definitions are
  // never rewritten: the mapped copy only lives in this run, and it is validated by the same catalog as before.
  const markerOf = new Map(bundle.registry.elements.map(item => [item.id, item.marker ?? item.id]));
  const roleOf = new Map(bundle.registry.elements.map(item => [item.id, item.role as string]));
  const mapped: WalkthroughDef = { ...bundle.definition, steps: bundle.definition.steps.map(step => (step.kind === "guide" ? { ...step, target: markerOf.get(step.target) ?? step.target } : step)) };
  let registry;
  try { registry = createSemanticRegistry({ routes: bundle.registry.routes, elements: bundle.registry.elements.map(({ marker, ...item }) => ({ ...item, id: marker ?? item.id })) }); }
  catch { return { ok: false, reason: "invalid_registry" } as const; }
  let catalog;
  try { catalog = createWalkthroughCatalog(registry, bundle.registry.postconditionNames, [mapped]); }
  catch { return { ok: false, reason: "invalid_bundle" } as const; }
  const router = history ? historyRouter(win, bundle.registry.pages) : managedRouter(win.location, bundle.registry.pages);
  const postconditions = checkPostconditions(bundle.registry.routes, checks, { root, route: () => router.current(), markerOf: id => markerOf.get(id), roleOf: id => roleOf.get(id) });
  const pageTargets = createTargets(root, registry);
  const targets = onUnexpectedRoute === undefined ? pageTargets : {
    ...pageTargets,
    find: (id: string) => registry.get(id)?.route === router.current() ? pageTargets.find(id) : null,
  };
  const overlay = createOverlay(doc);
  const dialog = createStatusDialog(doc, () => null);
  const presenter = createPresenter({ overlay, targets, registry, catalog, state: () => runtime.getState(),
    cancel: () => runtime.cancel(), ack: () => runtime.dispatch({ type: "ack" }), complete: text => dialog.updateText(text) });
  const runtime = createWalkthroughRuntime({ registry, catalog, router, postconditions, presenter,
    targets: { resolve: id => targets.find(id) ? "available" : "unavailable" },
    timers: { set: (callback, ms) => { const handle = win.setTimeout(callback, ms); return () => win.clearTimeout(handle); } } });
  const checkRoute = () => {
    const snapshot = runtime.getState();
    if (snapshot.status !== "WAITING" && snapshot.status !== "RESOLVING") return;
    const step = catalog.get(bundle.definition.id)?.steps.find(item => item.id === snapshot.stepId);
    if (step?.kind === "guide" && registry.get(step.target)?.route !== router.current()) onUnexpectedRoute?.();
  };
  const interactionEvents = ["click", "input", "change"] as const;
  if (onUnexpectedRoute) for (const event of interactionEvents) root.addEventListener(event, checkRoute, true);
  const bridge = createSemanticBridge({ root, registry, targets, dispatch: runtime.dispatch, trustedEventsOnly });
  const availabilityTimers = new Set<number>();
  const dispatchAvailability = onUnexpectedRoute === undefined ? runtime.dispatch : (event: unknown) => {
    // Deliver DOM changes after any user interaction the bridge queued during event capture.
    const timer = win.setTimeout(() => {
      availabilityTimers.delete(timer);
      runtime.dispatch(event);
    }, 0);
    availabilityTimers.add(timer);
  };
  const availability = createAvailabilityFeed({ registry, targets: pageTargets, dispatch: dispatchAvailability });
  const stopPlacement = targets.observe(() => overlay.reposition());
  let seen = historyPageOfPath(win.location.pathname);
  const routeChanged = () => {
    seen = historyPageOfPath(win.location.pathname);
    availability.refresh();
    const route = router.current();
    if (route) runtime.dispatch({ type: "routeChanged", route });
  };
  // History routing: popstate AND a run-scoped pathname poll (an application's own pushState raises no event). The poll only lives while the run is active.
  let poll: number | undefined;
  let previousRoute = router.current();
  const startPoll = () => {
    if ((!history && !onUnexpectedRoute) || poll !== undefined) return;
    poll = win.setInterval(() => {
      if (history && historyPageOfPath(win.location.pathname) !== seen) routeChanged();
      if (onUnexpectedRoute) {
        const nextRoute = router.current();
        // A native link action may change the route before its queued semantic event is delivered.
        if (nextRoute === previousRoute) checkRoute();
        previousRoute = nextRoute;
      }
    }, POLL_MS);
  };
  const stopPoll = () => { if (poll !== undefined) { win.clearInterval(poll); poll = undefined; } };
  const escape = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !dialog.isOpen() && !resultKind(runtime.getState())) { event.preventDefault(); runtime.cancel(); }
  };
  let last = "";
  const unsubscribe = runtime.subscribe(snapshot => {
    const kind = resultKind(snapshot);
    if (kind) {
      bridge.clearPending();
      const step = catalog.get(bundle.definition.id)?.steps.find(item => item.id === snapshot.stepId);
      dialog.show(kind, step?.kind === "complete" ? step.text : "", {
        returnTo: null, retry: () => { startPoll(); runtime.startWalkthrough(bundle.definition.id); },
        ...(onDismiss === undefined ? {} : { onDismiss }),
      });
    }
    presenter.update(snapshot);
    if (active(snapshot.status)) startPoll(); else stopPoll();
    const report = diagnose(snapshot, bundle.definition, checks, router.current());
    const key = report === null ? "" : JSON.stringify([report.status, snapshot.stepId, snapshot.attempt, "failure" in report ? report.failure : null]);
    if (report !== null && key !== last) { last = key; onStatus(report); }
  });
  if (history) win.addEventListener("popstate", routeChanged); else win.addEventListener("hashchange", routeChanged);
  doc.addEventListener("keydown", escape);
  startPoll();
  runtime.startWalkthrough(bundle.definition.id);
  return { ok: true, runtime, destroy() {
    runtime.cancel();
    stopPoll();
    unsubscribe();
    if (onUnexpectedRoute) for (const event of interactionEvents) root.removeEventListener(event, checkRoute, true);
    for (const timer of availabilityTimers) win.clearTimeout(timer);
    availabilityTimers.clear();
    stopPlacement(); bridge.destroy(); availability.destroy();
    win.removeEventListener("popstate", routeChanged); win.removeEventListener("hashchange", routeChanged); doc.removeEventListener("keydown", escape);
    dialog.destroy(); overlay.hide();
  } } as const;
}
