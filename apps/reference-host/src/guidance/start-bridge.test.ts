import { describe, expect, it } from "vitest";
import type { RawToolCall } from "@dap/ai";
import type { AiSession } from "../compose.js";
import { submitWalkthroughStart } from "./start-bridge.js";

const SECRET = "sk-live-SECRET-FEEDBACK";
function fakeSession(answer: (call: RawToolCall) => unknown) {
  const calls: RawToolCall[] = [];
  const session: AiSession = { submit: (async (call: RawToolCall) => { calls.push(call); return answer(call); }) as never };
  return { session, calls };
}
const feedback = (outcome: string, category: string, extra: Record<string, unknown> = {}) => ({ outcome, category, ...extra });

describe("submitWalkthroughStart: the proposal that goes to the Gateway", () => {
  it("submits exactly one startWalkthrough envelope { action, params: { walkthroughId } } as raw text, with a provider call id the Gateway accepts", async () => {
    const { session, calls } = fakeSession(() => feedback("ALLOWED", "ok"));
    await submitWalkthroughStart(session, "profileUpdate");
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0]!.arguments)).toEqual({ action: "startWalkthrough", params: { walkthroughId: "profileUpdate" } });
    expect(Object.keys(JSON.parse(calls[0]!.arguments)).sort()).toEqual(["action", "params"]);
    expect(calls[0]!.providerCallId).toMatch(/^[\x21-\x7e]{1,256}$/);
    expect(Object.keys(calls[0]!).sort()).toEqual(["arguments", "providerCallId"]);
  });
  it("every submission has a fresh call id (so the Gateway's replay guard never sees a repeat)", async () => {
    const { session, calls } = fakeSession(() => feedback("ALLOWED", "ok"));
    await submitWalkthroughStart(session, "profileUpdate");
    await submitWalkthroughStart(session, "profileUpdate");
    expect(calls[0]!.providerCallId).not.toBe(calls[1]!.providerCallId);
  });
  it.each([undefined, null, 5, {}, "", " profileUpdate", "profile Update", "a/b", "__proto__", "x".repeat(65), "profileUpdate\n"])("an id that is not a well-formed walkthrough id (%j) is refused WITHOUT any submission", async (id) => {
    const { session, calls } = fakeSession(() => feedback("ALLOWED", "ok"));
    const result = await submitWalkthroughStart(session, id as never);
    expect(result).toMatchObject({ kind: "unsupported" });
    expect(calls).toHaveLength(0);
  });
});

describe("submitWalkthroughStart: the Gateway feedback becomes a closed result", () => {
  it("ALLOWED/ok -> the walkthrough is accepted", async () => {
    const result = await submitWalkthroughStart(fakeSession(() => feedback("ALLOWED", "ok")).session, "profileUpdate");
    expect(result).toEqual({ kind: "walkthrough", walkthroughId: "profileUpdate" });
    expect(Object.isFrozen(result)).toBe(true);
  });
  it.each([
    ["UNAUTHORIZED", "not_available"], ["FORBIDDEN_POLICY", "not_available"], ["DENIED", "not_available"],
  ])("%s/%s -> unsupported(not_permitted)", async (outcome, category) => {
    expect(await submitWalkthroughStart(fakeSession(() => feedback(outcome, category)).session, "profileUpdate")).toMatchObject({ kind: "unsupported", reason: "not_permitted" });
  });
  it.each([
    ["DENIED", "try_later"], ["ALLOWED", "try_later"], ["REQUIRES_CONFIRMATION", "needs_user_confirmation"], ["INVALID_PARAMETERS", "invalid_input"], ["INVALID_ACTION", "not_available"],
    ["WHATEVER", "ok"], ["ALLOWED", "not_available"], ["ALLOWED", undefined],
  ])("%s/%s -> unsupported(unavailable): in particular ALLOWED with try_later means execution failed or was not confirmed", async (outcome, category) => {
    expect(await submitWalkthroughStart(fakeSession(() => feedback(outcome, category as string)).session, "profileUpdate")).toMatchObject({ kind: "unsupported", reason: "unavailable" });
  });
  it.each([null, undefined, "ALLOWED", 5, [], {}])("a malformed feedback (%j) -> unavailable", async (answer) => {
    expect(await submitWalkthroughStart(fakeSession(() => answer).session, "profileUpdate")).toMatchObject({ kind: "unsupported", reason: "unavailable" });
  });
  it("a submit that throws or rejects -> unavailable, and no error text, feedback issue or secret is in the result", async () => {
    const throwing: AiSession = { submit: (() => { throw new Error(SECRET); }) as never };
    const rejecting: AiSession = { submit: (() => Promise.reject(new Error(SECRET))) as never };
    for (const session of [throwing, rejecting]) {
      const result = await submitWalkthroughStart(session, "profileUpdate");
      expect(result).toMatchObject({ kind: "unsupported", reason: "unavailable" });
      expect(JSON.stringify(result)).not.toContain("SECRET");
    }
  });
  it("raw feedback (issues, extra fields) never reaches the result", async () => {
    const result = await submitWalkthroughStart(fakeSession(() => feedback("INVALID_PARAMETERS", "invalid_input", { issues: [{ path: "/walkthroughId", code: "format" }], note: SECRET })).session, "profileUpdate");
    expect(JSON.stringify(result)).not.toMatch(/SECRET|issues|walkthroughId|format/);
  });
  it.each([
    Object.assign(() => undefined, { outcome: "ALLOWED", category: "ok" }),
    Object.assign([], { outcome: "ALLOWED", category: "ok" }),
  ])("non-record feedback cannot claim success", async (answer) => {
    expect(await submitWalkthroughStart(fakeSession(() => answer).session, "profileUpdate")).toMatchObject({ reason: "unavailable" });
  });
  it("a feedback with a throwing getter -> unavailable", async () => {
    const hostile = { get outcome(): string { throw new Error(SECRET); }, category: "ok" };
    expect(await submitWalkthroughStart(fakeSession(() => hostile).session, "profileUpdate")).toMatchObject({ reason: "unavailable" });
  });
});
