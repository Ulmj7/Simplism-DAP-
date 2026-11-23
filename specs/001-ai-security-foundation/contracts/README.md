# Contracts: AI Security Foundation

**Feature**: `001-ai-security-foundation` | **Spec**: [../spec.md](../spec.md) | **Plan**: [../plan.md](../plan.md)

These are the interfaces later AI features build against (spec FR-053). The TypeScript files are
specification mirrors of types and closed-vocabulary constants, not shipped modules. **Since T143 (2026-11-16) their type declarations mirror `packages/contracts/src/*.ts`** (imports omit `.js`; comments below correct inherited runtime-description errors), so they describe what is actually exported. They were compile-checked again with
`tsc --ignoreConfig --noEmit --strict --exactOptionalPropertyTypes --noUncheckedIndexedAccess --moduleResolution Bundler` (exit 0, log in
[validation-report.md](../../../docs/validation-report.md)). They contain no behavior; behavior lives in the packages named below. The list of
mismatches found and how each was resolved is in [reconciliation.md](./reconciliation.md).

| File | Defines | Implemented in |
|------|---------|----------------|
| [`core.ts`](./core.ts) | Branded ids, `RiskLevel`, outcomes, reason codes, pipeline stages, `PlannerRunMeta` | `@dap/contracts` |
| [`action-definition.ts`](./action-definition.ts) | `ActionDefinition`, `ActionRegistry`, registration rules R1-R12 | `@dap/contracts` (types and `defineAction`), `@dap/security` (`buildRegistry`, `RegistrationError`, `RESERVED_*` names) |
| [`security-context.ts`](./security-context.ts) | `AuthorizationContext`, host ports (`AuthenticationPort`, `PermissionChecker`, `ResourceAuthorizer`, `PageContextProvider`) | types in contracts; factory in `@dap/security`; ports by the **host** |
| [`gateway.ts`](./gateway.ts) | `ProposalCall`, `PolicyDecision`, `PlannerFeedback`, `PolicyGateway`, `GatewayDependencies` (types) | types in `@dap/contracts`; `createPolicyGateway` and `toPlannerFeedback` in `@dap/security` |
| [`confirmation.ts`](./confirmation.ts) | `ConfirmationRequest`, `ConfirmationService`, `ConfirmationChannel` | **types only; the service is NOT built** (OPTIONAL). `createPolicyGateway` returns a fail-closed stub; the host supplies fail-closed placeholders |
| [`audit.ts`](./audit.ts) | `AuditEvent`, `AuditSink`, `AuditAppendOptions`, `AuditReader` | types in contracts; `PostgresAuditStore`, `InMemoryAuditStore`, `createAuditReader` in `@dap/security` |
| [`execution.ts`](./execution.ts) | `ActionExecutor`, `ExecutionGrant`, `ExecutorTable` (types) | `defineExecutor` in `@dap/contracts`; `bindExecutors` in `@dap/security`; **`@dap/actions` is empty** (the host's demo executors live in `apps/reference-host/src/capabilities.ts`) |
| [`state-ports.ts`](./state-ports.ts) | Replay, rate limiting, confirmation store, tenant policy | `@dap/security`: PostgreSQL and in-memory adapters for replay, rate limiting, tenant policy and audit; **no confirmation-store adapter on `dev`** |
| [`testkit.ts`](./testkit.ts) | Hostile planner, attack scenarios, coverage report (types) | `@dap/testkit` implements the planner, scenarios and world; **`buildCoverageReport` is not built** (FUTURE) |
| [`security-test-catalogue.md`](./security-test-catalogue.md) | The attack scenarios every capability is tested against | `@dap/testkit` (partly; see its status table). Representative scenarios are REQUIRED, the rest OPTIONAL or FUTURE |
| [`reference-host-api.md`](./reference-host-api.md) | HTTP surface of the thin reference host | **Not built** (OPTIONAL). The built host is in-process: `apps/reference-host/README.md` |

## Package boundaries (enforced; research D4)

```text
                     +-------------+
        +----------->|  contracts  |<-----------+------------+
        |            +-------------+            |            |
   +----+----+        ^           ^        +-----+-----+  +---+----+
   |   ai    |        |           |        |  security |  | actions|
   +---------+   (types only)     |        +-----------+  +--------+
        |                         |             ^              |
        |   NO edge from ai, actions, or security to each other.|
        |                                                       |
        +--------------- composition root (reference host) -----+
                  wires all packages; the only place that
                  sees registry + executors + gateway together
   testkit --> contracts, security, ai        (never imported by production code)
```

**Allowed edges only**: every package to `contracts`; `testkit` to `security` and `ai`;
`apps/reference-host` to contracts, security, ai and actions (never testkit). **Forbidden**: `ai` to `security` or `actions`; `actions` to `ai` or
`security`; `security` to `ai` or `actions`; any production package to `testkit`.
The restricted subpath `@dap/contracts/mint` may be imported only by `security` and `testkit`.

## What each party can hold at runtime

| Party | Holds | Never holds |
|-------|-------|-------------|
| AI layer (planner runner) | a `ProposalSubmitter` bound to one session and run | context, registry, executors, state store, confirmation service, audit reader |
| Security module | context factory, Gateway internals, state store, audit sink | executor implementations (injected opaque, via `ExecutorTable`) |
| Executors | a grant-checked `execute` | a way to mint grants or contexts |
| Trusted HTTP layer | `ConfirmationService`, context factory | the planner's submitter internals |
| Trusted host application | composition root, ports, registry, executor bindings and context factory | must not expose these trusted APIs as model tools; not isolated from same-process malicious host code |

## Pipeline

See research D6 for the ordered stage table and the spec FR mapping. In short: trusted context,
intake, global limits, replay claim, resolve and enable, strict validation, authorization, risk
and confirmation, durable audit, grant-checked execution. Before a confirmed ALLOWED receipt, policy faults stop execution with a denial. After that receipt, execution faults preserve ALLOWED and report failure/try_later; optional metadata and telemetry faults do not revoke known success.

## Adding a capability (the contract for later features)

> **Status**: steps 1 to 4 and 6 describe what exists; step 5 describes the **representative** route (the exhaustive catalogue runner and coverage
> gate are FUTURE). Step 2 currently lands in the host's `capabilities.ts` because `@dap/actions` is empty.

1. **Define** it with `defineAction({...})`: strict `inputSchema`, `risk`, `requiredPermission`,
   `allowedPages`, `confirmation`, `changesState`, `audit.params`, `resource`,
   `describeConsequence` (if confirmable), `executorId`, `version: 1`. Use no identity-like
   parameter names.
2. **Implement** its executor (in `@dap/actions` once it has content; today in the composition root) with `defineExecutor`. It receives only validated
   parameters and the user's own context.
3. **Register** it by adding the definition to the list passed to `buildRegistry`, and bind the
   executor in the composition root. Startup fails with all registration issues if a rule is
   violated.
4. **Enable** it by adding its id to the global allowlist configuration. A tenant can then be
   narrowed per tenant. Nothing is enabled by default.
5. **Test** it: add representative cases for the boundaries it touches (Constitution XVII) to `tests/security/` using the testkit's `withGateway()`
   world and its scenario oracles. The capability-by-scenario coverage gate that would fail the build for a missing scenario is FUTURE
   (`package.json` still lists `npm run coverage:security`, but its target `packages/testkit/dist/cli/coverage.js` does not exist on `dev`, so the script fails; it is not part of M1 or CI).
6. **Bump `version`** on any later change; the drift test enforces this.

Generic execution capabilities are prohibited by the Constitution. Reserved-name registration checks and executor binding reject known forbidden capabilities; the production static scan checks dangerous API usage (`tests/architecture/static-scan.test.ts`). These checks are not a semantic proof of arbitrary trusted executor bodies: later capability authors must still review their authority and effects.
