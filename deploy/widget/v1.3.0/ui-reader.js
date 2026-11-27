// Both the widget asset and the Studio browser command append a call to this function.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function createUiReader(excludedRoot) {
  const excluded = "[data-ai-ignore],[data-ai-private],[data-ai-redact],[hidden],[inert],[aria-hidden=true]";
  const roles = new Set(["button", "link", "textbox", "select", "checkbox", "radio", "tab", "menuitem"]);
  const selector = "button,a[href],input,select,textarea,summary,[role]";
  const markerPattern = /^[A-Za-z][A-Za-z0-9.]{0,79}$/u;
  const pagePattern = /^\/[A-Za-z0-9._~/%-]*(?:#!?\/[A-Za-z0-9._~/%-]*)?$/u;

  function currentPage() {
    const page = location.pathname + (/^#!?\//u.test(location.hash) ? location.hash : "");
    return page.length <= 200 && pagePattern.test(page) ? page : null;
  }

  function clean(text) {
    const normalized = (text ?? "").normalize("NFKC").replace(/\p{Cf}/gu, "").trim().replace(/\s+/gu, " ");
    return normalized.length <= 120 && !/[\p{Cc}]/u.test(normalized) ? normalized : "";
  }

  function permitted(node) {
    return !excludedRoot?.contains(node) && !node.closest(excluded) && !node.isContentEditable &&
      !/^(password|hidden|file|email|tel)$/iu.test(node.getAttribute("type") ?? "") &&
      !/(?:^|\s)(?:cc-\S+|current-password|new-password|one-time-code)(?:\s|$)/iu.test(node.getAttribute("autocomplete") ?? "");
  }

  function visible(node) {
    if (!node.isConnected || !permitted(node) || !node.getClientRects().length) return false;
    if (getComputedStyle(node).visibility !== "visible") return false;
    for (let parent = node; parent; parent = parent.parentElement) {
      if (getComputedStyle(parent).opacity === "0") return false;
    }
    return true;
  }

  const disabled = node => node.matches(":disabled") || Boolean(node.closest("[aria-disabled=true]"));
  const available = node => Boolean(node && visible(node) && !disabled(node));

  function roleOf(node) {
    const role = node.getAttribute("role")?.trim().split(/\s+/u)[0];
    if (role === "combobox" || role === "listbox") return "select";
    if (role === "searchbox") return "textbox";
    if (roles.has(role)) return role;
    if (node.matches("a[href]")) return "link";
    if (node.matches("button,summary,input[type=submit],input[type=button],input[type=reset],input[type=image]")) return "button";
    if (node.matches("select")) return "select";
    if (node.matches("input[type=checkbox]")) return "checkbox";
    if (node.matches("input[type=radio]")) return "radio";
    return node.matches("input,textarea") ? "textbox" : null;
  }

  function visibleText(node) {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let text = "";
    let visited = 0;
    while (walker.nextNode()) {
      if (++visited > 256) return "";
      const parent = walker.currentNode.parentElement;
      if (!parent || !permitted(parent) || parent.closest("script,style,textarea,select,input") ||
          getComputedStyle(parent).visibility !== "visible" || !parent.getClientRects().length) continue;
      text += walker.currentNode.nodeValue;
      if (text.length > 512) return "";
    }
    return clean(text);
  }

  function labelOf(node) {
    const refs = node.getAttribute("aria-labelledby")?.trim().split(/\s+/u).slice(0, 5) ?? [];
    const referenced = clean(refs.map(id => {
      const label = document.getElementById(id);
      return label && permitted(label) ? visibleText(label) : "";
    }).join(" "));
    const labels = clean(Array.from(node.labels ?? [], label => visibleText(label)).join(" "));
    const actionLabel = node.matches("input[type=submit],input[type=reset],input[type=button]") ? node.getAttribute("value") : null;
    const imageLabel = node.matches("input[type=image]") ? node.getAttribute("alt") : null;
    return referenced || clean(node.getAttribute("aria-label")) || labels || clean(actionLabel || imageLabel) || visibleText(node) ||
      clean(node.getAttribute("title"));
  }

  function sectionOf(node) {
    const sections = [];
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      if (!parent.matches("dialog,form,fieldset,nav,section,aside,[role=dialog],[role=region],[role=group],[role=tabpanel],[role=navigation],[role=menu]")) continue;
      const heading = Array.from(parent.children).find(child => child.matches("legend,h1,h2,h3,h4,h5,h6,[role=heading]"));
      const name = labelOfSection(parent, heading);
      if (name) sections.unshift(name);
      if (sections.length === 5) break;
    }
    return sections;
  }

  function labelOfSection(node, heading) {
    const refs = node.getAttribute("aria-labelledby")?.trim().split(/\s+/u).slice(0, 5) ?? [];
    return clean(refs.map(id => {
      const label = document.getElementById(id);
      return label && permitted(label) ? visibleText(label) : "";
    }).join(" ")) || clean(node.getAttribute("aria-label")) || (heading ? visibleText(heading) : "");
  }

  function scan() {
    const page = currentPage();
    const candidates = [];
    for (const node of document.querySelectorAll(selector)) {
      if (!visible(node)) continue;
      const role = roleOf(node);
      if (!role) continue;
      const marker = node.getAttribute("data-ai-id") ?? "";
      const target = {
        page, section: sectionOf(node), role, name: labelOf(node),
        marker: markerPattern.test(marker) ? marker : null,
      };
      candidates.push({ node, target, disabled: disabled(node) });
    }
    return candidates;
  }

  function resolve(target) {
    if (!target || !target.page || target.page !== currentPage() || !roles.has(target.role) ||
        typeof target.name !== "string" || !Array.isArray(target.section) ||
        target.section.length > 5 || !target.section.every(item => typeof item === "string") ||
        (target.marker !== null && (typeof target.marker !== "string" || !markerPattern.test(target.marker))) ||
        (!target.marker && !target.name)) return { status: "not-found" };
    const matches = scan().filter(({ target: item }) => target.marker
      ? item.marker === target.marker
      : item.role === target.role && item.name === target.name &&
        item.section.length === target.section.length && item.section.every((part, index) => part === target.section[index]));
    if (matches.length > 1) return { status: "ambiguous" };
    const match = matches[0];
    if (!match || match.target.role !== target.role || !available(match.node)) return { status: "not-found" };
    return { status: "found", node: match.node };
  }

  function snapshot() {
    const targets = scan().map(({ target }) => target).filter(target => target.name || target.marker);
    return {
      page: currentPage(),
      targets: targets.slice(0, 64),
      truncated: targets.length > 64,
    };
  }

  return { available, scan, resolve, snapshot };
}
