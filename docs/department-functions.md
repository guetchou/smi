# Module d’organisation départementale

## Périmètre

Ce module gère sous MySQL :

- chef de département ;
- premier adjoint et adjoints ;
- responsable intérimaire et suppléant ;
- chef de service, chef de section et coordonnateur ;
- services, sections, cellules, bureaux et équipes ;
- rattachement à un poste officiel du référentiel `org_postes` ;
- supérieur fonctionnel dans le workflow de mutation RH.

## Workflow

Toute nouvelle fonction suit le cycle :

`brouillon → soumis → approuve/refuse → actif → cloture`

Une demande refusée ou signalée `a_corriger` peut être révisée puis soumise à nouveau. Une fonction approuvée avec une date future est activée automatiquement lorsque la date d’effet est atteinte.

## Séparation des responsabilités

Les permissions sont indépendantes :

- `hr.department_function.view` ;
- `hr.department_function.create` ;
- `hr.department_function.submit` ;
- `hr.department_function.approve` ;
- `hr.department_function.activate` ;
- `hr.department_function.close` ;
- `hr.department_function.attach_document` ;
- `hr.department_function.report`.

L’initiateur ou le soumetteur ne peut pas approuver ou refuser sa propre demande.

## Règles d’intégrité

- l’agent doit être actif et appartenir au département ;
- un seul chef, premier adjoint et intérimaire peuvent être actifs simultanément par département ;
- l’intérim et la suppléance exigent une date de fin ;
- une décision signée est obligatoire pour le chef, le premier adjoint, l’intérimaire et le suppléant ;
- la version optimiste empêche l’écrasement d’une modification concurrente ;
- les transitions utilisent des transactions MySQL et des verrous `FOR UPDATE` ;
- chaque transition écrit le journal métier et `audit_logs` dans la même transaction ;
- la clôture d’un intérim rétablit le chef titulaire ;
- l’activation d’un nouveau chef clôture automatiquement l’ancien ;
- une unité ne peut pas former une boucle, changer de département ou être désactivée avec des enfants ou fonctions actives.

## Documents

Les décisions acceptées sont PDF, JPEG ou PNG, limitées à 7 Mo. Le fichier est stocké dans le volume persistant `/app/backend/data/uploads/org-functions` et son empreinte SHA-256 est enregistrée.

## Notifications

Le module émet des notifications à la soumission, l’approbation, au refus, à la prise d’effet, avant expiration et à la clôture. Une panne de notification est journalisée sans transformer une transaction déjà validée en faux échec utilisateur.

## Rapports

Le rapport expose :

- volumes par statut et type ;
- fonctions arrivant à échéance ;
- département sans chef actif ;
- fonction active portée par un agent inactif ;
- fonction rattachée au mauvais département ;
- fonction sensible sans décision signée.

## Reprise historique

Les responsables historiques sont repris comme chefs actifs. Les postes texte sont rapprochés du référentiel `org_postes`, puis `employes.poste_id` et `org_departement_fonctions.poste_id` sont renseignés lorsque la correspondance est certaine.

## Déploiement

Avant le remplacement du conteneur applicatif, le pipeline :

1. sauvegarde MySQL ;
2. applique les migrations 033 à 036 ;
3. exécute les backfills idempotents ;
4. vérifie colonnes, clés étrangères, permissions, notifications, unicité, unités et rollback transactionnel ;
5. vérifie l’unicité du journal d’événements ;
6. démarre le nouveau conteneur ;
7. contrôle `/api/health`.

Une pull request exécute également `npm test` et les migrations contre un service MySQL 8 réel avant fusion.
