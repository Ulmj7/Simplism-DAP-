/**
 * C01: the AI Help launcher and panel. Presentation only: the state below says what is on screen, never what the user may do. Every server string is
 * rendered through text nodes (no markup), the request carries only the typed query and `GuideApi.context()`, and a guide starts only with the id a
 * `kind:"start"` reply approved, through the app's own start path (the existing overlay then takes over).
 */
import type { StartResult } from "@dap/walkthrough";
import { copy } from "../copy.js";
import { h } from "../dom.js";
import type { GuideApi } from "../launcher.js";
import { button } from "../ui/pieces.js";
import { HELP_LIMITS } from "./client.js";
import type { GuidanceClient, GuidanceOutcome } from "./client.js";

export type HelpState = "closed" | "idle" | "submitting" | "answer" | "walkthroughRecommendation" | "clarify" | "unsupported" | "error";

export interface HelpOptions {
  readonly doc: Document;
  readonly guides: Pick<GuideApi, "context">;
  readonly client: GuidanceClient;
  /** True while a higher-priority owner (an active walkthrough run or the status dialog) handles Escape. */
  readonly escapeOwnedElsewhere: () => boolean;
  /** Starts an approved walkthrough through the app's start path; returns the existing GuideApi result unchanged. */
  readonly startGuide: (walkthroughId: string, source: HTMLElement) => StartResult;
  /** Called after the docked panel opens or closes and the page has reflowed, so anything placed over the page (the walkthrough overlay) can re-place. */
  readonly onLayoutChange?: () => void;
  readonly available?: () => boolean;
}

export interface HelpWidget {
  readonly launcher: HTMLButtonElement;
  readonly panel: HTMLElement;
  state(): HelpState;
  open(): void;
  close(restoreFocus?: boolean): void;
  destroy(): void;
}

const SVG = "http://www.w3.org/2000/svg";
/** An original speech-bubble-with-question-mark glyph, drawn in the current text colour. */
function helpIcon(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS(SVG, "svg");
  for (const [name, value] of [["viewBox", "0 0 24 24"], ["width", "20"], ["height", "20"], ["fill", "none"], ["stroke", "currentColor"], ["stroke-width", "2"], ["stroke-linecap", "round"], ["stroke-linejoin", "round"], ["aria-hidden", "true"], ["focusable", "false"]] as const) svg.setAttribute(name, value);
  for (const d of ["M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4h0A2.5 2.5 0 0 1 4 13.5Z", "M9.75 7.75a2.25 2.25 0 1 1 3.1 2.08c-.5.21-.85.68-.85 1.22v.2", "M12 13.6v.01"]) {
    const path = doc.createElementNS(SVG, "path"); path.setAttribute("d", d); svg.append(path);
  }
  return svg;
}

export function createHelp(options: HelpOptions): HelpWidget {
  const { doc, guides, client } = options;
  const win = doc.defaultView;
  let state: HelpState = "closed";
  /** Bumped on close and on every new request, so a late reply for an exchange the user has left is dropped. */
  let generation = 0;
  let lastQuery = "";
  let inFlight = false;

  const launcher = h("button", { type: "button", class: "help-launcher", "aria-label": copy.help.title, "aria-expanded": "false", "aria-controls": "dap-help-panel", "data-ai-ignore": true }) as HTMLButtonElement;
  launcher.append(helpIcon(doc), h("span", { class: "help-launcher-text" }, copy.help.launcher));
  const closeButton = button(copy.help.close); closeButton.classList.add("help-close"); closeButton.setAttribute("aria-label", copy.help.closeLabel);
  const suggestions = copy.help.suggestions.map(prompt => { const b = button(prompt); b.classList.add("help-suggestion"); b.addEventListener("click", () => { input.value = prompt; void ask(prompt); }); return b; });
  const status = h("p", { role: "status", "aria-live": "polite", class: "status help-status" });
  const result = h("div", { class: "help-result", "aria-live": "polite" });
  const input = h("input", { id: "dap-help-query", type: "text", maxlength: String(HELP_LIMITS.queryChars), autocomplete: "off", placeholder: copy.help.placeholder }) as HTMLInputElement;
  const askButton = h("button", { type: "submit", class: "button primary" }, copy.help.ask) as HTMLButtonElement;
  const form = h("form", { class: "help-form" }, h("label", { for: "dap-help-query" }, copy.help.inputLabel), h("div", { class: "help-ask" }, input, askButton));
  const panel = h("section", { id: "dap-help-panel", class: "help-panel", "aria-labelledby": "dap-help-title", "data-ai-ignore": true, "data-state": "closed", hidden: true },
    h("div", { class: "help-head" }, h("h2", { id: "dap-help-title" }, copy.help.title), closeButton),
    h("div", { class: "help-body" }, h("p", { class: "help-intro" }, copy.help.intro), h("div", { class: "help-suggestions", role: "group", "aria-label": copy.help.suggestionsLabel }, ...suggestions), status, result),
    form);
  doc.body.append(panel, launcher);

  const setState = (next: HelpState) => {
    state = next; panel.setAttribute("data-state", next);
    const busy = next === "submitting";
    // The Ask button and prompts are disabled while a request is in flight (one at a time); the field stays focusable but read-only.
    const active = doc.activeElement;
    if (busy && (active === askButton || suggestions.includes(active as HTMLButtonElement) || result.contains(active))) input.focus();
    askButton.disabled = busy; input.readOnly = busy; for (const s of suggestions) s.disabled = busy;
    if (busy) result.setAttribute("aria-busy", "true"); else result.removeAttribute("aria-busy");
    status.textContent = busy ? copy.help.loading : "";
  };
  const paragraph = (value: string, cls = "help-text") => h("p", { class: cls }, value);
  const show = (next: HelpState, ...children: Node[]) => { setState(next); result.replaceChildren(...children); };
  const retryBlock = () => {
    const retry = button(copy.help.retry); retry.addEventListener("click", () => { void ask(lastQuery); });
    return h("div", { class: "help-notice" }, paragraph(copy.help.unavailable), retry);
  };

  const render = (outcome: GuidanceOutcome) => {
    switch (outcome.kind) {
      case "answer": {
        const block = h("div", { class: "help-answer" }, paragraph(outcome.answer));
        if (outcome.sources.length > 0) block.append(h("h3", { class: "help-sources-title" }, copy.help.sources), h("ul", { class: "help-sources" }, ...outcome.sources.map(s => h("li", {}, s.title))));
        show("answer", block); return;
      }
      case "walkthrough": {
        const startButton = button(copy.guide.start, true);
        startButton.setAttribute("aria-label", `${copy.guide.start}: ${outcome.title}`);
        const block = h("div", { class: "help-recommendation" }, paragraph(copy.help.recommendation, "help-lead"), h("h3", { class: "help-guide-title" }, outcome.title));
        if (outcome.message !== null) block.append(paragraph(outcome.message));
        block.append(startButton);
        startButton.addEventListener("click", () => { void startGuide(outcome.proposalId); }, { once: true });
        show("walkthroughRecommendation", block); return;
      }
      case "clarify": show("clarify", paragraph(outcome.message)); input.focus(); return;
      case "unsupported": show("unsupported", paragraph(copy.help.unsupported)); return;
      case "unavailable": show("error", retryBlock()); return;
    }
  };

  function finishRequest(mine: number): boolean {
    inFlight = false;
    if (mine === generation) return true;
    // Closing abandons the result, but reopening still waits for the one in-flight request.
    if (state === "submitting") show("idle");
    return false;
  }

  async function ask(query: string): Promise<void> {
    const trimmed = query.trim();
    if (state === "closed" || options.available?.() === false || inFlight || trimmed.length === 0 || trimmed.length > HELP_LIMITS.queryChars) return;
    inFlight = true;
    lastQuery = trimmed;
    const mine = ++generation;
    show("submitting");
    // The only context is the walkthrough runtime's own semantic snapshot, read at submit time; nothing is read from the page.
    let outcome: GuidanceOutcome;
    try { outcome = await client.ask(trimmed, guides.context()); }
    catch { outcome = { kind: "unavailable" }; }
    if (finishRequest(mine)) render(outcome);
  }

  async function startGuide(proposalId: string): Promise<void> {
    if (state !== "walkthroughRecommendation" || inFlight) return;
    inFlight = true;
    const mine = ++generation;
    show("submitting");
    status.textContent = copy.help.starting; // announced once, by the status region
    let outcome: Awaited<ReturnType<GuidanceClient["start"]>>;
    try { outcome = await client.start(proposalId); }
    catch { outcome = { kind: "unavailable" }; }
    if (!finishRequest(mine)) return;
    if (outcome.kind === "refused") { show("unsupported", paragraph(copy.help.refused)); return; }
    if (outcome.kind === "unavailable") { show("error", retryBlock()); return; }
    // Only the id the host approved reaches the runtime, through the app's normal start path; the runtime's own answer decides what happens.
    let started: StartResult;
    try { started = options.startGuide(outcome.walkthroughId, launcher); } catch { show("error", retryBlock()); return; }
    // The overlay never takes focus, so it returns to the launcher (Tab then reaches the guide card, which follows it in the document).
    if (started.ok) close(true); else show("unsupported", paragraph(copy.guide.refused));
  }

  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented || options.escapeOwnedElsewhere()) return;
    event.preventDefault(); close(true);
  };
  const mobile = () => win?.matchMedia?.("(max-width: 767px)").matches === true;

  function open(): void {
    if (state !== "closed" || options.available?.() === false) return;
    panel.hidden = false; launcher.setAttribute("aria-expanded", "true"); doc.body.classList.add("dap-help-open"); options.onLayoutChange?.();
    // The phone sheet covers the page, so it is announced as a (non-modal) dialog; nothing is trapped and the page stays reachable.
    if (mobile()) panel.setAttribute("role", "dialog"); else panel.removeAttribute("role");
    show(inFlight ? "submitting" : "idle"); doc.addEventListener("keydown", escape);
    input.focus();
  }
  function close(restoreFocus = true): void {
    if (state === "closed") return;
    generation++;
    show("closed"); input.value = ""; panel.hidden = true; panel.removeAttribute("role");
    launcher.setAttribute("aria-expanded", "false"); doc.body.classList.remove("dap-help-open"); options.onLayoutChange?.(); doc.removeEventListener("keydown", escape);
    if (restoreFocus) launcher.focus();
  }

  launcher.addEventListener("click", () => { if (state === "closed") open(); else close(true); });
  closeButton.addEventListener("click", () => close(true));
  form.addEventListener("submit", event => { event.preventDefault(); void ask(input.value); });

  return Object.freeze({
    launcher, panel, state: () => state, open, close,
    destroy() {
      generation++; doc.removeEventListener("keydown", escape); panel.remove(); launcher.remove();
      if (doc.body.classList.contains("dap-help-open")) { doc.body.classList.remove("dap-help-open"); options.onLayoutChange?.(); }
    },
  });
}
