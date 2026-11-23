# Studio quickstart

Publish a guide for a managed application, then run it with Studio closed. The example uses a history-routed profile page with a **Save** button and a **Profile saved** status message.

1. **Start the local demo.** Follow the [browser build instructions](studio-browser-foundation.md#build-and-use) and the [local PostgreSQL, host and web setup](../specs/004-authoring-analytics/quickstart.md). Use the demo **Maintainer** role. The host setup includes the action allowlist for Studio writes. The demo role switch is for local development.

2. **Prepare the application.** Run the app on an enrolled origin such as `http://127.0.0.1:5189`. Make `/profile` work directly and through the app's history router. For this one-page guide, redirect `/` to `/profile` on the same origin so the Preview window opens on the first step's page. Give the button a unique `data-ai-id="profile.save"`. Give its public, visible status region `role="status"` and `data-ai-id="profile.saved"`. After Save, make that region read `Profile saved`. Serve both build outputs from the same directory on the app. The example assumes Studio Web runs on port 5173.

   ```bash
   npm run build:embed
   # Serve apps/reference-web/dist-embed/dap-embed.js and dap-embed.css on the app.
   ```

   ```html
   <script src="/dap-embed.js" data-dap-origin="http://127.0.0.1:5173"></script>
   ```

3. **Enroll the application.** In **Applications**, choose **Studio-managed**, **History** and **Development**. Enter the primary origin and include it among the allowed origins with its exact port. Save and choose **Open Studio**. For a hash app, choose **Hash** and use a page key such as `/#/profile`.

4. **Record the page and its targets.** In Studio choose **Connect Chrome**, open `/profile` in Chrome and choose **Inspect current page**. If the status region only appears after Save, complete that interaction in Chrome and inspect again. Choose **Register target…** for Save, pick a label and description and record route `profile`. Register the marked status region on the same route. Give Save highlight and click. The text target supports highlight only.

5. **Save a workflow with a check.** Enter a title, description and completion message. **Use** the trusted Save row for a guide step, choose **Click** as the interaction and enter a short instruction. Under **Verification**, choose **Element text equals**, select the status target and enter `Profile saved` as **Expected value**. Select **Set verification**, then **Save draft**. Use public copy and expectations. The guide stores the target ID rather than a browser ref.

6. **Preview and return to editing.** Click **Preview** and perform the Save interaction in the app window. Confirm that **Preview results** shows the run completed after the check. Choose **Edit** to return to the draft. If the target is missing, use the result's repair action or open **Targets**, inspect the recorded page and review the repair's impact before confirming.

7. **Review and publish.** With the draft saved, choose **Publish**. Read the review, resolve blockers and confirm publication. **Version history** shows version 1 as live. If another editor saves before confirmation, reload or reconcile changes and review the new revision.

8. **Run without Studio.** Enable **Runtime access** in the managed application's settings and copy its public key from the overview. For the self-hosted files in step 2, replace the script tag with the example below and use the actual local API port from your host setup. Adjust the application's [CSP](studio-v1.md#content-security-policy) if needed. Close Studio, open the app directly and choose **Guides** → **Start**. Use this delivery mode for public guide content.

   ```html
   <script src="/dap-embed.js"
           data-dap-origin="http://127.0.0.1:5173"
           data-dap-key="REPLACE_WITH_RUNTIME_KEY"
           data-dap-api="http://127.0.0.1:8791"></script>
   ```

9. **Revise without interrupting users.** From **Workflows**, choose **Create draft from published**. Edit and save while visitors can still run version 1. Review and publish version 2. Compare the two in **Version history**. To try the original again, use **Create draft from this version** on version 1. Version 2 stays live until the restored draft is published or you unpublish.

See the [Studio guide](studio-v1.md) for routing, privacy, session recovery and runtime delivery boundaries.
