import assert from "node:assert/strict";
import { browserCommand, browserSession, request, studio, trackProcesses } from "./studio-acceptance-support.mjs";

const applications = "/api/admin/applications";
const workflows = "/api/admin/walkthroughs";
export const callBrowser = async (session, ...args) => {
  const result = await browserCommand(session, ...args);
  assert.equal(result.success, true, `Browser ${args[0]} failed: ${result.error ?? ""}`);
  return result.data;
};

export async function publishRuntimeConsumer(consumer) {
  const { name, origin, routing, prefix } = consumer;
  const app = await request("POST", applications, 201, {
    name, origin, allowedOrigins: [origin], routing, environment: "test", registryId: "studio-managed", runtimeAccess: true,
  });
  const { sessionId } = await studio("connect", { applicationId: app.id });
  const command = (action, fields) => studio(action, { sessionId, applicationId: app.id, ...fields });
  async function register(marker) {
    const { elements } = await command("refresh");
    const candidate = elements.find(item => item.proposal?.targetId === marker);
    assert.ok(candidate, `Missing registrable marker ${marker}`);
    const { targetId, route, suggestedLabel, defaultOperations } = candidate.proposal;
    return command("register", { ref: candidate.ref, targetId, route, label: suggestedLabel, description: `Public ${suggestedLabel} control.`, operations: defaultOperations, privacy: "public" });
  }
  let profile;
  try {
    await trackProcesses();
    await register(`${prefix}.profile`);
    await callBrowser(browserSession(), "click", `[data-ai-id="${prefix}.profile"]`);
    await callBrowser(browserSession(), "wait", "#label");
    profile = (await register(`${prefix}.label`)).route.route;
    await register(`${prefix}.save`);
    await callBrowser(browserSession(), "click", "#save");
    await register(`${prefix}.saved`);
  } finally {
    await command("disconnect");
  }
  const checks = `${applications}/${app.id}/checks`;
  const text = await request("POST", checks, 200, { kind: "element.text.equals", targetId: `${prefix}.saved`, expected: "Saved" });
  const definition = {
    title: `Set name in ${name}`, description: "Change and save the display name.", start: "open",
    steps: [
      { id: "open", kind: "guide", target: `${prefix}.profile`, text: "Open Profile.", wait: "click", verify: `route.${profile}`, next: "enter" },
      { id: "enter", kind: "guide", target: `${prefix}.label`, text: "Enter a display name.", wait: "input", next: "save" },
      { id: "save", kind: "guide", target: `${prefix}.save`, text: "Save your name.", wait: "click", verify: text.name, next: "done" },
      { id: "done", kind: "complete", text: "Your name was saved." },
    ],
  };
  const record = await request("POST", workflows, 201, { applicationId: app.id, definition });
  const draft = await request("POST", workflows, 201, { applicationId: app.id, definition: { ...definition, title: `${name} draft only` } });
  const review = await request("POST", `${workflows}/${record.id}/review`, 200, {});
  assert.equal(review.ok, true);
  await request("POST", `${workflows}/${record.id}/status`, 200, { status: "published", expectedRevision: review.revision });
  consumer.configure(app.id, app.runtimeKey);
  return { ...app, title: definition.title, guide: record.id, draft: draft.id };
}
