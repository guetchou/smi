# Tâche « grand livre » — ADR 0002 §5.6, voie A

Tala SMI est le seul écran ; Dolibarr tient la comptabilité en arrière-plan.
Le passage au grand livre des factures, paiements et virements n'existe dans
Dolibarr que dans le code de ses écrans. Cette tâche les exécute en ligne de
commande, toutes les 5 minutes : ventilation automatique (clients,
fournisseurs), puis journaux ventes (VT), achats (AC) et banque (BQ), sur les
exercices ouverts. La logique comptable reste celle de Dolibarr. La paie et les
OD ne passent pas par ici : elles sont écrites par `POST /smi/pieces`.

| Fichier | Rôle |
|---|---|
| `grand-livre-auto.sh` | tâche : verrou, 5 étapes, bilan, journal ; code de sortie non nul en cas d'échec |
| `ecran.php` | exécute un écran de Dolibarr et imprime ses messages en JSON |
| `bilan.php` | compte les lignes du grand livre ; range l'état du passage dans Dolibarr |

## Sûreté

- Les exécutants agissent en administrateur de Dolibarr sans authentification.
  Ils sont copiés dans `/tmp` du conteneur à chaque passage (jamais sous le
  répertoire servi par le web) et refusent de tourner hors ligne de commande —
  gardé par `tests/dolibarr_executants_cli_test.js`.
- Tant que la production n'est pas validée, le script refuse tout conteneur
  dont le nom ne contient pas `sandbox`.
- `flock` empêche deux passages de se chevaucher ; un passage sauté est noté.

## Installation sur le serveur (bac à sable, 29/09/2026)

```
/opt/smi-dolibarr/grand-livre/{grand-livre-auto.sh,ecran.php,bilan.php}
/etc/cron.d/smi-dolibarr-grand-livre-sandbox
    */5 * * * * root CONTENEUR=dolibarr-sandbox /bin/sh /opt/smi-dolibarr/grand-livre/grand-livre-auto.sh >/dev/null 2>&1
/etc/logrotate.d/smi-dolibarr      hebdomadaire, 8 semaines, compressé
/var/log/smi-dolibarr/grand-livre-dolibarr-sandbox.log   une ligne JSON par passage
```

Pour retirer la tâche : supprimer le fichier de `/etc/cron.d`.

## Surveillance

`GET /smi/etat` (module « smi ») rend le dernier passage : horodatage, statut,
écritures ajoutées, étapes et leurs messages, et `en_retard` au-delà de
15 minutes (paramètre `retard_minutes`). C'est ce que Tala SMI affichera pour
qu'un journal qui ne s'écrit plus ne passe pas inaperçu.

## Preuve du 29/09/2026

Une vente poussée par le code de l'API à 13:52:01 (facture IN2601-0002,
75 000) : au passage planifié de 13:55:01, 4 écritures ajoutées sans aucun
geste — VT 411 D / 706 C, BQ 5711 D / 411 C. `GET /smi/etat` : statut `ok`,
`ecritures_ajoutees` 4, `en_retard` faux ; sans clé : 401.

Défaut trouvé en route : la colonne d'état des exercices s'appelle `statut` ;
la requête sur `status` échouait et l'exécutant l'annonçait comme « aucun
exercice ouvert ». Il dit désormais une erreur SQL comme une erreur SQL.
