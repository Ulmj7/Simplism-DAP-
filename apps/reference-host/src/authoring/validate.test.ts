/** T403: the host validator over the REAL Feature 002 validator (no fake), with the host's authoring bounds in front of it. */
import { describe, expect, it } from "vitest";
import { MAX_GUIDE_STEPS, MAX_STEPS } from "./schema.js";
import { TRUSTED_REGISTRY } from "./trusted-registry.js";
import type { TrustedRegistryData } from "./trusted-registry.js";
import { MAX_ISSUES, MAX_ISSUE_CHARS, capIssues, validateAuthoredDefinition, validateDefinition } from "./validate.js";

const ID = "wt-0123456789ab";
type Step = Record<string, unknown>;
const nav = (id: string, route: string, next: string, extra: Step = {}): Step => ({ id, kind: "navigate", route, next, ...extra });
const guide = (id: string, target: string, next: string, extra: Step = {}): Step => ({ id, kind: "guide", target, text: `Do the step ${id}.`, wait: "click", next, ...extra });
const done = (id = "done"): Step => ({ id, kind: "complete", text: "All done." });
const def = (over: Record<string, unknown> = {}) => ({
  id: ID, title: "Save your name", description: "Change your display name and save it.", start: "n1",
  steps: [nav("n1", "profile", "s1"), guide("s1", "profile.saveButton", "done"), done()], ...over,
});
const issues = (input: unknown, registry?: TrustedRegistryData): readonly string[] => { const r = validateDefinition(input, registry); return r.ok ? [] : r.issues; };
const ok = (input: unknown, registry?: TrustedRegistryData) => expect(validateDefinition(input, registry)).toMatchObject({ ok: true });
const bad = (input: unknown, registry?: TrustedRegistryData) => { const r = validateDefinition(input, registry); expect(r.ok, JSON.stringify(r)).toBe(false); return r.ok ? [] : r.issues; };

describe("valid definitions", () => {
  it("a one-guide-step definition is accepted and comes back frozen, with the known fields only", () => {
    const r = validateDefinition(def());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.definition).toEqual(def());
    expect(Object.isFrozen(r.definition)).toBe(true);
    expect(Object.isFrozen(r.definition.steps)).toBe(true);
    expect(Object.isFrozen(r.definition.steps[0])).toBe(true);
    expect(Object.keys(r.definition).sort()).toEqual(["description", "id", "start", "steps", "title"]);
  });
  it("a multi-step definition across pages, with verify, input and ack waits, is accepted", () => {
    ok(def({
      start: "n1",
      steps: [
        nav("n1", "profile", "s1"),
        guide("s1", "profile.nameInput", "s2", { wait: "input" }),
        guide("s2", "profile.saveButton", "n2", { verify: "profile.saved" }),
        nav("n2", "settings", "s3"),
        guide("s3", "settings.securityPanel", "done", { wait: "ack" }),
        done(),
      ],
    }));
  });
  it("optional bounded fields are accepted: targetWaitMs, maxAttempts and a recover step", () => {
    ok(def({ steps: [nav("n1", "profile", "s1"), guide("s1", "profile.saveButton", "done", { recover: "s2", maxAttempts: 2, targetWaitMs: 500, verify: "profile.saved" }), guide("s2", "profile.nameInput", "s1", { wait: "input" }), done()] }));
  });
  it("a navigate step with text, and a step without a navigate before it, are accepted", () => {
    ok(def({ start: "s1", steps: [guide("s1", "nav.settings", "n1"), nav("n1", "settings", "done", { text: "Go to settings." }), done()] }));
  });
  it("does not change the caller's object, and later changes to it do not reach the result", () => {
    const input = def();
    const before = JSON.stringify(input);
    const r = validateDefinition(input);
    expect(JSON.stringify(input)).toBe(before);
    (input.steps[1] as unknown as Step).text = "Changed afterwards.";
    expect(r.ok && (r.definition.steps[1] as unknown as Step).text).toBe("Do the step s1.");
  });
  it("the three real built-in step shapes the app ships (navigate, input, click + verify, ack) are all within the bounds", () => {
    ok(def({ steps: [nav("n1", "profile", "s1"), guide("s1", "profile.nameInput", "s2", { wait: "input" }), guide("s2", "profile.saveButton", "done", { verify: "profile.saved", recover: "s3" }), guide("s3", "profile.nameInput", "s2", { wait: "input" }), done()] }));
  });
});

describe("the authoring bounds (host-only additions)", () => {
  it("zero guide steps is refused", () => {
    expect(bad(def({ start: "done", steps: [done()] })).join(" ")).toMatch(/guide step/);
    expect(bad(def({ start: "n1", steps: [nav("n1", "profile", "done"), done()] })).join(" ")).toMatch(/guide step/);
  });
  it(`exactly ${MAX_GUIDE_STEPS} guide steps are accepted and ${MAX_GUIDE_STEPS + 1} are refused`, () => {
    const chain = (n: number) => [
      ...Array.from({ length: n }, (_v, i) => guide(`s${i + 1}`, "profile.saveButton", i + 1 === n ? "done" : `s${i + 2}`)),
      done(),
    ];
    ok(def({ start: "s1", steps: chain(MAX_GUIDE_STEPS) }));
    expect(bad(def({ start: "s1", steps: chain(MAX_GUIDE_STEPS + 1) })).join(" ")).toMatch(/guide step/);
  });
  it(`more than ${MAX_STEPS} steps in total is refused, exactly ${MAX_STEPS} is accepted`, () => {
    // 8 guide steps, each preceded by a navigate, is 16; pad with navigate steps to the limit.
    const guides = Array.from({ length: 8 }, (_v, i) => guide(`g${i}`, "profile.saveButton", `p${i}`));
    const pads = Array.from({ length: MAX_STEPS - 9 }, (_v, i) => nav(`p${i}`, "profile", i + 1 === MAX_STEPS - 9 ? "done" : `p${i + 1}`));
    const stepsOf = (padCount: number) => {
      const out: Step[] = [];
      for (let i = 0; i < 8; i++) out.push(guide(`g${i}`, "profile.saveButton", i < 7 ? `g${i + 1}` : padCount > 0 ? "p0" : "done"));
      for (let i = 0; i < padCount; i++) out.push(nav(`p${i}`, "profile", i + 1 === padCount ? "done" : `p${i + 1}`));
      out.push(done());
      return out;
    };
    expect(guides.length + pads.length + 1).toBe(MAX_STEPS);
    ok(def({ start: "g0", steps: stepsOf(MAX_STEPS - 9) }));
    expect(bad(def({ start: "g0", steps: stepsOf(MAX_STEPS - 8) })).join(" ")).toMatch(/too long or too many/);
  });
  it("a definition with no steps, or steps that are not an array, is refused", () => {
    bad(def({ steps: [] }));
    bad(def({ steps: "none" }));
    bad(def({ steps: { 0: done() } }));
  });
  it("oversize strings are refused: title over 80, text over 240, ids over 64, target over 128", () => {
    bad(def({ title: "t".repeat(81) }));
    ok(def({ title: "t".repeat(80) }));
    bad(def({ description: "d".repeat(241) }));
    bad(def({ steps: [nav("n1", "profile", "s1"), guide("s1", "profile.saveButton", "done", { text: "x".repeat(241) }), done()] }));
    bad(def({ steps: [nav("n1", "profile", "s1"), { ...guide("s1", "profile.saveButton", "done"), id: "s".repeat(65) }, done()] }));
    bad(def({ steps: [nav("n1", "profile", "s1"), guide("s1", "p".repeat(129), "done"), done()] }));
  });
  it("empty strings are refused", () => {
    bad(def({ title: "" }));
    bad(def({ steps: [nav("n1", "profile", "s1"), guide("s1", "profile.saveButton", "done", { text: "" }), done()] }));
  });
});

describe("shape: extra keys, wrong types and prototype pollution", () => {
  it.each([
    ["an extra top-level key", { extra: 1 }], ["a selector at top level", { selector: "#save" }], ["a script", { script: "alert(1)" }], ["tenantId", { tenantId: "t" }],
    ["permissions", { permissions: ["x"] }], ["status", { status: "published" }], ["published flag", { published: true }],
  ])("%s is refused", (_name, extra) => { bad(def(extra)); });
  it("an extra key on a step is refused, whatever its name", () => {
    for (const key of ["selector", "script", "url", "html", "condition", "branch", "onClick", "operation", "kind2"]) {
      const withKey = def({ steps: [nav("n1", "profile", "s1"), { ...guide("s1", "profile.saveButton", "done"), [key]: "x" }, done()] });
      expect(issues(withKey).join(" "), key).toMatch(/unknown field/);
    }
  });
  it("a foreign field for the step's own kind is the validator's refusal (a complete step cannot carry a target)", () => {
    expect(bad(def({ steps: [nav("n1", "profile", "s1"), guide("s1", "profile.saveButton", "done"), { ...done(), target: "profile.saveButton" }] })).join(" ")).toMatch(/unknown field/);
  });
  it.each([
    ["null", null], ["undefined", undefined], ["a string", "definition"], ["a number", 5], ["an array", []], ["a function", () => def()],
    ["a numeric title", { title: 5 }], ["an object title", { title: { a: 1 } }], ["an array description", { description: ["x"] }], ["a numeric id", { id: 7 }],
    ["a string steps", { steps: "x" }], ["a null step", { steps: [null] }], ["a numeric step", { steps: [5] }], ["a string step", { steps: ["done"] }],
    ["a string maxAttempts", { steps: [guide("s1", "profile.saveButton", "done", { maxAttempts: "2" })] }],
    ["a float targetWaitMs", { steps: [guide("s1", "profile.saveButton", "done", { targetWaitMs: 1.5 })] }],
    ["a negative maxAttempts", { steps: [guide("s1", "profile.saveButton", "done", { maxAttempts: -1 })] }],
  ])("wrong type: %s", (_name, value) => {
    const input = value !== null && typeof value === "object" && !Array.isArray(value) ? def(value as Record<string, unknown>) : value;
    bad(input);
  });
  it("prototype-pollution keys are refused as unknown fields, and pollute nothing", () => {
    const polluted = JSON.parse('{"id":"wt-0123456789ab","title":"T","description":"D","start":"done","steps":[{"id":"done","kind":"complete","text":"x"}],"__proto__":{"polluted":true}}');
    bad(polluted);
    bad(JSON.parse('{"id":"wt-0123456789ab","title":"T","description":"D","start":"done","steps":[{"id":"done","kind":"complete","text":"x","__proto__":{"polluted":true}}]}'));
    bad(def({ constructor: { prototype: { polluted: true } } }));
    bad(def({ prototype: {} }));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty("polluted");
  });
  it("step ids that are prototype names are refused by the validator", () => {
    for (const reserved of ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty", "valueOf"]) {
      bad(def({ start: reserved, steps: [guide(reserved, "profile.saveButton", "done"), done()] }));
    }
  });
  it("a class instance, a getter and an object with a throwing property are handled without throwing", () => {
    class Def { id = ID; title = "T"; description = "D"; start = "done"; steps = [done()]; }
    expect(() => validateDefinition(new Def())).not.toThrow();
    const hostile = { get id(): string { throw new Error("SECRET-GETTER"); }, title: "T", description: "D", start: "done", steps: [done()] };
    const r = validateDefinition(hostile);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("SECRET");
    const proxied = new Proxy({}, { get() { throw new Error("SECRET-PROXY"); }, ownKeys() { throw new Error("SECRET-PROXY"); } });
    expect(JSON.stringify(validateDefinition(proxied))).not.toContain("SECRET");
  });
});

describe("semantic targets: only registered elements that allow the chosen interaction", () => {
  it.each(["#save", ".settings-button", "//*[@id='foo']", "document.querySelector('x')", "button[type=submit]", "profile.saveButton ", " profile.saveButton", "PROFILE.SAVEBUTTON", "profile.password", "settings.adminPanel", "constructor", "__proto__", "javascript:alert(1)", "<img src=x>"])(
    "the hand-typed or unknown target %j is refused as an unknown target", (target) => {
      expect(bad(def({ steps: [nav("n1", "profile", "s1"), guide("s1", target, "done"), done()] })).join(" ")).toMatch(/unknown target|text must be plain/);
    });
  it("a target with a click wait that only allows highlight is refused, as is an input wait on a button", () => {
    expect(bad(def({ steps: [nav("n1", "settings", "s1"), guide("s1", "settings.securityPanel", "done", { wait: "click" }), done()] })).join(" ")).toMatch(/wait click needs a target that allows click/);
    expect(bad(def({ steps: [nav("n1", "profile", "s1"), guide("s1", "profile.saveButton", "done", { wait: "input" }), done()] })).join(" ")).toMatch(/wait input needs a target that allows input/);
    expect(bad(def({ steps: [nav("n1", "profile", "s1"), guide("s1", "profile.nameInput", "done", { wait: "click" }), done()] })).join(" ")).toMatch(/wait click needs/);
  });
  it("a wait that is not click, input or ack is refused (an operation the language does not have)", () => {
    for (const wait of ["hover", "focus", "type", "CLICK", "", "click "]) {
      const found = issues(def({ steps: [nav("n1", "profile", "s1"), guide("s1", "profile.saveButton", "done", { wait }), done()] }));
      expect(found.length, JSON.stringify(wait)).toBeGreaterThan(0);
    }
  });
  it("a step kind outside guide, navigate and complete is refused (no new kinds)", () => {
    for (const kind of ["branch", "script", "click", "condition", "Guide", ""]) bad(def({ steps: [nav("n1", "profile", "s1"), { ...guide("s1", "profile.saveButton", "done"), kind }, done()] }));
  });
  it("the password field and admin pages are not in the registry, so no guide can target them", () => {
    expect(TRUSTED_REGISTRY.elements.map((e) => e.id)).not.toContain("profile.passwordInput");
    expect(TRUSTED_REGISTRY.routes).not.toContain("walkthroughs");
    bad(def({ steps: [nav("n1", "walkthroughs", "s1"), guide("s1", "profile.saveButton", "done"), done()] }));
    bad(def({ steps: [nav("n1", "editor", "s1"), guide("s1", "profile.saveButton", "done"), done()] }));
  });
});

describe("routes, postconditions and transitions", () => {
  it("an unknown route is refused", () => {
    expect(bad(def({ steps: [nav("n1", "admin", "s1"), guide("s1", "profile.saveButton", "done"), done()] })).join(" ")).toMatch(/unknown route/);
    expect(bad(def({ steps: [nav("n1", "Profile", "s1"), guide("s1", "profile.saveButton", "done"), done()] })).join(" ")).toMatch(/unknown route/);
  });
  it("an unknown postcondition is refused (no arbitrary check can be named)", () => {
    for (const verify of ["profile.deleted", "eval", "window.x", "profile.saved ", "route.admin"]) {
      expect(bad(def({ steps: [nav("n1", "profile", "s1"), guide("s1", "profile.saveButton", "done", { verify }), done()] })).join(" "), verify).toMatch(/unknown postcondition/);
    }
  });
  it("a missing start, a start that names no step, and a missing next are refused", () => {
    expect(bad(def({ start: undefined })).length).toBeGreaterThan(0);
    expect(bad(def({ start: "nowhere" })).join(" ")).toMatch(/missing start step/);
    expect(bad(def({ steps: [nav("n1", "profile", "s1"), guide("s1", "profile.saveButton", "ghost"), done()] })).join(" ")).toMatch(/missing next step/);
    expect(bad(def({ steps: [nav("n1", "profile", "s1"), { id: "s1", kind: "guide", target: "profile.saveButton", text: "x", wait: "click" }, done()] })).join(" ")).toMatch(/missing next step/);
  });
  it("a recover step that is the step itself, a complete step, missing, or over the attempts limit is refused", () => {
    const withRecover = (recover: string, extra: Step = {}) => def({ steps: [nav("n1", "profile", "s1"), guide("s1", "profile.saveButton", "done", { recover, ...extra }), guide("s2", "profile.nameInput", "s1", { wait: "input" }), done()] });
    expect(bad(withRecover("s1")).join(" ")).toMatch(/recover points at the step itself/);
    expect(bad(withRecover("done")).join(" ")).toMatch(/recover points at a complete step/);
    expect(bad(withRecover("ghost")).join(" ")).toMatch(/missing recover step/);
    expect(bad(withRecover("s2", { maxAttempts: 11 })).join(" ")).toMatch(/maxAttempts/);
    expect(bad(withRecover("s2", { maxAttempts: 0 })).join(" ")).toMatch(/maxAttempts/);
    expect(bad(withRecover("s2", { targetWaitMs: 10_001 })).join(" ")).toMatch(/targetWaitMs/);
    ok(withRecover("s2", { maxAttempts: 10, targetWaitMs: 10_000 }));
  });
  it("an unreachable step is refused", () => {
    expect(bad(def({ steps: [nav("n1", "profile", "s1"), guide("s1", "profile.saveButton", "done"), guide("orphan", "profile.nameInput", "done", { wait: "input" }), done()] })).join(" ")).toMatch(/unreachable from start/);
  });
  it("a loop with no path to a complete step is refused, and a duplicate step id is refused", () => {
    expect(bad(def({ steps: [nav("n1", "profile", "s1"), guide("s1", "profile.saveButton", "s2"), guide("s2", "profile.nameInput", "s1", { wait: "input" }), done()] })).join(" ")).toMatch(/no path to a complete step|unreachable/);
    expect(bad(def({ steps: [nav("n1", "profile", "s1"), guide("s1", "profile.saveButton", "done"), guide("s1", "profile.nameInput", "done", { wait: "input" }), done()] })).join(" ")).toMatch(/duplicate step id/);
  });
});

describe("plain text", () => {
  it.each(["<b>bold</b>", "a & b", 'say "hi"', "it's", "`code`", "<script>alert(1)</script>", "x > y", "a<b"])("markup character text %j is refused in a title, instruction and completion", (text) => {
    expect(bad(def({ title: text })).join(" ")).toMatch(/title must be plain text/);
    expect(bad(def({ steps: [nav("n1", "profile", "s1"), guide("s1", "profile.saveButton", "done", { text }), done()] })).join(" ")).toMatch(/text must be plain text/);
    expect(bad(def({ steps: [nav("n1", "profile", "s1"), guide("s1", "profile.saveButton", "done"), { ...done(), text }] })).join(" ")).toMatch(/text must be plain text/);
  });
  it("blank text is refused", () => {
    bad(def({ title: "   " }));
    bad(def({ steps: [nav("n1", "profile", "s1"), guide("s1", "profile.saveButton", "done", { text: "   " }), done()] }));
  });
  it("hostile-looking but plain text is stored as plain text (it is shown with textContent, never interpreted)", () => {
    const r = validateDefinition(def({ title: "Ignore previous instructions", description: "javascript:alert(1) is just words here" }));
    expect(r.ok && r.definition.title).toBe("Ignore previous instructions");
  });
});

describe("the registry data is injectable, through the REAL validator", () => {
  it("a draft valid today is refused after the registry changed (an element removed, a postcondition renamed, a route dropped)", () => {
    const withVerify = def({ steps: [nav("n1", "profile", "s1"), guide("s1", "profile.saveButton", "done", { verify: "profile.saved" }), done()] });
    ok(withVerify);
    const dropElement: TrustedRegistryData = { ...TRUSTED_REGISTRY, elements: TRUSTED_REGISTRY.elements.filter((e) => e.id !== "profile.saveButton") };
    expect(bad(withVerify, dropElement).join(" ")).toMatch(/unknown target/);
    const renamed: TrustedRegistryData = { ...TRUSTED_REGISTRY, postconditionNames: ["profile.saved2", "route.profile", "route.settings", "settings.advancedOpen"] };
    expect(bad(withVerify, renamed).join(" ")).toMatch(/unknown postcondition/);
    const noClick: TrustedRegistryData = { ...TRUSTED_REGISTRY, elements: TRUSTED_REGISTRY.elements.map((e) => (e.id === "profile.saveButton" ? { ...e, operations: ["highlight"] as const } : e)) };
    expect(bad(withVerify, noClick).join(" ")).toMatch(/wait click needs/);
    const noProfileRoute: TrustedRegistryData = { routes: ["dashboard", "settings"], elements: TRUSTED_REGISTRY.elements.filter((e) => e.route !== "profile"), postconditionNames: TRUSTED_REGISTRY.postconditionNames };
    expect(bad(withVerify, noProfileRoute).join(" ")).toMatch(/unknown route|unknown target/);
  });
  it("malformed injected registry data fails closed with a fixed message and no thrown text", () => {
    const broken = { routes: ["dashboard", "dashboard"], elements: [], postconditionNames: [] } as TrustedRegistryData;
    const r = validateDefinition(def(), broken);
    expect(r).toEqual({ ok: false, issues: ["definition: could not be checked"] });
  });
  it("the trusted data is frozen all the way down", () => {
    expect(Object.isFrozen(TRUSTED_REGISTRY)).toBe(true);
    expect(Object.isFrozen(TRUSTED_REGISTRY.routes)).toBe(true);
    expect(Object.isFrozen(TRUSTED_REGISTRY.postconditionNames)).toBe(true);
    for (const element of TRUSTED_REGISTRY.elements) { expect(Object.isFrozen(element)).toBe(true); expect(Object.isFrozen(element.operations)).toBe(true); }
    expect(TRUSTED_REGISTRY.routes).toHaveLength(3);
    expect(TRUSTED_REGISTRY.elements).toHaveLength(8);
    expect(TRUSTED_REGISTRY.postconditionNames).toHaveLength(4);
  });
});

describe("issues are safe and bounded", () => {
  it("at most 20 issues of at most 200 characters, with control characters replaced", () => {
    const many = Array.from({ length: 30 }, (_v, i) => guide(`s${i}`, `unknown.target${i}`, i === 29 ? "done" : `s${i + 1}`));
    const found = issues({ id: ID, title: "T", description: "D", start: "s0", steps: [...many.slice(0, 8), done()] });
    expect(found.length).toBeLessThanOrEqual(MAX_ISSUES);
    expect(capIssues(Array.from({ length: 50 }, () => "x"))).toHaveLength(MAX_ISSUES);
    expect(capIssues(["a".repeat(500)])[0]).toHaveLength(MAX_ISSUE_CHARS);
    expect(capIssues(["line1\nline2" + String.fromCharCode(0) + String.fromCharCode(0x202e)])[0]).toBe("line1 line2  ");
  });
  it("an unknown key's own name (typed by the maintainer) cannot smuggle a line break or a long text", () => {
    const found = issues(def({ ["bad\nkey" + "x".repeat(300)]: 1 }));
    for (const line of found) { expect(line).not.toMatch(/[\r\n]/); expect(line.length).toBeLessThanOrEqual(MAX_ISSUE_CHARS); }
  });
  it("no issue mentions zod, a stack or a registry object", () => {
    const found = JSON.stringify(issues({ id: 1, title: [], steps: null, extra: {} }));
    for (const word of ["zod", "Zod", "at ", "stack", "[object", "invalid_type", "Expected"]) expect(found, word).not.toContain(word);
  });
});

describe("validateAuthoredDefinition: the executor's check", () => {
  it("accepts a generated id with a matching definition id", () => { expect(validateAuthoredDefinition(ID, def())).toMatchObject({ ok: true }); });
  it("refuses an id that is not the generated shape, the preview id and every built-in id", () => {
    for (const id of ["profileUpdate", "findSecuritySettings", "findTwoFactorSettings", "wt-preview", "wt-ABCDEF012345", "wt-0123456789a", "wt-0123456789abc", "abc", "", "__proto__", " wt-0123456789ab", "wt-0123456789ab\n", 5, null, undefined, {}]) {
      expect(validateAuthoredDefinition(id, def({ id: typeof id === "string" && id !== "" ? id : ID })), String(id)).toMatchObject({ ok: false, code: "id_refused" });
    }
  });
  it("refuses a definition whose own id differs from the walkthrough id (never repaired)", () => {
    expect(validateAuthoredDefinition(ID, def({ id: "wt-ffffffffffff" }))).toMatchObject({ ok: false, code: "id_refused" });
    expect(validateAuthoredDefinition(ID, def({ id: "profileUpdate" }))).toMatchObject({ ok: false, code: "id_refused" });
  });
  it("refuses an invalid definition as invalid_definition and returns its issues", () => {
    const r = validateAuthoredDefinition(ID, def({ start: "nowhere" }));
    expect(r).toMatchObject({ ok: false, code: "invalid_definition" });
    expect(r.ok ? [] : r.issues.join(" ")).toMatch(/missing start step/);
  });
});
