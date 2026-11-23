# Research: AI Security Foundation

**Feature**: `001-ai-security-foundation` | **Date**: 2026-11-13
**Inputs**: `spec.md`, constitution v1.0.0, `security-first-ai-guidance-agent-prompt.md`, lab handbook

Every Technical Context unknown is resolved here. Decisions marked **PROVISIONAL** answer a spec
ambiguity that has not yet been confirmed by the user (see "Open clarifications" at the end).

## Starting point

The repository contains only documentation and Spec Kit scaffolding. There is **no existing
frontend, backend, database, authentication, or authorization system** to preserve (verified by
listing the repo root). "Use the existing stack" therefore has nothing to bind to, and the stack
below is a fresh choice. The "do not replace working authentication" instruction is honored by
making authentication and authorization **ports implemented by the host application** (D7). This
feature builds none of them.

Local toolchain observed: Node.js v22.23.4, npm 10.9.9, Docker 29.9.3. Not present: `tsc`, `psql`,
`gh`. The repo is not a git repository.

---

## D1. Language and runtime

- **Decision**: TypeScript (strict mode, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`)
  on Node.js 22.
- **Rationale**: The platform has a browser side (DOM, `data-ai-*` annotations) and a server side;
  one language lets the contracts be shared with no translation layer. The source prompt's examples
  are TypeScript. Node 22 is already installed. Branded types give compile-time separation of
  `TenantId`/`UserId`/etc., which matters when the core rule is "never trust model-supplied IDs".
- **Alternatives**: Python (pytest is a lab default, but weaker static typing at the contract
  boundary); Go/Java (not installed, no benefit at this scale).

## D2. Runtime validation

- **Decision**: Zod 4 with `z.strictObject` for every object schema at every nesting level.
- **Verified facts** (Zod docs, v4.6.7):
  - `z.strictObject` throws on unknown keys. A plain `z.object` **silently strips** unknown keys.
  - `z.toJSONSchema` of a plain `z.object` in default (output) mode still emits
    `additionalProperties: false`, which would make a plain object look strict. In
    `{ io: "input" }` mode `additionalProperties` is omitted for `z.object` and always set to
    `false` for `z.strictObject`.
  - Unrepresentable constructs throw by default (`unrepresentable: "throw"`).
- **Consequence (pitfall, now a requirement)**: the registry's strictness check MUST convert with
  `{ io: "input", unrepresentable: "throw" }` and require `additionalProperties: false` on every
  object node. A regression test registers a plain `z.object` fixture and expects rejection.
- **Verified by running Zod 4.6.7 (2026-11-13)** with `{ io: "input", unrepresentable: "throw" }`:
  - `z.strictObject` rejects an extra key; plain `z.object` strips it and parses successfully.
  - Plain `z.object` in default output mode reports `additionalProperties: false` (the trap).
    In input mode that key is **absent** for a plain object, **including one nested inside a
    `strictObject`**, so a registry walk finds it. `strictObject` reports `false`.
  - `.max()` on strings and arrays and `.min()/.max()` on numbers appear as `maxLength`,
    `maxItems`, `minimum`, `maximum`. An unbounded `z.string()` has **no** `maxLength`, so
    "every string and array bounded" (FR-018) is mechanically checkable.
  - `z.date()` throws under `unrepresentable: "throw"`, which fails registration closed.
  - **Nuance**: `.transform()` is representable in input mode and is not rejected. That is
    acceptable because only the **normalized output** of parsing is ever authorized, digested,
    confirmed, audited, and executed (FR-020); the schema's input side is what the model can reach.
  - `JSON.parse` keeps the **last** duplicate key silently (`{"a":"first","a":"second"}` yields
    `"second"`), and it creates an own `__proto__` property, which `strictObject` then rejects.
    This confirms why intake must reject duplicates itself (D3).
  The spike script is not part of the repo. The same assertions become unit tests in the first
  implementation task so the behavior is pinned against future Zod upgrades.
- **Alternatives**: JSON Schema + Ajv (less ergonomic types, but equally valid; rejected for
  single-source-of-truth typing); hand-written validators (rejected, error-prone).

## D3. Strict intake of untrusted input

- **Decision**: A dedicated intake step runs before any schema: maximum payload bytes (default
  16 KiB), maximum nesting depth (default 8), rejection of duplicate JSON keys, rejection of the
  keys `__proto__`, `constructor`, `prototype`, rejection of non-finite numbers. Action IDs must
  match `^[a-z][A-Za-z0-9]{2,63}$` before any lookup. Registry lookup uses a `Map`, never an object
  property, so names like `__proto__` or `constructor` cannot match.
- **Rationale**: `JSON.parse` silently keeps the last duplicate key, which could let an attacker
  show one value to a check and another to an executor (spec edge case: duplicate or ambiguous
  keys). Look-alike names (case, whitespace, homoglyphs) are rejected by exact-match plus an ASCII
  pattern.
- **Requirement on the AI layer**: the tool-call adapter MUST pass the provider's raw arguments
  text to the Gateway untouched. Once something has been parsed into an object, duplicate keys no
  longer exist to be detected. Already-parsed input is still accepted but is deep-copied once into
  plain data before any check, so getters or proxies cannot return different values on a later read.
- **Alternatives**: rely on schema validation alone (rejected: duplicate keys are gone by then).
  Implementation note: the strict parser is small but easy to get wrong, so it is covered by
  property-based tests (D17).

## D4. Enforcing "the AI layer must not import executors"

- **Decision**: Three static layers plus one runtime layer (D5).
  1. **Package boundaries** (npm workspaces): `ai` depends only on `contracts`. `actions`
     (executors) depends only on `contracts`. `security` depends only on `contracts`. Executors are
     injected into the Gateway at the composition root, never imported by `security`.
  2. **dependency-cruiser rules** in CI forbid every edge not in the allowed graph (see plan.md).
  3. **Lint rules** forbid `eval`, `new Function`, dynamic `import()` of non-literals, and imports
     of the restricted `@dap/contracts/mint` subpath outside `security` and `testkit`.
  4. An **architecture test** reads the workspace manifests and the import graph and fails on any
     forbidden edge.
- **Rationale**: Honest scope: these controls stop developer mistakes and refactors that would
  silently open a path. They do not stop a malicious dependency running in-process. That is a
  supply-chain risk handled by dependency scanning (constitution, Section 3), not by this design.
- **Alternatives**: a single package with lint rules only (rejected: one misconfigured rule removes
  the guard, whereas a missing manifest dependency fails the build).

## D5. Trusted minting and execution grants

- **Decision**: Two objects can only be created by the Gateway side and are verified at runtime:
  - `AuthorizationContext`: minted by `security/context` after authentication. The Gateway rejects
    any context object it cannot recognize as minted.
  - `ExecutionGrant`: minted by the Gateway only after every check passed and the allow-event is
    durably audited. It is bound to `(requestId, actionId, paramsDigest, tenantId, userId)` and is
    **single-use**.
  Both are tracked in a module-private registry in `contracts`, reachable only through the
  restricted `mint` subpath. Executors are created with `defineExecutor()`, whose wrapper refuses to
  run without a valid, unconsumed grant whose binding matches the call.
- **Rationale**: This gives FR-011 ("callable only by the Gateway") and FR-017 (executors receive
  trusted context, never AI-supplied identity) a runtime guarantee, not only a convention. A
  forged object (a plain data literal) fails the registry check. A copied reference to an executor
  still cannot run without a grant.
- **Alternatives**: signed JWT grants (rejected: adds key management for an in-process hand-off);
  type-level brands only (rejected: erased at runtime and can be cast away).

## D6. Evaluation pipeline and ordering

The requested flow (Planner, Proposal, Schema Validation, Gateway, Authorization, Confirmation,
Executor) is kept. The plan makes it precise and adds three ordering decisions:

1. **Trusted context first.** The server resolves the `AuthorizationContext` from authentication
   before the proposal is even read, so unauthenticated callers cannot probe schemas.
2. **Cheap shared-state checks early.** Per-user/turn rate limits and the replay claim run
   immediately after intake, before registry resolution and any host hook, so floods and duplicates
   cost one indexed operation each instead of several hook calls.
3. **Durable audit before execution**, for every allowed action (stricter than FR-040).

| # | Stage | Fails with | Spec |
|---|-------|-----------|------|
| 0 | Context: valid minted context, not expired | `UNAUTHORIZED` | FR-021, 022 |
| 1 | Intake: size, depth, duplicate keys, envelope shape | `INVALID_ACTION` | FR-019 |
| 2 | Global rate limits (turn, user, tenant, denial throttle) | `DENIED` (rate) | FR-043, 044 |
| 3 | Replay claim (atomic, tenant-scoped) | `DENIED` (replay) | FR-034 |
| 4 | Resolve: exact match; reserved-forbidden check; enabled globally and for tenant | `INVALID_ACTION`, `FORBIDDEN_POLICY`, `DENIED` | FR-001, 006, 008, 009 |
| 5 | Schema validation: strict, bounded, normalized | `INVALID_PARAMETERS` | FR-018, 020 |
| 6 | Authorization: permission, page narrowing, resource (tenant-checked), per-capability limits | `UNAUTHORIZED`, `DENIED` | FR-013, 024, 025 |
| 7 | Risk and confirmation: create confirmation request, stop | `REQUIRES_CONFIRMATION` | FR-010, 027 |
| 8 | Audit: durable allow-event | `DENIED` (audit) | FR-040 |
| 9 | Execute with a single-use grant; audit the result | `ALLOWED` | FR-011, 017 |

A decision always ends the pipeline at the first failing stage. Any thrown error, timeout, or
malformed hook answer at any stage maps to `DENIED` (`dependency_failure`/`internal_error`).

- **"Policy service unavailable"**: the Gateway is an in-process module, so it fails together with
  the backend that hosts it, and nothing executes (executors are unreachable without it). Its
  dependencies (state store, audit sink, host hooks) failing produce `DENIED`, and the readiness
  probe reports not-ready. If the Gateway is later extracted into a separate service, its client
  MUST treat timeouts and errors as `DENIED`. What the user sees during an outage is a UX concern
  for the planner feature.
- **Alternatives**: an external policy engine (OPA/Cedar) was rejected for now. The spec requires
  authorization to be the host application's own, so a second policy language would duplicate it
  and widen the surface. The `PermissionChecker`/`ResourceAuthorizer` ports could front such an
  engine later.

## D7. Authentication and authorization integration

- **Decision**: Host-implemented ports: `AuthenticationPort`, `PermissionChecker`,
  `ResourceAuthorizer`, `PageContextProvider`. `security/context` validates the principal returned
  by `AuthenticationPort` (strict shape, not expired), then mints the `AuthorizationContext`. Only
  identity, tenant, session, and validity times live in the context. **Permissions are not copied
  into it**; they are checked live through the port so a stale or forged copy cannot grant access.
- **Resource checks** return a `ResolvedResource | null`. `null` covers not found, not permitted,
  and other-tenant, which are indistinguishable by design (FR-025). The resolved resource carries a
  trusted display name used for confirmation text.
- **Reference host**: ships a development-only authentication stub (fixed sessions from an
  environment value). It refuses to start when `NODE_ENV=production` and requires an explicit
  opt-in flag.
- **Alternatives**: building a real login system here (rejected as out of scope and against the
  instruction to keep existing auth).

## D8. Tenant model (PROVISIONAL)

- **Decision**: A tenant is one customer organization account of the host product. Every
  authenticated session has **exactly one active tenant**, fixed by the host's authentication when
  the session is established. A user who belongs to several tenants gets a separate session per
  tenant; switching tenants means a new context, never a per-request selection. No sub-tenants in
  this feature (workspaces or projects are resources inside a tenant). `TenantId` is an opaque
  UUID.
- **Rationale**: One tenant per context makes the partition key unambiguous for every store, and
  removes a whole class of "which tenant did this request mean" bugs.
- **If the answer differs** (multi-tenant sessions): `AuthorizationContext` and every store key
  change, so this needs re-planning rather than a tweak.

## D9. Shared security state storage

- **Decision**: PostgreSQL (16 or newer) for confirmations, replay claims, rate counters, audit
  events, and tenant action policy, behind a `SecurityStateStore` port with two adapters: PostgreSQL
  (production) and in-memory (tests). Both run the **same conformance suite**.
- **Tenant isolation**: every table has `tenant_id`; row-level security is enabled and forced.
  Policies compare `tenant_id` to a per-transaction setting applied with `set_config(..., true)`.
  An unset setting yields no rows, which fails closed. The application connects as a role that is
  neither table owner nor able to bypass row-level security.
- **Atomicity** (no application-level locks):
  - Replay claim: `INSERT ... ON CONFLICT DO NOTHING` and check the affected row count.
  - Confirmation acceptance: a single `UPDATE ... WHERE status='pending' AND expires_at > now()
    RETURNING` transition. Under PostgreSQL's default isolation a concurrent second update
    re-evaluates the condition after the first commits and matches nothing, so exactly one wins
    (SC-005).
  - Rate counters: `INSERT ... ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count`.
- **Clock**: expiry and windows use the database clock, so replicas with skewed clocks agree.
- **Why not Redis**: a second datastore adds an operational dependency; the needed operations are
  all expressible atomically in PostgreSQL. The `RateLimiter` port allows a swap if load demands.
- **Why not an ORM**: a small set of explicit parameterized statements is easier to audit for
  tenant scoping.

## D10. Confirmation design

- **Decision**:
  - Created by the Gateway at stage 7. Stores the **normalized parameters**, their digest, the
    capability version and definition hash, the resolved resource, user, tenant, risk, and a
    **consequence summary**, with an expiry.
  - Handle: a random UUID (`crypto.randomUUID()`), unguessable and single-use. It is delivered only
    through the `ConfirmationChannel` port to the user's own session and **never** included in any
    result returned to the planner (FR-028).
  - Accept and reject go through `ConfirmationService.decide`, a separate entry point that the AI
    layer has no dependency on and that requires an authenticated session (FR-030).
  - On accept, in order: load by id inside the tenant scope; verify same user, still pending, not
    expired, definition hash unchanged, digest recomputed from stored params equals stored digest;
    **re-run permission and resource authorization**; consume atomically; write durable audit;
    mint a grant; execute the **stored** parameters (the client never resends parameters).
  - Re-authorization on accept applies to every confirmable capability (spec minimum is CRITICAL,
    FR-032); the cost is one extra check and it closes the permission-revoked-meanwhile gap.
  - A confirmation is at-most-once: if execution fails after consumption, the record stays
    consumed, the failure is audited, and the user must start over.
- **Consequence text** comes from the definition's `describeConsequence`, fed only with validated
  parameters and the **trusted** resolved resource (for example its display name from the host's
  data), never from AI-authored text (FR-029).
- **Default lifetime (PROVISIONAL)**: 300 seconds, configurable, capabilities may only shorten it,
  hard maximum 900 seconds. A user needs time to read a consequence summary, and the window should
  still be short enough that a stale prompt cannot be approved by accident.
- **Requirement on the later confirmation UI**: it must render outside any DOM the AI can drive
  (Principle VII). This feature cannot enforce that, so it is recorded as a dependency.
- **Alternatives**: a hashed secret token in addition to the id (rejected: the authenticated
  session already authorizes the click, and listing pending items would need the plaintext);
  confirming by re-submitting parameters (rejected: invites parameter swap).

## D11. Replay protection

- **Decision**:
  - **Proposals**: the trusted runner (not the model) assigns a `callId` per model tool call. The
    Gateway atomically claims `(tenant, aiSessionId, callId)` with a 24-hour retention (configurable).
    A duplicate returns `DENIED` (`replayed_request`). This protects against duplicate delivery,
    retries, and resubmission. It does not authenticate the sender; that is the context's job.
  - **Confirmations**: replay protection is inherent in the single-use state transition. The
    consumed record is retained for the same period.
  - **Across restarts and replicas**: all claims live in the shared store (FR-036).
- The `callId` is not part of the model-visible schema, so the model cannot choose or reuse it.

## D12. Rate limiting and abuse controls

- **Decision**: fixed-window counters in the shared store behind a `RateLimiter` port. Scopes: per
  turn, per user, per tenant, per user and capability, per user and high-risk class, and a denial
  throttle per AI session. All values configurable. Defaults chosen by this plan, to be tuned:

| Control | Default |
|---------|---------|
| Proposals per turn | 25 |
| Executions per turn | 8 |
| Chain depth per turn (runner-supplied) | 4 |
| Turn wall-clock budget (runner-supplied start time) | 30 s |
| Proposals per user per minute | 60 |
| Proposals per tenant per minute | 600 |
| Per user and capability per minute | 20 |
| HIGH + CRITICAL attempts per user per hour | 10 |
| Denial throttle | 5 denials in 60 s blocks the AI session for 300 s |

- **Cost control for floods** (SC-006): each replica also keeps a local per-turn counter. A local
  count never exceeds the shared count, so a local rejection is always correct and costs no
  database call.
- **Known limitation**: fixed windows allow up to twice the limit across a window boundary. This is
  accepted for the foundation and documented.

## D13. Audit design

- **Decision**:
  - Event types: the eight required (`AI_ACTION_PROPOSED`, `AI_ACTION_ALLOWED`,
    `AI_ACTION_DENIED`, `AI_CONFIRMATION_REQUIRED`, `AI_CONFIRMATION_ACCEPTED`,
    `AI_CONFIRMATION_REJECTED`, `AI_POLICY_VIOLATION`, `AI_RATE_LIMITED`) plus
    `AI_ACTION_EXECUTED` to carry the execution result (FR-038).
  - **No `ALLOWED` without a durable allow-event**, for every capability including SAFE. This is
    stricter than FR-040 and follows constitution Principle XVI (an unavailable audit service
    results in denial). Failure to record a denial never changes the denial.
  - **Parameters are recorded through a per-capability allowlist** (`audit.params`: path plus
    `plain` or `masked`). Anything not listed is omitted (default deny). This realizes the
    "audit setting" in FR-002 and "mark inputs as sensitive" in FR-041. A final scrubber redacts
    secret-shaped values as defense in depth.
  - **Append-only**: the application role has insert and select on the audit table and no update,
    delete, or truncate; a trigger also rejects them. The AI path has no reader at all (FR-042).
  - Fields `model` and `aiSessionId` come from the trusted runner, never from model output.
  - **Post-execution record failure**: the action already happened. The failure increments a
    metric and raises an alert, and the pre-execution allow-event (which recorded intent)
    remains. A reconciliation job is out of scope and listed as a residual risk.
- **Not included** (future hardening): per-tenant hash chains for tamper evidence.

## D14. What the model is told about denials (PROVISIONAL)

- **Decision**: The model **does** receive a result, but only a `PlannerFeedback`:
  the outcome type plus a closed-set category, never internal reasons.

| Internal reason | Outcome shown | Category shown |
|-----------------|---------------|----------------|
| Invalid parameters | `INVALID_PARAMETERS` | `invalid_input` plus issue list of field path and generic code (never values) |
| Unknown or disabled capability, reserved forbidden name | `INVALID_ACTION` / `FORBIDDEN_POLICY` / `DENIED` | `not_available` |
| Missing permission | `UNAUTHORIZED` | `not_available` |
| Resource not found, not permitted, other tenant, wrong context | `DENIED` | `not_available` (identical) |
| Rate limited, denial throttle, dependency or audit failure | `DENIED` | `try_later` |
| Replayed request | `DENIED` | `not_available` |
| Needs confirmation | `REQUIRES_CONFIRMATION` | `needs_user_confirmation` (no id, no token) |
| Success | `ALLOWED` | `ok` |
| Authorized execution attempted but executor failed | `ALLOWED` | `try_later` (no error text, result value, or internal code) |

- **Rationale**: the model needs enough to repair a malformed call and to tell the user an action is
  unavailable, but not enough to map which names, resources, or permissions exist.
- **Accepted residual risk (low)**: the outcome type still distinguishes "unknown action" from
  "known but forbidden to you". The model is already given its tool list, so this reveals little.
  If the user prefers, collapsing all to one outward outcome is a mapping-table change only.
- **If the answer differs**: only `toPlannerFeedback` and its tests change.

## D15. Browser trust boundary (PROVISIONAL, clarification question still open)

- **Decision**: Option A: **the browser is display-only and untrusted.** Proposals and every
  decision live on the server. The browser receives only already-approved on-screen instructions
  (highlight, tooltip, navigate) as typed results. Everything the browser reports (current page,
  element IDs, events) is untrusted input that may only **narrow** what is allowed. Operations that
  change data run on the server through the Gateway only, with the user's own authority.
- **Rationale**: matches constitution Principles III, VI-IX and XV, and spec FR-011. Hybrid
  client-side enforcement (option B) and browser-held approvals (option C) both let a modified
  browser influence a decision.
- **If the answer differs**: option B or C changes the execution model and the trusted-input list;
  re-plan.

## D16. Are action definitions tenant-configurable? (PROVISIONAL)

- **Decision**: No. Definitions (schema, risk, permission, confirmation, audit) are developer-authored
  and immutable at runtime (FR-003). Tenants can only **narrow**: a per-tenant row can disable a
  capability that the global allowlist enables. Narrowing is read on every proposal with no
  caching in this feature, so a disable takes effect immediately. Who edits narrowing (platform
  operators; tenant administrators through a later UI) is outside this feature.
- **Note on the constitution**: Principle XI lists "action definitions" among tenant-owned records.
  The plan reads this as covering per-tenant enablement state, not the definitions themselves.
  Flagged for confirmation.

## D17. Security testing strategy (stack and layers)

Detail and scenario catalogue: `contracts/security-test-catalogue.md`. Summary of the approach:

- **Runner**: Vitest (Jest-compatible API, native TypeScript). `npm test` satisfies the lab
  convention. **Property-based**: fast-check for the strict parser and for gateway invariants.
  **Database**: real PostgreSQL (a CI service container; Docker Compose locally).
- **Hostile planner, no LLM**: a scripted `HostilePlanner` emits worst-case proposals; tests never
  depend on live model behavior (FR-045, FR-049).
- **Independent oracle**: for generated proposals, a test-side oracle recomputes whether a call
  should ever reach an executor. The invariant "executor invoked implies schema valid, enabled,
  authorized, within limits, not replayed, audited" is checked, not just the sampled outputs.
- **Prompt-injection without a model**: (a) scripted hostile proposals standing for what a
  successfully injected model could emit; (b) a **metamorphic** test: embedding injection text in
  any free-text value must not change any decision; (c) the envelope has no free-text channel that
  affects decisions. Live-model red-team evaluations belong to the planner feature and are
  non-gating because they are non-deterministic.
- **Canary secrets**: unique sentinel values are planted in host-hook outputs, environment, and
  fixtures; any appearance in a planner-visible result or audit record fails the build (Principle V).
- **Fault injection**: every port can be wrapped to throw, hang, or return malformed data.
- **Mutation testing** (Stryker) on `packages/security` nightly, to prove the tests would fail if a
  check were removed. Optional per-PR; not required to merge.
- **Architecture tests**: import-graph and manifest checks (D4); forged-grant and forged-context
  attempts (D5).
- **Coverage gate**: a capability-by-scenario matrix; any applicable scenario without a test or a
  reviewed waiver fails CI (FR-048).

## D18. Observability

- **Decision**: `prom-client` metrics at `/metrics` on the reference host: decisions by outcome,
  reason, risk, and action; confirmations by state; policy violations; rate-limit hits by scope;
  dependency failures by dependency; audit write failures; gateway evaluation duration histogram.
  **No tenant or user labels** (cardinality and privacy). `pino` structured logs with redaction of
  secret-shaped fields. Grafana dashboard and at least one alert (denial spike, any audit failure).
- No numeric latency target exists in the spec; evaluation duration is measured, not budgeted.

## D19. Delivery

- **CI**: GitHub Actions on push and pull request: install, lint, type-check, architecture tests,
  unit, security attack suite, integration (PostgreSQL service container), build, dependency audit
  (`npm audit`), secret scan (gitleaks).
- **Containers and deployment**: multi-stage Dockerfile ordered for layer caching, non-root runtime
  user, no secrets in the image; Docker Compose for the host, PostgreSQL, Prometheus, and Grafana;
  Kubernetes Deployment (2+ replicas) and Service manifests validated on Minikube. Readiness
  depends on the state store and audit sink.
- The reference host is a thin, non-production service that exercises the boundary over HTTP and
  gives the delivery assets something to deploy.

---

## Open clarifications

| Question | Status | Plan assumption |
|----------|--------|-----------------|
| Browser trust boundary: who executes on-screen actions | Asked in `/speckit-clarify`, **unanswered** | Option A, display-only browser (D15) |
| What constitutes a tenant | Not yet asked | One active tenant per session (D8) |
| Do denied calls reach the model | Not yet asked | Minimal feedback only (D14) |
| Are action definitions tenant-configurable | Not yet asked | No, narrowing only (D16) |
| Confirmation validity | Not yet asked | 300 s default, max 900 s (D10) |

Answers that differ from these assumptions change the parts named in each decision. Running
`/speckit-clarify` before `/speckit-tasks` is recommended.
