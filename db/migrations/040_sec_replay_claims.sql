-- T112: durable replay claims. Only dap_owner may apply/own this migration.
DO $$
BEGIN
  IF current_user <> 'dap_owner' THEN RAISE EXCEPTION 'Replay migration requires dap_owner'; END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.sec_replay_claims (
  tenant_id uuid NOT NULL,
  namespace text NOT NULL CHECK (namespace <> ''),
  claim_key text NOT NULL CHECK (octet_length(claim_key) BETWEEN 1 AND 1024),
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, namespace, claim_key),
  CHECK (expires_at > claimed_at)
);
DO $$
BEGIN
  IF (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.sec_replay_claims'::regclass) <> 'dap_owner' THEN
    RAISE EXCEPTION 'Replay table must be owned by dap_owner';
  END IF;
END $$;
ALTER TABLE public.sec_replay_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sec_replay_claims FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.sec_replay_claims;
CREATE POLICY tenant_isolation ON public.sec_replay_claims
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
REVOKE ALL ON public.sec_replay_claims FROM PUBLIC, dap_app;
-- DELETE is required for atomic expired-key reclamation; UPDATE/TRUNCATE are not needed.
GRANT SELECT, INSERT, DELETE ON public.sec_replay_claims TO dap_app;
CREATE INDEX IF NOT EXISTS sec_replay_claims_expiry ON public.sec_replay_claims (tenant_id, expires_at);
