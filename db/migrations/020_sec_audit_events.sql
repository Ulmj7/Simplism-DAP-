-- T093: the durable, append-only audit trail (AuditEvent contract, FR-037..FR-042). Only dap_owner may apply/own this migration.
DO $$
BEGIN
  IF current_user <> 'dap_owner' THEN RAISE EXCEPTION 'Audit migration requires dap_owner'; END IF;
END $$;

-- One row per AuditEvent, field for field. `seq` is an allocation-order column: it is not part of the event, it only makes the order of events
-- that share an instant deterministic. Every sanitization already happened in the event builder; the database stores what it is given
-- and refuses malformed rows (closed enums, shape of decision events, size of the projected params view) as a second line of defence.
CREATE TABLE IF NOT EXISTS public.sec_audit_events (
  seq bigint GENERATED ALWAYS AS IDENTITY,
  id uuid NOT NULL PRIMARY KEY,
  tenant_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL CHECK (isfinite(occurred_at)),
  event_type text NOT NULL CHECK (event_type IN (
    'AI_ACTION_PROPOSED','AI_ACTION_ALLOWED','AI_ACTION_DENIED','AI_CONFIRMATION_REQUIRED','AI_CONFIRMATION_ACCEPTED',
    'AI_CONFIRMATION_REJECTED','AI_POLICY_VIOLATION','AI_RATE_LIMITED','AI_ACTION_EXECUTED')),
  request_id text NOT NULL CHECK (char_length(request_id) BETWEEN 1 AND 256),
  decision_id text NOT NULL CHECK (char_length(decision_id) BETWEEN 1 AND 256),
  user_id text NOT NULL CHECK (char_length(user_id) BETWEEN 1 AND 256),
  ai_session_id text NOT NULL CHECK (char_length(ai_session_id) BETWEEN 1 AND 256),
  turn_id text NOT NULL CHECK (char_length(turn_id) BETWEEN 1 AND 256),
  model text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 256),
  action_id text CHECK (action_id IS NULL OR char_length(action_id) BETWEEN 1 AND 256),
  definition_version bigint CHECK (definition_version IS NULL OR definition_version BETWEEN 1 AND 9007199254740991),
  params_view jsonb NOT NULL CHECK (jsonb_typeof(params_view) = 'object' AND octet_length(params_view::text) <= 65536),
  risk text CHECK (risk IS NULL OR risk IN ('SAFE','LOW','MEDIUM','HIGH','CRITICAL','FORBIDDEN')),
  outcome text CHECK (outcome IS NULL OR outcome IN (
    'ALLOWED','DENIED','REQUIRES_CONFIRMATION','INVALID_ACTION','INVALID_PARAMETERS','UNAUTHORIZED','FORBIDDEN_POLICY')),
  reason text CHECK (reason IS NULL OR reason IN ('allowed','malformed_envelope','payload_too_large','unknown_action','reserved_forbidden_action','action_not_enabled','tenant_action_disabled','invalid_parameters','unauthenticated','session_expired','permission_missing','context_not_allowed','resource_not_available','tenant_mismatch','rate_limited_turn','rate_limited_user','rate_limited_tenant','rate_limited_capability','rate_limited_risk','denial_throttle','replayed_request','confirmation_required','confirmation_unknown','confirmation_expired','confirmation_consumed','confirmation_rejected','confirmation_mismatch','definition_changed','dependency_failure','audit_unavailable','state_unavailable','internal_error')),
  confirmation_id uuid,
  confirmation_state text CHECK (confirmation_state IS NULL OR confirmation_state IN ('pending','accepted','rejected','invalidated')),
  execution_result text CHECK (execution_result IS NULL OR execution_result IN ('success','failure')),
  resource_type text CHECK (resource_type IS NULL OR char_length(resource_type) BETWEEN 1 AND 256),
  resource_id text CHECK (resource_id IS NULL OR char_length(resource_id) BETWEEN 1 AND 256),
  -- A proposal has no decision yet; every other event type carries both an outcome and a reason (the contract).
  CHECK ((event_type = 'AI_ACTION_PROPOSED') = (outcome IS NULL)),
  CHECK ((event_type = 'AI_ACTION_PROPOSED') = (reason IS NULL)),
  CHECK ((event_type = 'AI_ACTION_EXECUTED') = (execution_result IS NOT NULL)),
  CHECK ((confirmation_id IS NULL) = (confirmation_state IS NULL)),
  CHECK ((resource_type IS NULL) = (resource_id IS NULL))
);
DO $$
BEGIN
  IF (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.sec_audit_events'::regclass) <> 'dap_owner' THEN
    RAISE EXCEPTION 'Audit table must be owned by dap_owner';
  END IF;
END $$;

ALTER TABLE public.sec_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sec_audit_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.sec_audit_events;
CREATE POLICY tenant_isolation ON public.sec_audit_events
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- The application may add events and read them back. Nothing else: no UPDATE, DELETE or TRUNCATE.
REVOKE ALL ON public.sec_audit_events FROM PUBLIC, dap_app;
GRANT SELECT, INSERT ON public.sec_audit_events TO dap_app;

CREATE INDEX IF NOT EXISTS sec_audit_events_tenant_time ON public.sec_audit_events (tenant_id, occurred_at, seq);
CREATE INDEX IF NOT EXISTS sec_audit_events_tenant_request ON public.sec_audit_events (tenant_id, request_id);
CREATE INDEX IF NOT EXISTS sec_audit_events_tenant_user_time ON public.sec_audit_events (tenant_id, user_id, occurred_at);

-- Belt and braces: even a role that owns the table (or is later granted more) cannot change or remove a recorded event.
CREATE OR REPLACE FUNCTION public.sec_audit_events_refuse() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'sec_audit_events is append-only' USING ERRCODE = 'insufficient_privilege';
END $$;
REVOKE ALL ON FUNCTION public.sec_audit_events_refuse() FROM PUBLIC;
DROP TRIGGER IF EXISTS sec_audit_events_no_row_change ON public.sec_audit_events;
CREATE TRIGGER sec_audit_events_no_row_change BEFORE UPDATE OR DELETE ON public.sec_audit_events
  FOR EACH ROW EXECUTE FUNCTION public.sec_audit_events_refuse();
DROP TRIGGER IF EXISTS sec_audit_events_no_truncate ON public.sec_audit_events;
CREATE TRIGGER sec_audit_events_no_truncate BEFORE TRUNCATE ON public.sec_audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.sec_audit_events_refuse();
