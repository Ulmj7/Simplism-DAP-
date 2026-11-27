(() => {
  const script = document.currentScript;
  const installationId = script?.dataset.install;
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(installationId ?? "")) return;

  let apiOrigin;
  try {
    const api = new URL(script.dataset.apiOrigin);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(api.hostname);
    if (api.origin !== script.dataset.apiOrigin || (api.protocol !== "https:" && !(local && api.protocol === "http:"))) return;
    apiOrigin = api.origin;
  } catch {
    return;
  }

  const installed = Symbol.for("dap.widget.installations");
  const active = window[installed] ??= new Set();
  const key = `${apiOrigin}:${installationId}`;
  if (active.has(key)) return;
  active.add(key);

  const api = `${apiOrigin}/api/widget/v1/${installationId}`;
  const serviceUnavailable = "AI үйлчилгээ түр боломжгүй байна. Дахин оролдоно уу.";
  const invalidQuestion = "1–500 тэмдэгттэй асуулт бичнэ үү.";

  function request(path, options = {}) {
    return fetch(api + path, {
      ...options, credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(10000),
    });
  }

  async function bootstrap() {
    const response = await request("/bootstrap");
    if (!response.ok) return null;
    const result = await response.json();
    return typeof result?.name === "string" && typeof result.session === "string" && result.session ? result : null;
  }

  function element(tag, text, style) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (style) Object.assign(node.style, style);
    return node;
  }

  function statusMessage(status) {
    if (status === 401) return "Сесс дууссан байна. Дахин оролдоно уу.";
    if (status === 404) return "Энэ вебэд туслах түр боломжгүй байна.";
    if (status === 422) return invalidQuestion;
    if (status === 429) return "Хэт олон асуулт илгээсэн байна. Түр хүлээгээд дахин оролдоно уу.";
    return serviceUnavailable;
  }

  function replyContent(result) {
    if (result?.kind === "answer" && typeof result.answer === "string") {
      const sources = Array.isArray(result.sources)
        ? result.sources.map(source => source?.title).filter(title => typeof title === "string")
        : [];
      return { text: result.answer, sources };
    }
    if (result?.kind === "clarify" && typeof result.message === "string") {
      return { text: result.message };
    }
    if (result?.kind === "walkthrough" && typeof result.title === "string") {
      return { text: `Санал болгосон заавар: ${result.title}` };
    }
    return null;
  }

  function responseMessage(result) {
    if (result?.kind === "pending") return "Байгууллагын мэдлэгийн сан хараахан бэлэн болоогүй байна.";
    if (result?.kind !== "unsupported") return serviceUnavailable;
    if (["model_unavailable", "unavailable"].includes(result.reason)) return serviceUnavailable;
    if (result.reason === "query_invalid") return invalidQuestion;
    return "Энэ асуултад тохирох хариулт олдсонгүй.";
  }

  const guidanceLifetime = 5 * 60_000;
  const glossary = [
    ["нэхэмжлэх", "санхүү", "төлбөр", "invoice", "billing", "finance", "payment"],
    ["тохиргоо", "бүртгэл", "профайл", "settings", "account", "profile"],
    ["захиалга", "orders", "order"],
    ["тайлан", "reports", "report"],
  ];
  const storageKey = `dap-ui-v1:${key}`;
  const initialState = () => ({ pages: [], resume: null });

  function readNavigation() {
    try {
      const value = JSON.parse(sessionStorage.getItem(storageKey));
      if (Array.isArray(value?.pages)) {
        const pages = value.pages.slice(0, 30).filter(page => page &&
          typeof page.href === "string" && Array.isArray(page.terms) &&
          page.terms.length <= 80 && page.terms.every(term => typeof term === "string") &&
          Number.isFinite(page.seenAt));
        const resume = value.resume;
        return { pages, resume: resume && typeof resume.expected === "string" && Number.isFinite(resume.expires) &&
          Array.isArray(resume.visited) && resume.visited.length <= 30 &&
          Array.isArray(resume.queryTerms?.terms) && resume.queryTerms.terms.length <= 24 &&
          resume.queryTerms.terms.every(term => typeof term === "string") &&
          Array.isArray(resume.queryTerms.related) && resume.queryTerms.related.every(term => typeof term === "string") ? resume : null };
      }
    } catch { /* Storage can be unavailable in some browser contexts. */ }
    return initialState();
  }
  function writeNavigation(state) {
    try { sessionStorage.setItem(storageKey, JSON.stringify(state)); } catch { /* In-page guidance remains usable. */ }
  }
  function destination(raw, currentPage = false) {
    try {
      const url = new URL(raw, location.href);
      if (url.origin !== location.origin || url.username || url.password || url.href.length > 400) return null;
      if (url.search && !currentPage) return null;
      if (url.hash && (!/^#!?\//u.test(url.hash) || url.hash.includes("?"))) {
        if (!currentPage || /^#!?\//u.test(url.hash)) return null;
        return url.pathname;
      }
      return url.pathname + url.hash;
    } catch { return null; }
  }
  function currentRoute() {
    return destination(location.href, true);
  }
  function words(value) {
    return [...new Set(value.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]{2,32}/gu) ?? [])].slice(0, 24);
  }
  function termsFor(query) {
    const terms = words(query);
    const related = glossary.filter(group => group.some(word => terms.some(term => term.startsWith(word)))).flat();
    return { terms, related };
  }
  function score(label, queryTerms) {
    const names = words(label);
    const exact = names.filter(word => queryTerms.terms.includes(word)).length;
    const partial = names.filter(word => word.length >= 3 && queryTerms.terms.some(term =>
      term.length >= 3 && (term.startsWith(word) || word.startsWith(term)))).length;
    if (exact) return Math.min(100, 71 + exact * 7 + partial);
    if (partial) return Math.min(70, 54 + partial * 6);
    return names.some(word => queryTerms.related.includes(word)) ? 38 : 0;
  }
  function invalidField(node) {
    return Boolean(node?.matches("[aria-invalid=true],[aria-invalid=grammar],[aria-invalid=spelling],input:invalid,select:invalid,textarea:invalid"));
  }

  function createPageGuide(host, root, panel, choose, requestRoute, setStatus, openPanel) {
    const state = readNavigation();
    const reader = createUiReader(host);
    let route = currentRoute();
    let highlighted;
    let activeError;
    let revision = 0;
    let manualSearch;
    let lastInteraction;
    let rescan;
    let rememberTimer;
    const ring = element("div", undefined, { position: "fixed", pointerEvents: "none", border: "3px solid #149487",
      borderRadius: "7px", zIndex: "2147483000", boxSizing: "border-box" });
    const tip = element("div", undefined, { position: "fixed", pointerEvents: "none", padding: "7px 10px",
      background: "#145c55", color: "white", font: "14px system-ui", borderRadius: "6px",
      maxWidth: "min(260px, calc(100vw - 20px))", zIndex: "2147483001" });
    tip.setAttribute("role", "status");
    tip.hidden = ring.hidden = true;
    root.append(ring, tip);
    const nextLink = element("a", "Хуудас руу очих", { display: "inline-block", margin: "8px 0", color: "#145c55" });
    nextLink.hidden = true;
    nextLink.style.display = "none";
    panel.append(nextLink);

    function hideHighlight() {
      highlighted = null;
      ring.hidden = tip.hidden = true;
    }
    function placeHighlight() {
      if (!highlighted) return;
      const { node, error } = highlighted;
      if (!reader.available(node) || (error && !invalidField(node))) {
        hideHighlight();
        return;
      }
      const rect = node.getBoundingClientRect();
      const onScreen = rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
      ring.hidden = tip.hidden = !onScreen;
      if (!onScreen) return;
      Object.assign(ring.style, { left: `${rect.left - 3}px`, top: `${rect.top - 3}px`,
        width: `${rect.width + 6}px`, height: `${rect.height + 6}px` });
      const left = Math.max(8, Math.min(rect.left, innerWidth - tip.offsetWidth - 8));
      const top = rect.bottom + tip.offsetHeight + 8 < innerHeight ? rect.bottom + 6 : Math.max(8, rect.top - tip.offsetHeight - 6);
      Object.assign(tip.style, { left: `${left}px`, top: `${top}px` });
    }
    function highlight(node, message, error = false) {
      highlighted = { node, error };
      tip.textContent = message;
      if (!error) node.scrollIntoView({ block: "nearest", inline: "nearest" });
      placeHighlight();
    }
    function clearNextLink() {
      nextLink.hidden = true;
      nextLink.style.display = "none";
      nextLink.removeAttribute("href");
    }
    function scan() {
      const items = [];
      for (const { node, target, disabled } of reader.scan()) {
        if (disabled) continue;
        const { role, name: label } = target;
        const href = node.matches("a[href]:not([download]):not([target=_blank])") ? destination(node.href) : null;
        if (node.matches("a[href]") && !href) continue;
        const kind = href && href !== route ? "page"
          : node.matches("details:not([open]) > summary,[aria-expanded=false],[aria-haspopup=menu]:not([aria-expanded=true])") ? "menu" : "element";
        items.push({ node, target, label, role, kind, href, invalid: invalidField(node) });
      }
      return items;
    }
    function remember(items = scan()) {
      // Only a real visit supplies controls for a route. Addresses and labels stay in this tab.
      if (!route || location.search || items.length === 0) return;
      const previous = state.pages.find(page => page.href === route);
      const terms = [...new Set(items
        .filter(item => item.kind === "element" && item.role !== "link")
        .flatMap(item => words(item.label)))].slice(0, 80);
      if (!terms.length && previous?.terms.length) return;
      state.pages = [{ href: route, terms, seenAt: Date.now() }, ...state.pages.filter(page => page.href !== route)].slice(0, 30);
      writeNavigation(state);
    }
    function candidatesFor(queryTerms, visited, usedMenus) {
      const items = scan();
      remember(items);
      const byPage = new Map();
      const results = [];
      for (const item of items) {
        if ((item.href && (item.href === route || visited.includes(item.href))) || usedMenus.has(item.node)) continue;
        const entry = { ...item, match: score(item.label, queryTerms) };
        if (item.kind === "page") {
          const previous = byPage.get(item.href);
          if (!previous || previous.match < entry.match) byPage.set(item.href, entry);
        } else if (entry.match || entry.invalid) {
          results.push(entry);
        }
      }
      for (const page of state.pages) {
        if (page.href === route || visited.includes(page.href) || destination(page.href) !== page.href ||
          Date.now() - page.seenAt > 30 * 60_000) continue;
        const match = score(page.terms.join(" "), queryTerms);
        if (!match) continue;
        const current = byPage.get(page.href);
        if (current) current.match = Math.max(current.match, match);
        else byPage.set(page.href, { href: page.href, label: "", role: "link", kind: "page", match, invalid: false });
      }
      return results.concat([...byPage.values()].filter(item => item.match))
        .sort((left, right) => right.match - left.match || Number(right.invalid) - Number(left.invalid))
        .slice(0, 24);
    }
    function resumeAt(href) {
      state.resume = { expected: href, queryTerms: manualSearch.queryTerms, expires: manualSearch.expires,
        visited: [...manualSearch.visited] };
      writeNavigation(state);
    }
    nextLink.addEventListener("click", () => {
      const href = nextLink.getAttribute("href");
      if (manualSearch && href && destination(href) === href) resumeAt(href);
    });
    function present(candidate) {
      if (candidate.kind === "page") {
        if (destination(candidate.href) !== candidate.href) return false;
        manualSearch.next = candidate;
        nextLink.href = candidate.href;
        nextLink.textContent = candidate.label ? `«${candidate.label}» руу очих` : "Өмнө нээсэн хуудас руу очих";
        nextLink.hidden = false;
        nextLink.style.display = "inline-block";
        if (candidate.node) highlight(candidate.node, "Энэ холбоосоор орно уу.");
        setStatus("Хуудас руу орсны дараа хайлт үргэлжилнэ.");
        return true;
      }
      if (candidate.kind === "menu") {
        manualSearch.next = candidate;
        highlight(candidate.node, "Энэ цэсийг нээнэ үү.");
        setStatus("Цэсийг нээхэд дараагийн алхмыг харуулна.");
        return true;
      }
      highlight(candidate.node, candidate.label ? `«${candidate.label}» энд байна.` : "Тохирох элемент энд байна.");
      setStatus("Тохирох элемент тодорлоо.");
      manualSearch = null;
      return true;
    }

    async function find(search) {
      const run = ++revision;
      const requestRoute = currentRoute();
      clearNextLink();
      hideHighlight();
      if (search.expires <= Date.now() || search.visited.length >= 30) {
        setStatus("Хайлтын хугацаа дууссан байна. Дахин асууна уу.");
        return;
      }
      const candidates = candidatesFor(search.queryTerms, search.visited, search.usedMenus);
      if (!candidates.length) {
        setStatus("Тохирох элемент эсвэл хуудас олдсонгүй. Цэс, товчны нэрийг тодруулж асууна уу.");
        return;
      }
      setStatus("Дэлгэц болон цэснээс хайж байна…");
      const result = await choose(search.query, candidates.map(({ kind, role, match, invalid }, index) => ({
        id: index + 1, kind, role, match, invalid,
      })));
      if (run !== revision || currentRoute() !== requestRoute) return;
      if (result?.error) {
        setStatus(result.error);
        return;
      }
      const candidate = result?.kind === "target" && Number.isInteger(result.id) ? candidates[result.id - 1] : null;
      if (candidate?.node) {
        const resolved = reader.resolve(candidate.target);
        if (resolved.status !== "found" || (candidate.href && destination(resolved.node.href) !== candidate.href)) {
          setStatus("Аль цэс эсвэл талбар болохыг тодруулж асууна уу.");
          return;
        }
        candidate.node = resolved.node;
      }
      if (!candidate || !present(candidate)) {
        setStatus("Аль цэс эсвэл талбар болохыг тодруулж асууна уу.");
      }
    }
    function restore() {
      const resume = state.resume;
      state.resume = null;
      writeNavigation(state);
      if (!resume || resume.expires <= Date.now()) return;
      openPanel();
      if (resume.expected !== route) {
        setStatus("Зорьсон хуудас нээгдсэнгүй. Хаяг болон нэвтрэх эрхээ шалгана уу.");
        return;
      }
      const search = { ...resume, visited: [...resume.visited, route], query: resume.queryTerms.terms.join(" "), usedMenus: new Set() };
      manualSearch = search;
      setStatus("Шинэ дэлгэцээс үргэлжлүүлэн хайж байна…");
      setTimeout(() => {
        if (manualSearch === search && currentRoute() === route) void find(search);
      }, 350);
    }
    function navigate() {
      const next = currentRoute();
      if (route === next) return;
      if (!state.resume && manualSearch?.next?.href === next && manualSearch.expires > Date.now()) resumeAt(next);
      route = next;
      revision++;
      manualSearch = null;
      activeError = null;
      clearNextLink();
      hideHighlight();
      remember();
      restore();
    }

    const mapped = createMappedGuide(reader, {
      storageKey: `dap-ui-route:${key}`, requestRoute, currentRoute, destination, openPanel, highlight,
      clearHighlight: hideHighlight, setStatus,
    });
    document.addEventListener("click", event => {
      const target = event.target;
      if (!(target instanceof Element) || host.contains(target)) return;
      lastInteraction = { target, at: Date.now() };
      if (mapped.click(event)) return;
      const selected = manualSearch?.next;
      if (!selected?.node?.contains(target) || manualSearch.expires <= Date.now()) return;
      if (selected.kind === "page" && destination(selected.node.href) === selected.href) {
        resumeAt(selected.href);
      } else if (selected.kind === "menu") {
        manualSearch.usedMenus.add(selected.node);
        clearTimeout(rescan);
        rescan = setTimeout(() => {
          if (manualSearch?.next !== selected) return;
          manualSearch.next = null;
          void find(manualSearch);
        }, 350);
      }
    }, true);
    document.addEventListener("focusout", event => {
      if (event.target instanceof Element && !host.contains(event.target)) {
        lastInteraction = { target: event.target, at: Date.now() };
      }
    }, true);
    document.addEventListener("invalid", event => {
      if (event.target instanceof HTMLElement && reader.available(event.target) && !activeError) {
        activeError = event.target;
        highlight(activeError, activeError.validity?.valueMissing ? "Энэ талбарыг бөглөнө үү." : "Энэ талбарын мэдээллээ шалгана уу.", true);
      }
    }, true);
    document.addEventListener("input", () => {
      if (activeError && !invalidField(activeError)) {
        activeError = null;
        if (highlighted?.error) hideHighlight();
      }
    }, true);
    new MutationObserver(records => {
      const changes = records.filter(record => !host.contains(record.target));
      if (!changes.length) return;
      navigate();
      placeHighlight();
      if (activeError && (!activeError.isConnected || !invalidField(activeError))) activeError = null;
      const form = lastInteraction?.target.closest("form");
      if (!activeError && !highlighted && lastInteraction && Date.now() - lastInteraction.at < 4000) {
        const changed = changes.find(record => record.attributeName === "aria-invalid" && record.target instanceof HTMLElement &&
          reader.available(record.target) && invalidField(record.target) &&
          (record.target === lastInteraction.target || (form && form.contains(record.target))));
        if (changed) {
          activeError = changed.target;
          highlight(activeError, "Энэ талбарын мэдээллээ шалгана уу.", true);
        }
      }
      clearTimeout(rememberTimer);
      rememberTimer = setTimeout(() => {
        remember();
        void mapped.refresh(true);
      }, 500);
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true,
      attributeFilter: ["aria-invalid", "aria-expanded", "aria-selected", "aria-label", "aria-labelledby",
        "href", "hidden", "disabled", "class", "aria-hidden", "data-ai-id", "data-ai-private", "data-ai-ignore", "data-ai-redact"] });
    addEventListener("scroll", placeHighlight, true);
    addEventListener("resize", placeHighlight);
    addEventListener("hashchange", navigate);
    addEventListener("popstate", navigate);
    setInterval(() => {
      navigate();
      void mapped.refresh();
    }, 400);
    script.addEventListener("dap:highlight-target", event => {
      const resolved = reader.resolve(event.detail);
      revision++;
      manualSearch = null;
      clearNextLink();
      mapped.cancel();
      if (resolved.status === "found") {
        highlight(resolved.node, "Тохирох элемент энд байна.");
      }
      script.dispatchEvent(new CustomEvent("dap:target-result", { detail: resolved.status }));
    });
    remember();
    restore();
    return async query => {
      state.resume = null;
      writeNavigation(state);
      revision++;
      manualSearch = null;
      clearNextLink();
      if (await mapped.start(query)) return;
      manualSearch = { query, queryTerms: termsFor(query), expires: Date.now() + guidanceLifetime,
        visited: route ? [route] : [], usedMenus: new Set() };
      await find(manualSearch);
    };
  }

  async function mount() {
    let session = await bootstrap();
    if (!session) {
      active.delete(key);
      return;
    }

    const host = element("div", undefined, { position: "fixed", right: "20px", bottom: "20px", zIndex: "2147483000" });
    const root = host.attachShadow({ mode: "open" });
    const buttonStyle = {
      background: "#145c55", color: "#fff", border: "1px solid #fff", borderRadius: "10px", cursor: "pointer",
      padding: "10px 15px", font: "600 14px system-ui",
    };
    const launcher = element("button", session.name, {
      ...buttonStyle, maxWidth: "min(300px, calc(100vw - 40px))", overflowWrap: "anywhere",
    });
    launcher.type = "button";
    launcher.setAttribute("aria-expanded", "false");
    launcher.setAttribute("aria-controls", "dap-agent-panel");
    const panel = element("section", undefined, {
      position: "absolute", right: "0", bottom: "calc(100% + 8px)", width: "min(360px, calc(100vw - 40px))",
      maxHeight: "calc(100dvh - 100px)", overflowY: "auto", boxSizing: "border-box", padding: "15px",
      border: "1px solid #dce3eb", background: "#fff", borderRadius: "10px", color: "#1b2736",
      boxShadow: "0 6px 20px #1b273633", font: "14px system-ui", overflowWrap: "anywhere",
    });
    panel.id = "dap-agent-panel";
    panel.setAttribute("aria-labelledby", "dap-agent-title");
    panel.hidden = true;
    const heading = element("strong", session.name);
    heading.id = "dap-agent-title";
    const conversation = element("div", undefined, { maxHeight: "min(280px, 40dvh)", overflowY: "auto" });
    conversation.setAttribute("role", "log");
    conversation.setAttribute("aria-label", "Асуулт, хариулт");
    const form = element("form", undefined, { marginTop: "12px" });
    const label = element("label", "Асуултаа бичнэ үү");
    label.htmlFor = "dap-agent-question";
    const input = element("textarea", undefined, {
      boxSizing: "border-box", width: "100%", padding: "8px", font: "inherit",
      backgroundColor: "#fff", color: "#172536", border: "1px solid #dce3eb",
      borderRadius: "6px", resize: "vertical", margin: "4px 0 8px",
    });
    input.id = "dap-agent-question";
    input.rows = 2;
    input.maxLength = 500;
    const submit = element("button", "Илгээх", buttonStyle);
    submit.type = "submit";
    const status = element("p", undefined, { margin: "8px 0 0", color: "#435465" });
    status.setAttribute("role", "status");
    const uiHelp = element("button", "Дэлгэц дээр заах", {
      ...buttonStyle, marginLeft: "6px", background: "#fff", color: "#145c55", borderColor: "#145c55",
    });
    uiHelp.type = "submit";
    form.append(label, input, submit, uiHelp, status);
    panel.append(heading, conversation, form);

    function showReply(question, { text, sources }) {
      const exchange = element("div");
      exchange.append(
        element("p", question, { background: "#eef3f5", padding: "8px", borderRadius: "6px", whiteSpace: "pre-wrap" }),
        element("p", text, { whiteSpace: "pre-wrap" }),
      );
      if (sources?.length) {
        const list = element("ul", undefined, { marginTop: "4px", paddingLeft: "20px" });
        for (const source of sources) list.append(element("li", source));
        exchange.append(element("strong", "Эх сурвалж"), list);
      }
      conversation.append(exchange);
      conversation.scrollTop = conversation.scrollHeight;
    }

    async function send(path, payload) {
      const post = () => request(path, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.session}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      let response = await post();
      if (response.status === 401) {
        const refreshed = await bootstrap();
        if (refreshed) {
          session = refreshed;
          heading.textContent = session.name;
          launcher.textContent = session.name;
          response = await post();
        }
      }
      return response;
    }

    async function choose(query, candidates) {
      try {
        const response = await send("/ui-assist", { query, candidates });
        return response.ok ? await response.json() : { error: statusMessage(response.status) };
      } catch {
        return { error: "Сервертэй холбогдож чадсангүй. Дахин оролдоно уу." };
      }
    }

    async function requestRoute(query, page, controls) {
      try {
        const response = await send("/ui-route", { query, page, controls });
        if (response.status === 404) return { kind: "unmapped" };
        return response.ok ? await response.json() : { error: statusMessage(response.status) };
      } catch {
        return { error: "Сервертэй холбогдож чадсангүй. Дахин оролдоно уу." };
      }
    }

    function openPanel() {
      panel.hidden = false;
      launcher.setAttribute("aria-expanded", "true");
    }
    const guide = createPageGuide(host, root, panel, choose, requestRoute, message => { status.textContent = message; }, openPanel);

    let pending = false;
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (pending) return;
      const query = input.value.trim();
      if (!query || query.length > 500) {
        status.textContent = invalidQuestion;
        return;
      }

      pending = true;
      submit.disabled = uiHelp.disabled = true;
      input.readOnly = true;
      status.textContent = "Хариулт бэлдэж байна…";
      try {
        if (event.submitter === uiHelp) {
          await guide(query);
          return;
        }
        const response = await send("/ask", { query });
        if (!response.ok) {
          status.textContent = statusMessage(response.status);
          return;
        }
        const result = await response.json().catch(() => null);
        const reply = replyContent(result);
        if (!reply) {
          status.textContent = responseMessage(result);
          return;
        }
        showReply(query, reply);
        input.value = "";
        status.textContent = "";
      } catch {
        status.textContent = "Сервертэй холбогдож чадсангүй. Сүлжээгээ шалгаад дахин оролдоно уу.";
      } finally {
        pending = false;
        submit.disabled = uiHelp.disabled = false;
        input.readOnly = false;
      }
    });

    function close() {
      panel.hidden = true;
      launcher.setAttribute("aria-expanded", "false");
      launcher.focus();
    }
    launcher.addEventListener("click", () => {
      if (!panel.hidden) {
        close();
        return;
      }
      openPanel();
      input.focus();
    });
    root.addEventListener("keydown", event => {
      if (event.key === "Escape" && !panel.hidden) {
        event.stopPropagation();
        close();
      }
    });
    root.append(panel, launcher);
    document.body.append(host);
  }

  function start() {
    void mount().catch(() => { active.delete(key); });
  }
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
