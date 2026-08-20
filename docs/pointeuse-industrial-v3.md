# Pointeuse industrielle V3

## Objectif

Faire évoluer la pointeuse historique « une ligne par agent et par jour » vers un moteur de gestion des temps fondé sur des événements immuables, des plannings, des anomalies explicites, des corrections approuvées et une clôture de période avant consommation par la paie.

## Principes non négociables

1. **Autorité serveur** : les horodatages de présence utilisés comme preuve sont produits par le serveur.
2. **Événements append-only** : un événement physique de pointage n'est ni modifié ni supprimé par le workflow normal. Une erreur est corrigée par une demande puis, après approbation, par un événement compensatoire traçable.
3. **Idempotence** : chaque écriture de pointage exige une clé idempotente et la base impose son unicité par agent.
4. **Machine à états** : seules les transitions légales sont acceptées (`clock_in`, `break_start`, `break_end`, `clock_out`).
5. **Temps non ambigu** : conservation de l'instant UTC, de la date/heure locale et du fuseau IANA utilisé pour l'interprétation métier.
6. **Planning comme source métier** : horaires, pauses, tolérances, site et modes autorisés sont rattachés à un planning effectif dans le temps.
7. **Anomalies comme workflow** : les anomalies ne sont pas de simples couleurs UI mais des objets suivis jusqu'à résolution.
8. **Séparation des responsabilités** : l'agent demande une correction ; RH/DG/admin la contrôle. Une période ne peut être clôturée avec des anomalies non résolues.
9. **Clôture avant paie** : la paie doit consommer des temps approuvés/clôturés et non des événements bruts modifiables.
10. **Audit et observabilité** : toute opération sensible doit pouvoir être reconstruite sans exposer de données secrètes dans les logs.

## Modèle V3

- `pointeuse_events` : flux événementiel immuable.
- `pointeuse_work_schedules` : modèles horaires.
- `pointeuse_schedule_assignments` : affectations datées par agent.
- `pointeuse_daily_summaries` : résultat calculé d'une journée.
- `pointeuse_anomalies` : file d'exceptions et de justification.
- `pointeuse_correction_requests` : workflow de rectification.
- `pointeuse_periods` : calcul, contrôle, approbation, clôture et réouverture.

## API cible

- `GET /api/pointeuse/v3/me/status`
- `POST /api/pointeuse/v3/events`
- `GET /api/pointeuse/v3/me/events`
- `POST /api/pointeuse/v3/corrections`
- `GET /api/pointeuse/v3/anomalies` (RH/DG/admin)
- `POST /api/pointeuse/v3/periods/:id/close` (RH/DG/admin)

## Références externes retenues

- ISO 8601-1:2019 : représentation non ambiguë des dates/heures et prise en compte UTC/décalage.
- W3C WCAG 2.2 : cible d'accessibilité de la future interface web et kiosque.
- OWASP Business Logic Security : validation serveur des combinaisons métier, machine à états, anti-rejeu/idempotence, journalisation et détection d'anomalies.
- OWASP API Security Top 10 2023 : contrôle d'accès objet/fonction et protection des flux métier sensibles.
- NIST SP 800-171r3 03.03.08 : protection des informations et outils d'audit contre accès, modification ou suppression non autorisés.

## Compatibilité

La V2 reste opérationnelle pendant la transition. La V3 est introduite sans suppression de `pointages`. Le basculement UI et la migration historique seront faits après validation du moteur événementiel et des règles de calcul.

## Lots suivants

1. Monter le routeur V3 derrière l'authentification existante et ajouter les contrôles GPS/PIN/planning au nouveau flux.
2. Implémenter le calcul quotidien transactionnel, la génération d'anomalies et les horaires de nuit/traversée de minuit.
3. Implémenter approbation/rejet/appliquer correction avec séparation demandeur/approbateur.
4. Ajouter calcul/approbation/clôture de période et contrat de données vers la paie.
5. Refaire `/app/rh/pointeuse` en cockpit : temps réel, anomalies, feuilles de temps, approbations, planning et paramètres.
6. Ajouter E2E concurrence/double-clic, pause, nuit, oubli sortie, congé, télétravail, géofence, correction, clôture et paie.
