import type { Postconditions } from "@dap/walkthrough";
import type { AppState } from "./app-state.js";
import type { Store } from "./store.js";
import type { Router } from "./router.js";
export const POSTCONDITION_NAMES = ["profile.saved", "route.profile", "route.settings", "settings.advancedOpen"] as const;
export function createPostconditions(store: Store<AppState>, router: Router): { checks: Postconditions; destroy(): void } {
 const pending = new Set<() => void>(); let destroyed = false;
 const saved = () => { const p = store.get().profile; return p.status === "saved" && p.draft === p.savedName; };
 const checks: Postconditions = {
  "route.profile": () => router.current() === "profile", "route.settings": () => router.current() === "settings",
  "settings.advancedOpen": () => store.get().advancedOpen,
  "profile.saved": async () => {
   if (destroyed) return false;
   if (store.get().profile.status !== "saving") return saved();
   return new Promise<boolean>(resolve => {
    let unsubscribe = () => {};
    const finish = (ok: boolean) => { unsubscribe(); clearTimeout(timer); pending.delete(cancel); resolve(ok); };
    const cancel = () => finish(false); pending.add(cancel);
    unsubscribe = store.subscribe(state => { if (state.profile.status !== "saving") finish(saved()); });
    const timer = setTimeout(cancel, 1500);
   });
  },
 };
 return { checks, destroy() { destroyed = true; for (const cancel of [...pending]) cancel(); } };
}
