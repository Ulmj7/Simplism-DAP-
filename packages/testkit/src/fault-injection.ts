/** Fault wrappers never probe the healthy implementation or infer async behavior from names. */
import { portMembers } from "./snapshot.js";

export const FAULT_CANARY = "TESTKIT_FAULT_CANARY";
export type FaultMode = "throws" | "hangs" | "undefined" | "wrong-type";

/**
 * Wrap every port method, including inherited and symbol methods. Wrong-type always returns
 * the same invalid string synchronously; awaiting it also produces the invalid string.
 */
export function faulty(port: object, mode: FaultMode): object {
  if (!["throws", "hangs", "undefined", "wrong-type"].includes(mode)) throw new RangeError("faulty: unknown mode");
  const wrapped = {};
  for (const [name, value] of portMembers(port)) {
    if (typeof value !== "function") continue;
    const fault = (): unknown => {
      switch (mode) {
        case "throws": throw new Error(`${FAULT_CANARY}: ${String(name)}()`);
        case "hangs": return new Promise<never>(() => {});
        case "undefined": return undefined;
        case "wrong-type": return "yes";
      }
    };
    Object.defineProperty(wrapped, name, { value: fault, enumerable: true });
  }
  return Object.freeze(wrapped);
}
