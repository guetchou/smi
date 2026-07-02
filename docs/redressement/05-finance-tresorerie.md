# 05 — Audit Finance et Trésorerie

## 1. Verdict provisoire

**Finance / Trésorerie : non exploitable comme source comptable unique en l’état, exploitable sous contrôle pour certains workflows isolés.**

Ce verdict ne signifie pas que tout est cassé. Le dépôt contient des briques sérieuses :

- un service canonique `backend/services/treasury-ledger.js` ;
- un cache `cashbox_balances` verrouillé avec `FOR UPDATE` ;
- un ledger append-only `cash_ledger` ;
- une migration dédiée `037_treasury_ledger_canonical.sql` ;
- un service de diagnostic `backend/services/finance-integrity.js` ;
- des services comptables et des écritures débit/crédit ;
- des tests contractuels et des scripts MySQL.

Cependant, ces briques ne prouvent pas encore que tous les flux de production passent exclusivement par elles. Le dépôt conserve des chemins historiques basés sur `operations`, `solde_position`, des recalculs dynamiques et des routes génériques. La migration 037 est explicitement additive, sans backfill ni activation automatique. Les positions restent `legacy` tant qu’elles ne sont pas préparées.

## 2. Modèle financier actuellement observé

### 2.1 Document métier

La table `operations` porte encore plusieurs responsabilités :

- demande ou opération métier ;
- workflow d’encaissement ou de décaissement ;
- position source et destination ;
- statut de validation ;
- statut de paiement ;
- statut comptable ;
- statut de rapprochement ;
- historique de solde via `solde_position` dans le modèle ancien.

Cette concentration explique une grande partie de la confusion actuelle.

### 2.2 Ledger de trésorerie

Le service `treasury-ledger.js` définit correctement les jambes attendues :

| Type opération | Jambe attendue |
|---|---|
| encaissement | crédit de la position destination |
| décaissement | débit de la position payeuse |
| virement | débit source + crédit destination |

Le service :

- refuse les montants nuls ou négatifs ;
- exige une opération effective ;
- exige un décaissement payé ;
- verrouille les positions et le cache de solde avec `FOR UPDATE` ;
- contrôle la divergence entre dernier ledger et cache ;
- empêche les soldes négatifs sauf override explicite ;
- assure l’idempotence par `operation_id + leg_code` ;
- détecte les opérations partiellement postées ;
- met à jour le ledger, le cache, le statut trésorerie et l’audit dans la même transaction.

Cette conception est cohérente avec la cible industrielle.

### 2.3 Activation progressive

La migration 037 ajoute :

```text
positions.ledger_status = legacy | ready
positions.ledger_ready_at
positions.ledger_ready_by
cash_ledger.leg_code
cash_ledger.reversal_of_ledger_id
UNIQUE(operation_id, leg_code)
```

Mais elle précise :

```text
Additive uniquement. Aucun backfill et aucune activation automatique.
```

Conséquence : l’existence du service canonique ne garantit pas qu’une position réelle soit `ready`, ni que son historique soit cohérent avec le ledger.

### 2.4 Comptabilité générale

Le module `backend/routes/accounting.js` utilise un service dédié et expose :

- plan de comptes ;
- règles de mapping ;
- tableau de bord comptable ;
- écritures ;
- anomalies ;
- activation / désactivation des mappings ;
- génération et contre-passation via le service comptable.

Le tableau de bord convertit explicitement les valeurs MySQL en `Number`, puis vérifie l’équilibre débit/crédit avec une tolérance de 0,01.

Limite : les permissions de gestion comptable restent basées sur `hasRole(admin, finance, dg)` au lieu d’une permission effective canonique.

## 3. Chaîne cible et niveau de preuve

```text
Opération métier
→ mouvement de trésorerie
→ cache de solde
→ écriture OHADA
→ affectation tiers
→ impact budget
→ reporting
→ audit
```

| Maillon | État observé | Verdict |
|---|---|---|
| Opération métier | `operations` et workflows spécialisés existent | partiellement conforme |
| Mouvement trésorerie | service ledger canonique existe | conforme en conception, adoption non prouvée |
| Cache solde | verrouillé et mis à jour transactionnellement dans le service canonique | conforme si position `ready` |
| Écriture OHADA | service, mappings, posting et reversal existent | partiellement conforme |
| Affectation tiers | fondations finance présentes | intégration bout en bout non prouvée |
| Budget | non cartographié complètement | impossible à vérifier |
| Reporting | endpoints et dashboard existent | fiabilité dépendante des sources utilisées |
| Audit | inclus dans certaines transactions | non généralisé à tous les chemins |

## 4. Anomalies

## FIN-001 — Plusieurs sources de vérité pour le solde

- **Gravité : critique**
- **Exigence PRD :** source canonique unique des soldes.
- **Preuve :** coexistence de calculs depuis `operations`, champ `operations.solde_position`, `cash_ledger`, `cashbox_balances` et agrégats de reporting.
- **Fichiers :** `backend/routes/operations.js`, `backend/routes/dashboard.js`, `backend/services/treasury-ledger.js`, `backend/services/finance-integrity.js`, `docs/audits/accounting-flow-control-2026-06-23.md`.
- **Scénario :** comparer le solde calculé depuis les opérations à celui du dernier ledger puis au cache.
- **Conséquence métier :** soldes journaliers différents selon écran, route ou date de recalcul.
- **Correction minimale :** rendre le ledger obligatoire pour toute position `ready`, interdire la lecture du solde depuis `operations` pour ces positions et afficher explicitement les positions `legacy`.
- **Tests :** MySQL avec encaissement, décaissement, transfert, rétrodatation, concurrence et reconstruction du cache.
- **Risque de régression :** élevé, car de nombreux écrans historiques utilisent les opérations.
- **Statut : ouvert.**

## FIN-002 — Migration canonique sans backfill ni activation

- **Gravité : critique**
- **Exigence PRD :** chaque mouvement effectif doit être présent dans le ledger.
- **Preuve :** migration 037 additive, positions par défaut `legacy`, aucun backfill automatique.
- **Scénario :** sélectionner une position historique non préparée et tenter un posting canonique.
- **Conséquence métier :** les nouvelles garanties existent dans le code mais ne couvrent pas nécessairement les positions réelles.
- **Correction minimale :** produire un plan de backfill en lecture seule, comparer les historiques, faire valider les écarts puis activer position par position.
- **Tests :** migration idempotente, backfill sur données contrôlées, reprise après interruption.
- **Risque de régression :** critique si activation sans validation métier.
- **Statut : ouvert.**

## FIN-003 — Statut effectif encore basé sur les colonnes historiques

- **Gravité : haute**
- **Exigence PRD :** workflow canonique explicite.
- **Preuve :** `treasury-ledger.js` et `finance-integrity.js` considèrent l’opération effective lorsque `statut='valide'`, et pour un décaissement `dec_statut='paye'`.
- **Conséquence métier :** le nouveau ledger dépend toujours de l’ancien modèle de statuts au lieu des dimensions `business_status`, `approval_status`, `payment_status`.
- **Correction minimale :** définir une fonction canonique unique d’effectivité et migrer progressivement les routes et services.
- **Tests :** matrice complète des combinaisons de statuts.
- **Risque de régression :** élevé.
- **Statut : ouvert.**

## FIN-004 — Numérique monétaire géré en `Number`

- **Gravité : haute**
- **Exigence PRD :** exactitude des montants MySQL décimaux.
- **Preuve :** `money()` et `amount()` convertissent les DECIMAL MySQL en `Number`, puis arrondissent à deux décimales.
- **Conséquence métier :** la précision est acceptable pour XAF sans centimes, mais reste fragile pour devises, proratas, taux ou agrégations importantes.
- **Correction minimale :** définir un contrat monétaire en unités mineures entières ou bibliothèque décimale ; interdire les calculs libres en flottants.
- **Tests :** grands montants, décimaux, sommes répétées, conversions et égalité débit/crédit.
- **Risque de régression :** moyen à élevé.
- **Statut : ouvert.**

## FIN-005 — Permissions comptables fondées sur les rôles

- **Gravité : haute**
- **Exigence PRD :** autorisation fondée sur permissions effectives.
- **Preuve :** `canManageAccounting()` retourne vrai pour `admin`, `finance`, `dg` via `hasRole`.
- **Conséquence métier :** une personne peut cumuler création de mapping, activation, génération, validation et contre-passation.
- **Correction minimale :** permissions séparées : `accounting.mapping.manage`, `accounting.entry.generate`, `accounting.entry.post`, `accounting.entry.reverse`, `accounting.audit.view`.
- **Tests :** refus backend même si l’écran est visible ; séparation des fonctions.
- **Risque de régression :** moyen.
- **Statut : ouvert.**

## FIN-006 — Création de règle comptable directement active

- **Gravité : haute**
- **Exigence PRD :** activation contrôlée et séparation des fonctions.
- **Preuve :** la création de mapping accepte `rule.is_active`, tandis que l’endpoint d’activation exige une confirmation explicite.
- **Scénario :** créer une nouvelle règle avec `is_active=1`.
- **Conséquence métier :** contournement du contrôle d’activation.
- **Correction minimale :** toute nouvelle règle doit être créée inactive ; activation séparée, auditée et autorisée.
- **Tests :** création active refusée, activation avec confirmation, acteur distinct si exigé.
- **Risque de régression :** faible.
- **Statut : ouvert.**

## FIN-007 — Diagnostic finance incomplet sur `leg_code`

- **Gravité : moyenne**
- **Exigence PRD :** contrôle exact de l’idempotence et des jambes attendues.
- **Preuve :** `treasury-ledger.js` utilise `leg_code`, mais `finance-integrity.js` charge le ledger sans sélectionner `leg_code` et vérifie les jambes principalement par position/type/montant.
- **Conséquence métier :** certaines incohérences de code de jambe ou collisions sémantiques peuvent ne pas être signalées par le rapport d’intégrité.
- **Correction minimale :** inclure `leg_code`, `reversal_of_ledger_id` et `treasury_status` dans le diagnostic.
- **Tests :** jambe mal codée, doublon même montant, transfert partiel.
- **Risque de régression :** faible.
- **Statut : ouvert.**

## FIN-008 — Date opérationnelle et ordre du ledger

- **Gravité : critique**
- **Exigence PRD :** solde historique à date et clôture journalière fiable.
- **Preuve :** le ledger est ordonné par `created_at, id`; le posting utilise `NOW()` et ne conserve pas explicitement dans la ligne la date opérationnelle de l’opération.
- **Conséquence métier :** une opération rétrodatée postée aujourd’hui apparaît aujourd’hui dans la séquence du ledger ; le solde au 31 mars à 17h ne peut pas être reconstruit proprement par date opérationnelle.
- **Correction minimale :** ajouter `effective_at` / `operation_date` canonique au ledger, définir la politique de rétroactivité et interdire l’insertion dans une journée clôturée.
- **Tests :** opération rétrodatée, même timestamp, clôture passée, solde à date/heure.
- **Risque de régression :** critique.
- **Statut : ouvert.**

## FIN-009 — Reversal ledger non encore prouvé dans le service principal

- **Gravité : critique**
- **Exigence PRD :** aucune suppression destructive ; correction par contre-mouvement.
- **Preuve :** migration 037 ajoute `reversal_of_ledger_id`, mais le service lu expose le posting initial et pas encore une opération publique de reversal ledger complète.
- **Conséquence métier :** l’infrastructure existe sans preuve que toutes les annulations après effet créent les jambes inverses.
- **Correction minimale :** service canonique de reversal idempotent, transactionnel, lié à l’original et protégé après clôture.
- **Tests :** double reversal, reversal partiel interdit, transfert inversé à deux jambes, audit.
- **Risque de régression :** élevé.
- **Statut : ouvert.**

## FIN-010 — Comptabilité non prouvée atomique avec l’effet financier

- **Gravité : critique**
- **Exigence PRD :** opération → trésorerie → comptabilité sans rupture silencieuse.
- **Preuve :** services comptables séparés et statut `accounting_status`; le diagnostic recherche les opérations effectives sans écriture postée.
- **Conséquence métier :** une opération peut avoir effet en trésorerie tout en restant sans écriture OHADA postée.
- **Correction minimale :** définir une politique explicite : soit atomicité complète, soit file d’anomalies bloquante empêchant clôture et reporting final.
- **Tests :** échec mapping, échec écriture après ledger, retry idempotent, clôture interdite.
- **Risque de régression :** élevé.
- **Statut : ouvert.**

## FIN-011 — Budget non prouvé dans le flux financier

- **Gravité : haute**
- **Exigence PRD :** contrôle budget avant engagement et réalisation.
- **Preuve :** le PRD exige l’impact budget, mais les services audités ici ne démontrent pas ce maillon.
- **Conséquence métier :** paiement possible sans consommation ou contrôle budgétaire cohérent.
- **Correction minimale :** cartographie dédiée `07-budget.md`, puis contrat transactionnel d’engagement et réalisation.
- **Tests :** dépassement, réservation concurrente, annulation, transfert budgétaire.
- **Risque de régression :** à déterminer.
- **Statut : impossible à vérifier.**

## FIN-012 — Journal financier journalier absent comme vue canonique

- **Gravité : critique**
- **Exigence PRD :** connaître par jour les encaissements, décaissements, versements, retraits, transferts et soldes.
- **Preuve :** plusieurs endpoints et dashboards existent, mais aucun contrat unique vérifié ne produit : ouverture + mouvements + transferts + régularisations + clôture + écart.
- **Conséquence métier :** les utilisateurs ne savent pas expliquer une journée financière.
- **Correction minimale :** après diagnostic F0, créer une vue canonique en lecture seule fondée sur le ledger, sans correction automatique.
- **Tests :** journée vide, multi-position, transfert, opération en transit, rétroactivité, clôture.
- **Risque de régression :** faible si lecture seule.
- **Statut : absent ou non prouvé.**

## 5. Invariants à prouver avant toute activation globale

1. Chaque opération effective possède exactement les jambes ledger attendues.
2. Chaque jambe est unique par `operation_id + leg_code`.
3. Le cache égale le dernier `solde_apres` du ledger.
4. Le ledger peut reconstruire le cache depuis le solde initial.
5. Aucun débit ne rend le solde négatif sans autorisation explicite et auditée.
6. Un transfert possède exactement deux jambes opposées et ne modifie pas le consolidé.
7. Une annulation après effet produit une contre-opération, jamais une suppression.
8. Une journée clôturée refuse toute opération rétroactive.
9. Toute opération effective est comptabilisée ou apparaît comme anomalie bloquante.
10. Toute écriture postée respecte `total débit = total crédit`.
11. Une référence externe ne peut être consommée deux fois.
12. Les permissions sont vérifiées côté serveur par permission effective.

## 6. Tests existants à réutiliser

- `tests/treasury_ledger_canonical_contract_test.js`
- `scripts/test_treasury_ledger_canonical_mysql.js`
- `scripts/test_finance_integrity_mysql.js`
- `tests/finance_operations_model_test.js`
- `scripts/test_cash_receipt_workflow_mysql.js`
- tests comptables de posting, reversal et période clôturée.

Leur présence ne vaut pas exécution. Chaque résultat devra être collecté avec : SHA, moteur MySQL, migrations appliquées, jeu de données, sortie et date.

## 7. Ordre de redressement recommandé

### F0.1 — Diagnostic de production en lecture seule

Exécuter `finance-integrity` sur une copie restaurée de la base réelle et produire :

- opérations effectives sans ledger ;
- ledger orphelin ;
- jambes manquantes ou dupliquées ;
- écarts operations / ledger / cache ;
- écritures manquantes ou déséquilibrées ;
- opérations annulées sans reversal ;
- positions `legacy` et `ready`.

### F0.2 — Inventaire par journée et position

Pour chaque position :

- solde initial ;
- premier et dernier mouvement ;
- nombre d’opérations historiques ;
- nombre de lignes ledger ;
- solde operations ;
- solde ledger ;
- solde cache ;
- dernier rapprochement ;
- dernière clôture.

### F0.3 — Validation métier des écarts

Aucun backfill automatique avant validation Finance/DG des écarts et des soldes d’ouverture.

### F1 — Activation progressive

Activer une seule position pilote après :

- sauvegarde ;
- rapport sans anomalie critique ;
- backfill validé ;
- tests MySQL ;
- procédure de rollback ;
- journal journalier en lecture seule.

## 8. Conclusion

Le dépôt contient la base technique d’un moteur de trésorerie industriel, mais la situation opérationnelle reste hybride. Le risque principal n’est plus l’absence de code : c’est la coexistence du nouveau moteur avec les anciennes sources et l’absence de preuve que les données réelles ont été migrées, rapprochées et activées.

La prochaine action sûre est un diagnostic MySQL en lecture seule sur une copie de la base réelle. Aucun recalcul destructif, backfill ou activation globale ne doit être lancé avant ce rapport.
