import type { AdminResult, DemoRole, GuideRecord } from "./client.js";
import { emptyDraft } from "./draft.js";
import type { EditorDraft } from "./draft.js";

const ROLE_KEY = "dap-demo-role";
export function readRole(win: Window): DemoRole {
  try { return win.sessionStorage.getItem(ROLE_KEY) === "maintainer" ? "maintainer" : "user"; } catch { return "user"; }
}
export function writeRole(win: Window, role: DemoRole): void {
  try { win.sessionStorage.setItem(ROLE_KEY, role); } catch { /* unavailable on some browser origins */ }
}
export interface EditSession {
  id?: string;
  /** The application this draft is written for. Chosen once (new draft, or a legacy draft with none) and fixed after the first save. */
  applicationId?: string;
  applicationLocked?: boolean;
  draft: EditorDraft;
  selected: number;
  dirty: boolean;
  saved?: boolean;
  saving?: Promise<AdminResult<GuideRecord>>;
}
let current: EditSession | undefined;
export const getEditSession = () => current;
export function setEditSession(session?: EditSession): void { current = session; }
/** A new draft; `applicationId` preselects an application (the Application Manager's "Use for authoring"). */
export function newEditSession(applicationId?: string): EditSession {
  current = { draft: emptyDraft(), selected: 0, dirty: true, ...(applicationId === undefined ? {} : { applicationId }) };
  return current;
}

let requestedId: string | undefined;
export function requestEdit(id: string): void { requestedId = id; }
export function takeRequestedEdit(): string | undefined { const id = requestedId; requestedId = undefined; return id; }
