# Contracts reconciliation (T143)

**Feature**: `001-ai-security-foundation` | Date: 2026-11-16 | Code head reviewed: `dev` `e610cf8`

What this is: each contract, type or port named in `contracts/` and `data-model.md` compared with what the packages actually export and how
`apps/reference-host` uses it. **The spec text was changed to match the code; no code was changed.** Method: every exported name in the nine
`contracts/*.ts` files was looked up in `packages/contracts/src/*.ts`; the files were then diffed; the runtime names were located in the other
packages' sources; the table names were read against `db/migrations/`.

## Result in one paragraph

The **types** already matched (the nine contract files differed from `packages/contracts/src` only in `.js` import suffixes, in ten
phantom runtime `declare` declarations, in one missing option type and in comments). The mismatches were therefore about **where things live**, about
**what is built**, and about the **database shapes**. After this change `contracts/*.ts` mirrors the code's contract type declarations (comments correct inherited runtime-description errors), and the strict
compile check passes (see [validation-report.md](../../../docs/validation-report.md)).

## A. TypeScript contracts (`contracts/*.ts`)

| # | Spec item (before) | Actual on `dev` | Resolution |
|---|--------------------|-----------------|------------|
| A1 | `action-definition.ts` declared `RegistrationError`, `buildRegistry` as exports of the contracts module | They are exports of `@dap/security` (`registry/registration-error.ts`, `registry/build-registry.ts`) | Removed the phantom declarations; README table now says "types in contracts, `buildRegistry` in `@dap/security`" |
| A2 | `action-definition.ts` declared `defineAction` inside the type-only contract file | `defineAction` is a runtime export of `@dap/contracts`, from its own file `define-action.ts` | Declaration removed from the type file; README names the location |
| A3 | `action-definition.ts` declared `RESERVED_PARAMETER_NAMES` and `RESERVED_FORBIDDEN_ACTION_NAMES` in contracts | Both are exports of `@dap/security` (`registry/reserved-names.ts`); the lists match `data-model.md` | Removed from the contract file; README points to `@dap/security` |
| A4 | `gateway.ts` declared `toPlannerFeedback` and `createPolicyGateway` and imported `ConfirmationService` | Both functions are `@dap/security` exports (`gateway/feedback.ts`, `gateway/create-gateway.ts`). `createPolicyGateway(deps, extras?)` returns `{ proposals, confirmations }`; **`confirmations` is a frozen fail-closed stub** (`decide` answers `not_valid / not_found`, `listPending` is empty). It also accepts optional `extras.telemetry` | Phantom declarations removed; README and `docs/architecture.md` say the service is a stub |
| A5 | `execution.ts` declared `defineExecutor` and `bindExecutors` in the contract file | `defineExecutor` (with `ExecutionGuardError`, `ExecutorSpec`) is exported by `@dap/contracts` via `execution-runtime.ts`; `bindExecutors` is exported by `@dap/security` | Removed; README corrected. `ExecutionGuardError` and `ExecutorSpec` were **absent from the spec** and are now named |
| A6 | `audit.ts`: `AuditSink.append(event)` | `append(event, options?: AuditAppendOptions)`; `AuditAppendOptions` (a structural abort signal) was **absent from the spec**; the durability wording was weaker than the code's (commit-acknowledgement window) | Mirrored from code, including the cancellation contract |
| A7 | `audit.ts`: `AuditReader` implemented in `@dap/security` | `createAuditReader` (`audit/audit-reader.ts`) over `PostgresAuditStore.queryForTenant` / `InMemoryAuditStore` | Row unchanged, README names the factories |
| A8 | `testkit.ts` declared `buildCoverageReport` | Not built anywhere (`coverage` is FUTURE; `packages/testkit/src/cli/` does not exist). The types `Waiver`, `CoverageCell`, `CoverageReport` do exist in contracts | Phantom function removed; README marks it "not built (FUTURE)" |
| A9 | `testkit.ts`: field order in `AttackObservation` | `auditEvents` is declared before `leakFindings` in code | Mirrored (cosmetic) |
| A10 | `core.ts`, `security-context.ts`, `state-ports.ts`, `confirmation.ts` | Identical to code apart from `.js` suffixes | No change besides the mirror |
| A11 | README: "implemented in `@dap/security`" for `ConfirmationService` and "executors in `@dap/actions`" | The service is **not built**. `@dap/actions` exports nothing (`export {};`); the host's demo executors are in `apps/reference-host/src/capabilities.ts` | README rows rewritten; "Adding a capability" step 2 notes the temporary location |
| A12 | README: "add it to the testkit target list so the full catalogue runs against it; the coverage gate fails the build" | No catalogue runner and no coverage gate on `dev`. `package.json` lists `coverage:security` but its target file does not exist, so the script fails (found while reconciling; outside this task's boundary, reported to the lead) | Step 5 rewritten to the representative route |
| A13 | README "Package boundaries": allowed edges | Matches `dependency-cruiser.config.cjs` and `tests/architecture/graph.test.ts` (`ALLOWED_MANIFEST_EDGES`). Note: one extra rule exists, `no-deep-imports-into-contracts` | Unchanged; `docs/architecture.md` section 6 lists every rule |

## B. Names used in `data-model.md`

| # | Spec item | Actual | Resolution |
|---|-----------|--------|------------|
| B1 | `ActionRegistry.isReserved(name)` | `isReservedForbidden(name)` (also in the contract file) | Text fixed |
| B2 | R7 and R10 enforced "at registration" | R7 (no executor for FORBIDDEN) and R10 (binding) are checked by `bindExecutors`/the allowlist, not by `buildRegistry`; `buildRegistry` checks R1 to R6, R8, R9, R11, R12 | Text fixed |
| B3 | `ExecutionGrant` minted "after the durable allow-event" | True; it is minted by the execute stage and consumed by `defineExecutor` | Added the two locations |

## C. Persistent tables (`data-model.md` section 3 against `db/migrations/`)

| # | Spec item | Actual | Resolution |
|---|-----------|--------|------------|
| C1 | `sec_audit_events`: `occurred_at` is "Database `now()`" | The **Gateway clock's** instant (ms); PostgreSQL preserves microseconds, finer fractions rejected (plan.md Remaining Risks 14) | Text fixed |
| C2 | `sec_audit_events.decision_id` UUID | `text` (1 to 256 chars) | Fixed |
| C3 | `sec_audit_events` missing `seq` and `tenant_id`; `outcome`/`reason` "not null" implied | `seq` identity column exists; `outcome` and `reason` are NULL exactly on `AI_ACTION_PROPOSED`; `params_view` is a JSON object of at most 64 KiB; index is `(tenant_id, occurred_at, seq)` | Fixed |
| C4 | `action_id` "requested name as received (truncated)" | Escaped to printable ASCII, scrubbed, at most 64 characters; NULL when empty | Fixed |
| C5 | `sec_confirmations` described as a table of the feature | **No migration, no adapter on `dev`** (store on the parked `confirm-store` branch, 6 commits not in `dev`) | Heading marked NOT BUILT (OPTIONAL T096 to T106); relationships and validation rules marked accordingly |
| C6 | `sec_replay_claims.claim_key` is `aiSessionId:callId` | `encodeURIComponent(aiSessionId):encodeURIComponent(callId)`; grants are `SELECT, INSERT, DELETE` with DELETE limited to expired rows (041) | Fixed |
| C7 | `sec_rate_counters` columns | Adds `limit_count`, `window_seconds`; `count` is bigint; a second table `sec_rate_blocks` exists; migration 051 makes live counters count-up-only | Fixed |
| C8 | "Purged on schedule" | `purgeExpiredState` exists (`state/postgres/purge.ts`, migration 060) but **nothing calls it** in M1 | Text says a deployment must schedule it |
| C9 | "Timestamps use the database clock" for all tables | True for replay and rate counters (`clock_timestamp()`); **not** for audit (C1) | Fixed |

## D. Other spec and plan text with a status that no longer matched

| # | Where | Was | Now |
|---|-------|-----|-----|
| D1 | `plan.md` "Scope and Milestone M1" table | audit/execute "built on branch `exec`, QA pending"; risk stage, test world, audit sink, composition root "not built" | Each row shows its real status (all merged on `dev`) |
| D2 | `plan.md` Tier A table | V and X "pending", III/XIV "on `exec`" | Statuses updated with evidence pointers |
| D3 | `plan.md` Delivery Increments 4, 5b, 6, 7, 8a | "stages on `exec`", "not built" | Done |
| D4 | `plan.md` Source Code tree | listed `confirmation/`, `coverage`, `http/`, `metrics.ts`, `deploy/{docker,k8s,...}`, HTTP-level integration tests | Marked not built; real file names added |
| D5 | `plan.md` "Reference host" description (Fastify service) | Not built; the host is in-process | Fixed in the tree and in the Summary |
| D6 | `quickstart.md` | Described a Docker/HTTP/Prometheus flow that does not exist ("Nothing here runs yet") | Rewritten as the M1 quickstart and run (T144) |
| D7 | `spec.md` header status | "Implementation in progress" | "M1 acceptance criteria evidenced; maintainer sign-off pending" with scope note |
| D8 | `apps/reference-host/package.json` lists `fastify`, `pino`, `prom-client` | No source imports them | **Not changed** (manifests are outside this task); recorded in the validation report and constitution review |

## Not reconciled (and why)

- `research.md` (decisions D1 to D19) is design rationale, not a status document. Where it describes confirmation, HTTP or metrics it is describing
  OPTIONAL or FUTURE work. It was read for contradictions and none was found that affects M1; it was not edited.
- Functional requirements in `spec.md` that belong to OPTIONAL or FUTURE work keep their wording; their tier labels are already in the spec.


## QA clarification of inherited comments

The declarations match, but the original source comments are not an API guarantee: `AuditEvent.occurredAt` is Gateway-supplied, projected parameters/attempted names can be model-authored, `ExecutionResult.code` is not written into the audit by the Gateway, and the M1 confirmation handle is not delivered. The spec mirror comments state these limits explicitly. `queryForTenant` is the bounded PostgreSQL source method; `AuditReader.query` is the public reviewer method.
