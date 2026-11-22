-- 074: Studio-managed application target registries (Studio V1B, D2). For an application whose registry_id is 'studio-managed' the trusted routes and targets are DATA owned by
-- the application's tenant instead of a host-code catalog entry. Owner: dap_owner (applied by the migration runner as dap_owner). Same guards and tenant mechanism as 072/073.
--
-- Defences, each proved by a direct-SQL PostgreSQL test as dap_app (tests/integration/studio-registry-migration.test.ts):
--   * ENABLE + FORCE row-level security on both tables, policy on app.tenant_id exactly as 072; grants SELECT/INSERT for routes and SELECT/INSERT/UPDATE for targets; NO DELETE, NO TRUNCATE.
--   * studio_applications gets UNIQUE (tenant_id, application_id, registry_id) (added idempotently; 072/073 are otherwise untouched). Routes and targets carry registry_id with CHECK
--     registry_id = 'studio-managed' and a composite FOREIGN KEY on that unique key: a route or target can only attach to a managed application of the SAME tenant, and a managed
--     application can never be re-pointed at another registry while it has routes or targets.
--   * routes: PK (tenant, application, route), UNIQUE (tenant, application, page); route and page grammars as CHECKs; at most 20 per application (trigger, serialised by an advisory
--     transaction lock per application, so two concurrent inserts cannot exceed it); a route row is immutable (no UPDATE grant, and a trigger refuses it for any role).
--   * targets: PK (tenant, application, target_id), composite FOREIGN KEY (tenant, application, route) to the routes; CHECKs for the id grammar (the walkthrough semantic-id rule, at most 80,
--     reserved first segments), the registrable roles, the operations (a non-empty subset allowed for the role that contains `highlight`), the label and description character rules and
--     lengths, privacy = 'public', status; at most 200 per application (trigger, same lock); an UPDATE trigger that lets ONLY status, updated_by and updated_at change.
-- Every statement is idempotent.

DO $$
BEGIN
  IF current_user <> 'dap_owner' THEN RAISE EXCEPTION 'Studio registry migration requires dap_owner'; END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'studio_applications_registry_key' AND conrelid = 'public.studio_applications'::regclass) THEN
    ALTER TABLE public.studio_applications ADD CONSTRAINT studio_applications_registry_key UNIQUE (tenant_id, application_id, registry_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.studio_registry_routes (
  tenant_id uuid NOT NULL,
  application_id text NOT NULL,
  registry_id text NOT NULL DEFAULT 'studio-managed' CHECK (registry_id = 'studio-managed'),
  route text NOT NULL CHECK (route ~ '^[a-z][A-Za-z0-9]{0,39}$'),
  page text NOT NULL CHECK (char_length(page) <= 120 AND page ~ '^/(#/[A-Za-z0-9._~-]+(/[A-Za-z0-9._~-]+)*)?$'),
  created_by text NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 256),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, application_id, route),
  CONSTRAINT studio_registry_routes_page_key UNIQUE (tenant_id, application_id, page),
  CONSTRAINT studio_registry_routes_application_fk FOREIGN KEY (tenant_id, application_id, registry_id)
    REFERENCES public.studio_applications (tenant_id, application_id, registry_id)
);

CREATE TABLE IF NOT EXISTS public.studio_registry_targets (
  tenant_id uuid NOT NULL,
  application_id text NOT NULL,
  registry_id text NOT NULL DEFAULT 'studio-managed' CHECK (registry_id = 'studio-managed'),
  target_id text NOT NULL CHECK (
    char_length(target_id) <= 80 AND target_id ~ '^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)+$' AND target_id !~ '^(dap|studio|admin|system|internal)\.'),
  route text NOT NULL,
  role text NOT NULL CHECK (role IN ('button', 'link', 'textbox', 'checkbox', 'select')),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80 AND btrim(label) <> '' AND label !~ '[<>&"''`]'),
  description text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 240 AND btrim(description) <> '' AND description !~ '[<>&"''`]'),
  operations text[] NOT NULL CHECK (
    cardinality(operations) BETWEEN 1 AND 3 AND 'highlight' = ANY (operations)
    AND ((role = 'textbox' AND operations <@ ARRAY['highlight', 'input', 'focus']::text[])
      OR (role <> 'textbox' AND operations <@ ARRAY['highlight', 'click', 'focus']::text[]))),
  privacy text NOT NULL CHECK (privacy = 'public'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_by text NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 256),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL CHECK (char_length(updated_by) BETWEEN 1 AND 256),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, application_id, target_id),
  CONSTRAINT studio_registry_targets_application_fk FOREIGN KEY (tenant_id, application_id, registry_id)
    REFERENCES public.studio_applications (tenant_id, application_id, registry_id),
  CONSTRAINT studio_registry_targets_route_fk FOREIGN KEY (tenant_id, application_id, route)
    REFERENCES public.studio_registry_routes (tenant_id, application_id, route)
);

CREATE INDEX IF NOT EXISTS studio_registry_targets_route_idx ON public.studio_registry_targets (tenant_id, application_id, route);

DO $$
BEGIN
  IF (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.studio_registry_routes'::regclass) <> 'dap_owner'
     OR (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.studio_registry_targets'::regclass) <> 'dap_owner' THEN
    RAISE EXCEPTION 'Studio registry tables must be owned by dap_owner';
  END IF;
END $$;

-- Caps, serialised per application so concurrent inserts cannot exceed them. The count runs under the caller's own tenant setting (forced RLS), which is the row's tenant.
CREATE OR REPLACE FUNCTION public.studio_registry_routes_cap() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('studio-registry-routes:' || NEW.tenant_id::text || ':' || NEW.application_id, 0));
  IF (SELECT count(*) FROM public.studio_registry_routes WHERE tenant_id = NEW.tenant_id AND application_id = NEW.application_id) >= 20 THEN
    RAISE EXCEPTION 'An application registry holds at most 20 routes' USING ERRCODE = '23514', CONSTRAINT = 'studio_registry_routes_cap';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.studio_registry_targets_cap() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('studio-registry-targets:' || NEW.tenant_id::text || ':' || NEW.application_id, 0));
  IF (SELECT count(*) FROM public.studio_registry_targets WHERE tenant_id = NEW.tenant_id AND application_id = NEW.application_id) >= 200 THEN
    RAISE EXCEPTION 'An application registry holds at most 200 targets' USING ERRCODE = '23514', CONSTRAINT = 'studio_registry_targets_cap';
  END IF;
  RETURN NEW;
END $$;

-- A route never changes; a target changes ONLY its status (and who/when). Everything else is the target's identity.
CREATE OR REPLACE FUNCTION public.studio_registry_routes_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'A registry route cannot be changed' USING ERRCODE = '23514', CONSTRAINT = 'studio_registry_routes_immutable';
END $$;

CREATE OR REPLACE FUNCTION public.studio_registry_targets_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'status' - 'updated_by' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'updated_by' - 'updated_at') THEN
    RAISE EXCEPTION 'A registry target cannot be changed, only enabled or disabled' USING ERRCODE = '23514', CONSTRAINT = 'studio_registry_targets_immutable';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS studio_registry_routes_cap ON public.studio_registry_routes;
CREATE TRIGGER studio_registry_routes_cap BEFORE INSERT ON public.studio_registry_routes FOR EACH ROW EXECUTE FUNCTION public.studio_registry_routes_cap();
DROP TRIGGER IF EXISTS studio_registry_targets_cap ON public.studio_registry_targets;
CREATE TRIGGER studio_registry_targets_cap BEFORE INSERT ON public.studio_registry_targets FOR EACH ROW EXECUTE FUNCTION public.studio_registry_targets_cap();
DROP TRIGGER IF EXISTS studio_registry_routes_immutable ON public.studio_registry_routes;
CREATE TRIGGER studio_registry_routes_immutable BEFORE UPDATE ON public.studio_registry_routes FOR EACH ROW EXECUTE FUNCTION public.studio_registry_routes_immutable();
DROP TRIGGER IF EXISTS studio_registry_targets_immutable ON public.studio_registry_targets;
CREATE TRIGGER studio_registry_targets_immutable BEFORE UPDATE ON public.studio_registry_targets FOR EACH ROW EXECUTE FUNCTION public.studio_registry_targets_immutable();

REVOKE ALL ON FUNCTION public.studio_registry_routes_cap() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.studio_registry_targets_cap() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.studio_registry_routes_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.studio_registry_targets_immutable() FROM PUBLIC;

ALTER TABLE public.studio_registry_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.studio_registry_routes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.studio_registry_routes;
CREATE POLICY tenant_isolation ON public.studio_registry_routes
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE public.studio_registry_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.studio_registry_targets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.studio_registry_targets;
CREATE POLICY tenant_isolation ON public.studio_registry_targets
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON TABLE public.studio_registry_routes FROM PUBLIC, dap_app;
GRANT SELECT, INSERT ON TABLE public.studio_registry_routes TO dap_app;
REVOKE ALL ON TABLE public.studio_registry_targets FROM PUBLIC, dap_app;
GRANT SELECT, INSERT, UPDATE ON TABLE public.studio_registry_targets TO dap_app;
