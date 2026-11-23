# Simplism Browser Extension V1

The Chromium extension lets a user run published Studio guides on a site they enable. It uses the [Runtime SDK](runtime-sdk.md) and the site's existing public `data-ai-id` controls. A Studio maintainer still enrolls the application, registers its targets, and publishes its guides.

## Install locally

1. From the repository root, use the Node version in `.nvmrc`, run `npm ci`, then run `npm run build:extension`.
2. Open `chrome://extensions` in Chrome or Chromium 116 or later. Turn on **Developer mode**, choose **Load unpacked**, and select `apps/browser-extension/dist`, the folder containing the generated `manifest.json`.
3. Open the browser's Extensions menu and pin **Simplism**. After rebuilding locally, use the extension card's reload button and reload the application tab. [Chrome's unpacked installation instructions](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked)

## Enable an application

1. Ask the Studio maintainer for the application's **Application ID**, **Runtime key**, and **API origin**. The API origin is the backend's scheme, host and optional port. Leave off any path or trailing slash.
2. Navigate to the exact enrolled site and open the Simplism toolbar popup. Enter the three values and choose **Save site**. If the site needs browser access, Simplism opens a setup tab. Choose **Allow site access**, then approve Chrome's prompt. The setup tab saves the binding and returns you to the original page.
3. Choose **Open Simplism**, then select a published guide. Use the in-page launcher to stop or restart an active guide. A page reload ends the run. The enabled site can mount a fresh launcher for the next run.
4. Reopen the popup to see the current page's cached status and published guide count when available. Use **Refresh** to fetch the latest catalog. Use **Disable on this site** to remove the extension's runtime and stop loading guides there. Use **Enable on this site** and then **Open Simplism** to start using the saved binding again.

If a page already integrates the SDK directly, its runtime owns the page. Use that page's **Guides** launcher. If an enrolled site changes origin, save a new binding on that origin.

## Permissions and architecture

- `activeTab` lets the toolbar popup identify the current page when the user opens it. `scripting` lets the extension attach its bundled runtime and CSS to the enabled page. `storage` stores the site binding locally in the browser profile. [Chrome activeTab and script injection](https://developer.chrome.com/docs/extensions/get-started/tutorial/scripts-activetab)
- The manifest declares optional HTTP and HTTPS site permissions so users can enroll their own applications. The setup tab keeps the save in progress through Chrome's permission prompt. Before it saves, the worker verifies that the original document is still open and that Chrome granted access to its exact web origin, including the port. Use Chrome's extension Details page to review or revoke a browser-level grant. [Chrome extension permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)
- The MV3 worker coordinates popup actions and top-frame attachment. The worker rechecks the active tab's document and origin before applying a binding. A registered content script asks the worker to attach on enabled pages, and the worker loads the packaged Runtime SDK in the page's main world. The extension injects the SDK's bundled CSS through Chrome's scripting API. [Chrome scripting API](https://developer.chrome.com/docs/extensions/reference/api/scripting)
- The SDK makes credential-free requests from the application origin to the configured API. The backend applies its usual exact-origin and application binding checks and returns compatible live guides. A page CSP with restrictive `connect-src` must allow the API origin. The bundled code and CSS do not require `unsafe-inline`. [Runtime SDK origin and CSP requirements](runtime-sdk.md#origins-and-content-security-policy)

## Handling public guide data

The Runtime key is a public application identifier. Store only public guide text, control metadata, and expected check values. The Runtime API serves published guides for that application, with the same public delivery rules as the direct SDK. Private application data, credentials, and per-user authorization belong in the host application. See the [Runtime SDK's delivery model](runtime-sdk.md).

A missing guide control or failed verification stops progress. Check that the page is on the expected route and its public `data-ai-id` marker is unique and present. When guides are unavailable, check the exact allowed origin in Studio, Runtime access, the Application ID and Runtime key, the API origin, and the page's CSP. If Chrome withholds access, reopen the toolbar popup from the target page and check that site's permission.

## Validate the extension build

Run `npm run test:extension` for binding and worker tests. Run `npm run verify:extension` after building to check the manifest and bundle boundaries. Site bindings persist in the browser profile, including after extension restart. Disabling a binding stops playback and leaves its optional permission available for re-enabling.

## Run unpacked acceptance

Use a terminal on a desktop with headed Chromium and the [vendored agent-browser binary](studio-browser-foundation.md#build-and-use). Use the existing migrated, isolated PostgreSQL on port `54362` with `DAP_DATABASE_URL` set to its `dap_app` URL. Reserve ports `8795` and `5186`–`5188` for the run.

```sh
npm run build:extension
npx tsc -b
DAP_ACCEPTANCE_DB_PORT=54362 node scripts/browser-extension-acceptance.mjs \
  --browser-extension apps/browser-extension/dist
```

The harness launches only the unpacked build in a fresh temporary browser profile. Follow its terminal prompts for actual toolbar clicks and Chrome permission dialogs. The harness drives page interactions and checks DOM, catalog delivery, CSP, failure and cleanup assertions. It publishes independent guides on hash and history origins, leaves drafts unpublished, and uses a third unconfigured origin to check isolation. The collision fixture includes the direct SDK only when requested. The run closes its browser sessions and fixture servers and removes its profile on exit. PostgreSQL is reused without resetting it.

To verify fixture setup before the extension bundle is available, run `npm run build:sdk` and `npx tsc -b`, then use the same acceptance command with `--browser-extension --fixtures-only` in place of the directory. That mode publishes the test guides and checks the fixture CSP and live catalogs.
