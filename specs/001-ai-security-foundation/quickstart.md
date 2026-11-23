# Quickstart: Validating the AI Security Foundation (Milestone M1)

**Feature**: `001-ai-security-foundation` | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Recorded run**: [docs/validation-report.md](../../docs/validation-report.md)

A run-and-verify guide for **Milestone M1** (the eleven criteria in the spec's Scope Declaration), rewritten on 2026-11-16 (T144) to describe only
what exists on `dev`. The previous version described an HTTP host, Prometheus, a confirmation flow and a coverage gate. **None of those are built**;
they are OPTIONAL or FUTURE and are not part of this guide. No live LLM is used. Docker image pulls and npm installation may access the network; tests use local PostgreSQL.

## Prerequisites

- Node.js 22 and npm 10
- Docker with Compose, for PostgreSQL 16 (`deploy/compose.yaml`, port `54329` on `127.0.0.1`)
- A **throwaway database** for every run. Never use a shared development database, and never `dap` if anyone else uses it.

## 0. Start PostgreSQL and create a fresh database

```bash
docker compose -f deploy/compose.yaml up -d --wait postgres

docker compose -f deploy/compose.yaml exec -T postgres psql -U dap_bootstrap -d postgres -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE dap_m1_run OWNER dap_owner;" -c "GRANT CONNECT ON DATABASE dap_m1_run TO dap_app;"

export DAP_DATABASE_URL='postgresql://dap_app:dap_app_local_only@127.0.0.1:54329/dap_m1_run'
export DAP_MIGRATE_DATABASE_URL='postgresql://dap_owner:dap_owner_local_only@127.0.0.1:54329/dap_m1_run'
```

These are the local-only development credentials from `deploy/compose.yaml`; they are not secrets and must never be reused anywhere else.
`dap_owner` owns the schema and applies migrations; `dap_app` is the unprivileged role the host connects as.

## 1. Install and migrate

```bash
npm ci
npm run db:migrate
```

**Expected**: `db:migrate` prints `Applied ...` for `000_roles.sql` through `060_sec_state_purge.sql` (nine files). Running it again applies nothing.

## 2. Static gates: lint, types, boundaries, architecture

```bash
npm run lint          # no eval/new Function, no restricted mint or deep contracts imports
npm run typecheck     # strict TypeScript across all packages and apps
npm run check:deps    # dependency-cruiser over packages and apps (same as: npx depcruise --config dependency-cruiser.config.cjs packages apps)
npm run test:arch     # import graph, manifests, mint boundary, module loaders, static scans, the gate's own checks
```

**Expected**: all four succeed; `check:deps` ends with `no dependency violations found`. Adding `import ... from "@dap/actions"` anywhere in
`packages/ai` makes `check:deps` and `test:arch` fail naming the edge (M1 criterion 9).

## 3. Unit, security, conformance and integration tests

```bash
npm run test:security       # representative hostile-proposal scenarios through the real Gateway (no database needed for most)
npm run test:conformance    # the in-memory and PostgreSQL adapters pass the same conformance suites, plus migration checks
npm run test:integration    # PostgreSQL audit sink and the reference host end to end
npm test                    # everything above plus the package unit tests
```

**Expected**: every command passes. `npm test` reports the remaining `todo` tests; each is tagged OPTIONAL or FUTURE (see step 5).

## 4. The reference-host vertical path

```bash
npx vitest run --project integration tests/integration/reference-host.test.ts
```

The test composes the real host (`apps/reference-host`) over your database and drives six groups: a valid execution (dev session, trusted context,
real Gateway, durable `ALLOWED` row, executor exactly once, `EXECUTED` row); missing, invalid and expired sessions; an unauthorized user; a real
PostgreSQL failure of the `ALLOWED` write; a HIGH capability that stops at `REQUIRES_CONFIRMATION`; and the AI-facing handle that exposes only
`submit`. **Expected**: all pass; each denial leaves the executors at zero calls.

There is **no HTTP server** and no `curl` walkthrough: the host is an in-process composition root. To embed it, see `apps/reference-host/README.md`
(environment variables `DAP_DATABASE_URL`, `DAP_ENABLED_ACTIONS`, `DAP_ALLOW_DEV_AUTH=1`, `DEV_SESSIONS`).

## 5. The M1 gate (the authoritative check)

```bash
npm run test:m1-gate
```

It migrates the database and runs the `arch`, `security`, `conformance` and `integration` test projects plus two focused unit guards (the dev-auth
startup checks `apps/reference-host/src/startup.test.ts` and the PostgreSQL pool checks `packages/security/src/state/postgres/pool.test.ts`), with
`.only` refused and every test required to assert. It **fails** if any of the 26 named suites is missing, empty, skipped or failing, if a
reference-host group or one of its seven pinned cases did not pass, or if any remaining `todo` is not tagged OPTIONAL or FUTURE. Run it twice on the
same database to see that it is repeatable. The gate is representative, not exhaustive.

## 6. Look at the audit trail in the database

```bash
docker compose -f deploy/compose.yaml exec -T -e PGPASSWORD=dap_app_local_only postgres \
  psql -h 127.0.0.1 -U dap_app -d dap_m1_run -c "select count(*) from sec_audit_events;"
docker compose -f deploy/compose.yaml exec -T -e PGPASSWORD=dap_app_local_only postgres \
  psql -h 127.0.0.1 -U dap_app -d dap_m1_run -c "update sec_audit_events set reason = 'x';"
docker compose -f deploy/compose.yaml exec -T -e PGPASSWORD=dap_app_local_only postgres \
  psql -h 127.0.0.1 -U dap_app -d dap_m1_run -c "begin; select set_config('app.tenant_id', gen_random_uuid()::text, true); select count(*) from sec_audit_events; commit;"
```

**Expected**: the first query returns `0` although the tests wrote rows (forced row-level security: no tenant is set, so no row is visible); the
`update` fails with `permission denied for table sec_audit_events` (the application role has `SELECT` and `INSERT` only; installed triggers also refuse ordinary
`UPDATE`, `DELETE` and `TRUNCATE`, including owner DML; administrators can alter/disable these controls); a random tenant sees `0` rows.

## 7. CI

`.github/workflows/ci.yml` runs the steps above in this order on a `postgres:16` service container: install, lint, typecheck, dependency boundaries,
architecture tests, role bootstrap, migrations, security, conformance, integration, the reference-host test, the full suite, and last
`npm run test:m1-gate`. It was linted with actionlint and its commands were replayed locally against a fresh `postgres:16` container; **it has not
yet had a first run on GitHub Actions**. To break it on purpose, remove one authorization check from `packages/security/src/gateway/stages/authorize.ts`
and run `npm run test:security`: it names the failing scenarios. Restore the file afterwards.

## 8. Clean up

```bash
docker compose -f deploy/compose.yaml exec -T postgres psql -U dap_bootstrap -d postgres -c "DROP DATABASE dap_m1_run;"
```

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| `db:migrate` says to set `DAP_MIGRATE_DATABASE_URL`, or refuses to run | The variable is unset, or it does not connect as `dap_owner` (migrations refuse any other role) |
| Integration or conformance tests fail to connect | PostgreSQL is not up (`docker compose ... up -d --wait postgres`), or `DAP_DATABASE_URL` names a database `dap_app` cannot connect to (grant `CONNECT` in step 0) |
| Host startup throws `ConfigError` | A required variable is missing or malformed (`DAP_DATABASE_URL`, `DAP_ENABLED_ACTIONS` naming an unknown or empty id, `DEV_SESSIONS`) |
| Host startup throws `DevAuthError` | `DAP_ALLOW_DEV_AUTH` is not exactly `1`, or `NODE_ENV` is production (dev auth is always refused there) |
| A capability returns `DENIED` although the user holds its permission | It is not listed in `DAP_ENABLED_ACTIONS` (the global allowlist is default deny), or it is disabled for the tenant |
| `npm run coverage:security` fails with `MODULE_NOT_FOUND` | Known: the script is a leftover from the parked `tooling` branch; its target file does not exist and it is not part of M1 |
