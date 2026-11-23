# Data Model: AI Security Foundation

**Feature**: `001-ai-security-foundation` | **Spec**: [spec.md](./spec.md) | **Research**: [research.md](./research.md)

Two kinds of data exist here. **Definition-time data** lives in code and configuration and is
immutable while running. **Runtime security state** lives in PostgreSQL, is partitioned by tenant,
and is shared by every service replica. Type-level shapes are in [`contracts/`](./contracts/).

> **Reconciled with the code on 2026-11-16 (T143).** Built and migrated: `sec_audit_events`, `sec_replay_claims`, `sec_rate_counters` and
> `sec_rate_blocks`, `sec_tenant_action_policy` (migrations 010 to 060). **Not built**: `sec_confirmations` and the confirmation state machine
> (OPTIONAL, T096 to T106; the store was written on the parked `confirm-store` branch, which is not on `dev`). "Replicas share state" is a
> property of the PostgreSQL adapters; Feature 001 itself runs one process (Tier B trigger absent). Every mismatch found is listed in
> [contracts/reconciliation.md](./contracts/reconciliation.md).

## 1. Definition-time entities (code and configuration)

### ActionDefinition (spec: Capability)

| Field | Rule |
|-------|------|
| `id` | Unique, matches `^[a-z][A-Za-z0-9]{2,63}$`, not on the reserved-forbidden list |
| `version` | Integer from 1. Bumped on any change. A snapshot test fails CI if the schema changes without a bump |
| `description` | Non-empty text for developers and future planner prompts |
| `inputSchema` | Strict schema. Every object node closed; every string and array bounded; no unrepresentable constructs; must not declare reserved parameter names (below) |
| `risk` | Exactly one of SAFE, LOW, MEDIUM, HIGH, CRITICAL, FORBIDDEN |
| `requiredPermission` | Non-empty permission identifier checked through the host port |
| `allowedPages` | A non-empty list of page identifiers, or `any`. Narrowing signal only |
| `confirmation` | `required` or `not-required`. See registration rules |
| `changesState` | Boolean |
| `audit.params` | List of `{path, mode: plain or masked}`. Unlisted parameters are never recorded |
| `resource` | Optional extractor from validated parameters to a resource reference. Required if `changesState` is true or the capability targets a resource |
| `describeConsequence` | Required when confirmation is required. Builds the user-facing summary from validated parameters and the trusted resolved resource |
| `confirmationTtlSeconds` | Optional. May only shorten the global default |
| `executorId` | Reference (not a function) to a bound executor |

**Reserved parameter names** (rejected at any depth in `inputSchema`): `userId`, `tenantId`,
`sessionId`, `role`, `roles`, `permission`, `permissions`, `isAdmin`, `confirmed`, `confirmation`,
`confirmationId`, `approved`, `authorization`, `token` (case-insensitive, ignoring `_` and `-`).
A capability that needs to name a target uses a resource reference, whose ownership is always
re-checked.

**Registration rules** (all enforced at startup; any failure aborts startup with the full list):

| Rule | Source |
|------|--------|
| R1. All fields present and valid | FR-002 |
| R2. Identifiers unique, exact | FR-004 |
| R3. Schema strict, bounded, representable, free of reserved names | FR-005, 018 |
| R4. HIGH and CRITICAL: `confirmation = required` | FR-010 |
| R5. MEDIUM: `required`, unless `not-required` carries a written justification string | FR-010 |
| R6. SAFE and LOW may be `not-required`. A SAFE or LOW capability with `changesState = true` is rejected | constitution XIII |
| R7. FORBIDDEN definitions have no executor and cannot be enabled (checked by `bindExecutors` and the allowlist, not by `buildRegistry`) | FR-006, 008 |
| R8. Confirmation required implies `describeConsequence` present | FR-029 |
| R9. `changesState` or resource-targeting implies `resource` present | FR-025 |
| R10. Every non-FORBIDDEN definition has exactly one executor bound; every executor is used (`bindExecutors`, `@dap/security`) | FR-053 |
| R11. `confirmationTtlSeconds` is at most the global default | D10 |
| R12. Capabilities of MEDIUM risk or higher cannot opt out of auditing (there is no opt-out for any) | FR-040 |

### ActionRegistry

Built once from the definitions by `buildRegistry` (`@dap/security`). Read-only: lookup by exact id (`get`), `list`, `isReservedForbidden(name)`, and a
`fingerprint` (hash over all definition hashes). No mutation methods exist.

- `definitionHash`: SHA-256 over canonical JSON of `{id, version, risk, requiredPermission,
  allowedPages, confirmation, changesState, inputSchemaJson}`.
- Reserved-forbidden names (matched case-insensitively with non-alphanumerics removed, used only
  to classify an attempt as a policy violation): arbitrary script execution, shell and command
  execution, query execution, outbound requests, selector-based clicking or typing, credential and
  token retrieval, disabling audit, changing permissions.

### Enablement

- **Global allowlist**: static configuration loaded at startup. A set of action ids. Empty by
  default, so nothing is usable until listed (default deny).
- **Tenant narrowing**: see `sec_tenant_action_policy`. Can only disable.
- Effective: enabled = in global allowlist **and** not disabled for the tenant.

### LimitPolicy (configuration)

Values from research D12 with their defaults. Immutable per process; changed by redeploy.

## 2. Runtime entities (in memory, one request)

| Entity | Fields | Notes |
|--------|--------|-------|
| `AuthorizationContext` | `userId`, `tenantId`, `sessionId`, `authenticatedAt`, `validUntil` | Minted only by the security module. Immutable. Never contains permissions |
| `PlannerRunMeta` | `aiSessionId`, `turnId`, `model`, `depth`, `turnStartedAt` | Supplied by the trusted runner, never by model output |
| `ProposalCall` | `callId` (runner-assigned), `raw` (untrusted) | The only model-derived data is `raw` |
| `PolicyDecision` | `decisionId`, `outcome`, `reason`, `stage`, optional `issues`, `actionId`, `risk` | Internal. Never returned to the model as is |
| `PlannerFeedback` | `outcome`, `category`, optional `issues[{path, code}]` | The only thing the model sees. See research D14 |
| `ExecutionGrant` | bound to `(requestId, actionId, paramsDigest, tenantId, userId)`, single-use | Minted by the execute stage after the durable allow-event; consumed by `defineExecutor` (`@dap/contracts`) |

## 3. Persistent tables

All tables carry `tenant_id` (UUID, not null). All have row-level security enabled **and forced**,
with a policy on both read and write conditions comparing `tenant_id` to the transaction-local
setting `app.tenant_id` (set per transaction by `withTenant`, `packages/security/src/state/postgres/tenant-tx.ts`). The application role
(`dap_app`) is not a table owner and cannot bypass row-level security. Replay and rate-limit timestamps come from the database clock
(`clock_timestamp()`); **audit** timestamps come from the Gateway's clock (see below).

### `sec_audit_events` (append-only; migration 020)

| Column | Type | Notes |
|--------|------|-------|
| `seq` | bigint identity | Insertion tie-break for events sharing an instant. Not part of `AuditEvent`; **not** commit order across concurrent transactions |
| `id` | UUID | Primary key |
| `tenant_id` | UUID | Row-level security key |
| `occurred_at` | timestamptz | The **Gateway clock's** instant (milliseconds); microseconds are preserved, finer nonzero fractions are rejected |
| `event_type` | text | One of the nine event types (research D13); closed `CHECK` |
| `request_id` | text (1 to 256) | Links proposal, decision, execution |
| `decision_id` | text (1 to 256) | Not a UUID column: the Gateway's own id string |
| `user_id` | text | From trusted context |
| `ai_session_id`, `turn_id`, `model` | text | From the trusted runner |
| `action_id` | text, nullable; SQL CHECK 1..256 | The registered id; for an unresolved proposal the **attempted name**, escaped to printable ASCII, scrubbed, at most 64 characters; NULL when the name is empty |
| `definition_version` | bigint, nullable | |
| `params_view` | jsonb | Allowlisted, masked projection only; a JSON object of at most 64 KiB |
| `risk` | text, nullable | |
| `outcome`, `reason` | text, **NULL only on `AI_ACTION_PROPOSED`** | One of the seven outcomes; closed reason-code `CHECK` |
| `confirmation_id`, `confirmation_state` | UUID / text, nullable | Both NULL or both set. No confirmation records are written in M1 |
| `execution_result` | text, nullable | `success` or `failure`; set exactly on `AI_ACTION_EXECUTED` |
| `resource_type`, `resource_id` | text, nullable | Both NULL or both set |

- Privileges: `SELECT, INSERT` only for `dap_app`. `BEFORE UPDATE OR DELETE` row triggers and a `BEFORE TRUNCATE` trigger also refuse, for any role.
- Indexes: `(tenant_id, occurred_at, seq)`, `(tenant_id, request_id)`, `(tenant_id, user_id, occurred_at)`.
- Retention is a deployment decision (spec Assumptions); this table never purges itself.
- Evidence: `packages/security/src/state/conformance/audit-migration.test.ts`, `tests/integration/audit-postgres.test.ts`.

### `sec_confirmations` (**NOT BUILT**: OPTIONAL, T096 to T106; no migration exists; design retained as the contract for the confirmation feature)

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Random handle (`randomUUID`). Primary key |
| `user_id` | text | Only this user may decide |
| `request_id` | text | Originating proposal |
| `action_id`, `definition_version`, `definition_hash` | | Bind the exact capability definition |
| `params` | jsonb | **Normalized** parameters, executed as stored |
| `params_digest` | text | SHA-256 over canonical JSON of `{actionId, version, params, resource, tenant, user}` |
| `resource_type`, `resource_id` | text, nullable | |
| `risk` | text | |
| `consequence` | jsonb | Built from trusted data only |
| `status` | text | `pending`, `accepted`, `rejected`, `invalidated` |
| `execution_status` | text | `none`, `succeeded`, `failed` |
| `created_at`, `expires_at`, `decided_at` | timestamptz | `expires_at` is created from the database clock plus the TTL |

State transitions (each a single conditional update; the first to commit wins):

```text
pending --accept (not expired, user matches, bindings match)--> accepted
pending --reject-------------------------------------------------> rejected
pending --any binding or authorization check fails on decide-----> invalidated
pending --time passes expires_at (derived, purged later)---------> (treated as expired)
accepted --execute--> execution_status: succeeded | failed        (never re-enters pending)
```

- Index: `(tenant_id, user_id, status, expires_at)` for the pending list.

### `sec_replay_claims`

| Column | Type | Notes |
|--------|------|-------|
| `namespace` | text | `proposal` (the only namespace written) |
| `claim_key` | text (1 to 1024 bytes) | `encodeURIComponent(aiSessionId):encodeURIComponent(callId)` (`gateway/stages/replay.ts`) |
| `claimed_at`, `expires_at` | timestamptz | `claimed_at` defaults to `clock_timestamp()`; retention default 24 hours (`replayRetentionSeconds` 86 400) |

- Primary key `(tenant_id, namespace, claim_key)`. A claim is `INSERT ... ON CONFLICT DO NOTHING`;
  zero rows inserted means duplicate.
- `dap_app` holds `SELECT, INSERT, DELETE`; `DELETE` is allowed only for rows already expired by the database clock (migration 041). Expired rows are
  purged by `purgeExpiredState` (`packages/security/src/state/postgres/purge.ts`, run as `dap_owner` under migration 060), which a deployment must schedule (nothing calls it in M1). The same `claim_key` in two tenants is independent.

### `sec_rate_counters`

| Column | Type | Notes |
|--------|------|-------|
| `bucket_key` | text | `scope:subject[:capability]`, for example `user:u1`, `turn:t9`, `deny:s4` |
| `window_start` | timestamptz | Window start, from database time |
| `count` | bigint | Incremented atomically; must be positive |
| `expires_at` | timestamptz | For purging |
| `limit_count`, `window_seconds` | int | The rule the row was created under (migration 051: a live counter can only count up with its window, rule and expiry fixed; a block can only be extended) |

- Primary key `(tenant_id, bucket_key, window_start)`. A second table, `sec_rate_blocks (tenant_id, bucket_key, expires_at)`, holds denial-throttle
  blocks (migration 050). `dap_app` holds `SELECT, INSERT, UPDATE` on both. Purged by `purgeExpiredState`, which a deployment must schedule.

### `sec_tenant_action_policy`

| Column | Type | Notes |
|--------|------|-------|
| `action_id` | text | |
| `disabled` | boolean | True means disabled for this tenant. Absence means inherit |
| `updated_at`, `updated_by` | timestamptz (default `now()`), text | Operator identity from the trusted admin path |

- Primary key `(tenant_id, action_id)`. Read on every proposal, no caching (research D16).

## 4. Relationships

```text
ActionRegistry 1---* ActionDefinition 1---1 Executor (bound at composition)
Tenant 1---* sec_audit_events / sec_replay_claims / sec_rate_counters / sec_rate_blocks / sec_tenant_action_policy
(not built) sec_confirmations 1---* sec_audit_events   (by confirmation_id and request_id)
Tenant is referenced by id only; the tenant itself is owned by the host application.
```

## 5. Validation rules that apply to stored data

- **Not built in M1** (confirmation): a confirmation can be decided only if: same `user_id` and `tenant_id`; `status = pending`;
  database `now() < expires_at`; the current definition hash equals the stored hash; the recomputed
  params digest equals `params_digest`; authorization still passes.
- Audit rows never contain unlisted parameters, secrets, or tokens (scrubber verified by canary
  tests).
- No table has a column that the model can write directly; every value originates from trusted
  context, trusted runner metadata, the validated parameters, or system clocks and generators.
