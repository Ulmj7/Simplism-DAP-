import { describe, expect, it } from "vitest";
import { toProposalCall, type PlannerPort } from "@dap/ai";
import { HostilePlanner } from "./hostile-planner.js";

describe("T122 scripted hostile planner", () => {
  it("emits script order, ignores feedback, and remains exhausted", async () => {
    const planner: PlannerPort = new HostilePlanner([{ callId: "a", raw: "bad json" }, { callId: "b", raw: "{}" }]);
    expect(await planner.plan([])).toEqual({ providerCallId: "a", arguments: "bad json" });
    expect(await planner.plan([{ outcome: "ALLOWED", category: "ok" }])).toEqual({ providerCallId: "b", arguments: "{}" });
    expect(await planner.plan([])).toBeNull(); expect(await planner.plan([])).toBeNull();
  });
  it.each(["\ud800", "x\u0000y", "\ufeff{}", "x".repeat(1_000_000), '{"a":1,"a":2}', '{"__proto__":{}}'])("preserves hostile raw code units (length %i)", async (raw) => {
    const planner = new HostilePlanner([toProposalCall("id", raw)]);
    const emitted = await planner.plan([]);
    expect(emitted).not.toBeNull();
    expect(Object.isFrozen(emitted)).toBe(true);
    expect(toProposalCall("trusted-id", emitted!.arguments)).toEqual({ callId: "trusted-id", raw });
    expect(emitted!.arguments.length).toBe(raw.length);
  });
  it("snapshots script metadata, freezes exposed values and gives independent cursors", async () => {
    const input = [{ callId: "first", raw: "original" }];
    const first = new HostilePlanner(input); const second = new HostilePlanner(input);
    input[0]!.raw = "changed"; input[0]!.callId = "changed-id"; input.length = 0;
    expect(Object.isFrozen(first.script)).toBe(true);
    expect(Object.isFrozen(first.script[0])).toBe(true);
    expect(await first.plan([])).toEqual(await second.plan([]));
    expect(first.script[0]?.raw).toBe("original");
  });
  it("allocates concurrent plan calls deterministically and rejects non-text scripts", async () => {
    const planner = new HostilePlanner([{ callId: "a", raw: "a" }, { callId: "b", raw: "b" }]);
    expect(await Promise.all([planner.plan([]), planner.plan([]), planner.plan([])])).toEqual([{ providerCallId: "a", arguments: "a" }, { providerCallId: "b", arguments: "b" }, null]);
    expect(() => new HostilePlanner([{ callId: "a", raw: {} }])).toThrow(TypeError);
    expect(() => new HostilePlanner([{ callId: 1, raw: "{}" }] as never)).toThrow(TypeError);
  });
});
