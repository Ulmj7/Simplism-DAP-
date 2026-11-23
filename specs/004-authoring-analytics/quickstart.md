# Walkthrough authoring and usage analytics

Run this demo locally with Node 22+, Docker Compose and a Chromium-based browser (the smoke below used Chrome 157). Both demo roles must use the same tenant. The host selects a server-held session. The browser's role selector is available in Vite development mode, and ordinary User sessions receive a denial on maintainer routes.

## Run PostgreSQL

From the repository root, install dependencies, start a separate Compose project and migrate as the owner.

```bash
npm ci
DAP_POSTGRES_PORT=54339 docker compose -p dap004final -f deploy/compose.yaml up -d --wait
export DAP_MIGRATE_DATABASE_URL=postgresql://dap_owner:dap_owner_local_only@127.0.0.1:54339/dap
export DAP_DATABASE_URL=postgresql://dap_app:dap_app_local_only@127.0.0.1:54339/dap
npm run db:migrate
```

The bundled passwords are local fixtures. Compose creates database `dap` and configures `dap_owner` for migrations and `dap_app` for the running host. The default Compose port is 54329. The commands above use 54339 to keep the demo project independent.

## Run the host and web app

In the terminal with the database URLs, configure the reference host. The fixture below gives both sessions a one-hour lifetime. It uses the offline guidance model and the default Gateway configuration.

```bash
export NODE_ENV=development DAP_ALLOW_DEV_AUTH=1 DAP_GUIDANCE_MODEL=fake
export DAP_HTTP_PORT=8791
export DAP_ENABLED_ACTIONS=startWalkthrough,saveWalkthroughDraft,setWalkthroughStatus,saveStudioApplication,setStudioApplicationEnabled,registerStudioTarget,setStudioTargetStatus
export DAP_DEMO_SESSION_TOKEN=local-user-token DAP_DEMO_MAINTAINER_TOKEN=local-maintainer-token
export DEV_SESSIONS="$(node -e '
const e = process.env;
const tenantId = "e3150ee5-615a-4bfb-8ff0-5af500eade04";
const validUntil = new Date(Date.now() + 3600000).toISOString();
console.log(JSON.stringify([
  { token: e.DAP_DEMO_SESSION_TOKEN, userId: "demo-user", tenantId,
    sessionId: "feature-004-demo-user", validUntil, permissions: ["perm.guidance.start"] },
  { token: e.DAP_DEMO_MAINTAINER_TOKEN, userId: "demo-maintainer", tenantId,
    sessionId: "feature-004-demo-maintainer", validUntil, permissions: ["perm.walkthrough.maintain"] }
]));
')"
npm run dev:host
```

Enable `saveWalkthroughDraft` and `setWalkthroughStatus` for draft and publication writes, and `saveStudioApplication` and `setStudioApplicationEnabled` for enrollment and application status. Studio requires an enabled application before authoring. Use the same origin as Vite when enrolling the reference app in the demo tenant. You can enroll from Applications after opening the web app, or send this request while the host is running.

```bash
curl --fail-with-body --request POST http://127.0.0.1:8791/api/admin/applications \
  --header 'X-Demo-Role: maintainer' --header 'Content-Type: application/json' \
  --data '{"name":"Reference application","origin":"http://127.0.0.1:5173","allowedOrigins":["http://127.0.0.1:5173"],"environment":"development","registryId":"reference"}'
```

Use the returned application ID when authoring. The draft API takes `{applicationId, definition}`. Legacy guides use the reference registry. [Studio V1B application and browser setup](../../docs/studio-v1.md)

In another terminal, use the same port for Vite's same-origin `/api` proxy. Both processes default to host port 8787 when `DAP_HTTP_PORT` is unset.

```bash
DAP_HTTP_PORT=8791 npm run dev:web
```

Open `http://127.0.0.1:5173`. Restart the host with refreshed fixture sessions if the demo role session expires.

## Onboard a managed application

Build the embed with `npm run build:embed` and serve the resulting `dap-embed.js` on the enrolled application. Set the attribute to the web origin serving Studio.

```html
<script src="/dap-embed.js" data-dap-origin="http://127.0.0.1:5173"></script>
```

Enroll the application with **Studio-managed** as its registry. Give public controls stable markers such as `data-ai-id="orders.submit"` and use hash routes. Choose **Use for authoring**, connect Chrome, inspect a page and register eligible targets. Enable `registerStudioTarget` for registration and `setStudioTargetStatus` for the manager's disable and enable actions. Select registry IDs in the editor and preview in the enrolled application window. Published managed guides launch from the external guides list. [Managed inspector and embed setup](../../docs/studio-v1.md#preview-and-run-a-managed-guide)

## A — Create a walkthrough

1. Change **Demo role** to **Maintainer**. Open **Applications** and choose **Use for authoring** for the enabled reference application. You can also open **Walkthroughs**, select **New walkthrough** and choose the reference application in the editor.
2. Enter a title, short description and completion message. Set the first step's semantic target to **Name** under **Profile**, set **Interaction** to **Acknowledge** and enter an instruction.
3. Add a second step for **Security** under **Settings** with another acknowledgement instruction. The editor shows validation problems as you edit. Use **Save draft** and wait for **Saved**. The server generates the guide ID.

## B — Reject an invalid draft

Clear one instruction. The editor names the affected step and disables **Save draft**, **Preview** and **Publish**. Restore the instruction and save before publishing.

## C — Preview and publish

1. Select **Preview**. Follow both real overlay steps, then dismiss the result. The editor retains your draft and the preview records no usage.
2. Select **Publish** and confirm. The host revalidates the stored definition and the editor returns to the list after success.
3. Switch to **User**, open **Dashboard** and find the walkthrough under **Guides**. Drafts stay out of this launcher. To edit a published guide again, switch back to **Maintainer**, unpublish it and then select **Edit**.

## D — Measure a completion and cancellation

1. Start the published guide under **Guides** and finish both steps. Dismiss the result dialog.
2. Start the guide again and press Escape during the run. Close the cancelled result.
3. Switch to **Maintainer** and open **Analytics**. For a fresh tenant with only these runs, the totals and the guide row show 2 starts, 1 completion, 1 cancellation and a 50% completion rate. An empty tenant shows a dash for the rate.

The browser reports start and terminal events for product usage. Closing an unfinished run can leave a start without a terminal event. Reports can be lost and do not establish what happened for security audit purposes. Preview remounts the real reference app with an isolated temporary catalog entry and restores the normal app on return.

Save is explicit. Writes can be throttled and may show a standard retry message. The host caps publish count at 50 per tenant and stored definitions at 32 KiB. The save route also bounds the Gateway proposal to 15,000 bytes, so a definition with many multibyte characters may reach the save limit first.

## Smoke record

The smoke used Chrome 157 (Chromium engine, driven by `agent-browser`) against Vite, the real host on port 8791 and PostgreSQL on port 54339. Screenshots were captured separately from the repository. The final QA repeated it independently on a fresh database by pasting this quickstart's environment block verbatim (last row).

| Scenario | Viewport | Result | Date |
| --- | --- | --- | --- |
| A — Create | 1440 and 390 px | Saved two guide steps spanning Profile and Settings. | 2026-11-20 |
| B — Reject an invalid draft | 1440 and 390 px | Missing instruction identified by step. Save, Preview and Publish disabled. | 2026-11-20 |
| C — Preview and publish | 1440 and 390 px | Real overlay completed. SQL confirmed zero usage rows and draft status after Preview. Published guide appeared in the User launcher. | 2026-11-20 |
| D — Analytics | 1440, 768 and 390 px | One completion and one Escape cancellation. UI totals and guide row matched PostgreSQL at 2 starts, 1 completion, 1 cancellation and 50%. No page-level horizontal overflow. | 2026-11-20 |
| Editor layout | 768 and 390 px | Panes stacked with no page-level horizontal overflow. | 2026-11-20 |
| Walkthrough list | 1440, 768 and 390 px | The authored row showed two guide steps. No page-level horizontal overflow. | 2026-11-20 |
| Final QA re-run (A–D, direct admin URL as User) | 1440; 768 and 390 for S05, S06, S07 | A User opening `#/walkthroughs` directly saw only the denied message, no rows and no admin links. Maintainer: the target list held exactly the 8 registry targets, interactions followed the target, an invalid step disabled all three actions, Preview ran the real overlay and left no event rows, and Escape closed the Publish dialog without publishing. After Publish the User launcher listed the guide. One completion and one Escape cancellation, plus one start posted by hand with curl for an unrelated built-in guide, showed 3 started, 1 completed, 1 cancelled and 33% in the UI, equal to the SQL counts. A typed canary was in no event row. No page-level horizontal overflow. | 2026-11-20 |
