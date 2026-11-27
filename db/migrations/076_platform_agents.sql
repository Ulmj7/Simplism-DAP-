CREATE TABLE public.platform_installations (
  tenant_id uuid PRIMARY KEY,
  application_id text NOT NULL,
  agent_id uuid NOT NULL UNIQUE,
  installation_id uuid NOT NULL UNIQUE,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{1,61})[a-z0-9]$'),
  name text NOT NULL,
  agent_name text NOT NULL,
  origin text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  session_epoch integer NOT NULL DEFAULT 0,
  last_connected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, application_id),
  FOREIGN KEY (tenant_id, application_id) REFERENCES public.studio_applications (tenant_id, application_id)
);
CREATE TABLE public.platform_operations (
  actor text NOT NULL,
  request_key uuid NOT NULL,
  digest text NOT NULL,
  tenant_id uuid NOT NULL REFERENCES public.platform_installations (tenant_id),
  PRIMARY KEY (actor, request_key)
);
CREATE TABLE public.platform_agent_audit (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.platform_installations (tenant_id),
  actor text NOT NULL,
  event text NOT NULL CHECK (event IN ('TenantCreated', 'InstallationEnabled', 'InstallationDisabled')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.agent_documents (
  tenant_id uuid NOT NULL,
  application_id text NOT NULL,
  id uuid NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 8000),
  PRIMARY KEY (tenant_id, application_id, id),
  FOREIGN KEY (tenant_id, application_id) REFERENCES public.platform_installations (tenant_id, application_id)
);
ALTER TABLE public.agent_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_documents_scope ON public.agent_documents
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, DELETE ON public.agent_documents TO dap_app;
CREATE TABLE public.agent_proposals (
  proposal_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  application_id text NOT NULL,
  session_id uuid NOT NULL,
  guide_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  FOREIGN KEY (tenant_id, application_id) REFERENCES public.platform_installations (tenant_id, application_id)
);
ALTER TABLE public.agent_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_proposals FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_proposals_scope ON public.agent_proposals
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, DELETE ON public.agent_proposals TO dap_app;

-- The installation directory contains only metadata intentionally used to route public installs.
GRANT SELECT, INSERT, UPDATE ON public.platform_installations TO dap_app;
GRANT SELECT, INSERT ON public.platform_operations TO dap_app;
GRANT INSERT ON public.platform_agent_audit TO dap_app;
GRANT USAGE ON SEQUENCE public.platform_agent_audit_event_id_seq TO dap_app;
CREATE TABLE public.agent_rate_windows (
  tenant_id uuid NOT NULL REFERENCES public.platform_installations (tenant_id),
  bucket text NOT NULL,
  period bigint NOT NULL,
  count integer NOT NULL CHECK (count > 0),
  PRIMARY KEY (tenant_id, bucket)
);
ALTER TABLE public.agent_rate_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_rate_windows FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_rate_scope ON public.agent_rate_windows
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON public.agent_rate_windows TO dap_app;
