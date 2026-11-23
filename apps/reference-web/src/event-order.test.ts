import { afterEach, expect, it, vi } from "vitest";
import { defineWalkthrough } from "@dap/walkthrough";
import { mountApp } from "./main.js";
import type { MountedApp } from "./main.js";
// Wrap dispatch for observation only; every normal call still reaches the real runtime.
vi.mock("@dap/walkthrough", async original => {
 const real = await original<typeof import("@dap/walkthrough")>();
 return { ...real, createWalkthroughRuntime: (options: Parameters<typeof real.createWalkthroughRuntime>[0]) => {
  const runtime = real.createWalkthroughRuntime(options); return { ...runtime, dispatch: vi.fn(runtime.dispatch) };
 } };
});
const mounted: MountedApp[] = [];
const drainDelivery = () => new Promise<void>(resolve => window.setTimeout(resolve, 0));
afterEach(() => { for (const app of mounted.splice(0)) app.destroy(); document.body.replaceChildren(); });
function setup(route: string, options: Parameters<typeof mountApp>[1] = {}) {
 window.location.hash = `#/${route}`;
 const root=document.createElement("div");document.body.append(root);
 const app=mountApp(root,{trustedEventsOnly:false,...options});mounted.push(app);return {app,root};
}
// The unmodified real anchor activates hash navigation before the bridge delivery turn in jsdom.
function activateLink(anchor: HTMLAnchorElement) { anchor.click(); }
it("4a Advanced has committed its real store flag at semantic dispatch", async()=>{
 const {app,root}=setup("settings");const seen:boolean[]=[];
 vi.mocked(app.runtime.dispatch).mockImplementation(event=>{if((event as {type?:string}).type==="click") seen.push(app.store.get().advancedOpen);});
 root.querySelector<HTMLButtonElement>('[data-ai-id="settings.advancedToggle"]')!.click();
 expect(seen).toEqual([]);await drainDelivery();expect(seen).toEqual([true]);
});
it("4b default anchor activation changes the real hash before semantic dispatch", async()=>{
 const {app,root}=setup("dashboard");const seen:string[]=[];
 vi.mocked(app.runtime.dispatch).mockImplementation(event=>{if((event as {type?:string}).type==="click") seen.push(app.router.current());});
 activateLink(root.querySelector<HTMLAnchorElement>('[data-ai-id="nav.settings"]')!);
 expect(seen).toEqual([]);await drainDelivery();expect(seen).toEqual(["settings"]);
});
it("4c Save is genuinely saving at semantic dispatch",async()=>{
 const {app,root}=setup("profile",{profileService:{save:()=>new Promise(()=>{})}});app.profile.edit("Ada");const seen:string[]=[];
 vi.mocked(app.runtime.dispatch).mockImplementation(event=>{if((event as {type?:string}).type==="click")seen.push(app.store.get().profile.status);});
 root.querySelector<HTMLButtonElement>('[data-ai-id="profile.saveButton"]')!.click();expect(seen).toEqual([]);await drainDelivery();expect(seen).toEqual(["saving"]);
});
function guide(target:string,verify:string) {
 return defineWalkthrough({id:"testOnlyGuide",title:"Test guide",description:"Delivery ordering regression",start:"click",steps:[{id:"click",kind:"guide",target,text:"Click the control.",wait:"click",verify,next:"done"},{id:"done",kind:"complete",text:"Done."}]});
}
it.each(["advanced","route"])("4e real runtime completes after %s state has changed",async mode=>{
 const target=mode==="advanced"?"settings.advancedToggle":"nav.settings";
 const {app,root}=setup(mode==="advanced"?"settings":"dashboard",{walkthroughs:[guide(target,mode==="advanced"?"settings.advancedOpen":"route.settings")]});
 expect(app.runtime.startWalkthrough("testOnlyGuide")).toEqual({ok:true});expect(app.runtime.getState().status).toBe("WAITING");
 const control=root.querySelector<HTMLElement>(`[data-ai-id="${target}"]`)!;
 if(mode==="route") activateLink(control as HTMLAnchorElement);else control.click();
 await drainDelivery();expect(app.runtime.getState().status).toBe("COMPLETED");
});
it.each(["success","invalid","failure"])("4e real runtime verifies real save outcome: %s",async mode=>{
 let settle!:(v:{ok:boolean})=>void;
 const {app,root}=setup("profile",{walkthroughs:[guide("profile.saveButton","profile.saved")],profileService:{save:()=>new Promise(resolve=>{settle=resolve;})}});
 app.profile.edit(mode==="invalid"?"a":"Ada");expect(app.runtime.startWalkthrough("testOnlyGuide")).toEqual({ok:true});
 root.querySelector<HTMLButtonElement>('[data-ai-id="profile.saveButton"]')!.click();await drainDelivery();
 expect(app.runtime.getState().status).not.toBe("COMPLETED");
 if(mode!=="invalid") {expect(app.runtime.getState().status).toBe("VERIFYING");settle({ok:mode==="success"});await drainDelivery();}
 expect(app.runtime.getState().status).toBe(mode==="success"?"COMPLETED":"FAILED");
 expect(app.store.get().profile).toMatchObject(mode==="invalid"?{status:"validation-error",draft:"a",error:"too_short"}:{status:mode==="success"?"saved":"save-failed",draft:"Ada"});
 if(mode!=="success") {expect(app.runtime.getState().failure).toBe("verification_failed");expect(app.runtime.getState().stepId).not.toBe("done");}
});
