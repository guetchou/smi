# Pointeuse V3 — Runbook de bascule et rollback

## Objectif

Passer de la Pointeuse V2 à la V3 sans perte de pointage, sans double écriture incontrôlée et avec une possibilité de retour immédiat. La V2 reste disponible pendant toute la phase de validation.

## Principes non négociables

- La V3 démarre en `shadow`.
- Aucune bascule `active` tant que le rapprochement V2/V3 n'est pas jugé acceptable par RH/DG.
- Les horodatages, l'identité, le fuseau, le décalage UTC et la géofence sont dérivés côté serveur.
- Les corrections V3 sont non destructives et auditées.
- Une période clôturée et son snapshot paie ne doivent pas être recalculés silencieusement.
- En cas d'incident, le rollback consiste d'abord à revenir en `shadow` ou `disabled`; il ne faut pas supprimer les événements V3 déjà écrits.

## 0. Pré-requis avant déploiement

1. CI du commit à déployer entièrement verte, notamment `npm test` avec `tests/pointeuse_v3_complete_lot_test.js`.
2. Sauvegarde MySQL récente et restaurable.
3. SHA exact du commit de production enregistré.
4. Migrations 043 à 046 présentes dans l'image/checkout déployé.
5. V2 `/api/pointeuse` toujours montée.
6. Accès RH/DG/admin disponible pour les endpoints d'administration V3.

## 1. Déploiement en mode `shadow`

Après déploiement, confirmer que la valeur runtime est `shadow` avant tout test métier.

Endpoint de lecture :

```text
GET /api/pointeuse/v3/admin/config
```

La réponse doit contenir :

```json
{"mode":"shadow"}
```

Si la valeur n'est pas `shadow`, la rétablir immédiatement via l'endpoint d'administration prévu pour `runtime-mode` avant de poursuivre.

### Contrôles techniques

- `/api/health` répond 200.
- Les migrations sont appliquées sans erreur.
- Les routes V2 et V3 répondent avec authentification normale.
- Aucun pic d'erreurs 5xx Pointeuse dans les logs.
- L'interface `/app/rh/pointeuse` se charge sans erreur JavaScript bloquante.

## 2. Shadow-sync V2 → V3

Lancer la synchronisation d'observation sur une plage courte représentative avant d'élargir la période.

Le shadow-sync doit rester idempotent : un pointage V2 donné doit conserver une clé `legacy:<id>` et ne pas produire de doublon lorsqu'on relance la synchronisation.

Contrôler après chaque lot :

- nombre de pointages V2 lus ;
- nombre d'événements V3 importés ;
- nombre de relectures idempotentes ;
- erreurs d'affectation planning/site/calendrier ;
- anomalies générées.

Ne pas passer en `active` si des imports sont incomplets ou si des doublons apparaissent.

## 3. Rapprochement V2 / V3

Endpoint :

```text
GET /api/pointeuse/v3/admin/reconciliation?debut=YYYY-MM-DD&fin=YYYY-MM-DD
```

Le rapport doit être examiné au minimum sur :

- `v2_only` ;
- `v3_only` ;
- écarts entrée ;
- écarts sortie ;
- écarts durée ;
- `match_rate`.

### Critère de feu vert

Le passage en `active` est interdit tant qu'une divergence non expliquée touche un pointage ayant un impact RH/paie. Un taux de concordance élevé ne suffit pas à lui seul : les écarts restants doivent être explicitement qualifiés.

Pour toute divergence :

1. déterminer si elle vient d'une règle V3 légitime (planning, calendrier, nuit, pause, géofence, correction) ;
2. corriger la configuration ou le code si nécessaire ;
3. relancer le recalcul/shadow-sync ;
4. relancer le rapprochement ;
5. conserver la preuve du rapport ayant servi au feu vert.

## 4. Validation RH avant bascule

RH/DG doit vérifier sur un échantillon représentatif :

- journée normale ;
- retard dans et hors tolérance ;
- pause/reprise ;
- sortie anticipée ;
- heures supplémentaires ;
- travail de nuit / shift traversant minuit ;
- jour de repos ;
- jour férié/exception calendrier ;
- absence sans pointage un jour planifié ;
- GPS requis et hors périmètre ;
- télétravail/terrain autorisé et refusé ;
- correction avec audit ;
- anomalie résolue ;
- journée approuvée ;
- période calculée, revue puis approuvée ;
- séparation réviseur/approbateur ;
- clôture bloquée tant que les préconditions ne sont pas remplies ;
- génération d'un snapshot paie après clôture.

## 5. Bascule `active`

La bascule doit être une action explicite RH/DG/admin via l'endpoint `runtime-mode`.

Ordre :

1. conserver le dernier rapport de rapprochement accepté ;
2. noter l'heure et le SHA de production ;
3. passer `pointeuse_v3_mode` à `active` ;
4. effectuer un pointage réel contrôlé avec un agent pilote ;
5. vérifier l'événement V3, le résumé journalier et l'absence d'écriture incohérente ;
6. surveiller les 4xx/409 métier et les 5xx ;
7. élargir progressivement l'usage.

Ne pas supprimer V2 lors de cette étape.

## 6. Surveillance après activation

Surveiller particulièrement :

- erreurs 500 ;
- conflits d'idempotence ;
- transitions d'état refusées ;
- pointages sans planning ;
- événements `remote_not_authorized` ;
- événements `outside_geofence` ;
- `missing_in` / `missing_out` anormaux ;
- durées excessives ;
- écarts entre résumés et événements effectifs ;
- périodes ou journées qui ne peuvent plus être recalculées ;
- snapshot paie consommé deux fois.

Tout incident ayant un risque sur la paie ou l'intégrité des horaires déclenche le rollback logique ci-dessous.

## 7. Rollback immédiat

### Niveau 1 — retour en `shadow`

Utiliser ce niveau si la V3 doit arrêter d'être le moteur actif mais peut continuer à être observée.

1. passer `pointeuse_v3_mode` de `active` à `shadow` ;
2. confirmer que V2 reste accessible ;
3. ne supprimer aucun événement V3 ;
4. isoler la période affectée ;
5. relancer le rapprochement après correction ;
6. ne revenir en `active` qu'après nouveau feu vert.

### Niveau 2 — `disabled`

Utiliser ce niveau si même l'exécution V3 en observation présente un risque technique ou opérationnel.

1. passer `pointeuse_v3_mode` à `disabled` ;
2. maintenir V2 comme voie de continuité ;
3. conserver tables, événements, audits et snapshots pour analyse ;
4. corriger hors production ;
5. repartir obligatoirement par `shadow`, jamais directement par `active`.

### Niveau 3 — rollback applicatif du SHA

À utiliser si l'incident vient du code déployé et n'est pas maîtrisable par le kill-switch.

1. conserver les logs, le SHA fautif et l'heure de début d'incident ;
2. déployer le dernier SHA de production connu sain ;
3. ne pas supprimer les migrations/tables V3 à chaud ;
4. vérifier `/api/health`, V2 et les fonctions RH critiques ;
5. analyser les données V3 écrites pendant la fenêtre d'incident avant toute nouvelle activation.

## 8. Interdictions de rollback

Ne jamais :

- supprimer les événements V3 pour « nettoyer » un incident ;
- modifier directement un événement physique append-only ;
- rouvrir ou recalculer silencieusement une journée/période clôturée ;
- réutiliser un snapshot paie déjà consommé ;
- forcer `active` pour contourner une anomalie de rapprochement ;
- désactiver V2 avant la fin formelle de la période de coexistence.

## 9. Critères de sortie de coexistence V2/V3

La suppression future de V2 doit faire l'objet d'un chantier séparé. Conditions minimales :

- période d'exploitation V3 stable validée ;
- rapprochements successifs sans divergence inexpliquée ;
- clôture et paie validées en conditions réelles ;
- procédure de correction RH éprouvée ;
- supervision et alerting opérationnels ;
- décision explicite de retrait V2.

Tant que ces conditions ne sont pas réunies, V2 reste le filet de continuité.
