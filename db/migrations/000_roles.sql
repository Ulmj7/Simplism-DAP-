-- Bootstrap runs this once as the local cluster administrator; subsequent runs
-- as dap_owner validate the existing roles without requiring CREATEROLE.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dap_owner') THEN
    CREATE ROLE dap_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dap_app') THEN
    CREATE ROLE dap_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  IF EXISTS (
    SELECT FROM pg_roles
    WHERE rolname IN ('dap_owner', 'dap_app')
      AND (NOT rolcanlogin OR rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication)
  ) OR pg_has_role('dap_app', 'dap_owner', 'MEMBER') THEN
    RAISE EXCEPTION 'dap roles must be unprivileged logins; dap_app must not be a member of dap_owner';
  END IF;
END
$$;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM dap_app;
GRANT USAGE ON SCHEMA public TO dap_app;
-- Application table grants belong to their individual migrations (audit is append-only).
