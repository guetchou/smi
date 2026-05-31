#!/bin/bash
# =============================================================================
# backup_db.sh — Sauvegarde journalière SQLite (safe WAL mode)
#
# Usage  : ./backup_db.sh
# Cron   : 0 2 * * * /opt/projet-smi/scripts/backup_db.sh
#
# - Utilise "sqlite3 .backup" (atomique, compatible WAL actif)
# - Vérifie l'intégrité du backup immédiatement après création
# - Conserve 14 jours, supprime le reste
# - Logs dans /var/log/caisse-backup.log
# =============================================================================
set -euo pipefail

BACKUP_BASE="/opt/backups/caisse-topcenter/daily"
RETENTION_DAYS=14
LOG_FILE="/var/log/caisse-backup.log"
DATE="$(date +%Y%m%d_%H%M%S)"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [BACKUP] $*" | tee -a "$LOG_FILE"
}

# ── Trouver la DB automatiquement ─────────────────────────────────────────────
find_db() {
  # Priorité 1 : volume Docker (production déployée)
  local docker_path="/var/lib/docker/volumes/caisse-topcenter_caisse_data/_data/caisse.db"
  # Priorité 2 : chemin direct (pm2 / dev)
  local dev_path="/opt/projet-smi/backend/data/caisse.db"

  if [ -f "$docker_path" ]; then
    echo "$docker_path"
  elif [ -f "$dev_path" ]; then
    echo "$dev_path"
  else
    find /opt -name "caisse.db" -type f 2>/dev/null | head -1
  fi
}

# ── Main ───────────────────────────────────────────────────────────────────────
DB_PATH="$(find_db)"

if [ -z "$DB_PATH" ]; then
  log "ERREUR : Aucune base caisse.db trouvée"
  exit 1
fi

log "Source : $DB_PATH"
mkdir -p "$BACKUP_BASE"

DEST="$BACKUP_BASE/caisse_${DATE}.db"

# Backup atomique — safe même avec WAL actif
if command -v sqlite3 &>/dev/null; then
  sqlite3 "$DB_PATH" ".backup '$DEST'"
  log "Méthode : sqlite3 .backup (WAL-safe)"
else
  # Fallback : copie directe (risque de fichier incohérent si WAL actif)
  log "AVERTISSEMENT : sqlite3 absent — copie directe (installer sqlite3 recommandé)"
  cp "$DB_PATH" "$DEST"
fi

# ── Vérification intégrité immédiate ──────────────────────────────────────────
if command -v sqlite3 &>/dev/null; then
  INTEGRITY="$(sqlite3 "$DEST" "PRAGMA integrity_check;" 2>&1 | head -1)"
  if [ "$INTEGRITY" = "ok" ]; then
    log "Intégrité : OK"
  else
    log "ERREUR intégrité backup : $INTEGRITY — déplacé en .corrupt"
    mv "$DEST" "${DEST}.corrupt"
    exit 2
  fi
fi

SIZE="$(du -sh "$DEST" | cut -f1)"
log "Backup : $DEST ($SIZE)"

# ── Nettoyage : conserver 14 jours ────────────────────────────────────────────
DELETED=$(find "$BACKUP_BASE" -name "caisse_*.db" -mtime +"$RETENTION_DAYS" -print -delete 2>/dev/null | wc -l)
[ "$DELETED" -gt 0 ] && log "Backups expirés supprimés : $DELETED"

TOTAL=$(find "$BACKUP_BASE" -name "caisse_*.db" 2>/dev/null | wc -l)
log "Total conservés : $TOTAL / rétention ${RETENTION_DAYS}j"
log "Backup terminé."
