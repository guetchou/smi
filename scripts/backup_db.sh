#!/bin/bash
# =============================================================================
# backup_db.sh — Sauvegarde journalière MySQL (production) avec fallback SQLite legacy
#
# Usage  : ./backup_db.sh
# Cron   : 0 2 * * * /opt/projet-smi/scripts/backup_db.sh
#
# - Production Docker : mysqldump MySQL depuis le conteneur mysql
# - Legacy uniquement : backup SQLite si DB_DRIVER != mysql
# - Conserve 14 jours, supprime le reste
# - Logs dans /var/log/caisse-backup.log
# =============================================================================
set -euo pipefail

PROJECT_DIR="/opt/projet-smi"
BACKUP_BASE="/opt/backups/caisse-topcenter/daily"
RETENTION_DAYS=14
LOG_FILE="/var/log/caisse-backup.log"
DATE="$(date +%Y%m%d_%H%M%S)"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [BACKUP] $*" | tee -a "$LOG_FILE"
}

load_env() {
  if [ -f "$PROJECT_DIR/.env" ]; then
    set -a
    # shellcheck disable=SC1091
    . "$PROJECT_DIR/.env"
    set +a
  fi
}

backup_mysql() {
  mkdir -p "$BACKUP_BASE"
  local dest="$BACKUP_BASE/mysql_${DATE}.sql.gz"
  log "Source : MySQL Docker (${MYSQL_DATABASE:-caisse_topcenter})"
  cd "$PROJECT_DIR"
  docker compose exec -T mysql sh -lc 'mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --routines --triggers "$MYSQL_DATABASE"' \
    | gzip > "$dest"
  gzip -t "$dest"
  log "Backup MySQL : $dest ($(du -sh "$dest" | cut -f1))"
  local deleted
  deleted=$(find "$BACKUP_BASE" -name "mysql_*.sql.gz" -mtime +"$RETENTION_DAYS" -print -delete 2>/dev/null | wc -l)
  [ "$deleted" -gt 0 ] && log "Backups MySQL expirés supprimés : $deleted"
}

find_sqlite_db() {
  local docker_path="/var/lib/docker/volumes/caisse-topcenter_caisse_data/_data/caisse.db"
  local dev_path="$PROJECT_DIR/backend/data/caisse.db"
  if [ -f "$docker_path" ]; then echo "$docker_path"
  elif [ -f "$dev_path" ]; then echo "$dev_path"
  else find /opt -name "caisse.db" -type f 2>/dev/null | head -1
  fi
}

backup_sqlite_legacy() {
  local db_path
  db_path="$(find_sqlite_db)"
  if [ -z "$db_path" ]; then
    log "ERREUR : aucune base SQLite legacy trouvée"
    exit 1
  fi
  mkdir -p "$BACKUP_BASE"
  local dest="$BACKUP_BASE/caisse_${DATE}.db"
  log "Source legacy SQLite : $db_path"
  if command -v sqlite3 &>/dev/null; then
    sqlite3 "$db_path" ".backup '$dest'"
    local integrity
    integrity="$(sqlite3 "$dest" "PRAGMA integrity_check;" 2>&1 | head -1)"
    [ "$integrity" = "ok" ] || { log "ERREUR intégrité SQLite : $integrity"; mv "$dest" "${dest}.corrupt"; exit 2; }
  else
    log "AVERTISSEMENT : sqlite3 absent — copie directe legacy"
    cp "$db_path" "$dest"
  fi
  log "Backup SQLite legacy : $dest ($(du -sh "$dest" | cut -f1))"
  find "$BACKUP_BASE" -name "caisse_*.db" -mtime +"$RETENTION_DAYS" -print -delete >/dev/null 2>&1 || true
}

load_env
mkdir -p "$(dirname "$LOG_FILE")" "$BACKUP_BASE"

if [ "${DB_DRIVER:-mysql}" = "mysql" ]; then
  backup_mysql
else
  log "DB_DRIVER=${DB_DRIVER:-non défini}; fallback SQLite legacy"
  backup_sqlite_legacy
fi

log "Backup terminé."
