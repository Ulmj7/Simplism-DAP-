import { describe, expect, it, vi } from "vitest";
import { wrapHook } from "@dap/security";
import { faulty, type FaultMode, FakeAuthenticationPort, FakePermissionChecker, FakeResourceAuthorizer, FakePageContextProvider, FakeConfirmationChannel, ctx, TENANT_A, ALICE } from "@dap/testkit";

describe("host hooks fail closed under testkit fault injection", () => {
  it("contains an injected hang under a deterministic timer", async () => {
    vi.useFakeTimers();
    try {
      const permissions = faulty(new FakePermissionChecker(), "hangs") as FakePermissionChecker;
      const pending = wrapHook(() => permissions.has(ctx(TENANT_A, ALICE), "p" as never), "boolean", {
        timer: { now: () => Date.now(), setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) },
      })();
      await vi.advanceTimersByTimeAsync(2000);
      expect(await pending).toEqual({ ok: false, reason: "dependency_failure" });
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it.each(["throws", "undefined", "wrong-type"] as FaultMode[])("contains %s from each host port", async (mode) => {
    const auth = faulty(new FakeAuthenticationPort(), mode) as FakeAuthenticationPort;
    const permissions = faulty(new FakePermissionChecker(), mode) as FakePermissionChecker;
    const resources = faulty(new FakeResourceAuthorizer(), mode) as FakeResourceAuthorizer;
    const pages = faulty(new FakePageContextProvider(), mode) as FakePageContextProvider;
    const channel = faulty(new FakeConfirmationChannel(), mode) as FakeConfirmationChannel;
    const policy = faulty({ isDisabled: async () => false }, mode) as { isDisabled(): Promise<boolean> };
    const calls = [
      () => wrapHook(() => auth.authenticate("cookie"), "authentication")(),
      () => wrapHook(() => permissions.has(ctx(TENANT_A, ALICE), "p" as never), "boolean")(),
      () => wrapHook(() => resources.resolve(ctx(TENANT_A, ALICE), { type: "document", id: "doc" }, "p" as never), "resource")(),
      () => wrapHook(() => channel.deliver(ctx(TENANT_A, ALICE), {} as never), "void")(),
      () => wrapHook(() => policy.isDisabled(), "tenantPolicy")(),
    ];
    for (const call of calls) expect((await call()).ok).toBe(false);
    const page = await wrapHook(() => pages.currentPage(ctx(TENANT_A, ALICE), {} as never), "page")();
    // faulty's fixed string is a well-shaped page id; page membership still narrows later.
    expect(page.ok).toBe(mode === "wrong-type");
    if (page.ok) expect(page.value).toBe("yes");
  });
});
