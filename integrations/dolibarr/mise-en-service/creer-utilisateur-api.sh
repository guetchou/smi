#!/bin/sh
# Crée l'utilisateur d'API de Tala SMI dans son entité Dolibarr et écrit la
# connexion dans le .env de Tala SMI, sans jamais afficher la clé.
#
#   CONTENEUR=dolibarr-prod ENTITE=2 ENV=/opt/projet-smi/.env \
#     sh integrations/dolibarr/mise-en-service/creer-utilisateur-api.sh
#
# À lancer par une personne, après mettre-en-service.sh. Écrit :
#   DOLIBARR_URL=http://<conteneur>   (joint par le réseau partagé, voir docker-compose.yml)
#   DOLIBARR_API_KEY=<clé>
#   DOLIBARR_ENTITE=<entité>
# Refuse si .env contient déjà une clé : la remplacer coupe Tala SMI.
# Tala SMI ne lit la clé qu'au prochain déploiement.
set -eu
CONTENEUR=${CONTENEUR:?CONTENEUR manquant}
ENTITE=${ENTITE:?ENTITE manquante}
ENV=${ENV:?ENV manquant (chemin du .env de Tala SMI)}
case "$ENTITE" in ''|*[!0-9]*) echo "refus : ENTITE doit etre un nombre" >&2; exit 2 ;; esac
[ "$ENTITE" -ge 2 ] || { echo "refus : ENTITE doit valoir 2 ou plus" >&2; exit 2; }
[ -f "$ENV" ] || { echo "refus : $ENV introuvable" >&2; exit 2; }
if grep -Eq '^DOLIBARR_API_KEY=.+' "$ENV"; then
	echo "refus : $ENV contient deja DOLIBARR_API_KEY" >&2
	exit 3
fi

ICI=$(cd "$(dirname "$0")" && pwd)
docker cp "$ICI/creer-utilisateur-api.php" "$CONTENEUR:/tmp/smi-mes-api.php" >/dev/null
trap 'docker exec -u 0 "$CONTENEUR" rm -f /tmp/smi-mes-api.php >/dev/null 2>&1 || true' EXIT
CLE=$(docker exec -u www-data -e DOLENTITY="$ENTITE" "$CONTENEUR" php /tmp/smi-mes-api.php | sed -n "s/^CLE=//p" | tail -1)
case "$CLE" in ''|*[!A-Za-z0-9]*) echo "ERREUR : cle absente ou mal formee" >&2; exit 1 ;; esac

cp -p "$ENV" "$ENV.avant-dolibarr-$(date +%Y%m%d-%H%M%S)"
# Les lignes vides laissées par docker-compose.yml (${...:-}) sont remplacées, pas doublées.
TMP=$(mktemp "$ENV.XXXXXX")
grep -Ev '^DOLIBARR_(URL|API_KEY|ENTITE)=' "$ENV" > "$TMP" || true
{
	printf "DOLIBARR_URL='http://%s'\n" "$CONTENEUR"
	printf "DOLIBARR_API_KEY='%s'\n" "$CLE"
	printf "DOLIBARR_ENTITE='%s'\n" "$ENTITE"
} >> "$TMP"
chmod --reference="$ENV" "$TMP" 2>/dev/null || chmod 600 "$TMP"
mv "$TMP" "$ENV"
echo "  $ENV : DOLIBARR_URL, DOLIBARR_API_KEY (masquee), DOLIBARR_ENTITE=$ENTITE ecrits"
echo "  copie de l'ancien .env a cote, suffixe .avant-dolibarr-*"
