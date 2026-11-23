-- Keep the already-applied 010 checksum intact; restore the exact application ACL on upgrades.
DO $$
BEGIN
  IF current_user <> 'dap_owner' OR
    (SELECT pg_get_userbyid(relowner) FROM pg_class
      WHERE oid = 'public.sec_tenant_action_policy'::regclass) <> 'dap_owner' THEN
    RAISE EXCEPTION 'Tenant policy migrations require dap_owner table ownership';
  END IF;
END
$$;

REVOKE ALL ON TABLE public.sec_tenant_action_policy FROM PUBLIC, dap_app;
GRANT SELECT, INSERT, UPDATE ON TABLE public.sec_tenant_action_policy TO dap_app;
