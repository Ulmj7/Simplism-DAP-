export interface ProfileState {
 readonly status: "ready" | "dirty" | "validation-error" | "saving" | "saved" | "save-failed";
 readonly draft: string; readonly savedName: string | null; readonly error: null | "too_short" | "too_long";
}
export interface ProfileService { save(name: string): Promise<{ ok: boolean }> }
export const initialProfile = (): ProfileState => Object.freeze({ status: "ready", draft: "", savedName: null, error: null });
/** Demo persistence only: a real asynchronous in-memory save, with no invented failure condition. */
export function createProfileService(delayMs = 250): ProfileService {
 let savedName: string | null = null;
 return { async save(name) { await new Promise(resolve => setTimeout(resolve, delayMs)); savedName = name; return { ok: savedName === name }; } };
}
export function createProfileController(store: { get(): { profile: ProfileState }; set(patch: { profile: ProfileState }): void }, service: ProfileService) {
 let destroyed = false; let pending = false;
 const update = (profile: ProfileState) => { if (!destroyed) store.set({ profile: Object.freeze(profile) }); };
 return {
  edit(draft: string) { if (!destroyed) update({ ...store.get().profile, draft, status: "dirty", error: null }); },
  async save() {
   if (destroyed || pending) return;
   const before = store.get().profile; const name = before.draft.trim();
   if (name.length < 2 || name.length > 80) { update({ ...before, status: "validation-error", error: name.length < 2 ? "too_short" : "too_long" }); return; }
   pending = true; update({ ...before, status: "saving", error: null });
   let ok = false;
   try { ok = (await service.save(name))?.ok === true; } catch { /* No dependency diagnostics become UI state. */ }
   pending = false;
   if (destroyed) return;
   const current = store.get().profile;
   if (current.draft !== before.draft) { update({ ...current, status: "dirty", savedName: ok ? name : current.savedName, error: null }); return; }
   update({ ...current, draft: ok ? name : current.draft, savedName: ok ? name : current.savedName, status: ok ? "saved" : "save-failed", error: null });
  },
  destroy() { destroyed = true; },
 };
}
