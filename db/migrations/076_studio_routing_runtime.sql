-- 076: Studio routing and independent runtime delivery (Studio COMPLETION, S1 and S7). Owner: dap_owner (applied by the migration runner as dap_owner). 072-075 are untouched.
--
--   studio_applications += routing ('hash' | 'history'), runtime_access (boolean) and runtime_key (`rk-` + the tenant id without dashes (32 hex) + `-` + 32 random hex, UNIQUE, a PUBLIC
--     identifier and not a secret: it is rotated by replacing it; the embedded tenant must equal the row's tenant_id, so a key can only ever name an application of the tenant it carries).
--     Defences: only a Studio-managed application may use history routing or runtime access or hold a key; runtime_access requires a key; routing cannot change once the application has
--     registered routes (trigger, race-safe through a share lock on the application row).
--   studio_registry_routes.page: the V1B hash-only CHECK of 074 is replaced by a grammar chosen by the APPLICATION's routing (trigger, share lock on the application row):
--       hash      `/` or `/#/segments`, at most 120 characters (exactly as 074)
--       history   a '/'-rooted pathname of `[A-Za-z0-9._~-]` segments, at most 200 characters, no query, no fragment, no trailing slash except `/`, no `.` or `..` segment
--     plus a generic shape CHECK (rooted, at most 200 characters, none of `?`, `#`... outside the hash grammar) so a page can never be arbitrary text.
--   There is NO SECURITY DEFINER function and NO extra policy: the key-addressed runtime routes parse the tenant out of the key and open the NORMAL tenant-scoped transaction, so row-level
--     security stays the only isolation (a key whose tenant part names another tenant simply finds nothing) and dap_app's access is exactly what 072 gave it.
-- Every statement is idempotent.

DO $$
BEGIN
  IF current_user <> 'dap_owner' THEN RAISE EXCEPTION 'Studio routing migration requires dap_owner'; END IF;
END $$;

ALTER TABLE public.studio_applications ADD COLUMN IF NOT EXISTS routing text NOT NULL DEFAULT 'hash';
ALTER TABLE public.studio_applications ADD COLUMN IF NOT EXISTS runtime_access boolean NOT NULL DEFAULT false;
ALTER TABLE public.studio_applications ADD COLUMN IF NOT EXISTS runtime_key text NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.studio_applications'::regclass AND conname = 'studio_applications_routing_check') THEN
    ALTER TABLE public.studio_applications ADD CONSTRAINT studio_applications_routing_check CHECK (routing IN ('hash', 'history'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.studio_applications'::regclass AND conname = 'studio_applications_runtime_key_shape') THEN
    ALTER TABLE public.studio_applications ADD CONSTRAINT studio_applications_runtime_key_shape CHECK (runtime_key IS NULL OR runtime_key ~ '^rk-[a-f0-9]{32}-[a-f0-9]{32}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.studio_applications'::regclass AND conname = 'studio_applications_runtime_key_tenant') THEN
    ALTER TABLE public.studio_applications ADD CONSTRAINT studio_applications_runtime_key_tenant CHECK (
      runtime_key IS NULL OR runtime_key LIKE 'rk-' || replace(tenant_id::text, '-', '') || '-%');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.studio_applications'::regclass AND conname = 'studio_applications_runtime_key_key') THEN
    ALTER TABLE public.studio_applications ADD CONSTRAINT studio_applications_runtime_key_key UNIQUE (runtime_key);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.studio_applications'::regclass AND conname = 'studio_applications_managed_only_runtime') THEN
    ALTER TABLE public.studio_applications ADD CONSTRAINT studio_applications_managed_only_runtime CHECK (
      registry_id = 'studio-managed' OR (routing = 'hash' AND runtime_access = false AND runtime_key IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.studio_applications'::regclass AND conname = 'studio_applications_runtime_access_needs_key') THEN
    ALTER TABLE public.studio_applications ADD CONSTRAINT studio_applications_runtime_access_needs_key CHECK (runtime_access = false OR runtime_key IS NOT NULL);
  END IF;
END $$;

-- --- the page grammar by routing -------------------------------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.studio_page_valid(p_routing text, p_page text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT CASE p_routing
    WHEN 'hash' THEN char_length(p_page) <= 120 AND p_page ~ '^/(#/[A-Za-z0-9._~-]+(/[A-Za-z0-9._~-]+)*)?$'
    WHEN 'history' THEN char_length(p_page) <= 200 AND p_page ~ '^/([A-Za-z0-9._~-]+(/[A-Za-z0-9._~-]+)*)?$' AND p_page !~ '(^|/)[.]{1,2}(/|$)'
    ELSE false
  END;
$$;
REVOKE ALL ON FUNCTION public.studio_page_valid(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.studio_page_valid(text, text) TO dap_app;

-- 074's hash-only CHECK gives way to a routing-neutral shape check plus the trigger below (existing hash pages satisfy both).
ALTER TABLE public.studio_registry_routes DROP CONSTRAINT IF EXISTS studio_registry_routes_page_check;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.studio_registry_routes'::regclass AND conname = 'studio_registry_routes_page_shape') THEN
    ALTER TABLE public.studio_registry_routes ADD CONSTRAINT studio_registry_routes_page_shape CHECK (
      public.studio_page_valid('hash', page) OR public.studio_page_valid('history', page));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.studio_registry_routes_page_grammar() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  app_routing text;
BEGIN
  -- The share lock keeps the application's routing from changing between this check and the commit of the route.
  SELECT routing INTO app_routing FROM public.studio_applications WHERE tenant_id = NEW.tenant_id AND application_id = NEW.application_id FOR SHARE;
  -- An unknown or invisible application (another tenant's) is left to the foreign key and row-level security, which refuse the row with their own errors.
  IF app_routing IS NOT NULL AND NOT public.studio_page_valid(app_routing, NEW.page) THEN
    RAISE EXCEPTION 'new row for relation "studio_registry_routes" violates check constraint "studio_registry_routes_page_grammar"' USING ERRCODE = '23514', CONSTRAINT = 'studio_registry_routes_page_grammar';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.studio_registry_routes_page_grammar() FROM PUBLIC;
DROP TRIGGER IF EXISTS studio_registry_routes_page_grammar ON public.studio_registry_routes;
CREATE TRIGGER studio_registry_routes_page_grammar BEFORE INSERT ON public.studio_registry_routes FOR EACH ROW EXECUTE FUNCTION public.studio_registry_routes_page_grammar();

-- --- routing is locked once the application has routes ---------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.studio_applications_routing_locked() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.routing IS DISTINCT FROM OLD.routing AND EXISTS (
    SELECT 1 FROM public.studio_registry_routes WHERE tenant_id = OLD.tenant_id AND application_id = OLD.application_id) THEN
    RAISE EXCEPTION 'row for relation "studio_applications" violates check constraint "studio_applications_routing_locked"' USING ERRCODE = '23514', CONSTRAINT = 'studio_applications_routing_locked';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.studio_applications_routing_locked() FROM PUBLIC;
DROP TRIGGER IF EXISTS studio_applications_routing_locked ON public.studio_applications;
CREATE TRIGGER studio_applications_routing_locked BEFORE UPDATE ON public.studio_applications FOR EACH ROW EXECUTE FUNCTION public.studio_applications_routing_locked();
