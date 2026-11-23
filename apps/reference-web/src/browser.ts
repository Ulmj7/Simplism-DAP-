import { createWalkthroughCatalog } from "@dap/walkthrough";
import type { WalkthroughDef } from "@dap/walkthrough";
import { createAdminClient } from "./admin/client.js";
import { PREVIEW_ID } from "./admin/draft.js";
import { readRole, setEditSession, takeRequestedEdit, writeRole } from "./admin/session.js";
import type { AppState } from "./app-state.js";
import type { FetchLike } from "./help/client.js";
import { mountApp } from "./main.js";
import type { MountedApp } from "./main.js";
import { POSTCONDITION_NAMES } from "./postconditions.js";
import { createDemoRegistry } from "./semantic-ui.js";
import { createUsageClient } from "./usage.js";
import { WALKTHROUGHS } from "./walkthroughs/index.js";

export async function boot(root: HTMLElement, options: { fetch?: FetchLike; trustedEventsOnly?: boolean; demoRoleEnabled?: boolean } = {}) {
  const window = root.ownerDocument.defaultView;
  if (!window) throw new Error("boot needs a window");
  const win = window;
  const fetcher = options.fetch ?? (typeof win.fetch === "function" ? win.fetch.bind(win) : undefined);
  const registry = createDemoRegistry();
  const usage = createUsageClient(fetcher);
  let role = options.demoRoleEnabled ? readRole(win) : undefined;
  let walkthroughs: readonly WalkthroughDef[] = WALKTHROUGHS;
  let app: MountedApp | undefined;
  let revision = 0;
  let previewing = false;
  let disposed = false;
  const mountOptions = options.trustedEventsOnly === undefined ? {} : { trustedEventsOnly: options.trustedEventsOnly };

  function preview(definition: WalkthroughDef) {
    const def = { ...definition, id: PREVIEW_ID };
    try { createWalkthroughCatalog(registry, POSTCONDITION_NAMES, [def]); } catch { return; }
    const returnHash = win.location.hash;
    const normalState = app?.store.get();
    app?.destroy();
    previewing = true;
    win.history.replaceState(null, "", "#/dashboard");
    app = mountApp(root, {
      ...mountOptions, walkthroughs: [...walkthroughs, def], hideFromLauncher: [PREVIEW_ID], autoStart: PREVIEW_ID, usage: false,
      onPreviewEnd: () => {
        win.history.replaceState(null, "", returnHash || "#/walkthroughs");
        previewing = false;
        mountNormal(normalState);
        root.querySelector<HTMLElement>("h1")?.focus();
      },
    });
  }

  function mountNormal(state?: AppState) {
    app?.destroy();
    app = mountApp(root, {
      ...mountOptions, walkthroughs, usage,
      admin: {
        client: createAdminClient({ fetch: fetcher, role }), role, preview,
        changeRole(next) {
          if (role === undefined || next === role) return;
          role = next; writeRole(win, next); setEditSession(); takeRequestedEdit();
          app?.destroy(); app = undefined;
          void remount("#demo-role");
        },
        refresh(focus = true) { void remount(focus ? "h1" : undefined); },
      },
    });
    if (state) {
      const profile = state.profile.status === "saving" ? { ...state.profile, status: "dirty" as const } : state.profile;
      app.store.set({ profile, advancedOpen: state.advancedOpen });
    }
  }

  async function remount(focus?: string) {
    if (disposed) return;
    const attempt = ++revision;
    const response = await createAdminClient({ fetch: fetcher, role }).published();
    if (attempt !== revision) return;
    const accepted: WalkthroughDef[] = [...WALKTHROUGHS];
    const seen = new Set(accepted.map(def => def.id));
    if (response.kind === "ok") for (const def of response.value) {
      if (seen.has(def.id)) continue;
      try {
        const validated = createWalkthroughCatalog(registry, POSTCONDITION_NAMES, [def]).get(def.id);
        if (validated) { accepted.push(validated); seen.add(def.id); }
      } catch { /* One invalid definition does not hide the others. */ }
    }
    walkthroughs = accepted;
    if (previewing) return;
    const replace = () => {
      if (attempt !== revision) return;
      const focused = root.ownerDocument.activeElement;
      const help = app?.help;
      const displaced = root.contains(focused) || (help !== undefined && (focused === help.launcher || help.panel.contains(focused)));
      const restoreFocus = focus ?? (displaced ? "h1" : undefined);
      mountNormal(app?.store.get());
      if (restoreFocus) root.querySelector<HTMLElement>(restoreFocus)?.focus();
    };
    if (app) app.whenGuideIdle(replace); else replace();
  }

  await remount();
  return {
    current: () => app,
    destroy() { disposed = true; revision++; app?.destroy(); app = undefined; },
  };
}
