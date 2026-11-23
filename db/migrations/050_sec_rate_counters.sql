-- T113: fixed-window counters and separate denial-throttle rows.
DO $$
BEGIN
  IF current_user <> 'dap_owner' THEN RAISE EXCEPTION 'Rate migration requires dap_owner'; END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.sec_rate_counters (
  tenant_id uuid NOT NULL,
  bucket_key text NOT NULL CHECK (octet_length(bucket_key) BETWEEN 1 AND 1024),
  window_start timestamptz NOT NULL,
  count bigint NOT NULL CHECK (count > 0),
  expires_at timestamptz NOT NULL,
  limit_count integer NOT NULL CHECK (limit_count BETWEEN 1 AND 1000000),
  window_seconds integer NOT NULL CHECK (window_seconds BETWEEN 1 AND 31536000),
  PRIMARY KEY (tenant_id, bucket_key, window_start),
  CHECK (expires_at > window_start)
);
CREATE TABLE IF NOT EXISTS public.sec_rate_blocks (
  tenant_id uuid NOT NULL,
  bucket_key text NOT NULL CHECK (octet_length(bucket_key) BETWEEN 1 AND 1024),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, bucket_key)
);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE oid IN ('public.sec_rate_counters'::regclass, 'public.sec_rate_blocks'::regclass) AND pg_get_userbyid(relowner) <> 'dap_owner') THEN
    RAISE EXCEPTION 'Rate tables must be owned by dap_owner';
  END IF;
END $$;
ALTER TABLE public.sec_rate_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sec_rate_counters FORCE ROW LEVEL SECURITY;
ALTER TABLE public.sec_rate_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sec_rate_blocks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.sec_rate_counters;
CREATE POLICY tenant_isolation ON public.sec_rate_counters
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS tenant_isolation ON public.sec_rate_blocks;
CREATE POLICY tenant_isolation ON public.sec_rate_blocks
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
REVOKE ALL ON public.sec_rate_counters, public.sec_rate_blocks FROM PUBLIC, dap_app;
-- UPDATE is necessary for atomic increment and GREATEST-based block extension.
-- No application DELETE/TRUNCATE: expired rows are purged by owner maintenance (T118).
GRANT SELECT, INSERT, UPDATE ON public.sec_rate_counters, public.sec_rate_blocks TO dap_app;
CREATE INDEX IF NOT EXISTS sec_rate_counters_expiry ON public.sec_rate_counters (tenant_id, expires_at);
CREATE INDEX IF NOT EXISTS sec_rate_blocks_expiry ON public.sec_rate_blocks (tenant_id, expires_at);
