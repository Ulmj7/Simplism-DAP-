import { afterEach, expect, it, vi } from "vitest";
import { mountApp } from "./main.js";
import type { MountedApp } from "./main.js";
// A semantic event is evidence about the run that was active when the user acted. It must never be delivered into a later run.
const apps: MountedApp[] = [];
afterEach(() => { apps.splice(0).forEach(a => a.destroy()); document.body.replaceChildren(); vi.useRealTimers(); });
const turn = () => vi.advanceTimersByTimeAsync(5);
function mount(route: string) {
 vi.useFakeTimers(); window.history.replaceState(null, "", `#/${route}`);
 const root = document.createElement("div"); document.body.append(root);
 const app = mountApp(root, { trustedEventsOnly: false }); apps.push(app); return { app, root };
}
const type = (root: ParentNode, value: string) => { const input = root.querySelector<HTMLInputElement>("#name")!; input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); };
it("an input accepted during one run cannot advance the restarted run (cancel, then start, before delivery)", async () => {
 const { app, root } = mount("profile");
 app.guides.startWalkthrough("profileUpdate"); await turn(); expect(app.runtime.getState()).toMatchObject({ stepId: "name", status: "WAITING" });
 type(root, "Ada"); app.guides.cancel(); app.guides.startWalkthrough("profileUpdate");
 await turn();
 expect(app.runtime.getState()).toMatchObject({ walkthroughId: "profileUpdate", stepId: "name", status: "WAITING" });
});
it("an event accepted while no guide was running cannot advance a guide started before delivery", async () => {
 const { app, root } = mount("profile");
 type(root, "Ada"); app.guides.startWalkthrough("profileUpdate");
 await turn();
 expect(app.runtime.getState()).toMatchObject({ stepId: "name", status: "WAITING" });
});
it("a genuine input after the restart still advances it", async () => {
 const { app, root } = mount("profile");
 app.guides.startWalkthrough("profileUpdate"); await turn(); type(root, "Ada"); app.guides.cancel(); app.guides.startWalkthrough("profileUpdate"); await turn();
 type(root, "Ada"); await turn();
 expect(app.runtime.getState()).toMatchObject({ stepId: "save", status: "WAITING" });
});
it("events queued behind the click that ends a run are dropped with it", async () => {
 const { app, root } = mount("profile");
 app.guides.startWalkthrough("profileUpdate"); await turn(); type(root, "Ada"); await turn();
 app.guides.cancel(); type(root, "Grace"); app.guides.startWalkthrough("profileUpdate"); await turn();
 expect(app.runtime.getState()).toMatchObject({ stepId: "name", status: "WAITING" });
});
