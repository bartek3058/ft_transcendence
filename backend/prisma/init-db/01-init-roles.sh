#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 \
    --username "$POSTGRES_USER" \
    --dbname "$POSTGRES_DB" \
    -v app_user="$APP_DB_USER" \
    -v app_pwd="$APP_DB_PASSWORD" \
    -v db_name="$POSTGRES_DB" <<-EOSQL
    SELECT format('CREATE ROLE %I WITH LOGIN PASSWORD %L', :'app_user', :'app_pwd')
    WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = :'app_user')
    \gexec

    GRANT CONNECT ON DATABASE :"db_name" TO :"app_user";
    GRANT USAGE ON SCHEMA public TO :"app_user";
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"app_user";
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO :"app_user";

    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_user";
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO :"app_user";
EOSQL


