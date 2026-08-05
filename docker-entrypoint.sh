#!/bin/sh
# CMS (Construction Management System) app container entrypoint:
# 1. wait for MySQL and apply migrations (see src/migrate.js)
# 2. optionally load the demo dataset (SEED_DEMO=true, first boot only)
# 3. start the API, which also serves the built web app
set -e

# Fail loudly on a missing/weak secret rather than 30 confusing schema retries.
if [ -z "$JWT_SECRET" ] || [ "$(printf %s "$JWT_SECRET" | wc -c)" -lt 32 ]; then
  echo "[cms] FATAL: JWT_SECRET must be set to at least 32 characters."
  echo "[cms] generate one with: node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\""
  exit 1
fi

# Waits for MySQL, baselines a pre-migrations database if needed, then applies
# pending migrations. Fails the boot rather than starting against a schema it
# could not bring up to date.
node src/migrate.js

if [ "$SEED_DEMO" = "true" ]; then
  echo "[cms] loading demo data (SEED_DEMO=true)..."
  node src/seed.js || echo "[cms] seed skipped/failed (probably already seeded) - continuing"
fi

echo "[cms] starting the app on port ${PORT:-4311}"
exec node src/server.js
