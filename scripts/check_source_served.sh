#!/usr/bin/env bash
# Verifie les sources et runtimes connus sans modifier l'environnement.
set -euo pipefail

LOCAL_PROJECT_DIR="${LOCAL_PROJECT_DIR:-/opt/frappe_docker/caisse-topcenter}"
PROD_PROJECT_DIR="${PROD_PROJECT_DIR:-/opt/caisse-topcenter}"
APP_URL="${APP_URL:-https://talatala.topcenter.cg}"

section() {
  printf '\n== %s ==\n' "$1"
}

section "Git local"
if [ -d "$LOCAL_PROJECT_DIR/.git" ]; then
  git -C "$LOCAL_PROJECT_DIR" status --short --branch
  git -C "$LOCAL_PROJECT_DIR" branch -vv
  git -C "$LOCAL_PROJECT_DIR" worktree list
else
  echo "Local project absent: $LOCAL_PROJECT_DIR"
fi

section "Chemins"
printf 'Workspace local : %s ' "$LOCAL_PROJECT_DIR"
[ -d "$LOCAL_PROJECT_DIR" ] && echo "(present)" || echo "(absent)"
printf 'Production VPS  : %s ' "$PROD_PROJECT_DIR"
[ -d "$PROD_PROJECT_DIR" ] && echo "(present sur cette machine)" || echo "(absent sur cette machine)"

section "Ports"
if command -v ss >/dev/null 2>&1; then
  ss -ltnp 2>/tmp/caisse_source_ss.err | grep -E '(:3337|:80|:443)' || {
    echo "ports non lisibles ou aucun port cible visible"
    sed -n '1,2p' /tmp/caisse_source_ss.err 2>/dev/null || true
  }
else
  echo "ss indisponible"
fi

section "PM2"
if command -v pm2 >/dev/null 2>&1; then
  pm2 list 2>/tmp/caisse_source_pm2.err || {
    echo "pm2 inaccessible"
    sed -n '1,3p' /tmp/caisse_source_pm2.err 2>/dev/null || true
  }
else
  echo "pm2 indisponible"
fi

section "Docker"
if command -v docker >/dev/null 2>&1; then
  docker context show 2>/tmp/caisse_source_docker_context.err || {
    echo "docker context inaccessible"
    sed -n '1,3p' /tmp/caisse_source_docker_context.err 2>/dev/null || true
  }
  docker ps --filter name=caisse-topcenter 2>/tmp/caisse_source_docker.err || {
    echo "docker ps inaccessible"
    sed -n '1,3p' /tmp/caisse_source_docker.err 2>/dev/null || true
  }
else
  echo "docker indisponible"
fi

section "HTTP"
if command -v curl >/dev/null 2>&1; then
  curl -skS "$APP_URL/api/health" || true
  printf '\n'
  curl -skSI "$APP_URL/dashboard.html" || true
else
  echo "curl indisponible"
fi
