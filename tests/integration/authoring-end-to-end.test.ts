// @vitest-environment jsdom
/** Real browser UI/runtime, Fastify inject, Policy Gateway and PostgreSQL. No browser code or walkthrough state is mocked. */
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { expect, it, vi } from "vitest";
import { boot } from "../../apps/reference-web/src/browser.js";
import { copy } from "../../apps/reference-web/src/copy.js";
import { setEditSession, writeRole } from "../../apps/reference-web/src/admin/session.js";
import type { FetchLike } from "../../apps/reference-web/src/help/client.js";
import { composeReferenceHost } from "../../apps/reference-host/src/index.js";
import { parseDevSessions } from "../../apps/reference-host/src/dev-auth/index.js";
import { createAuthoringExtension } from "../../apps/reference-host/src/authoring/capabilities.js";
import { createPostgresWalkthroughStore } from "../../apps/reference-host/src/authoring/postgres-store.js";
import { createDemoPrincipalResolver } from "../../apps/reference-host/src/authoring/principal.js";
import { registerAuthoringRoutes } from "../../apps/reference-host/src/authoring/routes.js";
import { withTenant } from "../../apps/reference-host/src/authoring/tenant-tx.js";
import { createApplicationExtension } from "../../apps/reference-host/src/studio/application-capabilities.js";
import { registerApplicationRoutes } from "../../apps/reference-host/src/studio/application-routes.js";
import { createPostgresApplicationStore } from "../../apps/reference-host/src/studio/postgres-application-store.js";
import { createRegistryCatalog } from "../../apps/reference-host/src/studio/registries.js";
import { createProposalStore } from "../../apps/reference-host/src/http/proposal-store.js";
import { createGuidanceTransport } from "../../apps/reference-host/src/http/transport.js";
import { demoCatalogView } from "../../apps/reference-host/src/guidance/walkthrough-summaries.js";
import { openStatePools } from "../../packages/security/src/state/conformance/state-pg-fixtures.js";

const ADMIN = "/api/admin/walkthroughs";
const EVENTS = "/api/walkthrough-events";
const TITLE = "Profile and settings tour";
const CANARY = "Private canary not sent 41983";
const c = copy.admin;
const overlay = (part: string) => document.querySelector<HTMLElement>(`[data-ai-overlay="${part}"]`);
const dialogue = () => document.querySelector<HTMLDialogElement>("dialog[open]");
function button(root: ParentNode, name: string) {
  const result = Array.from(root.querySelectorAll("button")).find(el => (el.getAttribute("aria-label") ?? el.textContent) === name);
  if (!result) throw new Error(`Missing button: ${name}`);
  return result;
}
function fill(root: ParentNode, id: string, value: string, event = "input") {
  const field = root.querySelector<HTMLInputElement>(`[id="${id}"]`);
  if (!field) throw new Error(`Missing field: ${id}`);
  field.value = value; field.dispatchEvent(new Event(event, { bubbles: true }));
}

it("authors, previews, publishes and measures two real runs through the Gateway and PostgreSQL", async () => {
  const tenant = randomUUID();
  const env = process.env;
  const tokens = { user: randomUUID(), maintainer: randomUUID() };
  const sessions = (["user", "maintainer"] as const).map(role => ({
    token: tokens[role], userId: role, tenantId: tenant, sessionId: randomUUID(),
    validUntil: new Date(Date.now() + 3_600_000).toISOString(), permissions: role === "maintainer" ? ["perm.walkthrough.maintain"] : [],
  }));
  const pools = await openStatePools(Pool);
  const store = createPostgresWalkthroughStore(pools.app);
  const applications = createPostgresApplicationStore(pools.app);
  const catalog = createRegistryCatalog();
  const { extension, trusted } = createAuthoringExtension({ store, applications, catalog });
  const studio = createApplicationExtension({ store: applications, catalog });
  const { host } = await composeReferenceHost({ NODE_ENV: "test", DAP_ALLOW_DEV_AUTH: "1", DAP_DATABASE_URL: env.DAP_DATABASE_URL,
    DAP_ENABLED_ACTIONS: "saveWalkthroughDraft,setWalkthroughStatus,saveStudioApplication,setStudioApplicationEnabled", DEV_SESSIONS: JSON.stringify(sessions),
  }, { extensions: [extension, studio.extension] });
  const transport = createGuidanceTransport({ ask: async () => ({ kind: "clarify", message: "Unused in this proof." }), catalog: demoCatalogView,
    resolveSession: async () => null, proposals: createProposalStore({ now: Date.now, newId: randomUUID }) });
  const resolvePrincipal = createDemoPrincipalResolver({
    sessions: parseDevSessions(JSON.stringify(sessions)), userToken: tokens.user, maintainerToken: tokens.maintainer, openSession: token => host.openSession(token),
  });
  registerAuthoringRoutes(transport, { store, applications, catalog, resolvePrincipal });
  registerApplicationRoutes(transport, { applications, catalog, resolvePrincipal });
  const eventRows = () => withTenant(pools.owner, tenant, async client => (await client.query(
    "SELECT walkthrough_id, run_id, event_type FROM public.walkthrough_events ORDER BY event_type, run_id")).rows);
  const requests: { method: string; path: string; body: string; status: number }[] = [];
  const fetch: FetchLike = async (path, init) => {
    const body = typeof init.body === "string" ? init.body : "";
    const method = init.method as "GET" | "POST" | "PUT";
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const reply = await transport.inject({ method, url: path, headers, ...(body ? { payload: body } : {}) });
    requests.push({ method, path, body, status: reply.statusCode });
    return new Response(reply.body === "" ? null : reply.body, { status: reply.statusCode });
  };
  const inject = (method: "GET" | "POST" | "PUT", url: string, body?: unknown, role = "user") => transport.inject({ method, url,
    headers: { "x-demo-role": role, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
  const root = document.createElement("div"); document.body.append(root);
  window.history.replaceState(null, "", "#/walkthroughs");
  writeRole(window, "maintainer");
  let app: Awaited<ReturnType<typeof boot>> | undefined;
  try {
    const enrolled = await inject("POST", "/api/admin/applications", {
      name: "Reference application", origin: "http://127.0.0.1:5184", allowedOrigins: ["http://127.0.0.1:5184"], environment: "development", registryId: "reference",
    }, "maintainer");
    expect(enrolled.statusCode).toBe(201);
    const appId = enrolled.json<{ id: string }>().id;
    app = await boot(root, { fetch, demoRoleEnabled: true, trustedEventsOnly: false });
    const navigate = (route: "dashboard" | "analytics" | "walkthroughs") => app?.current()?.router.navigate(route);
    const switched = async (role: "user" | "maintainer") => {
      fill(root, "demo-role", role, "change");
      await vi.waitFor(() => expect(root.querySelector<HTMLSelectElement>('[id="demo-role"]')?.value).toBe(role));
    };

    await vi.waitFor(() => button(root, c.newGuide));
    button(root, c.newGuide).click();
    await vi.waitFor(() => expect(root.querySelector('[id="editor-title"]')).not.toBeNull());
    expect(root.querySelector<HTMLSelectElement>("#editor-application")?.value).toBe(appId);
    for (const action of [c.save, c.preview, c.publish]) {
      expect(button(root, action).disabled).toBe(true);
      button(root, action).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
    expect(root.textContent).toContain("Step 1: Select a target.");
    expect(requests.filter(request => request.body)).toEqual([]);
    expect(await store.list(tenant)).toEqual([]);

    fill(root, "editor-title", TITLE); fill(root, "editor-description", "Read two demo pages.");
    fill(root, "editor-completion", "Both pages explored.");
    fill(root, "editor-target", "profile.nameInput", "change"); fill(root, "editor-text", "Find the display name.");
    button(root, c.add).click();
    fill(root, "editor-target", "settings.securityPanel", "change"); fill(root, "editor-text", "Find the Security panel.");
    button(root, c.save).click();
    await vi.waitFor(() => expect(root.querySelector("[role=status]")?.textContent).toBe(c.saved));
    const [draft] = await store.list(tenant);
    expect(draft).toMatchObject({ title: TITLE, status: "draft", stepCount: 2 });
    const id = draft!.id;
    const create = requests.find(request => request.method === "POST" && request.path === ADMIN && request.status === 201)!;
    const createdBody = JSON.parse(create.body);
    expect(Object.keys(createdBody).sort()).toEqual(["applicationId", "definition"]);
    expect(createdBody.applicationId).toBe(appId);
    expect(Object.keys(createdBody.definition)).toEqual(["title", "description", "start", "steps"]);
    expect(trusted.executorCalls()).toBe(1);

    const description = "Read the profile and settings pages.";
    fill(root, "editor-description", description);
    button(root, c.save).click();
    await vi.waitFor(() => expect(requests.some(request => request.method === "PUT" && request.path === `${ADMIN}/${id}` && request.status === 200)).toBe(true));
    const update = requests.find(request => request.method === "PUT" && request.path === `${ADMIN}/${id}`)!;
    const updatedBody = JSON.parse(update.body);
    expect(updatedBody).toEqual({ applicationId: appId, definition: { ...createdBody.definition, id, description } });
    await vi.waitFor(() => expect(root.querySelector("[role=status]")?.textContent).toBe(c.saved));

    button(root, c.preview).click();
    await vi.waitFor(() => expect(overlay("ring")).not.toBeNull());
    expect(app.current()?.runtime.getState().walkthroughId).toBe("wt-preview");
    overlay("cancel")!.click();
    button(dialogue()!, copy.result.close).click();
    await vi.waitFor(() => expect(button(root, c.publish).disabled).toBe(false));
    expect((await store.get(tenant, id))?.status).toBe("draft");
    expect(requests.filter(request => request.path === EVENTS)).toEqual([]);
    expect(await eventRows()).toEqual([]);

    const beforeRefused = trusted.executorCalls();
    for (const [method, path, body] of [
      ["GET", ADMIN], ["GET", `${ADMIN}/${id}`], ["GET", "/api/admin/analytics"], ["POST", ADMIN, { applicationId: appId, definition: {} }],
      ["PUT", `${ADMIN}/${id}`, { applicationId: appId, definition: {} }], ["POST", `${ADMIN}/${id}/status`, { status: "published" }],
    ] as const) {
      const response = await inject(method, path, body);
      expect(response.statusCode, path).toBe(403);
      expect(response.json()).toEqual({ kind: "forbidden", message: "You do not have access to that." });
    }
    expect(trusted.executorCalls()).toBe(beforeRefused);
    expect((await store.get(tenant, id))?.status).toBe("draft");
    const refusals = await Promise.all([id, "wt-preview", "wt-ffffffffffff"].map(walkthroughId => inject("POST", EVENTS, { walkthroughId, runId: randomUUID(), event: "started" })));
    expect(refusals.map(response => response.statusCode)).toEqual([400, 400, 400]);
    expect(new Set(refusals.map(response => response.body)).size).toBe(1);

    await switched("user"); navigate("dashboard");
    await vi.waitFor(() => expect(root.querySelectorAll(".guide-list button")).toHaveLength(3));
    expect(root.querySelector(".guide-list")?.textContent).not.toContain(TITLE);
    await switched("maintainer"); navigate("walkthroughs");
    await vi.waitFor(() => button(root, `Publish: ${TITLE}`));
    button(root, `Publish: ${TITLE}`).click();
    await vi.waitFor(() => expect(dialogue()).not.toBeNull());
    button(dialogue()!, c.publish).click();
    await vi.waitFor(() => button(root, `Unpublish: ${TITLE}`));

    await switched("user"); navigate("dashboard");
    const launch = () => button(root, `Start guide: ${TITLE}`).click();
    await vi.waitFor(() => button(root, `Start guide: ${TITLE}`)); launch();
    await vi.waitFor(() => expect(overlay("title")?.textContent).toBe(copy.semantic["profile.nameInput"].label));
    fill(root, "name", CANARY);
    overlay("ack")!.click();
    await vi.waitFor(() => expect(overlay("title")?.textContent).toBe(copy.semantic["settings.securityPanel"].label));
    overlay("ack")!.click();
    await vi.waitFor(() => expect(dialogue()?.textContent).toContain("Both pages explored."));
    button(dialogue()!, copy.result.done).click();
    navigate("dashboard"); await vi.waitFor(() => button(root, `Start guide: ${TITLE}`)); launch();
    await vi.waitFor(() => expect(overlay("ring")).not.toBeNull());
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(dialogue()?.textContent).toContain(copy.result.cancelled);
    button(dialogue()!, copy.result.close).click();
    await vi.waitFor(async () => expect(await eventRows()).toHaveLength(4));

    const stored = await eventRows();
    expect(stored.map(row => row.event_type)).toEqual(["cancelled", "completed", "started", "started"]);
    expect(new Set(stored.map(row => row.walkthrough_id))).toEqual(new Set([id]));
    expect(new Set(stored.map(row => row.run_id)).size).toBe(2);
    const orphanId = randomUUID();
    const orphan = await inject("POST", EVENTS, { walkthroughId: id, runId: orphanId, event: "completed" });
    expect(orphan.statusCode).toBe(204);
    expect(await eventRows()).toHaveLength(4);
    // A directly inserted orphan still cannot change the displayed report.
    await withTenant(pools.app, tenant, client => client.query(
      "INSERT INTO public.walkthrough_events (tenant_id,walkthrough_id,run_id,event_type) VALUES ($1,$2,$3,'completed')",
      [tenant, id, orphanId]));
    expect(await eventRows()).toHaveLength(5);

    await switched("maintainer"); navigate("analytics");
    await vi.waitFor(() => expect([...root.querySelectorAll(".usage-metrics p")].map(el => el.textContent)).toEqual(["2", "1", "1", "50%"]));
    const guide = root.querySelector("tbody tr");
    expect(guide?.querySelector("th")?.textContent).toBe(TITLE);
    expect([...(guide?.querySelectorAll("td") ?? [])].map(el => el.textContent)).toEqual(["2", "1", "1", "50%"]);
    expect(root.textContent).not.toContain(CANARY);
    expect(JSON.stringify({ requests, stored: await eventRows() })).not.toContain(CANARY);
    expect(requests.filter(request => request.path === EVENTS).map(request => Object.keys(JSON.parse(request.body)).sort()))
      .toEqual(Array(4).fill(["event", "runId", "walkthroughId"]));

    navigate("walkthroughs"); await vi.waitFor(() => button(root, `Unpublish: ${TITLE}`));
    button(root, `Unpublish: ${TITLE}`).click();
    await vi.waitFor(() => button(root, `Edit: ${TITLE}`));
    await switched("user"); navigate("dashboard");
    await vi.waitFor(() => expect(root.querySelectorAll(".guide-list button")).toHaveLength(3));
    expect(root.querySelector(".guide-list")?.textContent).not.toContain(TITLE);
  } finally {
    app?.destroy(); setEditSession(); sessionStorage.clear(); root.remove();
    await Promise.all([transport.close(), host.close(), pools.app.end(), pools.owner.end()]);
  }
}, 20_000);
