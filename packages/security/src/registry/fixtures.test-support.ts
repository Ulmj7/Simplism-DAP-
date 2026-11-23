import { defineAction, defineExecutor } from "@dap/contracts";
import type { ActionDefinition, ActionExecutor, ActionId, ExecutorId, PermissionId, PageId } from "@dap/contracts";
import { z } from "zod";

export type TestDefinition = ActionDefinition<Record<string, unknown>>;

export function definition(overrides: Partial<TestDefinition> = {}): TestDefinition {
  return defineAction({
    id: "viewProject" as ActionId,
    version: 1,
    description: "View a project",
    inputSchema: z.strictObject({ projectId: z.string().max(64), name: z.string().max(100) }),
    risk: "SAFE",
    requiredPermission: "project:read" as PermissionId,
    allowedPages: ["projects" as PageId],
    confirmation: { kind: "not-required" },
    changesState: false,
    audit: { params: [{ path: "/projectId", mode: "plain" }] },
    executorId: "viewProjectExecutor" as ExecutorId,
    ...overrides,
  });
}

export const consequence: NonNullable<TestDefinition["describeConsequence"]> = () => ({
  title: "Update project", effects: ["The project is updated"], irreversible: false,
});

export const resource: NonNullable<TestDefinition["resource"]> = () => ({ type: "project", id: "project-1" });

export function executor(id = "viewProjectExecutor"): ActionExecutor {
  return defineExecutor({ id, run: async () => ({ status: "success" }) });
}

/** Deliberately bypass the authoring type to exercise the startup trust boundary. */
export function malformed(changes: Record<string, unknown>): TestDefinition {
  return { ...definition(), ...changes } as TestDefinition;
}
