CREATE TABLE public.studio_ui_maps (
  tenant_id uuid NOT NULL,
  application_id text NOT NULL,
  origin text NOT NULL CHECK (char_length(origin) BETWEEN 1 AND 190),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  map jsonb NOT NULL CHECK (jsonb_typeof(map) = 'object' AND octet_length(map::text) <= 8388608),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, application_id, origin),
  FOREIGN KEY (tenant_id, application_id)
    REFERENCES public.platform_installations (tenant_id, application_id)
);

ALTER TABLE public.studio_ui_maps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.studio_ui_maps FORCE ROW LEVEL SECURITY;
CREATE POLICY studio_ui_maps_scope ON public.studio_ui_maps
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON public.studio_ui_maps TO dap_app;
