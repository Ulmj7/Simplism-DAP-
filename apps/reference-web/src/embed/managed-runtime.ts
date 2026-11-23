import { createSemanticRegistry, createWalkthroughCatalog, createWalkthroughRuntime } from "@dap/walkthrough";
import type { EngineSnapshot, RouterPort } from "@dap/walkthrough";
import { createAvailabilityFeed, createOverlay, createSemanticBridge, createTargets } from "@dap/walkthrough/dom";
import { createPresenter } from "../presenter.js";
import { createStatusDialog, resultKind } from "../status-dialog.js";
import type { ManagedBundle } from "./protocol.js";

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

export function mountManagedRuntime({ window: win, bundle, trustedEventsOnly = true, onStatus }: {
  window: Window; bundle: ManagedBundle; trustedEventsOnly?: boolean; onStatus: (snapshot: EngineSnapshot) => void;
}) {
  const doc = win.document;
  const root = doc.body;
  if (!root) return { ok: false, reason: "invalid_bundle" } as const;
  let registry;
  try { registry = createSemanticRegistry(bundle.registry); } catch { return { ok: false, reason: "invalid_registry" } as const; }
  let catalog;
  try { catalog = createWalkthroughCatalog(registry, bundle.registry.postconditionNames, [bundle.definition]); }
  catch { return { ok: false, reason: "invalid_bundle" } as const; }
  const router = managedRouter(win.location, bundle.registry.pages);
  const postconditions = Object.fromEntries(bundle.registry.routes.map(route => [`route.${route}`, () => router.current() === route]));
  const targets = createTargets(root, registry);
  const overlay = createOverlay(doc);
  const dialog = createStatusDialog(doc, () => null);
  const presenter = createPresenter({ overlay, targets, registry, catalog, state: () => runtime.getState(),
    cancel: () => runtime.cancel(), ack: () => runtime.dispatch({ type: "ack" }), complete: text => dialog.updateText(text) });
  const runtime = createWalkthroughRuntime({ registry, catalog, router, postconditions, presenter,
    targets: { resolve: id => targets.find(id) ? "available" : "unavailable" },
    timers: { set: (callback, ms) => { const handle = win.setTimeout(callback, ms); return () => win.clearTimeout(handle); } } });
  const bridge = createSemanticBridge({ root, registry, targets, dispatch: runtime.dispatch, trustedEventsOnly });
  const availability = createAvailabilityFeed({ registry, targets, dispatch: runtime.dispatch });
  const stopPlacement = targets.observe(() => overlay.reposition());
  const routeChanged = () => {
    availability.refresh();
    const route = router.current();
    if (route) runtime.dispatch({ type: "routeChanged", route });
  };
  const escape = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !dialog.isOpen() && !resultKind(runtime.getState())) { event.preventDefault(); runtime.cancel(); }
  };
  let last: EngineSnapshot["status"] | undefined;
  const unsubscribe = runtime.subscribe(snapshot => {
    const kind = resultKind(snapshot);
    if (kind) {
      bridge.clearPending();
      const step = catalog.get(bundle.definition.id)?.steps.find(item => item.id === snapshot.stepId);
      dialog.show(kind, step?.kind === "complete" ? step.text : "", {
        returnTo: null, retry: () => runtime.startWalkthrough(bundle.definition.id),
      });
    }
    presenter.update(snapshot);
    if (snapshot.status !== last) { last = snapshot.status; onStatus(snapshot); }
  });
  win.addEventListener("hashchange", routeChanged);
  doc.addEventListener("keydown", escape);
  runtime.startWalkthrough(bundle.definition.id);
  return { ok: true, runtime, destroy() {
    runtime.cancel();
    unsubscribe(); stopPlacement(); bridge.destroy(); availability.destroy();
    win.removeEventListener("hashchange", routeChanged); doc.removeEventListener("keydown", escape);
    dialog.destroy(); overlay.hide();
  } } as const;
}
