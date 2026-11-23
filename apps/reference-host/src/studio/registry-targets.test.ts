import { describe, expect, it } from "vitest";
import {
  ALLOWED_OPERATIONS, DEFAULT_OPERATIONS, MAX_PAGE_CHARS, REGISTRABLE_ROLES, RESERVED_TARGET_PREFIXES, TARGET_ISSUE_PHRASES, isPage, isRouteName, isTargetId, managedPostconditionName,
  MAX_HISTORY_PAGE_CHARS, isHashPage, isHistoryPage, isPageFor, registerTargetInputSchema, snapshotRoleToTargetRole, targetStatusInputSchema, validateTargetRegistration,
} from "./registry-targets.js";

const valid = (patch: Record<string, unknown> = {}) => ({
  targetId: "orders.submitButton", route: "orders", page: "/#/orders", elementRole: "button", label: "Submit order", description: "Submits the order", operations: ["highlight", "click"], privacy: "public", ...patch,
});
const issuesOf = (input: unknown): readonly string[] => { const result = validateTargetRegistration(input); if (result.ok) throw new Error("expected a refusal"); return result.issues; };

describe("a valid registration", () => {
  it("returns a frozen, fresh object with trimmed texts, canonical operations and the registry role", () => {
    const input = valid({ label: "  Submit order  ", description: " Submits the order ", operations: ["click", "highlight", "click"] });
    const result = validateTargetRegistration(input);
    expect(result).toEqual({ ok: true, value: { targetId: "orders.submitButton", route: "orders", page: "/#/orders", role: "button", label: "Submit order", description: "Submits the order", operations: ["highlight", "click"], privacy: "public" } });
    if (!result.ok) return;
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.operations)).toBe(true);
    expect(result.value.operations).not.toBe(input.operations);
  });
  it.each([
    ["button", ["highlight", "click", "focus"]], ["link", ["highlight"]], ["checkbox", ["highlight", "focus"]], ["select", ["highlight", "click"]], ["textbox", ["highlight", "input", "focus"]], ["textbox", ["highlight"]],
  ])("accepts the %s operations %j", (elementRole, operations) => { expect(validateTargetRegistration(valid({ elementRole, operations })).ok).toBe(true); });
  it("accepts the home page and a nested hash page", () => {
    expect(validateTargetRegistration(valid({ route: "home", page: "/" })).ok).toBe(true);
    expect(validateTargetRegistration(valid({ route: "orderList", page: "/#/orders/open-1_a.b~c" })).ok).toBe(true);
  });
});

describe("every rejection class", () => {
  it.each([
    ["no dot", "submitButton"], ["upper-case first letter", "Orders.submit"], ["a leading digit", "1orders.submit"], ["a trailing dot", "orders.submit."], ["an empty segment", "orders..submit"], ["a hyphen", "orders.submit-button"],
    ["a space", "orders .submit"], ["markup", "orders.<b>"], ["an 81-character id", `orders.${"a".repeat(74)}`], ["a prototype name", "__proto__.x"], ["non-ASCII", "orders.sübmit"], ["an empty id", ""],
  ])("refuses a target id with %s", (_name, targetId) => { expect(issuesOf(valid({ targetId }))).toEqual([TARGET_ISSUE_PHRASES.targetId]); });
  it.each(RESERVED_TARGET_PREFIXES)("refuses the reserved first segment %s", (prefix) => {
    expect(issuesOf(valid({ targetId: `${prefix}.submit` }))).toEqual([TARGET_ISSUE_PHRASES.targetId]);
    expect(validateTargetRegistration(valid({ targetId: `${prefix}Orders.submit` })).ok).toBe(true); // only the exact first segment is reserved
  });
  it("accepts the longest id (80 characters)", () => { expect(isTargetId(`orders.${"a".repeat(73)}`)).toBe(true); });
  it.each(["Orders", "1orders", "order-list", "order_list", "orders page", "", "a".repeat(41), "orders.list", "ö"])("refuses the route name %j", (route) => {
    expect(issuesOf(valid({ route }))).toEqual([TARGET_ISSUE_PHRASES.route]);
  });
  it("route names are letters and digits starting with a lower-case letter, at most 40", () => {
    expect(isRouteName("orders2")).toBe(true);
    expect(isRouteName("a".repeat(40))).toBe(true);
    expect(isRouteName("a".repeat(41))).toBe(false);
  });
  it.each(["", "orders", "/#orders", "/#/", "/#//orders", "/?x=1", "/#/orders?id=1", "/a/#/orders", "https://x.example/#/orders", "/#/orders#more", "/#/or ders", "/#/<x>", "//#/x", "/#/orders/"])(
    "refuses the page %j (neither a hash page nor a history path: no query, no fragment outside the hash grammar, no empty segment)", (page) => {
      expect(issuesOf(valid({ page }))).toEqual([TARGET_ISSUE_PHRASES.page]);
    });
  it("bounds the page at 120 characters", () => {
    expect(isPage(`/#/${"a".repeat(MAX_PAGE_CHARS - 3)}`)).toBe(true);
    expect(isPage(`/#/${"a".repeat(MAX_PAGE_CHARS - 2)}`)).toBe(false);
  });
  it.each(["panel", "nav", "heading", "text", "searchbox", "combobox", "Button", "", 5, null, undefined, "__proto__"])("refuses the role %j", (elementRole) => {
    expect(issuesOf(valid({ elementRole }))).toEqual([TARGET_ISSUE_PHRASES.role]);
  });
  it.each([
    ["button", ["highlight", "input"]], ["link", ["click"]], ["textbox", ["highlight", "click"]], ["select", ["highlight", "input"]], ["checkbox", ["highlight", "input", "focus"]],
    ["button", []], ["button", ["highlight", "drag"]], ["button", "highlight"], ["button", [5]], ["button", ["highlight", "click", "focus", "input", "click"]],
  ])("refuses the %s operations %j", (elementRole, operations) => { expect(issuesOf(valid({ elementRole, operations }))).toEqual([TARGET_ISSUE_PHRASES.operations]); });
  it.each(["private", "redact", "Public", "", null, undefined, true])("refuses the privacy %j: only public targets are registrable", (privacy) => {
    expect(issuesOf(valid({ privacy }))).toEqual([TARGET_ISSUE_PHRASES.privacy]);
  });
  it.each(["", "   ", "a<b", "a>b", "a&b", 'a"b', "a'b", "a`b", "line\nbreak", "bidi\u202eover", "x".repeat(81), 5, null])("refuses the label %j", (label) => {
    expect(issuesOf(valid({ label }))).toEqual([TARGET_ISSUE_PHRASES.label]);
  });
  it.each(["", "   ", "a<b", "a&b", "x".repeat(241), 5])("refuses the description %j", (description) => {
    expect(issuesOf(valid({ description }))).toEqual([TARGET_ISSUE_PHRASES.description]);
  });
  it("accepts the longest label (80) and description (240)", () => {
    expect(validateTargetRegistration(valid({ label: "x".repeat(80), description: "y".repeat(240) })).ok).toBe(true);
  });
  it.each([null, undefined, 5, "x", [], [valid()]])("refuses a non-object input %j", (input) => { expect(issuesOf(input)).toEqual([TARGET_ISSUE_PHRASES.shape]); });
  it("refuses an unknown field (role under its reserved name, tenant, status) without naming it", () => {
    for (const extra of [{ role: "button" }, { tenantId: "t" }, { status: "active" }, { __x: 1 }]) expect(issuesOf({ ...valid(), ...extra })).toEqual([TARGET_ISSUE_PHRASES.shape]);
  });
  it("never echoes anything that was supplied", () => {
    const MARK = "TYPED-MARKER-4417";
    const result = validateTargetRegistration({ targetId: MARK, route: MARK, page: MARK, elementRole: MARK, label: `${MARK}<`, description: `${MARK}&`, operations: [MARK], privacy: MARK, [MARK]: 1 });
    expect(JSON.stringify(result)).not.toContain(MARK);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.length).toBeGreaterThanOrEqual(8);
  });
  it("collects every problem at once", () => { expect(issuesOf(valid({ targetId: "x", route: "X", page: "x", elementRole: "x", label: "", description: "", operations: [], privacy: "x" })).length).toBe(8); });
});

describe("roles and operations (D5)", () => {
  it("maps snapshot roles onto registry roles and refuses every other role", () => {
    expect(["button", "link", "textbox", "searchbox", "checkbox", "combobox"].map(snapshotRoleToTargetRole)).toEqual(["button", "link", "textbox", "textbox", "checkbox", "select"]);
    for (const role of ["heading", "img", "listbox", "menuitem", "radio", "switch", "tab", "slider", "spinbutton", "option", "", null, undefined, 5]) expect(snapshotRoleToTargetRole(role), String(role)).toBeNull();
  });
  it("every default is a subset of its allowed set and includes highlight", () => {
    for (const role of REGISTRABLE_ROLES) {
      expect(DEFAULT_OPERATIONS[role]).toContain("highlight");
      for (const operation of DEFAULT_OPERATIONS[role]) expect(ALLOWED_OPERATIONS[role]).toContain(operation);
    }
    expect(ALLOWED_OPERATIONS.textbox).toEqual(["highlight", "input", "focus"]);
    expect(ALLOWED_OPERATIONS.button).toEqual(["highlight", "click", "focus"]);
  });
  it("managed postconditions are route.<route>", () => { expect(managedPostconditionName("orders")).toBe("route.orders"); });
});

describe("the capability input schemas", () => {
  const input = { applicationId: "app-0123456789ab", targetId: "orders.submit", route: "orders", page: "/#/orders", elementRole: "button", label: "Submit", description: "Submits", operations: ["highlight"], privacy: "public" };
  it("accept exactly the register fields and refuse spoofed, missing, oversize and mistyped ones", () => {
    expect(registerTargetInputSchema.safeParse(input).success).toBe(true);
    for (const extra of ["tenantId", "role", "status", "permissions", "actorId"]) expect(registerTargetInputSchema.safeParse({ ...input, [extra]: "x" }).success, extra).toBe(false);
    for (const key of Object.keys(input)) expect(registerTargetInputSchema.safeParse({ ...input, [key]: undefined }).success, key).toBe(false);
    expect(registerTargetInputSchema.safeParse({ ...input, operations: ["highlight", "click", "input", "focus", "x"] }).success).toBe(false);
    expect(registerTargetInputSchema.safeParse({ ...input, label: "x".repeat(81) }).success).toBe(false);
    expect(registerTargetInputSchema.safeParse({ ...input, applicationId: "wt-0123456789ab" }).success).toBe(false);
    expect(registerTargetInputSchema.safeParse({ ...input, operations: "highlight" }).success).toBe(false);
  });
  it("the status input accepts active and disabled only", () => {
    const status = { applicationId: "app-0123456789ab", targetId: "orders.submit", status: "disabled" };
    expect(targetStatusInputSchema.safeParse(status).success).toBe(true);
    expect(targetStatusInputSchema.safeParse({ ...status, status: "active" }).success).toBe(true);
    for (const bad of [{ ...status, status: "deleted" }, { ...status, status: "" }, { ...status, extra: 1 }, { applicationId: status.applicationId, status: "active" }]) expect(targetStatusInputSchema.safeParse(bad).success).toBe(false);
  });
});

describe("history pages (Studio COMPLETION, S1)", () => {
  it.each(["/", "/profile", "/users/123", "/a/b-c/d.e_f~g", `/${"a".repeat(199)}`, "/.hidden", "/a..b", "/a.b/c"])("%j is a history page", (page) => { expect(isHistoryPage(page)).toBe(true); });
  it.each(["", "profile", "/profile/", "/a//b", "/a/./b", "/a/../b", "/..", "/.", "/a?b=1", "/a#b", "/#/orders", "/a b", "/a%20b", "/a\\b", "/a:b", "/caf\u00e9", "/a\nb", `/${"a".repeat(200)}`, "https://x.example/a", 5, null, undefined])(
    "%j is not a history page", (page) => { expect(isHistoryPage(page)).toBe(false); });
  it("the hash grammar is unchanged: `/` and `/#/segments` up to 120 characters, never a pathname", () => {
    expect(isHashPage("/")).toBe(true);
    expect(isHashPage("/#/orders/open")).toBe(true);
    expect(isHashPage("/orders")).toBe(false);
    expect(isHashPage(`/#/${"a".repeat(118)}`)).toBe(false);
    expect(isHashPage(`/#/${"a".repeat(117)}`)).toBe(true);
  });
  it("isPageFor applies the application's own routing; `/` is a page of both; isPage accepts either grammar", () => {
    expect(isPageFor("hash", "/#/orders")).toBe(true);
    expect(isPageFor("hash", "/users/123")).toBe(false);
    expect(isPageFor("history", "/users/123")).toBe(true);
    expect(isPageFor("history", "/#/orders")).toBe(false);
    expect(isPageFor("hash", "/")).toBe(true);
    expect(isPageFor("history", "/")).toBe(true);
    expect(isPage("/users/123")).toBe(true);
    expect(isPage("/#/orders")).toBe(true);
    expect(isPage("/a/./b")).toBe(false);
    expect(MAX_HISTORY_PAGE_CHARS).toBe(200);
  });
  it("the validator accepts a history page structurally (the store applies the application's routing) and still refuses malformed ones", () => {
    expect(validateTargetRegistration(valid({ page: "/users/123", route: "users123" }))).toMatchObject({ ok: true, value: { page: "/users/123" } });
    for (const page of ["/users/", "/a?x=1", "/a#x", "/a//b", "/a/../b", `/${"a".repeat(200)}`]) expect(issuesOf(valid({ page }))).toEqual([TARGET_ISSUE_PHRASES.page]);
  });
  it("the capability input schema allows pages up to 200 characters", () => {
    expect(registerTargetInputSchema.safeParse({ applicationId: "app-0123456789ab", targetId: "a.b", route: "a", page: `/${"a".repeat(199)}`, elementRole: "button", label: "L", description: "D", operations: ["highlight"], privacy: "public" }).success).toBe(true);
    expect(registerTargetInputSchema.safeParse({ applicationId: "app-0123456789ab", targetId: "a.b", route: "a", page: `/${"a".repeat(200)}`, elementRole: "button", label: "L", description: "D", operations: ["highlight"], privacy: "public" }).success).toBe(false);
  });
});
