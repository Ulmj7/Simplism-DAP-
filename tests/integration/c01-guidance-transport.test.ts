/**
 * C01, the browser transport through the REAL Gateway and PostgreSQL (fake model): POST /api/guidance mints a proposal and starts nothing; POST
 * /api/guidance/start redeems it through submitWalkthroughStart -> AiSession.submit -> Policy Gateway -> executor -> recording starter, and replies with the
 * id the executor received. A session without perm.guidance.start is refused with a safe message.
 *
 * NEEDS the PostgreSQL of deploy/compose.yaml (DAP_DATABASE_URL), like tests/integration/guidance-start.test.ts; uses a tenant of its own per run.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { composeReferenceHost } from "../../apps/reference-host/src/index.js";
import type { ReferenceHost } from "../../apps/reference-host/src/index.js";
import { createGuidanceHost } from "../../apps/reference-host/src/guidance/compose-guidance.js";
import { demoCatalogView } from "../../apps/reference-host/src/guidance/walkthrough-summaries.js";
import { createApprovalRecorder, createGatewayStart } from "../../apps/reference-host/src/http/approved-start.js";
import { createProposalStore } from "../../apps/reference-host/src/http/proposal-store.js";
import { TRANSPORT_MESSAGES, createGuidanceTransport } from "../../apps/reference-host/src/http/transport.js";
import { withTenant } from "../../packages/security/src/state/postgres/tenant-tx.js";
import { openStatePools } from "../../packages/security/src/state/conformance/state-pg-fixtures.js";

let owner: Pool; let app: Pool;
beforeAll(async () => { ({ app, owner } = await openStatePools(Pool)); });
afterAll(async () => { await Promise.all([app?.end(), owner?.end()]); });
const hosts: ReferenceHost[] = [];
const transports: { close(): Promise<unknown> }[] = [];
afterEach(async () => { await Promise.all([...transports.splice(0).map((transport) => transport.close()), ...hosts.splice(0).map((host) => host.close())]); });

const context = { route: "profile", elements: [{ id: "profile.displayName", role: "textbox", label: "Display name", description: "Your public name", privacy: "public", available: true }] };

async function start(who: "alice" | "bob") {
  const tenant = randomUUID();
  const token = `tok-${randomUUID()}`;
  const permissions = who === "alice" ? ["perm.guidance.start", "perm.demo.lookup"] : ["perm.demo.lookup"];
  const sessions = [{ token, userId: who, tenantId: tenant, sessionId: `s-${who}-${tenant.slice(0, 8)}`, validUntil: new Date(Date.now() + 3_600_000).toISOString(), permissions }];
  const env = { NODE_ENV: "test", DAP_ALLOW_DEV_AUTH: "1", DAP_DATABASE_URL: process.env.DAP_DATABASE_URL, DAP_ENABLED_ACTIONS: "demoLookup,startWalkthrough", DEV_SESSIONS: JSON.stringify(sessions), DAP_GUIDANCE_MODEL: "fake" };
  const recorder = createApprovalRecorder();
  const guidance = createGuidanceHost({ env, starter: recorder.starter });
  const { host } = await composeReferenceHost(env, { extensions: [guidance.extension] });
  hosts.push(host);
  const startPort = createGatewayStart({ openSession: () => host.openSession(token), recorder });
  const transport = createGuidanceTransport({
    ask: guidance.askGuidance,
    catalog: demoCatalogView,
    resolveSession: async () => ({ key: "demo", start: startPort }),
    proposals: createProposalStore({ now: () => Date.now(), newId: () => randomBytes(32).toString("base64url") }),
  });
  transports.push(transport);
  const post = async (url: string, payload: unknown) => {
    const res = await transport.inject({ method: "POST", url, headers: { "content-type": "application/json" }, payload: JSON.stringify(payload) });
    return { status: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown>, raw: res.body };
  };
  const rows = async () => (await withTenant(owner, tenant, (client) => client.query(
    "SELECT event_type, action_id, outcome, risk, params_view, execution_result FROM public.sec_audit_events ORDER BY seq",
  ))).rows;
  return { post, rows, receivedParams: guidance.trusted.receivedParams };
}

describe("C01 transport through the real Gateway (PostgreSQL)", () => {
  it("proposal starts nothing; /start with perm.guidance.start returns the approved id once", async () => {
    const t = await start("alice");
    const proposed = await t.post("/api/guidance", { query: "How do I change my profile name?", semanticContext: context });
    expect(proposed.body.kind).toBe("walkthrough");
    expect(proposed.raw).not.toContain("profileUpdate");
    expect(await t.rows()).toEqual([]);
    expect(t.receivedParams()).toEqual([]);
    const proposalId = proposed.body.proposalId as string;
    expect((await t.post("/api/guidance/start", { proposalId })).body).toEqual({ kind: "start", walkthroughId: "profileUpdate" });
    const trail = await t.rows();
    expect(trail.map(row => row.event_type)).toEqual(["AI_ACTION_PROPOSED", "AI_ACTION_ALLOWED", "AI_ACTION_EXECUTED"]);
    expect(trail.map(row => row.action_id)).toEqual(["startWalkthrough", "startWalkthrough", "startWalkthrough"]);
    expect(trail[1]).toMatchObject({ outcome: "ALLOWED", risk: "LOW", params_view: { "/walkthroughId": "profileUpdate" } });
    expect(trail[2]).toMatchObject({ execution_result: "success" });
    expect(t.receivedParams()).toEqual([{ walkthroughId: "profileUpdate" }]);
    expect((await t.post("/api/guidance/start", { proposalId })).body).toEqual({ kind: "unsupported", message: TRANSPORT_MESSAGES.proposalGone });
    expect(await t.rows()).toEqual(trail);
    expect(t.receivedParams()).toEqual([{ walkthroughId: "profileUpdate" }]);
  });

  it("a session without perm.guidance.start is refused with a safe message", async () => {
    const t = await start("bob");
    const proposed = await t.post("/api/guidance", { query: "How do I change my profile name?", semanticContext: context });
    const res = await t.post("/api/guidance/start", { proposalId: proposed.body.proposalId });
    expect(res.body).toEqual({ kind: "unsupported", message: TRANSPORT_MESSAGES.startRefused });
    const trail = await t.rows();
    expect(trail.map(row => row.event_type)).toEqual(["AI_ACTION_PROPOSED", "AI_ACTION_DENIED"]);
    expect(trail[1]).toMatchObject({ outcome: "UNAUTHORIZED" });
    expect(t.receivedParams()).toEqual([]);
    for (const word of ["perm.", "DENIED", "risk", "reason", "startWalkthrough"]) expect(res.raw).not.toContain(word);
  });
});
