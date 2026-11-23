# Implementation Plan: AI Security Foundation

**Branch**: `001-ai-security-foundation` (spec directory id; development was integrated on `dev` and closed on 2026-11-16) | **Date**: 2026-11-13 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-ai-security-foundation/spec.md`

## Summary

Build the security boundary that every future AI feature must pass through, and nothing else.
The AI layer can only hand an **untrusted proposal** to a deterministic **Policy Gateway**. The
Gateway resolves the proposal against an immutable, typed **Action Registry**, validates it with
strict runtime schemas, checks the caller's trusted identity, tenant, permissions, resource access,
limits, and replay status through host-implemented ports, demands a **server-verified confirmation**
for dangerous operations, writes a durable **audit** record, and only then lets an **executor** run,
using a single-use grant that nothing else can mint. Every failure, throw, and timeout is a denial.

Technical approach (details in [research.md](./research.md)):

- TypeScript monorepo (npm workspaces). **Package boundaries enforce the layering**: the AI package
  depends only on the contracts package, so it cannot import executors or the Gateway internals.
- Zod 4 `strictObject` schemas, checked at registration through JSON Schema export in `input` mode
  (verified by running it: plain `z.object` silently strips unknown keys).
- PostgreSQL holds all shared security state (confirmations, replay claims, rate counters, audit,
  tenant narrowing) with forced row-level security, atomic single-statement transitions, and the
  database clock, so controls hold across restarts and replicas.
- Authentication and authorization are **host-implemented ports**. This feature builds neither.
- A scripted hostile planner and a focused set of representative security scenarios prove each
  control with no LLM (Milestone M1, **acceptance criteria evidenced; maintainer sign-off pending**; evidence in [docs/validation-report.md](../../docs/validation-report.md)). The 102-scenario catalogue, the 36-case dependency-failure
  matrix, and mutation testing are Future Work; code already built for them is retained.

The requested pipeline is preserved: *AI Planner, Action Proposal, Schema Validation, Policy
Gateway, Authorization, Confirmation if required, Action Executor.* Research D6 makes it precise
and explains three ordering choices (trusted context first, cheap shared-state checks early,
durable audit before any execution).

## Scope and Milestone M1 (Constitution 2.0.0)

This plan was written under Constitution 1.0.0 and is **reconciled, not restarted**, with
Constitution 2.0.0 (see the Scope Declaration in [spec.md](./spec.md)). All implemented work stays.
Items are classified **REQUIRED**, **OPTIONAL**, or **FUTURE** (Principles XVIII and XIX).

**M1 vertical slice (independently demonstrable):**

```text
Registered SAFE/LOW proposal
  -> Gateway (context, intake, rate limit, replay)
  -> validation (registered capability, strict parameters)
  -> authorization (session, permission, page, resource)
  -> risk decision
  -> audit (durable before execution)
  -> trusted executor (single-use grant, validated frozen parameters, user's own context)
  -> deterministic success
```

| Stage / piece | Status (2026-11-16) | Scope |
|---------------|--------------------|-------|
| Context, intake, rate-limit, replay, resolve, validate, authorize | built, merged | REQUIRED |
| Audit stage and execute stage, `evaluate()` runner result | built, merged (T089, T090, T146) | REQUIRED |
| Risk decision stage (no confirmation records) | built, merged (T104a) | REQUIRED |
| Gateway test world with the real chain | built, merged (T070, T078) | REQUIRED |
| Persistent audit sink and migration | built, merged: `db/migrations/020_sec_audit_events.sql`, `PostgresAuditStore` (T093 to T095) | REQUIRED, minimal |
| Representative security scenarios | built, merged, run on the real Gateway (T052 to T054, T059, T072, T073, T082 to T084) | REQUIRED, reduced |
| Composition root, development authentication, one integration test | built, merged (T131, T132, T136): `apps/reference-host`, `tests/integration/reference-host.test.ts` | REQUIRED |
| M1 gate and minimal CI | built, merged (T071, T140): `npm run test:m1-gate`, `.github/workflows/ci.yml` (replayed locally and linted with actionlint; no GitHub Actions run yet) | REQUIRED |
| Documentation and validation | T142 to T145: `docs/architecture.md`, `docs/validation-report.md`, `docs/constitution-review.md` | REQUIRED |
| Confirmation store, binding, service, endpoints | **not built on `dev`**: a store exists only on the parked `confirm-store` branch; the Gateway has a fail-closed stub | OPTIONAL, parked |
| Coverage gate, double-run, dependency matrix, mutation testing, metrics, Kubernetes | **not built on `dev`** (some tooling on the parked `tooling` branch) | FUTURE, parked |

Branch handling: `exec` is critical path; `attacks2` is merged only for the representative
trust-boundary tests; `confirm-store` and `tooling` are preserved but do not block M1. No branch is
merged merely because the old task list marked it mandatory.

## Technical Context

**Language/Version**: TypeScript (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) on Node.js 22

**Primary Dependencies**: Zod 4 (4.6.7 verified); `pg` (node-postgres, explicit parameterized SQL, no ORM); Fastify (declared by the reference host's manifest but **not used**: the built host is in-process); `pino` (`prom-client` and metrics are FUTURE). Dev: Vitest, fast-check, dependency-cruiser, ESLint with typescript-eslint, Stryker (FUTURE: nightly, optional). Versions other than Zod are pinned by the lockfile at implementation time

**Storage**: PostgreSQL 16 or newer (confirmations, replay claims, rate counters, audit events, tenant action policy) with forced row-level security; in-memory adapter for fast tests

**Testing**: Vitest (unit, contract, conformance, attack suites), fast-check (property tests), real PostgreSQL for shared-state scenarios, dependency-cruiser (architecture)

**Target Platform**: Linux, single-process modular monolith. Docker and Docker Compose are OPTIONAL; Kubernetes and Minikube are FUTURE

**Project Type**: TypeScript library monorepo plus one thin, non-production reference service

**Performance Goals**: No numeric latency or throughput target exists in the spec, so none is invented. Gateway evaluation time is measured (histogram). Design intent: a bounded number of indexed database round trips per proposal, and a local per-turn pre-check so floods cost no database call

**Constraints**: Fail closed everywhere; Gateway decisions deterministic and LLM-free; no general execution capability of any kind (FR-050); all shared state tenant-partitioned and database-clock based; metrics and logs carry no tenant, user, secret, or raw DOM data

**Scale/Scope**: Course-project scale (tens of tenants, hundreds of users) with a design that does not preclude several service replicas. Scope: 6 risk classes, 7 outcome types, 9 audit event types, 5 shared-state tables, 12 registration rules, 102 catalogued (the exhaustive set is FUTURE; M1 uses a representative subset) attack scenarios plus a 36-case dependency-failure matrix (9 ports x 4 failure modes)

**Existing stack and authentication**: None exists (repo contains documentation only). Nothing is replaced. Authentication and authorization are ports the host application will implement; the reference host ships only a development-only stub that refuses to run in production

**Unknowns**: none remain open in Technical Context. Five spec ambiguities are resolved as **provisional** decisions and tracked below.

## Constitution Check

*GATE: re-evaluated on 2026-11-16 against Constitution 2.0.0 (tiered). Result: **PASS**. The
earlier check against 1.0.0 (Principles I-XVII, all universal) is superseded.*

### Tier A: mandatory invariants

| # | Principle | Design response (evidence) | Status |
|---|-----------|----------------------------|--------|
| I | LLM is an untrusted planner | AI layer holds only a `ProposalSubmitter`; identity, tenant, run metadata, and `callId` come from trusted code | PASS, implemented |
| II | LLM output never authorizes | Claims in text or parameters are unknown keys or ignored; confirmation is never taken from the model | PASS, implemented |
| III | Deterministic Policy Gateway | Single chokepoint; executors need a single-use grant only the Gateway mints; no LLM in the decision path; static graph, types, runtime grant checks | PASS, implemented and merged (`docs/architecture.md`) |
| IV | Default deny, allowlists | Exact-match registry, default-deny enablement, strict schemas, reserved names | PASS, implemented |
| V | No secrets to the AI | Planner feedback is outcome, category, and field paths only; audit scrubber; canary test (T082) | PASS, implemented; `tests/security/secret-extraction.test.ts`, `tests/integration/audit-postgres.test.ts` P4 |
| VI | Client-side redaction | Out of scope for this feature (a later UI feature); this feature accepts no DOM data | N/A here |
| VII | No arbitrary execution | No `eval`, shell, network, or selector capability; static scan and graph tests | PASS, implemented |
| VIII | Typed registered capabilities | `buildRegistry` rules R1-R12; executor binding | PASS, implemented |
| IX | Backend authorization authoritative | Authorize stage re-judges session, permission, page, and resource against host ports | PASS, implemented |
| X | No privilege amplification | Executors receive the requesting user's own minted context; parity test (T072) | PASS, implemented; `tests/security/privilege-escalation.test.ts` (ATK-PRIV-01 parity), `positive.test.ts` (ATK-PRIV-04) |
| XII | RAG is untrusted data | No RAG in this feature; feedback and audit never echo model text | N/A here |
| XIV | Auditability | Audit builder, projection, scrubber, writer; durable ALLOWED before every execution; PostgreSQL sink | PASS, implemented, with the limits in `docs/constitution-review.md` (commit-acknowledgement window, best-effort PROPOSED/denial/EXECUTED) |
| XV | Survives LLM compromise | Hostile planner; bounded per-turn execution and per-proposal budget | PASS, implemented |
| XVI | Least privilege, strict schemas, minimal context, fail closed | Strict schemas at every boundary; every fault is a denial | PASS, implemented |
| XVII | Focused security tests | Representative M1 set (see spec Scope Declaration); exhaustive catalogue is Future | PASS for scope; run by `npm run test:m1-gate` and CI |

### Tier B: conditional controls and their triggers

| Principle | Trigger | Present? | Consequence |
|-----------|---------|----------|-------------|
| XI Tenant isolation | A feature stores or retrieves tenant-owned data | Yes (audit, tenant policy) | Tenant-ready: tenant from the trusted context, tenant-scoped data, forced RLS (built). Demo may run one tenant |
| XIII Confirmation | HIGH/CRITICAL capability, or MEDIUM requiring confirmation, delivered | Only in the fallback form of XIII: the host registers a HIGH demo capability (`demoPublishNote`) that stops at `REQUIRES_CONFIRMATION` and never reaches an executor; no executable HIGH/CRITICAL or confirmation-required MEDIUM capability exists | Only the risk decision is REQUIRED (T104a), built. Store and binding exist only on the parked `confirm-store` branch |
| Replay protection | Retry-sensitive or state-changing actions | Yes (one state-changing demo capability) | Replay guard (in-memory and PostgreSQL) and stage built and used by the host |
| Shared state across copies | More than one copy runs | No (single process) | In-memory adapters allowed, documented; PostgreSQL adapters built and used by the reference host (no multi-replica test) |

### Tier C: Future Work (not prerequisites)

Exhaustive attack catalogue and coverage gate; mutation testing; independent oracle frameworks beyond
existing code; double-run determinism script; 36-case dependency-failure matrix; 10,000-proposal
flood suites; multi-replica guarantees and distributed rate limiting; Prometheus, Grafana,
Kubernetes, Minikube, distributed tracing, SIEM, and enterprise deployment hardening.

### Principles XVIII and XIX: delivery scope and scope discipline

| Check | Result |
|-------|--------|
| Bounded vertical slice, independently demonstrable (XVIII) | M1 defined in the Scope Declaration; P1 stories complete before P2 hardening |
| No infrastructure beyond what the feature needs (XVIII) | Kubernetes, Prometheus, Grafana, and enterprise observability removed from the critical path |
| Future Work recorded explicitly (XVIII) | Yes: spec "Future Work" section and the Tier C list above |
| Minimum architecture for the invariants; reuse existing (XIX) | All built components reused; nothing replaced |
| REQUIRED / OPTIONAL / FUTURE classification (XIX) | Present in spec, this plan, and every open task |
| Deferred hardening never blocks product work (XIX) | Confirmation service and Tier C work are non-blocking |

### Items needing attention

1. **Audit is stricter than the spec.** FR-040 requires durable audit before state-changing
   execution; the implementation requires it before **every** execution (D13). A long audit outage
   therefore denies even SAFE actions. This is retained as built. Relaxing it for purely visual
   guidance is Future Work.
2. **Delegated authority is a convention at the executor edge.** The contract passes each executor
   the user's own context; an executor that calls downstream systems with a service credential
   would reintroduce the confused deputy. A mandatory review item and a parity test per capability.
3. **Principle XI wording.** Per-tenant *enablement* is tenant state; capability *definitions* are
   global (D16, resolved).

## Architecture

### Trust boundaries

```text
 UNTRUSTED                                   |  TRUSTED (server)
 -------------------------------------------+-----------------------------------------------
  user's browser (display-only; reports are  |
  untrusted, may only narrow)                |
        ^   typed, already-approved          |  composition root (wires everything)
        |   on-screen instructions           |
        |                                    |  +--------------------+
  LLM / model output  --- raw tool call -----+->| @dap/ai            |  planner runner
  retrieved documents (future)               |  | ProposalSubmitter  |  (our code; assigns callId,
        ^                                    |  +---------+----------+   run metadata)
        |  PlannerFeedback only              |            | ProposalCall
        |  (outcome + category)              |            v
        +------------------------------------+---- @dap/security --------------------------------+
                                             |  Policy Gateway                                   |
   host application (ports)                  |  context -> intake -> limits -> replay -> resolve |
   authentication, permissions, resource     |  -> validate -> authorize -> risk/confirm -> audit |
   checks, page context, confirmation  <-----+->  -> grant ---------------------+                |
   channel                                   |      state store (PostgreSQL, RLS) |               |
                                             +------------------------------------|---------------+
   user's own session  --- decide(id) -------+-> ConfirmationService (separate door)               |
                                             |                                    v               |
                                             |                          @dap/actions executors    |
                                             |                          (grant-checked, user's    |
                                             |                           own authority)           |
```

### Data flow: AI to action

1. The runner receives a model tool call and creates a `ProposalCall` (`callId`, raw text).
2. `gateway.forSession(ctx, run)` was bound earlier by the composition root; the runner calls
   `submit(call)`.
3. The Gateway runs the stages in research D6, ending at the first failure.
4. On `ALLOWED`: durable allow-event, grant minted, executor runs once, result event written.
5. The runner receives only `PlannerFeedback`. A UI effect, if any, is returned to the browser as a
   typed instruction by the composition root, not by the model.

### Data flow: confirmation to execution

1. Stage 7 stores a confirmation (normalized parameters, digest, definition hash, trusted
   consequence) and delivers its handle to the user's session through the host's channel. The
   planner gets `REQUIRES_CONFIRMATION` with no handle.
2. The user's session calls `ConfirmationService.decide`. The Gateway re-checks user, state, expiry,
   definition hash, digest, and authorization, consumes the confirmation atomically, writes the
   audit event, mints a grant, and executes the **stored** parameters.
3. At most once: a failed execution is audited and the user must start over.

Data flows for UI-to-AI and RAG-to-AI belong to the features that introduce those paths.

## Project Structure

### Documentation (this feature)

```text
specs/001-ai-security-foundation/
├── plan.md              # This file
├── research.md          # Phase 0: decisions D1-D19 and open clarifications
├── data-model.md        # Phase 1: definition-time entities, runtime entities, tables
├── quickstart.md        # Phase 1: run-and-verify guide
├── contracts/           # Phase 1: interfaces and test catalogue
│   ├── README.md                 # index, package boundaries, how to add a capability
│   ├── core.ts                   # ids, RiskLevel, outcomes, reasons, stages
│   ├── action-definition.ts      # ActionDefinition, ActionRegistry
│   ├── security-context.ts       # AuthorizationContext and host ports
│   ├── gateway.ts                # PolicyDecision, PlannerFeedback, createPolicyGateway
│   ├── confirmation.ts           # ConfirmationRequest, ConfirmationService
│   ├── audit.ts                  # AuditEvent, AuditSink
│   ├── execution.ts              # ActionExecutor, ExecutionGrant
│   ├── state-ports.ts            # replay, rate limiting, stores
│   ├── testkit.ts                # hostile planner, scenarios, coverage
│   ├── security-test-catalogue.md
│   └── reference-host-api.md
└── tasks.md             # Phase 2 (/speckit-tasks, not created here)
```

### Source Code (repository root)

> **Status of this tree (2026-11-16)**: it is the planned layout. Built on `dev`: `contracts`, `ai`, `security` (without `confirmation/`), `testkit` (without
> `coverage`), `apps/reference-host` as an **in-process** composition root (`compose.ts`, `config.ts`, `capabilities.ts`, `host-ports.ts`, `dev-auth/`; no
> `http/` and no `metrics.ts`), `db/migrations/` (000, 010, 011, 020, 040, 041, 050, 051, 060), `deploy/compose.yaml` only, `scripts/m1-gate*.mjs`,
> `tests/{architecture,security,integration}` (integration tests run in-process against PostgreSQL, not over HTTP) and `.github/workflows/ci.yml`.
> `packages/actions` is empty. `deploy/docker`, `deploy/k8s`, `deploy/prometheus` and `deploy/grafana` do not exist.

```text
packages/
├── contracts/                  # @dap/contracts: types, constants, defineExecutor wrapper
│   └── src/
│       ├── core.ts, action-definition.ts, gateway.ts, security-context.ts,
│       │   confirmation.ts, audit.ts, execution.ts, state-ports.ts
│       └── mint/               # restricted subpath: mints contexts and grants
├── ai/                         # @dap/ai: depends on contracts ONLY
│   └── src/ { planner-port.ts, tool-call.ts, index.ts }
├── security/                   # @dap/security: depends on contracts ONLY
│   └── src/
│       ├── context/            # SecurityContextFactory
│       ├── registry/           # buildRegistry, rules R1-R12, reserved names, hashing
│       ├── validation/         # strict intake, envelope, parameters, digest
│       ├── gateway/            # pipeline stages, decisions, feedback mapping, hook wrapper
│       ├── confirmation/       # binding and ConfirmationService (OPTIONAL; store and binding built on `confirm-store`, parked)
│       ├── limits/             # limit orchestration over the RateLimiter port
│       ├── audit/              # projection, scrubber, event builder
│       └── state/              # postgres/ and memory/ adapters, conformance suite
├── actions/                    # @dap/actions: depends on contracts ONLY
│   └── src/index.ts            # empty now: production executors arrive with later features
└── testkit/                    # @dap/testkit: never imported by production code
    └── src/ { world, hostile-planner, attacks/, leak-scanner, recording-executor,
               coverage, test-capabilities/ }
apps/
└── reference-host/             # composition root (non-production); in-process, no HTTP service was built
    └── src/ { compose.ts, dev-auth/ (REQUIRED, M1); http/ (OPTIONAL); metrics.ts (FUTURE) }
db/
└── migrations/                 # tables, forced RLS, privileges, audit append-only trigger
deploy/
├── docker/                     # OPTIONAL: Dockerfile (multi-stage, non-root)
├── compose.yaml                # postgres (REQUIRED for the audit sink); host (OPTIONAL); prometheus, grafana (FUTURE)
├── k8s/                        # FUTURE: Deployment (2+ replicas) and Service
├── prometheus/                 # FUTURE: scrape config and alert rules
└── grafana/                    # FUTURE: dashboard
tests/
├── architecture/               # import graph, manifests, no mutators, static scans
├── security/                   # runs the catalogue against every test capability
└── integration/                # HTTP-level flows against the reference host
.github/workflows/ci.yml
```

**Structure Decision**: an npm-workspaces monorepo with five small packages and one app. The
package split is the enforcement mechanism for "the AI layer must not import executors": a missing
manifest dependency fails the build, which is stronger than a lint rule alone. Unit tests sit next
to the code (`*.test.ts`). The attack suites live in `tests/security/` and take capabilities as
input so later features reuse them unchanged.

**Allowed dependency edges** (checked in CI by dependency-cruiser and a manifest test):

| From | May depend on |
|------|---------------|
| `contracts` | external libraries only (Zod types) |
| `ai`, `actions`, `security` | `contracts` |
| `testkit` | `contracts`, `security`, `ai` |
| `apps/reference-host` | all packages (it is the composition root) |

Everything else is forbidden. `@dap/contracts/mint` is importable only by `security` and `testkit`.

## Security Testing Strategy

Full catalogue: [`contracts/security-test-catalogue.md`](./contracts/security-test-catalogue.md).
Approach and rationale: research D17. Every row is proven by the recording executor staying at
zero calls, not only by a returned status.

| Required topic | How it is tested | Representative scenarios |
|----------------|------------------|--------------------------|
| Unknown actions | Exact-match lookups against never-registered names, reserved dangerous names, look-alikes (case, whitespace, zero-width, homoglyph), prototype keys, runtime registry mutation attempts | ATK-UNKNOWN-01..08 |
| Malformed parameters | Missing, mistyped, extra (top-level and nested), oversized, duplicate keys, prototype keys, depth and byte caps, identity-like keys, and a check-then-use mutation using getters or a Proxy | ATK-PARAMS-01..13, plus property tests on the strict intake |
| Privilege escalation | Permission denied through the AI path with a **parity oracle** against the direct path; role claims ignored; non-boolean hook answers denied; spoofed page context; expired session; revoked permission before accept | ATK-PRIV-01..08 |
| Cross-tenant access | Resource in another tenant (feedback byte-identical to nonexistent), tenant id in input, host returning a foreign resource, store-level isolation as the application role, independent claims, confirmations, counters, audit | ATK-XTENANT-01..10 |
| Confirmation bypass | Model claims, no AI path to `decide`, expiry, reuse, wrong user or tenant, tampered parameters, definition drift, lost authorization, 100 concurrent-accept trials, deceptive text, audit down | ATK-CONFIRM-01..16 |
| Replay | Duplicate `callId`, new Gateway instance, 50 parallel submissions across two instances, retention boundary, per-tenant independence, model-chosen ids rejected | ATK-REPLAY-01..08 |
| Prompt-injected requests | Scripted compromised-model proposals from an injection corpus; **metamorphic** test (injection text must not change any decision); injection inside resource names and audited values; envelope has no free-text decision channel | ATK-INJECT-01..06 |

Supporting techniques: canary secrets on every output (ATK-SECRET), fault injection across all
ports (ATK-DEP), audit failure modes (ATK-AUDIT), architecture and forged-grant checks
(ATK-ARCH), generated-input invariants (fast-check), positive controls so denials are not vacuous
(POS-01..04), a capability-by-scenario coverage gate (FR-048), and nightly mutation testing of the
security package.

## Delivery Increments (input for `/speckit-tasks`)

Each increment lands together with the representative scenarios for what it adds. Classification
follows Principles XVIII and XIX.

| # | Increment | Stories | Scope | Status |
|---|-----------|---------|-------|--------|
| 1 | Workspace, TypeScript, lint rules, dependency-cruiser, contracts, Zod behavior pins | foundation | REQUIRED | done |
| 2 | Registry (R1-R12), strict intake, parameter validation and digest | US1, US2 | REQUIRED | done |
| 3 | Context factory, host ports, Gateway pipeline, authorize stage | US1, US3 | REQUIRED | done |
| 4 | Audit projection, scrubber, writer; audit and execute stages; grant minting | US4 | REQUIRED | done, merged (T089, T090) |
| 5 | PostgreSQL adapters: tenant policy, replay, rate counters | US3, US6 | REQUIRED (retained) | done |
| 5b | Persistent audit sink and migration (minimal) | US4 | REQUIRED | done, merged (T093 to T095) |
| 6 | Risk decision stage (no confirmation records) | US1, US5 | REQUIRED | done, merged (T104a) |
| 6b | Confirmation store, binding, service, endpoints | US5 | OPTIONAL | **not on `dev`**; store and binding on the parked `confirm-store` branch |
| 7 | Gateway test world and representative scenarios | US1, US3, US4 | REQUIRED | done, merged (T070, T052 to T054, T072, T073, T082 to T084) |
| 7b | Coverage gate, double-run, dependency matrix, mutation testing | US7 | FUTURE | not built on `dev`; some tooling on the parked `tooling` branch |
| 8a | Composition root, minimal development authentication, one integration path, minimal CI | delivery | REQUIRED | done, merged (T131, T132, T136, T071, T140) |
| 8b | Dockerfile, readiness endpoint, PR template | delivery | OPTIONAL | not built |
| 8c | Prometheus, Grafana, Kubernetes, Minikube, enterprise hardening | delivery | FUTURE | not built |

## Provisional Decisions and Open Clarifications

| Topic | Plan assumption | Status | If the answer differs |
|-------|-----------------|--------|-----------------------|
| Browser trust boundary | Display-only browser; server decides and executes everything (research D15) | **Resolved 2026-11-16**: confirmed | Execution model and trusted-input list change; re-plan |
| What constitutes a tenant | One active tenant per session context (D8) | **Resolved 2026-11-16**: confirmed; the demo may run one active tenant | Context and every store key change; re-plan |
| Do denied calls reach the model | Only outcome type, category, and field paths (D14) | **Resolved 2026-11-16**: confirmed | Change `toPlannerFeedback` and its tests |
| Tenant-configurable definitions | No; per-tenant narrowing only (D16) | **Resolved 2026-11-16**: confirmed (narrowing only) | Registry and enablement model change |
| Confirmation validity | 300 s default, 900 s maximum, may only shorten (D10) | OPTIONAL (confirmation is conditional); value retained | Configuration value only |

All five decisions are settled as of 2026-11-16, so none blocks M1.

## Remaining Risks and Known Limitations

This design does not make the system "secure"; it makes specific failures structurally hard.
What remains:

1. **In-process supply-chain compromise** can reach the restricted mint functions. Mitigation is
   dependency scanning and review, not this design.
2. **Post-execution audit failure**: the action has already happened. The writer calls optional audit-failure telemetry; the reference host installs no metrics/alerting backend;
   reconciliation is out of scope.
3. **Fixed-window rate limits** allow up to twice the limit across a window boundary.
4. **Outcome type reveals one bit**: "unknown action" versus "not allowed for you". Low impact;
   a mapping change removes it (D14).
5. **Replay protection** covers duplicate delivery and resubmission within the retention window. It
   does not authenticate senders.
6. **Confirmation UI** must render outside any DOM the AI can drive. This feature cannot enforce
   that; it is a hard requirement on the future UI feature.
7. **Single PostgreSQL** is a dependency: new proposals fail closed when their required state/audit operations fail; already-confirmed ALLOWED outcomes and already-running executors are not retroactively denied.
8. **Executor authority** (attention item 4) depends on executor implementations and review.
9. **Reference host** includes a development-only authentication stub; mitigated by explicit
   opt-in and a production refusal, but it is attack surface in any shared environment.
10. **Assumptions** are settled as of 2026-11-16 (see Provisional Decisions).
11. **Retained but not required code** (confirmation store, extended limiter and replay scenarios,
    coverage tooling) is not exercised end to end. It MUST NOT be wired into a production path until
    its trigger exists.

12. **Attempted action names in forensic audit** are planner-authored data, escaped to printable
    ASCII and capped at 64 characters. Recognized secret patterns are scrubbed, but arbitrary
    unknown canary-like strings can remain in actionId. This field must be treated as untrusted
    text by audit reviewers; it is never returned in planner feedback. M1 does not promise secrecy
    for arbitrary secrets the planner itself embeds in an attempted action name.

13. **Audit append cancellation window (QA #14, closed except for one window)**: when the audit
    writer gives up on an append (timeout, rejection, wrong-shaped or late answer) it aborts that
    attempt's `AuditAppendOptions.signal`. The PostgreSQL sink does not start once the signal is
    aborted, rolls back instead of committing if it is aborted before COMMIT, and the database
    itself bounds a blocked or slow statement (`lock_timeout`, `statement_timeout`,
    `writeTimeoutMs`, default 1500 ms). The unavoidable window is a COMMIT already in flight when
    the writer gives up: its outcome is uncertain, so an ALLOWED row may exist for a request that
    was denied and never executed. The trail then truthfully shows ALLOWED without EXECUTED; an EXECUTED failure does not prove the body started. The best-effort DENIED record may also exist;
    consumers must not infer execution from ALLOWED alone. Legacy sinks that ignore the signal
    retain their broader old uncertainty, including writes abandoned before COMMIT.
14. **Audit time and sequence precision**: the current Gateway clock supplies millisecond instants;
    PostgreSQL preserves microseconds. Finer nonzero fractions are rejected rather than silently
    aliased. Sequence allocation is a deterministic insertion tie-break, not evidence of commit
    order across concurrent transactions. Per-request PROPOSED/ALLOWED/EXECUTED ordering is tested.

## Complexity Tracking

No constitution violations to justify. The five-package split is a deliberate enforcement mechanism
for Principle III and is explained under **Structure Decision**. Code already built for Tier B
(confirmation store) and Tier C (coverage and mutation tooling) work is retained as Future Work; it
adds no obligation to M1 and is tracked under "Scope and Milestone M1".
