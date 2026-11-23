import { installEmbed } from "./installer.js";
import tokens from "../styles/tokens.css?inline";
import overlay from "../styles/overlay.css?inline";
import styles from "./embed.css?inline";

installEmbed(window, document.currentScript?.getAttribute("data-dap-origin"),
  tokens.replace(":root", ":is(.dap-guide-card, .dap-guide-scrim, .dap-result)") + overlay + styles);
