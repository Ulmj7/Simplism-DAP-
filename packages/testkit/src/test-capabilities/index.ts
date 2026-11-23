/**
 * @dap/testkit: test-capabilities/index.ts (T030)
 *
 * One developer-authored ActionDefinition per risk class, built with defineAction from
 * @dap/contracts. Strict BOUNDED schemas only: z.strictObject, every string .max(n),
 * every array .max(n), and no reserved parameter names at any depth.
 *
 * These are TEST capabilities — they exist so attack tests (FR-046..FR-049) exercise the
 * whole risk spectrum without touching production actions. They are imported only by
 * @dap/testkit; the Gateway never registers them in production.
 */
import { z } from "zod";
import { defineAction } from "@dap/contracts";
import type {
  ActionDefinition,
  ActionId,
  ExecutorId,
  PermissionId,
  ResourceRef,
} from "@dap/contracts";

/**
 * Reference-only executor id for the FORBIDDEN definition. Per R7 a FORBIDDEN definition
 * has no executor and cannot be enabled; this value is never bound to a function.
 */
export const NO_EXECUTOR = "no-executor" as ExecutorId;

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

export interface TestSafeEchoParams {
  readonly message: string;
}

export interface TestLowNavigateParams {
  readonly route: string;
}

export interface TestMediumDraftParams {
  readonly documentId: string;
  readonly draft: string;
}

export interface TestHighPublishParams {
  readonly documentId: string;
  readonly audience: readonly string[];
}

export interface TestCriticalDeleteParams {
  readonly documentId: string;
}

export interface TestForbiddenShellParams {
  readonly command: string;
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

/** SAFE: echoes a bounded message. No state change, no resource. */
export const testSafeEcho: ActionDefinition<TestSafeEchoParams> = defineAction({
  id: "testSafeEcho" as ActionId,
  version: 1,
  description: "Echoes a bounded message back to the caller. No state change.",
  inputSchema: z.strictObject({
    message: z.string().min(1).max(200),
  }),
  risk: "SAFE",
  requiredPermission: "perm.test.safe-echo" as PermissionId,
  allowedPages: "any",
  confirmation: { kind: "not-required" },
  changesState: false,
  audit: { params: [{ path: "/message", mode: "plain" }] },
  executorId: "ex.test-safe-echo" as ExecutorId,
});

/** LOW: navigates to a bounded route. No state change, no resource. */
export const testLowNavigate: ActionDefinition<TestLowNavigateParams> = defineAction({
  id: "testLowNavigate" as ActionId,
  version: 1,
  description: "Navigates the host UI to a bounded route.",
  inputSchema: z.strictObject({
    route: z.string().min(1).max(200),
  }),
  risk: "LOW",
  requiredPermission: "perm.test.low-navigate" as PermissionId,
  allowedPages: "any",
  confirmation: { kind: "not-required" },
  changesState: false,
  audit: { params: [{ path: "/route", mode: "plain" }] },
  executorId: "ex.test-low-navigate" as ExecutorId,
});

/** MEDIUM: drafts a document revision. Changes state, targets the document. */
export const testMediumDraft: ActionDefinition<TestMediumDraftParams> = defineAction({
  id: "testMediumDraft" as ActionId,
  version: 1,
  description: "Stores a bounded draft revision of a document.",
  inputSchema: z.strictObject({
    documentId: z.string().min(1).max(64),
    draft: z.string().min(1).max(4000),
  }),
  risk: "MEDIUM",
  requiredPermission: "perm.test.medium-draft" as PermissionId,
  allowedPages: "any",
  confirmation: { kind: "required" },
  changesState: true,
  audit: { params: [{ path: "/documentId", mode: "plain" }, { path: "/draft", mode: "masked" }] },
  resource: (params): ResourceRef | null => ({ type: "document", id: params.documentId }),
  describeConsequence: ({ resource }) => ({
    title: resource ? `Save a draft of "${resource.displayName}"` : "Save a document draft",
    effects: ["A draft revision is stored for review."],
    irreversible: false,
  }),
  executorId: "ex.test-medium-draft" as ExecutorId,
});

/** Separate R5 opt-out fixture; the per-risk catalogue retains the confirming default. */
export const testMediumOptOut: ActionDefinition<TestMediumDraftParams> = defineAction({
  ...testMediumDraft,
  id: "testMediumOptOut" as ActionId,
  description: "Stores a reversible, private document draft without confirmation.",
  confirmation: { kind: "not-required", justification: "Private drafts are reversible and never published." },
  executorId: "ex.test-medium-opt-out" as ExecutorId,
});

/** HIGH: publishes a document to a bounded audience. Confirmation required. */
export const testHighPublish: ActionDefinition<TestHighPublishParams> = defineAction({
  id: "testHighPublish" as ActionId,
  version: 1,
  description: "Publishes a document to a bounded list of audiences.",
  inputSchema: z.strictObject({
    documentId: z.string().min(1).max(64),
    audience: z.array(z.string().min(1).max(64)).min(1).max(10),
  }),
  risk: "HIGH",
  requiredPermission: "perm.test.high-publish" as PermissionId,
  allowedPages: "any",
  confirmation: { kind: "required" },
  changesState: true,
  audit: {
    params: [
      { path: "/documentId", mode: "plain" },
      { path: "/audience", mode: "plain" },
    ],
  },
  resource: (params): ResourceRef | null => ({ type: "document", id: params.documentId }),
  // Built ONLY from the trusted resolved resource (FR-029). `input.params` is never read.
  describeConsequence: ({ resource }) => ({
    title: resource ? `Publish "${resource.displayName}"` : "Publish a document",
    effects: ["The document becomes visible to the selected audience."],
    irreversible: false,
  }),
  executorId: "ex.test-high-publish" as ExecutorId,
});

/** CRITICAL: permanently deletes a document. Confirmation required. */
export const testCriticalDelete: ActionDefinition<TestCriticalDeleteParams> = defineAction({
  id: "testCriticalDelete" as ActionId,
  version: 1,
  description: "Permanently deletes a document from the tenant.",
  inputSchema: z.strictObject({
    documentId: z.string().min(1).max(64),
  }),
  risk: "CRITICAL",
  requiredPermission: "perm.test.critical-delete" as PermissionId,
  allowedPages: "any",
  confirmation: { kind: "required" },
  changesState: true,
  audit: { params: [{ path: "/documentId", mode: "plain" }] },
  resource: (params): ResourceRef | null => ({ type: "document", id: params.documentId }),
  // Built ONLY from the trusted resolved resource (FR-029). `input.params` is never read.
  describeConsequence: ({ resource }) => ({
    title: resource ? `Permanently delete "${resource.displayName}"` : "Permanently delete a document",
    effects: ["The document is removed and cannot be restored."],
    irreversible: true,
  }),
  executorId: "ex.test-critical-delete" as ExecutorId,
});

/**
 * FORBIDDEN: shell execution. No executor (R7) and cannot be enabled; it exists so tests
 * can assert the pipeline refuses it as a policy violation.
 */
export const testForbiddenShell: ActionDefinition<TestForbiddenShellParams> = defineAction({
  id: "testForbiddenShell" as ActionId,
  version: 1,
  description: "Shell command execution. Always forbidden; no executor is bound.",
  inputSchema: z.strictObject({
    command: z.string().min(1).max(200),
  }),
  risk: "FORBIDDEN",
  requiredPermission: "perm.test.forbidden-shell" as PermissionId,
  allowedPages: "any",
  confirmation: { kind: "not-required" },
  changesState: false,
  audit: { params: [{ path: "/command", mode: "masked" }] },
  // A shell command targets no tracked resource.
  resource: (): ResourceRef | null => null,
  executorId: NO_EXECUTOR,
});

// ---------------------------------------------------------------------------
// Sample parameters for later attack tests
// ---------------------------------------------------------------------------

/** One VALID parameter object per capability (parses against the definitions above). */
export const VALID_PARAMS = {
  testSafeEcho: { message: "hello from the test kit" },
  testLowNavigate: { route: "/docs/overview" },
  testMediumDraft: { documentId: "doc-1", draft: "Draft revision for review" },
  testHighPublish: { documentId: "doc-1", audience: ["team-a", "team-b"] },
  testCriticalDelete: { documentId: "doc-1" },
  testForbiddenShell: { command: "echo hello" },
} as const;

export interface InvalidParamsSample {
  readonly capabilityId: string;
  readonly reason: "missing" | "extra-key" | "too-long";
  readonly params: unknown;
}

/** Invalid parameter samples per capability: missing key, extra key, and over-limit value. */
export const INVALID_PARAM_SAMPLES: readonly InvalidParamsSample[] = [
  { capabilityId: "testSafeEcho", reason: "missing", params: {} },
  { capabilityId: "testSafeEcho", reason: "extra-key", params: { message: "x", extra: 1 } },
  { capabilityId: "testSafeEcho", reason: "too-long", params: { message: "x".repeat(201) } },
  { capabilityId: "testLowNavigate", reason: "missing", params: {} },
  { capabilityId: "testLowNavigate", reason: "extra-key", params: { route: "/a", extra: 1 } },
  { capabilityId: "testLowNavigate", reason: "too-long", params: { route: "r".repeat(201) } },
  { capabilityId: "testMediumDraft", reason: "missing", params: { documentId: "doc-1" } },
  { capabilityId: "testMediumDraft", reason: "extra-key", params: { documentId: "doc-1", draft: "d", extra: 1 } },
  { capabilityId: "testMediumDraft", reason: "too-long", params: { documentId: "doc-1", draft: "d".repeat(4001) } },
  { capabilityId: "testHighPublish", reason: "missing", params: { documentId: "doc-1" } },
  { capabilityId: "testHighPublish", reason: "extra-key", params: { documentId: "doc-1", audience: ["a"], extra: 1 } },
  { capabilityId: "testHighPublish", reason: "too-long", params: { documentId: "d".repeat(65), audience: ["a"] } },
  { capabilityId: "testCriticalDelete", reason: "missing", params: {} },
  { capabilityId: "testCriticalDelete", reason: "extra-key", params: { documentId: "doc-1", extra: 1 } },
  { capabilityId: "testCriticalDelete", reason: "too-long", params: { documentId: "d".repeat(65) } },
  { capabilityId: "testForbiddenShell", reason: "missing", params: {} },
  { capabilityId: "testForbiddenShell", reason: "extra-key", params: { command: "echo hi", extra: 1 } },
  { capabilityId: "testForbiddenShell", reason: "too-long", params: { command: "x".repeat(201) } },
];

/** All test-capability definitions, in risk order. */
export const ALL_TEST_CAPABILITIES = [
  testSafeEcho,
  testLowNavigate,
  testMediumDraft,
  testHighPublish,
  testCriticalDelete,
  testForbiddenShell,
] as const;
