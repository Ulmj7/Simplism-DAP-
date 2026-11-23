import { afterEach, expect, it } from "vitest";
import { createSemanticRegistry } from "../semantic/registry.js";
import { createTargets } from "./targets.js";
import { createSemanticBridge } from "./bridge.js";
import type { SemanticEvent } from "../engine/events.js";
const registry = createSemanticRegistry({ routes: ["profile"], elements: [
 { id: "profile.first", route: "profile", role: "button", label: "First", description: "Action", operations: ["click"], privacy: "public" },
 { id: "profile.other", route: "profile", role: "button", label: "Other", description: "Action", operations: ["click"], privacy: "public" },
] });
const turn = () => new Promise<void>(resolve => window.setTimeout(resolve, 0));
const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0)) fn(); document.body.replaceChildren(); });
function setup() {
 const root = document.createElement("div"); document.body.append(root); const events: SemanticEvent[] = [];
 const bridge = createSemanticBridge({ root, registry, targets: createTargets(root, registry), dispatch: e => events.push(e), trustedEventsOnly: false }); cleanups.push(bridge.destroy);
 const button = (id: string) => { const el = document.createElement("button"); el.setAttribute("data-ai-id", id); root.append(el); return el; };
 return { events, bridge, button };
}
it("clearPending drops events accepted but not yet delivered, and later events still arrive in order", async () => {
 const s = setup(); const first = s.button("profile.first"); const other = s.button("profile.other");
 first.click(); other.click(); s.bridge.clearPending();
 await turn(); expect(s.events).toEqual([]);
 other.click(); first.click(); await turn();
 expect(s.events).toEqual([{ type: "click", id: "profile.other" }, { type: "click", id: "profile.first" }]);
});
it("clearPending is safe when nothing is pending, after delivery, and after destroy", async () => {
 const s = setup(); const first = s.button("profile.first");
 expect(() => s.bridge.clearPending()).not.toThrow();
 first.click(); await turn(); s.bridge.clearPending(); expect(s.events).toHaveLength(1);
 s.bridge.destroy(); expect(() => s.bridge.clearPending()).not.toThrow();
});
