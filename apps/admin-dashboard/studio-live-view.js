const studioKeys = new Set([
  "Tab", "Enter", "Escape", "Backspace", "Delete", "Home", "End", "PageUp", "PageDown",
  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
]);

export function mountStudioLiveView(surface, image, { onFrame, onStatus, maySend }) {
  const keyboard = document.createElement("textarea");
  keyboard.className = "monitor-live-keyboard";
  keyboard.setAttribute("aria-label", "Studio браузерт бичих");
  keyboard.autocomplete = "off";
  keyboard.spellcheck = false;
  keyboard.hidden = true;
  keyboard.tabIndex = -1;
  surface.append(keyboard);

  let route;
  let socket;
  let retry;
  let revision;
  let restoreFocus = false;
  function interactive(enabled) {
    keyboard.hidden = !enabled;
    keyboard.value = "";
    surface.dataset.interactive = String(enabled);
    image.tabIndex = enabled ? 0 : -1;
  }
  function send(action) {
    if (socket?.readyState !== WebSocket.OPEN || revision === undefined || !maySend() || socket.bufferedAmount > 24 * 1024) return;
    socket.send(JSON.stringify({ ...action, revision }));
  }
  function sendText(text) {
    if (text) send({ kind: "text", text: text.slice(0, 2048) });
  }

  function position(event) {
    const rect = image.getBoundingClientRect();
    if (!rect.width || !rect.height) return undefined;
    const within = value => Math.max(0, Math.min(0.99999, value));
    return { x: within((event.clientX - rect.left) / rect.width), y: within((event.clientY - rect.top) / rect.height) };
  }
  function pointer(event) {
    if (keyboard.hidden || event.button !== 0 || !maySend()) return;
    const point = position(event);
    if (!point) return;
    keyboard.focus({ preventScroll: true });
    send({ kind: "click", ...point });
  }
  function wheel(event) {
    if (keyboard.hidden || !maySend()) return;
    const point = position(event);
    if (!point) return;
    event.preventDefault();
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? image.clientHeight : 1;
    const bound = value => Math.max(-2000, Math.min(2000, value * scale));
    send({ kind: "wheel", ...point, deltaX: bound(event.deltaX), deltaY: bound(event.deltaY) });
  }
  function press(event) {
    if (event.isComposing || !maySend()) return;
    let key;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") key = "ControlOrMeta+a";
    else if (!event.ctrlKey && !event.metaKey && !event.altKey && studioKeys.has(event.key)) {
      key = event.key === "Tab" && event.shiftKey ? "Shift+Tab" : event.key;
    }
    if (!key) return;
    event.preventDefault();
    send({ kind: "key", key });
    if (key === "Escape") image.focus({ preventScroll: true });
  }
  function change(event) {
    if (event.isComposing) return;
    const text = keyboard.value;
    keyboard.value = "";
    sendText(text);
  }
  function paste(event) {
    event.preventDefault();
    sendText(event.clipboardData?.getData("text/plain"));
  }

  function connect() {
    if (!route || socket) return;
    const url = new URL(route, location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const connection = new WebSocket(url);
    connection.binaryType = "blob";
    socket = connection;
    let metadata;
    connection.addEventListener("message", event => {
      if (socket !== connection) return;
      if (typeof event.data === "string") {
        try {
          const frame = JSON.parse(event.data);
          metadata = Number.isSafeInteger(frame.revision) && frame.width > 0 && frame.height > 0 ? frame : undefined;
        } catch { metadata = undefined; }
        return;
      }
      if (!metadata || !(event.data instanceof Blob)) return;
      const wasInteractive = !keyboard.hidden;
      revision = metadata.revision;
      if (!wasInteractive) interactive(true);
      onFrame(new Blob([event.data], { type: "image/jpeg" }), `${revision},${metadata.width},${metadata.height},0,0`);
      if (restoreFocus) keyboard.focus({ preventScroll: true });
      restoreFocus = false;
      metadata = undefined;
    });
    connection.addEventListener("error", () => { if (socket === connection) connection.close(); });
    connection.addEventListener("close", () => {
      if (socket !== connection) return;
      socket = revision = undefined;
      restoreFocus ||= document.activeElement === keyboard;
      interactive(false);
      onStatus("reconnecting");
      if (route) retry = setTimeout(connect, 700);
    });
  }

  image.addEventListener("click", pointer);
  image.addEventListener("keydown", event => {
    if (event.key !== "Enter" || keyboard.hidden || !maySend()) return;
    event.preventDefault();
    keyboard.focus({ preventScroll: true });
  });
  image.addEventListener("wheel", wheel, { passive: false });
  keyboard.addEventListener("keydown", press);
  keyboard.addEventListener("input", change);
  keyboard.addEventListener("compositionend", change);
  keyboard.addEventListener("paste", paste);
  interactive(false);

  return {
    show(next) {
      if (route === next) return;
      route = next;
      restoreFocus = false;
      clearTimeout(retry);
      const previous = socket;
      socket = revision = undefined;
      previous?.close();
      interactive(false);
      if (route) {
        onStatus("connecting");
        connect();
      }
    },
  };
}
