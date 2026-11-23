# Feature 003 quickstart

Prerequisites: Node 22+, npm and Docker. Run from the repository root.
These passwords/token are local-only fixtures, never deployment credentials.

```sh
npm ci
docker compose -f deploy/compose.yaml up -d postgres
docker compose -f deploy/compose.yaml exec -T postgres psql -U dap_bootstrap -d postgres -v ON_ERROR_STOP=1 -c 'CREATE DATABASE dap_f3_guidance_demo_20261117 OWNER dap_owner' -c 'GRANT CONNECT ON DATABASE dap_f3_guidance_demo_20261117 TO dap_app'
export DAP_DATABASE_URL=postgresql://dap_app:dap_app_local_only@127.0.0.1:54329/dap_f3_guidance_demo_20261117
export DAP_MIGRATE_DATABASE_URL=postgresql://dap_owner:dap_owner_local_only@127.0.0.1:54329/dap_f3_guidance_demo_20261117
npm run db:migrate
export DAP_ALLOW_DEV_AUTH=1
export DAP_ENABLED_ACTIONS=demoLookup,startWalkthrough
export DEV_SESSIONS='[{"token":"local-demo-only-token","userId":"alice","tenantId":"11111111-1111-4111-8111-111111111111","sessionId":"demo-session","validUntil":"2099-01-01T00:00:00Z","permissions":["perm.guidance.start"]}]'
export DAP_DEMO_SESSION_TOKEN=local-demo-only-token
export DAP_GUIDANCE_MODEL=fake
npm run test:guidance
npm run guidance:demo -- 'How do I change my profile name?'
npm run guidance:demo -- 'What is two-factor authentication?'
npm run guidance:demo -- 'Help me with settings.'
```

A prints `Walkthrough started:` then `profileUpdate`, followed by the no-browser demo notice.
B prints `Answer:`, a short explanation, then `Sources:` and `- Two-factor authentication`.
C prints `Clarification:` and a question naming the two settings guides.
The fake model is a deliberately scripted offline demo fixture; it is the default.
The CLI compiles TypeScript and runs the real PostgreSQL host and Gateway, with a recording
starter because no browser is attached. Dev authentication is refused in production.

To use the real provider manually, set ANTHROPIC_API_KEY in your shell (never commit it), then:

```sh
export DAP_GUIDANCE_MODEL=anthropic
# Optional: export DAP_GUIDANCE_MODEL_ID=your-provider-model-id
npm run guidance:demo -- 'What is two-factor authentication?'
```

The default `claude-haiku-5-5` is an unverified model-list assumption; override it with an
available Anthropic model id. Adapter implemented; live smoke test NOT performed because
no key is configured. CI never needs a key, network provider or live call.
Transport failures produce a fixed unsupported message, never provider diagnostics or secrets.

Add knowledge: place one validated public Markdown/front-matter document in
`apps/reference-host/knowledge/` (copy an existing article's format; secrets/tenantId reject startup).
Add a summary: edit the one `walkthrough-summaries.ts` list; real-catalog parity waits for T217-T219.
Final UI connection: the browser Help widget and its narrow host transport are the C01 slice, described in
`c01-ai-help.md` (wire contract, how a proposal becomes a user-confirmed start, how to run `dev:host` and
`dev:web`). The transport uses `askGuidance` and a recording starter, not `askAndStart`, because the browser overlay
start must follow the user's click. The only change to this feature's host code is that `createGuidanceHost`
also exposes `askGuidance` (the proposal step alone); `packages/*` and `askAndStart` are untouched.

Limits: lexical selection is heuristic; ALLOWED alone is not proof of a start; citation
membership is not entailment. Knowledge is shared public material. Tenant-owned retrieval
would trigger tenant-scoped storage/retrieval and isolation tests before it could be added.
One model call, no retries/tools/streaming; 7-second provider abort inside the core's 8 seconds.

Full gates (same throwaway DB):

```sh
npm run lint
npm run typecheck
npm run check:deps
npm run test:walkthrough
npm run build:web
npm test
npm run test:m1-gate
npm run test:guidance
git diff --check dev
docker compose -f deploy/compose.yaml exec -T postgres psql -U dap_bootstrap -d postgres -v ON_ERROR_STOP=1 -c 'DROP DATABASE dap_f3_guidance_demo_20261117'
```

Use a new throwaway database name for each repeat; never reuse or drop the shared `dap`.
