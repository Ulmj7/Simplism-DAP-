-- T112 hardening: inside ITS OWN tenant the application role holds DELETE on replay claims, and a single FOR ALL policy
-- let it delete a LIVE claim (a replay reset: the same callId would then be claimed again). Policies are permissive and
-- OR together, so the FOR ALL policy is replaced by one policy per command; DELETE alone also requires the row to have
-- really expired by the DATABASE clock (the adapter's own DELETE already says expires_at <= its clock; a test clock that
-- is not later than the real one passes this too). SELECT/INSERT keep the plain tenant form (NULLIF, not a bare cast).
DO $$
BEGIN
  IF current_user <> 'dap_owner' OR
    (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.sec_replay_claims'::regclass) <> 'dap_owner' THEN
    RAISE EXCEPTION 'Replay hardening requires dap_owner table ownership';
  END IF;
END $$;
ALTER TABLE public.sec_replay_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sec_replay_claims FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.sec_replay_claims;
DROP POLICY IF EXISTS tenant_select ON public.sec_replay_claims;
DROP POLICY IF EXISTS tenant_insert ON public.sec_replay_claims;
DROP POLICY IF EXISTS tenant_delete_expired ON public.sec_replay_claims;
CREATE POLICY tenant_select ON public.sec_replay_claims FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_insert ON public.sec_replay_claims FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_delete_expired ON public.sec_replay_claims FOR DELETE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid AND expires_at <= clock_timestamp());
