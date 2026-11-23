import type { WalkthroughDef } from "@dap/walkthrough";
import { h } from "../../dom.js";
import { button, statusMessage } from "../../ui/pieces.js";
import type { AdminClient } from "../client.js";
import { compareWorkflows } from "../compare.js";
import type { FieldChange } from "../compare.js";
import type { GuideVersion } from "../publishing.js";
import { confirmAction, readError, writeError } from "./shared.js";

function versionName(item: GuideVersion): string { return `v${item.version}${item.live ? " (Live)" : ""}`; }
function changesList(items: readonly FieldChange[]): HTMLElement {
  return h("ul", {}, ...items.map(item => h("li", {}, `${item.field}: ${item.before} → ${item.after}`)));
}

export function openVersions({ page, trigger, client, id, signal, hasDraft, getDraft, onRestore, canRestore, setBusy, draftChanged }: {
  page: HTMLElement; trigger: HTMLButtonElement; client: AdminClient; id: string; signal: AbortSignal; hasDraft: boolean;
  getDraft?: () => WalkthroughDef | undefined;
  onRestore: () => void;
  canRestore: () => boolean;
  setBusy: (busy: boolean) => void;
  draftChanged?: () => boolean;
}): void {
  if (signal.aborted) return;
  page.querySelector(".workflow-versions")?.remove();
  const title = h("h2", { id: "workflow-versions-title", tabindex: "-1" }, "Version history");
  const panel = h("section", { class: "card workflow-versions", "aria-labelledby": title.id });
  const status = statusMessage();
  const alert = h("p", { role: "alert", class: "error" });
  const close = button("Close version history");
  const content = h("div");
  panel.append(title, close, status, alert, content);
  page.append(panel);
  title.focus();
  let writing = false;
  const active = () => !signal.aborted && panel.isConnected;
  close.addEventListener("click", () => {
    if (writing) return;
    panel.remove();
    trigger.focus();
  });
  function readFailure(message: string): void {
    alert.textContent = message;
    const retry = button("Retry versions");
    retry.addEventListener("click", () => { title.focus(); void load(); });
    content.replaceChildren(retry);
  }
  async function load() {
    alert.textContent = "";
    content.replaceChildren();
    status.textContent = "Loading published versions…";
    const result = await client.versions(id);
    if (!active()) return;
    status.textContent = "";
    if (result.kind !== "ok") { readFailure(`Could not load version history. ${readError(result)}`); return; }
    if (result.value.length === 0) { status.textContent = "No versions have been published yet."; return; }
    const versions = result.value;
    const history = h("ol", { class: "workflow-history" });
    for (const item of versions) {
      const restore = button("Create draft from this version");
      restore.setAttribute("aria-label", `Create draft from version ${item.version}`);
      restore.addEventListener("click", () => {
        if (writing || !canRestore()) return;
        const message = draftChanged?.()
          ? `Replace the working draft with v${item.version} and discard unsaved changes? Published versions stay as they are.`
          : `Use v${item.version} as the working draft. This replaces any current working copy. Published versions stay as they are.`;
        confirmAction(restore, page, `Create draft from v${item.version}?`, message, "Create draft", () => {
          if (!writing && canRestore()) void restoreVersion(item.version);
        });
      });
      history.append(h("li", {}, h("strong", {}, versionName(item)), " · ",
        h("time", { datetime: item.publishedAt }, new Date(item.publishedAt).toLocaleString()),
        ` · ${item.publishedBy} · ${item.stepCount} steps`, h("div", { class: "admin-actions" }, restore)));
    }
    content.append(history);
    if (hasDraft || versions.length > 1) compareControls(versions);
  }
  async function restoreVersion(version: number) {
    writing = true;
    close.disabled = true;
    setBusy(true);
    alert.textContent = "";
    status.textContent = `Creating a draft from v${version}…`;
    const result = await client.restore(id, version);
    writing = false;
    setBusy(false);
    if (!active()) return;
    close.disabled = false;
    if (result.kind === "ok") { onRestore(); return; }
    status.textContent = "";
    alert.textContent = `Could not create a draft from v${version}. ${writeError(result)}`;
  }
  function compareControls(versions: readonly GuideVersion[]): void {
    const heading = h("h3", {}, "Compare versions");
    const before = h("select", { id: "workflow-compare-before" }) as HTMLSelectElement;
    const after = h("select", { id: "workflow-compare-after" }) as HTMLSelectElement;
    for (const select of [before, after]) {
      for (const item of versions) select.append(h("option", { value: String(item.version) }, versionName(item)));
      if (hasDraft) select.append(h("option", { value: "draft" }, "Working draft"));
    }
    const baseline = hasDraft ? versions.find(item => item.live) ?? versions[0]! : versions[1]!;
    before.value = String(baseline.version);
    after.value = hasDraft ? "draft" : String(versions[0]!.version);
    const run = button("Compare");
    const output = h("div", { class: "workflow-differences", "aria-label": "Comparison results" });
    const compareStatus = statusMessage();
    const compareAlert = h("p", { role: "alert", class: "error" });
    let attempt = 0;
    const clear = () => {
      attempt += 1;
      run.disabled = before.value === after.value;
      output.replaceChildren();
      compareAlert.textContent = "";
      compareStatus.textContent = "";
    };
    async function getDefinition(selected: string) {
      if (selected === "draft" && getDraft) return getDraft();
      const result = selected === "draft" ? await client.get(id) : await client.version(id, Number(selected));
      if (result.kind !== "ok" || ("status" in result.value && result.value.status !== "draft")) return undefined;
      return result.value.definition;
    }
    run.addEventListener("click", () => {
      if (writing || run.disabled) return;
      clear();
      run.disabled = true;
      const current = attempt;
      compareStatus.textContent = "Loading the two versions…";
      void Promise.all([getDefinition(before.value), getDefinition(after.value)]).then(([left, right]) => {
        if (!active() || attempt !== current) return;
        run.disabled = false;
        compareStatus.textContent = "";
        if (!left || !right) { compareAlert.textContent = "Could not load both versions. Try Compare again."; return; }
        const diff = compareWorkflows(left, right);
        if (diff.metadata.length === 0 && diff.steps.length === 0) { compareStatus.textContent = "No differences."; return; }
        compareStatus.textContent = "Comparison ready.";
        if (diff.metadata.length) output.append(h("h4", {}, "Workflow details"), changesList(diff.metadata));
        if (diff.steps.length) output.append(h("h4", {}, "Steps"), h("ul", {}, ...diff.steps.map(item => {
          const operation = item.kind === "added" ? `Added at step ${item.after}`
            : item.kind === "removed" ? `Removed from step ${item.before}`
              : item.moved ? `Moved from step ${item.before} to step ${item.after}` : `Changed at step ${item.after}`;
          return h("li", {}, `${item.id} · ${operation}`, ...(item.fields.length ? [changesList(item.fields)] : []));
        })));
      });
    });
    for (const select of [before, after]) select.addEventListener("change", clear);
    content.append(heading, h("div", { class: "admin-toolbar" },
      h("div", { class: "field" }, h("label", { for: before.id }, "Before"), before),
      h("div", { class: "field" }, h("label", { for: after.id }, "After"), after), run), compareStatus, compareAlert, output);
    clear();
  }
  void load();
}
