# Feature Specification: Walkthrough Authoring and Usage Analytics (004)

**Feature**: `004-authoring-analytics` | **Status**: planning only, 2026-11-18 | **Baseline**: `dev` at `ac6047f` (Features 001-003 and C01 merged, CI green). `main` is ignored.
**Nature**: a compressed diploma feature, deliberately smaller than Feature 003. It is **not** an administration platform.
**Companion documents**: [plan.md](./plan.md), [tasks.md](./tasks.md). Builds on, and changes the behaviour of none of: Feature 001 (Policy Gateway), Feature 002 (walkthrough runtime + UI), Feature 003 (AI guidance + C01).

## 1. Purpose

Prove two last product capabilities:

1. a **trusted maintainer** can manage walkthrough definitions: view, create, edit, validate, preview and publish simple guides built only from registered semantic targets;
2. the system can show **simple, real usage information**: started, completed, cancelled, completion rate, per guide.

The Maintainer manages trusted walkthrough **content**. The Maintainer does **not** remotely control a user's running walkthrough, see a user's screen or act as the user.

## 2. Actors

| Actor | Can do |
|---|---|
| **Maintainer** (a session holding `perm.walkthrough.maintain`) | See all walkthroughs including drafts; create/edit drafts; preview; publish/unpublish; read analytics. |
| **User** (any other valid session) | See and start **published** guides in the existing Guides launcher and in AI Help; their runs are counted. |
| **AI (Feature 003)** | Unchanged. Recommends only known guides by id; never authors, edits, publishes or sees definitions. |

Demo identity is the existing development authentication (a table of server-held sessions). It is not production authentication.

## 3. User stories and acceptance scenarios

### US1 - View the walkthroughs (REQUIRED)
As a Maintainer I see every guide with title, short description, step count and status, and can search them.
- **Given** the three built-in guides and two authored guides, **when** I open Walkthroughs, **then** I see five rows; built-in rows are marked read-only and published; authored rows show draft or published.
- **Given** a search term, **then** rows are filtered by title or description (client-side, plain text match).

### US2 - Create and edit a draft guide (REQUIRED) - demo scenario A
- **Given** I choose New, **when** I enter a title and description and add two to three steps, each choosing a **registered target** from a list, an allowed interaction (click / type / just read) and instruction text, **then** Save Draft stores a draft that passes validation.
- **Given** a saved draft, **when** I reopen it, **then** I can change text, targets, order, add or remove steps and save again.
- A published guide is not edited in place: Unpublish returns it to draft first.

### US3 - Invalid guides cannot reach users (REQUIRED) - demo scenario B
- **Given** a step with no target, a target that is not registered, an interaction the target does not allow, or a broken step chain, **then** the editor shows a named problem before saving, the host refuses the save, and nothing invalid is stored or published.
- **Given** a stored guide that later stops validating (for example the app's registry changed), **then** Publish re-validates and refuses, and the browser's catalog refuses to load it.

### US4 - Preview then publish (REQUIRED) - demo scenario C
- **Given** a valid draft, **when** I choose Preview, **then** the real Feature 002 runtime and overlay run that draft on the real demo pages; the draft is not published, is not in the Guides launcher and is not counted in analytics.
- **When** I choose Publish, **then** the guide becomes available in the Guides launcher (after the app reloads its catalog) and starts like any built-in guide.

### US5 - See usage (REQUIRED) - demo scenario D
- **Given** several runs, **when** I open Analytics, **then** I see Started, Completed, Cancelled and Completion Rate, and a table: Guide, Starts, Completed, Cancelled, Completion %.
- Numbers come from stored events of real runs. Preview runs are excluded. No field values or free text are stored.

### US6 - A User cannot maintain (REQUIRED)
- **Given** a session without `perm.walkthrough.maintain`, **when** it calls any maintainer route directly (not through the UI), **then** the host refuses with a safe message and nothing is read or changed.

## 4. Functional requirements

| ID | Requirement | Tier |
|---|---|---|
| FR-401 | Walkthrough list (S05): title, description, step count, status, search, Edit, Preview, New, Publish/Unpublish. Built-in guides are listed read-only. | REQUIRED |
| FR-402 | Editor (S06): title, description, 1-8 guide steps plus a completion message; add, remove, reorder (buttons); per step: target (select from the trusted registry), interaction (only those the target allows), instruction text, optional verification (select from the trusted postcondition names). | REQUIRED |
| FR-403 | The editor produces a standard Feature 002 `WalkthroughDef` (kinds `navigate`, `guide`, `complete` only). No new definition language, no branching. | REQUIRED |
| FR-404 | **One validator**: the Feature 002 catalog validator (`createWalkthroughCatalog`) is the rule set for the editor, the host save, Publish and the browser catalog. Authoring bounds are tighter than the runtime's, never looser. | REQUIRED |
| FR-405 | Statuses `draft` and `published`. Save Draft stores only a valid definition. Publish and Unpublish are explicit actions. | REQUIRED |
| FR-406 | Preview runs a validated draft on the real Feature 002 runtime and overlay, separated from published sessions (no events, no launcher entry, no status change). | REQUIRED |
| FR-407 | Published authored guides load into the app's catalog at startup and appear in the existing Guides launcher. Drafts never do. | REQUIRED |
| FR-408 | Authorization on the host for every maintainer route. Writes go through two Feature 001 capabilities (permission, risk class, audit). Reads check the session's configured permission. Hidden buttons are not a control. | REQUIRED |
| FR-409 | Usage events `started`, `completed`, `cancelled` for non-preview runs, with a per-run id, the guide id and a time. Nothing else. | REQUIRED |
| FR-410 | Analytics (S07): four metrics, per-guide table, empty and error states. Completion rate = completed / started, whole percent, "-" when nothing started. | REQUIRED |
| FR-411 | Admin screens are hash routes `walkthroughs`, `editor`, `analytics` of the existing router; they are not semantic-registry routes, so no guide can target them. | REQUIRED |
| FR-412 | Small header control "Demo role: User / Maintainer" (development only, clearly labelled) so one browser can show both roles. | REQUIRED |
| FR-421 | Safe audit tab: time, safe actor id, guide id, action, policy decision, execution outcome (kept separate). | OPTIONAL |
| FR-422 | Duplicate a built-in guide as a draft. | OPTIONAL |
| FR-423 | Per-step "if this fails" hint using the existing bounded recovery (at most 2 attempts). | OPTIONAL |
| FR-424 | Publishing refreshes Feature 003's guide summaries so Help can recommend authored guides (safe `{id,title,description}` only). | OPTIONAL |

## 5. Security and negative requirements

- **NR-401** No selector, XPath, JavaScript, shell, SQL, URL or expression is accepted anywhere. Targets, routes and checks are chosen from trusted lists; every text field is plain text (Feature 002's rule: 1-240 characters, none of `< > & " ' \``) rendered with `textContent`.
- **NR-402** A hand-typed or unknown semantic id, route or postcondition name fails validation in the browser, in the host route and in the executor (three independent calls of the same validator).
- **NR-403** No invalid definition reaches the runtime: the host stores and serves only valid definitions; the browser re-validates every served definition individually and drops any that fail.
- **NR-404** No model involvement. AI cannot author, edit, publish, list drafts or read analytics. Feature 003 receives no definition (only safe summaries, and only if FR-424 is promoted). Feature C01 still carries only guide ids.
- **NR-405** The authoring write capabilities are real Feature 001 capabilities: permission-gated, risk-classified, replay/rate-limited, audited (the id only, never the definition), executed by a trusted executor that takes tenant and actor from the trusted context, never from the request.
- **NR-406** Analytics stores no field value, step text, user identifier or free text. Events name a guide id the host knows (built-in or published), an event kind from a closed list and a run id.
- **NR-407** The audit view (if built) never shows prompts, secrets, tokens, form values or stack traces, and never presents "policy allowed" as "execution succeeded".
- **NR-408** Features 001, 002 and 003 keep their behaviour. Allowed changes are additive only (a new export subpath, one extra exported helper, new routes, new capabilities, new tables).
- **NR-409** Events are client-reported usage telemetry, not an audit record; the spec and UI say so. Audit remains Feature 001's.

## 6. Success criteria

- **SC-401** All four demo scenarios (A create, B invalid, C preview + publish, D analytics) pass once in a real browser and are recorded in the quickstart.
- **SC-402** Every definition that reaches the runtime catalog has passed `createWalkthroughCatalog` (proved by test at the host and at browser boot).
- **SC-403** A maintainer-only route called by a non-maintainer session changes and reveals nothing (transport, Gateway and PostgreSQL tests).
- **SC-404** Start, complete and cancel each add exactly one to the matching count; replaying an event adds nothing; completion rate is deterministic and never above 100 %.
- **SC-405** The end-to-end proof (author -> validate -> save -> publish -> launch -> real runtime -> event -> analytics) passes in the CI proof step without browser automation infrastructure.
- **SC-406** All existing gates stay green (`lint`, `typecheck`, `check:deps`, `test:arch`, `test:security`, `test:conformance`, `test:integration`, `npm test`, `test:guidance`, `test:walkthrough`, `test:walkthrough:proof`, `build:web`, `test:m1-gate`) plus the new `test:authoring` step.

## 7. Non-goals (explicit)

Multi-tenant authoring workflow, RBAC beyond one permission, approval chains, versioning or rollback, scheduling, audiences, marketplace, drag-and-drop page builder, selector recorder or browser extension, self-healing selectors, conditional or scripting language, arbitrary JavaScript, theme editor, surveys/NPS, feature flags, billing, real-time analytics, streaming pipeline, Kafka, Elasticsearch, observability platform, AI-authored walkthroughs, Records screen (S02), full Guide Library (S04), Mongolian locale, new infrastructure of any kind (no Redis, document database, new service, event sourcing or CMS).

## 8. Tiers

| Tier | Contents |
|---|---|
| **REQUIRED** (16 tasks) | FR-401..FR-412, NR-401..NR-409, SC-401..SC-406 |
| **OPTIONAL** (8 tasks, promoted only if a demo needs one) | FR-421..FR-424 and four small polish items listed in tasks.md |
| **FUTURE** (8 tasks, not built) | Production identity/RBAC, versioning and approvals, publish as HIGH with the confirmation service, AI-assisted authoring, hardened telemetry, tenant-owned registries, recorder/extension/self-healing, real-time analytics |

## 9. Definition of done (REQUIRED)

1. A Maintainer can view walkthroughs. 2. A Maintainer can create a draft. 3. Step targets come only from trusted semantic ids. 4. Unsupported executable input is impossible. 5. Invalid definitions cannot publish. 6. Valid definitions can be saved. 7. Preview uses the existing runtime. 8. A published guide can be launched. 9. A User cannot perform Maintainer writes (or reads). 10. Starts, completions and cancels are counted. 11. Analytics shows real summary metrics. 12. Analytics holds no private values. 13. Feature 001 is intact. 14. Feature 002 engine is intact. 15. Feature 003 guidance is intact. 16. The end-to-end proof passes. 17. Existing gates stay green.

## 10. Decisions taken by default (owner may override before implementation)

1. **Demo roles**: a development-only role switch chooses between two server-held demo sessions; the browser still never holds a token or an identity. A real host puts real authentication in front of the same routes.
2. **Publish is a MEDIUM capability with a written justification** (reversible, validated, maintainer-only), because HIGH needs the confirmation service Feature 001 has not built. Promote to HIGH when it exists (FUTURE).
3. **Preview is the real app remounted with the draft in its catalog** (hidden from the launcher, no events), not a second renderer. After Publish the app remounts with the new catalog.
4. **The editor is two-pane** (step list and inspector). The "controlled demo preview" centre pane is OPTIONAL; Preview runs on the real pages instead.
5. **Save Draft requires a valid definition.** Half-finished work stays in the editor; drafts in the database are always valid.
6. **The audit tab is OPTIONAL.**
