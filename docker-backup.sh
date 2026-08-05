#!/bin/sh
# Nightly backup sidecar: database dump + uploads snapshot, with retention.
#
# A live deployment holds data that exists nowhere else - daily reports, wage
# records, site photos. Both halves matter: the database alone restores an app
# whose every photo and document is a broken link, and the uploads alone restore
# files nothing references.
#
# Writes to /backups (bind-mounted to ./backups on the host, so backups survive
# `docker compose down -v`). Copy them off this machine as well - a backup on
# the same disk as the database does not survive losing the disk.
set -eu

HOUR="${BACKUP_HOUR:-2}"          # local hour to run at (0-23)
KEEP="${BACKUP_KEEP_DAYS:-14}"    # delete backups older than this
DB_HOST="${DB_HOST:-db}"
DB_NAME="${DB_NAME:-bridge}"
DB_USER="${DB_USER_NAME:-root}"

log() { echo "[backup] $(date '+%F %T') $*"; }

run_backup() {
  stamp=$(date +%F-%H%M)
  ok=0

  # --single-transaction keeps the dump consistent without locking the app out.
  if mysqldump -h "$DB_HOST" -u "$DB_USER" \
      --single-transaction --quick --routines --events --no-tablespaces \
      "$DB_NAME" 2>/tmp/dump.err | gzip > "/backups/db-$stamp.sql.gz.part"; then
    mv "/backups/db-$stamp.sql.gz.part" "/backups/db-$stamp.sql.gz"
    log "database  -> db-$stamp.sql.gz ($(du -h "/backups/db-$stamp.sql.gz" | cut -f1))"
  else
    rm -f "/backups/db-$stamp.sql.gz.part"
    log "DATABASE BACKUP FAILED: $(tr '\n' ' ' < /tmp/dump.err)"
    ok=1
  fi

  if tar czf "/backups/uploads-$stamp.tgz.part" -C /uploads . 2>/tmp/tar.err; then
    mv "/backups/uploads-$stamp.tgz.part" "/backups/uploads-$stamp.tgz"
    log "uploads   -> uploads-$stamp.tgz ($(du -h "/backups/uploads-$stamp.tgz" | cut -f1))"
  else
    rm -f "/backups/uploads-$stamp.tgz.part"
    log "UPLOADS BACKUP FAILED: $(tr '\n' ' ' < /tmp/tar.err)"
    ok=1
  fi

  # Retention only runs after a successful pair, so a run of failures can never
  # quietly delete the last good backup.
  if [ "$ok" -eq 0 ]; then
    deleted=$(find /backups -maxdepth 1 \( -name 'db-*.sql.gz' -o -name 'uploads-*.tgz' \) -mtime "+$KEEP" -print -delete | wc -l)
    [ "$deleted" -gt 0 ] && log "pruned $deleted file(s) older than $KEEP days"
  else
    log "retention skipped - this run had a failure"
  fi
  return "$ok"
}

mkdir -p /backups
log "backup sidecar started: daily at ${HOUR}:00, keeping ${KEEP} days"
[ "${BACKUP_ON_START:-false}" = "true" ] && { log "BACKUP_ON_START set - running now"; run_backup || true; }

while true; do
  h=$(date +%-H); m=$(date +%-M); s=$(date +%-S)
  wait_s=$(( ((HOUR - h + 24) % 24) * 3600 - m * 60 - s ))
  [ "$wait_s" -le 0 ] && wait_s=$(( wait_s + 86400 ))
  log "next run in $((wait_s / 3600))h $(((wait_s % 3600) / 60))m"
  sleep "$wait_s"
  run_backup || true
done
