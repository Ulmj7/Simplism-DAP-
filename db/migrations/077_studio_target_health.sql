-- 077: Studio target roles, markers, health and repair (Studio COMPLETION, S3). Owner: dap_owner (applied by the migration runner as dap_owner). 072-076 are untouched.
--
--   * Roles: the registrable role set of studio_registry_targets gains `text` (status and alert regions) and `heading`, both with operations EXACTLY {highlight} (074's role CHECK is replaced by a
--     wider one; its operations CHECK is kept and a second one pins the operations of text and heading).
--   * marker: the DOM `data-ai-id` the runtime resolves for the target. NOT NULL, backfilled from target_id, UNIQUE per (tenant, application), same grammar as the id. A NEW target always has marker =
--     target_id (revision 1, health 'unverified'); only a repair changes the marker. A marker may never equal ANOTHER target's id in the same application and an id may never equal another target's
--     marker (trigger, serialised per application by an advisory transaction lock).
--   * health ('unverified' | 'healthy' | 'broken'), health_checked_at: free to change (they are observations, not identity).
--   * revision + studio_registry_target_changes: marker, role, operations, label and description can change ONLY through a repair: the same transaction names the target in the transaction-local
--     setting studio.repair_target, the revision increases by exactly 1, and a matching append-only change row (before/after of exactly those five fields) exists at COMMIT (deferred constraint
--     trigger). id, application, route, page, privacy, registry_id and created_* stay immutable for every role. dap_app's UPDATE is limited to the columns above by a COLUMN-LEVEL grant.
--     There is NO SECURITY DEFINER function: the setting is a gate against accidents, the constraints and triggers are the enforcement, and the Gateway capability is the only host path that writes.
-- Every statement is idempotent.

DO $$
BEGIN
  IF current_user <> 'dap_owner' THEN RAISE EXCEPTION 'Studio target health migration requires dap_owner'; END IF;
END $$;

-- --- roles ----------------------------------------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE public.studio_registry_targets DROP CONSTRAINT IF EXISTS studio_registry_targets_role_check;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.studio_registry_targets'::regclass AND conname = 'studio_registry_targets_role_set') THEN
    ALTER TABLE public.studio_registry_targets ADD CONSTRAINT studio_registry_targets_role_set CHECK (role IN ('button', 'link', 'textbox', 'checkbox', 'select', 'text', 'heading'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.studio_registry_targets'::regclass AND conname = 'studio_registry_targets_text_operations') THEN
    ALTER TABLE public.studio_registry_targets ADD CONSTRAINT studio_registry_targets_text_operations CHECK (role NOT IN ('text', 'heading') OR operations = ARRAY['highlight']::text[]);
  END IF;
END $$;

-- --- columns --------------------------------------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE public.studio_registry_targets ADD COLUMN IF NOT EXISTS marker text;
ALTER TABLE public.studio_registry_targets ADD COLUMN IF NOT EXISTS health text NOT NULL DEFAULT 'unverified';
ALTER TABLE public.studio_registry_targets ADD COLUMN IF NOT EXISTS health_checked_at timestamptz NULL;
ALTER TABLE public.studio_registry_targets ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;

-- The backfill needs the owner to see every tenant's rows and the immutability trigger out of the way; both are restored before the statement block ends.
ALTER TABLE public.studio_registry_targets NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.studio_registry_targets DISABLE TRIGGER studio_registry_targets_immutable;
UPDATE public.studio_registry_targets SET marker = target_id WHERE marker IS NULL;
ALTER TABLE public.studio_registry_targets ENABLE TRIGGER studio_registry_targets_immutable;
ALTER TABLE public.studio_registry_targets FORCE ROW LEVEL SECURITY;
ALTER TABLE public.studio_registry_targets ALTER COLUMN marker SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.studio_registry_targets'::regclass AND conname = 'studio_registry_targets_marker_check') THEN
    ALTER TABLE public.studio_registry_targets ADD CONSTRAINT studio_registry_targets_marker_check CHECK (
      char_length(marker) <= 80 AND marker ~ '^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)+$' AND marker !~ '^(dap|studio|admin|system|internal)\.');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.studio_registry_targets'::regclass AND conname = 'studio_registry_targets_marker_key') THEN
    ALTER TABLE public.studio_registry_targets ADD CONSTRAINT studio_registry_targets_marker_key UNIQUE (tenant_id, application_id, marker);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.studio_registry_targets'::regclass AND conname = 'studio_registry_targets_health_check') THEN
    ALTER TABLE public.studio_registry_targets ADD CONSTRAINT studio_registry_targets_health_check CHECK (health IN ('unverified', 'healthy', 'broken'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.studio_registry_targets'::regclass AND conname = 'studio_registry_targets_revision_check') THEN
    ALTER TABLE public.studio_registry_targets ADD CONSTRAINT studio_registry_targets_revision_check CHECK (revision >= 1);
  END IF;
END $$;

-- --- the append-only change history ----------------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.studio_registry_target_changes (
  tenant_id uuid NOT NULL,
  application_id text NOT NULL,
  target_id text NOT NULL,
  revision integer NOT NULL CHECK (revision >= 2),
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_by text NOT NULL CHECK (char_length(changed_by) BETWEEN 1 AND 256),
  before jsonb NOT NULL CHECK (jsonb_typeof(before) = 'object' AND octet_length(before::text) <= 2048),
  after jsonb NOT NULL CHECK (jsonb_typeof(after) = 'object' AND octet_length(after::text) <= 2048),
  reason text NOT NULL CHECK (reason = 'repair'),
  PRIMARY KEY (tenant_id, application_id, target_id, revision),
  CONSTRAINT studio_registry_target_changes_target_fk FOREIGN KEY (tenant_id, application_id, target_id)
    REFERENCES public.studio_registry_targets (tenant_id, application_id, target_id)
);

DO $$
BEGIN
  IF (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.studio_registry_target_changes'::regclass) <> 'dap_owner' THEN
    RAISE EXCEPTION 'Studio target change history must be owned by dap_owner';
  END IF;
END $$;

-- --- triggers --------------------------------------------------------------------------------------------------------------------------------------------------------------
-- A new target is revision 1, health unverified, marker = id. Markers and ids never collide inside an application.
CREATE OR REPLACE FUNCTION public.studio_registry_targets_marker_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.marker IS NULL THEN NEW.marker := NEW.target_id; END IF;
    IF NEW.marker <> NEW.target_id OR NEW.revision <> 1 THEN
      RAISE EXCEPTION 'new row for relation "studio_registry_targets" violates check constraint "studio_registry_targets_new_identity"' USING ERRCODE = '23514', CONSTRAINT = 'studio_registry_targets_new_identity';
    END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('studio-registry-markers:' || NEW.tenant_id::text || ':' || NEW.application_id, 0));
  IF EXISTS (
    SELECT 1 FROM public.studio_registry_targets other
     WHERE other.tenant_id = NEW.tenant_id AND other.application_id = NEW.application_id AND other.target_id <> NEW.target_id
       AND (other.target_id = NEW.marker OR other.marker = NEW.target_id)) THEN
    RAISE EXCEPTION 'row for relation "studio_registry_targets" violates check constraint "studio_registry_targets_marker_in_use"' USING ERRCODE = '23514', CONSTRAINT = 'studio_registry_targets_marker_in_use';
  END IF;
  RETURN NEW;
END $$;

-- Replaces 074's function of the same name: the trigger keeps its name, the rule widens from "only status" to the table above.
CREATE OR REPLACE FUNCTION public.studio_registry_targets_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  free_columns constant text[] := ARRAY['status', 'updated_by', 'updated_at', 'health', 'health_checked_at'];
  repair_columns constant text[] := ARRAY['marker', 'role', 'operations', 'label', 'description', 'revision'];
BEGIN
  IF (to_jsonb(NEW) - free_columns - repair_columns) IS DISTINCT FROM (to_jsonb(OLD) - free_columns - repair_columns) THEN
    RAISE EXCEPTION 'A registry target cannot be changed, only enabled, disabled, re-checked or repaired' USING ERRCODE = '23514', CONSTRAINT = 'studio_registry_targets_immutable';
  END IF;
  IF (NEW.marker, NEW.role, NEW.operations, NEW.label, NEW.description) IS DISTINCT FROM (OLD.marker, OLD.role, OLD.operations, OLD.label, OLD.description) THEN
    IF coalesce(current_setting('studio.repair_target', true), '') <> NEW.tenant_id::text || '/' || NEW.application_id || '/' || NEW.target_id THEN
      RAISE EXCEPTION 'A registry target changes its marker, role, operations or texts only by a repair' USING ERRCODE = '23514', CONSTRAINT = 'studio_registry_targets_repair_only';
    END IF;
    IF NEW.revision <> OLD.revision + 1 THEN
      RAISE EXCEPTION 'A repair raises the revision by exactly one' USING ERRCODE = '23514', CONSTRAINT = 'studio_registry_targets_revision_step';
    END IF;
  ELSIF NEW.revision <> OLD.revision THEN
    RAISE EXCEPTION 'The revision moves only with a repair' USING ERRCODE = '23514', CONSTRAINT = 'studio_registry_targets_revision_step';
  END IF;
  RETURN NEW;
END $$;

-- At COMMIT every revision step has its history row, and the row says exactly what changed (deferred, so the order inside the transaction does not matter).
CREATE OR REPLACE FUNCTION public.studio_registry_targets_repair_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.studio_registry_target_changes c
     WHERE c.tenant_id = NEW.tenant_id AND c.application_id = NEW.application_id AND c.target_id = NEW.target_id AND c.revision = NEW.revision
       AND c.before = jsonb_build_object('marker', OLD.marker, 'role', OLD.role, 'operations', to_jsonb(OLD.operations), 'label', OLD.label, 'description', OLD.description)
       AND c.after = jsonb_build_object('marker', NEW.marker, 'role', NEW.role, 'operations', to_jsonb(NEW.operations), 'label', NEW.label, 'description', NEW.description)) THEN
    RAISE EXCEPTION 'A repair needs its matching change row' USING ERRCODE = '23514', CONSTRAINT = 'studio_registry_target_changes_missing';
  END IF;
  RETURN NULL;
END $$;

-- A history row can only describe a revision the target really reached.
CREATE OR REPLACE FUNCTION public.studio_registry_target_changes_reached() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.studio_registry_targets t
     WHERE t.tenant_id = NEW.tenant_id AND t.application_id = NEW.application_id AND t.target_id = NEW.target_id AND t.revision >= NEW.revision) THEN
    RAISE EXCEPTION 'A change row describes a revision the target has not reached' USING ERRCODE = '23514', CONSTRAINT = 'studio_registry_target_changes_unreached';
  END IF;
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION public.studio_registry_targets_marker_rules() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.studio_registry_targets_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.studio_registry_targets_repair_history() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.studio_registry_target_changes_reached() FROM PUBLIC;

DROP TRIGGER IF EXISTS studio_registry_targets_marker_rules ON public.studio_registry_targets;
CREATE TRIGGER studio_registry_targets_marker_rules BEFORE INSERT OR UPDATE OF marker, target_id ON public.studio_registry_targets FOR EACH ROW EXECUTE FUNCTION public.studio_registry_targets_marker_rules();
DROP TRIGGER IF EXISTS studio_registry_targets_repair_history ON public.studio_registry_targets;
CREATE CONSTRAINT TRIGGER studio_registry_targets_repair_history AFTER UPDATE ON public.studio_registry_targets DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.revision IS DISTINCT FROM OLD.revision) EXECUTE FUNCTION public.studio_registry_targets_repair_history();
DROP TRIGGER IF EXISTS studio_registry_target_changes_reached ON public.studio_registry_target_changes;
CREATE CONSTRAINT TRIGGER studio_registry_target_changes_reached AFTER INSERT ON public.studio_registry_target_changes DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.studio_registry_target_changes_reached();

-- --- row-level security and grants ---------------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE public.studio_registry_target_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.studio_registry_target_changes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.studio_registry_target_changes;
CREATE POLICY tenant_isolation ON public.studio_registry_target_changes
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON TABLE public.studio_registry_target_changes FROM PUBLIC, dap_app;
GRANT SELECT, INSERT ON TABLE public.studio_registry_target_changes TO dap_app;

-- dap_app may update ONLY these columns of a target (everything else, including id, application, route, page and privacy, has no UPDATE grant at all).
REVOKE UPDATE ON TABLE public.studio_registry_targets FROM PUBLIC, dap_app;
GRANT UPDATE (status, health, health_checked_at, marker, role, operations, label, description, revision, updated_by, updated_at) ON TABLE public.studio_registry_targets TO dap_app;
