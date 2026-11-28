ALTER TABLE public.studio_ui_guide_runs ADD COLUMN finished_at timestamptz;

CREATE TABLE public.studio_ui_guide_events (
  tenant_id uuid NOT NULL,
  application_id text NOT NULL,
  origin text NOT NULL,
  run_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('highlighted', 'confirmed')),
  step_index integer NOT NULL CHECK (step_index BETWEEN 0 AND 16),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, application_id, origin, run_id, kind, step_index),
  FOREIGN KEY (tenant_id, application_id, origin, run_id)
    REFERENCES public.studio_ui_guide_runs (tenant_id, application_id, origin, run_id) ON DELETE CASCADE
);
CREATE INDEX studio_ui_guide_events_retention ON public.studio_ui_guide_events (tenant_id, recorded_at);
ALTER TABLE public.studio_ui_guide_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.studio_ui_guide_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.studio_ui_guide_events
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, DELETE ON public.studio_ui_guide_events TO dap_app;
