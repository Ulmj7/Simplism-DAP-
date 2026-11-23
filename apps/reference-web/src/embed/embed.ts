import { installEmbed } from "./installer.js";

// The delivery script tag configures the embed: `data-dap-origin` (Studio window handshake, Preview) or `data-dap-key` (standalone delivery). The stylesheet is a separate file, `dap-embed.css`,
// next to this script: see stylesheet.ts for the Content-Security-Policy this allows.
const script = document.currentScript;
installEmbed(window, {
  dapOrigin: script?.getAttribute("data-dap-origin"),
  key: script?.getAttribute("data-dap-key"),
  scriptSrc: script instanceof HTMLScriptElement ? script.src : undefined,
});
