# Feature 002 - UI P0 plan (from the DAP UI/UX brief)

**Status**: planning only, 2026-11-17. No code. **Baseline**: `dev` c9dc71a. **Source**: the user-supplied `DAP_UIUX_AGENT_SPEC.md` (not committed here; its third-party references are inspiration only, no asset or font from it is shipped). The brief says the repository wins where they differ; section 4 lists every difference and how it is resolved. This file unblocks the human-designed-UI tasks of [tasks.md](./tasks.md) (T211, T213, T216-T223). The engine boundary of [plan.md](./plan.md) does not change: the core stays non-visual.

## 1. Scope

**P0 (this plan)**: S01 Demo Home, S03 an editable form with a verifiable save, C02 the walkthrough overlay, C03 the result dialog, a Guides launcher (the brief's "direct CTA" for the first slice), brand tokens, an accessibility/responsive baseline, jsdom end-to-end proof, closure.
**Deferred**: S02 Records and a full S04 Guides page (OPTIONAL), a Mongolian locale (OPTIONAL), screenshots (OPTIONAL), C01 the AI help widget (needs a browser transport for `askAndStart`, which Feature 003 does not have: its own slice, FUTURE here), S05-S07 admin and analytics (Feature 004, FUTURE).

## 2. What exists and what is missing (verified on `dev`)

| Exists | Missing |
|---|---|
| `apps/reference-web`: hash router over `dashboard`, `profile`, `settings`; 9 registered semantic elements; three tiny pages; plain CSS in `index.html` | the runtime is not wired to the page; no DOM bridge; no launcher; no walkthrough definitions |
| `@dap/walkthrough/dom` overlay: amber ring, tooltip, "Got it"/"Cancel", fixed placement, reposition on scroll/resize, `textContent` only | brand tokens; backdrop; step title; "Step n of N"; waiting hint; Esc; flip/shift; reduced motion; result dialog |
| core runtime with `PresenterPort`, `RouterPort`, `TargetPort`, `TimerPort`, postconditions, recovery | profile save behaviour, Advanced toggle, postconditions from structured state |
| privacy fixtures in the Profile page (private email, redacted phone, unregistered password, ignored billing notes) | - (kept, see D8) |

## 3. Decisions

- **D1 Routes and ids stay.** Hash routes `dashboard|profile|settings` and the registered ids are unchanged; the brief's `/demo/...` URLs are illustrative. The temporary Feature 003 summaries, the knowledge articles and the walkthrough ids depend on them. Mapping: **S01 = Dashboard** (Demo Home); **S03 = the Profile page** (name field, Save, verifiable `profile.saved`); the **Settings page** hosts walkthroughs B and C (Security panel, Advanced toggle).
- **D2 No engine change.** The engine sends a presenter only `{stepId, target, text, expects}`. Title and "Step n of N" are derived app-side from the definition by one pure function (guide steps in declaration order; a recovery step is labelled as a retry, not counted past N). The overlay gains an additive content object and CSS-variable theming inside `@dap/walkthrough/dom`; `machine.ts`, `runtime.ts`, ports and events are untouched.
- **D3 Tokens and type.** The brief's `--dap-*` tokens (`#F1F2F4` background, `#812F74` accent, `#000000` ink, white surfaces, `#D6D8DC` borders, danger only for real errors). Display = `Georgia`, UI = system sans. **No font files are bundled** (the brief's named faces are licensed and unverified). Serif only for page titles; forms, tooltip and dialog use sans. Black text is never placed on the purple.
- **D4 C02 as shipped in P0.** Dim backdrop with a spotlight around the target (the target stays clickable; the backdrop never blocks it); accent ring; tooltip card with step title, at most three lines, "Step n of N", a waiting hint by `expects` (click / type / acknowledge); Cancel always visible; "Got it" only on `ack` steps; flips above/below and shifts to stay inside the viewport; **Esc cancels**; the card is a non-modal region (`aria-modal` false), does not steal focus from the target, and focus returns when it clears; `prefers-reduced-motion` respected; all text through `textContent`. An arrow is OPTIONAL polish.
- **D5 C03 result dialog.** States and the engine mapping: `COMPLETED` -> completed; `CANCELLED` -> cancelled; `FAILED` with `verification_failed` or `max_attempts` -> blocked (offers "Try again" = restart the same walkthrough); `FAILED` with `target_unavailable`, `navigation_refused`, `present_failed` or `internal_error` -> temporarily unavailable. Actions: Done, Try again (only where safe), Back to guides, Close. "Completed" appears only for `COMPLETED`. Text is a safe recovery sentence, never an internal reason code or a gateway detail.
- **D6 Guides launcher.** A header "Guides" button opens a popover (a full-width sheet on mobile) that lists `catalog.list()` (title, description, Start), shows the running guide and Cancel, and is the future home of C01. The narrow public API object of T220 (`startWalkthrough`, `catalog`, `context`, `cancel`, `getState`, `subscribe`) is unchanged. The S01 primary call to action opens it.
- **D7 S03 states.** Pristine, invalid (inline error tied to the field), saved (success message announced politely). Saving is synchronous in this demo, so there is no "saving" state and none is faked. The guide advances only on the `profile.saved` postcondition (structured store state), never on the click alone.
- **D8 Privacy fixtures stay.** The private email, redacted phone, the unregistered password field and the ignored billing panel remain, styled as ordinary profile content: they are the real-DOM proof of the privacy contract (T221). The Slice 1 scaffolding buttons ("Show me", "Ask for a missing element") leave the UI; their intent is covered by the launcher and the runtime's `target_unavailable` path.
- **D9 Copy.** Every UI string comes from one keyed dictionary (`copy.ts`, English). That makes a later locale a data change. The Mongolian locale of the brief is OPTIONAL (T242) and needs human-reviewed copy; the knowledge base and the AI guard are English, so the UI is not mixed-language.
- **D10 Verification.** jsdom end-to-end (T221) plus one manual real-browser smoke at closure (T223); no new dependency, no Playwright (T224 stays OPTIONAL). Screenshots of the P0 states at 1440 and 390 px are OPTIONAL (T243).
- **D11 Responsive and accessible.** Desktop 1200 and up, tablet 768-1199, mobile under 768 (stacked; the tooltip is contained; the Guides panel becomes a sheet). 44 px touch targets, visible focus ring in the accent, labels and landmarks, no colour-only status (icon or text accompanies colour).
- **D12 Link to Feature 003.** Once T217-T219 exist, a parity test (T240) compares the host's temporary summaries (`walkthrough-summaries.ts`) with `catalog.list()` of the real definitions and fails on any drift. The host list stays the single AI-side source.

## 4. Differences between the brief and the repo (and the resolution)

| Brief | Repo reality | Resolution |
|---|---|---|
| Path routes `/demo`, `/demo/items`, `/demo/settings` | hash router, three routes, ids already in Feature 003 data | D1 |
| "Leave password out of the form" | the password fixture proves the privacy contract | D8 |
| Illustrative ids `settings.name/save/success` | registered ids exist | keep existing ids |
| Mongolian copy first | the knowledge base and guard are English | D9 |
| Step title and "2 of 5" in the overlay | the engine does not send them | D2 |
| "Back" button | the walkthrough contract has no backtracking | no Back (the brief allows this) |
| Figma or code wireframes first | small app; code is the faster honest artifact | code-based directly; tradeoff accepted |
| S02, S04, S05-S07, C01 | not P0 | deferred (section 1) |
| Floating C01 launcher | no browser transport for `askAndStart` | FUTURE T244 |

## 5. Batches (tasks in tasks.md)

- **U1 Foundation**: T238 tokens, shell, copy dictionary and Demo Home; T216 profile and settings behaviour with postconditions; T213 hash-router wiring (RouterPort and route events); T211 DOM bridge (delegated click/change, `closest("[data-ai-id]")`, `trustedEventsOnly`, no values).
- **U2 Guided experience**: T226 (promoted) C02 presentation; T239 C03 dialog; T217-T219 the three walkthroughs; T220 launcher and runtime wiring; T227 (promoted) accessibility baseline. **Combined QA, then a human visual checkpoint** (run `npm run dev:web`, or screenshots if T243 is promoted).
- **U3 Proof and closure**: T221 jsdom end-to-end (A, B, C, cancel, failed-save recovery, missing target, wrong click, synthetic event, privacy of `context()`); T240 parity test; T222 CI; T223 docs and the manual real-browser smoke; **final QA**.

## 6. Brief acceptance checklist -> proof

| Brief item | Proof |
|---|---|
| three brand colours are tokens | T238 token test (exact hex values) and visual check |
| P0 flows are real interactions | T221 |
| tooltip points at a registered target and stays inside the viewport | T226 unit tests (flip/shift) and T223 smoke |
| advances only on event plus valid postcondition | T216, T221 |
| unknown, stale or private targets fail closed with a safe message | T221, T239 |
| cancel cleans up highlight, focus and session | T226, T221 |
| the assistant cannot execute actions directly | unchanged (Feature 003 boundary tests) |
| keyboard, focus indicators, responsive | T227 tests and T223 smoke |
| unavailable integrations labelled, no fake success | the launcher and dialog show only real engine states |
| one E2E covers the walkthrough and its cancel path | T221 |

## 7. Out of scope

Everything the brief lists as not MVP, plus: C01 and its transport, admin and analytics screens, Records and a full Guides page, any locale beyond the dictionary seam, Playwright, new fonts or third-party assets, any change to the walkthrough engine, Feature 001, or the Feature 003 contracts.

## 8. Decisions needed from the owner (defaults apply if not answered)

1. **Locale for the diploma demo** (default: English with the dictionary seam; Mongolian is OPTIONAL T242).
2. **Visual checkpoint** (default: you run `npm run dev:web` after U2; say so if you want agent-captured screenshots, T243, instead).
3. **C01 AI widget** (default: its own later slice with a host endpoint, not part of P0).

## U1 decisions

- Profile saving is genuinely asynchronous through an injected service (default 250 ms), with saving/failure states and a bounded async postcondition; this supersedes D7's synchronous-save assumption.
- The developer demo controls remain, clearly labelled for removal in U2; the existing overlay is untouched (D8 removal deferred).
- Dashboard has Profile/Settings navigation and an informational guides note, with no fake Guides action until U2.
- Security stays visible; Advanced reveals only the inert two-factor control, following the current registry and articles.

- U1 correction: capture-phase bridge checks stay synchronous, but typed event delivery uses a cancellable FIFO macrotask after application handlers/default actions, because the runtime verifies postconditions synchronously.
- Profile verification no longer uses a microtask barrier; it waits only for an actual in-flight save. Test-only injected definitions prove toggle, route and save ordering through the real runtime; no definitions ship.

## U2 decisions

- Trusted availability changes come from targets.observe plus route-render refresh, without changing the engine or bridge timing.
- Tooltip title is the registry label; primary-path guide steps alone count toward progress, recover-only steps say Extra step (a prerequisite is not necessarily a retry).
- A non-blocking scrim is the target ring's spread shadow; targetless route cards have a pointer-transparent dim layer.
- Guides are a Dashboard catalog card and a header link, not a popover; no generic Next exists.
- Profile allows three failed Save attempts by bounding fixName to two recovery entries; only the engine declares completion/failure.
- Result dialogs use native dialog when available, a semantic fallback in jsdom, and expose no request-denied state.
- U1+U2 QA fixes: the bridge drops accepted-but-undelivered events when a run ends or begins (`clearPending`, called by `mountApp`); busy Save and name field use `aria-disabled`/`readOnly`, never `disabled`, so keyboard focus survives a save; live-region text (card, profile status) is written only when it changes. D5's "Back to guides" action was not built (see T239).

## U3 decisions

- The jsdom end-to-end (T221, `apps/reference-web/src/e2e.test.ts`) mounts the real app with `trustedEventsOnly: false`, because jsdom cannot create trusted clicks or typing; it never calls `runtime.dispatch`, `store.set` or `profile.*` and never moves fake timers on its own except to let the real 250 ms save and the 400 ms target wait elapse. One test keeps the production default and shows scripted events are ignored. The trusted path is covered by the manual browser smoke (`quickstart.md` section 8).
- Feature 003 summaries stay one static, frozen host list; `packages/ai` and the host may not import `@dap/walkthrough`, so a root test (T240) is the single guard that the list equals the real `catalog.list()`. No third list was added and no production code changed.
- CI gained three steps before the M1 gate (`test:walkthrough`, `test:walkthrough:proof` with explicit file paths, `build:web`); the Feature 001 steps and the M1 gate are untouched.
- Found while proving recovery: Advanced opened and closed again before verification correctly fails the guide ("blocked"), it does not pretend success. Kept as a test.
- Manual smoke (2026-11-18, Chromium 157 headless over CDP, 1440 and 390 px): all three guides, cancel, Esc and keyboard passed. Not tested: screen readers, real phones, other browsers.
- QA U1+U2 review (2026-11-18) found two real defects, fixed in U3 on the owner's instruction, each with a failing test first: on phones the tooltip could cover the highlighted field (placement now caps the card height and scrolls the control into the free band; `scrollBy`/`maxHeight` on `placeCard`), and the header **Guides** link did not reach the catalog (it now scrolls to and focuses the Guides card; `launcher.reveal()`). T218 wording corrected to the shipped navigate step. The final QA pass found a third defect in the first fix (on short landscape phones the capped card reset its own scroll on every re-place, so Cancel/Got it were unreachable; fixed with two failing-first tests). The D6 popover/sheet stays an accepted deviation.
