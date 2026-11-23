import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";

const connectionString = process.env.DAP_MIGRATE_DATABASE_URL;
if (!connectionString) {
  throw new Error("Set DAP_MIGRATE_DATABASE_URL to the dap_owner connection URL before migrating.");
}

const client = new pg.Client({ connectionString, connectionTimeoutMillis: 5_000 });
try {
  await client.connect();
  const { rows: [role] } = await client.query(
    "SELECT current_user AS name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
  );
  if (role?.name !== "dap_owner" || role.rolsuper || role.rolbypassrls) {
    throw new Error("Migrations must connect as dap_owner without SUPERUSER or BYPASSRLS.");
  }

  await client.query("BEGIN");
  // Serialize migration processes before creating or consulting the ledger.
  await client.query("SELECT pg_advisory_xact_lock(714_025_001)");
  await client.query(`
    CREATE TABLE IF NOT EXISTS dap_schema_migrations (
      name text PRIMARY KEY,
      sha256 text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
    REVOKE ALL ON TABLE dap_schema_migrations FROM PUBLIC, dap_app;
  `);

  const directory = new URL("./migrations/", import.meta.url);
  const files = (await readdir(directory))
    .filter((name) => /^\d+_[a-z0-9_]+\.sql$/i.test(name))
    .sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
  for (const name of files) {
    const sql = await readFile(new URL(name, directory), "utf8");
    const sha256 = createHash("sha256").update(sql).digest("hex");
    const { rows: [applied] } = await client.query(
      "SELECT sha256 FROM dap_schema_migrations WHERE name = $1", [name],
    );
    if (applied) {
      if (applied.sha256 !== sha256) throw new Error(`Applied migration was modified: ${name}`);
      continue;
    }
    await client.query(sql);
    await client.query("INSERT INTO dap_schema_migrations (name, sha256) VALUES ($1, $2)", [name, sha256]);
    console.log(`Applied ${name}`);
  }
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  throw error;
} finally {
  await client.end();
}
