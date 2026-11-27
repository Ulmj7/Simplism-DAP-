// The installation server appends the widget source, which calls this function.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function createMappedGuide(reader, { storageKey, requestRoute, report, currentRoute, destination, openPanel, highlight, clearHighlight, setStatus }) {
  const duration = 5 * 60_000;
  const transitionTimeout = 8_000;
  const digestPattern = /^[a-f0-9]{64}$/u;
  const isDigest = value => typeof value === "string" && digestPattern.test(value);
  const isTicket = value => typeof value === "string" && value.length <= 600 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(value);
  const validSteps = steps => Array.isArray(steps) && steps.length > 0 && steps.length <= 17 &&
    steps.every((step, index) => step && isDigest(step.page) && isDigest(step.target) &&
      (index === steps.length - 1 ? step.kind === "target" :
        ["link", "menu", "tab"].includes(step.kind) && step.after === steps[index + 1]?.page &&
        (step.kind !== "link" || isDigest(step.href))));
  const available = Boolean(globalThis.crypto?.subtle);
  const encoder = new TextEncoder();
  const hash = async text => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))),
    byte => byte.toString(16).padStart(2, "0")).join("");
  const keyOf = ({ page, section, role, name, marker }) => hash(JSON.stringify([page, section, role, name, marker]));
  let plan = available ? restore() : null;
  let checking;
  let shown;
  let generation = 0;

  function restore() {
    try {
      const state = JSON.parse(sessionStorage.getItem(storageKey));
      const now = Date.now();
      if (state && validSteps(state.steps) && Number.isInteger(state.index) && state.index >= 0 && state.index < state.steps.length &&
          (state.ticket === null || isTicket(state.ticket)) &&
          state.expires > now && state.expires <= now + duration &&
          (state.waiting === null || (state.index < state.steps.length - 1 && Number.isFinite(state.waiting) &&
            state.waiting <= now + transitionTimeout))) return state;
    } catch { /* Guidance can run without browser storage. */ }
    return null;
  }

  function persist() {
    try {
      if (plan) sessionStorage.setItem(storageKey, JSON.stringify(plan));
      else sessionStorage.removeItem(storageKey);
    } catch { /* Same-document steps remain usable. */ }
  }

  function cancel() {
    generation++;
    plan = null;
    shown = null;
    persist();
    clearHighlight();
  }

  function feedback(active, kind, reason) {
    if (active?.ticket) {
      void report({ ticket: active.ticket, index: active.index, kind, ...(reason ? { reason } : {}) });
    }
  }

  function stop(message, reason) {
    feedback(plan, "stopped", reason);
    cancel();
    setStatus(message);
  }

  async function collect() {
    const route = currentRoute();
    if (!route) return null;
    const candidates = reader.scan().slice(0, 256);
    const ids = await Promise.all(candidates.map(({ target }) => keyOf(target)));
    return { page: await hash(route), candidates, ids };
  }

  function match(view, target) {
    const index = view.ids.indexOf(target);
    if (index < 0) return null;
    const entry = view.candidates[index];
    const confirmed = reader.resolve(entry.target);
    return confirmed.status === "found" && confirmed.node === entry.node ? entry : null;
  }

  function mismatch(view, target) {
    const index = view.ids.indexOf(target);
    return index >= 0 && reader.resolve(view.candidates[index].target).status === "ambiguous" ? "ambiguous" : "missing";
  }

  function advanced(step, view) {
    if (view.page !== step.after) return false;
    if (step.after !== step.page) return true;
    const index = view.ids.indexOf(step.target);
    if (index < 0) return true;
    const { node } = view.candidates[index];
    if (step.kind === "tab") return node.getAttribute("aria-selected") === "true";
    return node.getAttribute("aria-expanded") === "true" || node.matches("details[open] > summary");
  }

  async function guideCurrentStep(active) {
    if (active.expires <= Date.now()) {
      stop("Зааврын хугацаа дууслаа. Дахин асууна уу.", "expired");
      return;
    }
    const entered = currentRoute();
    const view = await collect();
    if (plan !== active || currentRoute() !== entered) return;
    let step = active.steps[active.index];
    if (active.waiting !== null) {
      const next = active.steps[active.index + 1];
      if (!view || !advanced(step, view) || !match(view, next.target)) {
        if (Date.now() >= active.waiting) {
          let reason = "timeout";
          if (view && advanced(step, view)) {
            active.index++;
            reason = mismatch(view, next.target);
          } else if (view && view.page !== step.page && view.page !== step.after) reason = "unexpected-page";
          stop("Дараагийн алхам дэлгэц дээр баталгаажаагүй. Одоогийн хуудаснаас дахин асууна уу.", reason);
        }
        return;
      }
      active.index++;
      active.waiting = null;
      step = next;
      persist();
    }
    const entry = view?.page === step.page ? match(view, step.target) : null;
    if (!entry) {
      stop("Заах элемент энэ дэлгэц дээр олдсонгүй эсвэл ялгах боломжгүй байна. Дахин асууна уу.",
        view?.page === step.page ? mismatch(view, step.target) : "unexpected-page");
      return;
    }
    let href = null;
    if (step.kind === "link") {
      const node = entry.node;
      href = node instanceof HTMLAnchorElement && !node.hasAttribute("download") && (!node.target || node.target === "_self")
        ? destination(node.href) : null;
      const matches = href && await hash(href) === step.href;
      if (plan !== active || currentRoute() !== entered) return;
      if (!matches || !reader.available(node)) {
        stop("Холбоос өөрчлөгдсөн байна. Одоогийн хуудаснаас дахин асууна уу.", "link-changed");
        return;
      }
    }
    if (shown?.node === entry.node && shown?.step === step) return;
    shown = { node: entry.node, target: entry.target, step, href, route: entered };
    const name = entry.target.name ? `«${entry.target.name}»` : "Тохирох элемент";
    if (step.kind === "target") {
      highlight(entry.node, `${name} энд байна.`);
      setStatus("Тохирох элемент тодорлоо.");
      feedback(active, "completed");
      plan = null;
      persist();
      return;
    }
    const instructions = { menu: "цэсийг нээнэ үү.", tab: "табыг сонгоно уу.", link: "холбоосоор орно уу." };
    const message = `${name} ${instructions[step.kind]}`;
    highlight(entry.node, message);
    setStatus(`${active.index + 1}/${active.steps.length - 1} · ${message}`);
  }

  async function refresh(validateShown = false) {
    const active = plan;
    if (!active || checking === active) return;
    if (active.expires > Date.now() && !validateShown && active.waiting === null &&
        shown?.step === active.steps[active.index] && shown.route === currentRoute() &&
        reader.available(shown.node)) return;
    checking = active;
    try { await guideCurrentStep(active); }
    catch {
      if (plan === active) stop("Дэлгэцийн зааврыг шалгаж чадсангүй. Дахин асууна уу.", "missing");
    } finally { if (checking === active) checking = null; }
  }

  function click(event) {
    if (!plan || plan.waiting !== null || shown?.step !== plan.steps[plan.index] ||
        !shown.node.contains(event.target) || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
    if (reader.resolve(shown.target).node !== shown.node || (shown.href && destination(shown.node.href) !== shown.href)) {
      stop("Элемент өөрчлөгдсөн байна. Дахин асууна уу.", shown.href ? "link-changed" : "missing");
      return true;
    }
    plan.waiting = Date.now() + transitionTimeout;
    persist();
    shown = null;
    clearHighlight();
    setStatus("Дараагийн дэлгэцийг шалгаж байна…");
    return true;
  }

  async function start(query) {
    cancel();
    if (!available) return false;
    const request = generation;
    const { page, targets } = reader.snapshot();
    if (!page || !targets.length || currentRoute() !== page) return false;
    const result = await requestRoute(query, await hash(page), [...new Set(await Promise.all(targets.map(keyOf)))]);
    if (request !== generation || currentRoute() !== page) return true;
    if (result?.kind === "unmapped") return false;
    if (result?.kind === "clarify") {
      setStatus("Ижил нэртэй элемент эсвэл дэлгэцийн төлөв байна. Цэс, хэсгийн нэрийг тодруулж асууна уу.");
      return true;
    }
    if (result?.kind !== "route" || !validSteps(result.steps)) {
      setStatus(result?.error || "Дэлгэцийн зааврыг авч чадсангүй. Дахин оролдоно уу.");
      return true;
    }
    plan = { steps: result.steps, index: 0, waiting: null, expires: Date.now() + duration,
      ticket: isTicket(result.ticket) ? result.ticket : null };
    persist();
    await refresh();
    return true;
  }

  if (plan) {
    openPanel();
    setStatus("Хадгалсан зааврыг үргэлжлүүлж байна…");
    // Allow the host page to mount its controls before checking a resumed route.
    setTimeout(() => { void refresh(); }, 350);
  }
  return { start, refresh, click, cancel };
}
