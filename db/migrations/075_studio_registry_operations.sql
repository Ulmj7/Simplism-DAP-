-- The registry and origin arrays represent sets. Enforce the rule on writes without
-- rewriting legacy rows accepted by the earlier checks.
CREATE OR REPLACE FUNCTION public.studio_distinct_text_items(items text[])
RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT cardinality(items) = (SELECT count(DISTINCT item COLLATE "C") FROM unnest(items) AS values_in_array(item));
$$;

REVOKE ALL ON FUNCTION public.studio_distinct_text_items(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.studio_distinct_text_items(text[]) TO dap_app;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.studio_registry_targets'::regclass AND conname = 'studio_registry_targets_distinct_operations') THEN
    ALTER TABLE public.studio_registry_targets
      ADD CONSTRAINT studio_registry_targets_distinct_operations CHECK (public.studio_distinct_text_items(operations)) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.studio_applications'::regclass AND conname = 'studio_applications_distinct_origins') THEN
    ALTER TABLE public.studio_applications
      ADD CONSTRAINT studio_applications_distinct_origins CHECK (public.studio_distinct_text_items(allowed_origins)) NOT VALID;
  END IF;
END $$;
