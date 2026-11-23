/** @dap/walkthrough/dom: the browser adapter, the only place that may touch `document` or `window`. */
export { createTargets } from "./targets.js";
export type { TargetHandle, Targets } from "./targets.js";
export { createOverlay } from "./overlay.js";
export type { Overlay, OverlayCallbacks } from "./overlay.js";
export { createSemanticBridge } from "./bridge.js";
export { createAvailabilityFeed } from "./availability.js";
export { placeCard } from "./placement.js";
export type { Rect, Size } from "./placement.js";
export type { OverlayContent } from "./overlay.js";
