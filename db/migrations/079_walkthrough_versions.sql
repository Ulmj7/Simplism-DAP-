-- S5: one editable head, immutable publication snapshots, and a tenant-bound live pointer.
DO $$
BEGIN
  IF current_user <> 'dap_owner' THEN RAISE EXCEPTION 'Walkthrough versions migration requires dap_owner'; END IF;
END $$;

ALTER TABLE public.walkthrough_definitions
  ADD COLUMN IF NOT EXISTS revision int NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 1000000),
  ADD COLUMN IF NOT EXISTS live_version int;

CREATE TABLE IF NOT EXISTS public.walkthrough_versions (
  tenant_id uuid NOT NULL,
  walkthrough_id text NOT NULL,
  version int NOT NULL CHECK (version BETWEEN 1 AND 1000000),
  application_id text,
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object' AND octet_length(definition::text) <= 32768),
  step_count int NOT NULL CHECK (step_count >= 0),
  published_by text NOT NULL CHECK (char_length(published_by) BETWEEN 1 AND 256),
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, walkthrough_id, version),
  FOREIGN KEY (tenant_id, walkthrough_id) REFERENCES public.walkthrough_definitions (tenant_id, walkthrough_id),
  FOREIGN KEY (tenant_id, application_id) REFERENCES public.studio_applications (tenant_id, application_id)
);

-- The migration transaction holds exclusive table locks. The owner's backfill can see
-- tenant rows only while the transaction holds these locks. Both tables finish with FORCE.
LOCK TABLE public.walkthrough_definitions, public.walkthrough_versions IN ACCESS EXCLUSIVE MODE;
ALTER TABLE public.walkthrough_definitions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.walkthrough_versions NO FORCE ROW LEVEL SECURITY;

INSERT INTO public.walkthrough_versions (tenant_id, walkthrough_id, version, application_id, definition, step_count, published_by, published_at)
SELECT d.tenant_id, d.walkthrough_id, 1, d.application_id, d.definition,
       (SELECT count(*) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(d.definition->'steps') = 'array' THEN d.definition->'steps' ELSE '[]'::jsonb END) step WHERE step->>'kind' = 'guide'),
       d.updated_by, d.updated_at
  FROM public.walkthrough_definitions d
 WHERE d.status = 'published' AND d.live_version IS NULL
ON CONFLICT DO NOTHING;

UPDATE public.walkthrough_definitions d SET live_version = 1
 WHERE d.status = 'published' AND d.live_version IS NULL
   AND EXISTS (SELECT 1 FROM public.walkthrough_versions v WHERE v.tenant_id = d.tenant_id AND v.walkthrough_id = d.walkthrough_id AND v.version = 1);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'walkthrough_definitions_live_fk' AND conrelid = 'public.walkthrough_definitions'::regclass) THEN
    ALTER TABLE public.walkthrough_definitions ADD CONSTRAINT walkthrough_definitions_live_fk
      FOREIGN KEY (tenant_id, walkthrough_id, live_version)
      REFERENCES public.walkthrough_versions (tenant_id, walkthrough_id, version);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.walkthrough_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'A walkthrough snapshot cannot be changed' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.walkthrough_definitions d
    WHERE d.tenant_id = NEW.tenant_id AND d.walkthrough_id = NEW.walkthrough_id
      AND d.application_id IS NOT DISTINCT FROM NEW.application_id
  ) THEN
    RAISE EXCEPTION 'A walkthrough snapshot belongs to its walkthrough application' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS walkthrough_version_guard ON public.walkthrough_versions;
CREATE TRIGGER walkthrough_version_guard BEFORE INSERT OR UPDATE OR DELETE ON public.walkthrough_versions
  FOR EACH ROW EXECUTE FUNCTION public.walkthrough_version_guard();
REVOKE ALL ON FUNCTION public.walkthrough_version_guard() FROM PUBLIC;

ALTER TABLE public.walkthrough_definitions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.walkthrough_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.walkthrough_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.walkthrough_versions;
CREATE POLICY tenant_isolation ON public.walkthrough_versions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
REVOKE ALL ON TABLE public.walkthrough_versions FROM PUBLIC, dap_app;
GRANT SELECT, INSERT ON TABLE public.walkthrough_versions TO dap_app;
