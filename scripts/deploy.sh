#!/bin/bash
# =============================================================================
# deploy.sh — Déploiement production Caisse TOP CENTER
# Appelé par GitHub Actions à chaque push sur main.
#
# ⛔ NE JAMAIS utiliser docker-compose down -v (supprime les données !)
# =============================================================================
set -e

PROJECT_DIR="/opt/caisse-topcenter"
BACKUP_DIR="/opt/backups/caisse-topcenter"
DB_VOLUME_PATH="/var/lib/docker/volumes/caisse-topcenter_caisse_data/_data/caisse.db"
DATE=$(date +%Y%m%d_%H%M%S)
BRANCH="${DEPLOY_BRANCH:-main}"

echo "=============================================="
echo "  DÉPLOIEMENT — Caisse TOP CENTER"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "=============================================="

# ── 1. Backup automatique de la DB ────────────────────────────────────────────
echo "[1/5] Backup de la base de données..."
mkdir -p "$BACKUP_DIR/daily"
if [ -f "$DB_VOLUME_PATH" ]; then
  # sqlite3 .backup est atomique et safe même avec WAL actif (contrairement à cp)
  if command -v sqlite3 &>/dev/null; then
    sqlite3 "$DB_VOLUME_PATH" ".backup '$BACKUP_DIR/daily/caisse_${DATE}.db'"
    echo "      ✅ Backup WAL-safe : $BACKUP_DIR/daily/caisse_${DATE}.db"
  else
    cp "$DB_VOLUME_PATH" "$BACKUP_DIR/daily/caisse_${DATE}.db"
    echo "      ⚠️  Backup (cp) : sqlite3 absent, installer avec apt install sqlite3"
  fi
  # Nettoyage : garder 14 jours
  find "$BACKUP_DIR/daily" -name "caisse_*.db" -mtime +14 -delete
  echo "      ✅ Backups conservés : $(find "$BACKUP_DIR/daily" -name "caisse_*.db" | wc -l)"
else
  echo "      ⚠️  Aucune DB existante (premier déploiement)"
fi

# ── 2. Récupérer le code depuis GitHub ────────────────────────────────────────
echo "[2/5] Mise à jour du code..."
cd "$PROJECT_DIR"

if [ ! -d .git ]; then
  echo "      Init git..."
  git init
  git remote add origin https://github.com/guetchou/smi.git
fi

git fetch origin "$BRANCH"
git reset --hard "origin/$BRANCH"
echo "      ✅ Code mis à jour ($(git rev-parse --short HEAD))"

# ── 3. Rebuild de l'image Docker ──────────────────────────────────────────────
echo "[3/5] Build de l'image Docker..."
docker compose build caisse
echo "      ✅ Image construite"

# ── 4. Redémarrage du conteneur (SANS -v) ─────────────────────────────────────
echo "[4/5] Redémarrage du conteneur..."
# ⛔ JAMAIS docker compose down -v ici
docker compose up -d caisse
echo "      ✅ Conteneur relancé"

# ── 5. Vérification de santé ──────────────────────────────────────────────────
echo "[5/5] Vérification de santé..."
sleep 5
if curl -sf --max-time 10 --connect-timeout 5 http://localhost:3337/ > /dev/null 2>&1; then
  echo "      ✅ Application opérationnelle"
else
  echo "      ⚠️  L'application ne répond pas encore (peut nécessiter quelques secondes)"
fi

echo ""
echo "=============================================="
echo "  ✅ DÉPLOIEMENT TERMINÉ"
echo "  Commit : $(git rev-parse --short HEAD)"
echo "  Backup : $BACKUP_DIR/caisse_${DATE}.db"
echo "=============================================="
