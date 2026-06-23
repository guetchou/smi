# Fondation MySQL asynchrone

Première tranche de l’issue #43.

## Flux migré

`offboarding → parapheur`

Le dossier de sortie, l’entrée parapheur, l’action initiale et les audits sont désormais écrits dans une transaction `backend/db.js` réelle. Les notifications sont envoyées uniquement après le commit.

## Preuves

- contrat statique : `tests/offboarding_parapheur_atomicity_test.js` ;
- scénario MySQL 8 : `scripts/test_offboarding_parapheur_mysql.js` ;
- panne forcée après insertion du dossier, puis vérification qu’aucun dossier ni parapheur orphelin ne subsiste.

## Hors périmètre

Les congés, avances salariales et autres consommateurs du connecteur historique seront migrés par tranches séparées.
