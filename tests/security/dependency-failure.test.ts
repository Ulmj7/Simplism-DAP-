import { describe, expect, it, vi } from "vitest";
import { dependencyFailureScenarios, confirmationChannelFailure, ALICE, withGateway } from "@dap/testkit";
import type { WorldPort, WorldUser } from "@dap/testkit";

const A_ALICE: WorldUser = { tenant: "A", user: ALICE };

// REQUIRED, representative (T071): the key trusted ports fail closed through the REAL Gateway. throws / undefined / wrong-type for every host port is in
// test-world.gateway.test.ts ("a faulted port denies"); the limiter and the execution cap in rate-replay.gateway.test.ts and execution-cap.test.ts; a
// failing or hanging audit store in review-fixes.test.ts and integration/audit-postgres.test.ts; page faults in review-fixes.test.ts. The only mode those
// leave to the host ports is a HANG, which needs a fake timer (never elapsed time), so it is proven here.
describe("a trusted port that never answers is bounded, and nothing executes (real Gateway, fake timers)", () => {
  it.each(["permissions", "resources", "replay", "tenantPolicy", "audit"] as const satisfies readonly WorldPort[])("%s hangs: generic try-later, executor at zero, no allow-event, and service returns once the fault is cleared", async (port) => {
    vi.useFakeTimers();
    try {
      const world = withGateway();
      const alice = await world.submitterFor(A_ALICE);
      world.injectFault(port, "hangs");
      const pending = alice.submit(world.proposal(port === "resources" ? "testMediumDraft" : "testSafeEcho"));
      await vi.advanceTimersByTimeAsync(10_000);
      const answer = await pending;
      expect(["DENIED", "UNAUTHORIZED"], port).toContain(answer.outcome);
      expect(answer.outcome === "DENIED" ? answer.category : "try_later", port).toBe("try_later");
      expect(world.executorCalls(), port).toBe(0);
      expect(world.events().some((event) => event.type === "AI_ACTION_ALLOWED" || event.type === "AI_ACTION_EXECUTED"), port).toBe(false);
      world.clearFault(port);
      expect((await alice.submit(world.proposal("testSafeEcho"))).outcome, `${port} recovers`).toBe("ALLOWED");
      expect(world.executorCalls()).toBe(1);
    } finally { vi.useRealTimers(); }
  });
});

// The exhaustive 36-case matrix (9 ports x 4 faults, one fresh fixture each) is FUTURE work (T123, Constitution 2.0.0): it stays as todo and does not gate Feature 001.
describe("ATK-DEP exhaustive dependency matrix (FUTURE, T123)", () => {
  for (const scenario of dependencyFailureScenarios) {
    it.todo(`${scenario.id} (FUTURE, T123): exhaustive matrix row, one fresh fixture per port and fault; representative real-Gateway failures are asserted above and in the files named at the top`);
  }
  for (const mode of confirmationChannelFailure.modes) {
    it.todo(`${confirmationChannelFailure.id}-${mode} (OPTIONAL, T096): needs the confirmation service, which Feature 001 M1 does not build`);
  }
});
