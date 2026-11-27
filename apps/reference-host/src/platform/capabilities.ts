import { defineAction, defineExecutor } from "@dap/contracts";
import type { ActionId, ExecutorId, PermissionId } from "@dap/contracts";
import type { HostExtension } from "../compose.js";
import { createInput, documentInput, statusInput, updateInput, uuid } from "./store.js";
import type { PlatformStore } from "./store.js";

const manage = "perm.platform.tenant.manage" as PermissionId;
const justification = "A trusted platform operator manages a public help installation.";
const documentActionInput = documentInput.extend({ organizationId: uuid });

function action<Input extends { organizationId: string }>(id: string, executorId: string, schema: import("zod").ZodType<Input>, description: string) {
  return defineAction<Input>({
    id: id as ActionId, version: 1, description, inputSchema: schema,
    risk: "MEDIUM", requiredPermission: manage, allowedPages: "any",
    confirmation: { kind: "not-required", justification }, changesState: true,
    audit: { params: [{ path: "/organizationId", mode: "plain" }] },
    resource: input => ({ type: "platformTenant", id: input.organizationId }),
    executorId: executorId as ExecutorId,
  });
}

const create = action("createTenantAndAgent", "ex.platform-create-tenant-agent", createInput, "Provision a public help installation.");
const update = action("updateTenantAndAgent", "ex.platform-update-tenant-agent", updateInput, "Update a tenant and its widget settings.");
const status = action("setAgentInstallationEnabled", "ex.platform-set-agent-enabled", statusInput, "Enable or disable a public help installation.");
const document = action("publishAgentDocument", "ex.platform-publish-document", documentActionInput, "Publish an approved public help article.");
const success = { status: "success" } as const;
const failure = { status: "failure", code: "write_refused" } as const;

export function platformExtension(store: PlatformStore): HostExtension {
  return {
    definitions: [create, update, status, document],
    executors: [
      defineExecutor<import("zod").infer<typeof createInput>>({ id: create.executorId, run: async ({ security, params }) => {
        try { await store.create(security.userId, params); return success; } catch { return failure; }
      }}),
      defineExecutor<import("zod").infer<typeof updateInput>>({ id: update.executorId, run: async ({ security, params }) => {
        return await store.update(security.userId, params) ? success : failure;
      }}),
      defineExecutor<import("zod").infer<typeof statusInput>>({ id: status.executorId, run: async ({ security, params }) => {
        try { await store.setEnabled(security.userId, params.organizationId, params.enabled); return success; } catch { return failure; }
      }}),
      defineExecutor<import("zod").infer<typeof documentActionInput>>({ id: document.executorId, run: async ({ params }) => {
        const installation = await store.lookup(params.organizationId);
        return installation && await store.publishDocument(installation, params) ? success : failure;
      }}),
    ],
  };
}
