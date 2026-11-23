import { installEmbed } from "./installer.js";
import tokens from "../styles/tokens.css?inline";
import overlay from "../styles/overlay.css?inline";
import styles from "./embed.css?inline";

installEmbed(window, document.currentScript?.getAttribute("data-dap-origin"),
  tokens.replace(":root", ":is(.dap-guide-card, .dap-guide-scrim, .dap-guide-ring, .dap-result)") + overlay.split(".guides-card", 1)[0]!.replace(".result-actions", ".dap-result .result-actions") + styles);
