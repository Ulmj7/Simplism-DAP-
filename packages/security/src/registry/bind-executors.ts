import type { ActionExecutor, ActionRegistry, ExecutorId, ExecutorTable, RegistrationIssue } from "@dap/contracts";
import { RegistrationError } from "./registration-error.js";
import { Snapshot } from "./snapshot.js";

export function bindExecutors(registry: ActionRegistry, executors: readonly ActionExecutor[]): ExecutorTable {
  const issues: RegistrationIssue[] = [];
  const implementations = new Map<ExecutorId, ActionExecutor>();
  const reader = new Snapshot();
  const length = reader.read(executors, "length");
  if (!Array.isArray(executors) || typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
    throw new RegistrationError([{ actionId: "<executors>", rule: "R10", detail: "executors must be an array" }]);
  }
  for (let index = 0; index < length; index += 1) {
    let id: unknown;
    try {
      const source = reader.read(executors, String(index));
      if (source === null || typeof source !== "object") throw new TypeError();
      id = reader.read(source, "id");
      const execute = reader.read(source, "execute");
      if (typeof id !== "string" || id.trim().length === 0 || typeof execute !== "function") throw new TypeError();
      if (implementations.has(id as ExecutorId)) {
        issues.push({ actionId: id, rule: "R10", detail: "duplicate executor id" });
      } else {
        // Freeze the contract fields without ever reading the mutable input executor again.
        implementations.set(id as ExecutorId, Object.freeze({ id: id as ExecutorId, execute: execute as ActionExecutor["execute"] }));
      }
    } catch { issues.push({ actionId: typeof id === "string" ? id : `<executor:${index}>`, rule: "R10", detail: "executor id and execute function are required" }); }
  }
  const used = new Set<ExecutorId>();
  for (const { definition } of registry.list()) {
    if (definition.risk === "FORBIDDEN") {
      if (implementations.has(definition.executorId)) issues.push({ actionId: definition.id, rule: "R7", detail: "FORBIDDEN definitions cannot have an executor" });
    } else {
      if (!implementations.has(definition.executorId)) issues.push({ actionId: definition.id, rule: "R10", detail: "no executor is bound" });
      used.add(definition.executorId);
    }
  }
  for (const id of implementations.keys()) {
    if (!used.has(id)) issues.push({ actionId: id, rule: "R10", detail: "executor is unused" });
  }
  if (issues.length > 0) throw new RegistrationError(issues);
  return Object.freeze({ executorFor: (id: ExecutorId) => implementations.get(id) });
}
