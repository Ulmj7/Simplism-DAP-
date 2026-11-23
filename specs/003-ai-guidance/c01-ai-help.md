# C01 — AI Help widget (browser) for the reference app

Status: implemented on branch `003-c01-ai-help`; validation record at the end of this file. This is a demo of the
**browser ⇄ trusted host** connection. It is not Feature 004, not an admin surface and not production authentication.

## What it is

- **Help launcher** — a 44px button fixed bottom-right on every page (Dashboard, Profile, Settings).
- **Help panel** — docked right at 400px on desktop; a full-width sheet below 768px. Presentation states:
  `closed | idle | submitting | answer | walkthroughRecommendation | clarify | unsupported | error`.
- The user types a question (max 500 characters, the Feature 003 limit) or taps a suggested prompt. The browser sends
  **only** `{ query, semanticContext }`, where `semanticContext` is exactly `GuideApi.context()` (registry metadata and
  availability; never page text, field values, secrets or `data-ai-private/redact/ignore` content).
- A reply is one of: grounded **answer** (+ source titles), a **recommended guide** (needs an explicit *Start guide* click),
  **clarify**, **unsupported**, or **unavailable** (+ *Try again*). All server text is rendered as text nodes (no HTML).

## Wire contract (same-origin JSON; `apps/reference-host/src/http/transport.ts`, `apps/reference-web/src/help/client.ts`)

`POST /api/guidance` body `{ "query": string, "semanticContext": {...} }` — exactly those keys.

| Reply | Shape |
| --- | --- |
| answer | `200 {kind:"answer", answer, sources:[{id,title}]}` |
| recommendation | `200 {kind:"walkthrough", proposalId, title, message}` — **no walkthrough id**, no steps |
| clarify | `200 {kind:"clarify", message}` |
| unsupported | `200 {kind:"unsupported", message}` (Feature 003 fixed text; the internal reason is dropped) |
| unavailable | `503 {kind:"unavailable", message}` (provider failure, unknown result shape) |
| bad request | `400` (non-object / missing or extra keys / query > 500 chars / invalid context), `413`, `415`, `404` |

`POST /api/guidance/start` body `{ "proposalId": string }` →
`200 {kind:"start", walkthroughId}` (the id the trusted executor approved) or `200 {kind:"unsupported", message}`.

Every response carries `cache-control: no-store` and `x-content-type-options: nosniff`; no CORS headers are sent. The
transport binds `127.0.0.1` only and rejects requests whose `Host` is not loopback (DNS-rebinding guard). Body limit 64 KiB
(a maximal valid context is about 31 KB).

## How a guide gets started (the handoff)

1. **Propose.** `/api/guidance` calls Feature 003's `askGuidance` (never `askAndStart`). If the model/selection picks a
   walkthrough the host mints an opaque single-use `proposalId` (256-bit random, 5-minute TTL on an injected clock, at most
   256 pending, bound to the session) and returns only that id and the catalog title. **Nothing is started or approved.**
2. **User clicks *Start guide*.** The browser posts `{proposalId}`.
3. **Approve.** The host redeems the token (deleted on every attempt, so replay fails), then sends the walkthrough id through
   the existing path: `submitWalkthroughStart` → `AiSession.submit` → Policy Gateway → the trusted `startWalkthrough`
   executor. The executor calls a host-side **recording starter**; the host answers `start` only if the Gateway allowed it
   *and* the recorder holds the id the executor actually received for that same submission, and it returns that recorded id.
4. **Browser start.** The browser calls `GuideApi.startWalkthrough(walkthroughId)` **only** with the id from a `kind:"start"`
   reply, closes the panel, and the existing Feature 002 overlay takes over. Raw model output never reaches `GuideApi`; a
   refusal or error never starts anything. A guide already running is handled by the existing `GuideApi` contract (a safe
   message; C01 adds no concurrency rule).

The server-side Gateway approval and the browser overlay start are two different things; C01 does not pretend otherwise.

## Run it locally (dev-only demo)

The host needs PostgreSQL (the Feature 001 Policy Gateway uses it): `docker compose -f deploy/compose.yaml up -d postgres`,
then migrate (`npm run db:migrate` with `DAP_MIGRATE_DATABASE_URL`). Start the host (variable *names* only; set your own values):

```
DAP_DATABASE_URL=…            # app role URL, as in CI
DAP_ENABLED_ACTIONS=demoLookup,startWalkthrough
DAP_ALLOW_DEV_AUTH=1          # explicit dev opt-in; refused when NODE_ENV=production
DEV_SESSIONS='[{"token":"<16+ chars>","userId":"u1","tenantId":"<uuid>","sessionId":"s1","validUntil":"<ISO 8601 with zone>","permissions":["perm.guidance.start"]}]'
DAP_DEMO_SESSION_TOKEN=<the token above>   # the host opens this session itself; the browser never sends an identity
DAP_GUIDANCE_MODEL=fake       # default; offline demo model
DAP_HTTP_PORT=8787            # optional, default 8787
npm run dev:host
```

In a second terminal run `npm run dev:web` and open <http://127.0.0.1:5173/>. Vite proxies `/api` to `127.0.0.1:8787`.
Demo prompts: **"How do I change my profile name?"** (recommends *Update your profile*), **"What is two-factor authentication?"**
(grounded answer + source), **"Help me with settings."** (clarify: two guides match).

Real model (optional, server-side only): `DAP_GUIDANCE_MODEL=anthropic` plus `ANTHROPIC_API_KEY` (and optionally
`DAP_GUIDANCE_MODEL_ID`) in the **host** environment. The key is never sent to, bundled into or logged by the browser app;
a test scans the web source and build output for the variable name and the key prefix.

## Known limits (honest list)

- **Dev authentication only.** `dev-server.ts` opens one shared demo session from `DAP_DEMO_SESSION_TOKEN`, so the transport's
  per-session proposal binding and its 401 path do nothing there. A real host must resolve the session from its own cookie/
  auth layer. This is not production authentication.
- `/api/guidance` has **no rate limit**; a flood could evict pending proposals (store bounded to 256). Every start opens a
  fresh dev-auth session. Redeeming a proposal with the wrong session burns it (fail closed).
- **Start approvals are serialised and bounded.** At most 8 starts wait or run at once (a 9th is answered `503 unavailable`
  immediately). Each start has a 10 s budget that begins when it gets the slot, so the worst-case wait is about 80 s; the widget's
  own request timeout means the user never sees a hang. A timed-out start fails closed (its late result is discarded and can never
  become an approval), but the abandoned Gateway call may continue in the background. Its recording scope is closed on timeout,
  so a late executor cannot provide or consume a newer submission’s approval.
- **Cross-site callers.** A request whose `Sec-Fetch-Site` is present and not `same-origin`/`none` gets a fixed `403`
  (`same-site` is rejected on purpose: on loopback it means another localhost origin). Requests without the header (curl, tests)
  are allowed; this is a cost/CSRF guard for a dev demo, not authentication.
- **Some client errors read as "unsupported".** `400`, `403`, `413` and `415` replies are shown with the safe "unsupported"
  copy, not the "unavailable / Try again" copy. A `403` only occurs on a non-loopback `Host` or a cross-site call, i.e. a
  misconfiguration, so retrying would not help.
- **Id shape is not re-validated in the browser.** The browser accepts any non-empty id (max 128 characters) from a `kind:"start"`
  reply. The Feature 002 id grammar is not exported from `packages/walkthrough` and C01 does not change that package; the runtime
  catalog is a lookup, so an unknown id only produces the "cannot start" message.
- Replies are not streamed; there is no conversation history, no voice, no Records or Guide Library, and no analytics.
- Mobile `role="dialog"` is decided when the panel opens; resizing across 768px while open does not re-evaluate it.
- The browser request timeout (15 s) is longer than the host's model deadline (8 s) by design.
- While a guide runs, the Help panel stays usable (the overlay scrim ignores pointer events); starting a second guide from Help
  is refused with the existing "A guide cannot start right now" message. Esc closes one layer at a time: the running guide, then
  its status dialog, then Help.

## Validation record

Recorded 2026-11-18 on `003-c01-ai-help` at the head named in the last row. Only runs that happened are listed.

| Check | Result |
| --- | --- |
| `npm run lint`, `npm run typecheck`, `npm run check:deps` | pass (369 modules, 1497 dependencies, no violations) |
| `npm run test:arch` | 9 files, 640 tests pass |
| `npm run test:walkthrough` (includes the Help widget tests) | 26 files, 749 tests pass |
| `npm run test:walkthrough:proof` | 2 files, 20 tests pass |
| `npm run build:web` | pass; the built bundle contains neither `ANTHROPIC_API_KEY` nor `sk-ant` |
| Host transport + guidance tests and the Help end-to-end proof, no database (`apps/reference-host/src/http`, `apps/reference-host/src/guidance`, `tests/integration/c01-help-end-to-end.test.ts`) | 15 files, 339 tests pass |
| Independent review (read-only worker) of the C01 diff, including a second pass over the fixes | APPROVE; checked in real Chromium at 1280x800 and with a Vite proxy in front of a real transport + fake model |
| Full CI gate order on a fresh PostgreSQL 16 (`npm ci`, `db:migrate`, lint, typecheck, `check:deps`, `test:arch`, `test:security`, `test:conformance`, `test:integration`, `test:guidance`, `test:walkthrough`, `test:walkthrough:proof`, `build:web`, `npm test`, `test:m1-gate`) at `c412069` | all 15 steps exit 0 |
| `test:security` / `test:conformance` / `test:integration` / `test:guidance` | 26 files, 969 pass + 76 todo / 13 files, 209 pass / 9 files, 144 pass / 36 files, 1016 pass |
| `tests/integration/c01-guidance-transport.test.ts` (real PostgreSQL Gateway; run on its own, not skipped) | 2 of 2 pass: a proposal starts nothing and `/start` with `perm.guidance.start` returns the approved id; a session without that permission is refused with a safe message |
| `npm test` (full suite) | 201 files, 6988 pass + 76 todo (7064); previous baseline 195 files, 6857 pass |
| `npm run test:m1-gate` | PASS: 59 files, 2048 pass + 76 todo, every todo tagged OPTIONAL or FUTURE; previous baseline 57 files, 2038 pass |
| Real browser (Chromium 157, agent-browser) against the real `npm run dev:host` (PostgreSQL, offline fake model) and `npm run dev:web` through the Vite `/api` proxy, 1440x900 | Help launcher 44px high, panel docks 400px with focus in the question box. "How do I change my profile name?" shows "I can guide you through this." with the guide title and a Start guide button, and starts nothing (route still Dashboard, 0 overlay nodes). Start guide opens Profile, closes the panel, and the real ring sits 4px around the name field (ring 161,361 488x52 vs field 165,365 480x44) with "Step 1 of 2". Esc cancels the guide, a second Esc closes the dialog, focus returns to the AI Help launcher. "What is two-factor authentication?" returns the answer with a source and no Start button. "Help me with settings." returns the clarifying question and starts nothing. Of the request bodies, only the two later questions were captured in the page (each began `query`, then `semanticContext`, truncated at 260 characters); the exact key sets of the ask and start bodies are asserted by the automated tests, not by this manual run |
| Same, 390x844 | launcher 99x44 at the bottom right; sheet 390x820 with `role=dialog`; no horizontal scroll; no control under 44px; Start guide opens the overlay with the card at 8,8 (374x290, inside the viewport) and not touching the ring (card bottom 298, ring top 423) |
| Real host stopped while Help is open | "Help is temporarily unavailable." with Try again; no Start button; no overlay |
| Real-provider smoke (`DAP_GUIDANCE_MODEL=anthropic`) | not run: no `ANTHROPIC_API_KEY` is configured |
| GitHub Actions | the branch was pushed at `c412069` (CI started); its result is not recorded here |

The Help end-to-end proof mounts the real reference app and the real browser client against the real host transport (Fastify
`inject`) with the offline fake model. It uses a labelled **fake Gateway submit** in place of the PostgreSQL-backed Gateway, so it
shows the proposal → click → approved start → overlay path, not the database-backed approval; the PostgreSQL test covers that.

## Deferred (not part of C01)

Feature 004 (admin authoring), conversation history, analytics UI, Records expansion, full Guide Library, a production
session/auth layer, rate limiting, and a live-provider smoke test (needs `ANTHROPIC_API_KEY`).
