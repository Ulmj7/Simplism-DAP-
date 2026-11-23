# Implementation Plan: Walkthrough Authoring and Usage Analytics (004)

**Spec**: [spec.md](./spec.md) | **Tasks**: [tasks.md](./tasks.md) | **Baseline**: `dev` `ac6047f`, 2026-11-18. Planning only: no production code.
Everything below was checked against the code on `dev`; file references are real. Where this plan differs from older Feature 004 ideas, the repository won.

## 1. What exists, and the constraints it puts on this feature

| Fact (verified) | Consequence |
|---|---|
| `createWalkthroughCatalog(registry, postconditionNames, definitions)` in `packages/walkthrough/src/walkthrough/catalog.ts` **is** the definition validator: strict keys, plain text (1-240), known targets with the right operations, known routes and postconditions, `next`/`recover` rules, reachability, no path without a `complete` step. It returns a **frozen** catalog and throws one `WalkthroughCatalogError` with every issue for a whole batch (max 100 definitions). | No second validator. Validate each definition **alone** (`[def]`) so one bad guide cannot take the others down. The catalog cannot grow after creation, so a newly published guide needs a **new catalog** (remount), not a mutation. |
| The language is three step kinds: `guide` (target, text, wait `click|input|ack`, optional `verify`, `next`, optional bounded `recover`), `navigate` (route, optional text), `complete` (text). `packages/walkthrough/src/walkthrough/definition.ts`. | The editor maps onto exactly these; no branching, no new kinds. |
| `reference-web` owns the demo registry (`semantic-ui.ts`: 3 routes, 8 elements, each with `operations` and `privacy`), `POSTCONDITION_NAMES` (4, `postconditions.ts`) and the three built-in definitions (`walkthroughs/`). `mountApp(root, { walkthroughs })` already builds the catalog and runtime from a list. | Authored definitions are just more entries in that list. |
| The hash router has a closed `ROUTES` list (`dashboard|profile|settings`). `registry.routes` is a separate list of the same three. | Admin routes can be added to the router **without** adding them to the registry, so a guide can never target an admin page. |
| `apps/reference-host` may **not** import `@dap/walkthrough` (scan in `tests/architecture/guidance-host-boundary.test.ts`; exact specifier `"@dap/walkthrough"`). The package exports only `.` (engine + core) and `./dom`. | One new, narrow, pure subpath `@dap/walkthrough/authoring` and an updated boundary test (T402). |
| Feature 001 capabilities arrive through `HostExtension { definitions, executors }` (`compose.ts`); `startWalkthrough` (`guidance/capability.ts`) is the model to copy. Registry rules: R5 MEDIUM needs a written justification or confirmation, R4 HIGH needs confirmation (the confirmation service is **not built**, so a HIGH executor can never run), R6 SAFE/LOW cannot change state, R9 a state change needs a `resource` extractor, input schemas must be strict and bounded (`schema-rules.ts`). | Authoring writes are **MEDIUM** with justification and a `walkthrough` resource. |
| `AiSession.submit` returns only `{ outcome, category }` (`gateway/feedback.ts`), never executor data. | Writes are fire-then-read: after `ALLOWED/ok` the transport reads the stored record. Reads cannot go through the Gateway. |
| `createResourceAuthorizer` (`host-ports.ts`) resolves only `note` references. | Additive branch for `walkthrough` references (same tenant, same permission rule). |
| `composeReferenceHost` creates the pool internally; `withTenant` (`packages/security/src/state/postgres/tenant-tx.ts`) is tested but **not exported** from `@dap/security`; `createPostgresPool` is. | Export `withTenant` additively (one line) and give the authoring store its own pool, built by the dev server (as Feature 003's dev server composes its own pieces). |
| PostgreSQL migrations are plain files `NNN_name.sql` owned by `dap_owner`; tenant tables use `FORCE ROW LEVEL SECURITY` with `app.tenant_id` and `GRANT ... TO dap_app` (`010_`, `020_`). Latest is `060_`. Nothing pins the migration list. | Two tiny migrations `070_` and `071_` in the same style. |
| Audit table `sec_audit_events` already records, per Gateway decision, the safe actor (`user_id`), `action_id`, `outcome` (policy decision), and a separate `AI_ACTION_EXECUTED` row with `execution_result`. | Audit data for authoring exists for free; only a read view is missing (OPTIONAL). |
| The runtime has **no persistence**; it exposes `subscribe(snapshot)` with `status` (`IDLE`, active statuses, `COMPLETED`, `CANCELLED`, `FAILED`) and `walkthroughId`. The Gateway audit sees only AI-approved starts, not launcher starts. | The only complete source of "started / completed / cancelled" is the browser's snapshot stream: a small event table fed by it. |
| C01 transport (`apps/reference-host/src/http/transport.ts`) is a Fastify instance with loopback Host guard, `Sec-Fetch-Site` guard, JSON-only, 64 KiB limit, `no-store`, fixed error messages, and a dev server (`dev-server.ts`) holding one demo session. | Authoring routes are registered on that same instance and inherit every guard. |

## 2. Decisions

- **D1 Maintainer role = one permission**, `perm.walkthrough.maintain`, on a server-held dev session. No roles table, no RBAC.
- **D2 Persistence = PostgreSQL, two tables.** One row per guide holding the **validated `WalkthroughDef` as JSON** plus status (`walkthrough_definitions`); one append-only event table (`walkthrough_events`). No step tables: the runtime consumes a whole definition, so one JSON column is the least code and keeps one validated shape.
- **D3 Authored ids are server-generated** `wt-` + 12 hex characters. A maintainer never types an id, cannot collide with or shadow a built-in id, and the executor refuses ids outside that pattern (and the reserved preview id `wt-preview`).
- **D4 Editor model -> definition by one pure function.** The editor holds a linear model; `draftToDefinition` compiles it (section 4); `definitionToDraft` reverses only that generated shape and **refuses** anything else ("this guide uses features the editor cannot edit"). Built-in guides are read-only.
- **D5 One validator, three call sites**: browser editor (instant feedback), host save and publish (authority), executor (defence in depth); plus the browser's per-definition re-validation at boot. All call `createWalkthroughCatalog` with the same registry data.
- **D6 Host registry data is a static copy** (`apps/reference-host/src/authoring/trusted-registry.ts`: 3 routes, 8 elements, 4 postcondition names), guarded by a root parity test against the web app's real `createDemoRegistry()` and `POSTCONDITION_NAMES`. This repeats the accepted Feature 003 pattern (T240).
- **D7 Writes through the Gateway, reads through a host check.** Writes (`saveWalkthroughDraft`, `setWalkthroughStatus`) are Feature 001 capabilities: permission, risk class, rate/replay, durable audit, trusted executor. Reads (list, get, analytics) are host routes that require the session's configured `perm.walkthrough.maintain` (same dev-session table the Gateway's permission checker uses). Published definitions and event ingestion need any valid session.
- **D8 Publish = MEDIUM with justification**: maintainer-only, validated, reversible by Unpublish, shows guidance only. HIGH is impossible until the confirmation service exists (FUTURE).
- **D9 Catalog refresh = remount.** The app is started by an async `boot()`; it fetches the published definitions, validates each, and mounts. Publish, Unpublish and Preview call `remount(...)` with a new list. No engine change, no mutable catalog.
- **D10 Preview = the real app remounted** with the validated draft added to the catalog, hidden from the launcher, usage reporting off, auto-started; when the run's dialog closes the app returns to the editor. Fallback if remount proves clumsy: a second runtime instance over the same ports (decided inside T410, never a fake renderer).
- **D11 Analytics from client-reported events** (honestly labelled), made trustworthy by a per-run id and a join at read time, so completed + cancelled can never exceed started.
- **D12 Dev role switch**: the dev server holds two sessions (user, maintainer) from `DAP_DEMO_SESSION_TOKEN` and `DAP_DEMO_MAINTAINER_TOKEN`; the SPA sends `X-Demo-Role: user|maintainer`; unknown or absent means user. Dev only, labelled, refused in production by the existing dev-auth guard. The security boundary is the host's per-request permission check, not this header (which exists only to demo two roles in one browser).
- **D13 No AI changes.** Feature 003 stays on its static three summaries unless OPTIONAL T424 is promoted.

## 3. Persistence

`db/migrations/070_walkthrough_definitions.sql` (owner `dap_owner`, same guards as `010_`/`020_`):

```sql
CREATE TABLE IF NOT EXISTS public.walkthrough_definitions (
  tenant_id uuid NOT NULL,
  walkthrough_id text NOT NULL CHECK (walkthrough_id ~ '^wt-[a-f0-9]{12}$'),
  status text NOT NULL CHECK (status IN ('draft','published')),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object' AND octet_length(definition::text) <= 32768),
  created_by text NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 256), created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL CHECK (char_length(updated_by) BETWEEN 1 AND 256), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, walkthrough_id));
-- ENABLE + FORCE ROW LEVEL SECURITY; policy tenant_isolation on app.tenant_id (as 010)
-- GRANT SELECT, INSERT, UPDATE TO dap_app; no DELETE, no TRUNCATE
```

`db/migrations/071_walkthrough_events.sql` (append-only like `sec_audit_events`):

```sql
CREATE TABLE IF NOT EXISTS public.walkthrough_events (
  seq bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id uuid NOT NULL,
  walkthrough_id text NOT NULL CHECK (walkthrough_id ~ '^[a-zA-Z][A-Za-z0-9_-]{0,63}$'),
  run_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('started','completed','cancelled')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, run_id, event_type));          -- a replayed event adds nothing
CREATE UNIQUE INDEX ... ON public.walkthrough_events (tenant_id, run_id) WHERE event_type <> 'started';  -- one terminal event per run
-- FORCE RLS tenant_isolation; GRANT SELECT, INSERT TO dap_app; BEFORE UPDATE/DELETE/TRUNCATE trigger refuses (copy of the 020_ pattern)
```

Both tables are tenant-scoped through the existing mechanism, which gives tenant isolation at no extra design cost without building any multi-tenant authoring workflow.

## 4. Authoring model and compile rules

Editor model: `{ title, description, steps: [{ target, wait, text, verify? }], completion }`, 1-8 steps.

`draftToDefinition` (pure, in `reference-web`): for each step, if its target's route differs from the previous step's route (or it is the first), first emit a `navigate` step (no text: the runtime navigates itself, exactly like the built-in guides); then the `guide` step; link `next` in order; finish with one `complete` step carrying `completion`. Generated step ids: `n1..`, `s1..`, `done`. No `recover` is generated (a failed check ends the run as "blocked", which the result dialog already explains); OPTIONAL T423 adds the bounded hint.

Editor constraints (the UI offers only what the validator would accept): targets = registry elements with `highlight`; `wait` offers `click` only if the target allows `click`, `input` only if it allows `input`, `ack` always; `verify` offers the four postcondition names. Text is plain text, 1-240.

## 5. Validator reuse and the package boundary

- New `packages/walkthrough/src/authoring/index.ts`, exported as `@dap/walkthrough/authoring`: re-exports `createSemanticRegistry`, `createWalkthroughCatalog`, `WalkthroughCatalogError`, `isValidId`, the text and step limits and the related types. **No** runtime, DOM, ports or machine. The package stays a leaf; the engine files are untouched.
- `apps/reference-host/package.json` gains the `@dap/walkthrough` workspace dependency (lockfile link change).
- `guidance-host-boundary.test.ts` keeps refusing the root specifier everywhere; a new `authoring-boundary.test.ts` allows `@dap/walkthrough/authoring` only inside `apps/reference-host/src/authoring/**` and proves a planted `@dap/walkthrough` or `@dap/walkthrough/dom` import there is refused. `check:deps` stays free of cycles.
- `apps/reference-host/src/authoring/validate.ts`: `validateDefinition(unknown) -> { ok, definition } | { ok: false, issues }` = the authoring size bounds (zod, tighter than the runtime's: at most 24 steps, bounded strings) followed by `createWalkthroughCatalog(trustedRegistry, names, [definition])`. Issues keep the catalog diagnostic with positional step labels and omit author-supplied field names and ids.
- Browser: the editor and boot call the same `createWalkthroughCatalog` from `@dap/walkthrough` with the web app's own registry.

## 6. Authorization and Feature 001

Two capabilities in one `HostExtension` (`apps/reference-host/src/authoring/capabilities.ts`), modelled on `guidance/capability.ts`:

| Capability | Input (strict, bounded) | Risk | Permission | Executor (trusted; tenant and actor from `call.security`) |
|---|---|---|---|---|
| `saveWalkthroughDraft` | `{ walkthroughId, definition }` | MEDIUM, `changesState`, justification | `perm.walkthrough.maintain` | re-validate; insert, or update only while `status = 'draft'`; refuse ids outside `wt-...` |
| `setWalkthroughStatus` | `{ walkthroughId, status: 'draft'\|'published' }` | MEDIUM, `changesState`, justification | `perm.walkthrough.maintain` | load; on publish re-validate and cap published at 50; set status |

Both declare `resource: { type: 'walkthrough', id }` (R9) and audit only `/walkthroughId` (plain): the definition itself is never audited. `host-ports.ts` gains the additive `walkthrough` branch in `createResourceAuthorizer`. Both ids are enabled only if listed in `DAP_ENABLED_ACTIONS` (default deny). The dev server opens a **fresh session per write** (as C01 does for starts) so per-turn rate limits do not throttle an editing session; if defaults still bite, T405 records the needed `DAP_GATEWAY_CONFIG` value.

Read routes use the principal the transport resolved from host configuration (`permissions` of the matching dev session). Test: a session lacking the permission is refused by **both** the read gate and the Gateway, with the same safe copy.

## 7. Host API (registered on the C01 Fastify instance; every C01 guard applies)

| Route | Who | Behaviour |
|---|---|---|
| `GET /api/walkthroughs/published` | any session | validated published definitions of the tenant (each re-validated; at most 50). Drafts never. |
| `POST /api/walkthrough-events` | any session | `{ walkthroughId, runId, event }` exact keys; `walkthroughId` must be a built-in id or a published id of the tenant; closed event list; idempotent; `204`. |
| `GET /api/admin/walkthroughs` | Maintainer | list: id, title, description, status, step count, updated time, built-in marker. |
| `GET /api/admin/walkthroughs/:id` | Maintainer | `{ id, status, definition }`. |
| `POST /api/admin/walkthroughs` | Maintainer | `{ definition }`: validate (`422` + issues), generate id, Gateway `saveWalkthroughDraft`, read back. |
| `PUT /api/admin/walkthroughs/:id` | Maintainer | same for an existing **draft** (`409` for a published guide). |
| `POST /api/admin/walkthroughs/:id/status` | Maintainer | `{ status }`: pre-validate on publish, Gateway `setWalkthroughStatus`. |
| `GET /api/admin/analytics` | Maintainer | totals and per-guide rows (section 9). |

Responses use closed shapes and fixed messages (the C01 pattern): no stack, SQL, Zod, permission id or Gateway stage ever leaves. `403` for a missing permission, `401` for no session. OPTIONAL: `GET /api/admin/audit`.

## 8. Browser

- **Boot** (`browser.ts` becomes `boot()`): fetch published definitions (short timeout), validate each with `createWalkthroughCatalog(registry, names, [def])`, drop failures, then `mountApp(root, { walkthroughs: [...WALKTHROUGHS, ...valid] })`. Any failure degrades to the three built-in guides. `remount(options)` destroys and mounts again.
- **`mountApp` additions** (options only): `hideFromLauncher`, `autoStart`, `usage` (client or `false`), `admin` client; `createLauncher` filters hidden ids. The engine, bridge, presenter and dialog are not touched.
- **Router**: add `walkthroughs`, `editor`, `analytics` to `ROUTES` (hash `#/walkthroughs` etc.); `registry.routes` stays three. Titles come from `copy.ts`. The editor's current draft lives in a small module-level session so it survives a remount.
- **Nav gating**: after boot, a probe of `GET /api/admin/walkthroughs` decides whether to show the three admin links (200 = Maintainer). This is presentation only; every route is checked on the host.
- **Demo role control**: header "Demo role: User | Maintainer", stored in `sessionStorage`, sent as `X-Demo-Role`. Switching remounts.
- **Usage reporter** (`usage.ts`): subscribes to the runtime; on the edge not-active -> active it creates a `runId` (`crypto.randomUUID`) and posts `started`; on `COMPLETED` / `CANCELLED` posts that event once; `FAILED` and abandoned runs post nothing (they appear only as "not finished"). Fire-and-forget, failures swallowed, disabled in Preview.
- **Admin client** (`admin/client.ts`): eight typed calls, hand-written strict response guards, bounded reply size, abort timeout, fixed failure outcomes (reusing the bounded reader exported from `help/client.ts`).

## 9. Analytics

Events: `started`, `completed`, `cancelled` (the three the spec names). Stored as in section 3. Read model, one query:

```sql
SELECT s.walkthrough_id,
       count(*)                                         AS started,
       count(*) FILTER (WHERE c.event_type='completed') AS completed,
       count(*) FILTER (WHERE c.event_type='cancelled') AS cancelled
FROM walkthrough_events s
LEFT JOIN walkthrough_events c ON c.tenant_id=s.tenant_id AND c.run_id=s.run_id AND c.walkthrough_id=s.walkthrough_id AND c.event_type<>'started'
WHERE s.event_type='started' GROUP BY s.walkthrough_id;
```

A terminal event without a matching start is ignored, so completed + cancelled <= started and the rate is at most 100 %. `completionRate(started, completed)` is one pure function (whole percent, `null` when started is 0). Titles in the table come from the host's built-in summaries and the stored definitions; an unknown id shows as its id. One trend line is OPTIONAL. Honest labelling: "reported by the app in the browser; not an audit record".

## 10. Audit (OPTIONAL T421)

`GET /api/admin/audit`: a fixed-column, tenant-scoped, bounded SELECT over `sec_audit_events` for the two authoring action ids: time, `user_id` (the safe actor id), `action_id`, `/walkthroughId`, policy decision (`outcome`) and, on the `AI_ACTION_EXECUTED` row, `execution_result`, shown in **separate** columns. No params beyond the id, no prompts. The row text for a denied attempt says "refused", never "executed".

## 11. Features 002 and 003

- **Feature 002**: engine, bridge, overlay, presenter, dialog unchanged. One additive subpath export, additive `mountApp`/launcher options, router entries, new pages. A guide authored here is executed by the same runtime as the built-in ones.
- **Feature 003 / C01**: unchanged. C01 still returns ids; its `GuideApi.startWalkthrough` still refuses ids not in the browser catalog. Authored guides are launchable from the launcher; Help recommends them only after OPTIONAL T424 (which refreshes the host's safe `{id,title,description}` summaries and nothing else; the model never receives a definition). The parity test T240 keeps comparing the **built-in** three.
- Definitions served to the browser come from the trusted host store, are re-validated there, and are never produced by the AI path.

## 12. UI design

- **S05 Walkthroughs (`#/walkthroughs`)**: header with search and **New walkthrough**; a table (title, truncated description, steps, status chip, updated) with row actions Edit, Preview, Publish / Unpublish. Built-in rows: "Built-in", read-only, Preview only. Empty, loading and error states; text only, 44 px targets, mobile stacks to cards.
- **S06 Editor (`#/editor`)**: top bar (title, status chip, Save draft, Preview, Publish); left: ordered step list with up/down/remove and Add step (max 8); right: inspector (instruction, target select grouped by page, interaction select limited by the target, optional check select, per-step problem text). Metadata (title, description, completion message) above the list. The centre "demo context" pane is OPTIONAL (T428). Problems are listed by step before Save or Publish; Save and Publish are disabled with the reason shown, not hidden.
- **S07 Analytics (`#/analytics`)**: four metric tiles (Started, Completed, Cancelled, Completion rate) and one table (Guide, Starts, Completed, Cancelled, Completion %). Empty state "No runs yet. Start a guide from Guides." Error state with Try again. Audit tab is OPTIONAL.
- Styling reuses the existing tokens and `ui/pieces.ts`; copy goes in `copy.ts` (English). Admin containers are `data-ai-ignore` like the launcher.

## 13. Test strategy (representative, written with the code)

- **Unit (no DB)**: `validateDefinition` (valid; missing, unknown and not-allowed targets; bad transition; unreachable; unbounded recovery; markup text; oversize); `draftToDefinition` / `definitionToDraft` round trip and refusal of foreign shapes; `completionRate`; usage reporter edges (start, complete, cancel, preview off, FAILED silent, no values); admin client guards and failures.
- **Transport (Fastify `inject`, fake store and fake principals)**: guards inherited (Host, `Sec-Fetch-Site`, JSON-only, size); Maintainer vs User on every admin route; strict bodies; drafts never in `published`; events reject unknown ids, bad runs, extra keys; replay adds nothing; fixed errors.
- **PostgreSQL**: migrations 070 and 071 (RLS, grants, constraints, append-only); store (insert, draft-only update, status, publish cap); capabilities through the **real Gateway** (maintainer allowed with an exact PROPOSED/ALLOWED/EXECUTED trail and executor params; user denied with zero executor runs; invalid definition fails in the executor; policy-allowed and execution-failed kept distinct); analytics SQL (counts, run integrity, tenant isolation).
- **Architecture**: authoring import boundary; existing boundary tests still pass; `check:deps` clean; no new package edge from `packages/ai` or the engine.
- **Parity**: host registry data equals the web registry and postcondition names (drift test with planted drift cases, like T240).
- **Browser (jsdom)**: S05, S06 (add/remove/reorder, selects, problems, disabled Save), Preview through the real runtime and overlay (invalid draft cannot preview; no status change; no events), role switch, nav gating, remount after Publish.
- **End to end (`tests/integration/authoring-end-to-end.test.ts`)**: author -> validate -> save -> publish -> remount -> launch from the launcher -> real runtime completes -> event posted -> analytics shows 1/1/0/100 %; plus invalid blocked, User denied, Cancel counted. Real browser smoke of scenarios A-D recorded in the quickstart (the T223 pattern), no new automation dependency.

## 14. Slices (one branch each from `dev`, `--ff-only`)

1. **Authoring core** (T401-T406): migration, subpath, trusted registry + validator, store, Gateway capabilities, authoring routes, dev-server roles. QA focus: authority and validation (Tier A).
2. **Admin UI** (T407-T411): admin client, router, pages, editor, Preview, Publish and boot. QA focus: the real-runtime preview, remount, accessibility basics.
3. **Analytics and closure** (T412-T416): events table, reporter and ingestion, analytics route and page, end-to-end proof, docs, CI step, smoke.

QA cadence: one review after Slice 1 (the security-relevant part), one final review after Slice 3.

## 14a. Slice 1 implementation notes (2026-11-18)

Only real deviations and decisions; everything else is as planned.
- **`withTenant` is NOT exported from `@dap/security`.** The public API gives the host a pool (`createPostgresPool`) but no tenant-scoped transaction, so `apps/reference-host/src/authoring/tenant-tx.ts` reproduces the same semantics (BEGIN; transaction-local `set_config('app.tenant_id')`; COMMIT whose command is checked; ROLLBACK on error; discard the connection if ROLLBACK fails). It is typed from `createPostgresPool` through `authoring/pool.ts` (the authoring code's only import of `@dap/security`, pinned in `graph.test.ts`), so the host declares no driver dependency. T404's wording "additive export `withTenant`" is therefore superseded; Feature 001 packages are unchanged.
- **071 is deferred to T412.** Slice 1 adds only `070_walkthrough_definitions.sql`; no event table, reporter, events or analytics route.
- **Store contract.** `setStatus(scope, id, status, isValid)` locks the row, runs the validator on the STORED definition inside the transaction, enforces the cap of 50 under a per-tenant advisory lock, then updates. So "re-validate on publish" cannot race a concurrent edit. `saveDraft` is one `INSERT ... ON CONFLICT DO UPDATE ... WHERE status = 'draft'`.
- **One authoring schema** (`authoring/schema.ts`) is both the `validateDefinition` first step and the capability `inputSchema`. It states shape and size only (the step is the union of the three kinds' field names; `kind`, `wait`, `target` are bounded strings), so every rule about targets, waits, routes, postconditions, transitions and reachability comes from the ONE Feature 002 validator, in its own wording. The status enum is `string(max 9) -> enum` because Feature 001 requires `maxLength` on every string.
- **List response shape** `GET /api/admin/walkthroughs` is `{ authored: [{ id, title, description, status, stepCount, updatedAt }], builtIn: [{ id, title, description }] }`; `GET /api/walkthroughs/published` is `{ walkthroughs: [definition, ...] }` (each re-validated, invalid ones left out). Errors are `{ kind, message }` (`unauthenticated` 401, `forbidden` 403, `not_found` 404, `malformed` 400, `conflict` 409, `unavailable` 503) and `{ kind: "invalid", message, issues }` on 422; the transport's own `{ kind: "unsupported", message }` still answers framework-level errors (bad Host, cross-site, 413, 415).
- **Gateway limits recorded.** The default `maxPayloadBytes` (16 KiB) fits the 24-step ASCII fixture in `authoring-gateway.test.ts`. A definition that passes shape and catalog checks can still exceed the route’s 15,000-byte proposal budget, for example with extensive multibyte text. The route returns 422 before calling the Gateway, and the dev server opens a fresh Gateway session per write, so the per-turn limits do not bite; the per-user-per-capability limit (20 per minute) applies to editing and needs no configuration for the demo.
- **Dev role switch** lives only in `authoring/principal.ts` (`X-Demo-Role`, two server-held sessions, unknown = user, maintainer without a configured token = user). Permissions come from the host's session table; the header is a demo convenience, not the authority.
- `http/transport.ts` gained one additive `export` (`exactBody`); `approved-start.ts` and all guidance code are untouched.

## 14b. Slice 2 implementation notes (2026-11-20)

- Preview remounts the reference app over the same runtime and overlay with a temporary `wt-preview` entry hidden from Guides. The result dialog has one optional dismissal callback. Closing an editor preview returns to the editor and restores its draft from memory. A list preview returns to the list. Preview has isolated profile and settings state. The normal app restores its own state on return. Help is hidden and inactive on admin pages and during Preview.
- The demo role control and header are enabled by Vite in development. The host still determines access. A successful status write refreshes the catalog even if the maintainer has left that page. If a guide is running, the app replaces the catalog after the result dialog closes.
- The client uses the six authoring and catalog routes shipped in Slice 1. Create removes the definition's top-level ID and adopts the host's ID after success. Step IDs remain because the runtime links steps with them. Read denials have their own state. Writes show fixed copy, with specific messages for oversized definitions and the published-edit conflict.
- Slice 2 used the host's authored count of all stored steps. Slice 3 corrects the list to show guide steps for authored and built-in rows. Analytics registers a placeholder route in this slice.

## 14c. Slice 3 implementation notes (2026-11-20)

- The existing list query now counts only steps with `kind = 'guide'`. This aligns the Slice 1 host summary with the editor and built-in count. The route shape stays the same.
- The event table omits the proposed sequence column. Its keys and timestamp suffice for the run-based report. Authored event admission checks published status under a row lock in the same transaction as the append. Duplicates, second terminals and terminals without a matching start are acknowledged without adding rows. The browser finishes sending a start before sending its terminal. The aggregate still ignores any orphan rows from direct inserts.
- Usage sends three fields over the same-origin proxy and uses the host's default session during the demo. Configure both demo roles in the same tenant. The end-to-end proof uses the real Gateway and PostgreSQL through Fastify injection.

## 14d. Final QA notes (2026-11-20)

- No code defect was found. Two documentation points were corrected: the smoke browser is Chrome 157 (Chromium engine), not a bare Chromium build, and the completion lines were added only after the gates passed.
- Known limitations kept on purpose: the demo role header is a development convenience (the host's own session table is the authority); events are client-reported, unauthenticated beyond a valid session and unthrottled (FUTURE T435), so anyone holding a session can add or lose runs; a terminal event for a guide that was unpublished after its start is refused; the browser needs `crypto.randomUUID` (a secure context such as `127.0.0.1`) or it reports nothing; both demo roles must share a tenant.

## 15. Largest scope-creep risks

1. **Editor gold-plating**: drag and drop, centre preview pane, branching, recovery UI, rich text. Held off by the REQUIRED/OPTIONAL split and the three-step-kind rule.
2. **Preview/remount cost**: the frozen catalog forces a remount; keep it as one `boot/remount` function and decide the fallback inside T410 only.
3. **Auth creep**: real login, user management, roles table. D1/D12 hold the line: one permission, server-held sessions.
4. **Versioning creep**: draft copies, history, rollback. One row per guide; Unpublish to edit.
5. **Pulling in AI**: T424 is the only door and is OPTIONAL.
6. **Analytics growth**: charts, date ranges, step drop-off, per-user data. Three events and one table.
7. **Touching Feature 001/002 packages**: only two additive exports (`@dap/walkthrough/authoring`, `withTenant`). Any other change is a stop-and-ask.
8. **Registry duplication drift**: covered by the parity test.
9. **Default Gateway rate limits** throttling editing: fresh session per write; record config if needed.
10. **Lockfile/workspace change** for the host dependency: small but visible; do it in T402 and run `npm ci` in CI.

## 16. Why this can be done quickly

The validator, the runtime, the overlay, the launcher, the privacy-safe registry, the result dialog, the Gateway, the capability and extension seam, the dev authentication, the tenant tables and the transport guards all exist. New code is two small migrations, one pure compile function, two capabilities (copied from `startWalkthrough`), eight routes on the existing transport, three pages built from existing UI pieces, one reporter, one SQL query. No new service, package or dependency.
