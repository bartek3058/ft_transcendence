#!/bin/bash
set -e

echo "Generating Prisma client..."
npx prisma generate

echo "Applying migrations with owner role..."
DATABASE_URL="$MIGRATION_DATABASE_URL" npx prisma migrate deploy

echo "Running database seed..."
DATABASE_URL="$MIGRATION_DATABASE_URL" npx prisma db seed || true

echo "Starting backend application..."
exec "$@"
