-- T113 hardening: dap_app needs UPDATE on the rate tables (atomic increment, GREATEST-based block extension), and with
-- raw SQL inside its own tenant it could also shorten a denial block or rewind a live counter. Row triggers make those
-- UPDATEs one-way, independent of how the caller computes anything:
--  * a block can only be extended and can never be re-keyed;
--  * a counter that is live by the DATABASE clock can only count up: its window, rule and expiry are fixed, and its key
--    can never change. An expired counter may be rewritten (that is the adapter's own reset path after a rule change).
-- Trigger functions are SECURITY INVOKER with a pinned search_path (nothing for a caller to shadow).
DO $$
BEGIN
  IF current_user <> 'dap_owner' OR EXISTS (
    SELECT 1 FROM pg_class WHERE oid IN ('public.sec_rate_counters'::regclass, 'public.sec_rate_blocks'::regclass)
      AND pg_get_userbyid(relowner) <> 'dap_owner') THEN
    RAISE EXCEPTION 'Rate hardening requires dap_owner table ownership';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.sec_rate_blocks_monotonic() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.bucket_key IS DISTINCT FROM OLD.bucket_key OR NEW.expires_at < OLD.expires_at THEN
    RAISE EXCEPTION 'A denial block can only be extended' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.sec_rate_counters_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.bucket_key IS DISTINCT FROM OLD.bucket_key OR NEW.window_start IS DISTINCT FROM OLD.window_start THEN
    RAISE EXCEPTION 'A rate counter cannot be re-keyed' USING ERRCODE = '42501';
  END IF;
  IF OLD.expires_at > clock_timestamp() AND (
    NEW.count < OLD.count OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR
    NEW.limit_count IS DISTINCT FROM OLD.limit_count OR NEW.window_seconds IS DISTINCT FROM OLD.window_seconds) THEN
    RAISE EXCEPTION 'A live rate counter can only count up' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.sec_rate_blocks_monotonic(), public.sec_rate_counters_guard() FROM PUBLIC, dap_app;
DROP TRIGGER IF EXISTS sec_rate_blocks_monotonic ON public.sec_rate_blocks;
CREATE TRIGGER sec_rate_blocks_monotonic BEFORE UPDATE ON public.sec_rate_blocks
  FOR EACH ROW EXECUTE FUNCTION public.sec_rate_blocks_monotonic();
DROP TRIGGER IF EXISTS sec_rate_counters_guard ON public.sec_rate_counters;
CREATE TRIGGER sec_rate_counters_guard BEFORE UPDATE ON public.sec_rate_counters
  FOR EACH ROW EXECUTE FUNCTION public.sec_rate_counters_guard();
