const messages = {
  BROWSER_NOT_STARTED: "The browser session has not started.",
  BROWSER_BUSY: "The browser session is running another command.",
  BROWSER_TIMEOUT: "The browser command timed out.",
  SNAPSHOT_FAILED: "The browser snapshot could not be captured.",
  REF_NOT_FOUND: "The target is unavailable in the current snapshot.",
  HIGHLIGHT_FAILED: "The browser could not highlight the target.",
  NAVIGATION_FAILED: "The reference app could not be opened.",
  DOMAIN_BLOCKED: "The browser URL is outside the approved app origin.",
  SESSION_CLOSED: "The browser session has closed.",
  CLOSE_FAILED: "The browser session could not be closed.",
  INVALID_BROWSER_OUTPUT: "The browser returned unusable data.",
} as const;

export type BrowserRuntimeErrorCode = keyof typeof messages;

export class BrowserRuntimeError extends Error {
  constructor(readonly code: BrowserRuntimeErrorCode) {
    super(messages[code]);
    this.name = "BrowserRuntimeError";
  }
}
