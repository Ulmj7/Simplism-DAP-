import { copy } from "../../copy.js";
import { h } from "../../dom.js";
import { button, card, statusMessage } from "../../ui/pieces.js";
import { adminPage } from "./shared.js";
import type { AdminPageOptions } from "./shared.js";

const c = copy.admin;
const usage = c.usage;
const percent = (value: number | null) => value === null ? usage.noRate : `${value}%`;

export function analyticsPage({ client, signal }: AdminPageOptions) {
  const page = adminPage(c.analytics);
  const status = statusMessage();
  const results = h("div");
  page.append(h("p", { class: "page-intro" }, usage.note), status, results);
  async function load() {
    status.textContent = c.loading;
    results.replaceChildren();
    const result = await client.analytics();
    if (signal.aborted) return;
    if (result.kind === "denied") { status.textContent = c.denied; return; }
    if (result.kind !== "ok") {
      status.textContent = usage.failed;
      const retry = button(usage.retry);
      retry.addEventListener("click", () => { status.tabIndex = -1; status.focus(); void load(); });
      results.append(retry);
      return;
    }
    const { totals, guides } = result.value;
    status.textContent = guides.length === 0 ? usage.empty : "";
    const metric = (label: string, value: string | number) => card(h("h2", {}, label), h("p", {}, String(value)));
    results.append(h("div", { class: "usage-metrics" },
      metric(usage.started, totals.started), metric(usage.completed, totals.completed),
      metric(usage.cancelled, totals.cancelled), metric(usage.rate, percent(totals.completionRate))));
    if (guides.length === 0) return;
    const columns = [usage.guide, usage.starts, usage.completed, usage.cancelled, usage.percent];
    results.append(card(h("table", { class: "usage-table" },
      h("caption", {}, usage.caption), h("thead", {}, h("tr", {}, ...columns.map(label => h("th", { scope: "col" }, label)))),
      h("tbody", {}, ...guides.map(guide => h("tr", {}, h("th", { scope: "row" }, guide.title),
        ...[guide.started, guide.completed, guide.cancelled, percent(guide.completionRate)].map(value => h("td", {}, String(value)))))))));
  }
  void load();
  return page;
}
