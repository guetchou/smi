#!/bin/bash
# =============================================================================
# test_backup.sh — Vérifie l'intégrité du dernier backup (ou d'un backup donné)
#
# Usage  : ./test_backup.sh [chemin_backup.db]
# Cron   : 30 2 * * * /opt/frappe_docker/caisse-topcenter/scripts/test_backup.sh
#          (à lancer 30min après backup_db.sh)
#
# Retourne 0 si tous les tests passent, non-zéro sinon.
# =============================================================================
set -euo pipefail

BACKUP_BASE="/opt/backups/caisse-topcenter/daily"
LOG_FILE="/var/log/caisse-backup.log"
RESTORE_TEST_DIR="/tmp/caisse-restore-test-$$"
PASS=0
FAIL=0

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [TEST] $*" | tee -a "$LOG_FILE"
}

pass() { log "  ✔ $*"; PASS=$((PASS+1)); }
fail() { log "  ✘ $*"; FAIL=$((FAIL+1)); }

# ── Sélectionner le backup à tester ──────────────────────────────────────────
if [ -n "${1:-}" ]; then
  BACKUP_FILE="$1"
else
  BACKUP_FILE="$(find "$BACKUP_BASE" -name "caisse_*.db" -type f 2>/dev/null | sort | tail -1)"
fi

if [ -z "$BACKUP_FILE" ] || [ ! -f "$BACKUP_FILE" ]; then
  log "ERREUR : Aucun backup trouvé dans $BACKUP_BASE"
  exit 1
fi

log "======================================================="
log "Test backup : $(basename "$BACKUP_FILE")"
log "Chemin      : $BACKUP_FILE"
log "Taille      : $(du -sh "$BACKUP_FILE" | cut -f1)"
log "Modifié     : $(date -r "$BACKUP_FILE" '+%Y-%m-%d %H:%M:%S')"
log "======================================================="

# ── Vérifier que sqlite3 est disponible ───────────────────────────────────────
if ! command -v sqlite3 &>/dev/null; then
  log "ERREUR : sqlite3 non disponible — impossible de tester (apt install sqlite3)"
  exit 1
fi

# ── Test 1 : Intégrité SQLite ─────────────────────────────────────────────────
INTEGRITY="$(sqlite3 "$BACKUP_FILE" "PRAGMA integrity_check;" 2>&1 | head -1)"
if [ "$INTEGRITY" = "ok" ]; then
  pass "Intégrité SQLite (PRAGMA integrity_check)"
else
  fail "Intégrité SQLite : $INTEGRITY"
fi

# ── Test 2 : Tables critiques présentes ───────────────────────────────────────
TABLES="$(sqlite3 "$BACKUP_FILE" ".tables" 2>&1)"
for table in users employes operations bulletins_salaire employes_avances; do
  if echo "$TABLES" | grep -qw "$table"; then
    pass "Table '$table' présente"
  else
    fail "Table '$table' ABSENTE"
  fi
done

# ── Test 3 : Données lisibles ─────────────────────────────────────────────────
USERS="$(sqlite3  "$BACKUP_FILE" "SELECT COUNT(*) FROM users;"      2>&1)"
AGENTS="$(sqlite3 "$BACKUP_FILE" "SELECT COUNT(*) FROM employes;"   2>&1)"
OPS="$(sqlite3    "$BACKUP_FILE" "SELECT COUNT(*) FROM operations;"  2>&1)"
BULS="$(sqlite3   "$BACKUP_FILE" "SELECT COUNT(*) FROM bulletins_salaire;" 2>&1)"

if [[ "$USERS"  =~ ^[0-9]+$ ]]; then pass "Lecture users : $USERS enregistrement(s)";  else fail "Lecture users : $USERS";  fi
if [[ "$AGENTS" =~ ^[0-9]+$ ]]; then pass "Lecture employes : $AGENTS enregistrement(s)"; else fail "Lecture employes : $AGENTS"; fi
if [[ "$OPS"    =~ ^[0-9]+$ ]]; then pass "Lecture operations : $OPS enregistrement(s)";  else fail "Lecture operations : $OPS";  fi
if [[ "$BULS"   =~ ^[0-9]+$ ]]; then pass "Lecture bulletins : $BULS enregistrement(s)";  else fail "Lecture bulletins : $BULS";  fi

# ── Test 4 : Simulation restauration ─────────────────────────────────────────
mkdir -p "$RESTORE_TEST_DIR"
RESTORE_PATH="$RESTORE_TEST_DIR/caisse_restore.db"

sqlite3 "$BACKUP_FILE" ".backup '$RESTORE_PATH'" 2>&1
RESTORE_CHECK="$(sqlite3 "$RESTORE_PATH" "PRAGMA integrity_check;" 2>&1 | head -1)"
RESTORE_USERS="$(sqlite3 "$RESTORE_PATH" "SELECT COUNT(*) FROM users;" 2>&1)"
rm -rf "$RESTORE_TEST_DIR"

if [ "$RESTORE_CHECK" = "ok" ] && [[ "$RESTORE_USERS" =~ ^[0-9]+$ ]]; then
  pass "Restauration simulée (backup → copie → lecture) : OK"
else
  fail "Restauration simulée : integrity=$RESTORE_CHECK users=$RESTORE_USERS"
fi

# ── Résumé ────────────────────────────────────────────────────────────────────
log "======================================================="
log "Résultat : $PASS tests OK  |  $FAIL échec(s)"

if [ "$FAIL" -eq 0 ]; then
  log "VERDICT : Backup VALIDE — restauration possible"
  log "======================================================="
  exit 0
else
  log "VERDICT : Backup INVALIDE — vérifier immédiatement"
  log "======================================================="
  exit 2
fi
