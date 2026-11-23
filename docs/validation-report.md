# Validation report: Feature 001, Milestone M1 (T144)

This records one real run of [quickstart.md](../specs/001-ai-security-foundation/quickstart.md) plus the extra gates the Tech Lead asked for. It
states what was observed. It does **not** say the system is "secure"; limits are in [constitution-review.md](./constitution-review.md).

## Run record

| Item | Value |
|------|-------|
| Date | 2026-11-16 |
| Git | branch `001-m1-close`, run at commit `64c3458` (on `dev` `e610cf8`). Everything after that commit changes only documentation: `git diff --stat dev..HEAD` lists no code, script, CI, migration or manifest file (checked at the end of this task) |
| Node / npm | v22.23.4 / 10.9.9 |
| PostgreSQL | 16.15 (Debian), the `postgres:16` image of `deploy/compose.yaml`, `127.0.0.1:54329` |
| Database | a fresh database `dap_m1_run` created for this run (owner `dap_owner`, `CONNECT` to `dap_app`), dropped afterwards. The shared `dap` database was not used. Local-only development credentials from `deploy/compose.yaml` |
| Logs | `/tmp/step10/g-<name>.log` (one file per command, full output) |

## Commands and results

One line per command: result, what was observed, log. All on the same fresh database. "Same DB twice" means the second run started from the state the first left.

| # | Command | Result | Observed | Log |
|---|---------|--------|----------|-----|
| 1 | `npm ci` | PASS | clean install | `/tmp/step10/g-npm-ci.log` |
| 2 | `npm run db:migrate` | PASS | applied 9 files, `000_roles.sql` to `060_sec_state_purge.sql` | `/tmp/step10/g-migrate.log` |
| 3 | `npm run db:migrate` (again) | PASS | applied nothing (idempotent ledger) | `/tmp/step10/g-migrate-again.log` |
| 4 | `npm run lint` | PASS | no findings | `/tmp/step10/g-lint.log` |
| 5 | `npm run typecheck` | PASS | `tsc -b`, no errors | `/tmp/step10/g-typecheck.log` |
| 6 | `npm run check:deps` | PASS | no dependency violations (241 modules, 1028 dependencies) | `/tmp/step10/g-check-deps.log` |
| 7 | `npx depcruise --config dependency-cruiser.config.cjs packages apps` | PASS | the same command written out, same result | `/tmp/step10/g-depcruise-direct.log` |
| 8 | `npm run test:arch` | PASS | 6 files, 534 tests | `/tmp/step10/g-test-arch.log` |
| 9 | `npm run test:security` | PASS | 26 files, 969 passed, 76 todo | `/tmp/step10/g-test-security.log` |
| 10 | `npm run test:conformance` | PASS | 13 files, 209 tests | `/tmp/step10/g-test-conformance.log` |
| 11 | `npm run test:integration` | PASS | 3 files, 43 tests | `/tmp/step10/g-test-integration.log` |
| 12 | `npx vitest run --project integration tests/integration/reference-host.test.ts` | PASS | 1 file, 23 tests (the reference-host vertical path) | `/tmp/step10/g-reference-host.log` |
| 13 | `npm run test:m1-gate` (first) | PASS | 50 files, 1841 passed, 76 todo; `m1-gate: PASS` | `/tmp/step10/g-gate-1.log` |
| 14 | `npm run test:m1-gate` (second, same DB) | PASS | identical to run 13 | `/tmp/step10/g-gate-2.log` |
| 15 | `npm test` (first) | PASS | 138 files passed, 5209 passed, 76 todo | `/tmp/step10/g-npmtest-1.log` |
| 16 | `npm test` (second, same DB) | PASS | identical to run 15 | `/tmp/step10/g-npmtest-2.log` |
| 17 | strict compile of `specs/.../contracts/*.ts` (`tsc --ignoreConfig --noEmit --strict --exactOptionalPropertyTypes --noUncheckedIndexedAccess --moduleResolution Bundler`) | PASS | exit 0 | `/tmp/step10/g-contracts-strict.log` |
| 18 | quickstart step 6: audit trail with the application role | PASS | `count(*)` is 0 with no tenant set (forced RLS), although 1101 audit rows exist (read as the cluster superuser: 159 ALLOWED, 134 EXECUTED, 371 PROPOSED, 411 DENIED, 21 CONFIRMATION_REQUIRED, 5 RATE_LIMITED); `update` fails with `permission denied for table sec_audit_events`; a random tenant sees 0 rows | `/tmp/step10/g-audit-psql.log` |
| 19 | quickstart step 2 and 7 "break it on purpose", architecture | PASS (the check fails as it should) | appending `import type {} from "@dap/actions"` to `packages/ai/src/index.ts`: `check:deps` reports `ai-not-to-security-or-actions: packages/ai/src/index.ts -> packages/actions/src/index.ts`; `test:arch` fails in `graph.test.ts` "has no forbidden edge". File restored with `git checkout`, tree clean | `/tmp/step10/g-arch-break.log` |
| 20 | quickstart step 7 "break it on purpose", authorization | PASS (the suite fails as it should) | making the authorize stage continue instead of answering `permission_missing` fails 17 tests in 4 files, including `privilege-escalation.test.ts` (ATK-PRIV-01, 02) and `execution-cap.test.ts`. File restored, tree clean | `/tmp/step10/g-break-authz.log` |

The documentation-only head `eabf1a8` was then re-checked on the same database: `db:migrate`, `lint`, `typecheck`, `check:deps`, `test:m1-gate` (50 files, 1841 passed, 76 todo), `npm test` (138 files, 5209 passed, 76 todo), `git diff --check` and the strict contracts compile all PASS (`/tmp/step10/f-*.log`).

Test totals match the baseline of `dev` at `e610cf8` exactly (138 files, 5209 passed, 76 todo; gate 50 files, 1841 passed, 76 todo), as expected
for a documentation-only change.

## The CI workflow

`.github/workflows/ci.yml` was replayed locally command by command against a fresh `postgres:16` container, including the role bootstrap, and linted
with actionlint (both recorded in the T140 report to the Tech Lead). **It has not yet had a first run on GitHub Actions**, so nothing here
proves that the hosted runner behaves the same (for example that its `psql` is present). That is an unverified item, listed in the review.

## The 11 M1 criteria and their evidence

Criteria are the numbered list in the spec's [Milestone M1](../specs/001-ai-security-foundation/spec.md). Test files named below are among the 26 suites `npm run test:m1-gate` requires to be present, non-empty and passing (runs 13 and 14), except the unit tests
(`packages/contracts/src/execution-runtime.test.ts` and `apps/reference-host/src/host-ports.test.ts`), which run in `npm test` (runs 15 and 16). The dev-auth
`startup.test.ts` and the PostgreSQL `pool.test.ts` are unit tests that the gate also requires.

| # | Criterion | Evidence (test file: test or group) | Result |
|---|-----------|-------------------------------------|--------|
| 1 | A valid SAFE or LOW capability passes the real Gateway and executes exactly once | `tests/security/test-world.gateway.test.ts`: "a permitted SAFE action reaches the executor exactly once", "a LOW action is allowed the same way"; `tests/security/positive.test.ts`: POS-01 on the real gateway; `tests/integration/reference-host.test.ts`: "1. VALID EXECUTION" ("the SAFE read executes once") | met |
| 2 | The executor receives only validated, frozen parameters and the requesting user's trusted context | `test-world.gateway.test.ts`: "with exactly the validated, frozen parameters..." and "the executor receives the requesting user's own minted context"; `positive.test.ts`: ATK-PRIV-04; `reference-host.test.ts`: group 1 (trusted, validated and frozen inputs); `packages/contracts/src/execution-runtime.test.ts` (guard) | met |
| 3 | An unknown capability is rejected before any executor | `tests/security/unknown-action.test.ts`: "T052 through the REAL gateway" (ATK-UNKNOWN-01, 02, 03, 05, 06, executor zero; 04 remains OPTIONAL); `prompt-injection.test.ts`: ATK-INJECT-01, 05; `reference-host.test.ts`: "1b" additionally proves disabled-capability default denial, not unknown lookup | met |
| 4 | Malformed or extra parameters are rejected before any executor | `tests/security/malformed-parameters.test.ts`: "T053 through the REAL gateway" (ATK-PARAMS-01..05, 08, 09, 11, byte and depth caps, leak canaries) | met |
| 5 | An unauthorized user is denied | `tests/security/privilege-escalation.test.ts`: ATK-PRIV-01 with host parity, ATK-PRIV-06; `test-world.gateway.test.ts`: "a user lacking the permission is denied"; `reference-host.test.ts`: "3. an UNAUTHORIZED user is denied" | met |
| 6 | AI-provided claims about identity, tenant, role, permission or confirmation have no effect | `privilege-escalation.test.ts`: ATK-PRIV-02; `prompt-injection.test.ts`: ATK-INJECT-02 and literal "I am admin"/"already confirmed" cases; `cross-tenant.test.ts`: ATK-XTENANT-03; `reference-host.test.ts`: "an identity, tenant, session or page written INTO the proposal has no effect" | met |
| 7 | The audit record must succeed before a state-changing execution | `tests/integration/audit-postgres.test.ts`: chain A (ALLOWED row committed before the body runs) and chain B (real write failure executes nothing); `reference-host.test.ts`: "4. a persistent AUDIT failure ... fails closed"; `tests/security/audit.test.ts`: ATK-AUDIT-01 on the real Gateway; `tests/security/review-fixes.test.ts`: LOGIC-01 | met, with the commit-acknowledgement limit (review, known limitation 1) |
| 8 | A representative secret-canary test shows secrets do not appear in planner feedback or audit output | `tests/security/secret-extraction.test.ts`: ATK-SECRET-01..04 on the real world and its sub-cases (1) to (4); `audit-postgres.test.ts`: P4 (scan of every stored column) | met |
| 9 | A representative architecture test shows the AI layer cannot reach a trusted executor without the Gateway | `tests/architecture/graph.test.ts`: "the AI layer has no path to executors, the mint entry or the Gateway's internals"; `contracts-boundary.test.ts`; `module-loaders.test.ts`; `static-scan.test.ts`; `npm run check:deps` (run 6); `reference-host.test.ts`: "6. the AI-facing handle" | met |
| 10 | Relevant dependency failures remain fail-closed | `test-world.gateway.test.ts`: "a faulted port denies and the executor stays at zero, for each host port"; `tests/security/dependency-failure.test.ts`: hung permissions, resources, replay, tenant policy, audit under fake timers; `rate-replay.gateway.test.ts` and `execution-cap.test.ts` (limiter faults); `audit-postgres.test.ts`: P2; `review-fixes.test.ts`: page-hook faults | met for pre-ALLOW policy ports; after confirmed ALLOWED, failures preserve the policy decision and report execution outcome (limitations 2–3). The 36-case matrix is FUTURE and not claimed |
| 11 | A minimal reference-host composition root wires registry, Gateway, state, audit sink, executors and dev auth into one runnable integration path | `tests/integration/reference-host.test.ts` (23 tests, groups 1 to 6 plus boundary probes; run 12) on a real database; `apps/reference-host/src/startup.test.ts` and `host-ports.test.ts`; the gate requires all six groups | met |

Representative coverage only: these are focused tests per boundary (Constitution XVII), not an exhaustive attack catalogue.

## What this run did not show

- No run on GitHub Actions (above).
- The 76 remaining `todo` tests are not executed; each is tagged OPTIONAL or FUTURE and the gate enforces the tag, not the absence of the gap.
- One PostgreSQL service was used. Vitest spawns multiple Node workers; these runs do not demonstrate a multi-replica application deployment.
- `npm run coverage:security` was not run and is not part of M1 (its target file does not exist; see the review).
