#!/bin/sh
# Redeploy CMS to production.
#
#   ./deploy.sh
#
# The server has 908 MB of RAM, which is not enough to run vite, so the front
# end is built HERE and the finished files are uploaded. Everything else - API
# dependencies, database migrations, restart - is done by the post-receive hook
# on the server, so a push alone is a valid deploy of API-only changes.
#
# Secrets and uploaded files live in /srv/cms-shared on the server and are
# symlinked into the checkout, so no deploy can overwrite or delete them.
set -eu

REMOTE=${REMOTE:-production}
HOST=${HOST:-cms-prod}
BRANCH=$(git rev-parse --abbrev-ref HEAD)

if [ "$BRANCH" != "main" ]; then
  echo "You are on '$BRANCH'. The deploy hook only acts on 'main'."
  echo "Switch branches or push explicitly: git push $REMOTE $BRANCH:main"
  exit 1
fi

if ! git diff-index --quiet HEAD -- 2>/dev/null; then
  echo "Uncommitted changes - commit them first, or they will not be deployed:"
  git status --short
  exit 1
fi

echo "==> building the front end locally"
( cd web && npx vite build )

echo "==> pushing code (triggers install + migrations + restart on the server)"
git push "$REMOTE" main

echo "==> uploading the built front end"
tar czf - -C web dist | ssh "$HOST" 'rm -rf /srv/cms/web/dist && mkdir -p /srv/cms/web && tar xzf - -C /srv/cms/web'

echo "==> restarting so the new front end is served"
ssh "$HOST" 'sudo systemctl restart cms-api && sleep 2 && systemctl is-active cms-api'

echo "==> verifying"
ssh "$HOST" 'curl -fsS -o /dev/null -w "   local  /healthz -> %{http_code}\n" http://127.0.0.1:4311/healthz'
curl -fsS -o /dev/null -w "   public /healthz -> %{http_code}\n" "http://$(ssh "$HOST" 'curl -s -4 ifconfig.me')/healthz" || true

echo "Deployed $(git rev-parse --short HEAD)"
