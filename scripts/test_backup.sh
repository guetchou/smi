#!/bin/bash
# =============================================================================
# test_backup.sh — Vérifie le dernier backup MySQL (ou SQLite legacy si fourni)
#
# Usage  : ./test_backup.sh [chemin_backup.sql.gz|chemin_backup.db]
# Cron   : 30 2 * * * /opt/projet-smi/scripts/test_backup.sh
#
# Retourne 0 si tous les tests passent, non-zéro sinon.
# =============================================================================
set -euo pipefail

BACKUP_BASE="/opt/backups/caisse-topcenter/daily"
LOG_FILE="/var/log/caisse-backup.log"
PASS=0
FAIL=0

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [TEST] $*" | tee -a "$LOG_FILE"; }
pass() { log "  OK  $*"; PASS=$((PASS+1)); }
fail() { log "  ERR $*"; FAIL=$((FAIL+1)); }

pick_backup() {
  if [ -n "${1:-}" ]; then
    echo "$1"
  else
    find "$BACKUP_BASE" \( -name "mysql_*.sql.gz" -o -name "caisse_*.db" \) -type f 2>/dev/null | sort | tail -1
  fi
}

test_mysql_backup() {
  local backup_file="$1"
  if ! gzip -t "$backup_file"; then
    fail "Archive gzip invalide"
    return
  fi
  pass "Archive gzip lisible"

  local header
  header="$(gzip -cd "$backup_file" | head -40)"
  echo "$header" | grep -q "MySQL dump" && pass "Format mysqldump détecté" || fail "Format mysqldump non détecté"
  for table in users employes operations bulletins_salaire employes_avances; do
    if gzip -cd "$backup_file" | grep -q "Table structure for table .$table."; then
      pass "Table '$table' présente dans le dump"
    else
      fail "Table '$table' absente du dump"
    fi
  done
}

test_sqlite_backup() {
  local backup_file="$1"
  if ! command -v sqlite3 &>/dev/null; then
    fail "sqlite3 absent — impossible de tester le backup legacy"
    return
  fi
  local integrity
  integrity="$(sqlite3 "$backup_file" "PRAGMA integrity_check;" 2>&1 | head -1)"
  [ "$integrity" = "ok" ] && pass "Intégrité SQLite" || fail "Intégrité SQLite : $integrity"
  local tables
  tables="$(sqlite3 "$backup_file" ".tables" 2>&1)"
  for table in users employes operations bulletins_salaire employes_avances; do
    echo "$tables" | grep -qw "$table" && pass "Table '$table' présente" || fail "Table '$table' absente"
  done
}

BACKUP_FILE="$(pick_backup "${1:-}")"
if [ -z "$BACKUP_FILE" ] || [ ! -f "$BACKUP_FILE" ]; then
  log "ERREUR : Aucun backup trouvé dans $BACKUP_BASE"
  exit 1
fi

log "======================================================="
log "Test backup : $(basename "$BACKUP_FILE")"
log "Chemin      : $BACKUP_FILE"
log "Taille      : $(du -sh "$BACKUP_FILE" | cut -f1)"
log "======================================================="

case "$BACKUP_FILE" in
  *.sql.gz) test_mysql_backup "$BACKUP_FILE" ;;
  *.db)     test_sqlite_backup "$BACKUP_FILE" ;;
  *)        fail "Type de backup non supporté" ;;
esac

log "Résultat : $PASS tests OK | $FAIL échec(s)"
if [ "$FAIL" -eq 0 ]; then
  log "VERDICT : Backup VALIDE"
  exit 0
fi
log "VERDICT : Backup INVALIDE"
exit 2
