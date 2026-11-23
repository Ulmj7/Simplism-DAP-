-- T118: maintenance path for expired replay claims and rate counters/blocks.
-- The tables use FORCE ROW LEVEL SECURITY, so even the owner sees no row without a tenant. The scheduled
-- purge connects as dap_owner and gets exactly one extra capability: it may SELECT, lock (FOR UPDATE
-- SKIP LOCKED) and DELETE rows that are already expired, across tenants. dap_app is not covered by any
-- of these policies. No policy lets anyone change a row (the UPDATE policy admits locking only: its
-- WITH CHECK is false), read a live row without its tenant, or insert without its tenant.
DO $$
BEGIN
  IF current_user <> 'dap_owner' THEN RAISE EXCEPTION 'Purge migration requires dap_owner'; END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid IN ('public.sec_replay_claims'::regclass, 'public.sec_rate_counters'::regclass, 'public.sec_rate_blocks'::regclass)
      AND (pg_get_userbyid(relowner) <> 'dap_owner' OR NOT relforcerowsecurity)
  ) THEN
    RAISE EXCEPTION 'State tables must be owned by dap_owner with forced row level security';
  END IF;
END $$;

DROP POLICY IF EXISTS purge_expired_select ON public.sec_replay_claims;
DROP POLICY IF EXISTS purge_expired_lock ON public.sec_replay_claims;
DROP POLICY IF EXISTS purge_expired_delete ON public.sec_replay_claims;
CREATE POLICY purge_expired_select ON public.sec_replay_claims FOR SELECT TO dap_owner USING (expires_at <= now());
CREATE POLICY purge_expired_lock ON public.sec_replay_claims FOR UPDATE TO dap_owner USING (expires_at <= now()) WITH CHECK (false);
CREATE POLICY purge_expired_delete ON public.sec_replay_claims FOR DELETE TO dap_owner USING (expires_at <= now());

DROP POLICY IF EXISTS purge_expired_select ON public.sec_rate_counters;
DROP POLICY IF EXISTS purge_expired_lock ON public.sec_rate_counters;
DROP POLICY IF EXISTS purge_expired_delete ON public.sec_rate_counters;
CREATE POLICY purge_expired_select ON public.sec_rate_counters FOR SELECT TO dap_owner USING (expires_at <= now());
CREATE POLICY purge_expired_lock ON public.sec_rate_counters FOR UPDATE TO dap_owner USING (expires_at <= now()) WITH CHECK (false);
CREATE POLICY purge_expired_delete ON public.sec_rate_counters FOR DELETE TO dap_owner USING (expires_at <= now());

DROP POLICY IF EXISTS purge_expired_select ON public.sec_rate_blocks;
DROP POLICY IF EXISTS purge_expired_lock ON public.sec_rate_blocks;
DROP POLICY IF EXISTS purge_expired_delete ON public.sec_rate_blocks;
CREATE POLICY purge_expired_select ON public.sec_rate_blocks FOR SELECT TO dap_owner USING (expires_at <= now());
CREATE POLICY purge_expired_lock ON public.sec_rate_blocks FOR UPDATE TO dap_owner USING (expires_at <= now()) WITH CHECK (false);
CREATE POLICY purge_expired_delete ON public.sec_rate_blocks FOR DELETE TO dap_owner USING (expires_at <= now());

-- Serve the purge's oldest-first scan across tenants.
CREATE INDEX IF NOT EXISTS sec_replay_claims_purge ON public.sec_replay_claims (expires_at);
CREATE INDEX IF NOT EXISTS sec_rate_counters_purge ON public.sec_rate_counters (expires_at);
CREATE INDEX IF NOT EXISTS sec_rate_blocks_purge ON public.sec_rate_blocks (expires_at);
