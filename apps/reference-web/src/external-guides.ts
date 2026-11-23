import { applicationRunResult, applicationRunStatus, runInApplicationWindow } from "./admin/application-window.js";
import type { AdminClient, ExternalGuide } from "./admin/client.js";
import { h } from "./dom.js";
import { button, card, statusMessage } from "./ui/pieces.js";

export function createExternalGuides(win: Window, guides: readonly ExternalGuide[], client: Pick<AdminClient, "publishedBundle">) {
  const notice = statusMessage();
  const controls: HTMLButtonElement[] = [];
  let busy = false;
  const cards = guides.map(guide => {
    const label = `Start in ${guide.application.name}`;
    const start = button(label, true);
    start.setAttribute("aria-label", `${label}: ${guide.title}`);
    controls.push(start);
    start.addEventListener("click", () => {
      if (busy) return;
      busy = true;
      for (const control of controls) control.disabled = true;
      notice.textContent = "Opening the application window…";
      let unavailable: string | undefined;
      void runInApplicationWindow({ window: win, application: guide.application, async bundle() {
        const result = await client.publishedBundle(guide.id);
        if (result.kind === "ok") return result.value;
        unavailable = result.kind === "not-found" ? "This published walkthrough is no longer available." : "The published walkthrough could not be loaded.";
        return null;
      }, onStatus(status) { notice.textContent = applicationRunStatus(status); } }).then(result => {
        if (result.kind !== "started") notice.textContent = unavailable ?? applicationRunResult(result);
        busy = false;
        for (const control of controls) control.disabled = false;
      });
    });
    return card(h("h3", {}, guide.title), h("p", {}, guide.description), h("p", {}, guide.application.name), start);
  });
  return h("section", { class: "guides-card card external-guides", "aria-label": "Guides in other applications", "data-ai-ignore": true },
    h("h2", {}, "Guides in other applications"), h("div", { class: "guide-list" }, ...cards), notice);
}
