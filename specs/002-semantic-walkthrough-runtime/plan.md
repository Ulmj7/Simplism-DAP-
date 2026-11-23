# Implementation Plan: Semantic Walkthrough Runtime

**Spec**: [spec.md](./spec.md) · **Tasks**: [tasks.md](./tasks.md) · **Date**: 2026-11-16 · **Base**: `dev` (verified against `dev` @ `42ac15f`; the repository, not older planning documents, is the source of truth)

## 1. Where this sits (Constitution 2.0.0)

Phase 1 of the Constitution's phased delivery still owes the **UI semantic registry and the client-side privacy layer** (Feature 001 delivered the Action Registry, Gateway, audit and reference host). Phase 2 asks for guidance: highlight, tooltips, step-by-step, allowlisted internal navigation, waiting for registered UI events. Feature 002 delivers both, deterministically and without an LLM. Feature 003 adds intent selection and RAG on top and calls this feature's narrow API. Formal maintainer sign-off for Feature 001 is recorded separately; this plan proceeds on the owner's directive.

## 2. What exists today (verified)

- **Workspaces**: npm workspaces `packages/*`, `apps/*`. Packages: `contracts`, `ai` (`PlannerPort`, `RawToolCall`, `toProposalCall`), `actions` (empty), `security` (registry, `createPolicyGateway`, Postgres stores, audit), `testkit`. Apps: `reference-host` only.
- **`apps/reference-host`** is a backend composition root (`composeReferenceHost`, dev auth, demo capabilities). It has **no HTTP server and no UI** (its `package.json` lists `fastify`, `pino`, `prom-client` but nothing imports them).
- **No browser frontend exists**: no HTML, no framework, no bundler, no DOM test environment, no Playwright.
- **Tooling**: TypeScript 6 with `tsc -b` project references, Node 22, Vitest 5 (`test.projects`: `unit`, `conformance`, `arch`, `security`, `integration`), ESLint 10, dependency-cruiser rules (`ai/actions/security` mutually isolated, `contracts-leaf`, `production-not-to-testkit` incl. `apps/`, `nothing-imports-apps`, mint entry restricted, no circular, no runtime module loaders).
- **CI**: one `verify` job (Node 22, `postgres:16` service): lint, typecheck, dependency-cruiser, arch, role bootstrap, migrate, security, conformance, integration, reference-host file, `npm test`, M1 gate last.
- **Feature 001 API relevant here**: `createPolicyGateway`, `buildRegistry`, `defineAction`, `@dap/ai`'s `toProposalCall`, and the host's `AiSession.submit`. This feature does **not** import any of them.

## 3. Decisions (each passed the scope test)

| Decision | Why | Rejected |
|---|---|---|
| **New package `packages/walkthrough`** (`@dap/walkthrough`) | Establishes a real trust boundary: a leaf package that dependency-cruiser forbids from importing `security`, `ai`, `actions`, `contracts`, `testkit`, so the UI runtime can never reach an executor; also satisfies "privacy layer is its own module with its own unit tests" (Principle VI) | Putting it in `apps/` (not reusable, boundary unenforced); several packages (config cost, no extra boundary) |
| **One package, two entry points**: `.` (pure core) and `./dom` (browser adapter) | Same pattern as `contracts/mint`; core stays testable in Node; only `src/dom/**` may touch `document`/`window` (arch test) | Separate `walkthrough-dom` package |
| **Reference app `apps/reference-web`: Vite + vanilla TypeScript, hash router, no framework** | Smallest thing that is a real browser app; zero framework learning/config; semantic IDs are plain `data-ai-id` attributes | React/Vue/Tailwind (time, no demo value) |
| **jsdom (Vitest `dom` project) for the REQUIRED integration proof**; Playwright is OPTIONAL | Fast, runs in existing CI with no browser download; the engine is deterministic so DOM events are enough to prove the flow. Visual ring placement and interaction feel get one **manual real-browser smoke check at final closure** (REQUIRED once, recorded in the quickstart) | Playwright as REQUIRED (CI browser install + flake risk for the first half of the budget) |
| **Runtime performs no state change; user performs the app actions** | Keeps Constitution III/VIII out of the critical path; Save is the app's own handler; the runtime only observes and verifies | Routing Save through the Gateway (a server round trip nobody needs for a guidance demo) |
| **Core has zero runtime dependencies** | Small browser bundle, nothing to audit; hand-written bounded validation | zod in the browser bundle |
| **Postconditions are named functions supplied by the app** | Definitions stay pure data; checks stay trusted code | Expression language, inline lambdas in data |
| **Input waits complete on the committed `change` event** (blur/Enter), not every keystroke | Deterministic, no timers or debouncing, natural UX because clicking Save blurs the field first | Debounced keystroke detection |
| **Untrusted (synthetic) DOM events are ignored by default** (`trustedEventsOnly: true`) | One line; makes "registered raw user interaction" real. Tests construct the bridge with `false`; an arch check keeps production `main.ts` on the default | Accepting all events |

**Presentation boundary (2026-11-16).** The UI/UX is designed separately by a human, so the walkthrough core is deliberately non-visual. It emits typed, **Update 2026-11-17:** the UI/UX brief arrived. The P0 UI plan is [ui-p0.md](./ui-p0.md); this boundary is unchanged (the engine stays non-visual; presentation is app-side plus an additive upgrade of the `dom` overlay).
presentation-neutral effects as plain data (`present { stepId, target?, text, expects }` and `clear`) to a `presenter` port, asks a `targets` port
whether a semantic id is available, and receives semantic events (`click`, `input` with `nonEmpty`, `routeChanged`, `targetAvailable`, `targetGone`,
`ack`) through `runtime.dispatch`. No effect carries a selector, style, coordinate or element. The DOM bridge, the hash-router wiring, the help
launcher and progress UI, and the three product walkthrough definitions follow once the UI exists (T211 and T213 UI parts, T216 to T223). The Slice 1
DOM targets and overlay stay as the working demo adapter; the designed UI will replace the overlay's appearance, not the core.

## 4. Architecture

```text
packages/walkthrough/                 @dap/walkthrough   (leaf: no @dap/* imports, zero runtime deps)
  src/semantic/    types.ts registry.ts           trusted registry; duplicate/unknown/malformed -> startup failure
  src/privacy/     privacy.ts                     OWN MODULE + OWN TESTS: annotations, effective privacy, value view, context builder
  src/walkthrough/ definition.ts catalog.ts       typed definitions + startup validation
  src/engine/      events.ts machine.ts ports.ts runtime.ts   pure transition() + thin effect runner + public API
  src/dom/         targets.ts bridge.ts overlay.ts            ONLY place that touches document/window  (entry: @dap/walkthrough/dom)
  src/index.ts     public core API
apps/reference-web/                   @dap/reference-web (private; may import only @dap/walkthrough)
  index.html vite.config.ts
  src/main.ts router.ts store.ts pages/{dashboard,profile,settings}.ts
  src/semantic-ui.ts postconditions.ts launcher.ts
  src/walkthroughs/{profileUpdate,findSecuritySettings,findTwoFactorSettings}.ts
```

Dependency direction: `apps/reference-web -> @dap/walkthrough(/dom)`. Nothing in `packages/*` imports `walkthrough` except the app; `security`, `ai`, `actions`, `contracts` must never import it (new cruiser rules). `reference-host` is untouched.

### 4.1 Semantic registry

`SemanticElementDef = { id, route, role, label, description, operations, privacy }`.
- `id`: `^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)+$`, e.g. `profile.nameInput`.
- `role`: `button | link | textbox | checkbox | select | panel | nav | heading | text` (no password role exists).
- `operations`: non-empty subset of `highlight | click | input | focus` (what a walkthrough may do with it).
- `privacy`: `public | private | redact`.
- `label`, `description`: plain text, bounded (label <= 80, description <= 240), no markup characters; rendered only through `textContent`.
- `createSemanticRegistry({ routes, elements })`: frozen result; rejects duplicate IDs, malformed IDs, unknown routes, empty operations, bad bounds. Lookups use a `Map`. `get`, `has`, `list`, `forRoute`.

The app owns the mapping to real elements: it puts `data-ai-id="profile.saveButton"` on markup. The DOM adapter finds an element by iterating `root.querySelectorAll("[data-ai-id]")` and comparing the attribute value to the registry **as a string**. It never builds a selector from a semantic ID, a definition, or an event.

### 4.2 Privacy boundary (own module, Tier A VI)

- Attributes: `data-ai-id`, `data-ai-ignore`, `data-ai-private`, `data-ai-redact`.
- **Effective privacy** of an element = `ignore` if it or any ancestor has `data-ai-ignore`, or it is `input[type=password|hidden]` (always, even if registered); else `private` / `redact` / registry `privacy`.
- `ignore` => untargetable, no events, reported as unavailable. `private` => value omitted entirely. `redact` => fixed marker `[REDACTED]`. `public` text field => only `nonEmpty: boolean`.
- `buildSemanticContext(registry, route, availability)` is the **only** producer of data meant for AI use: `{ route, elements: [{ id, role, label, description, privacy, available }], walkthrough?: { id, step, state } }`. It never reads the DOM, values, text, or HTML. Unit tests prove that private/redacted/ignored fixtures leak nothing.

### 4.3 Walkthrough definitions

```ts
type Step =
  | { id; kind: "guide";    target: SemanticId; text; wait: "click" | "input" | "ack";
      verify?: PostconditionName; next: StepId; recover?: StepId; targetWaitMs?: number; maxAttempts?: number }
  | { id; kind: "navigate"; route: RouteId; text?; next: StepId; recover?: StepId }
  | { id; kind: "complete"; text };
type WalkthroughDef = { id; title; description; start: StepId; steps: readonly Step[] };
```
`createWalkthroughCatalog(registry, postconditionNames, defs)` fails startup on: duplicate walkthrough or step IDs, missing start/next/recover step, unknown target (or an `operations` mismatch: `click` wait needs `click`, `input` needs `input`, every guide needs `highlight`), unknown route, unknown postcondition name, no path from `start` to a `complete` step, steps unreachable from `start`. That is the whole "language". Catalogs are capped at 100 walkthroughs and 100 steps each. Every step's success-only `next` chain must reach `complete`; only `recover` edges may form retry loops.

### 4.4 State machine

Pure `transition(state, input) -> { state, effects }`; the runtime runs effects (resolve target, show/hide overlay, navigate, evaluate postcondition, schedule timeout) through injected ports and feeds results back as inputs. All timers are injected, so tests need no real time.

States: `IDLE, RESOLVING, PRESENTING, WAITING, VERIFYING, COMPLETED, FAILED(reason), CANCELLED`.
Inputs: `start`, `targetFound`, `targetWaitExpired`, `presented`, `presentFailed`, `event`, `navigated`, `navigationRefused`, `verified(bool)`, `verifyFailed`, `internalError`, `cancel`. Semantic events include payload-free `ack`, which satisfies only an `ack` wait.

| From | Input | To |
|---|---|---|
| IDLE / terminal | `start(valid id)` | RESOLVING(start step) (unknown id: refused, state unchanged) |
| RESOLVING (guide) | `targetFound` or matching `targetAvailable` | PRESENTING |
| RESOLVING (guide) | `targetWaitExpired` | `recover` ? RESOLVING(recover) : FAILED `target_unavailable` |
| RESOLVING (navigate, no text) | `navigated` | VERIFYING (implicit route check) |
| RESOLVING (navigate) | `navigationRefused` | FAILED `navigation_refused` |
| PRESENTING | `presented` / `presentFailed` | WAITING / FAILED `present_failed` |
| WAITING | `event` that exactly matches the step | `verify` ? VERIFYING : advance(`next`) |
| WAITING | any other event (wrong id, wrong type, unknown) | unchanged |
| WAITING | `targetGone` for the current target | RESOLVING(same step) |
| VERIFYING | `verified(true)` | advance(`next`) |
| VERIFYING | `verified(false)` / `verifyFailed` | `recover` ? RESOLVING(recover) : FAILED `verification_failed` |
| live state | `internalError` | FAILED `internal_error` (cancel timers and clear) |
| live state (not IDLE) | `cancel` | CANCELLED |
| any non-terminal | `start` | refused (`busy`) |

`advance(next)` enters the next step: COMPLETED for a complete step, RESOLVING for a guide or automatic navigation, PRESENTING for navigation with instruction text. Cancelling IDLE or a terminal state is a no-op. Every entry into a step through `recover`/re-resolve increments its attempt count; beyond `maxAttempts` (default 3) the run ends FAILED `max_attempts`. Events while VERIFYING are ignored. An event is consumed by exactly one step per dispatch. A navigate step with `text` presents an instruction and waits for the matching `routeChanged`; one without text uses the synchronous router port. Both then emit `verifyRoute` and read the actual router state before advancing. Neither a route event nor an `ack` substitutes for a postcondition. `targetAvailable` is meaningful only in RESOLVING; ordinary events in PRESENTING/VERIFYING are ignored.

Re-entrant callbacks are queued. Cancellation suppresses pending presentation; timers are single-use and generation-checked again when their queued result is processed. A start requested from a live callback returns `busy`; callers may start again after the terminal snapshot is delivered. Effects and snapshots are frozen. The per-run bound counts state-changing transitions, not unbounded no-op inputs or repeated host-started runs. Human WAITING states intentionally have no overall deadline.

### 4.5 Event flow

```text
user click / change
   -> DOM bridge: delegated listener on the app root; ignores untrusted events; element.closest("[data-ai-id]");
      id looked up in the registry Map; privacy check; emits a typed SemanticEvent (input carries nonEmpty only)
   -> runtime.dispatch(event) -> transition(state, event) -> { state', effects }
   -> ports: targets.resolve / presenter.show|hide / router.navigate / postcondition() / timers
   -> results come back as inputs; subscribers (the launcher UI) re-render progress
router (hashchange)  -> routeChanged(route)             MutationObserver -> targetAvailable / targetGone
```

### 4.6 Ports (all injected; the engine imports no DOM)

The built core ports are `targets: { resolve(id): "available" | "unavailable" }`, `presenter: { apply(PresentationEffect): void }`, `router: { current(): string; navigate(route): void }`, `timers: { set(callback, ms): Cancel }`, and named `postconditions`. No core port holds a DOM handle. The pending UI adapter will translate Slice 1 target handles/overlay operations into these ports and forward route, acknowledgement and availability events through `dispatch`; subscriptions belong to that adapter, not to the core port interfaces.

The synchronous ports are trusted host adapters, not sandboxed code. The timer port must return a cancellation function and eventually invoke active callbacks; a never-firing timer cannot establish elapsed time. The core cannot preempt a synchronously blocking callback or guarantee physical timer cleanup when the host never supplies a valid handle. Verification timeouts bound asynchronous checks only while the timer port works. The pure `transition` helper is public for diagnostics/testing but holds no runtime state; `test-support` is not a public entry. Feature 003 still receives a narrower trusted facade, not this full host API.

## 5. Feature 001 integration (what is reused, what is respected)

- **Reused as-is**: none of its code is imported. The leaf-package rule is the integration: the guidance runtime physically cannot reach `security`, executors or the audit store.
- **Application mutations**: the runtime performs none (FR-011). The demo Save is the app's own handler; if a later feature lets a walkthrough perform a mutation, it MUST be a registered capability through the Gateway.
- **Limits respected, not claimed solved**: `ALLOWED` is not proof of effect; no exactly-once; audit COMMIT window; execution cap is per tenant/session/turn and can reset on a new host turn; dev auth is session-bound; DB admins trusted; URL validation is not credential validation; some audit events are best-effort. Because this feature calls no Gateway, none of these is exercised or weakened.
- **Feature 001 CI and the M1 gate stay untouched**; the new tests are additive.

## 6. Feature 003 integration point

```ts
interface DapRuntime {
  catalog: { list(): readonly { id: string; title: string; description: string }[] };
  startWalkthrough(id: string): { ok: true } | { ok: false; reason: "unknown_walkthrough" | "busy" | "invalid_id" };
  cancel(): void; getState(): EngineSnapshot; subscribe(fn): Unsubscribe; context(): SemanticContext;
}
```
Feature 003 registers a Feature 001 capability `startWalkthrough({ walkthroughId: enum(catalog IDs) })` (initial risk class **LOW**, no application state change: a walkthrough may navigate internally, and one capability cannot be SAFE for some walkthroughs and LOW for others, so the cleaner rule is LOW now; a separate display-only SAFE capability can be added later if it earns its place). A walkthrough never inherits authority for application mutations: the runtime has no executor, no Gateway access and no path to state-changing code; its **trusted host executor** forwards the ID to the browser over a transport that Feature 003 designs. The model only ever selects an existing ID and receives `{ok}` feedback; it never holds `DapRuntime`, a selector, or a definition. `runtime.startWalkthrough` re-validates the ID, so a compromised caller still cannot start anything outside the catalog. `context()` is the only UI data the AI layer may read, and it is already privacy-projected. The runtime knows nothing of prompts, models, embeddings or RAG.

## 7. Testing strategy (focused, not Feature 001 scale)

| Layer | Tool | Covers |
|---|---|---|
| Registry, privacy, definitions/catalog, machine, runtime (fake ports + injected timers) | Vitest `unit` (Node) | registration failures; ignored/private/redacted/password; invalid catalogs; every transition and every refused transition; complete/cancel/busy; wrong/unknown events; postcondition true/false/throw/timeout; recovery and `maxAttempts`; navigation allowlist |
| DOM targets, bridge, overlay | Vitest `dom` (jsdom) | exact-attribute lookup (no selector building), ignore/hidden/password, trusted-only events, `change` commit, MutationObserver availability, overlay text via `textContent`, teardown |
| Architecture | Vitest `arch` + dependency-cruiser | leaf package; allowed edges; no DOM globals in core; no `eval`/`new Function`/`innerHTML`/`insertAdjacentHTML`/`document.write`/`fetch`/`WebSocket` in new sources; production `main.ts` keeps `trustedEventsOnly` default; planted-failure proofs |
| Integration | Vitest `dom` against the real reference app | A, B, C start -> complete; failed-postcondition recovery (A); missing-target recovery (C); wrong click does not advance; in-app privacy checks; unknown walkthrough refused |
| Real browser | Playwright (automated) | OPTIONAL; one manual smoke check at closure is REQUIRED |

New scripts: `test:walkthrough` (unit + dom + new arch file), `dev:web`, `build:web`. New dev dependencies: `vite`, `jsdom` only.

## 8. Slices (vertical, each independently demonstrable) and QA policy

1. **First visible walkthrough** (T201-T207): registry + privacy + DOM targets/overlay + reference app shell -> "Show me" highlights a real element with a tooltip.
2. **Deterministic engine** (T208-T210): catalog, pure machine, runtime and public API, all with fake ports.
3. **User interaction** (T211-T213): events + bridge, wait semantics, internal navigation.
4. **Verification and recovery** (T214-T215): postconditions, recover/bounded attempts.
5. **Reference product integration** (T216-T223): app behaviour, three walkthroughs, launcher, jsdom integration, CI, short quickstart.

Parallelism: T202/T203/T204/T205/T206 are independent after T201; T217-T219 are independent after T216. Two developers can run most of each slice side by side.
**QA policy (to avoid Feature 001's cost)**: three reviews only: (1) a focused review after Slice 1; (2) one combined review for Slices 2-4; (3) a final review after Slice 5, which includes the manual real-browser smoke check. Reviews focus on Tier A (privacy VI, no arbitrary selectors VII, leaf boundary) plus the slice acceptance, with one repair round each. Normal tests (lint, typecheck, dependency-cruiser, `test:walkthrough`, `npm test`) run continuously and once per review. No mutation campaigns or mutant sweeps; a double full-suite run only at final closure.

## 9. Scope-creep register

| Risk | Rule |
|---|---|
| Overlay polish (arrows, flipping, animation) | A positioned ring + card is enough; polish is OPTIONAL |
| Workflow-language drift (conditions, loops, expressions) | Three step kinds, one `recover` edge, `maxAttempts`; nothing else |
| Real-browser CI | OPTIONAL until the jsdom proof is green |
| Framework adoption (React, Tailwind, state libraries) | Vanilla TS only |
| Per-element permissions / authorization | Backend authorization stays authoritative; gating is OPTIONAL |
| Feature 003 transport, intent selection, RAG | Not here; only the narrow API |
| Persistence across refresh, multi-tab | OPTIONAL / FUTURE |
| Feature 001 style QA depth | Slice-level QA only (section 8) |
| Reopening Feature 001 | Only for a genuine Tier A defect, with a regression test |

## 10. Why this fits the time budget

23 REQUIRED tasks: most are small pure-TypeScript units with fake-port tests; the DOM adapter is three files; the reference app is a few static pages and one store; each walkthrough is a ~30-line definition. There is no database, no server, no new security subsystem, and the only new dependencies are `vite` and `jsdom`. With two developers in parallel and slice-level QA, the REQUIRED work targets roughly **the first half of the remaining build (about 5-6 hours wall-clock)**, with a visible demo after Slice 1 and a complete second flow after Slice 3, leaving the rest of the budget for Feature 003.
