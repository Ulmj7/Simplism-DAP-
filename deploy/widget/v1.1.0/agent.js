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
      border: "1px solid #a3b1be", borderRadius: "6px", resize: "vertical", margin: "4px 0 8px",
    });
    input.id = "dap-agent-question";
    input.rows = 2;
    input.maxLength = 500;
    const submit = element("button", "Илгээх", buttonStyle);
    submit.type = "submit";
    const status = element("p", undefined, { margin: "8px 0 0", color: "#435465" });
    status.setAttribute("role", "status");
    form.append(label, input, submit, status);
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

    function ask(query) {
      return request("/ask", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.session}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
    }

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
      submit.disabled = true;
      input.readOnly = true;
      status.textContent = "Хариулт бэлдэж байна…";
      try {
        let response = await ask(query);
        if (response.status === 401) {
          const refreshed = await bootstrap();
          if (!refreshed) {
            status.textContent = "Сессийг сэргээж чадсангүй. Дахин оролдоно уу.";
            return;
          }
          session = refreshed;
          heading.textContent = session.name;
          launcher.textContent = session.name;
          response = await ask(query);
        }
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
        submit.disabled = false;
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
      panel.hidden = false;
      launcher.setAttribute("aria-expanded", "true");
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
