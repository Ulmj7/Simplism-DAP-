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

  async function bootstrap() {
    const response = await fetch(`${apiOrigin}/api/widget/v1/${installationId}/bootstrap`, {
      credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return null;
    const result = await response.json();
    return typeof result.name === "string" && typeof result.session === "string" ? result : null;
  }

  async function mount() {
    const initial = await bootstrap();
    if (!initial) {
      active.delete(key);
      return;
    }

    const host = document.createElement("div");
    Object.assign(host.style, { position: "fixed", right: "20px", bottom: "20px", zIndex: "2147483000" });
    const root = host.attachShadow({ mode: "open" });
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = initial.name;
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-controls", "dap-agent-panel");
    Object.assign(button.style, {
      background: "#145c55", color: "#fff", border: "1px solid #fff", borderRadius: "10px", cursor: "pointer",
      maxWidth: "min(300px, calc(100vw - 40px))", padding: "10px 15px", font: "600 14px system-ui",
      overflowWrap: "anywhere",
    });
    const panel = document.createElement("section");
    panel.id = "dap-agent-panel";
    panel.setAttribute("aria-labelledby", "dap-agent-title");
    panel.hidden = true;
    Object.assign(panel.style, {
      position: "absolute", right: "0", bottom: "calc(100% + 8px)", width: "min(290px, calc(100vw - 40px))",
      boxSizing: "border-box", padding: "15px", border: "1px solid #dce3eb", background: "#fff",
      borderRadius: "10px", color: "#1b2736", boxShadow: "0 6px 20px #1b273633", font: "14px system-ui",
    });
    const heading = document.createElement("strong");
    heading.id = "dap-agent-title";
    const message = document.createElement("p");
    message.textContent = "Туслах амжилттай холбогдсон байна.";
    panel.append(heading, message);

    function close() {
      panel.hidden = true;
      button.setAttribute("aria-expanded", "false");
    }
    button.addEventListener("click", async () => {
      if (!panel.hidden) {
        close();
        return;
      }
      button.disabled = true;
      try {
        const current = await bootstrap();
        if (!current) {
          host.remove();
          active.delete(key);
          return;
        }
        heading.textContent = current.name;
        button.textContent = current.name;
        panel.hidden = false;
        button.setAttribute("aria-expanded", "true");
      } catch {
        close();
      } finally {
        button.disabled = false;
      }
    });
    root.addEventListener("keydown", event => {
      if (event.key === "Escape") close();
    });
    root.append(panel, button);
    document.body.append(host);
  }

  function start() {
    void mount().catch(() => { active.delete(key); });
  }
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
