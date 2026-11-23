# Simplism Runtime SDK V1

Simplism runs public guides published from Studio in your application. The browser SDK loads the application’s live guides from the Simplism backend and runs them through the same deterministic walkthrough engine as Studio Preview. Publishing and target management happen in Studio. Users can open your application directly to run a guide.

## Quickstart

1. In Studio, enroll your application with its exact origin and the appropriate **Hash** or **History** routing mode. Add unique, stable `data-ai-id` markers to public controls, register those targets, and publish a guide.
2. Enable **Runtime access** in the application settings. Copy the application ID and public runtime key. The key identifies the application and may appear in your browser configuration. Keep credentials and private instructions out of public guides.
3. Build and pack the SDK from the Simplism checkout. Install the tarball in your application.

   ```sh
   npm run build:sdk
   npm run verify:sdk-package
   npm pack ./apps/reference-web/dist/sdk
   # In the consuming project
   npm install /path/to/simplism-sdk-1.0.0.tgz
   ```

4. Serve the packaged `simplism.css` on your app or import it through a build that emits an external stylesheet. In your browser entry module, after the document body is available, initialize Simplism.

   ```ts
   import { createSimplism } from "@simplism/sdk";

   const setup = createSimplism({
     applicationId: "app-0123456789ab",
     runtimeKey: runtimeConfig.publicKey,
     apiOrigin: "https://guides.example.com",
     stylesheetUrl: "/assets/simplism.css",
   });

   if (setup.ok) {
     const simplism = setup.value;
     await simplism.start();
     // Integrate with your app's teardown when it unmounts.
     // simplism.destroy();
   }
   ```

5. Open **Guides**, select the guide, and follow the instructions. Your app can also open the launcher from its own Help button.

Applications without a bundler can self-host `index.js` and `simplism.css` from the package and import `createSimplism` from the deployed module URL in an external browser script. See the two-app [SDK consumer fixture](../tests/fixtures/runtime-consumer/boot.js) for a complete example. The package exports only the SDK entry and `@simplism/sdk/simplism.css`. It has no server-side dependency or Studio client.

## API reference

`createSimplism(options)` returns `{ ok: true, value: instance }` or `{ ok: false, code }`. Calls with the same effective configuration reuse one instance per page. A competing configuration or standalone legacy embed yields `ALREADY_INITIALIZED`. Use the existing `dap-embed.js` integration for Studio’s opener-based Preview. The SDK’s independent mode uses neither an opener nor a Studio session.

| Method | Behavior |
|---|---|
| `start()` | Mounts the launcher and loads the public catalog. Concurrent and repeated calls share initialization. |
| `listGuides()` | Refreshes the catalog. Returns guide IDs, titles, and descriptions. |
| `openLauncher()` | Opens the keyboard-accessible launcher and refreshes the catalog. |
| `startGuide(id)` | Starts a listed guide after fetching and validating its current published bundle. |
| `stopGuide()` | Cancels a pending bundle request or removes the active run and its overlay. |
| `restartGuide()` | Starts the most recently started guide from its first step using a fresh bundle. Interactions already performed in the host application remain in effect. |
| `getRun()` | Returns a snapshot of the run state, including a typed failure code when applicable. |
| `destroy()` | Stops the guide, aborts requests, and removes the instance’s launcher, listeners, timers, and stylesheet. Existing host-owned styles and DOM stay in place. |

Asynchronous calls return a discriminated result with either `value` or a stable `code`. Configuration and lifecycle codes include `INVALID_CONFIGURATION`, `ALREADY_INITIALIZED`, and `RUNTIME_DESTROYED`. Loading reports `APPLICATION_UNAVAILABLE`, `NETWORK_UNAVAILABLE`, or `INVALID_RESPONSE`. The launcher offers Retry for temporary loading failures. Guide errors include `GUIDE_NOT_FOUND`, `GUIDE_BUSY`, `TARGET_NOT_FOUND`, `ROUTE_MISMATCH`, and `VERIFICATION_FAILED`. The launcher shows fixed messages and keeps actual comparison values in the page.

## Routing and verification

Hash applications match the current pathname and hash. History applications match the pathname, normalize a trailing slash, and ignore queries and fragments. For programmatic history navigation, the SDK uses `pushState` and sends `popstate` so the app can render. It observes changes during a guide without replacing the app’s history methods. Unexpected navigation stops a guide safely when its active control belongs to another route. Cross-origin or full-page navigation ends the current page’s run. On reload, initialization starts again with no restored progress.

The engine resolves unique registered markers on the active route and advances after the declared click, input, or acknowledgement and its verification. Route, visibility, text, value, and supported attribute checks have the same semantics as Studio. Missing or ambiguous controls and failed checks cannot advance a guide. Use public expected values. Completion is announced in the result dialog. Dismissing it returns focus to the launcher.

## Origins and Content Security Policy

Use an API origin distinct from the page origin. The browser must send the page’s exact enrolled `Origin` on credential-free runtime requests. Both the public key and configured application ID must match the enabled application. The backend serves only currently compatible live versions. Drafts, archived guides, and disabled targets are excluded. V1 standalone delivery is public and has no individual-user authorization.

Self-host the module, your startup script, and the stylesheet. For example:

```text
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' https://guides.example.com; base-uri 'none'; form-action 'none'
```

The SDK uses external CSS and scopes rules to its own launcher and walkthrough elements. If you load the stylesheet yourself, omit `stylesheetUrl`. Dynamic placement uses the existing overlay CSSOM implementation and requires neither inline scripts nor `unsafe-inline`.

## Local verification

Run `npm run test:runtime-sdk` with the normal PostgreSQL test configuration. Run `npm run build:sdk && npm run verify:sdk-package` to check the browser artifact and its declaration surface. The two-application Chromium acceptance uses the repository’s pinned browser binary, an isolated migrated database, and no running Studio UI.

```sh
npm run acceptance:runtime-sdk -- --headless
```

Set the acceptance database variables for the local isolated database on port 54362, as described in the [Studio guide](studio-v1.md#verify-with-chromium). The SDK acceptance uses ports 8795 and 5186–5188.
