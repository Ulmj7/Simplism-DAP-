/** The reference web app: a hash-routed vanilla TypeScript shell. `mountApp` is used by the browser entry (`browser.ts`) and by tests. */
import { createOverlay, createTargets, createSemanticBridge, createAvailabilityFeed } from "@dap/walkthrough/dom";
import type { Overlay, Targets } from "@dap/walkthrough/dom";
import { createWalkthroughCatalog, createWalkthroughRuntime } from "@dap/walkthrough";
import type { WalkthroughDef, WalkthroughRuntime, SemanticRegistry } from "@dap/walkthrough";
import { WALKTHROUGHS } from "./walkthroughs/index.js";
import { createPresenter } from "./presenter.js";
import { createStatusDialog, resultKind } from "./status-dialog.js";
import { createLauncher, guideApi } from "./launcher.js";
import type { GuideApi } from "./launcher.js";
import { copy } from "./copy.js";
import { createProfileController, createProfileService, initialProfile } from "./profile-state.js";
import type { ProfileService } from "./profile-state.js";
import { createPostconditions, POSTCONDITION_NAMES } from "./postconditions.js";
import { createRouterPort, createTargetPort } from "./ports.js";
import type { AppState } from "./app-state.js";
export type { AppState } from "./app-state.js";
import { h } from "./dom.js";
import { dashboardPage } from "./pages/dashboard.js";
import { profilePage } from "./pages/profile.js";
import { settingsPage } from "./pages/settings.js";
import { ADMIN_ROUTES, createRouter, isAdminRoute } from "./router.js";
import type { Router } from "./router.js";
import { createDemoRegistry } from "./semantic-ui.js";
import { createStore } from "./store.js";
import { createGuidanceClient } from "./help/client.js";
import type { GuidanceClient } from "./help/client.js";
import { createHelp } from "./help/widget.js";
import type { HelpWidget } from "./help/widget.js";
export { createGuidanceClient } from "./help/client.js";
export type { FetchLike, GuidanceClient } from "./help/client.js";
import type { Store } from "./store.js";
import type { AdminClient, DemoRole } from "./admin/client.js";
import { walkthroughsPage } from "./admin/pages/walkthroughs.js";
import { editorPage } from "./admin/pages/editor.js";
import { analyticsPage } from "./admin/pages/analytics.js";
import { applicationsPage } from "./admin/pages/applications.js";
import { targetsPage } from "./admin/pages/targets.js";
import { reportUsage } from "./usage.js";
import type { UsageClient } from "./usage.js";
import { adminPage } from "./admin/pages/shared.js";

export interface AdminOptions {
  client: AdminClient;
  role: DemoRole | undefined;
  changeRole(role: DemoRole): void;
  preview(definition: WalkthroughDef): void;
  refresh(focus?: boolean): void;
}

export interface MountedApp {
  readonly guides: GuideApi;
  readonly runtime: WalkthroughRuntime;
  readonly profile: ReturnType<typeof createProfileController>;
  readonly registry: SemanticRegistry;
  readonly targets: Targets;
  readonly overlay: Overlay;
  readonly router: Router;
  readonly store: Store<AppState>;
  /** C01: the AI Help launcher and panel (appended to the document body, like the status dialog). */
  readonly help: HelpWidget;
  whenGuideIdle(callback: () => void): void;
  destroy(): void;
}


export function mountApp(root: HTMLElement, options: { readonly window?: Window; readonly profileService?: ProfileService; readonly trustedEventsOnly?: boolean; readonly walkthroughs?: readonly WalkthroughDef[];
  /** C01: the AI Help transport. Defaults to same-origin `/api/guidance` through the window's `fetch`; tests inject a fake host. */
  readonly guidance?: GuidanceClient;
  readonly admin?: AdminOptions;
  readonly hideFromLauncher?: readonly string[];
  readonly autoStart?: string;
  readonly usage?: UsageClient | false;
  readonly onPreviewEnd?: () => void;
  readonly externalGuides?: () => HTMLElement;
} = {}): MountedApp {
  const doc = root.ownerDocument;
  const win = options.window ?? doc.defaultView;
  if (win === null || win === undefined) throw new Error("mountApp needs a window");
  const registry = createDemoRegistry();
  const targets = createTargets(root, registry);
  const overlay = createOverlay(doc);
  const router = createRouter(win);
  const store = createStore<AppState>({ route: router.current(), profile: initialProfile(), advancedOpen: false });

  const profile = createProfileController(store, options.profileService ?? createProfileService());
  const postconditions = createPostconditions(store, router);
  const catalog = createWalkthroughCatalog(registry, POSTCONDITION_NAMES, options.walkthroughs ?? WALKTHROUGHS);
  let returnTo: HTMLElement | null = null;
  const dialog = createStatusDialog(doc, () => root.querySelector<HTMLElement>("h1") ?? root.querySelector<HTMLElement>("main"));
  const presenter = createPresenter({overlay,targets,registry,catalog,state:()=>runtime.getState(),cancel:()=>runtime.cancel(),ack:()=>runtime.dispatch({type:"ack"}),complete:text=>dialog.updateText(text)});
  const runtime = createWalkthroughRuntime({ registry, catalog, router: createRouterPort(router, registry), targets: createTargetPort(targets), postconditions: postconditions.checks,
    presenter, timers: { set: (callback, ms) => { const handle = win.setTimeout(callback, ms); return () => win.clearTimeout(handle); } },
  });
  // The bridge listens on the page; its queue is cleared at every run boundary (see begin and the runtime subscription below).
  const bridge = createSemanticBridge({ root, registry, targets, dispatch: event => runtime.dispatch(event), trustedEventsOnly: options.trustedEventsOnly ?? true });
  const runActive=()=>["RESOLVING","PRESENTING","WAITING","VERIFYING"].includes(runtime.getState().status);
  // Events accepted before a run began (or after it ended) are not evidence about the next run: drop them as a run begins.
  const begin = (id: string) => { if (!runActive()) bridge.clearPending(); return runtime.startWalkthrough(id); };
  const guides = guideApi({ ...runtime, startWalkthrough: begin });
  let launcher: ReturnType<typeof createLauncher> | undefined;
  const start = (id:string, source:HTMLElement) => {returnTo=source;dialog.close(false);const result=begin(id);if(!result.ok)launcher?.refused();};
  const nav = h("nav", { class: "nav-group", "aria-label": copy.navigation });
  for (const route of ["dashboard", "profile", "settings"] as const) nav.append(h("a", { href: `#/${route}`, class: "nav-chip", ...(route === "dashboard" ? {} : { "data-ai-id": `nav.${route}` }) }, copy.nav[route]));
  const guidesLink = h("a", {href:"#/dashboard",class:"button"},copy.guide.link);
  // The Guides link opens the catalog: on the Dashboard it scrolls to the card; from another page it goes to the Dashboard first (revealed once rendered).
  let revealGuides=false;
  guidesLink.addEventListener("click",event=>{
    if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
    event.preventDefault();
    if(store.get().route==="dashboard")launcher?.reveal();else{revealGuides=true;router.navigate("dashboard");}
  });
  const main = h("main", { class: "page-container", tabindex: "-1" });
  const header = h("header", { class: "app-header" }, h("span", { class: "brand" }, copy.brand), nav, guidesLink);
  const admin = options.admin;
  const mountScope = new AbortController();
  let pageScope = new AbortController();
  if (admin?.role !== undefined) {
    const role = h("select", { id: "demo-role" }, h("option", { value: "user" }, copy.admin.user), h("option", { value: "maintainer" }, copy.admin.maintainer)) as HTMLSelectElement;
    role.value = admin.role;
    role.addEventListener("change", () => admin.changeRole(role.value === "maintainer" ? "maintainer" : "user"));
    header.append(h("div", { class: "demo-role", "data-ai-ignore": true }, h("label", { for: role.id }, copy.admin.role), role));
  }
  if (admin?.role !== "user" && admin) {
    void admin.client.list().then(result => {
      if (mountScope.signal.aborted || result.kind !== "ok") return;
      for (const route of ADMIN_ROUTES) nav.append(h("a", { href: `#/${route}`, class: "nav-chip", "data-ai-ignore": true,
        ...(router.current() === route ? { "aria-current": "page" } : {}) }, copy.admin[route]));
    });
  }
  root.replaceChildren(header, main);
  let renderedRoute: AppState["route"] | undefined;
  let updatePage: (state: AppState) => void = () => {};
  const helpAvailable = () => options.autoStart === undefined && !isAdminRoute(router.current());
  // C01: an active run or result dialog takes priority over Help on Escape.
  const help=createHelp({doc,guides,available:helpAvailable,client:options.guidance??createGuidanceClient({fetch:typeof win.fetch==="function"?(url,init)=>win.fetch(url,init):undefined}),
    escapeOwnedElsewhere:()=>runActive()||dialog.isOpen(),
    // The docked panel reflows the page (body padding) outside root, which the target observer does not see, so the overlay re-places explicitly.
    onLayoutChange:()=>overlay.reposition(),
    startGuide: (id, source) => {
      // A refusal must leave the current run, its dialog, and its focus target alone.
      if (runActive() || catalog.get(id) === undefined) return guides.startWalkthrough(id);
      returnTo = source;
      dialog.close(false);
      return guides.startWalkthrough(id);
    },
  });
  const render = (state: AppState): void => {
    doc.title = copy.titles[state.route];
    for (const link of Array.from(nav.querySelectorAll("a"))) {
      if (link.getAttribute("href") === `#/${state.route}`) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
    }
    if (state.route !== renderedRoute) {
      overlay.hide(); renderedRoute = state.route;
      pageScope.abort(); pageScope = new AbortController();
      help.launcher.hidden = !helpAvailable(); if (!helpAvailable()) help.close(false);
      launcher = undefined;
      if (state.route === "profile") {
        const page = profilePage({ edit: profile.edit, save: () => { void profile.save(); } });
        main.replaceChildren(page.element); updatePage = s => page.update(s.profile);
      } else if (state.route === "settings") {
        const page = settingsPage(() => store.set({ advancedOpen: !store.get().advancedOpen })); main.replaceChildren(page.element); updatePage = s => page.update(s.advancedOpen);
      } else if (isAdminRoute(state.route)) {
        const page = state.route === "walkthroughs" ? walkthroughsPage : state.route === "applications" ? applicationsPage : state.route === "targets" ? targetsPage : state.route === "editor" ? editorPage : analyticsPage;
        main.replaceChildren(admin ? page({ ...admin, registry, signal: pageScope.signal, navigate: router.navigate, ...(router.setGuard ? { setNavigationGuard: router.setGuard } : {}) })
          : adminPage(copy.admin[state.route])); updatePage = () => {};
        if (!admin) main.firstElementChild?.append(h("p", { role: "status" }, copy.admin.denied));
      } else { launcher=createLauncher(guides,start,options.hideFromLauncher);launcher.update();main.replaceChildren(dashboardPage(launcher.element)); if(options.externalGuides) main.append(options.externalGuides()); updatePage = () => {launcher?.update();}; if(revealGuides){revealGuides=false;launcher.reveal();} }
    }
    root.querySelector("h1")?.setAttribute("tabindex","-1");
    updatePage(state);
  };
  render(store.get());
  const unsubscribeStore = store.subscribe(render);
  const availability=createAvailabilityFeed({registry,targets,dispatch:event=>runtime.dispatch(event)});
  const unsubscribeRouter = router.subscribe(route => { store.set({ route }); availability.refresh();runtime.dispatch({ type: "routeChanged", route }); });
  const stopPlacement=targets.observe(()=>overlay.reposition());
  let terminal="";let escBound=false;
  let afterGuide: (() => void) | undefined;
  const escape=(event:KeyboardEvent)=>{if(event.key==="Escape"&&!dialog.isOpen()){event.preventDefault();runtime.cancel();}};
  const unsubscribeRuntime=runtime.subscribe(snapshot=>{
    presenter.update(snapshot);launcher?.update();
    const active=["RESOLVING","PRESENTING","WAITING","VERIFYING"].includes(snapshot.status);if(!active)bridge.clearPending();
    if(active&&!escBound){doc.addEventListener("keydown",escape);escBound=true;}else if(!active&&escBound){doc.removeEventListener("keydown",escape);escBound=false;}
    const kind=resultKind(snapshot);const key=kind===null?"":`${snapshot.walkthroughId}|${snapshot.status}|${snapshot.failure}`;
    if(kind&&key!==terminal){const def=snapshot.walkthroughId===null?undefined:catalog.get(snapshot.walkthroughId);const step=def?.steps.find(s=>s.id===snapshot.stepId);const id=snapshot.walkthroughId;
      dialog.show(kind,step?.kind==="complete"?step.text:"",{returnTo,retry:()=>{if(id!==null)begin(id);},
        onDismiss: () => {
          if (id === options.autoStart) options.onPreviewEnd?.();
          const pending = afterGuide; afterGuide = undefined; pending?.();
        }});
    }
    terminal=key;
  });
  const stopUsage = options.usage && typeof win.crypto.randomUUID === "function" && reportUsage(runtime, options.usage, () => win.crypto.randomUUID());
  if (options.autoStart !== undefined) begin(options.autoStart);
  let destroyed = false;
  return Object.freeze({
    registry, targets, overlay, router, store, runtime, profile, guides, help,
    whenGuideIdle(callback: () => void) { if (runActive() || dialog.isOpen()) afterGuide = callback; else callback(); },
    destroy() { if (destroyed) return; destroyed = true; mountScope.abort(); pageScope.abort(); if (stopUsage) stopUsage(); bridge.destroy(); availability.destroy(); stopPlacement();unsubscribeRuntime();doc.removeEventListener("keydown",escape);dialog.destroy();help.destroy();unsubscribeRouter(); unsubscribeStore(); profile.destroy(); postconditions.destroy(); runtime.cancel(); overlay.hide(); root.replaceChildren(); },
  });
}
