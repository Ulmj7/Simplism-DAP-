import { installEmbed } from "./installer.js";

// The delivery script tag configures the embed: `data-dap-origin` (Studio window handshake, Preview) or `data-dap-key` (standalone delivery; `data-dap-api` optionally names the DAP API origin
// when the two embed files are self-hosted, otherwise the API origin is the script's own origin). The stylesheet is a separate file, `dap-embed.css`,
// next to this script: see stylesheet.ts for the Content-Security-Policy this allows.
const script = document.currentScript;
installEmbed(window, {
  dapOrigin: script?.getAttribute("data-dap-origin"),
  key: script?.getAttribute("data-dap-key"),
  api: script?.getAttribute("data-dap-api"),
  scriptSrc: script instanceof HTMLScriptElement ? script.src : undefined,
});
