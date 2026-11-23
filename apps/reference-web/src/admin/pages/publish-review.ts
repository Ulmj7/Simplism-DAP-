import { copy } from "../../copy.js";
import { h } from "../../dom.js";
import { button, statusMessage } from "../../ui/pieces.js";
import type { AdminClient } from "../client.js";
import type { PublishReview, ReviewIssue } from "../publishing.js";
import { readError } from "./shared.js";

const c = copy.admin;

function issues(title: string, items: readonly ReviewIssue[]): HTMLElement {
  const rows = items.map(item => h("li", {}, [
    item.stepIndex === undefined ? "" : `Step ${item.stepIndex + 1}. `,
    item.message,
    item.targetId === undefined ? "" : ` (${item.targetId})`,
  ].join("")));
  return h("section", {}, h("h3", {}, title), ...(items.length ? [h("ul", {}, ...rows)] : [h("p", {}, "None.")]));
}

function summary({ application, title, steps, targets, verification, currentVersion, nextVersion }: PublishReview["summary"]): HTMLElement {
  const row = (label: string, value: string) => [h("dt", {}, label), h("dd", {}, value)];
  return h("dl", { class: "publish-summary" },
    ...row("Workflow", title || "Untitled"),
    ...row("Application", application.name),
    ...row("Steps", String(steps)),
    ...row("Targets", `${targets.healthy} healthy, ${targets.unverified} unverified, ${targets.broken} broken, ${targets.disabled} disabled`),
    ...row("Verification coverage", `${verification.withVerify} of ${verification.steps} steps have verification`),
    ...row("Live version", currentVersion === null ? "None" : `v${currentVersion}`),
    ...row("Next version", `v${nextVersion}`));
}

export function openPublishReview({ page, trigger, client, id, signal, applicationId, submit }: {
  readonly page: HTMLElement; readonly trigger: HTMLButtonElement; readonly client: AdminClient; readonly id: string; readonly signal: AbortSignal;
  readonly applicationId?: string | null | undefined; readonly submit: (revision: number) => void;
}): void {
  if (signal.aborted || page.querySelector("dialog[open]")) return;
  const dialog = h("dialog", { class: "dap-result publish-review", "aria-labelledby": "publish-review-title", "aria-describedby": "publish-review-description", "aria-modal": "true" }) as HTMLDialogElement;
  const status = statusMessage();
  const alert = h("p", { role: "alert", class: "error" });
  const content = h("div");
  const retry = button("Retry review");
  const cancel = button(c.cancel);
  const publish = button(c.publish, true);
  let reviewedRevision: number | undefined;
  async function load() {
    reviewedRevision = undefined;
    status.textContent = "Validating the saved workflow…";
    alert.textContent = "";
    content.replaceChildren();
    retry.hidden = true;
    publish.disabled = true;
    const result = await client.review(id);
    if (signal.aborted || !dialog.isConnected) return;
    status.textContent = "";
    if (result.kind !== "ok" || (result.value.ok && applicationId != null && result.value.summary.application.id !== applicationId)) {
      alert.textContent = result.kind === "ok" ? "The review belongs to a different application." : `Could not review this workflow. ${readError(result)}`;
      retry.hidden = false;
      return;
    }
    const review = result.value;
    content.append(summary(review.summary), issues("Blockers", review.blockers), issues("Warnings", review.warnings));
    if (review.ok) reviewedRevision = review.revision;
    publish.disabled = !review.ok;
    if (review.ok) status.textContent = "Review complete. Confirm Publish when you are ready.";
    else alert.textContent = "Resolve the blockers before publishing.";
  }
  const aborted = () => close(false);
  function close(restore = true) {
    if (!dialog.isConnected) return false;
    signal.removeEventListener("abort", aborted);
    if (typeof dialog.close === "function") dialog.close();
    dialog.remove();
    if (restore) trigger.focus();
    return true;
  }
  cancel.addEventListener("click", () => close());
  retry.addEventListener("click", () => { cancel.focus(); void load(); });
  publish.addEventListener("click", () => { if (reviewedRevision !== undefined && !publish.disabled && !signal.aborted && close()) submit(reviewedRevision); });
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  dialog.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key !== "Tab") return;
    const controls = [retry, cancel, publish].filter(item => !item.hidden && !item.disabled);
    if (dialog.ownerDocument.activeElement === (event.shiftKey ? controls[0] : controls.at(-1))) {
      event.preventDefault();
      (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
    }
  });
  dialog.append(h("h2", { id: "publish-review-title" }, c.publishTitle),
    h("p", { id: "publish-review-description" }, c.publishMessage), status, alert, content,
    h("div", { class: "result-actions" }, retry, cancel, publish));
  page.append(dialog);
  if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
  signal.addEventListener("abort", aborted, { once: true });
  cancel.focus();
  void load();
}
