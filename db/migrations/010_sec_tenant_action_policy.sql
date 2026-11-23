-- 010: Per-tenant action disabling policy (US2, T048).
-- Owner: dap_owner (applied by the migration runner as dap_owner).
-- Grants: SELECT, INSERT, UPDATE for dap_app only (no DELETE, no TRUNCATE).
-- RLS: enabled AND forced. The policy compares tenant_id to
-- NULLIF(current_setting('app.tenant_id', true), '')::uuid so an unset tenant
-- setting yields zero rows instead of a 22P02 cast error (T026 finding).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'sec_tenant_action_policy'
  ) THEN
    CREATE TABLE public.sec_tenant_action_policy (
      tenant_id uuid NOT NULL,
      action_id text NOT NULL,
      disabled boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text NOT NULL,
      PRIMARY KEY (tenant_id, action_id)
    );
  END IF;

  ALTER TABLE public.sec_tenant_action_policy ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.sec_tenant_action_policy FORCE ROW LEVEL SECURITY;

  DROP POLICY IF EXISTS tenant_isolation ON public.sec_tenant_action_policy;
  CREATE POLICY tenant_isolation ON public.sec_tenant_action_policy
    USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
END
$$;

REVOKE ALL ON TABLE public.sec_tenant_action_policy FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE public.sec_tenant_action_policy TO dap_app;
