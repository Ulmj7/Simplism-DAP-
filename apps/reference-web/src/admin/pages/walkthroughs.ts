import { createWalkthroughCatalog } from "@dap/walkthrough";
import { copy } from "../../copy.js";
import { h } from "../../dom.js";
import { POSTCONDITION_NAMES } from "../../postconditions.js";
import { button, card, field, statusMessage } from "../../ui/pieces.js";
import { WALKTHROUGHS } from "../../walkthroughs/index.js";
import type { GuideStatus } from "../client.js";
import { getEditSession, newEditSession, requestEdit, setEditSession } from "../session.js";
import { adminPage, confirmPublish, readError, writeError } from "./shared.js";
import type { AdminPageOptions } from "./shared.js";

const c = copy.admin;
export function walkthroughsPage(options: AdminPageOptions) {
  const { client, registry, signal, preview, navigate, refresh } = options;
  const page = adminPage(c.walkthroughs);
  const notice = statusMessage();
  page.append(notice);
  notice.textContent = c.loading;
  void client.list().then(result => {
    if (signal.aborted) return;
    if (result.kind !== "ok") { notice.textContent = readError(result); return; }
    notice.textContent = "";
    const search = field("walkthrough-search", c.search, { type: "search" });
    const add = button(c.newGuide, true);
    add.addEventListener("click", () => { newEditSession(); navigate("editor"); });
    const columns = [c.title, c.description, c.steps, c.status, c.updated, c.actions];
    const body = h("tbody", { role: "rowgroup" });
    const table = h("table", { class: "admin-table", role: "table", "aria-label": c.walkthroughs },
      h("thead", { role: "rowgroup" }, h("tr", { role: "row" }, ...columns.map(title => h("th", { scope: "col", role: "columnheader" }, title)))), body);
    const empty = statusMessage();
    empty.textContent = c.empty;
    page.append(h("div", { class: "admin-toolbar" }, search.element, add), card(table, empty));
    let busy = false;
    const rows = [...WALKTHROUGHS.map(def => ({
      id: def.id, title: def.title, description: def.description, stepCount: def.steps.filter(step => step.kind === "guide").length,
      status: "builtIn" as const, updatedAt: "",
    })), ...result.value.authored].map(row => {
      const controls = h("div", { class: "admin-actions" });
      function action(label: string, run: (trigger: HTMLButtonElement) => void) {
        const trigger = button(label);
        trigger.setAttribute("aria-label", `${label}: ${row.title}`);
        trigger.addEventListener("click", () => { if (!busy && !signal.aborted && !trigger.disabled) run(trigger); });
        controls.append(trigger);
      }
      const readValid = async (invalid: string, forPreview = false) => {
        const loaded = await client.get(row.id);
        if (signal.aborted) return null;
        if (loaded.kind !== "ok") { notice.textContent = readError(loaded); return null; }
        const owner = loaded.value.applicationId === null ? undefined : await client.applicationRegistry(loaded.value.applicationId);
        if (signal.aborted) return null;
        if (owner !== undefined && owner.kind !== "ok") { notice.textContent = readError(owner); return null; }
        const data = owner?.value;
        if (forPreview && data?.previewMode === "application-window") { notice.textContent = c.application.windowPreviewPending; return null; }
        if (forPreview && data?.previewable === false) { notice.textContent = c.application.noPreview; return null; }
        try { return createWalkthroughCatalog(data?.registry ?? registry, data?.postconditionNames ?? POSTCONDITION_NAMES, [loaded.value.definition]).get(row.id) ?? null; }
        catch { notice.textContent = invalid; return null; }
      };
      async function setStatus(wanted: GuideStatus) {
        busy = true; notice.textContent = c.saving;
        const changed = await client.setStatus(row.id, wanted);
        busy = false;
        if (changed.kind === "ok") {
          if (wanted === "published" && getEditSession()?.id === row.id) setEditSession();
          refresh(!signal.aborted);
        } else if (!signal.aborted) notice.textContent = writeError(changed);
      }
      if (row.status === "draft") action(c.edit, () => { requestEdit(row.id); navigate("editor"); });
      action(c.preview, () => {
        const builtIn = WALKTHROUGHS.find(def => def.id === row.id);
        if (builtIn) { preview(builtIn); return; }
        busy = true; notice.textContent = c.loading;
        void (async () => {
          const def = await readValid(c.previewFailed, true);
          busy = false;
          if (def && !signal.aborted) { notice.textContent = ""; preview(def); }
        })();
      });
      if (row.status === "draft") action(c.publish, trigger => {
        busy = true; notice.textContent = c.loading;
        void readValid(c.publishInvalid).then(def => {
          busy = false;
          if (def && !signal.aborted && trigger.isConnected) { notice.textContent = ""; confirmPublish(trigger, page, () => { void setStatus("published"); }); }
        });
      });
      if (row.status === "published") action(c.unpublish, () => { void setStatus("draft"); });
      const cell = (index: number, content: string | Node) => h("td", { role: "cell", "data-label": columns[index]! }, content);
      const date = row.updatedAt ? new Date(row.updatedAt).toLocaleDateString() : "";
      const description = h("span", { class: "admin-description", title: row.description }, row.description);
      return { haystack: `${row.title} ${row.description}`.toLowerCase(), element: h("tr", { role: "row" },
        cell(0, row.title), cell(1, description), cell(2, String(row.stepCount)), cell(3, h("span", { class: "admin-status" }, c[row.status])), cell(4, date), cell(5, controls)) };
    });
    function filter() {
      const query = search.input.value.trim().toLowerCase();
      const visible = rows.filter(row => row.haystack.includes(query));
      body.replaceChildren(...visible.map(row => row.element));
      table.hidden = visible.length === 0;
      empty.hidden = visible.length !== 0;
    }
    search.input.addEventListener("input", filter);
    filter();
  });
  return page;
}
