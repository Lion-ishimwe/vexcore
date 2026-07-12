# Deploying Bridge

Bridge deploys as **one Node process + MySQL**. The API server (`api/`) serves the
built web app (`web/dist`) itself, so there is no separate frontend host.

```
Internet → HTTPS (nginx or platform) → Node :4311 (API + web + /uploads) → MySQL
```

## Production checklist (any host)

| Item | How |
|---|---|
| `JWT_SECRET` | Long random string. `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `DATABASE_URL` | `mysql://user:password@host:3306/bridge` |
| `MOMO_NUMBER` / `MOMO_NAME` | The MoMo account subscribers pay into (shown at checkout) |
| `PORT` | Defaults to 4311 |
| Database schema | `cd api && npx prisma db push` |
| Super admin | `cd api && npm run seed` seeds demo data incl. `super@bridge.app` - **change its password immediately** (or create your own SUPER user and delete the demo). |
| Web build | `cd web && npm run build` (creates `web/dist`, auto-served by the API) |
| Uploads | `api/uploads/` holds all photos/videos/documents - must live on a **persistent disk** and be included in backups |
| Backups | Nightly `mysqldump bridge` + copy of `api/uploads/` |
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
JWT_SECRET="<long random string>"
MOMO_NUMBER="07xx xxx xxx"
MOMO_NAME="Your Company Ltd"
PORT=4311
EOF
npx prisma db push
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

# 6. Nightly backup (crontab -e)
# 0 2 * * * mysqldump bridge | gzip > /opt/backups/bridge-$(date +\%F).sql.gz && cp -r /opt/bridge/api/uploads /opt/backups/uploads
```

Updating later: `git pull && cd api && npm ci && npx prisma db push && cd ../web && npm ci && npm run build && pm2 restart bridge`.

## Option B - Railway / Render (zero server admin, ~$10-20/month)

1. Push the repo to GitHub.
2. Create a **MySQL** database on the platform (Railway plugin / Render uses external MySQL, e.g. PlanetScale or Aiven).
3. Create a web service from the repo:
   - Build command: `cd web && npm ci && npm run build && cd ../api && npm ci && npx prisma db push`
   - Start command: `cd api && node src/server.js`
   - Attach a **persistent volume** mounted at `api/uploads` (photos/documents die on redeploy without it).
4. Set the env vars from the checklist. The platform gives you HTTPS and a domain out of the box.

## Notes

- The dev flow is unchanged: `npm run dev` in `api/` and `web/` still works exactly as before (Vite proxies to :4311 and no `dist` is involved).
- If you later move to PostgreSQL (recommended when going managed-cloud), only `provider` in `api/prisma/schema.prisma` and `DATABASE_URL` change.
- The attendance kiosk uses the phone camera - it only works over HTTPS, so don't skip the certificate.
