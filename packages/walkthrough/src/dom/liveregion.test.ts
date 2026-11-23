import { afterEach, expect, it } from "vitest";
import { createOverlay } from "./overlay.js";
// The card is a polite live region. Assistive technology reacts to rewritten text, so an update must touch only what changed.
const overlays: { hide(): void }[] = [];
afterEach(() => { for (const o of overlays.splice(0)) o.hide(); document.body.replaceChildren(); });
const content = { title: "Name", text: "Type your display name here.", progress: "Step 1 of 2", hint: "Type in the highlighted field.", status: "", ack: false };
function watch(card: Element) {
 const touched: string[] = []; const observer = new MutationObserver(list => { for (const record of list) { const owner = record.type === "characterData" ? record.target.parentElement : (record.target as Element); touched.push(`${record.type}:${owner?.getAttribute("data-ai-overlay") ?? "?"}`); } });
 observer.observe(card, { subtree: true, childList: true, characterData: true });
 return { take: () => { const list = observer.takeRecords(); for (const record of list) { const owner = record.type === "characterData" ? record.target.parentElement : (record.target as Element); touched.push(`${record.type}:${owner?.getAttribute("data-ai-overlay") ?? "?"}`); } const out = [...touched]; touched.length = 0; return out; }, stop: () => observer.disconnect() };
}
it("an update that changes only the status rewrites only the status", () => {
 const overlay = createOverlay(document); overlays.push(overlay); overlay.show(null, content);
 const watcher = watch(document.querySelector('[data-ai-overlay="tooltip"]')!);
 overlay.update({ status: "Checking your progress…", ackDisabled: true });
 const changed = watcher.take(); expect(changed.length).toBeGreaterThan(0); expect(changed.every(entry => entry.endsWith(":status"))).toBe(true);
 watcher.stop();
});
it("an update that changes nothing rewrites nothing", () => {
 const overlay = createOverlay(document); overlays.push(overlay); overlay.show(null, content);
 overlay.update({ status: "Checking your progress…" });
 const watcher = watch(document.querySelector('[data-ai-overlay="tooltip"]')!);
 overlay.update({ status: "Checking your progress…" }); overlay.update({});
 expect(watcher.take()).toEqual([]);
 watcher.stop();
});
