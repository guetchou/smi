#!/bin/sh
# Mise en service de l'entité Top Center dans un Dolibarr partagé — ADR 0002,
# décision « multi-société » du 29/09/2026.
#
#   CONTENEUR=dolibarr-prod ENTITE=2 sh integrations/dolibarr/mise-en-service/mettre-en-service.sh
#
# Étapes, toutes idempotentes :
#   1. empreinte de l'entité 1 et des réglages d'instance (entité 0) ;
#   2. copie du module smi dans custom/smi ;
#   3. référentiels de l'entité (creer-entite.php) ;
#   4. configuration de l'entité (configurer-entite.php) ;
#   5. nouvelle empreinte, comparée à la première.
# Toute différence sur l'entité 1 fait sortir en erreur : elle appartient à un
# autre projet. Une différence sur l'entité 0 est affichée pour examen.
#
# La clé d'API n'est pas créée ici : voir creer-utilisateur-api.sh.
set -eu
CONTENEUR=${CONTENEUR:?CONTENEUR manquant}
ENTITE=${ENTITE:?ENTITE manquante}
case "$ENTITE" in ''|*[!0-9]*) echo "refus : ENTITE doit etre un nombre" >&2; exit 2 ;; esac
[ "$ENTITE" -ge 2 ] || { echo "refus : l'entite 1 appartient a l'instance existante" >&2; exit 2; }
docker inspect "$CONTENEUR" >/dev/null 2>&1 || { echo "refus : conteneur $CONTENEUR introuvable" >&2; exit 1; }

ICI=$(cd "$(dirname "$0")" && pwd)
MODULE=$(cd "$ICI/../smi" && pwd)
TRACE=$(mktemp -d)
trap 'rm -rf "$TRACE"; docker exec -u 0 "$CONTENEUR" rm -f /tmp/smi-mes-*.php >/dev/null 2>&1 || true' EXIT

php() { # php <script> [VAR=valeur...]
	s=$1; shift
	docker cp "$ICI/$s" "$CONTENEUR:/tmp/smi-mes-$s" >/dev/null
	env_args=""
	for kv in "$@"; do env_args="$env_args -e $kv"; done
	# shellcheck disable=SC2086
	docker exec -u www-data $env_args "$CONTENEUR" php "/tmp/smi-mes-$s"
}

echo "== empreinte avant"
php empreinte.php ENTITE_OBSERVEE=1 > "$TRACE/avant"
wc -l < "$TRACE/avant"

echo "== module smi"
tar czf - -C "$MODULE" . | docker exec -i -u 0 "$CONTENEUR" sh -c \
	'mkdir -p /var/www/html/custom/smi && tar xzf - -C /var/www/html/custom/smi && chown -R www-data:www-data /var/www/html/custom/smi'
echo "  copie dans custom/smi"

echo "== referentiels de l'entite $ENTITE"
php creer-entite.php DOLENTITY="$ENTITE"

echo "== configuration de l'entite $ENTITE"
php configurer-entite.php DOLENTITY="$ENTITE"

echo "== empreinte apres"
php empreinte.php ENTITE_OBSERVEE=1 > "$TRACE/apres"
if diff "$TRACE/avant" "$TRACE/apres" > "$TRACE/diff"; then
	echo "  entite 1 et reglages d'instance : identiques"
else
	cat "$TRACE/diff"
	if grep -q '^[<>] entite 1 ' "$TRACE/diff"; then
		echo "ERREUR : l'entite 1 a change" >&2
		exit 1
	fi
	echo "  entite 1 identique ; reglages d'instance (entite 0) modifies, a examiner"
fi
