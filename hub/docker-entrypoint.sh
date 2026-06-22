#!/bin/sh
set -e

# Ensure the data dir exists (mounted volume) and the SQLite schema is applied.
mkdir -p "$(dirname "${DATABASE_URL#file:}")" "$STORAGE_DIR"
echo "Applying database schema..."
npx prisma db push --skip-generate

# Seed the Windows client into the downloads folder so the dashboard's Setup tab
# can serve it on a fresh install. Only when it's missing, so a manually-updated
# copy is never clobbered.
DOWNLOADS="$STORAGE_DIR/downloads"
mkdir -p "$DOWNLOADS"
if [ ! -f "$DOWNLOADS/GameSyncClient-win-x64.zip" ] && [ -f /app/bundled/GameSyncClient-win-x64.zip ]; then
  cp /app/bundled/GameSyncClient-win-x64.zip "$DOWNLOADS/GameSyncClient-win-x64.zip"
  echo "Seeded Windows client into $DOWNLOADS."
fi

exec "$@"
