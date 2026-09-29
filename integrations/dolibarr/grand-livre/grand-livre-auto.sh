#!/bin/sh
# Tâche « grand livre » de Tala SMI — ADR 0002 §5.6, voie A.
#
# La logique comptable reste celle de Dolibarr : ce script exécute en ligne de
# commande ses écrans de ventilation automatique puis d'écriture des journaux
# ventes (VT), achats (AC) et banque (BQ), sur les exercices ouverts.
#
#   CONTENEUR=dolibarr-sandbox sh grand-livre-auto.sh
#   CONTENEUR=dolibarr-prod ENTITE=2 sh grand-livre-auto.sh
#
# ENTITE : la société Dolibarr visée (instance partagée, décision du
# 29/09/2026). Hors bac à sable, seule une entité 2 ou plus est admise :
# l'entité 1 de la production appartient à un autre projet.
#
# Planifiée toutes les 5 minutes par /etc/cron.d. Un verrou empêche deux
# passages de se chevaucher. Chaque passage laisse une ligne JSON dans
# /var/log/smi-dolibarr/grand-livre-<conteneur>[-e<entite>].log et son état
# dans Dolibarr (réglage SMI_GRAND_LIVRE_ETAT de l'entité, lu par
# GET /smi/etat). Code de sortie non nul en cas d'échec.
set -u
CONTENEUR=${CONTENEUR:-dolibarr-sandbox}
ENTITE=${ENTITE:-1}
case "$ENTITE" in ''|*[!0-9]*) echo "refus : ENTITE doit etre un nombre" >&2; exit 2 ;; esac
case "$CONTENEUR" in
	*sandbox*) ;;
	*) [ "$ENTITE" -ge 2 ] || { echo "refus : hors bac a sable, seule une entite 2 ou plus est admise" >&2; exit 2; } ;;
esac

ICI=$(cd "$(dirname "$0")" && pwd)
JOURNAL_DIR=/var/log/smi-dolibarr
mkdir -p "$JOURNAL_DIR"
SUFFIXE=""; [ "$ENTITE" = 1 ] || SUFFIXE="-e$ENTITE"
JOURNAL="$JOURNAL_DIR/grand-livre-$CONTENEUR$SUFFIXE.log"
VERROU="/run/lock/smi-grand-livre-$CONTENEUR$SUFFIXE.lock"

exec 9>"$VERROU"
if ! flock -n 9; then
	printf '{"horodatage":"%s","statut":"saute","raison":"passage precedent en cours"}\n' "$(date -Iseconds)" >> "$JOURNAL"
	exit 0
fi

debut=$(date -Iseconds)
docker inspect "$CONTENEUR" >/dev/null 2>&1 || {
	printf '{"horodatage":"%s","statut":"erreur","erreurs":["conteneur %s introuvable"]}\n' "$debut" "$CONTENEUR" >> "$JOURNAL"
	exit 1
}
for f in ecran.php bilan.php; do
	docker cp "$ICI/$f" "$CONTENEUR:/tmp/smi-gl-$f" >/dev/null || exit 1
done
nettoyer() { docker exec -u 0 "$CONTENEUR" rm -f /tmp/smi-gl-ecran.php /tmp/smi-gl-bilan.php >/dev/null 2>&1; }
trap nettoyer EXIT

avant=$(docker exec -u www-data -e DOLENTITY="$ENTITE" -e MODE=compter "$CONTENEUR" php /tmp/smi-gl-bilan.php 2>/dev/null)

etapes=""
statut=ok
for etape in \
	"accountancy/customer/index.php validatehistory -" \
	"accountancy/supplier/index.php validatehistory -" \
	"accountancy/journal/sellsjournal.php writebookkeeping VT" \
	"accountancy/journal/purchasesjournal.php writebookkeeping AC" \
	"accountancy/journal/bankjournal.php writebookkeeping BQ"; do
	set -- $etape
	journal=$3; [ "$journal" = "-" ] && journal=""
	res=$(docker exec -u www-data -e DOLENTITY="$ENTITE" -e ECRAN="$1" -e ACTION="$2" -e JOURNAL="$journal" "$CONTENEUR" php /tmp/smi-gl-ecran.php 2>/dev/null | grep '^{' | tail -1)
	[ -z "$res" ] && res=$(printf '{"ecran":"%s","etat":"erreur","messages":["aucune reponse de l executant"]}' "$1")
	echo "$res" | grep -q '"etat":"ok"' || statut=erreur
	etapes="${etapes:+$etapes,}$res"
done

apres=$(docker exec -u www-data -e DOLENTITY="$ENTITE" -e MODE=compter "$CONTENEUR" php /tmp/smi-gl-bilan.php 2>/dev/null)
ajoutees=$(( ${apres:-0} - ${avant:-0} ))
etat=$(printf '{"horodatage":"%s","statut":"%s","ecritures_ajoutees":%d,"etapes":[%s]}' "$debut" "$statut" "$ajoutees" "$etapes")
echo "$etat" >> "$JOURNAL"
docker exec -u www-data -e DOLENTITY="$ENTITE" -e MODE=enregistrer -e ETAT="$etat" "$CONTENEUR" php /tmp/smi-gl-bilan.php >/dev/null 2>&1 || statut=erreur

[ "$statut" = ok ]
