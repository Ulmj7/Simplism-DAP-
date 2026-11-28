import { mountStudioMap } from "./studio-map.js";
import { mountStudioLiveView } from "./studio-live-view.js";

const tabs = [
  ["map", "Зураглал"], ["activity", "Үйлдэл"], ["dom", "DOM Explorer"], ["console", "Console"], ["network", "Network"], ["storage", "Storage"],
];
const mapStatuses = {
  preparing: "Браузер нээж байна", ready: "Браузер бэлэн", scanning: "Зураглал үүсгэж байна",
  complete: "Зураглал хадгалагдсан", paused: "Зураглал түр зогссон", "access-required": "Нэвтрэх эрх шаардлагатай", failed: "Зураглал амжилтгүй",
};
const recognition = {
  mapped: "Зураглалд орсон", recognized: "Танигдсан ч зураглалд ороогүй",
  unrecognized: "UI уншигч таниагүй", unavailable: "Шалгах боломжгүй",
};
const states = { running: "Ажиллаж байна", success: "Амжилттай", failed: "Алдаа", started: "Эхэлсэн",
  completed: "Дууссан", stopped: "Зогссон", highlighted: "Тодруулсан", confirmed: "Баталгаажсан" };
const time = value => value ? new Date(value).toLocaleTimeString("mn", { hour12: false }) : "";
const day = value => new Date(value).toLocaleString("mn", { dateStyle: "short", timeStyle: "short" });

function element(tag, label, style) {
  const node = document.createElement(tag);
  if (label !== undefined) node.textContent = label;
  if (style) node.className = style;
  return node;
}
function button(label, callback, style) {
  const node = element("button", label, style);
  node.type = "button";
  node.addEventListener("click", callback);
  return node;
}
function fields(entries) {
  const list = element("dl", undefined, "monitor-fields");
  for (const [label, value] of entries) list.append(element("dt", label), element("dd", value ?? "—"));
  return list;
}
function empty(label) { return element("p", label, "monitor-empty"); }

export function createMonitorOrganizations(readPage) {
  const root = element("section", undefined, "monitor-organizations");
  root.setAttribute("aria-label", "Байгууллагууд");
  const list = element("ul", undefined, "monitor-org-list");
  const feedback = empty("Байгууллагуудыг ачаалж байна…");
  feedback.setAttribute("role", "status");
  const retry = button("Дахин оролдох", () => { void load(); });
  retry.hidden = true;
  root.append(list, feedback, retry);

  const entries = new Map();
  const controller = new AbortController();
  let selectedId;
  let sites;
  let offset = 0;
  let loading = false;

  function showSelection(id) {
    const entry = entries.get(id);
    if (!entry) return;
    const selected = id === selectedId;
    entry.link.setAttribute("aria-expanded", String(selected && Boolean(sites)));
    if (selected) {
      entry.link.setAttribute("aria-current", "page");
      if (sites) entry.row.append(sites);
    } else entry.link.removeAttribute("aria-current");
  }

  function add(tenant) {
    if (entries.has(tenant.tenantId)) return;
    const row = element("li");
    const link = element("a", tenant.name, "monitor-org-link");
    link.href = `#/organizations/${tenant.tenantId}/monitor`;
    link.title = tenant.name;
    link.addEventListener("click", event => {
      if (tenant.tenantId === selectedId && sites && event.button === 0 &&
          !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) event.preventDefault();
    });
    row.append(link);
    list.append(row);
    entries.set(tenant.tenantId, { row, link });
    showSelection(tenant.tenantId);
  }

  async function load() {
    if (loading || offset === null || controller.signal.aborted) return;
    loading = true;
    retry.hidden = true;
    feedback.hidden = false;
    feedback.textContent = "Байгууллагуудыг ачаалж байна…";
    try {
      while (offset !== null && !controller.signal.aborted) {
        const { tenants, nextOffset } = await readPage(offset, controller.signal);
        if (controller.signal.aborted) return;
        for (const tenant of tenants) add(tenant);
        offset = nextOffset;
      }
      feedback.hidden = entries.size > 0;
      feedback.textContent = entries.size ? "" : "Бүртгэлтэй байгууллага алга.";
    } catch {
      if (!controller.signal.aborted) {
        feedback.textContent = "Байгууллагын жагсаалт ачаалсангүй.";
        retry.hidden = false;
      }
    } finally { loading = false; }
  }

  void load();
  return {
    root,
    select(id, siteList, tenant) {
      const previous = selectedId;
      sites?.remove();
      selectedId = id;
      sites = siteList;
      if (tenant) add(tenant);
      if (previous !== id) showSelection(previous);
      showSelection(id);
      if (entries.size && offset === null) feedback.hidden = true;
    },
    dispose() { controller.abort(); },
  };
}

export function mountMonitor(tenant, { organizations, tenantId, openMap, mapRequest, emptyMessage }) {
  const root = element("section", undefined, "monitor");
  root.dataset.pane = "sessions";
  if (tenantId) root.classList.add("monitor-has-organization");
  const toolbar = element("header", undefined, "monitor-toolbar");
  const context = element("div", undefined, "monitor-context");
  const title = element("h1", "Хяналт");
  context.append(title);
  if (tenant) {
    const organization = element("a", tenant.name, "monitor-organization");
    organization.href = `#/organizations/${tenant.tenantId}`;
    organization.title = tenant.name;
    context.append(organization);
  }
  const studio = button("Зураглал", () => openStudio(), "monitor-studio-link");
  studio.disabled = !tenant;
  const availableSites = tenant?.allowedOrigins ?? [];
  let origin = availableSites.length === 1 ? availableSites[0] : "";
  const siteName = element("span", "", "monitor-site-name");
  siteName.hidden = !tenant;
  toolbar.append(context, siteName, studio);

  const paneNavigation = element("nav", undefined, "monitor-pane-navigation");
  paneNavigation.setAttribute("aria-label", "Хяналтын хэсгүүд");
  const paneButtons = new Map([
    ["sessions", "Сессүүд"], ["viewport", "Дүрс"], ["inspector", "Шалгах"],
  ].map(([id, label]) => [id, button(label, () => showPane(id))]));
  paneButtons.forEach(control => paneNavigation.append(control));
  function showPane(pane) {
    root.dataset.pane = pane;
    paneButtons.forEach((control, id) => control.setAttribute("aria-pressed", String(id === pane)));
  }
  showPane("sessions");

  const sidebar = element("aside", undefined, "monitor-panel monitor-sidebar");
  const viewport = element("section", undefined, "monitor-panel monitor-viewport");
  viewport.setAttribute("aria-label", "Браузерын дүрс");
  const inspector = element("section", undefined, "monitor-panel monitor-inspector");
  inspector.setAttribute("aria-label", "Шалгах");
  const navigation = element("div", undefined, "monitor-tabs");
  navigation.setAttribute("role", "group");
  navigation.setAttribute("aria-label", "Оношлогооны табууд");
  const content = element("div", undefined, "monitor-content");
  const browserList = element("div", undefined, "monitor-list");
  const widgetList = element("div", undefined, "monitor-list");
  const sidebarTitle = element("div", undefined, "monitor-panel-heading");
  sidebarTitle.append(element("h2", "Байгууллагууд"));
  const sideBody = element("div", undefined, "monitor-side-body");
  browserList.append(empty("Studio сесс хайж байна…"));
  const mapProgress = element("p", "", "monitor-map-progress");
  mapProgress.hidden = true;
  sideBody.append(element("h3", "Studio браузер"), mapProgress, browserList, element("h3", "Widget-ийн заавар"), widgetList);
  sidebar.append(sidebarTitle, organizations.root, sideBody);

  const siteList = availableSites.length ? element("ul", undefined, "monitor-site-list") : undefined;
  const siteControls = new Map();
  if (siteList) {
    const origins = availableSites.length === 1 ? availableSites : ["", ...availableSites];
    for (const value of origins) {
      const label = value ? new URL(value).host : "Бүх систем";
      const row = element("li");
      const control = button(label, () => selectOrigin(value), "monitor-site-button");
      control.title = value || label;
      row.append(control);
      siteList.append(row);
      siteControls.set(value, control);
    }
  }
  function showSite() {
    const selected = siteControls.get(origin);
    siteName.textContent = selected?.textContent ?? "Сайт алга";
    siteName.title = origin;
    for (const [value, control] of siteControls) control.setAttribute("aria-pressed", String(value === origin));
  }
  showSite();
  organizations.select(tenantId, siteList, tenant);

  const address = element("span", "Нээлттэй хуудас алга", "monitor-address");
  const viewState = element("span", "Сесс сонгоогүй", "monitor-view-state");
  const viewStatus = element("time", "", "monitor-view-status");
  const viewSize = element("span", "", "monitor-view-size");
  const viewHeader = element("div", undefined, "monitor-address-bar");
  viewHeader.append(address);
  const stage = element("div", undefined, "monitor-stage");
  const surface = element("div", undefined, "monitor-surface");
  const image = element("img");
  image.alt = "Сонгосон Studio браузерын дүрс";
  const outline = element("div", undefined, "monitor-outline");
  outline.hidden = true;
  const placeholder = empty(emptyMessage ?? "Зураглал табаас Studio сесс нээнэ үү.");
  const messageArea = element("div", undefined, "monitor-view-empty");
  messageArea.append(placeholder);
  surface.append(image, outline);
  stage.append(messageArea, surface);
  surface.hidden = image.hidden = true;

  let selection;
  let controller = new AbortController();
  let directoryController = new AbortController();
  let activeTab = openMap ? "map" : "activity";
  let mapState;
  let followedMap = false;
  let directoryDue = true;
  let revision;
  let after = 0;
  let records = [];
  let source = "";
  let outcome = "";
  let correlation;
  const expandedEvents = new Set();
  let dom;
  let domPending = false;
  let domError = false;
  let picked;
  let expanded = new Set();
  let filter = "";
  let storage;
  let storagePending = false;
  let selectedRun;
  let listed = "";
  let previewGeneration = 0;
  let frameView;
  let frameRequest;
  let actionHighlight;
  let objectUrl;
  let disposed = false;

  const viewFooter = element("div", undefined, "monitor-view-footer");
  viewFooter.append(viewState, viewStatus, viewSize);
  viewport.append(viewHeader, stage, viewFooter);
  inspector.append(navigation, content);
  root.append(toolbar, paneNavigation, sidebar, viewport, inspector);
  if (!tenant) {
    sideBody.hidden = navigation.hidden = true;
    viewState.textContent = "Байгууллага сонгоогүй";
    content.append(empty("Зүүн жагсаалтаас байгууллагаа сонгоно уу."));
    return { root, dispose() {} };
  }
  const mapping = mountStudioMap({ tenant, getOrigin: () => origin, request: mapRequest, onState: updateMapState });
  const live = mountStudioLiveView(surface, image, {
    maySend: () => selection?.mode === "control" && !isInputLocked(),
    onFrame: (blob, view) => renderFrame(blob, view, "Studio удирдлага"),
    onStatus: status => {
      const reconnecting = status === "reconnecting";
      if (reconnecting) directoryDue = true;
      resetFrame(reconnecting ? "Studio-той дахин холбогдож байна…" : "Studio браузерт холбогдож байна…");
    },
  });

  const stageObserver = new ResizeObserver(([entry]) => {
    surface.style.setProperty("--stage-height", `${entry.contentRect.height}px`);
  });
  stageObserver.observe(stage);

  async function request(path, signal, asImage = false) {
    const response = await fetch(`/api/platform/tenants/${tenant.tenantId}/monitor${path}`, { signal, cache: "no-store" });
    if (!response.ok) throw new Error(String(response.status));
    return asImage ? { blob: await response.blob(), view: response.headers.get("x-dap-view") } : response.json();
  }
  function sessionResource(resource) { return `/sessions/${selection.id}/${resource}`; }
  function setAddress(url) {
    address.textContent = url || "Нээлттэй хуудас алга";
    address.title = url || "";
  }
  function setFrameState(message, status) {
    placeholder.textContent = message;
    viewState.textContent = status;
    viewState.classList.remove("monitor-live");
  }
  function resetFrame(message, status = "Дүрсгүй") {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = frameView = undefined;
    image.removeAttribute("src");
    surface.hidden = image.hidden = outline.hidden = true;
    setFrameState(message, status);
    messageArea.hidden = false;
    viewStatus.textContent = "";
    viewSize.textContent = "";
  }
  function openStudio(section = "control") {
    mapping.showSection(section);
    showPane("inspector");
    switchTab("map");
  }

  function updateMapState(state) {
    const changed = mapState?.status !== state.status || mapState?.watching !== state.watching ||
      mapState?.origin !== state.origin || mapState?.audience !== state.audience;
    if (changed) {
      directoryDue = true;
      if (!state.watching) followedMap = false;
    }
    const showResults = mapState?.status === "scanning" &&
      mapState.origin === state.origin && mapState.audience === state.audience &&
      ["complete", "paused"].includes(state.status) && state.hasResult;
    const ended = mapState?.active && !state.active && selection?.source === "UI зураглал" &&
      selection.origin === state.origin && selection.audience === state.audience;
    const wasLocked = isInputLocked();
    mapState = state;
    if (selection?.mode === "control" && isInputLocked() && !wasLocked) {
      resetFrame("Зураглалд зориулж браузерыг бэлдэж байна…");
    }
    syncLive();
    if (ended) {
      const id = selection.id;
      latestDirectory.sessions = latestDirectory.sessions.filter(session => session.id !== id);
      select(undefined, false, { follow: true });
      displayLists(latestDirectory);
    }
    mapProgress.textContent = mapStatuses[state.status] ?? "";
    mapProgress.title = state.message;
    mapProgress.dataset.status = state.status;
    mapProgress.hidden = !mapProgress.textContent;
    showMapResult();
    if (showResults) openStudio("results");
  }

  function showMapResult() {
    const finished = mapState && ["complete", "paused"].includes(mapState.status) && mapState.hasResult;
    if (!selection) {
      if (finished) setFrameState(mapState.message, "Сесс дууссан");
      else if (mapState?.active) setFrameState(mapState.message, "Studio");
      else setFrameState("Зураглал табаас Studio сесс нээнэ үү.", "Сесс сонгоогүй");
    }
  }

  function showOutline() {
    const row = activeTab === "dom" ? dom?.nodes.find(item => item.id === picked) : undefined;
    const view = row ? dom?.view : actionHighlight?.view;
    const bounds = row ? row.bounds : actionHighlight?.bounds;
    outline.hidden = true;
    if (!bounds || !view || !view.width || !view.height || frameView !== [view.revision, view.width, view.height, view.x, view.y].join(",")) return;
    const x = Math.max(0, bounds.x);
    const y = Math.max(0, bounds.y);
    const width = Math.min(view.width, bounds.x + bounds.width) - x;
    const height = Math.min(view.height, bounds.y + bounds.height) - y;
    if (width <= 0 || height <= 0) return;
    outline.style.left = `${100 * x / view.width}%`;
    outline.style.top = `${100 * y / view.height}%`;
    outline.style.width = `${100 * width / view.width}%`;
    outline.style.height = `${100 * height / view.height}%`;
    outline.hidden = false;
  }
  function switchTab(tab) {
    if (activeTab !== tab) content.scrollTop = 0;
    activeTab = tab;
    drawTabs();
    drawContent();
    showOutline();
    if (tab === "dom" && !dom) void loadDom();
    if (tab === "storage" && !storage) void loadStorage();
  }
  function drawTabs() {
    const focused = navigation.contains(document.activeElement) ? document.activeElement.dataset.inspectorTab : undefined;
    navigation.replaceChildren(...tabs.filter(([id]) => id === "map" ||
      (selection && (!selection.widget || id === "activity"))).map(([id, label]) => {
      const control = button(label, () => { correlation = undefined; switchTab(id); });
      control.dataset.inspectorTab = id;
      control.setAttribute("aria-pressed", String(id === activeTab));
      return control;
    }));
    if (focused && !navigation.hidden) navigation.querySelector(`[data-inspector-tab="${focused}"]`)?.focus({ preventScroll: true });
  }
  function select(item, widget, { follow = false } = {}) {
    controller.abort();
    controller = new AbortController();
    selection = item ? { ...item, widget } : undefined;
    after = 0;
    records = [];
    dom = picked = storage = revision = selectedRun = correlation = actionHighlight = undefined;
    expanded = new Set();
    expandedEvents.clear();
    content.scrollTop = 0;
    filter = source = outcome = "";
    domPending = domError = storagePending = false;
    previewGeneration++;
    if (!follow || !item || widget || !["map", "activity"].includes(activeTab)) {
      activeTab = activeTab === "map" || !item ? "map" : "activity";
    }
    if (widget) activeTab = "activity";
    setAddress(item ? item.url ?? item.origin : "");
    resetFrame(widget ? "Widget-ийн зааврын алхмууд баруун талд харагдана."
      : item ? "Браузерын дүрс ачаалж байна…"
        : "Studio браузер нээгээд сессээ сонгоно уу.", item ? widget ? "Widget-ийн түүх" : "Холбогдож байна" : "Сесс сонгоогүй");
    syncLive();
    if (!follow) showPane(item ? widget ? "inspector" : "viewport" : "sessions");
    showMapResult();
    drawTabs();
    drawContent();
  }
  function filterSelect(label, items, current, changed) {
    const control = element("select");
    control.setAttribute("aria-label", label);
    control.dataset.eventControl = label;
    for (const [value, name] of items) {
      const option = element("option", name);
      option.value = value;
      option.selected = current === value;
      control.append(option);
    }
    control.addEventListener("change", () => { changed(control.value); drawContent(); });
    return control;
  }
  function activityRows() {
    const activity = records.filter(event => event.channel === "activity");
    const starts = new Map(activity.filter(event => event.outcome === "running").map(event => [event.id, event]));
    const rows = new Map();
    for (const event of activity) {
      const start = starts.get(event.related);
      const finished = event.outcome !== "running" && event.durationMs !== undefined;
      if (finished && (start === undefined || (start.action === event.action && start.source === event.source))) {
        const id = event.related ?? event.id;
        rows.set(id, { ...start, ...event, key: id, at: start?.at ?? event.at - event.durationMs, correlation: id });
      } else {
        rows.set(event.id, { ...event, key: event.id, correlation: event.related ?? event.id });
      }
    }
    return [...rows.values()].filter(event => (!source || source === event.source) && (!outcome || outcome === event.outcome)).reverse();
  }

  function eventRow(event, relatedLinks) {
    const key = `${activeTab}-${event.key}`;
    const row = element("article", undefined, "monitor-event");
    row.dataset.eventRow = key;
    const summary = button("", () => {
      if (expandedEvents.delete(key)) detail.hidden = true;
      else { expandedEvents.add(key); detail.hidden = false; }
      summary.setAttribute("aria-expanded", String(!detail.hidden));
    }, "monitor-event-summary");
    summary.dataset.eventControl = key;
    summary.setAttribute("aria-expanded", String(expandedEvents.has(key)));
    summary.setAttribute("aria-controls", `monitor-event-${key}`);
    const name = activeTab !== "activity" && event.detail ? `${event.action} · ${event.detail}` : event.action;
    const label = element("span", name, "monitor-event-name");
    label.title = name;
    const status = element("span", event.status ?? states[event.outcome] ?? "—", "monitor-event-status");
    status.title = status.textContent;
    status.dataset.status = event.outcome ?? (event.action === "error" ? "failed" : "");
    summary.append(element("time", time(event.at) || "—"), label, element("span", event.source, "monitor-event-source"),
      status, element("span", event.durationMs === undefined ? "—" : `${event.durationMs} ms`, "monitor-event-duration"),
      element("span", "", "monitor-event-chevron"));

    const detail = element("div", undefined, "monitor-event-detail");
    detail.id = `monitor-event-${key}`;
    detail.hidden = !expandedEvents.has(key);
    if (event.target) detail.append(fields([["Зорьсон элемент", event.target]]));
    if (event.detail) detail.append(element("code", event.detail));
    if (relatedLinks) {
      for (const [channel, label] of [["network", "Network мөрүүд"], ["console", "Console мөрүүд"]]) {
        const count = records.filter(record => record.channel === channel && record.related === event.correlation).length;
        if (count) {
          const link = button(`${label} · ${count}`, () => { correlation = event.correlation; switchTab(channel); });
          link.dataset.eventControl = `${key}-${channel}`;
          detail.append(link);
        }
      }
    }
    if (!detail.childElementCount) detail.append(empty("Нэмэлт мэдээлэл алга."));
    row.append(summary, detail);
    return row;
  }

  function eventView() {
    const box = element("div", undefined, "monitor-events");
    if (selection.widget) {
      if (!selectedRun) return empty("Зааврын мэдээлэл ачаалж байна…");
      return runView(selectedRun);
    }
    if (activeTab === "activity") {
      const filters = element("div", undefined, "monitor-filters");
      filters.append(filterSelect("Эх сурвалж", [["", "Бүх эх сурвалж"], ...["Agent", "Studio", "Хэрэглэгч", "Browser"].map(id => [id, id])], source, value => { source = value; }),
        filterSelect("Үр дүн", [["", "Бүх үр дүн"], ...Object.entries(states).slice(0, 3)], outcome, value => { outcome = value; }));
      box.append(filters);
    }
    if (correlation !== undefined) {
      const back = element("div", undefined, "monitor-filters");
      back.append(button("Бүх мөрийг харах", () => { correlation = undefined; drawContent(); }));
      box.append(back);
    }
    const rows = activeTab === "activity" ? activityRows() : records
      .filter(event => event.channel === activeTab && (correlation === undefined || event.related === correlation))
      .map(event => ({ ...event, key: event.id })).reverse();
    if (!rows.length) box.append(empty("Харуулах үйл явдал алга."));
    for (const event of rows) box.append(eventRow(event, activeTab === "activity"));
    return box;
  }
  function runView(run) {
    const box = element("div", undefined, "monitor-events");
    if (!run.events) return empty("Зааврын мэдээлэл одоогоор боломжгүй.");
    for (const event of run.events) {
      box.append(eventRow({
        key: `widget-${event.kind}-${event.index}`, at: event.at, action: states[event.kind] ?? event.kind,
        source: event.kind === "started" ? "Agent" : event.kind === "confirmed" ? "Хэрэглэгч" : "Widget",
        outcome: event.kind === "stopped" ? "failed" : event.kind === "completed" ? "success" : undefined,
        target: event.target, detail: `Алхам ${event.index + 1}${event.reason ? " · " + event.reason : ""}`,
      }, false));
    }
    return box;
  }
  function domName(row) {
    if (row.kind === "text") return row.text;
    if (row.kind === "shadow-root") return "#shadow-root";
    return [row.tag, row.name ?? row.aria?.["aria-label"]].filter(Boolean).join(" — ");
  }
  function renderTree(scroller) {
    const previousScroll = scroller.scrollTop;
    const query = filter.trim().toLowerCase();
    const byParent = new Map();
    for (const row of dom.nodes) {
      if (!byParent.has(row.parentId)) byParent.set(row.parentId, []);
      byParent.get(row.parentId).push(row);
    }
    const fragment = document.createDocumentFragment();
    const pending = (query ? dom.nodes.filter(row => [domName(row), row.role, row.selector].some(value => value?.toLowerCase().includes(query))) : (byParent.get(null) ?? []))
      .slice().reverse().map(row => [row, 0]);
    const rowsPerView = 400;
    let count = 0;
    while (pending.length && count < Number(scroller.dataset.limit ?? rowsPerView)) {
      const [row, depth] = pending.pop();
      count++;
      const line = element("div", undefined, "monitor-tree-row");
      line.style.paddingInlineStart = `${Math.min(depth, 12) * 12}px`;
      const children = query ? [] : byParent.get(row.id) ?? [];
      if (children.length) {
        const toggle = button(expanded.has(row.id) ? "▾" : "▸", () => {
          if (expanded.has(row.id)) expanded.delete(row.id); else expanded.add(row.id);
          renderTree(scroller);
          scroller.querySelector(`[data-node-toggle="${row.id}"]`)?.focus();
        });
        toggle.dataset.nodeToggle = row.id;
        toggle.setAttribute("aria-expanded", String(expanded.has(row.id)));
        toggle.setAttribute("aria-label", domName(row));
        line.append(toggle);
        if (expanded.has(row.id)) for (let index = children.length - 1; index >= 0; index--) pending.push([children[index], depth + 1]);
      } else line.append(element("span", "", "monitor-tree-spacer"));
      const selectRow = button(domName(row), () => {
        picked = row.id;
        content.querySelector(".monitor-properties")?.replaceChildren(properties(row));
        for (const control of scroller.querySelectorAll("[data-dom-node]")) control.setAttribute("aria-pressed", String(control === selectRow));
        showOutline();
      });
      selectRow.dataset.domNode = row.id;
      selectRow.setAttribute("aria-pressed", String(picked === row.id));
      if (row.recognition === "mapped") selectRow.classList.add("monitor-mapped");
      line.append(selectRow);
      fragment.append(line);
    }
    if (pending.length) {
      fragment.append(button(`Дараагийн ${rowsPerView} мөр`, () => {
        scroller.dataset.limit = String(Number(scroller.dataset.limit ?? rowsPerView) + rowsPerView);
        renderTree(scroller);
      }));
    }
    scroller.replaceChildren(fragment);
    if (!count) scroller.append(empty("Тохирох зангилаа алга."));
    scroller.scrollTop = previousScroll;
  }
  function properties(row) {
    if (!row) return empty("Модноос элемент сонгоно уу.");
    return fields([["Tag", row.tag ?? row.kind], ["Role", row.role], ["Нэр", row.name ?? row.text ?? row.aria?.["aria-label"]],
      ["Selector", row.selector ?? "Тогтвортой selector олдоогүй"],
      ["Visible", row.visible === undefined ? undefined : row.visible ? "Тийм" : "Үгүй"],
      ["UI зураглал", recognition[row.recognition]], ["Шалтгаан", row.reason ??
        ({ private: "Хамгаалсан хэсэг", frame: "Хандах боломжгүй iframe" })[row.unavailable]]]);
  }
  function domView() {
    const box = element("div");
    const top = element("div", undefined, "monitor-toolbar");
    const reload = button("DOM шинэчлэх", () => { void loadDom(true); });
    reload.disabled = domPending;
    top.append(element("h3", "DOM Tree"), reload);
    box.append(top);
    if (!dom) {
      box.append(empty(domPending ? "DOM уншиж байна…" : "DOM одоогоор боломжгүй."));
      return box;
    }
    box.append(element("small", `${dom.nodes.length} зангилаа · ${dom.audience} · ${dom.mapRevision ? "Зураглал v" + dom.mapRevision : "Хадгалсан зураглал алга"}${dom.truncated ? " · Хязгаарт хүрсэн" : ""}`));
    const search = element("input");
    search.type = "search";
    search.value = filter;
    search.placeholder = "Ачаалсан зангилаанаас хайх";
    search.setAttribute("aria-label", "DOM зангилаа хайх");
    const scroller = element("div", undefined, "monitor-tree");
    search.addEventListener("input", () => { filter = search.value; renderTree(scroller); });
    box.append(search, scroller);
    renderTree(scroller);
    if (dom.nextCursor) {
      const more = button("Дараагийн 500 зангилаа", () => { void loadDom(false, dom.nextCursor); });
      more.disabled = domPending;
      box.append(more);
    }
    box.append(element("h3", "Сонгосон элемент"));
    const details = element("div", undefined, "monitor-properties");
    details.append(properties(dom.nodes.find(row => row.id === picked)));
    box.append(details);
    return box;
  }
  function isInputLocked() {
    return selection && selection.origin === mapState?.origin &&
      selection.audience === mapState.audience && mapState.inputLocked;
  }

  function syncLive() {
    const enabled = selection?.mode === "control" && !selection.widget && !document.hidden && !isInputLocked();
    live.show(enabled ? `/api/platform/tenants/${tenant.tenantId}/monitor${sessionResource("live")}` : undefined);
  }

  function refreshEvents() {
    const scroll = content.scrollTop;
    const top = content.getBoundingClientRect().top;
    const anchor = scroll > 8 && [...content.querySelectorAll("[data-event-row]")]
      .find(row => row.getBoundingClientRect().bottom > top);
    const offset = anchor ? anchor.getBoundingClientRect().top - top : 0;
    const focus = content.contains(document.activeElement) ? document.activeElement.dataset.eventControl : undefined;
    drawContent();
    const next = anchor && content.querySelector(`[data-event-row="${CSS.escape(anchor.dataset.eventRow)}"]`);
    content.scrollTop = next ? content.scrollTop + next.getBoundingClientRect().top - top - offset : scroll;
    if (focus) content.querySelector(`[data-event-control="${CSS.escape(focus)}"]`)?.focus({ preventScroll: true });
  }
  function drawContent() {
    if (activeTab === "map") {
      if (mapping.panel.parentNode !== content) content.replaceChildren(mapping.panel);
      return;
    }
    if (!selection) {
      content.replaceChildren(empty("Сесс сонгосны дараа үйлдэл, DOM болон оношлогоо энд харагдана."));
      return;
    }
    if (!selection.widget && (selection.mode === "control" || selection.mode === "waiting")) {
      content.replaceChildren(empty("Studio нэвтрэх бэлтгэл дуусмагц оношлогоо гарна."));
    } else if (activeTab === "dom") content.replaceChildren(domView());
    else if (activeTab === "storage") {
      const refresh = button("Шинэчлэх", () => { void loadStorage(); });
      refresh.disabled = storagePending;
      content.replaceChildren(refresh);
      if (!storage) content.append(empty(storagePending ? "Уншиж байна…" : "Storage одоогоор боломжгүй."));
      else for (const [name, keys] of Object.entries(storage)) {
        content.append(element("h3", `${name} · ${keys.length}`), keys.length ? fields(keys.map((key, index) => [String(index + 1), key])) : empty("Түлхүүр алга."));
      }
    } else content.replaceChildren(eventView());
  }
  async function loadStorage() {
    if (!selection || selection.widget || selection.mode === "control" || selection.mode === "waiting" || storagePending) return;
    const { signal } = controller;
    storagePending = true;
    drawContent();
    try { storage = await request(sessionResource("storage"), signal); }
    catch { if (!signal.aborted) storage = undefined; }
    finally { if (!signal.aborted) { storagePending = false; if (activeTab === "storage") drawContent(); } }
  }
  async function loadDom(reset = false, cursor) {
    if (!selection || selection.widget || selection.mode === "control" || selection.mode === "waiting" || domPending) return;
    const { signal } = controller;
    if (reset) { dom = picked = undefined; expanded.clear(); outline.hidden = true; }
    domPending = true;
    domError = false;
    drawContent();
    try {
      const result = await request(sessionResource("dom") + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""), signal);
      if (signal.aborted) return;
      const same = cursor && dom?.view?.revision === result.view?.revision;
      dom = { ...result, nodes: same ? [...dom.nodes, ...result.nodes] : result.nodes };
      if (!same) {
        expanded = new Set(dom.nodes.filter(row => row.parentId === null || row.tag === "body").map(row => row.id));
        picked = undefined;
      }
    } catch { if (!signal.aborted) { dom = picked = undefined; domError = true; outline.hidden = true; } }
    finally { if (!signal.aborted) { domPending = false; if (activeTab === "dom") drawContent(); } }
  }
  function displayLists({ sessions, runs }) {
    const key = JSON.stringify([origin, sessions, runs, selection?.id]);
    if (key === listed) return;
    listed = key;
    function list(container, choices, widget) {
      const visible = choices.filter(item => !origin || origin === item.origin);
      container.replaceChildren(...visible.map(item => {
        const entry = button("", () => { select(item, widget); listed = ""; displayLists({ sessions, runs }); });
        entry.setAttribute("aria-pressed", String(selection?.id === item.id));
        const url = item.url ?? item.origin;
        const title = widget ? `Заавар · ${day(item.startedAt)}` : url.replace(/^https?:\/\//u, "");
        const name = element("strong", title);
        name.title = widget ? title : url;
        const state = element("small", widget ? states[item.outcome] ?? item.outcome : "Идэвхтэй", "monitor-session-state");
        state.dataset.status = widget ? item.outcome : "running";
        entry.append(name, state);
        return entry;
      }));
      if (!visible.length) container.append(empty(widget ? "Сүүлийн 7 хоногт заавар алга." : "Идэвхтэй сесс алга."));
    }
    list(browserList, sessions, false);
    list(widgetList, runs, true);
  }
  function selectOrigin(value) {
    if (origin === value) return;
    const wasMapping = activeTab === "map";
    origin = value;
    directoryController.abort();
    directoryController = new AbortController();
    latestDirectory = { sessions: [], runs: [] };
    firstDirectory = true;
    followedMap = false;
    directoryDue = true;
    listed = "";
    showSite();
    select(undefined, false, { follow: true });
    if (!wasMapping) switchTab("activity");
    mapping.syncOrigin();
    showDirectoryLoading();
  }

  function showDirectoryLoading() {
    browserList.replaceChildren(empty(tenant.enabled ? "Studio сесс хайж байна…" : "Байгууллага идэвхгүй."));
    widgetList.replaceChildren();
  }

  let latestDirectory = { sessions: [], runs: [] };
  let lastDirectory = 0;
  let firstDirectory = true;
  async function tick() {
    if (!tenant.enabled || document.hidden) return;
    if (directoryDue || Date.now() - lastDirectory > (mapState?.watching ? 850 : 4000) || !listed) {
      directoryDue = false;
      const { signal } = directoryController;
      try {
        const directory = await request("", signal);
        if (signal.aborted || disposed) return;
        latestDirectory = directory;
        lastDirectory = Date.now();
        if (selection && !(selection.widget ? latestDirectory.runs : latestDirectory.sessions).some(row => row.id === selection.id)) {
          select(undefined, false, { follow: true });
        }
        const visible = latestDirectory.sessions.filter(item => !origin || item.origin === origin);
        const matched = mapState?.watching && !followedMap && visible.find(item =>
          item.source === "UI зураглал" && item.origin === mapState.origin && item.audience === mapState.audience);
        if (matched) {
          followedMap = true;
          if (selection?.id !== matched.id) {
            select(matched, false, { follow: true });
            showPane("viewport");
          }
        } else if (firstDirectory && !selection && visible.length === 1 && !mapState?.watching) {
          select(visible[0], false, { follow: true });
        }
        const chosenBrowser = selection && !selection.widget && visible.find(item => item.id === selection.id);
        if (chosenBrowser && chosenBrowser.mode !== selection.mode) {
          selection = { ...chosenBrowser, widget: false };
          previewGeneration++;
          resetFrame("Браузерын дүрс ачаалж байна…");
          syncLive();
          drawContent();
          if (activeTab === "storage") void loadStorage();
        }
        firstDirectory = false;
        displayLists(latestDirectory);
      } catch {
        if (signal.aborted || disposed) return;
        browserList.replaceChildren(empty("Сессийн жагсаалт ачаалсангүй."));
        listed = "";
      }
    }
    if (!selection || disposed) return;
    const { signal } = controller;
    try {
      if (selection.widget) {
        const next = await request(`/runs/${selection.id}`, signal);
        if (!signal.aborted && JSON.stringify(next) !== JSON.stringify(selectedRun)) { selectedRun = next; refreshEvents(); }
        return;
      }
      if (selection.mode === "control" || selection.mode === "waiting") return;
      const packet = await request(sessionResource("events") + `?after=${after}`, signal);
      if (signal.aborted) return;
      if (revision !== packet.revision) {
        if (revision !== undefined) { dom = picked = storage = undefined; domError = false; resetFrame("Хуудас шинэчлэгдэж байна…"); }
        revision = packet.revision;
      }
      if (activeTab === "dom" && !dom && !domPending && !domError) void loadDom();
      actionHighlight = packet.highlight;
      setAddress(packet.url ?? selection.origin);
      if (packet.events.length) {
        after = packet.lastEvent;
        records = [...records, ...packet.events].slice(-200);
        if (["activity", "console", "network"].includes(activeTab)) refreshEvents();
      }
      await loadFrame();
    } catch {
      if (!signal.aborted) {
        if (selection?.widget) { selectedRun = {}; drawContent(); }
        else resetFrame("Сесс түр боломжгүй байна.");
      }
    }
  }
  async function loadFrame() {
    if (!selection || selection.widget || document.hidden || frameRequest === previewGeneration) return;
    const { signal } = controller;
    const version = previewGeneration;
    frameRequest = version;
    try {
      const frame = await request(sessionResource("viewport"), signal, true);
      if (signal.aborted || document.hidden || version !== previewGeneration) return;
      renderFrame(frame.blob, frame.view, "Шууд");
    } catch {
      if (signal.aborted || version !== previewGeneration) return;
      if (objectUrl) {
        viewState.textContent = "Дүрс түр саатсан";
        viewState.classList.remove("monitor-live");
        outline.hidden = true;
      } else resetFrame("Энэ хуудасны дүрсийг харуулах боломжгүй.");
    } finally {
      if (frameRequest === version) frameRequest = undefined;
    }
  }
  function renderFrame(blob, view, status) {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(blob);
    image.src = objectUrl;
    frameView = view;
    const [, width, height] = (frameView ?? "").split(",").map(Number);
    if (width > 0 && height > 0) {
      surface.style.setProperty("--frame-ratio", String(width / height));
      viewSize.textContent = `${width} × ${height}`;
    }
    surface.hidden = image.hidden = false;
    messageArea.hidden = true;
    viewState.textContent = status;
    viewState.classList.add("monitor-live");
    viewStatus.textContent = time(Date.now());
    showOutline();
  }
  function onVisibility() {
    if (document.hidden) {
      previewGeneration++;
      resetFrame("Дэлгэц далд үед дүрс түр зогсоно.");
    }
    syncLive();
  }
  document.addEventListener("visibilitychange", onVisibility);
  let timer;
  async function loop() {
    if (disposed) return;
    await tick();
    if (!disposed) timer = setTimeout(loop, mapState?.watching && !selection ? 500 : 1000);
  }
  if (openMap) openStudio();
  else { drawTabs(); drawContent(); }
  mapping.syncOrigin();
  showDirectoryLoading();
  void loop();
  return { root, dispose() {
    disposed = true;
    document.removeEventListener("visibilitychange", onVisibility);
    stageObserver.disconnect();
    mapping.dispose();
    live.show(undefined);
    clearTimeout(timer);
    controller.abort();
    directoryController.abort();
    resetFrame("");
  } };
}
