ALTER TABLE public.studio_ui_maps
  ADD COLUMN audience text NOT NULL DEFAULT 'legacy' CHECK (audience ~ '^[a-z][a-z0-9-]{0,40}$'),
  ADD COLUMN previous_map jsonb;
ALTER TABLE public.studio_ui_maps ALTER COLUMN audience SET DEFAULT 'public';
ALTER TABLE public.studio_ui_maps DROP CONSTRAINT studio_ui_maps_pkey;
ALTER TABLE public.studio_ui_maps ADD PRIMARY KEY (tenant_id, application_id, origin, audience);

CREATE TABLE public.studio_ui_map_work (
  tenant_id uuid NOT NULL,
  application_id text NOT NULL,
  origin text NOT NULL,
  audience text NOT NULL CHECK (audience ~ '^[a-z][a-z0-9-]{0,40}$'),
  checkpoint jsonb NOT NULL CHECK (jsonb_typeof(checkpoint) = 'object' AND octet_length(checkpoint::text) <= 16777216),
  PRIMARY KEY (tenant_id, application_id, origin, audience),
  FOREIGN KEY (tenant_id, application_id) REFERENCES public.platform_installations (tenant_id, application_id)
);

CREATE TABLE public.studio_ui_role_keys (
  tenant_id uuid NOT NULL,
  application_id text NOT NULL,
  origin text NOT NULL,
  public_key text NOT NULL CHECK (length(public_key) BETWEEN 1 AND 512),
  endpoint text NOT NULL CHECK (length(endpoint) BETWEEN 1 AND 160),
  PRIMARY KEY (tenant_id, application_id, origin),
  FOREIGN KEY (tenant_id, application_id) REFERENCES public.platform_installations (tenant_id, application_id)
);

CREATE TABLE public.studio_ui_guide_runs (
  tenant_id uuid NOT NULL,
  application_id text NOT NULL,
  origin text NOT NULL,
  audience text NOT NULL,
  run_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  steps text[] NOT NULL CHECK (cardinality(steps) BETWEEN 1 AND 17),
  started_at timestamptz NOT NULL DEFAULT now(),
  outcome text NOT NULL DEFAULT 'started' CHECK (outcome IN ('started','completed','stopped')),
  step_index integer CHECK (step_index BETWEEN 0 AND 16),
  reason text CHECK (reason IN ('missing','ambiguous','link-changed','timeout','expired','unexpected-page')),
  PRIMARY KEY (tenant_id, application_id, origin, run_id),
  FOREIGN KEY (tenant_id, application_id) REFERENCES public.platform_installations (tenant_id, application_id)
);
CREATE INDEX studio_ui_guide_runs_scope ON public.studio_ui_guide_runs (tenant_id, application_id, origin, audience, started_at);

DO $$
DECLARE record_table text;
BEGIN
  FOREACH record_table IN ARRAY ARRAY['studio_ui_map_work','studio_ui_role_keys','studio_ui_guide_runs']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', record_table);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', record_table);
    EXECUTE format(
      'CREATE POLICY tenant_scope ON public.%I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
      record_table
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO dap_app', record_table);
  END LOOP;
END $$;
