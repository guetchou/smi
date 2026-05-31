#!/bin/bash
# =============================================================================
# rollback.sh — Retour au dernier commit stable
#
# Usage : sudo ./rollback.sh [--commit <sha>] [--dry-run]
#
# Par défaut : lit /opt/releases/last_stable.txt
# Option     : passer un SHA explicite avec --commit
#
# ⚠ NE rollback PAS la base de données automatiquement.
#   Pour restaurer la DB : utiliser test_backup.sh + backup manuel.
#
# Journal : /var/log/caisse-rollback.log
# =============================================================================
set -euo pipefail

PROJECT_DIR="/opt/projet-smi"
STABLE_FILE="/opt/releases/last_stable.txt"
LOG_FILE="/var/log/caisse-rollback.log"
APP_NAME="caisse-topcenter"
DRY_RUN=0
TARGET_COMMIT=""

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

# ── Parsing arguments ─────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --commit) TARGET_COMMIT="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "Usage: $0 [--commit <sha>] [--dry-run]"; exit 1 ;;
  esac
done

# ── Résoudre le commit cible ───────────────────────────────────────────────────
if [ -z "$TARGET_COMMIT" ]; then
  if [ ! -f "$STABLE_FILE" ]; then
    log "ERREUR : $STABLE_FILE introuvable — spécifiez --commit <sha>"
    exit 1
  fi
  # Lire le SHA (première ligne non-commentaire)
  TARGET_COMMIT=$(grep -v '^#' "$STABLE_FILE" | head -1 | tr -d '[:space:]')
fi

if [ -z "$TARGET_COMMIT" ]; then
  log "ERREUR : commit cible vide dans $STABLE_FILE"
  exit 1
fi

log "=============================================="
log "  ROLLBACK — Caisse TOP CENTER"
log "  Commit cible : $TARGET_COMMIT"
[ "$DRY_RUN" -eq 1 ] && log "  MODE DRY-RUN (aucune modification)"
log "=============================================="

# ── Snapshot du commit courant ────────────────────────────────────────────────
CURRENT=$(git -C "$PROJECT_DIR" rev-parse HEAD 2>/dev/null || echo "inconnu")
log "Commit actuel : $CURRENT"

if [ "$CURRENT" = "$TARGET_COMMIT" ]; then
  log "Déjà sur le commit cible — rien à faire."
  exit 0
fi

if [ "$DRY_RUN" -eq 1 ]; then
  log "DRY-RUN : rollback simulé de $CURRENT → $TARGET_COMMIT"
  log "Exécuter sans --dry-run pour appliquer."
  exit 0
fi

# ── 1. Vérifier que le commit existe ──────────────────────────────────────────
log "[1/4] Fetch origin + vérification commit..."
git -C "$PROJECT_DIR" fetch origin 2>&1 | while read -r line; do log "  git: $line"; done || true

if ! git -C "$PROJECT_DIR" cat-file -e "${TARGET_COMMIT}^{commit}" 2>/dev/null; then
  log "ERREUR : commit $TARGET_COMMIT introuvable après fetch"
  exit 1
fi
log "      Commit vérifié."

# ── 2. Sauvegarder la DB avant rollback (sécurité) ────────────────────────────
log "[2/4] Backup DB pré-rollback..."
ROLLBACK_BACKUP_DIR="/opt/backups/caisse-topcenter/rollback"
mkdir -p "$ROLLBACK_BACKUP_DIR"
BACKUP_SCRIPT="$PROJECT_DIR/scripts/backup_db.sh"
if [ -f "$BACKUP_SCRIPT" ]; then
  BACKUP_DIR_ORIG="/opt/backups/caisse-topcenter/daily"
  # Backup rapide vers dossier rollback
  DB_PATH=$(find /var/lib/docker/volumes/caisse-topcenter_caisse_data/_data /opt/projet-smi/backend/data -name "caisse.db" 2>/dev/null | head -1 || true)
  if [ -n "$DB_PATH" ] && [ -f "$DB_PATH" ]; then
    ROLLBACK_DB="$ROLLBACK_BACKUP_DIR/pre_rollback_$(date +%Y%m%d_%H%M%S).db"
    sqlite3 "$DB_PATH" ".backup '$ROLLBACK_DB'" 2>/dev/null || cp "$DB_PATH" "$ROLLBACK_DB"
    log "      DB sauvegardée : $ROLLBACK_DB"
  else
    log "      AVERTISSEMENT : DB introuvable, pas de backup pré-rollback"
  fi
else
  log "      AVERTISSEMENT : backup_db.sh absent"
fi

# ── 3. Checkout du commit stable ──────────────────────────────────────────────
log "[3/4] Checkout $TARGET_COMMIT..."
git -C "$PROJECT_DIR" checkout "$TARGET_COMMIT" -- . 2>&1 | while read -r line; do log "  git: $line"; done

# Vérifier si package.json a changé → npm install
if git -C "$PROJECT_DIR" diff HEAD "$TARGET_COMMIT" -- backend/package.json 2>/dev/null | grep -q .; then
  log "      package.json modifié — npm install..."
  npm install --prefix "$PROJECT_DIR/backend" --production --silent 2>&1 | while read -r line; do log "  npm: $line"; done
  log "      npm install terminé."
fi

log "      Code rollbacké."

# ── 4. Redémarrage PM2 ────────────────────────────────────────────────────────
log "[4/4] Redémarrage PM2..."
if command -v pm2 &>/dev/null; then
  pm2 reload "$APP_NAME" 2>&1 | tail -3 | while read -r line; do log "  pm2: $line"; done
  sleep 3
  # Vérification
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://localhost:3337/api/health 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" = "200" ]; then
    log "      App opérationnelle (HTTP 200)."
  else
    log "      AVERTISSEMENT : app répond HTTP $HTTP_CODE — vérifier manuellement"
  fi
else
  log "      AVERTISSEMENT : PM2 absent — relancer manuellement l'application"
fi

log "=============================================="
log "  ROLLBACK TERMINÉ"
log "  De   : $CURRENT"
log "  Vers : $TARGET_COMMIT"
log "  ⚠ La DB n'a PAS été rollbackée"
log "  Backup pré-rollback : $ROLLBACK_BACKUP_DIR"
log "=============================================="

# ── Mise à jour last_stable ne se fait PAS automatiquement ────────────────────
# Le rollback ne reécrit pas last_stable.txt
# Après validation manuelle, mettre à jour avec :
#   git -C /opt/projet-smi rev-parse HEAD > /opt/releases/last_stable.txt
