import { createMonitorOrganizations, mountMonitor } from "./monitor.js";

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
let disposeMonitor;
let monitorOrganizations;
let monitorTenantRequest;

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
async function api(path = "", { method = "GET", body, key, signal } = {}) {
  const headers = { Accept: "application/json" };
  if (body) headers["Content-Type"] = "application/json";
  if (key) headers["Idempotency-Key"] = key;
  const response = await fetch(apiRoot + path, { method, headers, body: body && JSON.stringify(body), signal });
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
  actions.append(status(tenant), toggle, link("UI зураглал", detailPath(tenant) + "/monitor?tab=map"), link("Хяналт", detailPath(tenant) + "/monitor"));
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

function showMonitor(tenant, options) {
  const { root: directory } = monitorOrganizations;
  const scroll = directory.scrollTop;
  const focused = directory.contains(document.activeElement);
  disposeMonitor?.();
  const monitor = mountMonitor(tenant, { organizations: monitorOrganizations, ...options });
  disposeMonitor = monitor.dispose;
  app.replaceChildren(monitor.root);
  directory.scrollTop = scroll;
  if (focused) directory.querySelector('[aria-current="page"]')?.focus({ preventScroll: true });
}

async function renderMonitor(tenantId, search, request) {
  monitorTenantRequest?.abort();
  monitorTenantRequest = undefined;
  const firstVisit = !monitorOrganizations;
  monitorOrganizations ??= createMonitorOrganizations((offset, signal) => api(`?offset=${offset}`, { signal }));
  app.classList.add("monitor-route");
  showMonitor(null, {
    tenantId,
    emptyMessage: tenantId ? "Байгууллагын мэдээлэл ачаалж байна…" : "Зүүн жагсаалтаас байгууллагаа сонгоно уу.",
  });
  if (!tenantId) return;
  const pending = new AbortController();
  monitorTenantRequest = pending;
  try {
    const { tenant } = await api(`/${tenantId}`, { signal: pending.signal });
    if (navigation !== request || pending.signal.aborted) return;
    showMonitor(tenant, {
      tenantId,
      openMap: new URLSearchParams(search).get("tab") === "map",
      mapRequest: (query, options) => api(`/${tenantId}/ui-map${query}`, options),
    });
    if (firstVisit) monitorOrganizations.root.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest" });
  } catch (cause) {
    if (navigation !== request || pending.signal.aborted) return;
    showMonitor(null, { tenantId, emptyMessage: cause instanceof Error ? cause.message : unavailable });
  }
}

async function render() {
  const request = ++navigation;
  let [path, search] = location.hash.slice(1).split("?");
  if (/^\/organizations\/[a-f0-9-]{36}\/ui-map$/u.test(path)) {
    path = path.replace(/\/ui-map$/u, "/monitor");
    search = "tab=map";
    history.replaceState(history.state, "", `#${path}?${search}`);
  }
  const match = /^\/organizations\/([a-f0-9-]{36})(\/(?:edit|monitor))?$/u.exec(path);
  const monitoring = path === "/monitor" || match?.[2] === "/monitor";
  const section = monitoring ? "monitor" : "organizations";
  for (const anchor of document.querySelectorAll("[data-section]")) {
    if (anchor.dataset.section === section) anchor.setAttribute("aria-current", "page");
    else anchor.removeAttribute("aria-current");
  }
  app.setAttribute("aria-busy", "true");
  try {
    if (monitoring) {
      await renderMonitor(match?.[1], search, request);
      return;
    }

    monitorTenantRequest?.abort();
    monitorTenantRequest = undefined;
    disposeMonitor?.();
    disposeMonitor = undefined;
    monitorOrganizations?.dispose();
    monitorOrganizations = undefined;
    app.classList.remove("monitor-route");
    app.replaceChildren(node("p", "Ачаалж байна…", "empty"));

    let contents;
    if (path === "/organizations/new") {
      contents = formView();
    } else if (match) {
      const { tenant, assets } = await api(`/${match[1]}`);
      if (navigation !== request) return;
      contents = match[2] === "/edit" ? formView(tenant) : detailsView(tenant, assets);
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
