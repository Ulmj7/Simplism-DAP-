# Reference host (Feature 001, T131 / T132)

A minimal runnable composition of the AI Security Foundation. **It is not a production authentication system or application platform.**
`composeReferenceHost(env)` validates the environment, then wires the real Policy Gateway to PostgreSQL (audit, replay, rate limits, tenant policy)
and the host's three demo capabilities (`src/capabilities.ts`). It returns the host side (`openSession`, `close`) and a separate trusted view of the
executors. The AI layer is only ever given an `AiSession`: one `submit` function.

| Variable | Meaning |
| --- | --- |
| `DAP_DATABASE_URL` | PostgreSQL URL of the unprivileged `dap_app` role (from the environment, never the repository) |
| `DAP_ENABLED_ACTIONS` | comma-separated demo capability ids on the global allowlist (default deny) |
| `DAP_GATEWAY_CONFIG` | optional complete JSON gateway configuration replacing the defaults |
| `DAP_ALLOW_DEV_AUTH=1` | explicit opt-in for the development authentication stub; startup is refused without it, and always when `NODE_ENV=production` |
| `DEV_SESSIONS` | JSON array of `{ token, userId, tenantId, sessionId, validUntil, permissions? }`; anything malformed or duplicated fails startup |

Confirmation is not built: a HIGH/CRITICAL capability stops at `REQUIRES_CONFIRMATION` and its executor never runs (the store and channel are fail-closed placeholders).
The end-to-end proof is `tests/integration/reference-host.test.ts`; startup and dev-auth checks are `src/startup.test.ts`.

Each trusted `openSession` starts a new turn: reusing a provider call id inside that turn
is a replay, while the same id in a new host-opened turn is a new proposal. The AI-facing
handle cannot open turns. This is not exactly-once execution across host retries.
`composeReferenceHost` and its trusted result are host APIs, never model tools. AiSession
limits object capabilities; it is not a sandbox for arbitrary JavaScript or process globals.
Production mode checks ignore surrounding whitespace and case; opt-in remains exactly `1`.

## Docker lab

From the repository root, create a Git-ignored `.env.docker.local` with a
fresh local demo session. Use a random token of at least 16 characters in both
entries and set `validUntil` to a future ISO 8601 timestamp.

```dotenv
DAP_DEMO_SESSION_TOKEN=<local-demo-token>
DEV_SESSIONS='[{"token":"<local-demo-token>","userId":"lab","tenantId":"11111111-1111-4111-8111-111111111111","sessionId":"docker-lab","validUntil":"<future-ISO-8601-timestamp>","permissions":["perm.guidance.start"]}]'
```

```sh
docker compose --progress plain --env-file .env.docker.local -p dap-docker-lab -f deploy/compose.yaml --profile lab build app
docker compose --env-file .env.docker.local -p dap-docker-lab -f deploy/compose.yaml --profile lab up -d --no-build
docker compose --env-file .env.docker.local -p dap-docker-lab -f deploy/compose.yaml --profile lab ps -a
curl --fail-with-body --retry 5 --retry-connrefused -H 'Content-Type: application/json' \
  -d '{"query":"How do I change my profile name?","semanticContext":{"route":"profile","elements":[{"id":"profile.displayName","role":"textbox","label":"Display name","description":"Your public name","privacy":"public","available":true}]}}' \
  http://127.0.0.1:8787/api/guidance
```

Once the app has started, the guidance request returns `kind: "walkthrough"`.
The `migrate` service exits with code 0 and the app stays up on host loopback.
The optional `DAP_OWNER_PASSWORD` and `DAP_APP_PASSWORD` overrides must use
URL-safe characters and match the passwords used to initialize the PostgreSQL
volume. Repeat the build after changing a backend TypeScript file to verify
that both npm install steps are cached while TypeScript recompiles.

For the three-replica Kubernetes version, see the [Minikube lab](../../deploy/k8s/README.md).
