#!/bin/bash
# =============================================================================
# health_check.sh — Monitoring VPS local (disk, RAM, CPU, DB, process)
#
# Cron : */5 * * * * /opt/frappe_docker/caisse-topcenter/scripts/health_check.sh
# Log  : /opt/monitoring/health.log
#
# Seuils d'alerte :
#   Disque > 80%   RAM > 85%   CPU > 90%   DB > 500MB
# =============================================================================
set -euo pipefail

LOG_DIR="/opt/monitoring"
LOG_FILE="$LOG_DIR/health.log"
ALERT_FILE="$LOG_DIR/alerts.log"
DB_WARN_MB=500
DISK_WARN=80
RAM_WARN=85
CPU_WARN=90
APP_NAME="caisse-topcenter"
APP_URL="http://localhost:3337/api/health"

mkdir -p "$LOG_DIR"

# ── Helpers ───────────────────────────────────────────────────────────────────
TS() { date '+%Y-%m-%d %H:%M:%S'; }

log_line() {
  echo "$(TS) $*" >> "$LOG_FILE"
}

alert() {
  local msg="$*"
  echo "$(TS) [ALERT] $msg" >> "$LOG_FILE"
  echo "$(TS) $msg" >> "$ALERT_FILE"
}

ok() {
  echo "$(TS) [OK]    $*" >> "$LOG_FILE"
}

# ── Rotation log : conserver 7 jours ─────────────────────────────────────────
# Si le log dépasse 10 Mo, on archive et on repart
if [ -f "$LOG_FILE" ] && [ "$(du -sm "$LOG_FILE" 2>/dev/null | cut -f1)" -gt 10 ]; then
  mv "$LOG_FILE" "${LOG_FILE}.$(date +%Y%m%d%H%M%S).old"
  find "$LOG_DIR" -name "health.log.*.old" -mtime +7 -delete 2>/dev/null || true
fi

log_line "=== health_check start ==="

ALERTS=0

# ── 1. Disque ─────────────────────────────────────────────────────────────────
DISK_USED=$(df / 2>/dev/null | awk 'NR==2 {gsub(/%/,"",$5); print $5}')
DISK_AVAIL=$(df -h / 2>/dev/null | awk 'NR==2 {print $4}')
if [ -n "$DISK_USED" ] && [ "$DISK_USED" -gt "$DISK_WARN" ]; then
  alert "DISQUE ${DISK_USED}% — seuil ${DISK_WARN}% dépassé (dispo: ${DISK_AVAIL})"
  ALERTS=$((ALERTS+1))
else
  ok "Disque ${DISK_USED:-?}% (dispo: ${DISK_AVAIL:-?})"
fi

# ── 2. RAM ────────────────────────────────────────────────────────────────────
if command -v free &>/dev/null; then
  RAM_TOTAL=$(free -m | awk '/^Mem:/ {print $2}')
  RAM_USED=$(free -m  | awk '/^Mem:/ {print $3}')
  if [ "$RAM_TOTAL" -gt 0 ]; then
    RAM_PCT=$(( RAM_USED * 100 / RAM_TOTAL ))
    if [ "$RAM_PCT" -gt "$RAM_WARN" ]; then
      alert "RAM ${RAM_PCT}% (${RAM_USED}/${RAM_TOTAL} MB) — seuil ${RAM_WARN}% dépassé"
      ALERTS=$((ALERTS+1))
    else
      ok "RAM ${RAM_PCT}% (${RAM_USED}/${RAM_TOTAL} MB)"
    fi
  fi
fi

# ── 3. CPU (charge système — load average 1 min) ──────────────────────────────
LOAD1=$(cut -d' ' -f1 /proc/loadavg 2>/dev/null || echo "0")
NCPU=$(nproc 2>/dev/null || echo "1")
# CPU % approximatif = (load1 / nCPU) * 100
CPU_PCT=$(awk -v l="$LOAD1" -v n="$NCPU" 'BEGIN { printf "%d", (l/n)*100 }')
if [ "$CPU_PCT" -gt "$CPU_WARN" ]; then
  alert "CPU ${CPU_PCT}% (load: ${LOAD1} / ${NCPU} cœurs) — seuil ${CPU_WARN}% dépassé"
  ALERTS=$((ALERTS+1))
else
  ok "CPU ${CPU_PCT}% (load: ${LOAD1} / ${NCPU} cœurs)"
fi

# ── 4. Taille DB ──────────────────────────────────────────────────────────────
find_db() {
  local docker_path="/var/lib/docker/volumes/caisse-topcenter_caisse_data/_data/caisse.db"
  local dev_path="/opt/frappe_docker/caisse-topcenter/backend/data/caisse.db"
  if   [ -f "$docker_path" ]; then echo "$docker_path"
  elif [ -f "$dev_path" ];    then echo "$dev_path"
  else find /opt -name "caisse.db" -type f 2>/dev/null | head -1; fi
}

DB_PATH="$(find_db)"
if [ -n "$DB_PATH" ] && [ -f "$DB_PATH" ]; then
  DB_MB=$(du -sm "$DB_PATH" 2>/dev/null | cut -f1)
  if [ "$DB_MB" -gt "$DB_WARN_MB" ]; then
    alert "DB ${DB_MB} MB — seuil ${DB_WARN_MB} MB dépassé ($DB_PATH)"
    ALERTS=$((ALERTS+1))
  else
    ok "DB ${DB_MB} MB (seuil: ${DB_WARN_MB} MB)"
  fi
else
  alert "DB introuvable — aucun fichier caisse.db détecté"
  ALERTS=$((ALERTS+1))
fi

# ── 5. Process Node / PM2 ─────────────────────────────────────────────────────
PM2_OK=0
NODE_OK=0

# Vérification PM2
if command -v pm2 &>/dev/null; then
  PM2_STATUS=$(pm2 jlist 2>/dev/null | python3 -c "
import json,sys
try:
  procs = json.load(sys.stdin)
  app = next((p for p in procs if p.get('name')=='$APP_NAME'), None)
  if app:
    st = app.get('pm2_env',{}).get('status','?')
    pid = app.get('pid','?')
    print(f'status={st} pid={pid}')
  else:
    print('not_found')
except:
  print('parse_error')
" 2>/dev/null || echo "pm2_error")

  if echo "$PM2_STATUS" | grep -q "status=online"; then
    ok "PM2 $APP_NAME — $PM2_STATUS"
    PM2_OK=1
  else
    alert "PM2 $APP_NAME non actif — $PM2_STATUS"
    ALERTS=$((ALERTS+1))
  fi
else
  # PM2 absent : vérifier process node directement
  NODE_PID=$(pgrep -f "node.*server.js" 2>/dev/null | head -1 || true)
  if [ -n "$NODE_PID" ]; then
    ok "Node.js actif (pid $NODE_PID, PM2 absent)"
    NODE_OK=1
  else
    alert "Node.js introuvable — aucun process server.js détecté"
    ALERTS=$((ALERTS+1))
  fi
fi

# ── 6. Statut HTTP backend ────────────────────────────────────────────────────
if command -v curl &>/dev/null; then
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 --connect-timeout 3 "$APP_URL" 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" = "200" ]; then
    ok "Backend HTTP $HTTP_CODE — $APP_URL"
  else
    alert "Backend inaccessible — HTTP $HTTP_CODE ($APP_URL)"
    ALERTS=$((ALERTS+1))
  fi
fi

# ── Résumé ────────────────────────────────────────────────────────────────────
if [ "$ALERTS" -eq 0 ]; then
  log_line "=== OK — 0 alerte ==="
else
  log_line "=== ${ALERTS} ALERTE(S) ACTIVE(S) — voir $ALERT_FILE ==="
fi
