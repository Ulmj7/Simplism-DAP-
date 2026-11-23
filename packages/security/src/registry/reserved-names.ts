export const RESERVED_PARAMETER_NAMES: readonly string[] = Object.freeze([
  "userId", "tenantId", "sessionId", "role", "roles", "permission", "permissions", "isAdmin",
  "confirmed", "confirmation", "confirmationId", "approved", "authorization", "token",
]);

/** These names classify general-purpose powers; classification can only deny. */
export const RESERVED_FORBIDDEN_ACTION_NAMES: readonly string[] = Object.freeze([
  "eval", "executeJavaScript", "executeScript", "runScript", "executeShell", "runShell",
  "executeCommand", "runCommand", "executeSQL", "executeQuery", "runQuery", "queryDatabase", "fetchUrl", "fetchAnyUrl",
  "httpRequest", "outboundRequest", "callApi", "clickSelector", "typeSelector", "clickBySelector",
  "typeBySelector", "clickAnySelector", "typeAnySelector", "getPassword", "getCredentials", "getToken", "getSecret", "retrieveCredentials",
  "retrieveToken", "disableAudit", "disableAuditLog", "changePermissions", "setPermissions",
  "changeOwnPermissions", "grantPermission", "bypassAuthorization",
]);

export function normalizeForClassification(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const forbidden = new Set(RESERVED_FORBIDDEN_ACTION_NAMES.map(normalizeForClassification));
const parameters = new Set(RESERVED_PARAMETER_NAMES.map(normalizeParameterName));
const prototypeNames = new Set(["__proto__", "constructor", "prototype", "toString", "hasOwnProperty"]);

function normalizeParameterName(name: string): string {
  return name.toLowerCase().replace(/[_-]/g, "");
}

export function isReservedParameterName(name: string): boolean {
  return parameters.has(normalizeParameterName(name));
}

export function isReservedForbidden(name: string): boolean {
  return typeof name === "string" && forbidden.has(normalizeForClassification(name));
}

export function isValidActionId(id: unknown): id is string {
  // The end assertion also rejects a final newline (unlike JavaScript's `$`).
  return typeof id === "string" && /^[a-z][A-Za-z0-9]{2,63}$/.test(id) &&
    !/[\r\n]/.test(id) && !prototypeNames.has(id) && !isReservedForbidden(id);
}
