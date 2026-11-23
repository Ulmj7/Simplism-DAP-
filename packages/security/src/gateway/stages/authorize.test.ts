/**
 * T075 / T077. The user's own authority, live, sequential, fail-closed. Each guard has a case that fails without it;
 * host ports are fault-injected one by one; the three "resource is not for you" answers are indistinguishable to the planner.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineAction } from "@dap/contracts";
import type { ActionId, ActionRegistry, ExecutorId, PageId, PermissionId, PolicyDecision, ResolvedResource } from "@dap/contracts";
import { mintAuthorizationContext } from "@dap/contracts/mint";
import { createLimiter } from "../../limits/limiter.js";
import { DEFAULT_LIMIT_CONFIG } from "../../limits/limit-config.js";
import { InMemoryRateLimiter } from "../../state/memory/rate-limiter.js";
import { buildRegistry } from "../../registry/build-registry.js";
import { createPipeline } from "../pipeline.js";
import { allowedDecision } from "../decision.js";
import { createAuthorizeStage } from "./authorize.js";
import type { HookTimer } from "../hook-wrapper.js";
import type { PipelineRecord, PolicyStage } from "../pipeline.js";
import { toPlannerFeedback } from "../feedback.js";
import { context, input, run, stageMap } from "../fixtures.test-support.js";

const realLimiter = () => {
  const clock = { now: () => "2026-01-01T00:00:00Z" as never };
  return createLimiter({ rateLimiter: new InMemoryRateLimiter(clock), config: DEFAULT_LIMIT_CONFIG, clock });
};
const TENANT = "00000000-0000-4000-8000-000000000001";
const OTHER_TENANT = "00000000-0000-4000-8000-000000000002";
const NOW = "2026-01-01T00:00:00Z";
const define = (id: string, extra: Record<string, unknown> = {}) => defineAction({
  id: id as ActionId, version: 2, description: id, inputSchema: z.strictObject({ projectId: z.string().min(1).max(12).optional() }), risk: "SAFE", requiredPermission: "project:view" as PermissionId,
  allowedPages: "any", confirmation: { kind: "not-required" }, changesState: false, audit: { params: [] }, executorId: "exec" as ExecutorId, ...extra,
} as never);
const registry = buildRegistry([
  define("openProject", { resource: (params: { projectId: string }) => ({ type: "project", id: params.projectId }) }),
  define("listProjects"),
  define("editOnPage", { allowedPages: ["page.edit" as PageId, "page.admin" as PageId] }),
]);
const factsFor = (id: string, resource: unknown = null) => {
  const entry = registry.get(id)!;
  return { resolve: { id, version: entry.definition.version, risk: "SAFE", definitionHash: entry.definitionHash }, validate: { params: {}, paramsDigest: "a".repeat(64), resource } };
};
const PROJECT = { type: "project", id: "p1" };
const resolvedFor = (overrides: Record<string, unknown> = {}): ResolvedResource => ({ ref: PROJECT, tenantId: TENANT, displayName: "Project One", ...overrides }) as ResolvedResource;

class ManualTimer implements HookTimer {
  time = 0; private next = 0;
  readonly pending = new Map<number, { at: number; callback: () => void }>();
  now(): number { return this.time; }
  setTimeout(callback: () => void, ms: number): number { const id = this.next++; this.pending.set(id, { at: this.time + ms, callback }); return id; }
  clearTimeout(handle: unknown): void { this.pending.delete(handle as number); }
  advance(ms: number): void { this.time += ms; for (const [id, entry] of [...this.pending]) if (entry.at <= this.time) { this.pending.delete(id); entry.callback(); } }
}
type Answer = () => unknown;
interface Ports { omitHookTimeout?: boolean; clock?: Answer; has?: Answer; page?: Answer; resolve?: Answer; registry?: ActionRegistry; timer?: HookTimer; hookTimeoutMs?: number }

/** The stage with spy ports; `log` records every host call in order, `inFlight` proves they never overlap. */
function harness(ports: Ports = {}) {
  const log: string[] = [];
  const args: Record<string, unknown[]> = {};
  let active = 0; let overlapped = false;
  const spy = (name: string, answer: Answer) => (...received: unknown[]) => {
    log.push(name); args[name] = received;
    if (active > 0) overlapped = true;
    active++;
    const result = answer();
    return Promise.resolve(result).finally(() => { active--; });
  };
  const timer = ports.timer ?? new ManualTimer();
  const stage = createAuthorizeStage({ limiter: realLimiter(),
    registry: ports.registry ?? registry,
    permissions: { has: spy("has", ports.has ?? (() => true)) as never }, resources: { resolve: spy("resolve", ports.resolve ?? (() => resolvedFor())) as never },
    pages: { currentPage: spy("page", ports.page ?? (() => "page.edit")) as never }, clock: { now: spy("clock", ports.clock ?? (() => NOW)) as never },
  }, ports.omitHookTimeout ? { timer } : { timer, hookTimeoutMs: ports.hookTimeoutMs ?? 2000 });
  const budget = { remainingMs: () => 10_000 };
  const record = (facts: object, overrides: Partial<PipelineRecord> | Record<string, unknown> = {}) => ({ ...input(), run, context: context(), facts, budget, ...overrides }) as unknown as PipelineRecord;
  return { stage: stage as PolicyStage, log, args, record, timer: timer as ManualTimer, overlapped: () => overlapped };
}
const decisionOf = (result: unknown): PolicyDecision => { const r = result as { kind: string; decision: PolicyDecision }; if (r.kind !== "stop") throw new Error("expected a denial"); return r.decision; };
const deny = { stage: "authorize" };

describe("an authorized request", () => {
  it("continues with no resource when the action targets none, asking only the clock and the permission", async () => {
    const test = harness();
    expect(await test.stage(test.record(factsFor("listProjects")))).toEqual({ kind: "continue", data: { resource: null } });
    expect(test.log).toEqual(["clock", "has"]);
  });

  it("asks the permission checker with the minted context and the definition's permission, exactly", async () => {
    const test = harness();
    const request = test.record(factsFor("listProjects"));
    await test.stage(request);
    expect(test.args.has).toHaveLength(2);
    expect(test.args.has![0]).toBe(request.context);
    expect(test.args.has![1]).toBe("project:view");
  });

  it("resolves a targeted resource for this user and permission, and publishes only what a later stage needs", async () => {
    const test = harness();
    const request = test.record(factsFor("openProject", PROJECT));
    expect(await test.stage(request)).toEqual({ kind: "continue", data: { resource: { type: "project", id: "p1", displayName: "Project One" } } });
    expect(test.log).toEqual(["clock", "has", "resolve"]);
    expect(test.args.resolve![0]).toBe(request.context);
    expect(test.args.resolve![1]).toEqual(PROJECT);
    expect(Object.isFrozen(test.args.resolve![1])).toBe(true);
    expect(test.args.resolve![2]).toBe("project:view");
  });

  it("checks a restricted page only when the action is restricted, with the minted context and the run", async () => {
    const test = harness();
    const request = test.record(factsFor("editOnPage"));
    expect((await test.stage(request) as { kind: string }).kind).toBe("continue");
    expect(test.log).toEqual(["clock", "has", "page"]);
    expect(test.args.page![0]).toBe(request.context);
    expect(test.args.page![1]).toEqual(run);
    const any = harness();
    await any.stage(any.record(factsFor("listProjects")));
    expect(any.log).not.toContain("page");
  });

  it("runs its host calls strictly one after another, in the documented order", async () => {
    const test = harness({ page: () => "page.edit" });
    await test.stage(test.record({ ...factsFor("editOnPage", PROJECT) }));
    expect(test.log).toEqual(["clock", "has", "page", "resolve"]);
    expect(test.overlapped()).toBe(false);
  });
});

describe("the session, judged again now", () => {
  it.each([
    ["expired", { clock: () => "2026-01-01T01:00:01Z" }, "UNAUTHORIZED", "session_expired"], ["expiring this very instant", { clock: () => "2026-01-01T01:00:00Z" }, "UNAUTHORIZED", "session_expired"],
    ["not begun yet (authenticatedAt in the future)", { clock: () => "2025-12-31T23:59:59Z" }, "UNAUTHORIZED", "unauthenticated"],
  ])("%s", async (_name, ports, outcome, reason) => {
    const test = harness(ports as Ports);
    expect(decisionOf(await test.stage(test.record(factsFor("listProjects"))))).toMatchObject({ ...deny, outcome, reason });
    expect(test.log).toEqual(["clock"]); // nothing else is asked of the host for a dead session
  });

  it("accepts a session that began exactly now and one second before expiry", async () => {
    for (const clock of [() => NOW, () => "2026-01-01T00:59:59Z"]) {
      const test = harness({ clock });
      expect((await test.stage(test.record(factsFor("listProjects"))) as { kind: string }).kind).toBe("continue");
    }
  });

  it("re-derives the verdict from the context's own instants: validUntil before authenticatedAt is unauthenticated, not merely expired", async () => {
    const test = harness();
    const odd = mintAuthorizationContext({ userId: "alice", tenantId: TENANT, sessionId: "s", authenticatedAt: "2025-12-31T00:00:00Z", validUntil: "2025-12-30T00:00:00Z" });
    expect(decisionOf(await test.stage(test.record(factsFor("listProjects"), { context: odd })))).toMatchObject({ ...deny, outcome: "UNAUTHORIZED", reason: "unauthenticated" });
    expect(test.log).toEqual(["clock"]);
  });

  it("denies fail-closed when the clock is faulty, and asks nothing else", async () => {
    for (const clock of [() => { throw new Error("down"); }, () => undefined, () => 5, () => "garbage", () => Promise.reject(new Error("down"))]) {
      const test = harness({ clock });
      expect(decisionOf(await test.stage(test.record(factsFor("listProjects"))))).toMatchObject({ ...deny, outcome: "DENIED", reason: "dependency_failure" });
      expect(test.log).toEqual(["clock"]);
    }
  });
});

describe("permission: only the literal true allows", () => {
  it("a definite no is UNAUTHORIZED / permission_missing, and nothing later runs", async () => {
    const test = harness({ has: () => false });
    expect(decisionOf(await test.stage(test.record(factsFor("openProject", PROJECT))))).toMatchObject({ ...deny, outcome: "UNAUTHORIZED", reason: "permission_missing", attemptedAction: "openProject" });
    expect(test.log).toEqual(["clock", "has"]);
  });

  it.each([["undefined", undefined], ["null", null], ["0", 0], ["1", 1], ['"true"', "true"], ['"yes"', "yes"], ["an empty object", {}], ["an array holding true", [true]], ["an object that says true", { allowed: true }], ["a function", () => true], ["a boxed true", Object(true)]])(
    "%s is a denial, never an allow", async (_name, answer) => {
      const test = harness({ has: () => answer });
      const result = await test.stage(test.record(factsFor("openProject", PROJECT)));
      expect(decisionOf(result)).toMatchObject({ ...deny, outcome: "DENIED", reason: "dependency_failure" });
      expect(test.log).toEqual(["clock", "has"]);
    });

  it.each([["throws", () => { throw new Error("CANARY_SECRET"); }], ["rejects", () => Promise.reject(new Error("CANARY_SECRET"))], ["has a throwing getter", () => ({ get v(): never { throw new Error("CANARY_SECRET"); } })]])("a checker that %s denies without leaking", async (_name, has) => {
    const test = harness({ has });
    const decision = decisionOf(await test.stage(test.record(factsFor("listProjects"))));
    expect(decision).toMatchObject({ ...deny, outcome: "DENIED", reason: "dependency_failure" });
    expect(JSON.stringify(decision)).not.toContain("CANARY");
  });

  it("a checker that hangs denies at hookTimeoutMs and leaves no timer behind", async () => {
    const test = harness({ has: () => new Promise(() => {}), hookTimeoutMs: 50 });
    const pending = test.stage(test.record(factsFor("listProjects")));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    test.timer.advance(50);
    expect(decisionOf(await pending)).toMatchObject({ ...deny, outcome: "DENIED", reason: "dependency_failure" });
    expect(test.timer.pending.size).toBe(0);
  });
});

describe("page narrowing never grants", () => {
  it.each([["a different page", () => "page.view"], ["the same page in another case", () => "PAGE.EDIT"], ["a page with a suffix", () => "page.edit "], ["no current page (null)", () => null]])("%s is DENIED / context_not_allowed", async (_name, page) => {
    const test = harness({ page });
    expect(decisionOf(await test.stage(test.record(factsFor("editOnPage"))))).toMatchObject({ ...deny, outcome: "DENIED", reason: "context_not_allowed" });
    expect(test.log).toEqual(["clock", "has", "page"]);
  });

  it("accepts every listed page", async () => {
    for (const page of ["page.edit", "page.admin"]) {
      const test = harness({ page: () => page });
      expect((await test.stage(test.record(factsFor("editOnPage"))) as { kind: string }).kind).toBe("continue");
    }
  });

  it.each([["throws", () => { throw new Error("x"); }], ["rejects", () => Promise.reject(new Error("x"))], ["is undefined", () => undefined], ["is a number", () => 7], ["is an empty string", () => ""], ["is an object", () => ({ page: "page.edit" })]])(
    "a provider that %s is a dependency failure", async (_name, page) => {
      const test = harness({ page });
      expect(decisionOf(await test.stage(test.record(factsFor("editOnPage"))))).toMatchObject({ ...deny, outcome: "DENIED", reason: "dependency_failure" });
    });

  it("is not consulted when the permission is missing: a missing permission is never turned into a page question", async () => {
    const test = harness({ has: () => false });
    await test.stage(test.record(factsFor("editOnPage")));
    expect(test.log).toEqual(["clock", "has"]);
  });

  it("denies an action restricted to no page at all", async () => {
    const entry = registry.get("editOnPage")!;
    const none = { ...registry, get: () => ({ definition: { ...entry.definition, allowedPages: [] }, definitionHash: entry.definitionHash }) } as unknown as ActionRegistry;
    const test = harness({ registry: none, page: () => "page.edit" });
    expect(decisionOf(await test.stage(test.record(factsFor("editOnPage"))))).toMatchObject({ ...deny, outcome: "DENIED", reason: "context_not_allowed" });
  });
});

describe("resource access and tenant isolation (ATK-XTENANT)", () => {
  const targeted = async (ports: Ports) => { const test = harness(ports); const result = await test.stage(test.record(factsFor("openProject", PROJECT))); return { result, test }; };

  it("a resource the host will not resolve (not found, not permitted, another tenant's) is DENIED / resource_not_available", async () => {
    const { result } = await targeted({ resolve: () => null });
    expect(decisionOf(result)).toMatchObject({ ...deny, outcome: "DENIED", reason: "resource_not_available", attemptedAction: "openProject" });
  });

  it("a resolved resource of another tenant is DENIED / tenant_mismatch", async () => {
    const { result } = await targeted({ resolve: () => resolvedFor({ tenantId: OTHER_TENANT }) });
    expect(decisionOf(result)).toMatchObject({ ...deny, outcome: "DENIED", reason: "tenant_mismatch" });
  });

  it("the tenant is compared exactly: another spelling of the same UUID is a different tenant", async () => {
    const tenant = "abcdef00-0000-4000-8000-00000000000a";
    const mine = mintAuthorizationContext({ userId: "alice", tenantId: tenant, sessionId: "s", authenticatedAt: "2025-12-31T00:00:00Z", validUntil: "2026-01-02T00:00:00Z" });
    const asked = async (tenantId: string) => { const test = harness({ resolve: () => resolvedFor({ tenantId }) }); return decisionOf(await test.stage(test.record(factsFor("openProject", PROJECT), { context: mine }))); };
    expect(await asked(tenant.toUpperCase())).toMatchObject({ outcome: "DENIED", reason: "tenant_mismatch" });
    expect(await asked(tenant.replace("00a", "00b"))).toMatchObject({ outcome: "DENIED", reason: "tenant_mismatch" });
    const same = harness({ resolve: () => resolvedFor({ tenantId: tenant }) });
    expect(await same.stage(same.record(factsFor("openProject", PROJECT), { context: mine }))).toMatchObject({ kind: "continue" });
  });

  it("a host that answers about a different resource than the one asked is DENIED / resource_not_available", async () => {
    for (const ref of [{ type: "project", id: "p2" }, { type: "folder", id: "p1" }]) {
      const { result } = await targeted({ resolve: () => resolvedFor({ ref }) });
      expect(decisionOf(result)).toMatchObject({ outcome: "DENIED", reason: "resource_not_available" });
    }
  });

  it("other-tenant, nonexistent and same-tenant-unauthorized produce byte-identical planner feedback", async () => {
    const answers = [() => resolvedFor({ tenantId: OTHER_TENANT }), () => null, () => resolvedFor({ ref: { type: "project", id: "other" } })];
    const feedback = await Promise.all(answers.map(async (resolve) => JSON.stringify(toPlannerFeedback(decisionOf((await targeted({ resolve })).result)))));
    expect(new Set(feedback).size).toBe(1);
    expect(feedback[0]).toBe('{"outcome":"DENIED","category":"not_available"}');
  });

  it("the planner feedback for a resource denial differs from a host outage, so an outage cannot be mistaken for a 'no'", async () => {
    const no = toPlannerFeedback(decisionOf((await targeted({ resolve: () => null })).result));
    const down = toPlannerFeedback(decisionOf((await targeted({ resolve: () => { throw new Error("x"); } })).result));
    expect(no).not.toEqual(down);
    expect(down).toEqual({ outcome: "DENIED", category: "try_later" });
  });

  it("does not look up a resource when the permission is missing or the page is wrong", async () => {
    const noPermission = harness({ has: () => false });
    await noPermission.stage(noPermission.record(factsFor("openProject", PROJECT)));
    expect(noPermission.log).not.toContain("resolve");
  });

  it.each([["throws", () => { throw new Error("CANARY_SECRET"); }], ["rejects", () => Promise.reject(new Error("CANARY_SECRET"))], ["answers undefined", () => undefined], ["answers a string", () => "project p1"], ["answers a number", () => 1],
    ["answers without a tenant", () => ({ ref: PROJECT, displayName: "x" })], ["answers with an extra field", () => ({ ...resolvedFor(), secret: "CANARY_SECRET" })], ["answers a non-UUID tenant", () => resolvedFor({ tenantId: "acme" })],
    ["answers an empty display name", () => resolvedFor({ displayName: "" })], ["answers a malformed ref", () => resolvedFor({ ref: { type: "project" } })], ["has a throwing getter", () => ({ get ref(): never { throw new Error("CANARY_SECRET"); } })]])(
    "a resolver that %s is a dependency failure and never leaks", async (_name, resolve) => {
      const { result } = await targeted({ resolve });
      expect(decisionOf(result)).toMatchObject({ ...deny, outcome: "DENIED", reason: "dependency_failure" });
      expect(JSON.stringify(result)).not.toContain("CANARY");
    });

  it("a resolver that hangs denies at hookTimeoutMs", async () => {
    const test = harness({ resolve: () => new Promise(() => {}), hookTimeoutMs: 40 });
    const pending = test.stage(test.record(factsFor("openProject", PROJECT)));
    for (let i = 0; i < 6; i++) await Promise.resolve();
    test.timer.advance(40);
    expect(decisionOf(await pending)).toMatchObject({ outcome: "DENIED", reason: "dependency_failure" });
  });
});

describe("what the stage refuses to work from", () => {
  const good = () => factsFor("openProject", PROJECT);
  const refuse = async (test: ReturnType<typeof harness>, request: PipelineRecord) => {
    expect(decisionOf(await test.stage(request))).toMatchObject({ ...deny, outcome: "DENIED", reason: "dependency_failure" });
    expect(test.log).toEqual([]);
  };

  it.each([
    ["no resolve facts", { validate: good().validate }], ["no validate facts", { resolve: good().resolve }], ["resolve facts that are an array", { ...good(), resolve: [] }], ["validate facts that are null", { ...good(), validate: null }],
    ["a resource that is not an object", { ...good(), validate: { ...good().validate, resource: "project/p1" } }], ["a resource that is an array", { ...good(), validate: { ...good().validate, resource: ["project", "p1"] } }],
    ["a resource with an empty id", { ...good(), validate: { ...good().validate, resource: { type: "project", id: "" } } }], ["a resource without a type", { ...good(), validate: { ...good().validate, resource: { id: "p1" } } }],
    ["a resource with a numeric id", { ...good(), validate: { ...good().validate, resource: { type: "project", id: 1 } } }],
    ["resolve facts for another version", { ...good(), resolve: { ...good().resolve, version: 9 } }], ["resolve facts for another definition hash", { ...good(), resolve: { ...good().resolve, definitionHash: "b".repeat(64) } }],
    ["an action the registry no longer holds", { ...good(), resolve: { ...good().resolve, id: "vanished" } }],
  ])("%s", async (_name, facts) => {
    const test = harness();
    await refuse(test, test.record(facts));
  });

  it("names the attempted action in a denial only when resolve published one", async () => {
    const test = harness();
    const without = decisionOf(await test.stage(test.record({ validate: good().validate })));
    expect(Object.hasOwn(without, "attemptedAction")).toBe(false);
    const withName = decisionOf(await test.stage(test.record({ ...good(), resolve: { ...good().resolve, version: 9 } })));
    expect(withName).toMatchObject({ attemptedAction: "openProject" });
    const notText = decisionOf(await test.stage(test.record({ ...good(), resolve: { ...good().resolve, id: 7 } })));
    expect(Object.hasOwn(notText, "attemptedAction")).toBe(false);
  });

  it("a context that is not minted (a plain look-alike) and a request without one", async () => {
    const test = harness();
    await refuse(test, test.record(good(), { context: { ...context() } }));
    await refuse(test, test.record(good(), { context: null }));
  });

  it("a request without a budget", async () => {
    const test = harness();
    await refuse(test, test.record(good(), { budget: undefined }));
    await refuse(test, test.record(good(), { budget: {} }));
  });

  it("a registry whose definition has no usable permission or page list", async () => {
    const entry = registry.get("openProject")!;
    const broken = (patch: object) => ({ ...registry, get: () => ({ definition: { ...entry.definition, ...patch }, definitionHash: entry.definitionHash }) }) as unknown as ActionRegistry;
    for (const patch of [{ requiredPermission: "" }, { requiredPermission: 5 }, { requiredPermission: undefined }, { allowedPages: "some" }, { allowedPages: undefined }, { allowedPages: ["ok", 5] }, { allowedPages: ["ok", ""] }, { allowedPages: {} }]) {
      const test = harness({ registry: broken(patch) });
      await refuse(test, test.record(good()));
    }
  });

  it("reads the registry once per request and each definition field once", async () => {
    const entry = registry.get("openProject")!;
    let gets = 0; const reads = { requiredPermission: 0, allowedPages: 0, risk: 0, changesState: 0 };
    const counting = { ...registry, get: () => { gets++; return { definitionHash: entry.definitionHash, definition: { id: entry.definition.id, version: entry.definition.version, get changesState() { reads.changesState++; return false; }, get risk() { reads.risk++; return "SAFE"; }, get requiredPermission() { reads.requiredPermission++; return "project:view"; }, get allowedPages() { reads.allowedPages++; return "any"; } } }; } } as unknown as ActionRegistry;
    const test = harness({ registry: counting });
    expect((await test.stage(test.record(good())) as { kind: string }).kind).toBe("continue");
    expect({ gets, ...reads }).toEqual({ gets: 1, requiredPermission: 1, allowedPages: 1, risk: 1, changesState: 1 });
  });
});

describe("the proposal budget bounds every host call", () => {
  /** A request whose budget is read off the same manual timer the stage uses. */
  const withBudget = (test: ReturnType<typeof harness>, total: number) => test.record(factsFor("openProject", PROJECT), { budget: { remainingMs: () => total - test.timer.time } });

  it.each([0, 0.5, -5, Number.NaN, Number.NEGATIVE_INFINITY])("a remaining budget of %s denies before any host call", async (left) => {
    const test = harness();
    const request = test.record(factsFor("openProject", PROJECT), { budget: { remainingMs: () => left } });
    expect(decisionOf(await test.stage(request))).toMatchObject({ ...deny, outcome: "DENIED", reason: "dependency_failure" });
    expect(test.log).toEqual([]);
  });

  it("gives a host call min(hookTimeoutMs, what is left): a hung checker times out when the BUDGET runs out", async () => {
    const test = harness({ has: () => new Promise(() => {}), hookTimeoutMs: 2000 });
    const pending = test.stage(withBudget(test, 300));
    for (let i = 0; i < 6; i++) await Promise.resolve();
    test.timer.advance(299);
    for (let i = 0; i < 3; i++) await Promise.resolve();
    expect(test.timer.pending.size).toBe(1); // still waiting at 299
    test.timer.advance(1);
    expect(decisionOf(await pending)).toMatchObject({ outcome: "DENIED", reason: "dependency_failure" });
  });

  it("never gives a call more than hookTimeoutMs even when much budget is left", async () => {
    const test = harness({ has: () => new Promise(() => {}), hookTimeoutMs: 100 });
    const pending = test.stage(withBudget(test, 60_000));
    for (let i = 0; i < 6; i++) await Promise.resolve();
    test.timer.advance(99);
    for (let i = 0; i < 3; i++) await Promise.resolve();
    expect(test.timer.pending.size).toBe(1);
    test.timer.advance(1);
    expect(decisionOf(await pending)).toMatchObject({ outcome: "DENIED", reason: "dependency_failure" });
  });

  it("defaults hookTimeoutMs to 2000 when none is configured", async () => {
    const test = harness({ has: () => new Promise(() => {}), omitHookTimeout: true });
    const pending = test.stage(withBudget(test, 60_000));
    for (let i = 0; i < 8; i++) await Promise.resolve();
    const [only] = [...test.timer.pending.values()];
    expect(only!.at).toBe(2000);
    test.timer.advance(2000);
    expect(decisionOf(await pending)).toMatchObject({ outcome: "DENIED", reason: "dependency_failure" });
  });

  it("handles a fractional remaining budget by rounding DOWN, never by throwing", async () => {
    const test = harness({ has: () => new Promise(() => {}) });
    const pending = test.stage(test.record(factsFor("listProjects"), { budget: { remainingMs: () => 2.9 } }));
    for (let i = 0; i < 8; i++) await Promise.resolve();
    const [only] = [...test.timer.pending.values()];
    expect(only!.at).toBe(2);
    test.timer.advance(2);
    expect(decisionOf(await pending)).toMatchObject({ outcome: "DENIED", reason: "dependency_failure" });
  });

  it("recomputes what is left before EACH call: time spent by an earlier call shortens the next", async () => {
    const test = harness({ has: () => { test.timer.time += 700; return true; }, resolve: () => new Promise(() => {}), hookTimeoutMs: 1000 }); // the permission check takes 700 ms of a 1000 ms budget
    const pending = test.stage(withBudget(test, 1000));
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(test.timer.pending.size).toBe(1);
    const [only] = [...test.timer.pending.values()];
    expect(only!.at - test.timer.time).toBe(300); // the resolver may have only the 300 ms that remain, not 1000
    test.timer.advance(300);
    expect(decisionOf(await pending)).toMatchObject({ outcome: "DENIED", reason: "dependency_failure" });
  });

  it("denies when earlier calls used the whole budget, before the next call is made", async () => {
    const test = harness({ has: () => { test.timer.time += 1000; return true; } });
    const decision = decisionOf(await test.stage(withBudget(test, 1000)));
    expect(decision).toMatchObject({ outcome: "DENIED", reason: "dependency_failure" });
    expect(test.log).toEqual(["clock", "has"]); // no resolve call
  });
});

describe("authorize inside the real runner", () => {
  const spent = (timer: ManualTimer, ms: number, answer: unknown) => () => { timer.time += ms; return answer; };
  function pipelineWith(ports: Ports, options: { hookTimeoutMs: number; proposalBudgetMs: number }) {
    const timer = (ports.timer ?? new ManualTimer()) as ManualTimer;
    const test = harness({ ...ports, timer, hookTimeoutMs: options.hookTimeoutMs });
    const stages = stageMap((request) => ({ kind: "stop", decision: allowedDecision({ decisionId: request.decisionId, requestId: request.requestId, actionId: "editOnPage" as never, risk: "SAFE", paramsDigest: "a".repeat(64) as never }) }));
    stages.resolve = () => ({ kind: "continue", data: factsFor("editOnPage").resolve });
    stages.validate = () => ({ kind: "continue", data: factsFor("editOnPage", PROJECT).validate as never });
    stages.authorize = test.stage;
    return { timer, test, run: () => createPipeline(stages, { timer, hookTimeoutMs: options.hookTimeoutMs, proposalBudgetMs: options.proposalBudgetMs }).run(input()) };
  }

  it("lets four sequential host calls take longer in total than hookTimeoutMs, each within it: the stage's deadline is the proposal's, not a single hook's", async () => {
    const timer = new ManualTimer();
    const setup = pipelineWith({ timer, clock: spent(timer, 1500, NOW), has: spent(timer, 1500, true), page: spent(timer, 1500, "page.edit"), resolve: spent(timer, 1500, resolvedFor()) }, { hookTimeoutMs: 2000, proposalBudgetMs: 10_000 });
    expect(await setup.run()).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: "execute" }); // 6000 ms in total, past hookTimeoutMs, inside the budget
    expect(setup.test.log).toEqual(["clock", "has", "page", "resolve"]);
  });

  it("stops a chain of calls when the proposal budget runs out between two of them, without asking the next host", async () => {
    const timer = new ManualTimer();
    const setup = pipelineWith({ timer, clock: spent(timer, 1500, NOW), has: spent(timer, 1500, true), page: spent(timer, 1500, "page.edit"), resolve: spent(timer, 1500, resolvedFor()) }, { hookTimeoutMs: 2000, proposalBudgetMs: 4000 });
    expect(await setup.run()).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: "authorize" });
    expect(setup.test.log).toEqual(["clock", "has", "page"]); // 4500 > 4000: the resolver is never asked
  });

  it("a hanging host is cut off by the proposal budget when that is the shorter limit", async () => {
    const timer = new ManualTimer();
    const setup = pipelineWith({ timer, has: () => new Promise(() => {}) }, { hookTimeoutMs: 2000, proposalBudgetMs: 300 });
    const pending = setup.run();
    for (let i = 0; i < 30; i++) await Promise.resolve();
    timer.advance(299); for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(timer.pending.size).toBe(2); // the stage's deadline and the call's, both at the budget
    timer.advance(1);
    expect(await pending).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: "authorize" });
    expect(timer.pending.size).toBe(0);
  });
});

describe("host objects keep their own receiver", () => {
  it("calls the registry and every port as methods of the host's object", async () => {
    const receivers: Record<string, unknown> = {};
    const entry = registry.get("openProject")!;
    class Registry { get(id: string) { receivers.registry = this; return registry.get(id); } list() { return []; } isReservedForbidden() { return false; } readonly fingerprint = registry.fingerprint; }
    class Permissions { async has() { receivers.permissions = this; return true; } }
    class Resources { async resolve() { receivers.resources = this; return resolvedFor(); } }
    class Pages { async currentPage() { receivers.pages = this; return "page.edit"; } }
    class Clock { now() { receivers.clock = this; return NOW; } }
    const [host, permissions, resources, pages, clock] = [new Registry(), new Permissions(), new Resources(), new Pages(), new Clock()];
    const stage = createAuthorizeStage({ limiter: realLimiter(), registry: host as never, permissions: permissions as never, resources: resources as never, pages: pages as never, clock: clock as never }, {});
    const facts = { resolve: { id: "openProject", version: entry.definition.version, risk: "SAFE", definitionHash: entry.definitionHash }, validate: { params: {}, paramsDigest: "a".repeat(64), resource: PROJECT } };
    const result = await stage({ ...input(), run, context: context(), facts, budget: { remainingMs: () => 10_000 } } as unknown as PipelineRecord);
    expect(result).toMatchObject({ kind: "continue" });
    expect(receivers.registry).toBe(host);
    expect(receivers.permissions).toBe(permissions);
    expect(receivers.resources).toBe(resources);
    expect(receivers.clock).toBe(clock);
  });

  it("calls the page provider as a method of the host's object", async () => {
    const receivers: unknown[] = [];
    const entry = registry.get("editOnPage")!;
    const pages = { async currentPage(this: unknown) { receivers.push(this); return "page.edit"; } };
    const stage = createAuthorizeStage({ limiter: realLimiter(), registry, permissions: { has: async () => true }, resources: { resolve: async () => null }, pages: pages as never, clock: { now: () => NOW as never } }, {});
    const facts = { resolve: { id: "editOnPage", version: entry.definition.version, risk: "SAFE", definitionHash: entry.definitionHash }, validate: { params: {}, paramsDigest: "a".repeat(64), resource: null } };
    expect(await stage({ ...input(), run, context: context(), facts, budget: { remainingMs: () => 10_000 } } as unknown as PipelineRecord)).toMatchObject({ kind: "continue" });
    expect(receivers).toEqual([pages]);
    expect(receivers[0]).toBe(pages);
  });
});
