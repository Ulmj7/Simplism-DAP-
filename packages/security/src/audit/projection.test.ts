import { describe, expect, it } from "vitest";
import type { AuditParamRule } from "@dap/contracts";
import { MASKED, projectParams } from "./projection.js";
import { REDACTED, UNSERIALIZABLE } from "./scrubber.js";

const plain = (path: string): AuditParamRule => ({ path, mode: "plain" });
const masked = (path: string): AuditParamRule => ({ path, mode: "masked" });
const params = { projectId: "p1", note: "hello", email: "a@b.c", tags: ["x", "y"], nested: { a: 1, b: { c: "deep" } }, "a/b": "slash", "a~b": "tilde", "": "empty-key" };
const view = (rules: AuditParamRule[], input: unknown = params) => ({ ...projectParams(input, rules) });

describe("only listed paths are recorded", () => {
  it("records exactly the listed paths, keyed by path, and nothing else", () => {
    expect(view([plain("/projectId"), plain("/tags/1"), plain("/nested/b/c")])).toEqual({ "/projectId": "p1", "/tags/1": "y", "/nested/b/c": "deep" });
  });

  it("records nothing for an empty allowlist: the default is deny", () => {
    expect(view([])).toEqual({});
    expect(JSON.stringify(projectParams(params, []))).toBe("{}");
  });

  it("records nothing that is not listed, however the parameters look", () => {
    const out = JSON.stringify(projectParams(params, [plain("/projectId")]));
    for (const unlisted of ["hello", "a@b.c", "deep", "slash", "tilde", "empty-key"]) expect(out).not.toContain(unlisted);
  });

  it("records a whole subtree when its container is listed, and an array element by index", () => {
    expect(view([plain("/nested")])).toEqual({ "/nested": { a: 1, b: { c: "deep" } } });
    expect(view([plain("/tags")])).toEqual({ "/tags": ["x", "y"] });
    expect(view([plain("/tags/0")])).toEqual({ "/tags/0": "x" });
  });

  it("records the whole document for the root path", () => {
    expect(view([plain("")], { a: 1 })).toEqual({ "": { a: 1 } });
  });

  it("omits a listed path that is not present, rather than inventing a value", () => {
    expect(view([plain("/missing"), masked("/also/missing"), plain("/tags/9"), plain("/projectId/deeper")])).toEqual({});
  });

  it("unescapes ~1 and ~0, exactly", () => {
    expect(view([plain("/a~1b"), plain("/a~0b")])).toEqual({ "/a~1b": "slash", "/a~0b": "tilde" });
    expect(view([plain("/a/b")])).toEqual({});
    expect(view([plain("/a~b")])).toEqual({});
  });

  it("looks only at own properties: no prototype keys, no inherited values", () => {
    const inherited = Object.create({ secret: "inherited" }) as Record<string, unknown>;
    expect(view([plain("/secret"), plain("/__proto__"), plain("/constructor"), plain("/toString"), plain("/hasOwnProperty")], inherited)).toEqual({});
    expect(view([plain("/length")], ["a"])).toEqual({});
  });

  it("indexes arrays only by canonical non-negative integers", () => {
    const list = { l: ["a", "b", "c"] };
    expect(view([plain("/l/1")], list)).toEqual({ "/l/1": "b" });
    for (const path of ["/l/01", "/l/-1", "/l/1.0", "/l/1e0", "/l/ 1", "/l/length", "/l/", "/l/3"]) expect(view([plain(path)], list), path).toEqual({});
  });

  it("ignores a rule whose path is not a JSON pointer, and a rule that is not a rule", () => {
    expect(view([plain("projectId"), plain("projectId/x"), plain("/a~2"), plain("/a~"), { path: 5, mode: "plain" } as never, { path: "/projectId", mode: "loud" } as never, { path: "/projectId" } as never])).toEqual({});
    expect(view([plain("projectId"), plain("/projectId")])).toEqual({ "/projectId": "p1" });
  });

  it("is ordered by path, so the same rules always give the same record", () => {
    expect(Object.keys(projectParams(params, [plain("/tags/0"), plain("/projectId"), plain("/nested/a")]))).toEqual(["/nested/a", "/projectId", "/tags/0"]);
  });
});

describe("masked parameters", () => {
  it("record the marker, never the value, whatever its type", () => {
    expect(view([masked("/email"), masked("/nested"), masked("/tags"), masked("/nested/a")])).toEqual({ "/email": MASKED, "/nested": MASKED, "/tags": MASKED, "/nested/a": MASKED });
    expect(MASKED).toBe("[masked]");
    expect(JSON.stringify(projectParams(params, [masked("/email"), masked("/nested")]))).not.toMatch(/a@b|deep/);
  });

  it("are masked when ANY rule for the path says masked, in either order", () => {
    expect(view([plain("/email"), masked("/email")])).toEqual({ "/email": MASKED });
    expect(view([masked("/email"), plain("/email")])).toEqual({ "/email": MASKED });
  });

  it("mask the part of a plain subtree they sit beneath, so listing a container never exposes a masked field", () => {
    expect(view([plain("/nested"), masked("/nested/b/c")])).toEqual({ "/nested": { a: 1, b: { c: MASKED } }, "/nested/b/c": MASKED });
    expect(view([plain("/tags"), masked("/tags/0")])).toEqual({ "/tags": [MASKED, "y"], "/tags/0": MASKED });
    expect(view([plain(""), masked("/email"), masked("/nested/b")], params)["" ]).toMatchObject({ email: MASKED, nested: { a: 1, b: MASKED }, projectId: "p1" });
  });

  it("do not mask a sibling that merely shares a prefix", () => {
    expect(view([plain("/nested"), masked("/nested/a")])).toEqual({ "/nested": { a: MASKED, b: { c: "deep" } }, "/nested/a": MASKED });
    expect(view([plain("/tags"), masked("/tagsX")], { tags: ["x"], tagsX: "s" })).toEqual({ "/tags": ["x"], "/tagsX": MASKED });
  });

  it("mask by the escaped path for keys with a slash or a tilde", () => {
    expect(view([plain(""), masked("/a~1b"), masked("/a~0b")], params)[""]).toMatchObject({ "a/b": MASKED, "a~b": MASKED, projectId: "p1" });
  });
});

describe("the recorded value is scrubbed, bounded and contained", () => {
  it("redacts secret-shaped values even in a plain, listed field", () => {
    const out = view([plain("/note"), plain("/tags")], { note: "key sk-abcdefghijklmnopqrstuvwx here", tags: ["AKIAABCDEFGHIJKLMNOP"] });
    expect(out).toEqual({ "/note": `key ${REDACTED} here`, "/tags": [REDACTED] });
  });

  it("keeps newline, ANSI and JSON-breaking text inside one structured value (ATK-INJECT-04)", () => {
    const hostile = "ok\n\u001b[2J\u001b[31mFORGED\u001b[0m\r\n\"},{\"outcome\":\"ALLOWED\",\"type\":\"AI_ACTION_ALLOWED\"";
    const out = projectParams({ note: hostile, other: "x" }, [plain("/note")]);
    expect(Object.keys(out)).toEqual(["/note"]);
    expect(out["/note"]).toBe(hostile);
    const line = JSON.stringify({ paramsView: out });
    expect(line.includes("\n")).toBe(false);
    expect(Object.keys((JSON.parse(line) as { paramsView: object }).paramsView)).toEqual(["/note"]);
  });

  it("is plain data, deeply frozen, with no prototype", () => {
    const out = projectParams(params, [plain("/nested"), plain("/tags")]);
    expect(Object.isFrozen(out)).toBe(true);
    expect(Object.getPrototypeOf(out)).toBe(null);
    expect(Object.isFrozen(out["/nested"])).toBe(true);
    expect(Object.isFrozen(out["/tags"])).toBe(true);
  });

  it("never mutates the parameters it reads", () => {
    const input = Object.freeze({ nested: Object.freeze({ a: 1, b: Object.freeze({ c: "deep" }) }) });
    projectParams(input, [plain("/nested"), masked("/nested/b/c")]);
    expect(input.nested.b.c).toBe("deep");
  });

  it("does not throw on hostile parameters or rules, and records nothing unlisted", () => {
    const boom = { get nested(): never { throw new Error("CANARY"); }, ok: "fine" };
    expect(() => projectParams(boom, [plain("/ok"), plain("/nested")])).not.toThrow();
    const out = projectParams(boom, [plain("/ok"), plain("/nested")]);
    expect(JSON.stringify(out)).not.toContain("CANARY");
    expect(out["/ok"]).toBeUndefined(); // the read failed as a whole: an empty view, never a partial one
    expect(Object.keys(projectParams(params, { [Symbol.iterator]: () => { throw new Error("CANARY"); } } as never))).toEqual([]);
    expect(projectParams({ v: 10n } as never, [plain("/v")])["/v"]).toBe(UNSERIALIZABLE);
    expect(Object.keys(projectParams(undefined, [plain("/a")]))).toEqual([]);
    expect(Object.keys(projectParams(null, [plain("/a")]))).toEqual([]);
    expect(Object.keys(projectParams("text", [plain("/0")]))).toEqual([]);
  });
});
