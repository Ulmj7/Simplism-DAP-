import { createSimplism } from "/sdk/index.js";
import options from "/simplism-config.js";

if (options) {
  const result = createSimplism(options);
  if (result.ok) {
    window.simplism = result.value;
    document.querySelector("#stop-guide").addEventListener("click", () => window.simplism.stopGuide());
    document.querySelector("#restart-guide").addEventListener("click", () => { void window.simplism.restartGuide(); });
    document.querySelector("#destroy-runtime").addEventListener("click", () => window.simplism.destroy());
    window.simplismReady = await Promise.all([window.simplism.start(), window.simplism.start()]);
  }
}
