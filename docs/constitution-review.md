# Constitution 2.0.0 closure review: Feature 001, Milestone M1 (T145)

**Date**: 2026-11-16 | **Code reviewed**: `dev` `e610cf8` (docs-only changes since) | **Constitution**: `.specify/memory/constitution.md` v2.0.0
**Evidence**: [architecture.md](./architecture.md), [validation-report.md](./validation-report.md), `npm run test:m1-gate`, the test files named per row.

This review **does not claim the system is "secure"**. It records, per principle, whether M1 satisfies the rule, on what evidence, and with which limits.
"Satisfied" means the rule holds for what M1 delivers (a security boundary with one reference host and three demo capabilities), checked by focused
representative tests, not by an exhaustive catalogue. **Maintainer sign-off is not recorded here**: this document is input to it, not the sign-off.

## 1. Tier A: mandatory invariants

| Principle | Status | Evidence | Limit |
|-----------|--------|----------|-------|
| I. The LLM is an untrusted planner | satisfied | The AI layer holds one frozen `submit`; identity, tenant, run metadata, call id, clock, ids come from trusted code (`apps/reference-host/src/compose.ts`, `packages/security/src/gateway/submitter.ts`). `tests/integration/reference-host.test.ts` group 6, `tests/architecture/graph.test.ts`, gate categories "architecture bypass" and "hostile content" | Object-capability boundary, not a sandbox for arbitrary same-process JavaScript (limitation 6) |
| II. LLM output alone can never authorize | satisfied | Claims in text, parameters or envelope keys are rejected or inert: `tests/security/privilege-escalation.test.ts` (ATK-PRIV-02), `prompt-injection.test.ts` (ATK-INJECT-01, 02, 05, literal claims), `cross-tenant.test.ts` (ATK-XTENANT-03) | Representative corpus (46 injection strings), not exhaustive |
| III. Deterministic Policy Gateway, single chokepoint | satisfied | Stage order in `packages/contracts/src/core.ts` and `create-gateway.ts`; executors need a single-use grant bound to five fields (`execution-runtime.ts`, `mint/grant-registry.ts`); package graph and mint restriction (`dependency-cruiser.config.cjs`, `tests/architecture/`) | Confirmation stage is a position only (limitation 9). Supply-chain compromise of in-process code can reach the mint functions (plan.md Remaining Risks 1) |
| IV. Default deny, explicit allowlists | satisfied | Empty global allowlist denies (`unknown-action.test.ts` ATK-UNKNOWN-05; `reference-host.test.ts` group 1b; `packages/security/src/registry/enablement.test.ts`); exact-match registry; reserved names | Tenant narrowing can only disable (D16) |
| V. No secrets or credentials to the AI | satisfied | Feedback is outcome + category + field paths (`gateway/feedback.ts`); audit projection and scrubber; canaries: `secret-extraction.test.ts` (ATK-SECRET-01..04), `audit-postgres.test.ts` P4 | The attempted action name is model-authored text kept in the trail (escaped, 64 characters, limitation 5); unknown secret-like strings inside it are not guaranteed removed |
| VI. Client-side DOM redaction | **not applicable** to this feature | No browser DOM capture or browser-to-model transmission path is delivered (spec Out of scope); raw proposal text is still untrusted | Owned by the later UI/redaction feature |
| VII. No arbitrary execution capability | satisfied | No `eval`, shell, network or selector capability in production code: `tests/architecture/static-scan.test.ts`, `module-loaders.test.ts`, ESLint rules; FORBIDDEN reserved names (`registry/reserved-names.ts`; `unknown-action.test.ts` ATK-UNKNOWN-02) | A future capability's executor is trusted code; this boundary does not review its body |
| VIII. Registered typed capabilities | satisfied | Registry validation plus executor/allowlist binding collectively enforce R1 to R12 (`registry.rules.test.ts`, `enablement.test.ts`); R7 and R10 are binding checks, not `buildRegistry` checks; drift test `tests/security/registry-drift.test.ts` | Three demo capabilities only; `@dap/actions` is empty |
| IX. Backend authorization is authoritative | satisfied | The authorize stage asks the host live; the context carries no permissions; only a literal `true` allows (`gateway/stages/authorize.ts`; ATK-PRIV-01 parity and ATK-PRIV-06; `review-fixes.test.ts` AUTHZ-01) | The host's permission and resource ports are the host's responsibility; the demo ports are fakes (`apps/reference-host/src/host-ports.ts`) |
| X. No privilege amplification | satisfied | Executors receive the requesting user's own minted context (`execute.ts`; `positive.test.ts` ATK-PRIV-04; `test-world.gateway.test.ts`) | "Delegated authority" at the executor edge is a convention a future executor could break by using a service credential (plan.md attention item 2) |
| XII. RAG is untrusted data | satisfied for proposal text; retrieval-specific controls not applicable | XII also covers user prompts and tool text: strict intake and literal-string injection tests keep them from granting authority. No retrieval/prompt assembly exists here. Audit may retain allowlisted model-authored values | Retrieval-specific delimiting belongs to a later retrieval feature |
| XIV. State-changing actions are auditable | satisfied with limits | Durable `ALLOWED` before every execution, one decision per proposal, append-only PostgreSQL trail: `audit-postgres.test.ts`, `audit-trail.test.ts`, `reference-host.test.ts` group 4, `audit.test.ts` (ATK-AUDIT-01..05 on the real Gateway), `audit-migration.test.ts` | Limitations 1, 3 and 4: commit-acknowledgement window; best-effort PROPOSED / non-ALLOW / EXECUTED; volume not bounded |
| XV. Controls survive full LLM compromise | satisfied | Hostile-planner scenarios; per-turn execution cap (`execution-cap.test.ts`, default 8); bounded malformed flood; per-proposal budget | The 10,000-proposal flood and multi-replica runs are FUTURE; a bounded in-memory example exists (`rate-replay.gateway.test.ts`) but is not a required claim |
| XVI. Least privilege, strict schemas, minimal context, fail closed | satisfied | Strict validation at the relevant boundaries; policy-port faults before confirmed ALLOWED deny; later execution faults preserve ALLOWED and report failure (`hook-wrapper.ts`, `pipeline.ts`; `test-world.gateway.test.ts` faulted ports, `dependency-failure.test.ts` hangs); the planner sees minimal feedback | Representative ports only, not the 36-case matrix |
| XVII. Focused security tests per capability | satisfied for scope | `npm run test:m1-gate` runs the representative suites (unknown action, malformed parameters, prompt injection, privilege escalation, IDOR/cross-tenant, secret extraction, positive control, audit-before-state-change, dependency failure, architecture bypass) and CI runs it | Not an exhaustive catalogue (Tier C). Tests were not skipped, weakened or deleted to pass: the 76 `todo` tests are not hidden, they are tagged |

Principles XVIII and XIX are in section 4.

## 2. Tier B: conditional controls

| Item | Trigger | Applies to M1? | Status |
|------|---------|----------------|--------|
| XI Tenant isolation | A feature stores or retrieves tenant-owned data | **Yes**: audit, replay, rate and tenant-policy rows are tenant-owned | satisfied: tenant from the trusted context only; forced RLS on every `sec_*` table keyed on `app.tenant_id` (`db/migrations/`); `cross-tenant.test.ts`, `cross-tenant-store.test.ts`, `audit-postgres.test.ts` P3, conformance isolation suites. The demo may run one active tenant; the architecture is tenant-ready |
| XIII Confirmation | A HIGH or CRITICAL capability, or a confirmation-required MEDIUM, is delivered | **Only in the fallback form.** The host registers a HIGH demo capability (`demoPublishNote`) and a MEDIUM one with a recorded opt-out; neither can be *executed* needing confirmation | The fallback clause of XIII holds: the Gateway returns `REQUIRES_CONFIRMATION`, never `ALLOWED`, and the executor stays at zero (`reference-host.test.ts` group 5, `execution-cap.test.ts`, `risk-gate.gateway.test.ts`). The confirmation **service, store, persistence and endpoints are not built**; the Gateway's `confirmations` is a fail-closed stub and the host's store and channel placeholders reject every call. No capability that needs confirmation can execute |
| Replay protection | Retry-sensitive or state-changing actions | **Yes**: `demoSaveNote` changes state | satisfied for duplicate delivery inside one turn (`rate-replay.gateway.test.ts`, `reference-host.test.ts` "same proposal replayed"). Not an authentication of senders; a host-side new session can re-run a provider call id (limitation 7) |
| Shared state across copies | More than one copy runs | **No**: single process | not a prerequisite. PostgreSQL adapters exist and are used by the reference host, but there is **no deployed multi-replica test**, so no multi-replica guarantee is claimed |

## 3. Tier C: deferred (never blocked this feature)

| Item (constitution "Future Work") | State | Tracked in |
|-----------------------------------|-------|------------|
| Distributed rate limiting, denial throttling across replicas | PostgreSQL shared-counter/block adapters exist; deployed distributed guarantees are not validated | spec "Future Work"; plan.md Remaining Risks 3 (fixed-window limits allow up to twice the limit across a boundary) |
| Shared-state guarantees across replicas | not tested | spec "Future Work" (FR-036 in full) |
| Exhaustive attack catalogue; coverage matrices and gate | catalogue partly defined in testkit, run only representatively; gate not built | tasks T126, T127 (FUTURE); [contracts/security-test-catalogue.md](../specs/001-ai-security-foundation/contracts/security-test-catalogue.md) status table |
| Automated mutation infrastructure, independent oracles | no automated mutation job; independent oracle implementations and manual QA mutations exist | T128 (FUTURE) |
| Flood and concurrency stress tests | bounded adapter and in-process concurrency tests exist; the PostgreSQL real-Gateway flood is not built | `tests/security/rate-abuse.test.ts` todo (FUTURE) |
| 36-case dependency matrix; double-run determinism | definitions exist; runs not built | T123, T121 (FUTURE) |
| Kubernetes, Prometheus, Grafana, tracing, SIEM | not built | T138, T139 (FUTURE) |

Parked work that exists on branches but **not on `dev`**: `confirm-store` (confirmation store and binding) and `tooling` (coverage and determinism
tooling). `main` is reserved and unrelated.

## 4. Delivery scope (XVIII) and scope discipline (XIX)

| Check | Result | Evidence |
|-------|--------|----------|
| One bounded, independently demonstrable slice | respected | M1 defined in the spec Scope Declaration; the slice runs end to end in `tests/integration/reference-host.test.ts` and is gated by `npm run test:m1-gate` |
| No infrastructure beyond what the slice needs | respected | No Kubernetes, Prometheus, Grafana, Docker image, HTTP service or confirmation service on `dev`. CI is one job with one PostgreSQL service |
| Future work recorded explicitly | respected | spec "Future Work"; section 3; the 76 `todo` tests |
| Every item classified REQUIRED / OPTIONAL / FUTURE | respected | `tasks.md`; each remaining `todo` carries `(OPTIONAL ...)` or `(FUTURE ...)`, and `npm run test:m1-gate` **fails** if one does not (`scripts/m1-gate-check.mjs`) |
| Counts unchanged by this closure | respected | OPTIONAL **21**, FUTURE **9** (the lists under "OPTIONAL and FUTURE tasks" in `tasks.md`); REQUIRED open **0** after T142 to T145 |
| Existing controls were not removed to meet scope | respected for this closure | T142 to T145 changed documentation only (`git diff --stat dev..HEAD` lists no code, script, CI, migration or manifest file); no Tier A control was removed or weakened by it |

Two honest notes: (a) tasks T081, T107, T108 and T123 have most of their testkit code on `dev` but stay unchecked because their own acceptance
(catalogue-wide real-Gateway runs, the matrix) is OPTIONAL or FUTURE; the counts therefore count them as open. (b) The task list T140 once named
`npm audit`, gitleaks, a container build and Dependabot; the reduced scope dropped them, so **CI has no dependency or secret scanning**.

## 4a. Accepted M1 residual risks and who owns each

| Residual risk | Why accepted for M1 | Owner (later) |
|---------------|---------------------|---------------|
| Confirmation for HIGH/CRITICAL operations does not exist; such capabilities cannot run | Fails closed; no capability needs it yet | The confirmation feature (OPTIONAL T096 to T106), triggered by the first HIGH/CRITICAL or confirmation-required MEDIUM capability; its UI must render outside any DOM the AI can drive (plan.md Remaining Risks 6) |
| Dev authentication is a stub; real authentication, sessions and permission systems do not exist | The host ports are contracts; the stub refuses production | The host application feature that supplies `AuthenticationPort`, `PermissionChecker`, `ResourceAuthorizer` (not yet specified) |
| No production executors (`@dap/actions` empty); executor authority is a convention | A boundary can be proven before real capabilities exist | Each later capability feature, with its mandatory review item and parity test (plan.md attention item 2) |
| In-process supply-chain compromise reaches the mint functions; no dependency or secret scanning in CI | Out of the reduced T140 scope | A dependency-hygiene or release-hardening feature (T140's original items, now OPTIONAL/FUTURE) |
| Post-execution audit failure and audit commit-acknowledgement window | Bounded and documented; no cross-system atomicity claimed | Operations and reconciliation work (plan.md Remaining Risks 2, 13) |
| Audit retention, purge scheduling and volume | `purgeExpiredState` exists but nothing schedules it; audit never purges | Deployment/operations feature (data-model.md) |
| Fixed-window rate limits allow up to twice the limit across a boundary; single PostgreSQL | Course-project scale | Tier C (distributed limiting, HA) |
| "Unknown action" versus "not allowed for you" reveals one bit | Low impact; a mapping change removes it (D14) | The UI/feedback feature, if it matters |
| No metrics, readiness endpoint, HTTP service | OPTIONAL/FUTURE | T135, T138 |

## 5. Known limitations

Each item below was checked against code, tests or documents; the pointer shows where. Owners follow section 4a: host integration owns 6–9, 12 and 17; operations owns 1–5, 15 and 16; tooling/docs owns 10, 11 and 13; dependency hygiene owns 14. Items 18–20 name their owners explicitly.

1. **Audit commit-acknowledgement window.** If the audit writer gives up while a `COMMIT` is in flight, the outcome is uncertain: an `ALLOWED` row
   may exist for a request that was denied and never executed. The trail then shows `ALLOWED` without `EXECUTED`; EXECUTED failure may describe inability to start or an unknown outcome rather than a body invocation; a best-effort `DENIED` may also exist. Consumers must not infer execution from `ALLOWED` alone. A PostgreSQL write that has not
   started or is aborted before `COMMIT` rolls back; statements are bounded by `lock_timeout` and `statement_timeout` (1500 ms default).
   (`docs/review-fixes.md` "Retained limits"; plan.md Remaining Risks 13; `packages/security/src/state/postgres/audit.ts`;
   `tests/integration/audit-postgres.test.ts` "QA16".)
2. **`ALLOWED` is a policy decision, not proof of a side effect.** There is no exactly-once guarantee and no cancellation of a trusted executor
   that is already running when the proposal budget expires. An authorized attempt that cannot start, or whose result is unknown, reports
   execution failure / try later; a known success keeps `ok` even if recording the result fails. (`docs/review-fixes.md`; `execute.ts` header.)
3. **Recording of `PROPOSED`, non-ALLOW decisions and `EXECUTED` is best effort.** A selectively failing sink can omit them, including leaving an
   `ALLOWED` row without its `PROPOSED` row. Complete trails are asserted with healthy storage only; complete persistence during outages is not
   claimed. (`docs/review-fixes.md`; `decision-auditor.ts`.)
4. **The 200-envelope malformed flood bound limits limiter work, not ingress or audit volume.** Shared-store calls drop from 395 to 32 for 200
   malformed proposals, but two audit events per proposal (one proposal, one decision) are still written; there is no load shedding.
   (`docs/review-fixes.md` "Independent QA follow-up"; `tests/security/review-fixes.test.ts` RATE-01.) Because the durable `ALLOWED` is required
   before **every** execution (stricter than spec FR-040), a long audit outage also denies SAFE actions (plan.md "Items needing attention" 1).
5. **The attempted action name in the audit trail is planner-authored data**, escaped to printable ASCII, scrubbed of recognized secret patterns and
   capped at **64 characters** (an empty name is stored as NULL). Unknown secret-like strings inside it can remain; reviewers must treat it as
   untrusted text. It is never returned to the planner. (`packages/security/src/audit/event-builder.ts`; plan.md Remaining Risks 12;
   `secret-extraction.test.ts` "(1b)".)
6. **The AI boundary is an object-capability boundary, not a sandbox.** `AiSession` limits what the AI layer is handed; it is not isolation against
   arbitrary JavaScript, prototype tampering or process globals in the same process, and `composeReferenceHost` and its trusted result are host
   APIs that must never be exposed as model tools. (`apps/reference-host/README.md`; `reference-host.test.ts` "QA host boundary probes".)
7. **A host-side second `openSession` starts a new turn and can re-run a provider call id.** Within one turn a reused id is a replay; the same id in
   a new host-opened turn is a new proposal. The AI cannot open sessions. This is not exactly-once execution across host retries.
   (`compose.ts`; `apps/reference-host/README.md`.)
8. **Development authentication is a deliberately unsafe stub**, not an authentication system. It is opt-in (`DAP_ALLOW_DEV_AUTH=1`), reads sessions
   from the environment, and refuses to start when `NODE_ENV` is production (surrounding whitespace and case ignored) or when the session table is
   malformed, empty or duplicated. (`apps/reference-host/src/dev-auth/index.ts`, `startup.test.ts`.)
9. **The confirmation service, its persistence and its endpoints are not built.** `createPolicyGateway(...).confirmations` is a fail-closed stub;
   the host's confirmation store and channel reject every call; there is no `sec_confirmations` table. HIGH, CRITICAL and confirmation-required
   MEDIUM proposals end at `REQUIRES_CONFIRMATION` and their executors never run. (`create-gateway.ts`; `reference-host.test.ts` group 5.)
10. **The M1 gate is representative, not exhaustive.** Exhaustive catalogue runs, automated mutation/determinism infrastructure, deployed flood/multi-replica stress and the 36-case dependency matrix are parked; existing direct-adapter flood and in-process shared-store concurrency tests do run (section 3). A green gate means the representative suites passed and the
    remaining `todo` tests are tagged; it does not mean every attack in the catalogue was run. (`scripts/m1-gate.mjs` header.)
11. **CI was validated by local replay and actionlint only; it has not had a first GitHub Actions run.** Hosted-runner specifics (for example the
    presence of `psql` on `ubuntu-24.04`) are unverified. (`validation-report.md`.)
12. **The demo state-changing capability is MEDIUM with a recorded confirmation opt-out**, because registry rule R6 forbids SAFE and LOW capabilities
    from changing state. M1 criterion 1 ("SAFE or LOW ... executes") is demonstrated with the host's SAFE `demoLookup` and, in the test world, the LOW
    `testLowNavigate`; the host's state-changing path is the MEDIUM opt-out `demoSaveNote`. (`apps/reference-host/src/capabilities.ts`; `packages/security/src/registry/build-registry.ts` R5, R6.)

Further limits found while writing this review (each verified):

13. **A stale script**: `package.json` lists `npm run coverage:security`, but `packages/testkit/dist/cli/coverage.js` does not exist on `dev` (the CLI
    is on the parked `tooling` branch); running it fails with `MODULE_NOT_FOUND`. Not part of M1 or CI.
14. **Unused declared dependencies**: `apps/reference-host/package.json` lists `fastify`, `pino` and `prom-client`; no source file imports them.
15. **Audit time and order**: `occurred_at` is the Gateway clock at millisecond precision; `seq` is an insertion tie-break, not commit order across
    concurrent transactions. (plan.md Remaining Risks 14; migration 020.)
16. **Purge is not scheduled**: `purgeExpiredState` is not scheduled in M1. Replay also reclaims an expired matching key during claim; rate counters select a new window. This is not general background reclamation.
17. **No page context**: the reference host's `PageContextProvider` always answers `null` (`host-ports.ts`), so page narrowing is exercised only by
    the test world (`review-fixes.test.ts` TEST-02).

## 6. Conclusion

Representative M1 acceptance criteria are evidenced **as scoped above**, with maintainer sign-off pending. The reviewed Tier A controls have the qualifications above, with the limits listed. Tier B items that apply (tenant isolation,
replay) are satisfied; the confirmation trigger is met only in its fallback form; multi-replica guarantees are not claimed. Tier C is deferred and
tracked. Nothing here claims production readiness, a production authentication system, or exhaustive security coverage.


18. **Budget scope and host-managed turns.** Execution slots are keyed by tenant, AI session and turn, with a local conservative pre-check and a shared-store counter. A host can mint new turns; this is not a lifetime user execution cap. The default denial throttle counts the sixth countable denial in a session (threshold five); audit_unavailable does not count. Per-user/tenant windows remain separate. Owner: integrating host feature (`limits/limiter.ts`, `gateway/denial-throttle.ts`).
19. **Session and process lifetime.** Context and authorization stages check expiry; the development principal is bound at openSession, not re-authenticated from the token table on each submit. No real revocation mechanism is delivered. Pool defaults are 10 clients and a 2000 ms acquisition timeout; database append timeouts bound individual statements, not an entire multi-statement transaction or an executor. Owner: authentication/deployment integration (`compose.ts`, `context.ts`, `authorize.ts`, `state/postgres/pool.ts`).
20. **Database administrative trust.** Forced RLS and append-only triggers constrain ordinary statements, including owner DML while triggers are installed; they do not defend against a database administrator altering the table/policies or disabling triggers. The demo host validates the URL shape, not that its credentials are dap_app: operators must supply the documented least-privilege role. Owner: deployment/operations (`020_sec_audit_events.sql`, `config.ts`, `pool.ts`).
