#!/bin/bash
set -e

echo "Generating Prisma client..."
npx prisma generate

echo "Starting backend application..."
exec "$@"

