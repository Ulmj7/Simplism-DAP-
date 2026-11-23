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
