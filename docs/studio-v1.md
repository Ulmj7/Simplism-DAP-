# DAP Studio V1B

Studio lets maintainers enroll an application, inspect its live browser controls, register eligible targets and author deterministic walkthroughs. Built-in registries remain host-owned. New applications can use a Studio-managed registry stored in PostgreSQL. [Browser foundation and vendor provenance](studio-browser-foundation.md)

## Architecture

```mermaid
flowchart LR
    UI["Studio editor and Application Manager"] --> Host["Reference host"]
    Host --> Gateway["Policy Gateway"]
    Gateway --> DB["Tenant-scoped applications, routes, targets and drafts"]
    Host --> Catalog["Built-in registry catalog"]
    Host --> Session["Application-bound inspection session"]
    Session --> Adapter["BrowserRuntime and vendored CLI"]
    Adapter --> Chrome["Chrome on the enrolled application"]
    UI --> Embed["Deterministic embed in the application window"]
```

## Enrollment and ownership

Open **Applications** as a maintainer. Supply a plain-text name of 1–80 characters, a primary origin, 1–5 distinct allowed origins including the primary, an environment (`development` or `test`), and a registry. The host normalizes origins to `scheme://host[:port]`, drops an optional trailing slash and rejects credentials, paths, queries and fragments. The full origin allows at most 200 characters, and the hostname and port together allow at most 190. DNS labels use letters, digits and hyphens after URL normalization, with each label starting and ending in a letter or digit. Non-loopback hosts require HTTPS and a DNS name. Local development also permits HTTP on `localhost`, `127.0.0.1` and `[::1]`.

| Registry choice | Source and behavior |
| --- | --- |
| Built-in, such as `reference` | The host catalog defines the pages, labels, targets and postconditions. The Application Manager shows a read-only registry. |
| `studio-managed` | Starts empty. Maintainers register routes and targets from inspected controls. PostgreSQL stores them per application and tenant. |

An application keeps its registry source after enrollment. Each tenant can enroll 20 applications. The host requires `perm.walkthrough.maintain` on maintainer endpoints and PostgreSQL forces row-level security for application, registry and authoring tables. Configure `DAP_ENABLED_ACTIONS` with `saveStudioApplication`, `setStudioApplicationEnabled`, `registerStudioTarget`, `setStudioTargetStatus`, `saveWalkthroughDraft` and `setWalkthroughStatus`. The Gateway denies these writes by default. Target audit parameters carry the application and target IDs, and the status when it changes. [Local setup](../specs/004-authoring-analytics/quickstart.md)

## Inspect and register

Choose **Use for authoring** in Applications or choose an enabled application in a new draft. A saved draft shows its bound application as a fixed label. **Connect Chrome** opens the enrolled application in a separate browser. Browse there and then choose **Inspect current page** in Studio.

Built-in inspection uses the catalog's approved labels and pages. Managed inspection considers up to 64 operable controls in document order. The host reevaluates privacy and the name deny-list for every candidate, including existing targets. A trusted row has an active registry ID matching the page's route and the control's mapped semantic role. A disabled row names an eligible control whose registry target is disabled. A registrable row is eligible and has a valid new marker. Other managed controls contribute only to the hidden count.

```mermaid
flowchart TB
    App["Enrolled application and tenant"] --> Origin["Exact allowed origin and page"]
    Origin --> Live["Current observation and ephemeral ref"]
    Live --> Checks["Marker, role, current privacy and accessible name"]
    Checks --> Form["Maintainer confirms label, description, operations and route"]
    Form --> Gateway["Gateway and in-transaction validation"]
    Gateway --> Registry["Durable application route and target ID"]
    Registry --> Guide["Application-bound walkthrough"]
```

- Mark controls with stable `data-ai-id` values such as `orders.submit`. The live `@eN` ref is used within the session and expires with the observation. The draft stores the registry ID.
- Select **Register target…** on an eligible row. The ID comes from the live marker. The host derives role and page from the observation. Button, link, textbox, searchbox, checkbox and combobox are registrable. Searchbox maps to textbox and combobox maps to select.
- The marker must be a dotted semantic ID of at most 80 characters, starting with a lowercase letter and using letters and digits within each segment. Its first segment cannot be `dap`, `studio`, `admin`, `system` or `internal`. Only public controls pass. Current facts exclude ignored, private or redacted controls, password or hidden inputs, credit-card autocomplete fields, password autocomplete fields and one-time-code controls. A case-insensitive name heuristic also hides secret-looking names. Missing facts fail closed. The check sees the element's own facts and does not propagate ancestor privacy markers. Application authors should mark sensitive controls directly.
- Choose role-appropriate operations including `highlight`, a plain-text label up to 80 characters and a description up to 240 characters. Keep an existing page's route. For a new page, use a route matching `^[a-z][A-Za-z0-9]{0,39}$`, such as `orderList` for `/#/order-list`. Managed pages use `/` or a hash route under `/`. The registry holds up to 20 routes and 200 targets per application.
- The host re-verifies the marker and facts against the current observation before registration, then submits the Gateway capability. The store commits the target and any new route together. The reply reports whether that transaction created the route.
- **Highlight** draws an outline and persists nothing. **Use** binds the selected step to an active trusted ID. Its reply uses the stored semantic role. Before either action on a managed control, the host rechecks the current marker, privacy and registry. The inspector displays the observed browser role and labels live refs as session-only. The manual target picker is available for existing registry targets if Chrome is unavailable.

## Binding, target status and publication

A draft supplies `{applicationId, definition}` and keeps that application after its first bound save. A legacy unbound draft resolves through `reference`. A managed registry supplies `route.<route>` postconditions. Targets and routes are immutable. The manager can disable or re-enable a target and shows how many draft and published definitions reference it. Disabling removes it from validation and public bundles. A published managed guide that references it leaves the launcher until it validates again after re-enablement. Disabling an application blocks save, publish, registration and target enablement. Unpublish and target disable remain available.

Previously a disable could commit between the application check and the write. Save, publish, target registration and target status changes now acquire a `FOR SHARE` lock on the application row inside their tenant transaction. If disable wins first, the write observes the new state. If the writer wins, disable waits for commit. Real two-connection tests verify both orderings. PostgreSQL also enforces application ownership, immutability, uniqueness, caps and distinct operation and origin arrays for new writes. Migration 075 leaves legacy rows in place.

## Browser boundary and session recovery

The vendored Rust and injected JavaScript filters enforce a hostname allowlist. DAP independently checks the exact scheme, hostname and port before exposing observations or acting on targets. Chrome can load a different port on an allowed hostname. The CLI snapshot is collected locally before the adapter checks its reported URL, so the host discards off-policy output before returning any observation or candidate. The approximately 20-line vendor-side origin-filter change was deferred.

The host keeps one session and one in-flight command. The owner identity includes the principal, tenant and actor, and the session also binds the application and an opaque ID. Switching or leaving the editor requests a disconnect. If a reload leaves the old session open, **Connect** reports busy and **Reconnect** adopts it for the same owner and application under a new ID. The old ID stops working. Rejected connect and resume requests do not extend the five-minute idle timer. Host shutdown also closes the session.

| HTTP | Browser error | Meaning |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` | The command shape is invalid. |
| 401 / 403 | `SESSION_CLOSED` / `FORBIDDEN` | Authentication or maintainer permission is required. |
| 404 | `SESSION_CLOSED`, `APPLICATION_NOT_FOUND` | The session or the tenant's application is unavailable. |
| 409 | `BROWSER_BUSY`, `APPLICATION_DISABLED`, `APPLICATION_MISMATCH` | The slot is occupied or the application is disabled or mismatched. |
| 409 | `REF_NOT_FOUND`, `TARGET_UNAVAILABLE`, `TARGET_NOT_REGISTRABLE` | Refresh stale evidence or choose an eligible control. |
| 409 | `TARGET_ID_MISMATCH`, `TARGET_EXISTS`, `ROUTE_MISMATCH`, `REGISTRY_NOT_MANAGED`, `REGISTRY_FULL` | The marker, route, source or registry state prevents registration. |
| 422 | `INVALID_TARGET` | The submitted fields failed validation. The reply includes fixed validation issues. |
| 503 | `DOMAIN_BLOCKED`, `BROWSER_UNAVAILABLE` and runtime failures | The browser operation or store is unavailable, or the observed URL is outside policy. |

The workspace enables Connect when an enabled application is selected and the UI holds no session. Connected workspaces enable Inspect, Disconnect and applicable row actions. Connecting, inspecting or any pending command disables controls. Errors with a held session allow inspection and disconnect. A stale ref clears candidates. A closed session clears the UI's session, and explicit Disconnect always returns the UI to Disconnected.

## Preview and run a managed guide

Build the embed with `npm run build:embed` and serve `apps/reference-web/dist-embed/dap-embed.js` on the enrolled application. Set `data-dap-origin` to the Studio web origin.

```html
<script src="/dap-embed.js" data-dap-origin="http://127.0.0.1:5186"></script>
```

Built-in reference Preview runs in the reference app. Managed Preview opens the application window with the validated draft bundle. Published managed guides appear in the external launcher. The authenticated launcher loads `GET /api/walkthroughs/published/:id/bundle`, which revalidates the published definition against the active registry and returns the application identity, definition, routes, pages and public targets.

The application embed waits for a matching opener and exact Studio origin. The opener waits for a versioned ready message from the expected child at the enrolled origin, then sends the validated bundle using that exact origin. The embed checks sender and origin, validates the bundle and runs the deterministic overlay on the application page. Progress and terminal status return through the same handshake.

The embed does not authenticate or fetch a bundle independently without the opener. A cross-origin delivery flow with its own authentication and CORS remains future work. The opener relationship needed for the handshake carries reverse-tabnabbing risk, so use applications you trust. Popup blocking or COOP can prevent the handshake. Strict CSP must permit the embed asset and its injected style element. The installer has no style nonce option. Managed playback supports hash routing and route postconditions only.

## Verify with Chromium

Use Compose project `dapstudiov1b` on PostgreSQL 54362 and apply migrations using `dap_owner`. The demo host runs as `dap_app`. Run the checks sequentially on host 8795, Vite 5186 and fixture 5187.

```bash
DAP_POSTGRES_PORT=54362 docker compose -p dapstudiov1b -f deploy/compose.yaml up -d --wait
export DAP_MIGRATE_DATABASE_URL=postgresql://dap_owner:dap_owner_local_only@127.0.0.1:54362/dap
export DAP_DATABASE_URL=postgresql://dap_app:dap_app_local_only@127.0.0.1:54362/dap
export DAP_ACCEPTANCE_DB_PORT=54362
npm run db:migrate
npm run acceptance:studio-v1b-host
npm run acceptance:studio-v1b-ui -- --ordinary
DAP_PROBE_PORT_A=5186 DAP_PROBE_PORT_B=5187 npm run probe:studio-domains
```

Use `-- --headless` for the host command without a display, or add `--headless` after the UI arguments separator. Tests use separate fresh tenants on the isolated database. [Pinned browser build](studio-browser-foundation.md#build-and-use)
