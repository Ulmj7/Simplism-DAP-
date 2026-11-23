// Registration is top-frame only. The worker derives the document identity from Chrome's sender.
function attach() {
  void chrome.runtime.sendMessage({ action: "attach" }).catch(() => undefined);
}
attach();
window.addEventListener("pageshow", event => { if (event.persisted) attach(); });
