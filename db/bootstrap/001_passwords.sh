#!/bin/sh
set -eu
psql --set=ON_ERROR_STOP=1 --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" \
  --set=owner_password="$DAP_OWNER_PASSWORD" --set=app_password="$DAP_APP_PASSWORD" \
  --set=database_name="$POSTGRES_DB" <<'SQL'
ALTER ROLE dap_owner PASSWORD :'owner_password';
ALTER ROLE dap_app PASSWORD :'app_password';
ALTER DATABASE :"database_name" OWNER TO dap_owner;
SQL
