#!/bin/sh
# Rejoue la vérification « Tala SMI, surcouche de Dolibarr » sur le BAC À SABLE.
#
#   sh docs/verifications/dolibarr-surcouche/lancer.sh [etape...]
#
# Étapes, dans l'ordre : configurer caisse vente depenses ventilation journaux module grand-livre
# Sans argument : toutes. Chaque script est idempotent.
#
# Garde-fou : le conteneur visé est écrit en dur. Ces scripts configurent
# Dolibarr et y créent des pièces ; ils ne doivent jamais toucher dolibarr-prod.
set -eu
CONTENEUR=dolibarr-sandbox
case "$CONTENEUR" in *sandbox*) ;; *) echo "refus : $CONTENEUR n'est pas un bac à sable"; exit 1 ;; esac
docker inspect "$CONTENEUR" >/dev/null 2>&1 || { echo "refus : conteneur $CONTENEUR introuvable"; exit 1; }

ICI=$(cd "$(dirname "$0")" && pwd)
php() { # php <script> [VAR=valeur...]
	s=$1; shift
	docker cp "$ICI/$s" "$CONTENEUR:/tmp/$s" >/dev/null
	env_args=""
	for kv in "$@"; do env_args="$env_args -e $kv"; done
	# shellcheck disable=SC2086
	# DOLENTITY : la société visée dans une instance partagée (1 par défaut).
	docker exec -u www-data -e DOLENTITY="${DOLENTITY:-1}" $env_args "$CONTENEUR" php "/tmp/$s" 2>&1 | grep -v 'PHP Warning' || true
	docker exec -u 0 "$CONTENEUR" rm -f "/tmp/$s"
}

RACINE=$(cd "$ICI/../../.." && pwd)
installer_module() { # copie integrations/dolibarr/smi dans custom/smi du bac à sable
	tar czf - -C "$RACINE/integrations/dolibarr/smi" . | docker exec -i -u 0 "$CONTENEUR" sh -c \
		'mkdir -p /var/www/html/custom/smi && tar xzf - -C /var/www/html/custom/smi && chown -R www-data:www-data /var/www/html/custom/smi'
	echo "  module smi copie dans custom/smi"
}

ETAPES=${*:-configurer caisse vente depenses ventilation journaux module grand-livre}
for e in $ETAPES; do
	echo "== $e"
	case "$e" in
		configurer)  php configurer-bac-a-sable.php ;;
		caisse)      php pousser-caisse.php ;;
		vente)       php vente-comptant.php ;;
		depenses)    php depenses.php ;;
		ventilation) php ecran.php ECRAN=accountancy/customer/index.php ACTION=validatehistory
		             php ecran.php ECRAN=accountancy/supplier/index.php ACTION=validatehistory ;;
		journaux)    php ecran.php ECRAN=accountancy/journal/sellsjournal.php ACTION=writebookkeeping JOURNAL=VT
		             php ecran.php ECRAN=accountancy/journal/purchasesjournal.php ACTION=writebookkeeping JOURNAL=AC
		             php ecran.php ECRAN=accountancy/journal/bankjournal.php ACTION=writebookkeeping JOURNAL=BQ ;;
		module)      installer_module
		             php tester-module-smi.php ;;
		grand-livre) php grand-livre.php ;;
		diagnostic)  php diag-salaire.php ;;
		*) echo "étape inconnue : $e"; exit 1 ;;
	esac
done
