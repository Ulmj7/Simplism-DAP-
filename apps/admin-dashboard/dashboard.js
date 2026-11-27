const app = document.querySelector("#app");
const formTemplate = document.querySelector("#organization-form");
const apiRoot = "/api/platform/tenants";
const labels = {
  invalid_tenant: "Нэр, регистр, веб хаяг болон холбоо барих мэдээллээ шалгана уу.",
  company_reg_exists: "Энэ компанийн регистрээр байгууллага бүртгэгдсэн байна.",
  tenant_changed: "Бүртгэл шинэчлэгдсэн байна. Хуудсаа дахин нээгээд өөрчлөлтөө хадгална уу.",
  not_found: "Байгууллагын бүртгэл олдсонгүй.",
  forbidden: "Үйлдэл хийх боломжгүй байна.",
  discovery_busy: "Studio-д өөр зураглал ажиллаж байна. Дууссаны дараа дахин оролдоно уу.",
  discovery_disabled: "Зураглал үүсгэхийн тулд байгууллагыг идэвхжүүлнэ үү.",
  invalid_discovery: "Эхлэх зам болон эрхийн нэрийг шалгана уу.",
  invalid_audience: "Энэ зураглалд тохирох эрхийн нэр сонгоно уу.",
  invalid_role_key: "Ed25519 нийтийн түлхүүрээ PEM хэлбэрээр оруулна уу.",
  role_key_required: "Эхлээд SaaS-ийн эрх баталгаажуулах тохиргоог хадгална уу.",
  studio_login_required: "Studio браузерыг нээж, сонгосон эрхээрээ нэвтэрнэ үү.",
};
const unavailable = "Үйлдэл амжилтгүй боллоо. Дахин оролдоно уу.";
let navigation = 0;

function node(tag, value, className) {
  const element = document.createElement(tag);
  if (value !== undefined) element.textContent = value;
  if (className) element.className = className;
  return element;
}
function link(text, href, className = "button") {
  const element = node("a", text, className);
  element.href = href;
  return element;
}
function title(text, action) {
  const header = node("div", undefined, "page-title");
  header.append(node("h1", text));
  if (action) header.append(action);
  return header;
}
function status(tenant) {
  return node("span", tenant.enabled ? "Идэвхтэй" : "Идэвхгүй", tenant.enabled ? "status active" : "status inactive");
}
function connection(tenant) {
  return tenant.lastConnectedAt
    ? new Date(tenant.lastConnectedAt).toLocaleString("mn")
    : "Хараахан холбогдоогүй";
}
function detailPath(tenant) {
  return `#/organizations/${tenant.tenantId}`;
}
async function api(path = "", { method = "GET", body, key } = {}) {
  const headers = { Accept: "application/json" };
  if (body) headers["Content-Type"] = "application/json";
  if (key) headers["Idempotency-Key"] = key;
  const response = await fetch(apiRoot + path, { method, headers, body: body && JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(labels[result.error] ?? unavailable);
  return result;
}

async function listView() {
  const offsetText = new URLSearchParams(location.hash.split("?")[1]).get("offset");
  const offset = offsetText && /^\d{1,9}$/u.test(offsetText) ? Number(offsetText) : 0;
  const { tenants, nextOffset } = await api(`?offset=${offset}`);
  const heading = title("Байгууллагууд", link("Байгууллага нэмэх", "#/organizations/new", "button primary"));
  if (!tenants.length) {
    const content = [heading, node("p", "Бүртгэлтэй байгууллага алга.", "empty")];
    if (offset) content.push(link("Өмнөх хуудас", `#/?offset=${Math.max(0, offset - 50)}`));
    return content;
  }

  const table = node("table");
  const head = table.createTHead().insertRow();
  for (const text of ["Байгууллага", "Зөвшөөрсөн хаягууд", "AI туслах", "Төлөв", "Сүүлд холбогдсон"]) {
    const cell = node("th", text);
    cell.scope = "col";
    head.append(cell);
  }
  const body = table.createTBody();
  for (const tenant of tenants) {
    const row = body.insertRow();
    const organization = row.insertCell();
    organization.append(link(tenant.name, detailPath(tenant), "organization-link"));
    organization.append(node("small", tenant.companyReg || tenant.slug, "secondary"));
    const origins = row.insertCell();
    for (const origin of tenant.allowedOrigins) origins.append(node("div", origin, "origin"));
    row.insertCell().textContent = tenant.agentName;
    row.insertCell().append(status(tenant));
    row.insertCell().textContent = connection(tenant);
  }
  const card = node("div", undefined, "table-wrap");
  card.append(table);
  const pages = node("div", undefined, "actions");
  if (offset) pages.append(link("Өмнөх", `#/?offset=${Math.max(0, offset - 50)}`));
  if (nextOffset !== null) pages.append(link("Дараах", `#/?offset=${nextOffset}`));
  return [heading, card, pages];
}

function installationCode(tenant, assets) {
  return [
    "<script",
    `  src="${assets.src}"`,
    `  data-install="${tenant.installationId}"`,
    `  data-api-origin="${assets.apiOrigin}"`,
    `  integrity="${assets.integrity}"`,
    '  crossorigin="anonymous"',
    "  defer",
    "></script>",
  ].join("\n");
}

function detailsView(tenant, assets) {
  const details = node("section", undefined, "panel");
  details.append(node("h2", "Бүртгэлийн мэдээлэл"));
  const fields = node("dl");
  const entries = [
    ["Компанийн регистр", tenant.companyReg],
    ["AI туслахын нэр", tenant.agentName],
    ["Сүүлд холбогдсон", connection(tenant)],
    ["Зөвшөөрсөн веб хаягууд", tenant.allowedOrigins.join("\n")],
    ["Албан хаяг", tenant.address],
    ["Утас", tenant.phoneNumber],
    ["Имэйл", tenant.contactEmail],
  ];
  for (const [label, value] of entries) {
    fields.append(node("dt", label), node("dd", value || "—"));
  }
  const error = node("p", undefined, "error");
  error.setAttribute("role", "alert");
  error.hidden = true;
  const toggle = node("button", tenant.enabled ? "Идэвхгүй болгох" : "Идэвхжүүлэх");
  toggle.type = "button";
  toggle.addEventListener("click", async () => {
    if (tenant.enabled && !window.confirm(`${tenant.name} байгууллагын agent-ыг идэвхгүй болгох уу?`)) return;
    toggle.disabled = true;
    error.hidden = true;
    try {
      await api(`/${tenant.tenantId}/status`, { method: "POST", body: { enabled: !tenant.enabled } });
      if (location.hash === detailPath(tenant)) await render();
    } catch (cause) {
      error.textContent = cause instanceof Error ? cause.message : unavailable;
      error.hidden = false;
    } finally {
      toggle.disabled = false;
    }
  });
  const actions = node("div", undefined, "actions");
  actions.append(status(tenant), toggle, link("UI зураглал", detailPath(tenant) + "/ui-map"));
  details.append(fields, actions, error);

  const install = node("section", undefined, "panel");
  install.append(node("h2", "SaaS вебэд суулгах"));
  if (assets) {
    const code = node("textarea", undefined, "script");
    code.readOnly = true;
    code.rows = 9;
    code.setAttribute("aria-label", "Суулгах скрипт");
    code.value = installationCode(tenant, assets);
    const copy = node("button", "Суулгах скрипт хуулах", "primary");
    copy.type = "button";
    const feedback = node("span", undefined, "feedback");
    feedback.setAttribute("role", "status");
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(code.value);
        feedback.textContent = "Скрипт хуулагдлаа.";
      } catch {
        code.focus();
        code.select();
        feedback.textContent = "Сонгосон кодыг хуулна уу.";
      }
    });
    const tools = node("div", undefined, "actions");
    tools.append(copy, feedback);
    install.append(node("p", "Кодыг SaaS вебийн үндсэн layout-д, </body> тагийн өмнө нэг удаа байрлуулна."), code, tools);
  } else {
    install.append(node("p", "Суулгах скриптийн хаяг тохируулагдаагүй байна."));
  }

  const panels = node("div", undefined, "details");
  panels.append(details, install);
  return [
    link("← Байгууллагын жагсаалт", "#/", "back"),
    title(tenant.name, link("Мэдээлэл засах", detailPath(tenant) + "/edit", "button primary")),
    panels,
  ];
}

const discoveryStatuses = {
  idle: "",
  preparing: "Браузер нээж байна…",
  ready: "Нээгдсэн браузерт SaaS-д нэвтэрч, дараа нь «Зураглал үүсгэх» товчийг дарна уу.",
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

function uiMapView(tenant) {
  const panel = node("section", undefined, "panel");
  const field = node("label", "SaaS вебийн хаяг");
  const originSelect = node("select");
  for (const origin of tenant.allowedOrigins) {
    const option = node("option", origin);
    option.value = origin;
    originSelect.append(option);
  }
  field.append(originSelect);
  const audienceLabel = node("label", "Зураглалын эрх");
  const audienceInput = node("input");
  audienceInput.value = "public";
  audienceInput.setAttribute("list", "studio-audiences");
  audienceInput.placeholder = "public, finance-admin";
  const audienceOptions = node("datalist");
  audienceOptions.id = "studio-audiences";
  audienceLabel.append(audienceInput, audienceOptions, node("small", "Нийтлэг UI-д public, эрхтэй UI-д SaaS-аас баталгаажуулдаг role нэрийг оруулна."));
  const pathLabel = node("label", "Эхлэх зам");
  const startPath = node("input");
  startPath.placeholder = "/settings";
  pathLabel.append(startPath, node("small", "Хоосон бол нүүр хуудас эсвэл Studio браузерын нээлттэй хуудаснаас эхэлнэ."));
  const prepare = node("button", "Studio браузер нээх");
  const start = node("button", "Зураглал үүсгэх", "primary");
  const resume = node("button", "Үргэлжлүүлэх");
  const close = node("button", "Зогсоох");
  const controls = node("div", undefined, "actions map-actions");
  controls.append(prepare, start, resume, close);
  const feedback = node("p", "");
  feedback.setAttribute("role", "status");
  const results = node("div");
  const settings = node("details", undefined, "map-state");
  settings.append(node("summary", "SaaS-ийн эрх баталгаажуулах тохиргоо"));
  const endpointLabel = node("label", "SaaS-ийн эрхийн endpoint");
  const endpoint = node("input");
  endpoint.placeholder = "/api/dap/role";
  endpointLabel.append(endpoint);
  const keyLabel = node("label", "Ed25519 нийтийн түлхүүр");
  const publicKey = node("textarea");
  publicKey.rows = 3;
  publicKey.placeholder = "-----BEGIN PUBLIC KEY-----";
  keyLabel.append(publicKey);
  const keyStatus = node("p", "");
  keyStatus.setAttribute("role", "status");
  const saveKey = node("button", "Эрхийн тохиргоо хадгалах");
  const removeKey = node("button", "Эрхийн тохиргоо салгах");
  const keyActions = node("div", undefined, "actions");
  keyActions.append(saveKey, removeKey);
  settings.append(node("p", "SaaS-ийн endpoint нь нэвтэрсэн хэрэглэгчийн сессийг шалгаад { token } буцаана. JWT-г SaaS backend EdDSA-аар гарын үсэг зурна."),
    node("p", `JWT талбарууд · aud = ${tenant.installationId} · origin = SaaS-ийн хаяг · role = эрхийн нэр · iat, exp = Unix секунд, хүчинтэй хугацаа 5 минут хүртэл.`),
    endpointLabel, keyLabel, keyActions, keyStatus);
  panel.append(field, audienceLabel, pathLabel, controls, feedback, settings, results);

  let timer;
  let version = 0;
  let rendered = "";
  let currentStatus = "idle";
  let hasDraft = false;
  let configured = false;
  let configuredOrigin = "";
  const path = `/${tenant.tenantId}/ui-map`;
  function showStatus(status) {
    currentStatus = status;
    const busy = ["preparing", "scanning"].includes(status);
    const ready = status === "ready";
    feedback.textContent = discoveryStatuses[status] ?? "";
    const audience = audienceInput.value.trim();
    const scoped = audience !== "public";
    prepare.hidden = !scoped || audience === "legacy";
    prepare.disabled = busy || ready || !tenant.enabled || !configured;
    start.disabled = busy || !tenant.enabled || audience === "legacy" || (scoped && !ready);
    resume.hidden = !hasDraft;
    resume.disabled = start.disabled;
    originSelect.disabled = audienceInput.disabled = busy || ready;
    startPath.disabled = busy;
    saveKey.disabled = removeKey.disabled = busy || ready;
    close.hidden = !busy && !ready;
  }
  async function refresh(action) {
    clearTimeout(timer);
    const origin = originSelect.value;
    const audience = audienceInput.value.trim();
    if (!/^[a-z][a-z0-9-]{0,40}$/u.test(audience)) {
      feedback.textContent = labels.invalid_audience;
      return;
    }
    const request = ++version;
    try {
      if (action) {
        prepare.disabled = start.disabled = resume.disabled = close.disabled = originSelect.disabled = audienceInput.disabled = true;
        const seed = action === "start" ? startPath.value.trim() : "";
        await api(path, { method: "POST", body: { origin, action, audience, ...(seed ? { startPath: seed } : {}) } });
      }
      const { status, saved, draft, audiences, roleEndpoint, usage } = await api(`${path}?origin=${encodeURIComponent(origin)}&audience=${encodeURIComponent(audience)}`);
      if (!panel.isConnected || request !== version) return;
      audienceOptions.replaceChildren(...[...new Set(["public", ...audiences])].map(value => {
        const option = node("option");
        option.value = value;
        return option;
      }));
      hasDraft = Boolean(draft);
      configured = Boolean(roleEndpoint);
      if (configuredOrigin !== origin) {
        endpoint.value = roleEndpoint || "";
        publicKey.value = "";
        keyStatus.textContent = configured ? "Эрхийн тохиргоо идэвхтэй." : "Нийтлэг зураглал ашиглаж байна.";
        configuredOrigin = origin;
      }
      close.disabled = false;
      showStatus(status);
      const key = JSON.stringify([origin, audience, saved?.revision, draft?.map.states.length, draft?.pending.length, usage]);
      if (key !== rendered) {
        results.replaceChildren(...mapResults(saved, draft), guideUsage(usage, page => {
          startPath.value = page;
          startPath.focus();
        }));
        rendered = key;
      }
      if (["preparing", "ready", "scanning"].includes(status)) timer = setTimeout(() => { if (panel.isConnected) void refresh(); }, 1500);
    } catch (error) {
      if (!panel.isConnected || request !== version) return;
      close.disabled = false;
      showStatus(currentStatus);
      feedback.textContent = error instanceof Error ? error.message : unavailable;
      if (["preparing", "ready", "scanning"].includes(currentStatus)) {
        timer = setTimeout(() => { if (panel.isConnected) void refresh(); }, 1500);
      }
    }
  }
  async function configureKey(remove) {
    const origin = originSelect.value;
    saveKey.disabled = removeKey.disabled = true;
    try {
      await api(path, { method: "POST", body: { origin, action: "key", publicKey: remove ? null : publicKey.value.trim(),
        endpoint: endpoint.value.trim() || "/api/dap/role" } });
      publicKey.value = "";
      configuredOrigin = "";
      await refresh();
    } catch (error) {
      keyStatus.textContent = error instanceof Error ? error.message : unavailable;
      showStatus(currentStatus);
    }
  }
  originSelect.addEventListener("change", () => void refresh());
  audienceInput.addEventListener("change", () => void refresh());
  prepare.addEventListener("click", () => void refresh("prepare"));
  start.addEventListener("click", () => void refresh("start"));
  resume.addEventListener("click", () => void refresh("resume"));
  close.addEventListener("click", () => void refresh("close"));
  saveKey.addEventListener("click", () => void configureKey(false));
  removeKey.addEventListener("click", () => void configureKey(true));
  showStatus("idle");
  queueMicrotask(() => { if (panel.isConnected) void refresh(); });
  return [link("← Байгууллагын мэдээлэл", detailPath(tenant), "back"), title("Studio · UI зураглал"), panel];
}

function formView(tenant) {
  const fragment = formTemplate.content.cloneNode(true);
  const form = fragment.querySelector("form");
  const error = form.querySelector(".error");
  const submit = form.querySelector('button[type="submit"]');
  let previousPayload;
  let createKey;
  if (tenant) {
    for (const name of ["name", "companyReg", "agentName", "address", "phoneNumber", "contactEmail"]) {
      form.elements.namedItem(name).value = tenant[name] ?? "";
    }
    form.elements.namedItem("allowedOrigins").value = tenant.allowedOrigins.join("\n");
    form.querySelector(".cancel").href = detailPath(tenant);
  }
  form.addEventListener("submit", async event => {
    event.preventDefault();
    submit.disabled = true;
    error.hidden = true;
    const formData = new FormData(form);
    const value = field => String(formData.get(field) ?? "").trim();
    const body = {
      name: value("name"),
      companyReg: value("companyReg"),
      allowedOrigins: value("allowedOrigins").split("\n").map(origin => origin.trim()).filter(Boolean),
    };
    for (const name of ["agentName", "address", "phoneNumber", "contactEmail"]) {
      const text = value(name);
      if (text) body[name] = text;
    }

    const currentNavigation = navigation;
    try {
      let result;
      if (tenant) {
        result = await api(`/${tenant.tenantId}`, { method: "PATCH", body: { ...body, revision: tenant.revision } });
      } else {
        const payload = JSON.stringify(body);
        if (payload !== previousPayload) {
          createKey = crypto.randomUUID();
          previousPayload = payload;
        }
        result = await api("", { method: "POST", body, key: createKey });
      }
      if (navigation === currentNavigation) location.hash = detailPath(result.tenant);
    } catch (cause) {
      error.textContent = cause instanceof Error ? cause.message : unavailable;
      error.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
  const panel = node("section", undefined, "panel form-panel");
  panel.append(fragment);
  return [title(tenant ? "Байгууллагын мэдээлэл засах" : "Шинэ байгууллага"), panel];
}

async function render() {
  const request = ++navigation;
  app.setAttribute("aria-busy", "true");
  app.replaceChildren(node("p", "Ачаалж байна…", "empty"));
  try {
    const path = location.hash.slice(1).split("?")[0];
    const match = /^\/organizations\/([a-f0-9-]{36})(\/(?:edit|ui-map))?$/u.exec(path);
    let contents;
    if (path === "/organizations/new") {
      contents = formView();
    } else if (match) {
      const { tenant, assets } = await api(`/${match[1]}`);
      contents = match[2] === "/edit" ? formView(tenant)
        : match[2] === "/ui-map" ? uiMapView(tenant) : detailsView(tenant, assets);
    } else {
      contents = await listView();
    }
    if (navigation === request) app.replaceChildren(...contents);
  } catch (cause) {
    if (navigation !== request) return;
    const error = node("p", cause instanceof Error ? cause.message : unavailable, "error");
    error.setAttribute("role", "alert");
    app.replaceChildren(error, link("Байгууллагын жагсаалт", "#/"));
  } finally {
    if (navigation === request) app.setAttribute("aria-busy", "false");
  }
}

window.addEventListener("hashchange", () => { void render(); });
void render();
