#!/bin/sh
# CMS (Construction Management System) app container entrypoint:
# 1. wait for MySQL and sync the schema (prisma db push - the project's workflow)
# 2. optionally load the demo dataset (SEED_DEMO=true, first boot only)
# 3. start the API, which also serves the built web app
set -e

echo "[cms] syncing database schema..."
tries=0
until npx prisma db push --skip-generate; do
  tries=$((tries + 1))
  if [ "$tries" -ge 30 ]; then
    echo "[cms] database still unreachable after $tries attempts - giving up"
    exit 1
  fi
  echo "[cms] database not ready (attempt $tries) - retrying in 3s"
  sleep 3
done

if [ "$SEED_DEMO" = "true" ]; then
  echo "[cms] loading demo data (SEED_DEMO=true)..."
  node src/seed.js || echo "[cms] seed skipped/failed (probably already seeded) - continuing"
fi

echo "[cms] starting the app on port ${PORT:-4311}"
exec node src/server.js
