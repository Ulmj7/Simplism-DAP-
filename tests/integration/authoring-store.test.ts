/**
 * T404 (Feature 004): the walkthrough store and the host-local tenant transaction helper on PostgreSQL (a FRESH database, as dap_app through the real pool).
 * Proves, for the helper: RLS isolation, the setting is transaction-local (it does not leak to the next use of the SAME pooled connection), rollback on error, and a
 * transaction the server rolled back is never reported as committed. For the store: draft insert/update, a published row is not updatable as a draft, publish
 * re-validates the STORED definition inside the transaction, unpublish restores editability, cross-tenant isolation, the cap of 50, ids that are built-in or malformed
 * are refused, and the tenant and the actor come only from the trusted scope.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createPostgresPool } from "../../packages/security/src/index.js";
import { createPostgresWalkthroughStore } from "../../apps/reference-host/src/authoring/postgres-store.js";
import { MAX_PUBLISHED_PER_TENANT } from "../../apps/reference-host/src/authoring/store.js";
import { withTenant } from "../../apps/reference-host/src/authoring/tenant-tx.js";
import { generateWalkthroughId } from "../../apps/reference-host/src/authoring/ids.js";
import { validateDefinition } from "../../apps/reference-host/src/authoring/validate.js";
import type { WalkthroughDef } from "../../packages/walkthrough/src/authoring/index.js";
import { createPostgresApplicationStore } from "../../apps/reference-host/src/studio/postgres-application-store.js";
import { generateApplicationId } from "../../apps/reference-host/src/studio/applications.js";
import { openStatePools } from "../../packages/security/src/state/conformance/state-pg-fixtures.js";

let owner: Pool; let probe: Pool;
const pools: { end(): Promise<void> }[] = [];
beforeAll(async () => { ({ app: probe, owner } = await openStatePools(Pool)); });
afterAll(async () => { await Promise.all([probe?.end(), owner?.end(), ...pools.map((pool) => pool.end())]); });
const url = (): string => process.env.DAP_DATABASE_URL!;
const newPool = (max = 4) => { const pool = createPostgresPool(url(), { max }); pools.push(pool); return pool; };

const def = (id: string, title = "Save your name"): WalkthroughDef => {
  const result = validateDefinition({ id, title, description: "Change your display name and save it.", start: "n1", steps: [{ id: "n1", kind: "navigate", route: "profile", next: "s1" }, { id: "s1", kind: "guide", target: "profile.saveButton", text: "Press Save.", wait: "click", next: "done" }, { id: "done", kind: "complete", text: "Done." }] });
  if (!result.ok) throw new Error("fixture");
  return result.definition;
};
const scope = (tenantId: string, actor = "alice") => ({ tenantId, actor });
/** Studio V1A: every draft belongs to an enrolled application of its own tenant. `appFor` enrols one (once per tenant) and returns its id; `APP_ANY` is for calls refused before the database. */
const APP_ANY = "app-000000000000";
const applicationOf = new Map<string, string>();
const appFor = async (tenantId: string): Promise<string> => {
  const known = applicationOf.get(tenantId);
  if (known !== undefined) return known;
  const id = generateApplicationId();
  const outcome = await createPostgresApplicationStore(newPool(1)).save({ tenantId, actor: "seed" }, id,
    { name: "Reference application", origin: "http://localhost:5184", allowedOrigins: ["http://localhost:5184"], environment: "development", registryId: "reference" });
  if (outcome !== "created") throw new Error("fixture");
  applicationOf.set(tenantId, id);
  return id;
};
const alwaysValid = () => true;

describe("withTenant (host-local): the semantics of the Feature 001 helper", () => {
  it("RLS isolates tenants: rows written in A are invisible in B, and without a tenant setting the table is empty", async () => {
    const pool = newPool(2);
    const [a, b] = [randomUUID(), randomUUID()];
    const id = generateWalkthroughId();
    await withTenant(pool, a, (c) => c.query("INSERT INTO public.walkthrough_definitions (tenant_id, walkthrough_id, status, definition, created_by, updated_by) VALUES ($1::uuid,$2,'draft','{}'::jsonb,'x','x')", [a, id]));
    expect((await withTenant(pool, a, (c) => c.query("SELECT 1 FROM public.walkthrough_definitions"))).rows).toHaveLength(1);
    expect((await withTenant(pool, b, (c) => c.query("SELECT 1 FROM public.walkthrough_definitions"))).rows).toHaveLength(0);
    expect((await pool.query("SELECT 1 FROM public.walkthrough_definitions")).rows).toHaveLength(0);
  });
  it("the tenant setting is transaction-local: the next use of the SAME pooled connection sees none", async () => {
    const pool = newPool(1); // one connection: every use below is the same session
    const tenant = randomUUID();
    expect((await withTenant(pool, tenant, (c) => c.query("SELECT current_setting('app.tenant_id', true) AS t"))).rows).toEqual([{ t: tenant }]);
    const after = await pool.query("SELECT current_setting('app.tenant_id', true) AS t");
    expect(["", null]).toContain(after.rows[0]!.t);
    expect((await pool.query("SELECT 1 FROM public.walkthrough_definitions")).rows).toHaveLength(0);
    // and a second tenant on the same connection does not inherit the first
    const other = randomUUID();
    expect((await withTenant(pool, other, (c) => c.query("SELECT current_setting('app.tenant_id', true) AS t"))).rows).toEqual([{ t: other }]);
  });
  it("rolls back on error: nothing the body wrote survives, and the connection is reusable", async () => {
    const pool = newPool(1);
    const tenant = randomUUID();
    const id = generateWalkthroughId();
    await expect(withTenant(pool, tenant, async (c) => {
      await c.query("INSERT INTO public.walkthrough_definitions (tenant_id, walkthrough_id, status, definition, created_by, updated_by) VALUES ($1::uuid,$2,'draft','{}'::jsonb,'x','x')", [tenant, id]);
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect((await withTenant(pool, tenant, (c) => c.query("SELECT 1 FROM public.walkthrough_definitions"))).rows).toHaveLength(0);
  });
  it("a transaction the server aborted (a failed statement caught by the body) is never reported as committed", async () => {
    const pool = newPool(1);
    const tenant = randomUUID();
    const id = generateWalkthroughId();
    await expect(withTenant(pool, tenant, async (c) => {
      await c.query("INSERT INTO public.walkthrough_definitions (tenant_id, walkthrough_id, status, definition, created_by, updated_by) VALUES ($1::uuid,$2,'draft','{}'::jsonb,'x','x')", [tenant, id]);
      await c.query("SELECT 1/0").catch(() => undefined); // aborts the transaction; the body "recovers"
      return "looks fine";
    })).rejects.toThrow(/rolled back instead of committed/);
    expect((await withTenant(pool, tenant, (c) => c.query("SELECT 1 FROM public.walkthrough_definitions"))).rows).toHaveLength(0);
  });
  it("a body cannot write another tenant's row even by naming its id (the policy's WITH CHECK refuses it)", async () => {
    const pool = newPool(2);
    const [a, b] = [randomUUID(), randomUUID()];
    await expect(withTenant(pool, a, (c) => c.query("INSERT INTO public.walkthrough_definitions (tenant_id, walkthrough_id, status, definition, created_by, updated_by) VALUES ($1::uuid,$2,'draft','{}'::jsonb,'x','x')", [b, generateWalkthroughId()]))).rejects.toThrow(/row-level security/);
  });
});

describe("the store", () => {
  const store = () => createPostgresWalkthroughStore(newPool());

  it("inserts a draft, reads it back, and lists it with a summary (title, description, status, step count)", async () => {
    const s = store(); const tenant = randomUUID(); const id = generateWalkthroughId();
    expect(await s.saveDraft(scope(tenant), id, def(id), await appFor(tenant))).toBe("created");
    const stored = await s.get(tenant, id);
    expect(stored).toMatchObject({ id, status: "draft", definition: def(id) });
    expect(await s.list(tenant)).toEqual([expect.objectContaining({ id, title: "Save your name", description: "Change your display name and save it.", status: "draft", stepCount: 1 })]);
    expect(await s.listPublished(tenant)).toEqual([]);
  });
  it("counts only guide steps in a multi-page walkthrough summary", async () => {
    const s = store(); const tenant = randomUUID(); const id = generateWalkthroughId();
    const result = validateDefinition({ ...def(id), steps: [
      { id: "n1", kind: "navigate", route: "profile", next: "s1" },
      { id: "s1", kind: "guide", target: "profile.nameInput", text: "Read the name field.", wait: "ack", next: "n2" },
      { id: "n2", kind: "navigate", route: "settings", next: "s2" },
      { id: "s2", kind: "guide", target: "settings.securityPanel", text: "Read security settings.", wait: "ack", next: "done" },
      { id: "done", kind: "complete", text: "Done." },
    ] });
    if (!result.ok) throw new Error("fixture");
    expect(await s.saveDraft(scope(tenant), id, result.definition, await appFor(tenant))).toBe("created");
    expect(await s.list(tenant)).toEqual([expect.objectContaining({ stepCount: 2 })]);
  });
  it("updates a draft in place (same id), recording who updated it, and keeps who created it", async () => {
    const s = store(); const tenant = randomUUID(); const id = generateWalkthroughId();
    await s.saveDraft(scope(tenant, "alice"), id, def(id, "First"), await appFor(tenant));
    expect(await s.saveDraft(scope(tenant, "bob"), id, def(id, "Second"), await appFor(tenant))).toBe("updated");
    expect((await s.get(tenant, id))?.definition).toMatchObject({ title: "Second" });
    expect(await s.list(tenant)).toHaveLength(1);
    const stored = await withTenant(newPool(1), tenant, (c) => c.query("SELECT created_by, updated_by FROM public.walkthrough_definitions"));
    expect(stored.rows).toEqual([{ created_by: "alice", updated_by: "bob" }]);
  });
  it("a PUBLISHED guide cannot be saved over as a draft (nothing changes), and unpublishing restores editability", async () => {
    const s = store(); const tenant = randomUUID(); const id = generateWalkthroughId();
    await s.saveDraft(scope(tenant), id, def(id, "Original"), await appFor(tenant));
    expect(await s.setStatus(scope(tenant), id, "published", alwaysValid)).toBe("changed");
    expect(await s.saveDraft(scope(tenant), id, def(id, "Overwrite attempt"), await appFor(tenant))).toBe("not_a_draft");
    expect((await s.get(tenant, id))).toMatchObject({ status: "published", definition: { title: "Original" } });
    expect(await s.setStatus(scope(tenant), id, "draft", alwaysValid)).toBe("changed");
    expect(await s.saveDraft(scope(tenant), id, def(id, "Edited after unpublish"), await appFor(tenant))).toBe("updated");
    expect((await s.get(tenant, id))).toMatchObject({ status: "draft", definition: { title: "Edited after unpublish" } });
  });
  it("publish runs the validator on the STORED definition, inside the transaction: a stale or invalid stored definition is refused and the status does not change", async () => {
    const s = store(); const tenant = randomUUID(); const id = generateWalkthroughId();
    await s.saveDraft(scope(tenant), id, def(id), await appFor(tenant));
    const seen: unknown[] = [];
    expect(await s.setStatus(scope(tenant), id, "published", (stored) => { seen.push(stored); return false; })).toBe("invalid_definition");
    expect(seen).toEqual([def(id)]);
    expect((await s.get(tenant, id))?.status).toBe("draft");
    expect(await s.setStatus(scope(tenant), id, "published", () => { throw new Error("validator exploded"); })).toBe("invalid_definition");
    expect((await s.get(tenant, id))?.status).toBe("draft");
  });
  it("setStatus to the current status is a no-op ('unchanged'), and an unknown id is 'not_found' (it never creates a row)", async () => {
    const s = store(); const tenant = randomUUID(); const id = generateWalkthroughId();
    await s.saveDraft(scope(tenant), id, def(id), await appFor(tenant));
    expect(await s.setStatus(scope(tenant), id, "draft", alwaysValid)).toBe("unchanged");
    expect(await s.setStatus(scope(tenant), generateWalkthroughId(), "published", alwaysValid)).toBe("not_found");
    expect(await s.list(tenant)).toHaveLength(1);
  });
  it("tenants are isolated: another tenant cannot read, list, publish or overwrite a guide, and the same id may exist in both", async () => {
    const s = store(); const [a, b] = [randomUUID(), randomUUID()]; const id = generateWalkthroughId();
    await s.saveDraft(scope(a), id, def(id, "Tenant A"), await appFor(a));
    expect(await s.get(b, id)).toBeNull();
    expect(await s.list(b)).toEqual([]);
    expect(await s.setStatus(scope(b), id, "published", alwaysValid)).toBe("not_found");
    expect(await s.saveDraft(scope(b), id, def(id, "Tenant B"), await appFor(b))).toBe("created"); // B's own, separate row
    expect((await s.get(a, id))?.definition).toMatchObject({ title: "Tenant A" });
    expect((await s.get(b, id))?.definition).toMatchObject({ title: "Tenant B" });
    await s.setStatus(scope(a), id, "published", alwaysValid);
    expect((await s.listPublished(a)).map((g) => g.id)).toEqual([id]);
    expect(await s.listPublished(b)).toEqual([]);
  });
  it(`caps published guides at ${MAX_PUBLISHED_PER_TENANT} per tenant (the 51st is refused; unpublishing one makes room); drafts are not capped`, async () => {
    const s = store(); const tenant = randomUUID();
    const ids = Array.from({ length: MAX_PUBLISHED_PER_TENANT + 1 }, () => generateWalkthroughId());
    for (const id of ids) await s.saveDraft(scope(tenant), id, def(id), await appFor(tenant));
    for (const id of ids.slice(0, MAX_PUBLISHED_PER_TENANT)) expect(await s.setStatus(scope(tenant), id, "published", alwaysValid)).toBe("changed");
    const last = ids[MAX_PUBLISHED_PER_TENANT]!;
    expect(await s.setStatus(scope(tenant), last, "published", alwaysValid)).toBe("limit_reached");
    expect((await s.get(tenant, last))?.status).toBe("draft");
    expect(await s.listPublished(tenant)).toHaveLength(MAX_PUBLISHED_PER_TENANT);
    await s.setStatus(scope(tenant), ids[0]!, "draft", alwaysValid);
    expect(await s.setStatus(scope(tenant), last, "published", alwaysValid)).toBe("changed");
    // another tenant is unaffected by this tenant's cap
    const other = randomUUID(); const oid = generateWalkthroughId();
    await s.saveDraft(scope(other), oid, def(oid), await appFor(other));
    expect(await s.setStatus(scope(other), oid, "published", alwaysValid)).toBe("changed");
  }, 60_000);
  it("concurrent publishes cannot exceed the cap", async () => {
    const s = store(); const tenant = randomUUID();
    const ids = Array.from({ length: MAX_PUBLISHED_PER_TENANT + 4 }, () => generateWalkthroughId());
    for (const id of ids) await s.saveDraft(scope(tenant), id, def(id), await appFor(tenant));
    const outcomes = await Promise.all(ids.map((id) => s.setStatus(scope(tenant), id, "published", alwaysValid)));
    expect(outcomes.filter((o) => o === "changed")).toHaveLength(MAX_PUBLISHED_PER_TENANT);
    expect(outcomes.filter((o) => o === "limit_reached")).toHaveLength(4);
    expect(await s.listPublished(tenant)).toHaveLength(MAX_PUBLISHED_PER_TENANT);
  }, 60_000);
  it("lists newest update first; listPublished returns oldest first", async () => {
    const s = store(); const tenant = randomUUID();
    const [x, y] = [generateWalkthroughId(), generateWalkthroughId()];
    await s.saveDraft(scope(tenant), x, def(x, "X"), await appFor(tenant));
    await new Promise((resolve) => setTimeout(resolve, 15));
    await s.saveDraft(scope(tenant), y, def(y, "Y"), await appFor(tenant));
    expect((await s.list(tenant)).map((g) => g.title)).toEqual(["Y", "X"]);
    await s.setStatus(scope(tenant), y, "published", alwaysValid);
    await s.setStatus(scope(tenant), x, "published", alwaysValid);
    expect((await s.listPublished(tenant)).map((g) => g.id)).toEqual([x, y]);
  });

  it.each(["profileUpdate", "findSecuritySettings", "findTwoFactorSettings", "wt-preview", "wt-ABCDEF012345", "wt-0123456789a", "", "__proto__", "wt-0123456789ab\n", "../x"])(
    "refuses the id %j: saveDraft and setStatus say id_refused, get returns null, and nothing is stored", async (id) => {
      const s = store(); const tenant = randomUUID();
      expect(await s.saveDraft(scope(tenant), id, def("wt-0123456789ab"), await appFor(tenant))).toBe("id_refused");
      expect(await s.setStatus(scope(tenant), id, "published", alwaysValid)).toBe("id_refused");
      expect(await s.get(tenant, id)).toBeNull();
      expect(await s.list(tenant)).toEqual([]);
    });
  it("refuses a definition whose own id differs from the row id, and an oversize definition", async () => {
    const s = store(); const tenant = randomUUID(); const id = generateWalkthroughId();
    expect(await s.saveDraft(scope(tenant), id, def("wt-ffffffffffff"), await appFor(tenant))).toBe("id_refused");
    const huge = { ...def(id), description: "d".repeat(40_000) } as WalkthroughDef;
    expect(await s.saveDraft(scope(tenant), id, huge, await appFor(tenant))).toBe("too_large");
    expect(await s.list(tenant)).toEqual([]);
  });
  it("refuses an empty or oversize actor and a malformed tenant (nothing is written, nothing connects for a bad tenant)", async () => {
    const s = store(); const id = generateWalkthroughId();
    expect(await s.saveDraft({ tenantId: randomUUID(), actor: "" }, id, def(id), await appFor(randomUUID()))).toBe("id_refused");
    expect(await s.saveDraft({ tenantId: randomUUID(), actor: "a".repeat(257) }, id, def(id), await appFor(randomUUID()))).toBe("id_refused");
    await expect(s.saveDraft({ tenantId: "not-a-tenant", actor: "alice" }, id, def(id), APP_ANY)).rejects.toThrow(TypeError);
    await expect(s.list("' OR 1=1 --")).rejects.toThrow(TypeError);
  });
  it("takes tenant and actor ONLY from the scope: a definition that carries a tenantId or actor field changes nothing about who owns the row", async () => {
    const s = store(); const [real, claimed] = [randomUUID(), randomUUID()]; const id = generateWalkthroughId();
    const sneaky = { ...def(id), tenantId: claimed, createdBy: "mallory", updatedBy: "mallory" } as unknown as WalkthroughDef;
    await s.saveDraft(scope(real, "alice"), id, sneaky, await appFor(real));
    expect(await s.get(claimed, id)).toBeNull();
    const rows = (await withTenant(newPool(1), real, (c) => c.query("SELECT created_by, updated_by FROM public.walkthrough_definitions"))).rows;
    expect(rows).toEqual([{ created_by: "alice", updated_by: "alice" }]);
  });
  it("stores a guide the SAME for the same input (round trip keeps the definition exactly)", async () => {
    const s = store(); const tenant = randomUUID(); const id = generateWalkthroughId();
    await s.saveDraft(scope(tenant), id, def(id), await appFor(tenant));
    expect((await s.get(tenant, id))?.definition).toEqual(JSON.parse(JSON.stringify(def(id))));
  });
  it("a store whose pool is closed fails (rejects) rather than answering; no result is invented", async () => {
    const pool = createPostgresPool(url(), { max: 1 });
    const s = createPostgresWalkthroughStore(pool);
    await pool.end();
    await expect(s.list(randomUUID())).rejects.toThrow();
  });
});
