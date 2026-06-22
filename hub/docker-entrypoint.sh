#!/bin/sh
set -e

# Ensure the data dir exists (mounted volume) and the SQLite schema is applied.
mkdir -p "$(dirname "${DATABASE_URL#file:}")" "$STORAGE_DIR"
echo "Applying database schema..."
npx prisma db push --skip-generate

exec "$@"
