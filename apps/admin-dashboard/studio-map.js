function node(tag, value, className) {
  const element = document.createElement(tag);
  if (value !== undefined) element.textContent = value;
  if (className) element.className = className;
  return element;
}
const discoveryStatuses = {
  idle: "",
  preparing: "Браузер нээж байна…",
  ready: "Studio браузер бэлэн.",
  scanning: "SaaS-ийн цэс, таб, хуудсуудыг уншиж байна…",
  complete: "UI зураглалыг хадгаллаа.",
  paused: "Уншилтыг хадгаллаа. «Үргэлжлүүлэх» товчоор үлдсэн хэсгийг уншуулна уу.",
  "access-required": "Хуудас эсвэл хэрэглэгчийн эрхийг баталгаажуулж чадсангүй. Studio браузерт зөв эрхээр нэвтрээд дахин оролдоно уу.",
  failed: "UI зураглал үүсгэж чадсангүй. Браузер болон SaaS-ийн хаягийг шалгаад дахин оролдоно уу.",
};
const transitionStatuses = {
  observed: "Баталгаажсан",
  "access-required": "Эрх шаардсан",
  unreadable: "Уншиж чадаагүй",
  "no-change": "Шинэ төлөв илрээгүй",
  limited: "Уншилтын хязгаарт хүрсэн",
};
const feedbackReasons = {
  missing: "Элемент олдоогүй",
  ambiguous: "Ижил шинжтэй олон элементтэй",
  "link-changed": "Холбоос өөрчлөгдсөн",
  timeout: "Дараагийн төлөв нээгдээгүй",
  expired: "Зааврын хугацаа дууссан",
  "unexpected-page": "Өөр хуудас нээгдсэн",
};

function mapDiff(previous, current) {
  function entries(map) {
    const items = new Map();
    const pages = new Map(map.states.map(state => [state.id, state.page]));
    for (const state of map.states) {
      items.set("page:" + state.page, { label: state.page, page: state.page });
      for (const target of state.targets) {
        const id = JSON.stringify([state.page, target.section, target.role, target.name, target.marker]);
        items.set("target:" + id, { page: state.page, label: `${state.page} · ${[...target.section, target.name || target.marker].join(" → ")}` });
      }
    }
    for (const edge of map.transitions) {
      const { target, kind, href } = edge.action;
      const id = JSON.stringify([target, kind, href, edge.status, pages.get(edge.to) ?? null]);
      items.set("edge:" + id, { page: target.page, label: `${target.page} · ${target.name} → ${pages.get(edge.to) || transitionStatuses[edge.status]}` });
    }
    return items;
  }
  const before = entries(previous);
  const after = entries(current);
  const details = node("details", undefined, "map-state");
  const removed = [...before].filter(([key]) => !after.has(key)).map(([, value]) => value);
  const added = [...after].filter(([key]) => !before.has(key)).map(([, value]) => value);
  const changed = new Set([...removed, ...added].map(value => value.page));
  details.append(node("summary", `Өмнөх хувилбараас · ${changed.size} хуудас өөрчлөгдсөн · +${added.length} / −${removed.length}`));
  for (const [title, list] of [["Нэмэгдсэн", added], ["Хасагдсан", removed]]) {
    if (!list.length) continue;
    const section = node("ul");
    for (const entry of list) section.append(node("li", entry.label));
    details.append(node("h3", title), section);
  }
  return details;
}

function guideUsage(usage, selectPage) {
  const report = node("section", undefined, "map-state");
  report.append(node("h2", "Сүүлийн 30 хоногийн заавар"));
  report.append(node("p", `${usage.started ?? 0} эхэлсэн · ${usage.completed ?? 0} зорьсон элементдээ хүрсэн · ${usage.stopped ?? 0} зогссон`));
  for (const entry of usage.failures ?? []) {
    const item = node("div", undefined, "actions");
    item.append(node("p", `Хувилбар ${entry.revision} · алхам ${entry.step + 1} · ${entry.label || "Өмнөх элементийн ID"} · ${feedbackReasons[entry.reason]} · ${entry.count} удаа`));
    if (entry.seed) {
      const inspect = node("button", `${entry.seed} замыг сонгох`);
      inspect.addEventListener("click", () => selectPage(entry.seed));
      item.append(inspect);
    }
    report.append(item);
  }
  return report;
}

function mapResults(saved, draft) {
  if (!saved && !draft) return [node("p", "Хадгалсан UI зураглал байхгүй байна.", "empty")];
  const map = draft?.map ?? saved.map;
  const paths = new Set(map.states.map(state => state.page));
  const discovered = new Set([...paths, ...map.transitions.map(edge => edge.action.href), ...(draft?.pending ?? []).map(action => action.href)].filter(Boolean));
  const confirmed = map.transitions.filter(transition => transition.status === "observed").length;
  const summary = node("p", `Олдсон ${discovered.size} хуудаснаас ${paths.size}-г уншсан · ${map.states.length} төлөв · ${confirmed} баталгаажсан шилжилт · ${map.transitions.length - confirmed} баталгаажаагүй`);
  const version = node("p", saved ? `Ашиглаж буй хувилбар ${saved.revision} · ${new Date(saved.updatedAt).toLocaleString("mn")}`
    : "Эхний хувилбар уншиж байна.", "secondary");
  const content = [summary, version];
  if (saved?.previousMap) content.push(mapDiff(saved.previousMap, saved.map));
  if (draft?.pending.length) {
    const pending = node("details", undefined, "map-state");
    pending.append(node("summary", `Үргэлжлүүлэн унших ${draft.pending.length} цэс, холбоос`));
    const list = node("ul");
    for (const action of draft.pending) list.append(node("li", `${action.target.page} · ${action.target.name}${action.href ? ` → ${action.href}` : ""}`));
    pending.append(list);
    content.push(pending);
  }
  if (map.limited) content.push(node("p", "Уншилтын хязгаарт хүрсэн тул зарим дэлгэц зураглалд ороогүй."));

  const labelsById = new Map(map.states.map((state, index) => [state.id, `${state.page} · төлөв ${index + 1}`]));
  for (const state of map.states) {
    const details = node("details", undefined, "map-state");
    details.append(node("summary", labelsById.get(state.id)));
    const items = node("ul");
    for (const target of state.targets) {
      items.append(node("li", `${[...target.section, target.name || target.marker].join(" → ")} (${target.role})`));
    }
    if (items.childElementCount) details.append(items);
    if (state.truncated) details.append(node("p", "Элементийн тоо уншилтын хязгаараас давсан."));
    const transitions = map.transitions.filter(transition => transition.from === state.id);
    if (transitions.length) {
      const list = node("ul");
      for (const transition of transitions) {
        const name = transition.action.target.name || transition.action.target.marker;
        const description = transition.to ? labelsById.get(transition.to)
          : [transitionStatuses[transition.status], transition.action.href].filter(Boolean).join(" · ");
        list.append(node("li", `${name} → ${description}`));
      }
      details.append(node("h3", "Шилжилт"), list);
    }
    content.push(details);
  }
  return content;
}


const tabs = [["control", "Удирдлага"], ["results", "Үр дүн"], ["settings", "Тохиргоо"]];
const activeStatuses = new Set(["preparing", "ready", "scanning"]);
const validAudience = /^[a-z][a-z0-9-]{0,40}$/u;
const retryMessage = "Зураглалын мэдээллийг авч чадсангүй. Дахин оролдоно уу.";

export function mountStudioMap({ tenant, getOrigin, request, onState }) {
  const panel = node("section", undefined, "studio-map");
  const navigation = node("div", undefined, "studio-map-tabs");
  navigation.setAttribute("role", "group");
  navigation.setAttribute("aria-label", "Зураглалын хэсгүүд");

  const scopeHint = node("p", "Зүүн жагсаалтаас зураглах SaaS сайтаа сонгоно уу.", "monitor-empty");
  const work = node("div", undefined, "studio-map-work");
  const feedback = node("p", "", "studio-map-status");
  feedback.setAttribute("role", "status");
  const retry = node("button", "Дахин ачаалах");
  retry.type = "button";
  retry.hidden = true;

  const control = node("div", undefined, "studio-map-section");
  const audienceLabel = node("label", "Зураглалын эрх");
  const audience = node("input");
  audience.value = "public";
  audience.setAttribute("list", "studio-map-audiences");
  const options = node("datalist");
  options.id = "studio-map-audiences";
  audienceLabel.append(audience, options);
  const pathLabel = node("label", "Эхлэх зам");
  const startPath = node("input");
  startPath.placeholder = "/settings";
  pathLabel.append(startPath, node("small", "Хоосон бол нүүр хуудас эсвэл Studio-д нээлттэй хуудсаас эхэлнэ."));
  const actions = node("div", undefined, "studio-map-actions");
  const commands = new Map([
    ["prepare", "Studio браузер нээх"], ["start", "Зураглал үүсгэх"], ["resume", "Үргэлжлүүлэх"], ["close", "Зогсоох"],
  ].map(([action, label]) => {
    const button = node("button", label, action === "start" ? "primary" : undefined);
    button.type = "button";
    button.addEventListener("click", () => { void command(action); });
    actions.append(button);
    return [action, button];
  }));
  const roleSetup = node("button", "Эрхийн тохиргоо нээх");
  roleSetup.type = "button";
  roleSetup.addEventListener("click", () => showSection("settings"));
  control.append(audienceLabel, roleSetup, pathLabel, actions);

  const results = node("div", undefined, "studio-map-section");
  results.append(node("p", "Үр дүн ачаалж байна…", "monitor-empty"));
  const settings = node("div", undefined, "studio-map-section");
  const endpointLabel = node("label", "SaaS-ийн эрхийн endpoint");
  const endpoint = node("input");
  endpoint.placeholder = "/api/dap/role";
  endpointLabel.append(endpoint);
  const keyLabel = node("label", "Ed25519 нийтийн түлхүүр");
  const publicKey = node("textarea");
  publicKey.rows = 3;
  publicKey.placeholder = "-----BEGIN PUBLIC KEY-----";
  keyLabel.append(publicKey);
  const keyStatus = node("p", "", "studio-map-status");
  keyStatus.setAttribute("role", "status");
  const saveKey = node("button", "Эрхийн тохиргоо хадгалах");
  const removeKey = node("button", "Эрхийн тохиргоо салгах");
  saveKey.type = removeKey.type = "button";
  const keyActions = node("div", undefined, "studio-map-actions");
  keyActions.append(saveKey, removeKey);
  const token = node("details", undefined, "map-state");
  token.append(node("summary", "SaaS-аас буцаах JWT"),
    node("p", "Endpoint нь нэвтэрсэн хэрэглэгчийн сессийг шалгаж, EdDSA-аар гарын үсэг зурсан { token } буцаана."),
    node("p", `aud = ${tenant.installationId} · origin = SaaS-ийн хаяг · role = эрхийн нэр · iat, exp = Unix секунд · 5 минут хүртэл`));
  settings.append(endpointLabel, keyLabel, keyActions, keyStatus, token);

  const sections = { control, results, settings };
  const sectionButtons = new Map(tabs.map(([id, label]) => {
    const button = node("button", label);
    button.type = "button";
    button.addEventListener("click", () => showSection(id));
    navigation.append(button);
    return [id, button];
  }));
  function showSection(id) {
    for (const [key, button] of sectionButtons) {
      button.setAttribute("aria-pressed", String(key === id));
      sections[key].hidden = key !== id;
    }
  }
  work.append(navigation, feedback, retry, control, results, settings);
  panel.append(scopeHint, work);
  showSection("control");

  let scope = new AbortController();
  let timer;
  let status = "idle";
  let data;
  let rendered;
  let error = "";
  let pending = false;
  let reading = false;
  let pendingAction;
  let configuredOrigin;
  let disposed = false;

  function update() {
    const hasOrigin = Boolean(getOrigin());
    const name = audience.value.trim();
    const busy = pending || status === "preparing" || status === "scanning";
    const ready = status === "ready";
    const active = activeStatuses.has(status);
    const unavailable = !hasOrigin || !data || !tenant.enabled || !validAudience.test(name) || name === "legacy";
    const configured = Boolean(data?.roleEndpoint);
    work.hidden = !hasOrigin;
    scopeHint.hidden = hasOrigin;
    const message = error || (ready && name !== "public"
      ? "Гол хэсэгт SaaS-д зөв эрхээр нэвтэрсний дараа «Зураглал үүсгэх» дээр дарна уу."
      : discoveryStatuses[status] || (!data ? "Зураглалын мэдээлэл ачаалж байна…" : ""));
    if (feedback.textContent !== message) feedback.textContent = message;
    feedback.dataset.status = error ? "failed" : status;
    feedback.hidden = !feedback.textContent;
    retry.hidden = !error || active || pending;
    roleSetup.hidden = Boolean(!data || name === "public" || !validAudience.test(name) || configured);
    commands.get("prepare").disabled = unavailable || busy || ready || (name !== "public" && !configured);
    commands.get("start").disabled = unavailable || busy || (name !== "public" && !ready);
    commands.get("resume").hidden = !data?.draft;
    commands.get("resume").disabled = commands.get("start").disabled;
    commands.get("close").hidden = !active && !pendingAction;
    commands.get("close").disabled = pending || !active;
    audience.disabled = active || pending;
    startPath.disabled = busy;
    saveKey.disabled = busy || ready || !data || !tenant.enabled;
    removeKey.disabled = saveKey.disabled || !configured;
    onState({ origin: getOrigin(), audience: name, status, active, watching: active || Boolean(pendingAction && pendingAction !== "close"),
      inputLocked: status === "scanning" || Boolean(pendingAction && pendingAction !== "prepare"),
      message: feedback.textContent, hasResult: Boolean(data?.saved || data?.draft) });
  }

  function schedule() {
    clearTimeout(timer);
    if (!disposed && activeStatuses.has(status)) timer = setTimeout(() => { void refresh(); }, 850);
  }

  function renderResult() {
    const key = JSON.stringify([data.saved?.revision, data.draft?.map.states.map(state => state.id),
      data.draft?.pending, data.usage]);
    if (key === rendered) return;
    rendered = key;
    results.replaceChildren(...mapResults(data.saved, data.draft), guideUsage(data.usage, page => {
      startPath.value = page;
      showSection("control");
      startPath.focus();
    }));
  }

  async function read(signal) {
    const query = new URLSearchParams({ origin: getOrigin(), audience: audience.value.trim() });
    const next = await request(`?${query}`, { signal });
    if (signal.aborted) return;
    data = next;
    status = data.status;
    error = "";
    options.replaceChildren(...[...new Set(["public", ...data.audiences])].map(name => {
      const option = node("option");
      option.value = name;
      return option;
    }));
    if (configuredOrigin !== getOrigin()) {
      configuredOrigin = getOrigin();
      endpoint.value = data.roleEndpoint || "";
      keyStatus.textContent = data.roleEndpoint ? "Эрхийн тохиргоо идэвхтэй." : "";
    }
    renderResult();
  }

  async function refresh() {
    if (pending || reading || !getOrigin() || disposed) return;
    const { signal } = scope;
    if (!validAudience.test(audience.value.trim())) {
      error = "Зураглалд тохирох эрхийн нэр оруулна уу.";
      update();
      return;
    }
    clearTimeout(timer);
    reading = true;
    try { await read(signal); }
    catch (cause) { if (!signal.aborted) error = cause.message || retryMessage; }
    finally {
      if (!signal.aborted) {
        reading = false;
        update();
        schedule();
      }
    }
  }

  function changeScope({ system = false } = {}) {
    scope.abort();
    scope = new AbortController();
    clearTimeout(timer);
    pending = reading = false;
    pendingAction = undefined;
    status = "idle";
    error = "";
    data = rendered = undefined;
    results.replaceChildren(node("p", "Үр дүн ачаалж байна…", "monitor-empty"));
    if (system) {
      configuredOrigin = undefined;
      audience.value = "public";
      startPath.value = publicKey.value = endpoint.value = keyStatus.textContent = "";
      options.replaceChildren();
    }
    update();
    void refresh();
  }

  async function command(action) {
    if (pending || commands.get(action).disabled) return;
    clearTimeout(timer);
    scope.abort();
    scope = new AbortController();
    const { signal } = scope;
    reading = false;
    pending = true;
    pendingAction = action;
    error = "";
    update();
    try {
      const seed = action === "start" || action === "prepare" ? startPath.value.trim() : "";
      const result = await request("", { method: "POST", signal, body: {
        origin: getOrigin(), audience: audience.value.trim(), action, ...(seed ? { startPath: seed } : {}),
      } });
      if (signal.aborted) return;
      status = result.status;
      pendingAction = undefined;
      update();
      await read(signal);
    } catch (cause) {
      if (!signal.aborted) error = cause.message || retryMessage;
    } finally {
      if (!signal.aborted) {
        pending = false;
        pendingAction = undefined;
        update();
        schedule();
      }
    }
  }

  async function configureKey(remove) {
    if (pending) return;
    clearTimeout(timer);
    scope.abort();
    scope = new AbortController();
    const { signal } = scope;
    reading = false;
    pending = true;
    update();
    try {
      await request("", { method: "POST", signal, body: {
        origin: getOrigin(), action: "key", publicKey: remove ? null : publicKey.value.trim(),
        endpoint: endpoint.value.trim() || "/api/dap/role",
      } });
      if (signal.aborted) return;
      publicKey.value = "";
      configuredOrigin = undefined;
      await read(signal);
    } catch (cause) {
      if (!signal.aborted) keyStatus.textContent = cause.message || retryMessage;
    } finally {
      if (!signal.aborted) {
        pending = false;
        update();
        schedule();
      }
    }
  }

  retry.addEventListener("click", () => { void refresh(); });
  audience.addEventListener("change", () => changeScope());
  saveKey.addEventListener("click", () => { void configureKey(false); });
  removeKey.addEventListener("click", () => { void configureKey(true); });
  return {
    panel, showSection,
    syncOrigin: () => changeScope({ system: true }),
    dispose() { disposed = true; clearTimeout(timer); scope.abort(); },
  };
}
