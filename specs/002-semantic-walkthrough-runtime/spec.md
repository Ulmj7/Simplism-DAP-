# Feature Specification: Semantic Walkthrough Runtime

**Feature directory**: `specs/002-semantic-walkthrough-runtime` (feature work is cut from `dev`; `main` is reserved)
**Created**: 2026-11-16
**Status**: Draft, planning only (no code yet). Supersedes the older, much larger `specs/002-ui-semantic-layer/spec.md`, whose P1 intent (registry, privacy annotations, unknown IDs fail closed) is carried here and whose P2/preview/catalogue items are OPTIONAL or FUTURE.
**Governing document**: Constitution 2.0.0 (Tier A/B/C, XVIII Delivery Scope, XIX Scope Discipline).
**Input**: Build the interactive, deterministic walkthrough system that Feature 003 (natural-language intent + small secure RAG) will later invoke. It must work completely without an LLM and be visibly demonstrable in a browser.

## Scope declaration (REQUIRED / OPTIONAL / FUTURE)

The scope test for every item: *is it needed for a person to visibly complete one of the three demo walkthroughs, or to preserve a Tier A invariant?* If not, it is OPTIONAL or FUTURE.

- **REQUIRED**: trusted semantic UI registry; minimal UI privacy model (`data-ai-id/ignore/private/redact`); typed walkthrough definitions validated at startup; an explicit deterministic state machine; highlight + tooltip presentation; waiting for a registered click / committed input / route; wrong and unknown events never advance a step; deterministic postconditions; one bounded recovery pattern; internal allowlisted navigation; a small reference web app with three walkthroughs; a narrow public API for Feature 003; one jsdom integration proof per walkthrough; CI wiring; one manual real-browser smoke check at final closure.
- **OPTIONAL** (promote only if a demo needs it): real-browser (Playwright) smoke test, progress persistence across refresh, animation and richer overlay positioning, fuller accessibility pass, more than three walkthroughs, richer branch expressions, per-element permission gating, a "what the AI sees" preview panel.
- **FUTURE**: AI-authored walkthroughs, self-healing selectors, vision-based targeting, browser extension, third-party sites/apps, multi-device sync, generic workflow language, authoring dashboard, analytics, autonomous high-risk operations, the server-to-browser transport that lets Feature 003 start a walkthrough.
- **Out of scope**: RAG, embeddings, intent selection, any LLM call, new authentication, any change to Feature 001 production code, any backend state change performed by the runtime.

## User Scenarios & Testing

### User Story 1 - See the right element highlighted with guidance (P1)

A person asks for help and sees a real element of the page highlighted with a short instruction next to it.

**Independent test**: in the reference app, trigger a guide step on `profile.nameInput`; the overlay ring sits on that element and a tooltip shows the instruction text.

**Acceptance scenarios**:
1. **Given** a registered, visible target, **When** a guide step is presented, **Then** the target is highlighted and the registered-safe instruction text is shown.
2. **Given** a semantic ID that is not registered, **When** anything asks to present it, **Then** nothing is highlighted and the request fails safely with a typed reason.
3. **Given** a target that is hidden or absent, **When** a step needs it, **Then** the runtime waits at most the step's bounded wait and then recovers or fails (US3); it never highlights a different element.

### User Story 2 - The walkthrough waits for the exact expected interaction (P1)

The runtime advances only when the user does what the step asks.

**Independent test**: a step waiting for a click on `profile.saveButton` is not advanced by a click on `settings.cancelButton`, by a free-form event, or by a synthetic (untrusted) event.

**Acceptance scenarios**:
1. **Given** a step waiting for `click` on `profile.saveButton`, **When** that element is clicked by the user, **Then** the step moves to verification.
2. **Given** the same step, **When** any other registered element is clicked, an unregistered element is clicked, or an unknown event arrives, **Then** the state does not change.
3. **Given** a step waiting for input on `profile.nameInput`, **When** the user commits a non-empty value (change/blur/Enter), **Then** the step moves on, and the event carries only `nonEmpty: true`, never the value.
4. **Given** a step that waits for acknowledgement, **When** the user presses the overlay's own "Got it" control, **Then** the step moves on.

### User Story 3 - Verified progress, with recovery (P1)

Interaction is not success. After an important step the runtime checks a trusted postcondition and either advances, recovers, or fails.

**Independent test**: Walkthrough A: type a one-character name, click Save, the app rejects it (`profile.saved` stays false), the runtime shows retry guidance and returns to the name step; a valid name then verifies and completes.

**Acceptance scenarios**:
1. **Given** a click step with postcondition `profile.saved`, **When** the postcondition returns exactly `true`, **Then** the runtime advances to the success step.
2. **Given** the same step, **When** the postcondition returns anything else, throws, or times out, **Then** the runtime takes the step's recovery step if one exists, otherwise ends in FAILED with a reason code; it never advances falsely.
3. **Given** a step whose target is missing, **When** a recovery step exists (Walkthrough C: open the Advanced panel), **Then** the runtime performs the recovery and retries the original step; attempts are bounded.

### User Story 4 - Trusted semantic UI with a minimal privacy model (P1, Tier A)

Application code registers stable semantic IDs (`profile.saveButton`); no model, walkthrough, or event can supply a selector. Private data never leaves the privacy layer.

**Independent test**: a page with a password field, a `data-ai-private` email input, a `data-ai-redact` field and a `data-ai-ignore` panel yields a semantic context that contains none of their values or text, and ignored/password/hidden elements cannot be targeted.

**Acceptance scenarios**:
1. **Given** two registry entries with the same ID, **When** the registry is created, **Then** startup fails.
2. **Given** a walkthrough step naming an unknown semantic ID, route or postcondition, **When** the catalog is created, **Then** startup fails.
3. **Given** `data-ai-ignore` on an element or ancestor, or `type=password|hidden`, **When** resolving or listening, **Then** the element is treated as absent and emits no events.
4. **Given** `data-ai-private` / `data-ai-redact`, **When** the semantic context is built, **Then** values are omitted / replaced by a fixed marker and only registry metadata is exposed.
5. **Given** any code path, **When** the semantic context is produced, **Then** it contains only registry metadata (id, role, label, description, route, availability, privacy class) and never DOM text, `value`, `innerHTML`, or screenshots.

### User Story 5 - Three working walkthroughs and a narrow API (P2)

A help launcher lists three walkthroughs and starts one by ID; progress and completion are visible. Feature 003 will call the same narrow API.

**Independent test**: start each of A (`profileUpdate`), B (`findSecuritySettings`), C (`findTwoFactorSettings`) from the launcher and complete it end to end in jsdom against the real app DOM.

**Acceptance scenarios**:
1. **Given** the catalog, **When** `startWalkthrough("profileUpdate")` is called, **Then** the run starts; **When** the ID is unknown, **Then** it returns `{ ok: false, reason: "unknown_walkthrough" }` and does nothing else.
2. **Given** a run in progress, **When** `cancel()` is called, **Then** the overlay is removed and the state is CANCELLED.
3. **Given** the whole system, **When** no LLM, network or backend is available, **Then** all three walkthroughs still run.

### Edge cases

- Target appears after the step starts (a panel opens): the step proceeds if it appears within its bounded wait.
- Page route changes mid-step: a `routeChanged` event that does not match the step is ignored; a step that expects a route verifies it.
- A second `start` while a run is active is refused (`busy`); the active run is not disturbed.
- Duplicate event delivery: an event consumed by the current step cannot be re-used for the next one.
- A postcondition that throws or never resolves fails the verification after its timeout.
- Retry loops end: each step has `maxAttempts` (default 3), then FAILED `max_attempts`.

## Requirements

### Functional requirements

Tier tags follow the Constitution. All FRs are REQUIRED unless tagged.

- **FR-001** Semantic IDs are registered in a trusted registry (`id`, `route`, `role`, `label`, `description`, `operations`, `privacy`). Duplicates, malformed IDs, unknown routes, empty operations and over-long or markup-bearing text fail registration. (Tier A, VII)
- **FR-002** No API accepts a CSS selector, XPath, URL, script, or free-form command from walkthrough data, events, or any future model input. Elements are found by exact string comparison of the `data-ai-id` attribute value against the registry. (Tier A, VII)
- **FR-003** `data-ai-ignore` (element or ancestor), `type=password`, `type=hidden` make an element untargetable and silent. `data-ai-private` omits values, `data-ai-redact` yields a fixed marker. (Tier A, VI)
- **FR-004** The semantic context contains only registry-permitted metadata and availability; the privacy layer is its own module with its own unit tests and is the only way context is produced. (Tier A, VI)
- **FR-005** Walkthroughs are trusted, developer-authored typed data. The catalog validates: unique IDs and step IDs, existing start/next/recover steps, known targets, routes and postcondition names, at least one path to a `complete` step, no step kind outside the three supported ones. Any failure aborts startup.
- **FR-006** Step kinds are only `guide` (highlight + tooltip + a wait of `click`, `input` or `ack`), `navigate` (allowlisted internal route) and `complete`. No other operation exists. (Tier A, VII)
- **FR-007** The engine is an explicit state machine with states IDLE, RESOLVING, PRESENTING, WAITING, VERIFYING, COMPLETED, FAILED, CANCELLED, a pure transition function, and a thin effect runner. Transitions not defined are refused.
- **FR-008** Only typed semantic events count: `click(id)`, `input(id, nonEmpty)`, `routeChanged(route)`, `targetAvailable(id)`, `targetGone(id)`. Unknown, malformed or free-form events are dropped. By default only trusted browser events are accepted.
- **FR-009** Postconditions are named, trusted application functions returning exactly `true` to succeed (sync or async with a timeout). A thrown error, timeout, or any other value is a failure.
- **FR-010** Recovery is one pattern: success goes to `next`, a failed postcondition or missing target goes to `recover` if present, otherwise FAILED with a reason; attempts are bounded.
- **FR-011** The runtime performs no backend or application state change. State-changing application actions remain user-initiated app behaviour; any future runtime-initiated mutation MUST go through the Feature 001 Gateway. (Tier A, III/VIII)
- **FR-012** The runtime has no dependency on any other `@dap/*` package and knows nothing of prompts, models, embeddings or RAG. (Tier A, I/XV)
- **FR-013** Public API: `catalog.list()` (id, title, description), `startWalkthrough(id)`, `cancel()`, `getState()`, `subscribe(fn)`, `context()`. Unknown IDs and busy runs return typed refusals and never throw across the API.
- **FR-014** A reference web app (Dashboard, Profile, Settings) exists, runs with one command, and hosts the three walkthroughs and a help launcher.
- **FR-015** CI builds the web app and runs the walkthrough tests; Feature 001 CI steps and the M1 gate are unchanged and green.
- **FR-016** (OPTIONAL) Per-element permission gating; progress persistence; developer preview of the semantic context.

### Key entities

`SemanticElementDef`, `SemanticRegistry`, `SemanticEvent`, `SemanticContext`, `WalkthroughDef`, `Step` (`guide | navigate | complete`), `WalkthroughCatalog`, `EngineState`, `EngineInput`, `Effect`, `Postconditions`, `Ports` (`targets`, `presenter`, `router`, `timers`).

## Security items and tiers (Constitution: every security item names its tier)

| Item | Tier | In this feature |
|---|---|---|
| I, II, XV: LLM is untrusted; controls survive its compromise | A | Runtime has no LLM and no model input; walkthroughs are trusted data; Feature 003 may only select an existing ID |
| VI: DOM data removed client-side | A | Privacy module + DOM guards (FR-003/004); no raw DOM, `innerHTML` or screenshots anywhere |
| VII: no arbitrary execution / selectors | A | FR-002, FR-006; static scan forbids `eval`, `new Function`, `innerHTML`, `insertAdjacentHTML`, `document.write` in new code |
| III, VIII, X, XIV: Gateway for AI actions | A | Not exercised: runtime performs no state change (FR-011); integration point defined for Feature 003 (its `startWalkthrough` capability starts at risk LOW; a walkthrough never inherits authority for application mutations) |
| IX: backend authorization authoritative | A | Runtime grants nothing; a target the app does not render is simply unavailable |
| XII: RAG untrusted | A | Not applicable (no RAG) |
| XVI, XVII: least privilege, focused tests | A | Registry bounds, leaf package, focused tests per control |
| XI, XIII, replay/shared-state | B | Triggers absent (no tenant-owned data stored, no confirmation-required operation, no multi-replica state) |
| Distributed/enterprise hardening | C | Not pulled in |
| XVIII, XIX | A (process) | This scope declaration and `tasks.md` tags |

## Success criteria

- **SC-001** A person runs one command and sees walkthrough A highlight a real element, wait for their interaction, verify the result, advance, and complete.
- **SC-002** Three walkthroughs complete end to end; at least two distinct recovery paths (failed postcondition, missing target) are demonstrated.
- **SC-003** Wrong, unknown and synthetic events advance nothing (tests).
- **SC-004** The semantic context for a page with password/private/redacted/ignored content contains none of that content (tests).
- **SC-005** Registration and catalog validation fail startup on every invalid-definition case listed in FR-001/FR-005 (tests).
- **SC-006** `npm test`, lint, typecheck, dependency-cruiser, the M1 gate and the new walkthrough tests pass in CI.
- **SC-007** The REQUIRED task list fits in roughly the first half of the remaining build (see `plan.md`).

## Known limits carried from Feature 001 (not solved here)

`ALLOWED` is policy permission, not proof of a side effect; no exactly-once execution; the audit COMMIT-acknowledgement window remains; the execution cap is scoped to tenant/session/turn and a fresh host turn can reset it; development authentication is session-bound and not rechecked on every submit; database administrators are trusted; validating a database URL does not prove credentials; some non-critical audit events are best-effort during outages. Feature 002 does not claim to fix any of these and does not call the Gateway.

## Assumptions

- Feature 003's transport from backend to browser is its own work; Feature 002 exposes only the in-browser API.
- jsdom provides sufficient fidelity for the integration proof; layout-dependent visuals (ring position) are verified by one REQUIRED manual real-browser smoke check at closure; an automated real-browser test (Playwright) is OPTIONAL.
- The reference app is a demo surface, not a product; no persistence beyond in-memory state.
