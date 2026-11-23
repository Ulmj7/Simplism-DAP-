-- 073: bind a walkthrough to an application (Studio V1A, D4). `application_id` is NULLABLE: rows written before Studio have none and are treated by the host as
-- belonging to the built-in `reference` application. New drafts always carry one (the host requires it). Once a row has an application it can never change it: a
-- trigger enforces that even for a statement the host forgot to guard; a NULL may be assigned once (the first save of a legacy row).
-- The composite foreign key includes tenant_id, so a walkthrough can only point at an application of its OWN tenant; with MATCH SIMPLE a NULL application_id is not
-- checked. Referential checks do not expose another tenant's rows (the key carries the tenant). Every statement is idempotent. Owner: dap_owner.

DO $$
BEGIN
  IF current_user <> 'dap_owner' THEN RAISE EXCEPTION 'Walkthrough application migration requires dap_owner'; END IF;
END $$;

ALTER TABLE public.walkthrough_definitions ADD COLUMN IF NOT EXISTS application_id text NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'walkthrough_definitions_application_id_format' AND conrelid = 'public.walkthrough_definitions'::regclass) THEN
    ALTER TABLE public.walkthrough_definitions
      ADD CONSTRAINT walkthrough_definitions_application_id_format CHECK (application_id IS NULL OR application_id ~ '^app-[a-f0-9]{12}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'walkthrough_definitions_application_fk' AND conrelid = 'public.walkthrough_definitions'::regclass) THEN
    ALTER TABLE public.walkthrough_definitions
      ADD CONSTRAINT walkthrough_definitions_application_fk FOREIGN KEY (tenant_id, application_id)
      REFERENCES public.studio_applications (tenant_id, application_id) MATCH SIMPLE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS walkthrough_definitions_application_idx ON public.walkthrough_definitions (tenant_id, application_id);

CREATE OR REPLACE FUNCTION public.walkthrough_application_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.application_id IS NOT NULL AND NEW.application_id IS DISTINCT FROM OLD.application_id THEN
    RAISE EXCEPTION 'A walkthrough application cannot be changed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS walkthrough_application_immutable ON public.walkthrough_definitions;
CREATE TRIGGER walkthrough_application_immutable BEFORE UPDATE ON public.walkthrough_definitions
  FOR EACH ROW EXECUTE FUNCTION public.walkthrough_application_immutable();

REVOKE ALL ON FUNCTION public.walkthrough_application_immutable() FROM PUBLIC;
-- Table privileges (SELECT, INSERT, UPDATE for dap_app) already cover the new column.
