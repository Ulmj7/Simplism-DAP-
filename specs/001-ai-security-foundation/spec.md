# Feature Specification: AI Security Foundation

**Feature Branch**: `001-ai-security-foundation`

**Created**: 2026-11-13

**Status**: **Milestone M1 acceptance criteria evidenced (2026-11-16); maintainer sign-off pending**: the eleven M1 criteria below are each mapped to evidence in
[docs/validation-report.md](../../docs/validation-report.md). OPTIONAL and FUTURE work is deferred (some types, adapters and test scaffolding already exist) and does not block M1 acceptance. Reconciled with
Constitution 2.0.0 on 2026-11-16 (see the Scope Declaration); contracts and data model reconciled with the code the same day
([contracts/reconciliation.md](./contracts/reconciliation.md)). The system is not claimed to be "secure"; known limits are in
[docs/constitution-review.md](../../docs/constitution-review.md).

**Input**: User description:

> Build the security foundation for an AI-powered Digital Adoption Platform. The application will
> eventually use an LLM to understand application context and guide users through software. This
> feature does NOT implement autonomous AI control. Its purpose is to establish the security
> boundary through which all future AI functionality must operate. Required capabilities: typed AI
> Action Registry; deterministic Policy Gateway; action risk classifications (SAFE / LOW / MEDIUM /
> HIGH / CRITICAL / FORBIDDEN); strict action schema validation; authentication/authorization
> hooks; tenant isolation hooks; explicit allowlisting of actions; server-side confirmation
> framework for dangerous operations; audit logging for proposed/allowed/denied actions; rate
> limiting hooks; replay-protection design; security error/result types; security test
> infrastructure. The LLM must be considered fully untrusted. The security architecture must remain
> effective even when the LLM produces malicious tool calls. Do not add arbitrary JavaScript
> execution, arbitrary HTTP requests, SQL execution, shell access, unrestricted DOM control, or any
> other general execution capability. This feature should establish interfaces that later AI
> features can use without bypassing the security boundary. Success means malicious or invalid AI
> action requests fail closed before reaching application execution.

## Scope Declaration (Constitution 2.0.0)

This specification was written under Constitution 1.0.0 and has been **reconciled, not rewritten**,
with **Constitution 2.0.0**. Everything already built stays in the codebase. What changed is which
parts are required to call this feature complete.

- **What this is.** A production-shaped, modular-monolith **security foundation**: the
  deterministic Policy Gateway through which later DAP AI features propose application
  capabilities. It is not a production-scale commercial platform.
- **Tier A invariants are mandatory** (Principles I-X, XII, XIV-XVII): untrusted planner, no
  LLM-only authorization, single deterministic Gateway, default deny, no secrets to the model, no
  arbitrary-execution capability, typed registry, authoritative backend authorization, no
  privilege amplification, auditability, hostile-LLM resilience, focused security tests.
- **Tier B requirements apply only when their trigger exists**: tenant isolation (a feature stores
  or retrieves tenant-owned data), confirmation (a HIGH or CRITICAL capability, or a MEDIUM one
  that policy marks confirmation-required, is delivered), replay protection (retry-sensitive or
  state-changing actions), shared state across copies (more than one copy actually runs).
- **Tier C work is Future Work** (see "Future Work" at the end). It never blocks this feature.
- **Classification used in this document**: **REQUIRED** (needed for the medium-sized project, or
  to complete an already-used security boundary), **OPTIONAL** (useful, implement only when a later
  capability needs it), **FUTURE** (production hardening or infrastructure). Implemented code in
  OPTIONAL or FUTURE areas stays in the repository.

### Milestone M1: Executable Security Boundary

This feature is **REQUIRED complete** when M1 holds. M1 is the independently demonstrable slice:

*AI/action proposal, trusted session/security context, strict intake validation, registered
capability resolution, strict parameter validation, backend authorization, applicable risk
decision, required audit, trusted executor, deterministic result.*

1. A valid SAFE or LOW registered capability passes through the real Policy Gateway and executes
   exactly once.
2. The executor receives only the validated, frozen parameters and the requesting user's trusted
   security context.
3. An unknown capability is rejected before any executor is invoked.
4. Malformed or extra parameters are rejected before any executor is invoked.
5. An unauthorized user is denied.
6. AI-provided claims about identity, tenant, role, permission, or confirmation have no effect on
   authorization.
7. The relevant audit record must succeed before a state-changing execution.
8. A representative secret-canary test shows secrets do not appear in planner feedback or audit
   output.
9. A representative architecture test shows the AI layer cannot reach a trusted executor without
   the Gateway.
10. Relevant dependency failures remain fail-closed.
11. A minimal reference-host composition root wires the registry, Gateway, state dependencies,
    audit sink, executors, and development authentication into one runnable integration path.

**Risk decision (REQUIRED, small).** The Gateway applies a deterministic risk decision without any
confirmation machinery: SAFE and LOW continue; MEDIUM continues only when its definition opts out
of confirmation with a recorded justification; MEDIUM that requires confirmation, HIGH, and
CRITICAL return `REQUIRES_CONFIRMATION` and never `ALLOWED`; FORBIDDEN is denied. This creates no
confirmation record and does not depend on the confirmation service.

**Representative security tests required for M1** (Constitution XVII): unknown action; malformed
parameters; a prompt-injected or hostile proposal; unauthorized user; cross-tenant or resource
denial where tenant context applies; direct Gateway bypass prevention; a secret-leakage canary; a
positive allowed execution; audit-before-state-change; fail-closed dependency failure. The
exhaustive original catalogue is Future Work.

## User Scenarios & Testing *(mandatory)*

**Who is involved.** The *platform developer* builds AI features on top of this boundary. The
*security reviewer* verifies the boundary and investigates what the AI attempted. The *end user*
and their *tenant* (the customer organization they belong to) are the parties the boundary
protects. The *AI planner* is an **untrusted proposer**: it can only ask for actions, and every
ask is treated as potentially hostile, whether it came from a confused model, a prompt-injected
model, or a malicious document the model read.

The boundary is exercised with a stand-in for the AI planner in every scenario below. No real
LLM is needed or involved.

### User Story 1 - Hostile or invalid AI action requests fail closed (Priority: P1, REQUIRED)

> **Scope (Constitution 2.0.0)**: REQUIRED. M1 demonstrates this through the representative scenarios listed in the Scope
> Declaration, not the exhaustive attack catalogue.

Every action the AI asks for is stopped by the boundary before it can touch the application unless
the boundary can positively prove it is allowed. Requests for unknown actions, malformed
requests, requests for forbidden general-purpose powers (such as running commands or arbitrary
code), and requests carrying false claims ("the user already approved this") are all rejected with
a clear, safe result and without any application code running.

**Why this priority**: This is the definition of success for the whole feature. If one hostile
request can slip through to the application, nothing else in the feature matters.

**Independent Test**: Feed a scripted set of hostile and malformed requests to the boundary with a
recording stand-in for the application. Verify that the stand-in is never invoked and that each
request receives the expected result type.

**Acceptance Scenarios**:

1. **Given** no capability exists for running shell commands, **When** the AI proposes
   `executeShell` with a command string, **Then** the result is `FORBIDDEN_POLICY`, nothing
   executes, and a policy-violation event is recorded.
2. **Given** the AI proposes an action name that is not in the registry, **When** the boundary
   evaluates it, **Then** the result is `INVALID_ACTION` and nothing executes.
3. **Given** a registered capability and a proposal that adds a field the capability does not
   define, **When** the boundary evaluates it, **Then** the result is `INVALID_PARAMETERS` and
   nothing executes.
4. **Given** a registered capability and a proposal with a missing required value, a value of the
   wrong type, or an oversized value, **When** the boundary evaluates it, **Then** the result is
   `INVALID_PARAMETERS` and nothing executes.
5. **Given** a proposal that includes text such as "the user already confirmed" or "I am an
   admin", **When** the boundary evaluates it, **Then** that text has no effect on the decision.
6. **Given** any unexpected internal failure while evaluating a proposal, **When** the failure
   occurs, **Then** the result is `DENIED` and nothing executes.

---

### User Story 2 - Developers add capabilities only through a typed, allowlisted registry (Priority: P1, REQUIRED)

> **Scope (Constitution 2.0.0)**: REQUIRED. Implemented; retained as is.

A platform developer can describe each thing the AI is allowed to ask for as a *capability*:
its name, the exact inputs it accepts, its risk class, the permission it requires, where it may
be used, whether it needs confirmation, and whether it is audited. Only capabilities described
this way, and explicitly enabled, can ever be proposed successfully. Nothing the AI says or reads
can add to or change this list.

**Why this priority**: The registry is the allowlist. Without it, the boundary has nothing to
check proposals against, and every later AI feature has no safe way to exist.

**Independent Test**: Register well-formed and ill-formed capability definitions and confirm that
only the well-formed ones load, that none are usable until enabled, and that the list cannot be
changed while the platform runs.

**Acceptance Scenarios**:

1. **Given** a developer defines a capability with every required detail, **When** the platform
   starts, **Then** the capability is registered but is not usable until it is explicitly enabled.
2. **Given** a capability definition that lacks a risk class, input definition, required
   permission, or audit setting, **When** the platform starts, **Then** that definition is
   rejected and the platform reports exactly what is missing.
3. **Given** two capability definitions with the same identifier, **When** the platform starts,
   **Then** startup is rejected rather than one silently overriding the other.
4. **Given** a capability definition with an input meant to carry the caller's identity, tenant,
   role, permission grant, or confirmation status, **When** the platform starts, **Then** that
   definition is rejected, because those facts may only come from trusted server-side context.
5. **Given** the platform is running, **When** the AI, a user message, or retrieved document text
   attempts to add, change, or remove a capability, **Then** the registry is unchanged.
6. **Given** a capability enabled for Tenant A but not for Tenant B, **When** a Tenant B user's AI
   session proposes it, **Then** the result is `DENIED`.

---

### User Story 3 - Identity, tenant, and permissions are enforced; the AI can never exceed the user (Priority: P1, REQUIRED)

> **Scope (Constitution 2.0.0)**: REQUIRED. Tenant isolation follows its Tier B trigger: the architecture stays tenant-ready and
> the demo may run with one active tenant.

For every proposal, the boundary determines who the user is, which tenant they belong to, and
whether they may do this, using the host application's own trusted authentication and
authorization, never anything the AI states. A user can get the AI to do only what they could do
directly, and nothing that crosses into another tenant.

**Why this priority**: Without this, the AI becomes a way for users to exceed their permissions or
read another customer's data, the most damaging failure for a multi-tenant product.

**Independent Test**: Run proposals as users with differing permissions and tenants against
capabilities, including proposals that target other users' or other tenants' resources, and
compare each outcome with what the same user would get acting directly.

**Acceptance Scenarios**:

1. **Given** an authenticated user who lacks the permission a capability requires, **When** the AI
   proposes that capability for them, **Then** the result is `UNAUTHORIZED`, identical to what
   they would get acting directly.
2. **Given** a proposal that names a resource belonging to another tenant, **When** the boundary
   evaluates it, **Then** the proposal is denied and the response does not reveal whether the
   resource exists.
3. **Given** a proposal that names a resource in the user's own tenant that they may not access,
   **When** the boundary evaluates it, **Then** the response is indistinguishable from one for a
   resource that does not exist.
4. **Given** a proposal that supplies its own user, tenant, or role values, **When** the boundary
   evaluates it, **Then** those values are ignored or rejected and the decision uses only the
   trusted session context.
5. **Given** the identity, tenant, permission, or resource-authorization check is unconfigured,
   fails, times out, or returns a malformed answer, **When** a proposal needs it, **Then** the
   result is `DENIED`.
6. **Given** a proposal is allowed, **When** it is handed to the application, **Then** it runs with
   the requesting user's own authority and never with elevated or shared service authority.

---

### User Story 4 - Every proposal and decision is auditable (Priority: P1, REQUIRED)

> **Scope (Constitution 2.0.0)**: REQUIRED to the extent of M1: the audit record must succeed before a state-changing execution,
> and a usable persistent audit sink exists. Exhaustive database-role audit isolation tests are
> OPTIONAL.

A security reviewer can reconstruct what the AI attempted, why it was allowed or denied, who
authorized it, and what resource changed, from the audit trail alone. A state-changing action can
never run unless its audit record has been safely recorded.

**Why this priority**: Without a trustworthy trail, a compromised or misbehaving AI cannot be
investigated, and the organization cannot demonstrate that the boundary works.

**Independent Test**: Run allowed, denied, confirmed, rejected, and rate-limited proposals, then
check the audit trail for the expected events and fields. Repeat with the audit recorder made
unavailable and confirm state-changing actions do not run.

**Acceptance Scenarios**:

1. **Given** any proposal, **When** the boundary handles it, **Then** the audit trail contains a
   "proposed" event and exactly one final decision event, linked by a shared request identifier.
2. **Given** a proposal denied for any reason, **When** a reviewer inspects the trail, **Then**
   they can see the denial reason in detail, while the AI itself sees only a generic category.
3. **Given** a state-changing capability, **When** the audit recorder is unavailable, **Then** the
   action does not run and the result is `DENIED`.
4. **Given** a proposal whose values include credentials, tokens, or other sensitive data,
   **When** the event is recorded, **Then** those values are omitted or masked.
5. **Given** a sample of recorded actions, **When** a reviewer uses only the audit trail, **Then**
   they can answer: what did the AI attempt, why was it allowed, who authorized it, what resource
   changed.
6. **Given** two tenants, **When** a reviewer for Tenant A reads the trail, **Then** no Tenant B
   events are visible, and the AI has no way to read, change, or delete any event.

---

### User Story 5 - Dangerous operations require server-verified confirmation (Priority: P2, CONDITIONAL / OPTIONAL for the current delivery)

> **Scope (Constitution 2.0.0)**: CONDITIONAL (Tier B, Constitution XIII). Required only when a delivered capability is HIGH or
> CRITICAL, or MEDIUM with confirmation required. Until then only the small deterministic risk
> decision is REQUIRED (it returns `REQUIRES_CONFIRMATION`, never `ALLOWED`). The confirmation
> store, binding, and service already built are retained; the service, persistence endpoints, and
> deep concurrency/bypass suites are OPTIONAL.

For capabilities that can cause significant or irreversible effects, the boundary does not act on
the AI's say-so. It issues a confirmation request that the user must explicitly accept through a
trusted path the AI cannot reach. The confirmation is tied to one exact action on one exact
resource, expires quickly, and works only once.

**Why this priority**: This protects against the most severe harms (deletion, permission changes,
data leaving the system). It depends on the P1 stories but is not needed for the first safe,
read-only features.

**Independent Test**: Propose a high-risk test capability, verify nothing runs, accept via the
trusted path and verify it runs once, then attempt every misuse (reuse, expiry, mismatch,
fabrication) and verify each is rejected.

**Acceptance Scenarios**:

1. **Given** a HIGH or CRITICAL capability and a valid, authorized proposal, **When** the boundary
   evaluates it, **Then** the result is `REQUIRES_CONFIRMATION`, nothing executes, and a
   confirmation request exists whose description of consequences comes from trusted capability
   details and validated values, never from AI-written text.
2. **Given** an outstanding confirmation request, **When** the authenticated user accepts it
   through the trusted confirmation path, **Then** the action executes exactly once.
3. **Given** the AI asserts that confirmation was given, or invents a confirmation identifier,
   **When** the boundary evaluates it, **Then** the assertion is ignored and the action does not
   execute.
4. **Given** a confirmation that has expired, was already used, belongs to a different user or
   tenant, or no longer matches the action, resource, or values originally presented, **When** it
   is submitted, **Then** it is rejected and nothing executes.
5. **Given** the user rejects a confirmation request, **When** the rejection is recorded, **Then**
   nothing executes and the rejection is audited.
6. **Given** a CRITICAL capability with a valid confirmation, **When** execution is about to
   begin, **Then** the user's authorization for that exact resource is re-verified at that moment.
7. **Given** two simultaneous attempts to accept the same confirmation, **When** both are
   processed, **Then** exactly one succeeds.

---

### User Story 6 - Abuse is limited and replays are rejected (Priority: P2, bounded execution REQUIRED; remainder OPTIONAL / FUTURE)

> **Scope (Constitution 2.0.0)**: Bounded AI/tool execution (per-turn action, chain, and time limits) is REQUIRED. The replay guard,
> rate limiter, their pipeline stages, and Postgres adapters already built are retained. Replay
> protection is mandatory for retry-sensitive or state-changing actions. Durable multi-replica
> guarantees, distributed rate limiting, and exhaustive abuse or flood suites are not required for M1.

A looping, runaway, or hostile AI cannot drive the application with thousands of requests, keep
retrying forbidden actions, or resubmit a previously used request or confirmation. Limits and
replay checks hold across restarts and across multiple running copies of the service.

**Why this priority**: Required for safe operation once the AI can act repeatedly, but the
boundary is already safe against single bad requests without it.

**Independent Test**: Drive a scripted planner that floods the boundary, retries denied actions,
and resubmits earlier requests. Verify execution counts stay within configured limits and every
replay is rejected, including after a simulated restart.

**Acceptance Scenarios**:

1. **Given** configured limits per user, tenant, capability, and risk class, **When** a limit is
   exceeded, **Then** further proposals are `DENIED` with a rate-limited reason and an audit
   event.
2. **Given** a planner that emits thousands of proposals in a single turn, **When** the boundary
   processes them, **Then** executions never exceed the configured per-turn maximum and the rest
   are denied.
3. **Given** repeated denied proposals from one session within a time window, **When** the
   configured threshold is crossed, **Then** further proposals from that session are throttled.
4. **Given** a proposal or confirmation that was already processed, **When** it is submitted
   again, **Then** it is rejected as a replay.
5. **Given** the service restarts or a second copy of the service handles the request, **When** a
   replay or over-limit proposal arrives, **Then** it is still detected.
6. **Given** the limit-tracking or replay-tracking facility is unavailable, **When** a proposal
   needs it, **Then** the result is `DENIED`.

---

### User Story 7 - Reusable security test infrastructure for every future capability (Priority: P2, FUTURE security hardening; representative tests REQUIRED)

> **Scope (Constitution 2.0.0)**: FUTURE as an exhaustive, reusable security framework (full attack catalogue, coverage gate,
> double-run determinism, dependency-failure matrix, mutation testing). The testkit already built is
> retained. The representative tests Constitution XVII requires are REQUIRED and counted under the
> other stories.

A platform developer who adds a capability gets a ready-made way to attack it. A scripted
"hostile planner" replays a shared catalogue of attack scenarios against it, with ready-made
tenants, users, and recording stand-ins. A coverage report shows whether the capability has been
tested against every scenario that applies to it.

**Why this priority**: Security tests are mandatory for every AI capability. Without shared
infrastructure, each future feature would have to build its own and some would skip it.

**Independent Test**: Add a sample capability, run the catalogue, then deliberately omit a
required scenario and confirm the quality gate fails and names the gap.

**Acceptance Scenarios**:

1. **Given** a newly added capability, **When** the security test suite runs, **Then** the hostile
   planner and attack catalogue run against it without the developer writing boundary-specific
   test scaffolding.
2. **Given** a capability that lacks coverage for an applicable scenario and has no recorded
   justification for skipping it, **When** the quality gate runs, **Then** it fails and names the
   missing scenarios.
3. **Given** any run of the security suite, **When** it executes, **Then** it needs no live LLM
   and no network access, and two runs of the same suite produce the same results.
4. **Given** each denial scenario, **When** the test finishes, **Then** the recording stand-in
   confirms the application was never invoked.
5. **Given** multi-tenant, multi-permission test needs, **When** a developer writes a test,
   **Then** ready-made tenants, users, and capabilities for each risk class are available.

---

### Edge Cases

- **Look-alike action names**: a proposal using different letter case, extra whitespace, or
  visually similar characters than a registered name does not match it and returns
  `INVALID_ACTION`. Identifiers match exactly.
- **Nested or hidden extra fields**: unexpected fields at any depth in the parameters, as well as
  duplicate or ambiguous keys, are rejected rather than ignored.
- **Parameters change between check and use**: the values that are validated are the same values
  that are authorized, confirmed, audited, and executed. A change after any of those steps
  invalidates the proposal.
- **Check dependency misbehaves**: a trusted check (identity, tenant, permission, resource,
  limits, audit, confirmation) that errors, times out, or returns something unreadable results in
  denial, never in a default "allow".
- **Missing resource versus forbidden resource**: both produce the same external response so the
  AI cannot probe what exists.
- **Many proposals in one turn**: each is evaluated independently, and the per-turn cap applies
  to the total.
- **Capability definition changes while a confirmation is pending**: the pending confirmation no
  longer matches and is rejected.
- **Page context is wrong or spoofed**: where a capability is limited to certain pages, the
  claimed page can only narrow what is allowed, never grant anything. Backend authorization still
  decides.
- **Reserved dangerous names**: proposals for known-dangerous general powers (running scripts,
  commands, queries, outbound requests, selector-based clicking) are recognized and reported as
  policy violations rather than as ordinary unknown actions, but are denied either way.
- **Audit write fails after an action is allowed but before it runs**: the action does not run.
- **Audit write fails for a denied proposal**: the proposal is still denied. Failure to record
  never turns a denial into an allow.
- **Concurrent proposals using the same request identifier**: only the first is processed, and the
  rest are rejected as replays.

## Requirements *(mandatory)*

### Functional Requirements

**Capability registry and allowlisting**

- **FR-001**: The system MUST maintain a registry of AI capabilities, and a proposal can succeed
  only if it names a capability in that registry.
- **FR-002**: Each capability MUST declare a unique identifier, a description, the exact inputs it
  accepts, its risk class, the permission it requires, the pages or contexts where it may be used,
  whether it requires confirmation, whether it changes application state, its audit setting, and
  the application operation it triggers. A capability missing any of these MUST be rejected when
  the platform starts.
- **FR-003**: Capabilities MUST be defined only through trusted, developer-authored configuration
  loaded at startup, and the registry MUST NOT change while the platform is running. No AI
  output, user message, or retrieved content may add, alter, or remove a capability.
- **FR-004**: Identifiers MUST be matched exactly. Duplicate identifiers MUST be rejected at
  startup.
- **FR-005**: A capability definition that declares an input for caller identity, tenant, role,
  permission grant, or confirmation status MUST be rejected at startup.
- **FR-006**: A registered capability MUST be unusable until explicitly enabled by trusted
  allowlist configuration (default deny). The allowlist MUST support narrowing per tenant, and
  MUST NOT be able to enable a FORBIDDEN capability.

**Risk classification**

- **FR-007**: Every capability MUST have exactly one risk class from SAFE, LOW, MEDIUM, HIGH,
  CRITICAL, or FORBIDDEN, assigned in the registry. Nothing in a proposal can set, change, or
  downgrade it.
- **FR-008**: FORBIDDEN capabilities MUST never be allowed under any identity, permission,
  confirmation, or configuration. An attempt MUST return `FORBIDDEN_POLICY` and be recorded as a
  policy violation.
- **FR-009**: The system MUST reserve names for known-dangerous general-purpose powers (arbitrary
  script execution, shell commands, query execution, outbound requests, selector-based element
  control) as FORBIDDEN so attempts are classified distinctly. This is a supplement to the
  allowlist, not a replacement for it.
- **FR-010** [REQUIRED decision; CONDITIONAL machinery]: The Gateway MUST apply a deterministic risk
  decision. SAFE and LOW continue. MEDIUM continues only when its definition explicitly opts out of
  confirmation with a recorded justification. MEDIUM that requires confirmation, HIGH, and CRITICAL
  MUST return `REQUIRES_CONFIRMATION` and never `ALLOWED`. FORBIDDEN is denied. This decision MUST
  NOT create confirmation records. The confirmation machinery (FR-027 to FR-033) is CONDITIONAL on a
  delivered capability that needs it (Constitution XIII).

**Deterministic Policy Gateway**

- **FR-011**: Every AI-originated proposal MUST be evaluated by a single Policy Gateway before any
  application code runs. No other path from the AI to application execution may exist, and
  application operations MUST be callable only by the Gateway.
- **FR-012**: Gateway decisions MUST be deterministic. The same proposal, trusted context,
  registry, and check results MUST always produce the same decision, and the Gateway MUST NOT
  call an LLM or use any probabilistic decision.
- **FR-013**: The Gateway MUST require all of the following to pass before allowing a proposal:
  capability registered and enabled; inputs valid; caller authenticated; tenant matches; required
  permission held; use permitted in the current context; resource owned by or accessible to the
  caller; confirmation satisfied where required; limits not exceeded; not a replay; no
  privilege-escalation attempt; audit record durably written where FR-040 requires it. Any failure
  MUST deny.
- **FR-014**: The Gateway MUST return exactly one of: `ALLOWED`, `DENIED`, `REQUIRES_CONFIRMATION`,
  `INVALID_ACTION`, `INVALID_PARAMETERS`, `UNAUTHORIZED`, `FORBIDDEN_POLICY`. Each non-allowed
  result MUST carry a stable reason category (for example rate-limited, replayed, confirmation
  invalid, tenant mismatch) for the audit trail.
- **FR-015**: Results visible to the AI MUST contain only the result type and a generic reason
  category. They MUST NOT contain internal error details, stack traces, secrets, policy rules,
  permission names, confirmation tokens, or any hint about whether an inaccessible resource
  exists.
- **FR-016**: Any internal error, timeout, missing check, or malformed check answer MUST produce
  `DENIED`, never `ALLOWED`.
- **FR-017**: When a proposal is allowed, the Gateway MUST hand the application only the
  validated, normalized values and the trusted session context, never the raw proposal and never
  any AI-supplied identity or tenant.

**Strict schema validation**

- **FR-018**: Every proposal MUST be validated against its capability's declared inputs: required
  values present, correct types, bounded sizes and lengths, allowed formats and ranges, and no
  unexpected fields at any depth. Invalid proposals MUST return `INVALID_PARAMETERS` without
  execution.
- **FR-019**: A malformed proposal envelope (missing action identifier, unreadable structure,
  oversized payload) MUST return `INVALID_ACTION` without execution.
- **FR-020**: The values validated MUST be the values authorized, confirmed, audited, and
  executed, so that nothing can change between checking and use.

**Authentication, authorization, and tenant isolation hooks**

- **FR-021**: The system MUST provide integration points ("hooks") through which the host
  application supplies: the authenticated user, the active tenant, permission checks,
  resource-level authorization, and current-context information. The Gateway MUST consult them
  for every proposal that needs them.
- **FR-022**: User identity and tenant MUST come only from hooks bound to the authenticated
  session. Values supplied in a proposal MUST never be used.
- **FR-023**: A required hook that is missing, unconfigured, failing, timing out, or returning a
  malformed answer MUST cause denial. The platform MUST NOT permit proposals to be processed
  while a required hook is unconfigured.
- **FR-024**: Permission checks MUST evaluate the end user's own authority. The AI path MUST
  never grant more than the direct path, and MUST NOT use a shared, elevated, or service-level
  identity on the user's behalf.
- **FR-025**: For capabilities that target a resource, the Gateway MUST ask the resource
  authorization hook about that exact resource. "Not found" and "not permitted" MUST be
  indistinguishable to the AI.
- **FR-026** [REQUIRED, tenant-ready]: All tenant-owned security state (audit events, tenant policy,
  and, where they exist, confirmations, replay records, limit counters) MUST be partitioned by
  tenant so one tenant's records can never be read by, or affect, another tenant. The reference
  deployment MAY run with one active tenant (Constitution XI).

**Server-side confirmation framework**

- **FR-027**: When confirmation is required, the Gateway MUST return `REQUIRES_CONFIRMATION`
  without executing, and the server MUST create a confirmation request bound to: the exact
  capability, validated values, target resource, user, and tenant.
- **FR-028**: A confirmation MUST be single-use and expire after a configurable short lifetime.
  It MUST be generated server-side and MUST NOT pass through the AI.
- **FR-029**: The consequence description shown to the user MUST be derived from trusted
  capability details and validated values. It MUST NOT use text written by the AI.
- **FR-030**: Accepting or rejecting a confirmation MUST happen through an entry point separate
  from AI proposals that the AI cannot invoke, and MUST be verified server-side as the same
  authenticated user and tenant, with matching bindings, unexpired, and unused.
- **FR-031**: AI-supplied claims of confirmation MUST have no effect. A change to the action,
  values, or resource after confirmation was requested MUST invalidate it.
- **FR-032**: For CRITICAL capabilities, the user's authorization for the exact resource MUST be
  re-verified immediately before execution.
- **FR-033**: When the same confirmation is accepted concurrently, exactly one acceptance MUST
  succeed and the action MUST execute at most once.

**Replay protection**

- **FR-034**: Each proposal MUST carry a unique request identity assigned by trusted code. The
  system MUST reject any proposal or confirmation it has already processed within a defined
  validity window.
- **FR-035**: The replay-protection design (what is recorded, for how long, how it is partitioned
  by tenant, and how it behaves across restarts and multiple service copies) MUST be defined and
  documented as part of this feature, and enforced at least for confirmations and state-changing
  proposals.
- **FR-036** [OPTIONAL; multi-copy guarantee FUTURE]: Security state (confirmations, replay records,
  limit counters) MUST be held in server-side trusted code, never in the client or the model
  context. It MUST survive restarts and be shared across running copies only when the deployment
  actually runs more than one copy or needs the guarantee to survive a restart. The default
  single-process deployment MAY use the in-memory adapters, documented as such. The audit sink used
  for state-changing execution MUST be persistent (M1).

**Audit logging**

- **FR-037**: The system MUST record structured audit events for: proposal received; allowed;
  denied; confirmation required; confirmation accepted; confirmation rejected; policy violation;
  rate limited.
- **FR-038**: Each event MUST include: timestamp, request identifier, user, tenant, AI session,
  model, requested action, normalized values, risk class, decision with reason, confirmation
  state, execution result, and affected resource.
- **FR-039**: Every proposal MUST produce a "proposed" event and exactly one final decision
  event, linked by request identifier.
- **FR-040**: Capabilities that change application state, and all capabilities of MEDIUM risk or
  higher, MUST be audited and MUST NOT be able to opt out. For these, the audit record MUST be
  durably recorded before the application is invoked, and if it cannot be recorded the action
  MUST NOT run. A failure to record a denial MUST NOT change the denial.
- **FR-041**: Audit events MUST NOT contain passwords, tokens, secrets, or sensitive values
  beyond what is necessary, and MUST support marking inputs as sensitive so they are omitted or
  masked.
- **FR-042**: The AI MUST have no ability to read, alter, or delete audit events. Audit data MUST
  be readable only within its own tenant.

**Rate limiting hooks**

- **FR-043** [REQUIRED bounded execution; the rest retained, not required]: The system MUST enforce a
  per-turn maximum for actions, chained steps, and total execution time. All values MUST be
  configurable. The further limit-checking points (per user, per tenant, per capability, per risk
  class, destructive-action attempts, repeated denials) are implemented primitives that stay in the
  codebase; distributed and exhaustive guarantees are FUTURE.
- **FR-044**: When a limit is exceeded, the result MUST be `DENIED` with a rate-limited reason
  and an audit event. A limit-checking facility that is unavailable MUST cause denial.

**Security test infrastructure**

- **FR-045** [REQUIRED, implemented]: The system MUST provide a scripted hostile planner that submits proposals,
  including worst-case ones, without a real LLM.
- **FR-046** [FUTURE as the exhaustive catalogue; REQUIRED as the representative M1 set]: The system MUST provide a shared attack catalogue covering at least: prompt
  injection, retrieved-content injection, unknown action, parameter injection, other-user
  resource access, cross-tenant access, privilege escalation, confirmation bypass, secret
  extraction, replay, rate-limit abuse, check-dependency failure, and audit failure. It MUST also
  reserve a place for hidden-data exposure scenarios that later features will fill. For M1 only the
  representative set listed in the Scope Declaration is REQUIRED; the full catalogue is Future Work.
- **FR-047** [REQUIRED, implemented]: The system MUST provide ready-made test tenants, users with varying permissions, a
  test capability for each risk class, stand-in checks, a recording application stand-in that
  reveals whether it was ever invoked, and capture of audit events.
- **FR-048** [FUTURE]: The system MUST report, per capability, which applicable catalogue scenarios are
  covered and which are missing or justified as not applicable, and a capability with unjustified
  gaps MUST fail the quality gate.
- **FR-049** [REQUIRED]: Security tests MUST be deterministic and MUST NOT need a live LLM or network access.

**Boundaries of this feature**

- **FR-050**: This feature MUST NOT introduce any capability for arbitrary script execution,
  outbound requests, query execution, shell access, unrestricted interface control, or
  selector-based actions, and MUST NOT provide any generic "run anything" extension point. Later
  features extend the platform only by registering narrow, typed capabilities.
- **FR-051**: This feature MUST NOT include or depend on an LLM. The Gateway accepts proposals
  from any source and treats all of them as untrusted.
- **FR-052**: This feature MUST NOT ship production capabilities. It ships only the test-only
  capabilities needed to exercise the boundary. M1 executes through these test-only capabilities:
  at least one SAFE or LOW capability, and one state-changing capability whose execution is audited.
- **FR-053** [REQUIRED, minimal]: The system MUST provide a documented contract for later features covering: how to
  register a capability, how to submit a proposal, what results to expect, how to supply the
  application operation, and how to connect the hooks. The documented route to an application
  operation MUST go through the Gateway.

### Requirement scope classification (Constitution 2.0.0)

| Requirements | Scope | Note |
|--------------|-------|------|
| FR-001 to FR-009 (registry, risk classes, reserved names) | REQUIRED | Implemented |
| FR-010 (risk decision) | REQUIRED | Small deterministic stage, no confirmation records |
| FR-011 to FR-025 (Gateway, validation, hooks, authorization) | REQUIRED | Implemented except the pipeline stages listed under M1 |
| FR-026 (tenant partitioning) | REQUIRED, tenant-ready | One active tenant allowed in the demo |
| FR-027 to FR-033 (confirmation machinery) | CONDITIONAL / OPTIONAL | Store and binding built, retained; service not required for M1 |
| FR-034, FR-035 (request identity, replay) | REQUIRED for state-changing actions | Implemented, retained |
| FR-036 (durable, shared state) | OPTIONAL / FUTURE | Single process by default |
| FR-037 to FR-042 (audit) | REQUIRED | Persistent sink required for M1 |
| FR-043, FR-044 (limits) | REQUIRED bounded execution; rest retained | Distributed limits FUTURE |
| FR-045, FR-047, FR-049 (hostile planner, fixtures, determinism by construction) | REQUIRED | Implemented |
| FR-046 (attack catalogue) | Representative subset REQUIRED; exhaustive FUTURE | |
| FR-048 (coverage gate) | FUTURE | |
| FR-050 to FR-052 (boundaries) | REQUIRED | |
| FR-053 (developer contract) | REQUIRED, minimal | M1 surface only |

| Success criteria | Scope |
|------------------|-------|
| SC-001, SC-002, SC-003, SC-004, SC-007, SC-008, SC-009 | REQUIRED, evaluated on the representative M1 set |
| SC-005 (confirmation) | CONDITIONAL / OPTIONAL |
| SC-006 | REQUIRED as the per-turn bound; the 10,000-proposal flood run is FUTURE |
| SC-010 | OPTIONAL; REQUIRED only for one SAFE or LOW and one state-changing capability |
| SC-011, SC-012 | FUTURE (a single deterministic CI run is REQUIRED) |

### Key Entities *(include if feature involves data)*

- **Capability**: One thing the AI may ask for. Has a unique identifier, description, accepted
  inputs, risk class, required permission, permitted contexts, confirmation requirement, audit
  setting, and the application operation it triggers. Defined only by trusted developers.
- **Capability Registry**: The complete, fixed-at-startup set of capabilities, plus the allowlist
  of which are enabled, optionally narrowed per tenant.
- **Risk Class**: One of SAFE, LOW, MEDIUM, HIGH, CRITICAL, FORBIDDEN. Determines whether
  confirmation is needed and whether the capability can ever run.
- **Action Proposal**: A request from the untrusted AI to perform a capability with given values.
  Carries a unique request identity but no trusted facts about who or where.
- **Trusted Request Context**: The user, tenant, session, and current-context facts supplied by
  the host application's own trusted checks. The only source of identity and tenant.
- **Gateway Decision**: The outcome of evaluating a proposal. One result type plus a reason
  category, kept apart from the AI-visible response.
- **Confirmation Request**: A server-created, single-use, time-limited approval request bound to one
  capability, values, resource, user, and tenant, with a consequence description from trusted data.
- **Audit Event**: A structured, tenant-scoped, tamper-resistant record of a proposal, decision,
  confirmation step, or execution result.
- **Replay Record**: A tenant-scoped record that a request or confirmation has already been
  processed, kept for a defined window.
- **Limit Policy and Counter**: Configurable limits and the running counts they are compared
  against.
- **Security Hook**: A defined integration point through which the host application supplies a
  trusted fact or decision (identity, tenant, permission, resource access, context, limits).
- **Attack Scenario**: A reusable, scripted hostile case in the shared catalogue, with its
  expected result.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001** [REQUIRED, representative]: In 100% of scenarios in the representative hostile-request
  set defined for M1 (the exhaustive catalogue is Future Work), zero application operations are
  executed, as confirmed by the recording application stand-in.
- **SC-002** [REQUIRED]: 100% of proposals for unregistered, forbidden, or not-enabled capabilities, and 100%
  of proposals with invalid values, are rejected with the correct result type and have a
  matching audit record.
- **SC-003** [REQUIRED for the dependencies on the M1 path; the full matrix is FUTURE]: When any single trusted dependency (identity, tenant, permission, resource
  authorization, limit tracking, replay tracking, confirmation storage, audit recording) is made to
  fail, time out, or return unreadable answers, 100% of proposals that depend on it are denied.
- **SC-004** [REQUIRED, focused]: In every tested combination of user, tenant, and capability, the outcome through the
  AI path matches the outcome of the same user acting directly, and no AI-visible response
  reveals another tenant's data or whether an inaccessible resource exists.
- **SC-005** [CONDITIONAL / OPTIONAL]: 100% of expired, reused, mismatched (action, resource, values, user, tenant), and
  AI-fabricated confirmations are rejected, and across 100 repeated concurrent acceptances of one
  confirmation, exactly one succeeds each time.
- **SC-006** [REQUIRED as the per-turn bound; the 10,000-proposal flood run is FUTURE]: When a hostile planner submits 10,000 proposals in one turn, executions never exceed
  the configured per-turn maximum, and every excess proposal is denied and audited.
- **SC-007** [REQUIRED]: For 100% of evaluated proposals there is exactly one final decision record, and
  across audit-recorder failure tests, zero state-changing actions execute without a preceding
  durable audit record.
- **SC-008** [REQUIRED, one representative audit-trail test]: In a review exercise, a security reviewer can answer "what did the AI attempt, why
  was it allowed or denied, who authorized it, what changed" for 100% of sampled actions using
  only the audit trail.
- **SC-009** [REQUIRED, representative set]: An automated scan of every AI-visible response across the representative M1 set (the full attack catalogue is Future Work)
  finds zero occurrences of internal error details, secret-like values, policy or permission
  names, or confirmation tokens.
- **SC-010** [OPTIONAL; REQUIRED for one SAFE or LOW and one state-changing capability]: A developer can add a new narrow capability of each of the six risk classes by
  following the documented contract, with every boundary check applying to it automatically and no
  changes to the Gateway itself.
- **SC-011** [FUTURE]: 100% of registered capabilities have every applicable attack scenario covered or
  carry a recorded justification, and a capability with an unjustified gap fails the quality gate.
- **SC-012** [FUTURE; one deterministic CI run is REQUIRED]: Two consecutive runs of the full security test suite, with no live LLM and no
  network access, produce identical results.

## Assumptions

- **Governing rules**: The project constitution (v2.0.0) binds this feature: the Tier A principles
  always, each Tier B principle when its trigger exists, and Principles XVIII (Delivery Scope) and
  XIX (Scope Discipline). This feature is the "Security Foundation" phase of the constitution's
  phased delivery plan.
- **Host application**: The host application provides, or will provide, its own authentication,
  permission model, and resource ownership data. This feature defines how the boundary asks for
  those facts and does not build them. Until real checks are connected, the boundary denies
  every proposal (fail closed).
- **No production capabilities ship**: Only test-only capabilities exist, one per risk class, to
  exercise the boundary. Real guidance features come later.
- **Proposal source**: Proposals arrive as structured requests from an AI planner. What produced
  them does not matter, since all are treated as hostile.
- **Confirmation presentation**: This feature defines what a confirmation must contain and how it
  is verified. The user interface that displays it is a later feature, and it must show the
  trusted consequence description.
- **Default confirmation rules**: HIGH and CRITICAL always require confirmation. MEDIUM requires
  it unless the capability explicitly opts out with a justification. SAFE and LOW do not. The risk
  decision that applies these rules is REQUIRED; the confirmation machinery is CONDITIONAL.
- **Configurable values**: Confirmation lifetime, replay window, rate limits, per-turn caps, and
  repeated-denial thresholds are configurable. Specific default numbers are chosen during
  planning.
- **Context is only a narrowing signal**: Where a capability is limited to certain pages or
  contexts, the claimed context can only restrict what is allowed, never grant it. Backend
  authorization is authoritative.
- **Reserved forbidden names**: Pre-registering known-dangerous names as FORBIDDEN exists for
  clearer reporting only. The primary control remains default deny with an explicit allowlist.
- **Audit destination and retention**: Where audit events are stored and for how long is a
  deployment decision outside this feature. Events must be readable by tenant-scoped reviewers
  and not alterable by the AI.
- **Default deployment**: A single process (modular monolith). Several copies are not required.
  Shared-state guarantees across copies are FUTURE and apply only if a deployment actually runs
  several copies.
- **Browser boundary (resolved 2026-11-16)**: The browser is display-only guidance. The trusted
  server derives identity and tenant, decides, and executes every application capability.
- **Tenant model (resolved 2026-11-16)**: The architecture stays tenant-ready (one active tenant per
  session context, tenant derived server-side). The demo may operate with one active tenant.
- **What the model sees (resolved 2026-11-16)**: Feedback returned to the model exposes only
  intentionally selected safe information: the outcome type, a generic category, and field paths.
- **Tenant configuration (resolved 2026-11-16)**: Tenant configuration may narrow which capabilities
  are enabled for a tenant. It never dynamically redefines trusted capability definitions.
- **Out of scope (separate later features)**: the LLM planner and its prompts; retrieval over
  documents (RAG); the interface-element registry and the client-side privacy/redaction layer
  that precede AI context; the confirmation user interface; real application operations; rollback
  of executed actions; and any autonomous or multi-step agent behavior.

## Future Work

These items are Tier C or conditional work. They are recorded here so they do not silently become
prerequisites (Constitution XVIII). Code already built for them stays in the repository.

- The exhaustive attack catalogue (102 scenarios) and the capability-by-scenario coverage matrix
  and gate (FR-046 in full, FR-048, SC-011).
- The deterministic double-run script (SC-012) and the 36-case dependency-failure matrix.
- Independent security oracle requirements beyond the useful oracle code already implemented.
- Mutation testing and its nightly workflow.
- Large-scale flood and concurrency suites (the 10,000-proposal run of SC-006).
- Multi-replica security-state guarantees (FR-036 in full) and distributed rate limiting.
- Prometheus and Grafana, Kubernetes and Minikube, distributed tracing, SIEM integration, and other
  enterprise observability and deployment hardening.
- OPTIONAL, to be pulled in only when a capability triggers it: the complete confirmation service,
  persistence endpoints and deep bypass/concurrency suites; extended replay and rate-abuse suites;
  detailed database-role audit isolation tests; readiness endpoint; Docker image; PR template; an
  expanded testkit guide.
