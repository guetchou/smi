#!/bin/bash
# =============================================================================
# logview.sh — Lecture rapide des logs d'incident
#
# Usage : ./logview.sh [commande] [options]
#
# Commandes :
#   live          Suivi en temps réel (app + error)
#   errors        Toutes les erreurs (dernières 500 lignes)
#   auth          Événements d'authentification (login, logout, token)
#   pay [N]       Opérations de paiement/salaire (N lignes, défaut: 100)
#   dec [N]       Décaissements (N lignes, défaut: 100)
#   bulletin [N]  Bulletins de paie (N lignes, défaut: 100)
#   today         Logs du jour seulement
#   alerts        Alertes monitoring actives
#   health [N]    Dernières lignes health.log (N, défaut: 50)
#   size          Taille des fichiers de log
# =============================================================================

APP_LOG="/opt/projet-smi/logs/out.log"
ERR_LOG="/opt/projet-smi/logs/error.log"
HEALTH_LOG="/opt/monitoring/health.log"
ALERT_LOG="/opt/monitoring/alerts.log"

cmd="${1:-live}"
N="${2:-100}"

case "$cmd" in

  live)
    echo "=== Suivi live — Ctrl+C pour quitter ==="
    echo "  app.log  : $APP_LOG"
    echo "  error.log: $ERR_LOG"
    echo "========================================"
    tail -f "$APP_LOG" "$ERR_LOG" 2>/dev/null
    ;;

  errors)
    echo "=== Erreurs (500 dernières lignes de error.log) ==="
    tail -500 "$ERR_LOG" 2>/dev/null | grep -i --color=always "error\|exception\|fatal\|crash\|ENOENT\|SQLITE" || echo "(aucune erreur)"
    ;;

  auth)
    echo "=== Événements auth ==="
    grep -i --color=always "login\|logout\|token\|401\|403\|captcha\|password\|auth" "$APP_LOG" "$ERR_LOG" 2>/dev/null | tail -"$N" || echo "(aucun événement auth)"
    ;;

  pay|payer)
    echo "=== Paiements / Salaires ==="
    grep -i --color=always "payer\|paiement\|salaire\|bulletin\|net_a_payer\|decaissement.*employe\|paie" "$APP_LOG" "$ERR_LOG" 2>/dev/null | tail -"$N" || echo "(aucun)"
    ;;

  dec|decaissement)
    echo "=== Décaissements ==="
    grep -i --color=always "decaissement\|dec_statut\|workflow\|valider\|soumettre\|annuler" "$APP_LOG" "$ERR_LOG" 2>/dev/null | tail -"$N" || echo "(aucun)"
    ;;

  bulletin)
    echo "=== Bulletins de paie ==="
    grep -i --color=always "bulletin\|generer\|valider.*bulletin\|paye.*bulletin" "$APP_LOG" "$ERR_LOG" 2>/dev/null | tail -"$N" || echo "(aucun)"
    ;;

  today)
    TODAY=$(date '+%Y-%m-%d')
    echo "=== Logs du $TODAY ==="
    grep "^$TODAY\|$TODAY" "$APP_LOG" "$ERR_LOG" 2>/dev/null | tail -200 || echo "(aucun log aujourd'hui)"
    ;;

  alerts)
    echo "=== Alertes monitoring ==="
    if [ -f "$ALERT_LOG" ]; then
      cat "$ALERT_LOG"
    else
      echo "(aucune alerte enregistrée)"
    fi
    ;;

  health)
    echo "=== Health log (dernières $N lignes) ==="
    tail -"$N" "$HEALTH_LOG" 2>/dev/null || echo "(health.log vide ou inexistant)"
    ;;

  size)
    echo "=== Taille des fichiers de log ==="
    for f in "$APP_LOG" "$ERR_LOG" "$HEALTH_LOG" "$ALERT_LOG" /var/log/caisse-backup.log; do
      if [ -f "$f" ]; then
        printf "  %-60s %s\n" "$f" "$(du -sh "$f" | cut -f1)"
      else
        printf "  %-60s %s\n" "$f" "(absent)"
      fi
    done
    ;;

  *)
    echo "Usage: $0 {live|errors|auth|pay|dec|bulletin|today|alerts|health|size} [N]"
    exit 1
    ;;

esac
