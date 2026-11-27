ALTER TABLE public.platform_installations
  ADD COLUMN company_reg text UNIQUE,
  ADD COLUMN address text,
  ADD COLUMN phone_number text,
  ADD COLUMN contact_email text,
  ADD COLUMN allowed_origins text[],
  ADD COLUMN revision integer NOT NULL DEFAULT 0;

UPDATE public.platform_installations SET allowed_origins = ARRAY[origin];

ALTER TABLE public.platform_installations
  ALTER COLUMN allowed_origins SET NOT NULL,
  ADD CONSTRAINT platform_installations_origins_check
    CHECK (cardinality(allowed_origins) BETWEEN 1 AND 20 AND origin = allowed_origins[1]);

ALTER TABLE public.platform_agent_audit DROP CONSTRAINT platform_agent_audit_event_check;
ALTER TABLE public.platform_agent_audit ADD CONSTRAINT platform_agent_audit_event_check
  CHECK (event IN ('TenantCreated', 'TenantUpdated', 'InstallationEnabled', 'InstallationDisabled'));
