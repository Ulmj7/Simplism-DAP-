-- Feature 004 product usage. Append-only browser reports kept separate from the security audit.
DO $$
BEGIN
  IF current_user <> 'dap_owner' THEN RAISE EXCEPTION 'Walkthrough events migration requires dap_owner'; END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.walkthrough_events (
  tenant_id uuid NOT NULL,
  walkthrough_id text NOT NULL CHECK (walkthrough_id ~ '^[a-zA-Z][A-Za-z0-9_-]{0,63}$'),
  run_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('started', 'completed', 'cancelled')),
  occurred_at timestamptz NOT NULL DEFAULT now() CHECK (isfinite(occurred_at)),
  PRIMARY KEY (tenant_id, run_id, event_type)
);
DO $$
BEGIN
  IF (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.walkthrough_events'::regclass) <> 'dap_owner' THEN
    RAISE EXCEPTION 'Walkthrough events table must be owned by dap_owner';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS walkthrough_events_one_terminal
  ON public.walkthrough_events (tenant_id, run_id) WHERE event_type <> 'started';

ALTER TABLE public.walkthrough_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.walkthrough_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.walkthrough_events;
CREATE POLICY tenant_isolation ON public.walkthrough_events
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

REVOKE ALL ON public.walkthrough_events FROM PUBLIC, dap_app;
GRANT SELECT, INSERT ON public.walkthrough_events TO dap_app;

CREATE OR REPLACE FUNCTION public.walkthrough_events_refuse() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'walkthrough_events is append-only' USING ERRCODE = 'insufficient_privilege';
END $$;
REVOKE ALL ON FUNCTION public.walkthrough_events_refuse() FROM PUBLIC;
DROP TRIGGER IF EXISTS walkthrough_events_no_row_change ON public.walkthrough_events;
CREATE TRIGGER walkthrough_events_no_row_change BEFORE UPDATE OR DELETE ON public.walkthrough_events
  FOR EACH ROW EXECUTE FUNCTION public.walkthrough_events_refuse();
DROP TRIGGER IF EXISTS walkthrough_events_no_truncate ON public.walkthrough_events;
CREATE TRIGGER walkthrough_events_no_truncate BEFORE TRUNCATE ON public.walkthrough_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.walkthrough_events_refuse();
