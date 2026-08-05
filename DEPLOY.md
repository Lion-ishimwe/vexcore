# Deploying CMS (Construction Management System)

CMS deploys as **one Node process + MySQL**. The API server (`api/`) serves the
built web app (`web/dist`) itself, so there is no separate frontend host.

```
Internet → HTTPS (nginx or platform) → Node :4311 (API + web + /uploads) → MySQL
```

## Option 0 - Docker (easiest, works on any host with Docker)

Everything is prepared: `Dockerfile` (multi-stage: builds the web app, runs the API
which serves it), `docker-compose.yml` (app + MySQL + a nightly backup sidecar, with
persistent volumes for the database and uploads), and `docker-entrypoint.sh` (waits
for MySQL, applies migrations, optional demo seed).

```bash
cp .env.example .env        # then fill in DB_PASSWORD, JWT_SECRET, APP_URL, SMTP…
docker compose up -d --build
docker compose logs -f app  # watch it come up
```

The app is on `http://<host>:4311` (change with `APP_PORT` in `.env`).

**First boot of a fresh install**: set `SEED_DEMO=true` in `.env` for the first
`up` - it creates the Super Admin from `SUPER_EMAIL`/`SUPER_PASSWORD` in `.env`
(no default password exists; the seed refuses to run without a strong one) plus
the demo company. The seed is idempotent and skips itself once data exists.

**Then set `SEED_DEMO` back to `false` and remove the demo accounts** - they
share one password that is referenced throughout this repo:

```bash
docker compose exec app npm run purge:demo            # suspend the demo logins
docker compose exec app npm run purge:demo -- --wipe  # or delete the demo company
```

For a real deployment, skip `SEED_DEMO` entirely: create the Super Admin, sign
in, and register your own company through the normal sign-up flow.

Day-2 commands:

```bash
docker compose up -d --build          # redeploy after a code update (migrations apply on boot)
```

```bash
docker compose logs -f backup         # confirm nightly backups are running
```

An ad-hoc dump on top of the nightly ones:

```bash
docker compose exec db sh -c 'mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction bridge' > backup.sql
```

The password is read from inside the container: compose's `.env` is not exported
into your shell, so `-p"$DB_PASSWORD"` on the host fails with "Access denied".

## Backups (automatic)

The `backup` service dumps the database **and** snapshots uploads every night
into `./backups` on the host, keeping `BACKUP_KEEP_DAYS` (default 14). Both
halves matter: the database alone restores an app whose every photo is a broken
link; the uploads alone restore files nothing references.

```bash
BACKUP_HOUR=2          # local hour to run
BACKUP_KEEP_DAYS=14
BACKUP_ON_START=true   # set once to verify it works, then back to false
```

Old backups are pruned **only after a successful run**, so a spell of failures
cannot quietly delete your last good copy. `./backups` is a bind mount, so the
files survive `docker compose down -v`.

**This is not off-site.** A backup on the same disk as the database does not
survive losing the disk - sync `./backups` somewhere else (`rclone`, `restic`,
`aws s3 sync`, a nightly `scp`).

Restoring:

```bash
gunzip -c backups/db-2026-08-03-0200.sql.gz | docker compose exec -T db sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" bridge'
```

```bash
docker run --rm -v cms_uploads:/u -v "$PWD/backups":/b alpine sh -c 'rm -rf /u/* && tar xzf /b/uploads-2026-08-03-0200.tgz -C /u'
```

Test a restore into a scratch database before you need it - an untested backup
is a guess.

## Schema changes on a live database

The app uses **`prisma migrate`**, not `prisma db push`. Migrations live in
`api/prisma/migrations/`, are reviewable in the repo, and replay in the same
order on every environment. `db push` reshapes the database on the spot with no
history and no rollback, and on a destructive change either refuses (leaving the
deploy down) or drops columns full of real data.

`docker-entrypoint.sh` runs `node src/migrate.js` on boot, which:

1. waits for MySQL;
2. **baselines** an existing database that has no migration history - it marks
   `0_init` as already applied rather than recreating tables, so upgrading an
   installation that previously used `db push` is safe and loses nothing;
3. applies any pending migrations, and **fails the boot** rather than starting
   against a schema it could not bring up to date.

Changing the schema:

```bash
cd api && npm run migrate:new -- describe_your_change
```

That edits your **dev** database and writes a migration file - commit it. On the
server, `docker compose up -d --build` applies it. Check state at any time with
`npm run migrate:status`.

Before applying a migration that drops or rewrites a column on live data, take a
backup first (`BACKUP_ON_START=true`, or the ad-hoc dump above). A migration
that half-applies is restored from backup, not retried.

### Using a scoped database account (recommended, new installs)

The app connects as MySQL `root` by default so that existing deployments keep
working across an upgrade. On a **fresh** install, set `DB_APP_USER=bridge` and
`DB_APP_PASSWORD=<the DB_USER_PASSWORD value>` in `.env` before the first
`up` - the account is created during MySQL's first-boot initialisation.

On an **existing** deployment the account does not appear retroactively; create
it once, then set the two variables and redeploy:

```bash
docker compose exec db sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "CREATE USER IF NOT EXISTS '"'"'bridge'"'"'@'"'"'%'"'"' IDENTIFIED BY '"'"'YOUR_PASSWORD'"'"'; GRANT ALL ON bridge.* TO '"'"'bridge'"'"'@'"'"'%'"'"'; FLUSH PRIVILEGES;"'
```

Put nginx/Caddy (or your platform's load balancer) in front for HTTPS - required in
production for login tokens and phone-camera QR scanning.

## Production checklist (any host)

| Item | How |
|---|---|
| `JWT_SECRET` | **At least 32 characters** of randomness - the API refuses to start otherwise. `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `APP_URL` | The real public address, e.g. `https://app.yourdomain.com`. Password-reset emails link to it, and it is the browser origin the API accepts calls from. Getting this wrong sends users dead reset links. |
| `CORS_ORIGINS` | Only if the web app is served from somewhere other than `APP_URL` (comma-separated). |
| `TRUST_PROXY` | `1` behind nginx/a load balancer, so login rate limiting sees the real client IP rather than the proxy's. |
| `DATABASE_URL` | `mysql://user:password@host:3306/bridge` - use a scoped account, not root |
| `MOMO_NUMBER` / `MOMO_NAME` | The MoMo account subscribers pay into (shown at checkout) |
| `PORT` | Defaults to 4311 |
| Database schema | `cd api && npm run migrate` (waits for the DB, baselines if needed, applies migrations) |
| Super admin | `SUPER_EMAIL=you@yourdomain SUPER_PASSWORD='<long random>' npm run seed`. No default password exists; the seed refuses a weak one. |
| Demo accounts | Must not exist on a reachable instance - `npm run purge:demo` (or `-- --wipe`). Verify by trying a demo login and confirming it fails. |
| Web build | `cd web && npm run build` (creates `web/dist`, auto-served by the API) |
| Uploads | `api/uploads/` holds all photos/videos/documents - must live on a **persistent disk** and be included in backups |
| Backups | Docker: the `backup` service does it nightly. Otherwise a cron `mysqldump bridge` + copy of `api/uploads/`, held **off this machine** |
| HTTPS | Required in production (login tokens, camera access for QR scanning needs HTTPS) |

## Option A - VPS (recommended: full control, ~$5-10/month)

Works on DigitalOcean, Hetzner, Contabo, Vultr, Linode... Ubuntu 22.04+.

```bash
# 1. Base packages
sudo apt update && sudo apt install -y nginx mysql-server
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs
sudo npm i -g pm2

# 2. MySQL
sudo mysql -e "CREATE DATABASE bridge CHARACTER SET utf8mb4;
CREATE USER 'bridge'@'localhost' IDENTIFIED BY 'CHANGE_ME';
GRANT ALL ON bridge.* TO 'bridge'@'localhost'; FLUSH PRIVILEGES;"

# 3. App
cd /opt && sudo git clone <your-repo> bridge && cd bridge   # or rsync the folder
cd api && npm ci
cat > .env <<EOF
DATABASE_URL="mysql://bridge:CHANGE_ME@localhost:3306/bridge"
JWT_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")"
# APP_URL is NOT optional in production: reset-email links point at it and it is
# the browser origin the API accepts calls from.
APP_URL="https://app.yourdomain.com"
TRUST_PROXY=1
MOMO_NUMBER="07xx xxx xxx"
MOMO_NAME="Your Company Ltd"
PORT=4311
EOF
npm run migrate                       # baselines if needed, then applies migrations
cd ../web && npm ci && npm run build

# 4. Run under PM2 (auto-restart, boot persistence)
cd ../api && pm2 start src/server.js --name bridge && pm2 save && pm2 startup

# 5. nginx reverse proxy + HTTPS
sudo tee /etc/nginx/sites-available/bridge <<'EOF'
server {
  server_name app.yourdomain.com;
  client_max_body_size 60m;            # media uploads
  location / { proxy_pass http://127.0.0.1:4311; proxy_set_header Host $host; }
}
EOF
sudo ln -s /etc/nginx/sites-available/bridge /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d app.yourdomain.com                   # free HTTPS, auto-renews

# 6. Nightly backup - install it now, not "later"
sudo mkdir -p /opt/backups && sudo tee /usr/local/bin/cms-backup >/dev/null <<'EOF'
#!/bin/sh
set -eu
d=$(date +%F-%H%M)
mysqldump --single-transaction --quick --routines --events bridge | gzip > "/opt/backups/db-$d.sql.gz"
tar czf "/opt/backups/uploads-$d.tgz" -C /opt/bridge/api/uploads .
find /opt/backups -name 'db-*.sql.gz' -o -name 'uploads-*.tgz' -mtime +14 -delete
EOF
sudo chmod +x /usr/local/bin/cms-backup
sudo crontab -l 2>/dev/null | { cat; echo "0 2 * * * /usr/local/bin/cms-backup"; } | sudo crontab -
sudo /usr/local/bin/cms-backup && ls -lh /opt/backups   # prove it works today
```

Then sync `/opt/backups` off the machine (`rclone`, `restic`, `aws s3 sync`) -
a backup on the same disk as the database does not survive losing the disk.

Updating later: `git pull && cd api && npm ci && npm run migrate && cd ../web && npm ci && npm run build && pm2 restart bridge`.

## Option B - Railway / Render (zero server admin, ~$10-20/month)

1. Push the repo to GitHub.
2. Create a **MySQL** database on the platform (Railway plugin / Render uses external MySQL, e.g. PlanetScale or Aiven).
3. Create a web service from the repo:
   - Build command: `cd web && npm ci && npm run build && cd ../api && npm ci && npx prisma generate`
   - Start command: `cd api && npm run migrate && node src/server.js`
   - Migrations belong in the **start** command, not the build: build steps are
     not guaranteed network access to the database, so a schema step at build
     time fails on Railway and is unreliable on Render.
   - **Backups are yours to arrange here** - the compose backup sidecar does not
     exist on these platforms. Use the provider's managed-database backups (turn
     them on, and check the retention), plus a scheduled job that snapshots the
     uploads volume.
   - Attach a **persistent volume** mounted at `api/uploads` (photos/documents die on redeploy without it).
4. Set the env vars from the checklist. The platform gives you HTTPS and a domain out of the box.

## Notes

- The dev flow is unchanged: `npm run dev` in `api/` and `web/` still works exactly as before (Vite proxies to :4311 and no `dist` is involved).
- If you later move to PostgreSQL (recommended when going managed-cloud), only `provider` in `api/prisma/schema.prisma` and `DATABASE_URL` change.
- The attendance kiosk uses the phone camera - it only works over HTTPS, so don't skip the certificate.
