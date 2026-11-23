# DAP Studio V1A

Studio V1A lets a maintainer enroll an application, inspect its live browser targets and author a walkthrough against its semantic registry. The browser foundation supplied a single reference-app workspace. V1A derives the browser policy and draft validation from the application selected for authoring. Save, preview, publish and walkthrough execution still use the deterministic authoring and runtime model. [Browser foundation and vendor provenance](studio-browser-foundation.md)

## Architecture

```mermaid
flowchart LR
    UI["Studio UI: Application Manager and Editor"] --> Host["Reference host"]
    Host --> Apps["Tenant-scoped application store"]
    Host --> Catalog["Trusted registry catalog"]
    Host --> Session["Application-bound Studio session"]
    Host --> Gateway["Authoring and Policy Gateway"]
    Gateway --> Apps
    Gateway --> Drafts["Tenant-scoped walkthrough definitions"]
    Session --> Port["BrowserRuntime port"]
    Port --> Adapter["agent-browser adapter: origins, routes, labels"]
    Adapter --> CLI["Vendored agent-browser CLI"]
    CLI --> Chrome["Chrome"]
    Chrome --> Application["Enrolled application"]
```

## Enroll an application

As a maintainer, open **Applications** at `#/applications` and choose **Enroll application**. The form sends exactly these fields to `POST /api/admin/applications`. The host assigns an `app-` ID with 12 hexadecimal digits and enables the application on creation.

| Field | Accepted values |
| --- | --- |
| `name` | Plain text, 1–80 characters after trimming. |
| `origin` | The primary `scheme://host[:port]` where Chrome starts. The host normalizes it and drops an optional trailing slash. Credentials, paths, queries and fragments are refused. A host is a DNS name of letters, digits, hyphens and dots (after conversion to punycode), `localhost`, `127.0.0.1` or `[::1]`: `*`, `,`, `;`, `%`, `_`, empty labels and a leading or trailing hyphen are refused because the browser CLI reads the host names as a comma-separated allow-list with `*.` wildcards. The part after `scheme://` (host and port) is at most 190 characters, the bound of the database check on `allowed_origins`, so a valid enrollment is always storable. |
| `allowedOrigins` | 1–5 distinct normalized origins, including the primary origin. The same validation applies to each. |
| `environment` | `development` or `test`. V1A is a staged rollout, with production enrollment deferred. |
| `registryId` | An entry in the host's trusted registry catalog. The reference installation ships `reference`. |

HTTP works on `localhost`, `127.0.0.1` and `[::1]` for local development and tests. Non-loopback hosts require HTTPS and a DNS name. Non-loopback IP literals are refused. Enrollment errors return fixed validation issues. Each tenant can have up to 20 applications. Disable an application with `POST /api/admin/applications/:id/status` and `{"enabled":false}`. Use `PUT /api/admin/applications/:id` to update its configuration.

The host scopes reads and writes to the authenticated principal's tenant. PostgreSQL forces row-level security on `studio_applications` and `walkthrough_definitions`. The application role can select, insert and update application rows. Maintainer writes go through the Policy Gateway and require `perm.walkthrough.maintain`. Enable the following capabilities explicitly in `DAP_ENABLED_ACTIONS`. The Gateway denies them by default. [Local setup and demo sessions](../specs/004-authoring-analytics/quickstart.md)

| Purpose | Capabilities |
| --- | --- |
| Save or enable an application | `saveStudioApplication`, `setStudioApplicationEnabled` |
| Save or publish a walkthrough | `saveWalkthroughDraft`, `setWalkthroughStatus` |

Application writes audit the application ID and, for status changes, the enabled flag. Application names and origins stay out of the audit parameter fields.

## Registry and workflow binding

An application points to a host-controlled catalog entry. The host refuses, when the catalog is composed, an entry the editor could not load: at most 20 routes, 200 elements and 50 postconditions, element ids and postcondition names of at most 80 characters, and postcondition names that are dotted (`area.name`) and unique. That entry defines semantic routes, public targets and their supported operations, and named postconditions. Its browser policy also maps page URLs to semantic routes and specifies which role and accessible-name pairs may appear in the inspector. Hosts provide registry entries in code. V1A has no target-registration UI. The maintainer can read the public-eligible registry via `GET /api/admin/applications/:id/registry`.

New drafts require an enrolled, enabled application. Send `{applicationId, definition}` on create and save, omitting `definition.id` on create. A draft's application is immutable after it is assigned. Validation and publish-time validation use that application's registry. Legacy rows with a null application ID still use `reference` and can take an application on their first save in V1A. Disabling an application blocks save and publish. Unpublishing remains available, and already published definitions are still served if they validate against the current registry.

## Browser session and inspection

A maintainer starts a session with `POST /api/studio/browser`, sending `{action:"connect", applicationId}` and optionally a walkthrough ID. If the supplied walkthrough is already bound, it must belong to this application. The host binds the opaque session ID to the principal key, tenant, actor and application. Only one session and one command can be active per host. Switch applications by disconnecting and then explicitly connecting. Refresh, Highlight and Use require the session and application IDs. Disconnect accepts the session ID and an optional matching application ID.

The host attempts to close the browser after five minutes of idle time and on shutdown. Idle time is measured from the **owner's last successful command** (a connect that opened the session, or a command whose owner, session ID and application ID matched). A rejected connect (`BROWSER_BUSY`), a command with another person's session ID, an unauthorized or malformed request never extends it, so nobody can keep a forgotten session open by probing it. After a page reload the UI has lost the session ID and can only offer **Connect**, which answers `BROWSER_BUSY` while the old session is open; the user waits until the session has been idle for five minutes (clicking Connect meanwhile does not restart the clock), after which Connect works. There is no endpoint to take over a session in V1A. If the application is missing, disabled or its browser policy changes, the next inspection command refuses the request and attempts to close the session. A rename leaves the browser policy intact.

| Concept | What determines it |
| --- | --- |
| Navigation policy | Enrollment supplies the exact origins. The chosen registry supplies allowed page paths and fragments. The adapter checks both before exposing an observation. Each origin uses the same page map. |
| Exposure policy | The registry supplies approved role and accessible-name pairs. The inspector returns at most 64 candidates. |
| Persisted target | The walkthrough step stores the registry's stable semantic ID, for example `profile.nameInput`. |

The inspector marks a candidate **Trusted** when its live `data-ai-id` matches a public entry on the current route, with the same role and the `highlight` operation. An approved-label candidate that fails these checks is **Unregistered**. It has no target ID or operations in the response. Other accessibility labels are omitted. Highlight and Use both re-check the current observation and semantic ID. Highlight draws an outline and writes nothing. Use returns the registry ID and target metadata so the editor can select it. Saving the draft persists the registry ID. Live refs such as `@e21` expire with the inspected page observation and session.

```mermaid
flowchart TB
    Application["Enrolled application in the principal's tenant"] --> Config["Trusted config: origins, pages and labels"]
    Config --> Origin["Exact origin and approved page check"]
    Origin --> Session["Application-bound browser session"]
    Session --> Element["Live element with ephemeral ref"]
    Element --> Lookup["Registry lookup: data-ai-id, route, role, public, highlight"]
    Lookup --> Target["Persisted DAP target ID"]
    Target --> Definition["Walkthrough definition"]
```

### Browser security boundary

The vendored CLI enforces a hostname allowlist. DAP separately checks the exact scheme, hostname and port and the approved page on the URLs it reads. A page on the same hostname and a different port can briefly load in the headed window. The adapter may read a raw accessibility snapshot locally before checking its URL. A blocked observation returns no page content to Studio, and the raw snapshot never leaves the host. Reverification applies the same URL checks before highlighting or returning a target.

### Browser endpoint errors

`POST /api/studio/browser` uses closed `{error: CODE}` replies. Application and authoring endpoints have their own error bodies.

| HTTP | Code | Meaning |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` | Invalid fields, extra fields, or an invalid or unavailable walkthrough ID. |
| 401 | `SESSION_CLOSED` | No authenticated principal. |
| 403 | `FORBIDDEN` | The principal lacks maintainer permission. |
| 404 | `SESSION_CLOSED` | The session is gone, unknown or belongs to another principal. |
| 404 | `APPLICATION_NOT_FOUND` | The application is missing or outside the tenant. |
| 409 | `APPLICATION_DISABLED` | The application is disabled. |
| 409 | `APPLICATION_MISMATCH` | The session or walkthrough is bound to a different application, or the session's policy changed. A wrong application ID in a command leaves the existing session open. |
| 409 | `BROWSER_BUSY` | Connect encountered an existing session, or a browser command is in flight. |
| 409 | `REF_NOT_FOUND`, `TARGET_UNAVAILABLE` | The ref is stale or unknown, or the candidate is unregistered or has changed semantic ID. |
| 503 | `DOMAIN_BLOCKED` | The observed origin or page is outside the session policy. Return to an approved page and refresh. |
| 503 | `BROWSER_UNAVAILABLE`, `BROWSER_NOT_STARTED`, `BROWSER_TIMEOUT`, `NAVIGATION_FAILED`, `SNAPSHOT_FAILED`, `HIGHLIGHT_FAILED`, `CLOSE_FAILED`, `INVALID_BROWSER_OUTPUT` | A configuration, store or runtime error prevented the command from completing. |

## Author and inspect from the editor

In **Applications**, enroll or edit an app, enable or disable it, or choose **Use for authoring** to open a new draft with that app selected. Under **Walkthroughs**, **New walkthrough** opens an editor with an application selector. The editor selects the sole enabled app automatically when only one is available. An existing bound draft displays its application as a read-only label. Disabled apps cannot be selected for a new draft, and Connect is off for an app the editor knows is disabled. A published guide remains available while its application is disabled.

The editor shows the step list, browser inspector and step properties side by side, stacking on narrow screens. **Connect Chrome** opens a separate browser window. Browse there, then choose **Inspect current page** in Studio. The workspace shows the application, connection status, observed URL, semantic route and candidate count. URL, route and count reflect the last successful inspection.

Each candidate shows its accessible name, role, route and a line such as **Live ref: @e21 Session only**. Trusted rows show **Trusted target ✓**, their DAP target ID, allowed operations and **Public**. **Highlight** draws an outline and shows “Highlighted in Chrome — nothing was saved.” **Use** sets the selected step’s semantic target and shows a confirmation such as “Captured target — Profile · link · dashboard · DAP target nav.profile.” Rows labeled **Not registered for walkthrough use** have no action buttons. Switching applications closes the old session, clears the candidates and requires an explicit reconnect. Leaving the editor requests a disconnect.

Use the manual **Semantic target** picker when Chrome or the native browser binary is unavailable. It lists public eligible targets from the selected application's registry. Preview runs inside the reference web app and is available for the `reference` registry. Other registries show “Preview is available for the reference application in this release.”

### Workspace controls

| State | Connect Chrome | Inspect current page | Disconnect | Trusted row actions |
| --- | --- | --- | --- | --- |
| Disconnected | On with a selected application that is not known to be disabled | Off | Off | Off |
| Connecting | Off | Off | Off | Off |
| Connected | Off | On | On | On |
| Inspecting | Off | Off | Off | Off |
| Error | On with a connectable application and no session | On if the session is held | On if the session is held | Off |

A pending command turns all controls off. Browser, navigation, inspection and highlight failures show **Error** and retain a held session. A closed session shows **Disconnected**. A stale ref clears the candidate list and leaves the workspace **Connected**. An unavailable target shows a message and leaves it **Connected**. If the host reports a disabled or missing application during an open session, the workspace clears it and becomes **Disconnected**. An application mismatch shows **Error** with **Disconnect** available while the UI still holds the session. An explicit **Disconnect** always returns the workspace to **Disconnected**. If the host cannot confirm closure, the UI mentions the idle timeout.

## Verify with Chromium

Build and install the pinned native browser, then use the isolated Studio V1A Compose project and apply migrations. Both acceptance commands start the host on 8794, Vite on 5184 and fixture B on 5185. They use new tenants and leave their test data in this disposable database. Run the commands sequentially. They launch headed Chromium with a display and fall back to headless Chromium on Linux without one. [Native browser build](studio-browser-foundation.md#build-and-use)

```bash
DAP_POSTGRES_PORT=54359 docker compose -p dapstudiov1 -f deploy/compose.yaml up -d --wait
export DAP_MIGRATE_DATABASE_URL=postgresql://dap_owner:dap_owner_local_only@127.0.0.1:54359/dap
export DAP_DATABASE_URL=postgresql://dap_app:dap_app_local_only@127.0.0.1:54359/dap
npm run db:migrate
npm run acceptance:studio-v1-host
npm run acceptance:studio-v1-ui
npm run test:studio
npm run probe:studio-domains
```

Host acceptance exercises the HTTP API with the real Gateway and PostgreSQL. UI acceptance drives the editor in a separate Chromium session, completes Preview and the published guide, and checks application switching, domain refusal and session cleanup. Add `-- --measure-cap` to the UI command to measure a refresh of 64 of the fixture's 70 approved links with Chrome already connected. The domain probe checks the browser adapter directly. [Host acceptance](../scripts/studio-v1-host-acceptance.mjs) · [UI acceptance](../scripts/studio-browser-smoke.mjs) · [Domain probe](../scripts/studio-domain-probe.mjs)

## V1A limits

The host supports one browser session at a time, one shared route map per application across its origins, and no target-registration UI. Preview is limited to the `reference` registry. The enabled check and authoring write are separate operations, so a concurrent disable can race with a save or publication. Qdrant retrieval and LLM-assisted authoring are outside this release.
