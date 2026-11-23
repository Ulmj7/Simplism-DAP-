import { afterEach, expect, it, vi } from "vitest";
import { mountApp } from "./main.js";
import type { MountedApp } from "./main.js";
import { createStore } from "./store.js";
import { createProfileController, initialProfile } from "./profile-state.js";
import { createPostconditions } from "./postconditions.js";
import type { AppState } from "./app-state.js";
import { copy } from "./copy.js";
// Capture at the public adapter boundary while delegating to the REAL runtime (its API is frozen).
vi.mock("@dap/walkthrough", async original => {
 const real = await original<typeof import("@dap/walkthrough")>();
 return { ...real, createWalkthroughRuntime: (options: Parameters<typeof real.createWalkthroughRuntime>[0]) => {
  const runtime = real.createWalkthroughRuntime(options); return { ...runtime, dispatch: vi.fn(runtime.dispatch) };
 } };
});
const drainDelivery = () => new Promise<void>(resolve => window.setTimeout(resolve, 0));
const apps: MountedApp[] = [];
afterEach(() => { for (const app of apps.splice(0)) app.destroy(); document.body.replaceChildren(); vi.useRealTimers(); });
const setup = (service = { save: async () => ({ ok: true }) }) => {
 const store = createStore<AppState>({ route: "profile", profile: initialProfile(), advancedOpen: false });
 const profile = createProfileController(store, service);
 const pc = createPostconditions(store, { current: () => store.get().route, navigate: () => {}, subscribe: () => () => {} });
 return { store, profile, pc };
};
it("ready -> dirty -> invalid with no save; valid trimmed name saves; edits clear saved status", async () => {
 const save = vi.fn(async () => ({ ok: true })); const s = setup({ save });
 expect(s.store.get().profile.status).toBe("ready"); s.profile.edit(" a "); await s.profile.save(); expect(save).not.toHaveBeenCalled(); expect(s.store.get().profile).toMatchObject({ status: "validation-error", error: "too_short" }); expect(await s.pc.checks["profile.saved"]!()).toBe(false);
 s.profile.edit(" Ada "); expect(s.store.get().profile.status).toBe("dirty"); await s.profile.save(); expect(save).toHaveBeenCalledWith("Ada"); expect(s.store.get().profile).toMatchObject({ status: "saved", draft: "Ada", savedName: "Ada" }); expect(await s.pc.checks["profile.saved"]!()).toBe(true);
 s.profile.edit("Grace"); expect(await s.pc.checks["profile.saved"]!()).toBe(false); s.profile.edit("x".repeat(81)); await s.profile.save(); expect(s.store.get().profile.error).toBe("too_long");
});
it.each(["ok", "failure"])("real pending save %s settles the async postcondition and ignores duplicate save", async mode => {
 let finish!: (result: {ok:boolean}) => void; const save = vi.fn(() => new Promise<{ok:boolean}>(resolve => { finish = resolve; })); const s = setup({ save }); s.profile.edit("Ada");
 const pending = s.profile.save(); await s.profile.save(); expect(save).toHaveBeenCalledTimes(1); expect(s.store.get().profile.status).toBe("saving"); const verified = s.pc.checks["profile.saved"]!(); finish({ ok: mode === "ok" }); await pending; expect(await verified).toBe(mode === "ok"); expect(s.store.get().profile.status).toBe(mode === "ok" ? "saved" : "save-failed");
});
it("rejected services fail safely and allow a retry; destroy drops late results", async () => {
 const s = setup({ save: async () => { throw new Error("SECRETERROR"); } }); s.profile.edit("Ada"); await s.profile.save(); expect(s.store.get().profile.status).toBe("save-failed"); expect(JSON.stringify(s.store.get())).not.toContain("SECRETERROR"); expect(await s.pc.checks["profile.saved"]!()).toBe(false); s.profile.edit("Grace"); expect(s.store.get().profile.status).toBe("dirty");
 let finish!: (v:{ok:boolean})=>void; const late = setup({ save: () => new Promise(resolve => { finish = resolve; }) }); late.profile.edit("Ada"); const pending = late.profile.save(); late.profile.destroy(); const before = late.store.get(); finish({ok:true}); await pending; expect(late.store.get()).toBe(before);
});
it("stuck verification times out and always unsubscribes; destroy settles waiters", async () => {
 vi.useFakeTimers(); const s = setup({ save: () => new Promise(() => {}) }); s.profile.edit("Ada"); void s.profile.save(); const waiting = s.pc.checks["profile.saved"]!(); await vi.advanceTimersByTimeAsync(1500); expect(await waiting).toBe(false);
 const other = s.pc.checks["profile.saved"]!(); s.pc.destroy(); expect(await other).toBe(false); expect(vi.getTimerCount()).toBe(0);
});
function app(route = "profile", service?: Parameters<typeof mountApp>[1]) {
 window.location.hash = `#/${route}`; const root = document.createElement("div"); document.body.append(root); const a = mountApp(root, { trustedEventsOnly: false, ...service }); apps.push(a); return { a, root };
}
it("UI labels, saving/validation status and privacy match the store without remounting inputs", async () => {
 let finish!: (v:{ok:boolean})=>void; const {a,root} = app("profile", {profileService:{ save:()=>new Promise(resolve=>{finish=resolve;}) }});
 const name = root.querySelector<HTMLInputElement>("#name")!; const save = root.querySelector<HTMLButtonElement>('[data-ai-id="profile.saveButton"]')!;
 name.value="a"; name.dispatchEvent(new Event("input",{bubbles:true})); save.click(); expect(name.getAttribute("aria-invalid")).toBe("true"); expect(name.getAttribute("aria-describedby")).toContain("name-error"); expect(root.querySelector("#name-error")?.textContent).toBe(copy.profile.too_short);
 name.value="Ada"; name.dispatchEvent(new Event("input",{bubbles:true})); save.click(); expect(save.getAttribute("aria-disabled")).toBe("true"); expect(name.readOnly).toBe(true); expect(save.getAttribute("aria-busy")).toBe("true"); expect(root.querySelector('[role="status"]')?.textContent).toBe(copy.profile.saving);
 finish({ok:true}); await Promise.resolve(); await Promise.resolve(); expect(root.querySelector("#name")).toBe(name); expect(root.querySelector('[role="status"]')?.textContent).toBe(copy.profile.saved);
 expect(a.store.get().profile.savedName).toBe("Ada");
});
it("router/runtime follow only trusted routes and clean up on destroy", () => {
 const {a,root} = app("dashboard"); const dispatch = vi.spyOn(a.runtime,"dispatch");
 for (const route of ["profile","settings","dashboard","<script>x</script>","admin"]) { window.location.hash=`#/${route}`; window.dispatchEvent(new HashChangeEvent("hashchange")); const known=["profile","settings","dashboard"].includes(route)?route:"dashboard"; expect(a.store.get().route).toBe(known); expect(a.runtime.context().route).toBe(known); expect(root.querySelectorAll("h1")).toHaveLength(1); expect(root.querySelector('[aria-current="page"]')?.textContent).toBe(copy.nav[known as keyof typeof copy.nav]); }
 expect(JSON.stringify(a.runtime.context())).not.toContain("<script>"); expect(JSON.stringify(dispatch.mock.calls)).not.toContain("admin"); const state=a.store.get(); a.destroy(); dispatch.mockClear(); window.location.hash="#/profile"; window.dispatchEvent(new HashChangeEvent("hashchange")); expect(a.store.get()).toBe(state); expect(dispatch).not.toHaveBeenCalled();
});
it("one app bridge survives page renders, emits no values and excludes all privacy fixtures", async () => {
 const {a,root}=app(); await drainDelivery(); const dispatch=vi.spyOn(a.runtime,"dispatch");
 const name=root.querySelector<HTMLInputElement>("#name")!; name.value="PRIVATEVALUE"; name.dispatchEvent(new Event("input",{bubbles:true})); await drainDelivery(); expect(dispatch).toHaveBeenLastCalledWith({type:"input",id:"profile.nameInput",nonEmpty:true});
 for(const id of ["email","phone","password","billing-note"]) { const input=root.querySelector<HTMLInputElement>(`#${id}`)!; input.value="PASSWORDVALUE"; input.dispatchEvent(new Event("input",{bubbles:true})); input.click(); }
 await drainDelivery();
 // Router hashchange notifications are independent of bridge click/input delivery.
 expect(dispatch.mock.calls.filter(([event]) => (event as {type:string}).type !== "routeChanged")).toHaveLength(1); expect(JSON.stringify(dispatch.mock.calls)).not.toContain("PRIVATEVALUE"); expect(JSON.stringify(a.runtime.context())).not.toContain("PASSWORDVALUE"); expect(JSON.stringify(a.runtime.context())).not.toContain("PRIVATEVALUE");
 for(let i=0;i<3;i++) for(const route of ["dashboard","settings","profile"]) { window.location.hash=`#/${route}`; window.dispatchEvent(new HashChangeEvent("hashchange")); }
 await drainDelivery(); dispatch.mockClear(); root.querySelector<HTMLButtonElement>('[data-ai-id="profile.saveButton"]')!.click(); await drainDelivery(); expect(dispatch.mock.calls.filter(([e])=>(e as {type:string}).type==="click")).toHaveLength(1);
});
it("Settings security stays visible; Advanced is real, stable state and the control changes no auth state", () => {
 const {a,root}=app("settings"); const toggle=root.querySelector<HTMLButtonElement>('[data-ai-id="settings.advancedToggle"]')!; expect(a.targets.find("settings.securityPanel")).not.toBeNull(); expect(toggle.getAttribute("aria-expanded")).toBe("false"); toggle.click(); expect(toggle.getAttribute("aria-expanded")).toBe("true"); expect(a.store.get().advancedOpen).toBe(true); a.store.set({advancedOpen:true}); expect(root.querySelector("#advanced-settings")?.hasAttribute("hidden")).toBe(false); root.querySelector<HTMLButtonElement>('[data-ai-id="settings.twoFactorSetup"]')!.click(); expect(root.textContent).toContain(copy.settings.demoNote);
});
it("default app bridge refuses synthetic actions", async () => { const {a,root}=app("profile",{trustedEventsOnly:true}); await drainDelivery(); const spy=vi.spyOn(a.runtime,"dispatch"); root.querySelector<HTMLButtonElement>('[data-ai-id="profile.saveButton"]')!.click(); await drainDelivery(); expect(spy.mock.calls.filter(([event]) => (event as {type:string}).type !== "routeChanged")).toEqual([]); });
it("all pages have landmarks and one heading; every Profile field has a label", () => {
 const {root}=app("dashboard"); expect(root.querySelector("header nav")).not.toBeNull(); expect(root.querySelector("main")).not.toBeNull(); expect(root.querySelectorAll("h1")).toHaveLength(1); expect(root.textContent).not.toContain("Create project");
 window.location.hash="#/profile"; window.dispatchEvent(new HashChangeEvent("hashchange"));
 for(const input of Array.from(root.querySelectorAll("input"))) expect(root.querySelector(`label[for="${input.id}"]`)).not.toBeNull();
 expect(root.querySelector('[role="status"]')?.getAttribute("aria-live")).toBe("polite");
});
it("synchronous save throws are failures and may be retried without editing", async () => {
 const save=vi.fn(()=>{throw new Error("PRIVATEFAILURE");});const s=setup({save});s.profile.edit("Ada");await s.profile.save();expect(s.store.get().profile.status).toBe("save-failed");await s.profile.save();expect(save).toHaveBeenCalledTimes(2);expect(s.store.get().profile.draft).toBe("Ada");
});
it("an edit during an outstanding save is not falsely marked saved", async()=>{
 let finish!:(v:{ok:boolean})=>void;const s=setup({save:()=>new Promise(resolve=>{finish=resolve;})});s.profile.edit("Ada");const pending=s.profile.save();s.profile.edit("Grace");finish({ok:true});await pending;expect(s.store.get().profile).toMatchObject({status:"dirty",draft:"Grace",savedName:"Ada"});expect(await s.pc.checks["profile.saved"]!()).toBe(false);
});
it("postcondition subscriptions are removed on settlement and timeout", async()=>{
 vi.useFakeTimers();const s=setup({save:()=>new Promise(()=>{})});s.profile.edit("Ada");void s.profile.save();const removed=vi.fn();const subscribe=s.store.subscribe;s.store.subscribe=listener=>{const off=subscribe(listener);return()=>{removed();off();};};const pending=s.pc.checks["profile.saved"]!();await vi.advanceTimersByTimeAsync(1500);expect(await pending).toBe(false);expect(removed).toHaveBeenCalledTimes(1);
});
it("router and target ports refuse unknown routes and report actual availability", async()=>{
 const {createRouterPort,createTargetPort}=await import("./ports.js");const {a}=app("dashboard");const navigate=vi.fn();const port=createRouterPort({...a.router,navigate},a.registry);port.navigate("admin");expect(navigate).not.toHaveBeenCalled();port.navigate("profile");expect(navigate).toHaveBeenCalledWith("profile");expect(createTargetPort(a.targets).resolve("unknown.id")).toBe("unavailable");
});
it("a delivery-turn Save check waits for the real asynchronous save", async()=>{
 let finish!:(v:{ok:boolean})=>void;const {a,root}=app("profile",{profileService:{save:()=>new Promise(resolve=>{finish=resolve;})}});const pc=createPostconditions(a.store,a.router);
 const name=root.querySelector<HTMLInputElement>("#name")!;name.value="Ada";name.dispatchEvent(new Event("input",{bubbles:true}));await drainDelivery();let verified: boolean|Promise<boolean>|undefined;
 vi.mocked(a.runtime.dispatch).mockImplementation(event=>{if((event as {type?:string}).type==="click")verified=pc.checks["profile.saved"]!();});
 root.querySelector<HTMLButtonElement>('[data-ai-id="profile.saveButton"]')!.click();await drainDelivery();expect(a.store.get().profile.status).toBe("saving");finish({ok:true});expect(await verified).toBe(true);pc.destroy();
});
