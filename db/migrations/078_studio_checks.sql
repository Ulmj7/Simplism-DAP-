-- 078: verification checks of Studio-managed registries (Studio COMPLETION, S4). A check is a named, closed, read-only observation of the application's page that a guide step may name as its
-- `verify` (see apps/reference-host/src/studio/registry-checks.ts). It is DATA: the embed evaluates one of six fixed kinds, nothing a maintainer types is ever executed.
-- Owner: dap_owner (applied by the migration runner). Same guards and tenant mechanism as 074/077. NO SECURITY DEFINER anywhere.
--
-- Defences, each proved by a direct-SQL PostgreSQL test as dap_app (tests/integration/studio-checks-migration.test.ts):
--   * ENABLE + FORCE row-level security, policy on app.tenant_id exactly as 072/074; grants SELECT, INSERT and UPDATE of status/updated_by/updated_at ONLY: no DELETE, no TRUNCATE, no other column.
--   * composite FOREIGN KEYS: to the managed application of the SAME tenant, to the target (target_id) and to the route (route); a check can never name a target or route of another application.
--   * kind-specific CHECKs: exactly the fields each kind carries and nothing else; the attribute allow-list; expected 1..120 characters (1..40 for an attribute), not blank, no control characters.
--   * the NAME is `check.v` + the first 10 hex characters of the SHA-256 of the canonical JSON {kind,targetId,route,attribute,expected} (that key order, null when absent): the HOST computes it and
--     a trigger RECOMPUTES it, so a name that does not describe its content is refused. A UNIQUE index on the content makes the same observation exist once per application.
--   * a trigger (serialised per application by an advisory transaction lock) holds the cap of 100 checks per application, requires an ACTIVE target for an element check and a textbox, select or
--     checkbox target for `element.value.equals` (insert time: a later repair is judged by the repair compatibility check of the host).
--   * immutable: an UPDATE trigger lets only status, updated_by and updated_at change, for any role.
-- Every statement is idempotent.

DO $$
BEGIN
  IF current_user <> 'dap_owner' THEN RAISE EXCEPTION 'Studio checks migration requires dap_owner'; END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.studio_registry_checks (
  tenant_id uuid NOT NULL,
  application_id text NOT NULL,
  registry_id text NOT NULL DEFAULT 'studio-managed' CHECK (registry_id = 'studio-managed'),
  name text NOT NULL CHECK (name ~ '^check\.v[0-9a-f]{10}$'),
  kind text NOT NULL CHECK (kind IN ('route.equals', 'element.visible', 'element.hidden', 'element.text.equals', 'element.value.equals', 'element.attribute.equals')),
  target_id text,
  route text,
  attribute text,
  expected text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_by text NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 256),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL CHECK (char_length(updated_by) BETWEEN 1 AND 256),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, application_id, name),
  CONSTRAINT studio_registry_checks_application_fk FOREIGN KEY (tenant_id, application_id, registry_id)
    REFERENCES public.studio_applications (tenant_id, application_id, registry_id),
  CONSTRAINT studio_registry_checks_target_fk FOREIGN KEY (tenant_id, application_id, target_id)
    REFERENCES public.studio_registry_targets (tenant_id, application_id, target_id),
  CONSTRAINT studio_registry_checks_route_fk FOREIGN KEY (tenant_id, application_id, route)
    REFERENCES public.studio_registry_routes (tenant_id, application_id, route)
);

ALTER TABLE public.studio_registry_checks
  DROP CONSTRAINT IF EXISTS studio_registry_checks_shape,
  DROP CONSTRAINT IF EXISTS studio_registry_checks_expected_text;
ALTER TABLE public.studio_registry_checks
  ADD CONSTRAINT studio_registry_checks_shape CHECK (
       (kind = 'route.equals' AND route IS NOT NULL AND target_id IS NULL AND attribute IS NULL AND expected IS NULL)
    OR (kind IN ('element.visible', 'element.hidden') AND target_id IS NOT NULL AND route IS NULL AND attribute IS NULL AND expected IS NULL)
    OR (kind IN ('element.text.equals', 'element.value.equals') AND target_id IS NOT NULL AND route IS NULL AND attribute IS NULL AND expected IS NOT NULL AND char_length(expected) BETWEEN 1 AND 120)
    OR (kind = 'element.attribute.equals' AND target_id IS NOT NULL AND route IS NULL AND expected IS NOT NULL AND char_length(expected) BETWEEN 1 AND 40
        AND attribute IS NOT NULL AND attribute IN ('aria-checked', 'aria-expanded', 'aria-selected', 'aria-pressed', 'aria-disabled', 'aria-current', 'disabled', 'checked'))),
  ADD CONSTRAINT studio_registry_checks_expected_text CHECK (
    expected IS NULL OR (btrim(expected) <> '' AND expected !~ '[\u0001-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]'));

-- The same observation exists once per application (its name is derived from exactly these fields).
CREATE UNIQUE INDEX IF NOT EXISTS studio_registry_checks_content_key ON public.studio_registry_checks
  (tenant_id, application_id, kind, COALESCE(target_id, ''), COALESCE(route, ''), COALESCE(attribute, ''), COALESCE(expected, ''));
CREATE INDEX IF NOT EXISTS studio_registry_checks_target_idx ON public.studio_registry_checks (tenant_id, application_id, target_id);

DO $$
BEGIN
  IF (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.studio_registry_checks'::regclass) <> 'dap_owner' THEN
    RAISE EXCEPTION 'Studio checks table must be owned by dap_owner';
  END IF;
END $$;

-- Insert rules: the cap, the name, the target. Runs under the caller's own tenant setting (forced RLS), which is the row's tenant.
CREATE OR REPLACE FUNCTION public.studio_registry_checks_rules() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  canonical text;
  target_role text;
  target_status text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('studio-registry-checks:' || NEW.tenant_id::text || ':' || NEW.application_id, 0));
  IF (SELECT count(*) FROM public.studio_registry_checks WHERE tenant_id = NEW.tenant_id AND application_id = NEW.application_id) >= 100 THEN
    RAISE EXCEPTION 'An application registry holds at most 100 checks' USING ERRCODE = '23514', CONSTRAINT = 'studio_registry_checks_cap';
  END IF;
  -- The canonical JSON of the host: keys in this order, null when absent, strings escaped as JSON.stringify does (the control characters are refused above, so the escapes agree).
  canonical := '{"kind":' || to_json(NEW.kind)::text
    || ',"targetId":' || COALESCE(to_json(NEW.target_id)::text, 'null')
    || ',"route":' || COALESCE(to_json(NEW.route)::text, 'null')
    || ',"attribute":' || COALESCE(to_json(NEW.attribute)::text, 'null')
    || ',"expected":' || COALESCE(to_json(NEW.expected)::text, 'null') || '}';
  IF NEW.name IS DISTINCT FROM 'check.v' || substr(encode(sha256(convert_to(canonical, 'UTF8')), 'hex'), 1, 10) THEN
    RAISE EXCEPTION 'A check name must be derived from its content' USING ERRCODE = '23514', CONSTRAINT = 'studio_registry_checks_name';
  END IF;
  IF NEW.target_id IS NOT NULL THEN
    SELECT t.role, t.status INTO target_role, target_status FROM public.studio_registry_targets t
      WHERE t.tenant_id = NEW.tenant_id AND t.application_id = NEW.application_id AND t.target_id = NEW.target_id;
    IF FOUND THEN -- a missing target is the foreign key's error
      IF target_status <> 'active' THEN
        RAISE EXCEPTION 'A check needs an active target' USING ERRCODE = '23514', CONSTRAINT = 'studio_registry_checks_target_active';
      END IF;
      IF NEW.kind = 'element.value.equals' AND target_role NOT IN ('textbox', 'select', 'checkbox') THEN
        RAISE EXCEPTION 'A value check needs a textbox, select or checkbox target' USING ERRCODE = '23514', CONSTRAINT = 'studio_registry_checks_value_role';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- A check never changes; only its status (and who/when) does. Everything else is its identity.
CREATE OR REPLACE FUNCTION public.studio_registry_checks_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'status' - 'updated_by' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'updated_by' - 'updated_at') THEN
    RAISE EXCEPTION 'A registry check cannot be changed, only enabled or disabled' USING ERRCODE = '23514', CONSTRAINT = 'studio_registry_checks_immutable';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS studio_registry_checks_rules ON public.studio_registry_checks;
CREATE TRIGGER studio_registry_checks_rules BEFORE INSERT ON public.studio_registry_checks FOR EACH ROW EXECUTE FUNCTION public.studio_registry_checks_rules();
DROP TRIGGER IF EXISTS studio_registry_checks_immutable ON public.studio_registry_checks;
CREATE TRIGGER studio_registry_checks_immutable BEFORE UPDATE ON public.studio_registry_checks FOR EACH ROW EXECUTE FUNCTION public.studio_registry_checks_immutable();

REVOKE ALL ON FUNCTION public.studio_registry_checks_rules() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.studio_registry_checks_immutable() FROM PUBLIC;

ALTER TABLE public.studio_registry_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.studio_registry_checks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.studio_registry_checks;
CREATE POLICY tenant_isolation ON public.studio_registry_checks
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON TABLE public.studio_registry_checks FROM PUBLIC, dap_app;
GRANT SELECT, INSERT ON TABLE public.studio_registry_checks TO dap_app;
GRANT UPDATE (status, updated_by, updated_at) ON TABLE public.studio_registry_checks TO dap_app;
