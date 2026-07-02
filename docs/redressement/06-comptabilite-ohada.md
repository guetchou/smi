# 06 — Audit Comptabilité OHADA

## 1. Verdict provisoire

**Comptabilité OHADA : exploitable sous conditions, non démontrée comme chaîne complète et atomique avec la trésorerie.**

Le dépôt contient un moteur comptable structuré :

- plan de comptes ;
- règles de mapping ;
- génération d’écritures ;
- brouillons comptables ;
- validation / posting ;
- contrôle débit = crédit ;
- périodes clôturées ;
- contre-écritures ;
- anomalies et erreurs de synchronisation ;
- audit des générations, postings et reversals.

La faiblesse principale n’est pas l’absence de comptabilité. Elle est la séparation entre l’effet financier et la comptabilisation : une opération peut devenir effective en trésorerie, puis recevoir plus tard une écriture brouillon, une erreur de mapping ou aucune écriture postée.

## 2. Modèle observé

### 2.1 Sources comptables prises en charge

Le service `backend/services/accounting.js` accepte :

```text
encaissement → cash_receipt
décaissement → cash_disbursement
virement     → internal_transfer
```

Une contre-écriture utilise :

```text
accounting_reversal
```

### 2.2 Éligibilité actuelle

Une opération est comptabilisable si :

- son type est encaissement, décaissement ou virement ;
- `statut = valide` ;
- pour un décaissement, `dec_statut = paye` ;
- son montant est strictement positif ;
- sa période mensuelle n’est pas clôturée.

Cette logique reste liée aux statuts historiques et doit être réconciliée avec les statuts canoniques proposés.

### 2.3 Mapping comptable

Les règles de mapping peuvent dépendre de :

- type d’opération ;
- nature / catégorie ;
- mode de paiement ;
- type de position ;
- type de tiers ;
- compte débit ;
- compte crédit ;
- journal comptable.

Le moteur sélectionne la règle active la plus spécifique puis, à égalité, la plus ancienne par identifiant.

### 2.4 Génération

La génération :

1. verrouille son travail dans une transaction propre ;
2. vérifie l’éligibilité de l’opération ;
3. recherche une écriture existante pour éviter un doublon ;
4. vérifie la période ;
5. recherche un mapping actif ;
6. crée une écriture `draft` ;
7. crée deux lignes de même montant, une au débit et une au crédit ;
8. place `operations.accounting_status = pending` ;
9. crée une erreur de synchronisation `ACCOUNTING_SYNC_PENDING` ;
10. écrit l’audit.

### 2.5 Posting

Le posting :

- refuse une écriture annulée ;
- refuse une période clôturée ;
- exige au moins deux lignes ;
- exige un débit strictement positif ;
- exige `|débit - crédit| < 0,01` ;
- passe l’écriture de `draft` à `posted` avec garde de concurrence ;
- synchronise le statut de l’opération ;
- résout les erreurs ouvertes ;
- audite l’écriture et l’opération dans la même transaction du posting.

### 2.6 Contre-écriture

Le reversal :

- exige une écriture d’origine `posted` ;
- interdit la contre-passation directe d’une contre-écriture ;
- interdit une date antérieure à l’écriture d’origine ;
- exige un motif de cinq caractères minimum ;
- vérifie que la période de reversal est ouverte ;
- crée une écriture `draft` idempotente ;
- inverse chaque ligne débit / crédit ;
- conserve les références tiers, position et budget ;
- audite la génération.

La contre-écriture doit ensuite être postée pour produire un statut comptable annulé sur l’opération source.

## 3. Invariant principal

```text
Total débit = Total crédit
```

Le service applique une tolérance technique de `0,01`.

Cet invariant est contrôlé au posting. Il est également affiché dans le tableau de bord comptable pour les écritures postées.

Limite : les sommes sont converties en `Number`, ce qui reste un risque de précision pour les calculs décimaux étendus.

## 4. Anomalies

## ACC-001 — Effet métier et comptabilité non atomiques

- **Gravité : critique**
- **Exigence :** opération métier → trésorerie → écriture OHADA sans rupture silencieuse.
- **Preuve :** `generateAccountingEntryForOperation()` ouvre sa propre transaction ; `attemptAutomaticAccountingForOperation()` capture l’erreur et retourne un objet d’échec au lieu de bloquer systématiquement l’opération métier.
- **Scénario :** valider / payer une opération sans mapping actif.
- **Conséquence métier :** argent réellement entré ou sorti sans écriture comptable postée.
- **Correction minimale :** choisir et documenter un contrat unique :
  - soit génération comptable atomique dans la transaction métier ;
  - soit création obligatoire d’une anomalie bloquante empêchant clôture, rapprochement final et reporting définitif.
- **Tests :** échec mapping, panne SQL, retry idempotent, clôture refusée.
- **Risque de régression :** élevé.
- **Statut : ouvert.**

## ACC-002 — Génération en brouillon considérée comme erreur de synchronisation

- **Gravité : moyenne**
- **Preuve :** après génération normale, le service crée `ACCOUNTING_SYNC_PENDING` dans `sync_errors`.
- **Conséquence métier :** une étape normale du workflow et une vraie erreur technique utilisent la même infrastructure d’anomalie, ce qui brouille les indicateurs.
- **Correction minimale :** distinguer `pending_validation` d’une erreur `failed`, avec une file métier séparée ou une sévérité explicite.
- **Tests :** tableau de bord ne compte pas un brouillon normal comme incident critique.
- **Risque :** faible.
- **Statut : ouvert.**

## ACC-003 — Permissions par rôles larges

- **Gravité : haute**
- **Preuve :** `canManageAccounting()` autorise `admin`, `finance`, `dg` pour le paramétrage comptable.
- **Conséquence métier :** cumul possible de création de mapping, activation, génération, posting et reversal.
- **Correction minimale :** permissions effectives distinctes et séparation des fonctions.
- **Tests :** matrice refus / autorisation côté serveur.
- **Statut : ouvert.**

## ACC-004 — Création d’un mapping directement actif

- **Gravité : haute**
- **Preuve :** `normalizeRuleInput()` accepte `is_active`; la route de création enregistre cette valeur. L’endpoint d’activation séparé exige pourtant une confirmation explicite.
- **Scénario :** POST d’une règle avec `is_active=1`.
- **Conséquence métier :** contournement du contrôle et de l’audit d’activation.
- **Correction minimale :** créer toute règle inactive ; imposer un endpoint d’activation séparé.
- **Tests :** création active impossible.
- **Statut : ouvert.**

## ACC-005 — Mapping d’un virement potentiellement trop simpliste

- **Gravité : haute**
- **Preuve :** un virement utilise une seule règle avec un compte débit et un compte crédit, tandis que les positions source et destination sont enregistrées sur les lignes.
- **Conséquence métier :** si les comptes de trésorerie doivent dépendre de chaque position, une règle générique peut utiliser les mauvais comptes bancaires ou de caisse.
- **Correction minimale :** lier chaque position de trésorerie à son compte comptable canonique et générer le débit / crédit depuis les positions, pas uniquement depuis une règle globale.
- **Tests :** transfert banque A → caisse B, banque A → banque B, Mobile Money → caisse.
- **Statut : à vérifier.**

## ACC-006 — Type de tiers insuffisamment précis

- **Gravité : haute**
- **Preuve :** le moteur distingue principalement `agent`, `tiers` ou `*` selon `employe_id` et le texte `tiers`.
- **Conséquence métier :** fournisseur, client, État, associé et salarié peuvent être regroupés dans un type générique et recevoir un mapping inadéquat.
- **Correction minimale :** identifiant et type de tiers structurés : client, fournisseur, salarié, État, associé, autre.
- **Tests :** même catégorie payée à plusieurs types de tiers.
- **Statut : ouvert.**

## ACC-007 — Nature comptable fondée sur l’identifiant de catégorie

- **Gravité : haute**
- **Preuve :** `operation_nature` compare la chaîne de `categorie_id`.
- **Conséquence métier :** le mapping dépend d’un identifiant technique local, instable entre environnements ou migrations, plutôt que d’un code métier immuable.
- **Correction minimale :** utiliser un code canonique de nature comptable, versionné et unique.
- **Tests :** import / restauration avec identifiants différents mais codes identiques.
- **Statut : ouvert.**

## ACC-008 — Montants convertis en flottants JavaScript

- **Gravité : haute**
- **Preuve :** `Number(operation.montant).toFixed(2)`, sommes `Number`, comparaison à 0,01.
- **Conséquence métier :** risque d’écart sur devises, taux, proratas et grands volumes.
- **Correction minimale :** unités mineures entières ou bibliothèque décimale ; garder les DECIMAL sous forme sûre jusqu’à la base.
- **Tests :** 0,1 + 0,2, grands montants, taux, répétition de milliers de lignes.
- **Statut : ouvert.**

## ACC-009 — Clôture mensuelle seulement

- **Gravité : haute**
- **Preuve :** le service vérifie `periodes_cloturees` par année et mois.
- **Conséquence métier :** aucune preuve que la clôture journalière de caisse ou le rapprochement bancaire empêchent une écriture rétroactive dans une journée déjà arrêtée.
- **Correction minimale :** contrôle des clôtures comptables, de trésorerie et de caisse selon la date et la position concernée.
- **Tests :** écriture sur journée clôturée mais mois ouvert.
- **Statut : ouvert.**

## ACC-010 — Date et fuseau

- **Gravité : moyenne**
- **Preuve :** les validations de période utilisent `new Date(...T00:00:00)` et `getFullYear/getMonth`; le reversal par défaut utilise la date locale du processus Node.
- **Conséquence métier :** comportement dépendant du fuseau du conteneur si celui-ci n’est pas `Africa/Brazzaville`.
- **Correction minimale :** utilitaire de date métier avec fuseau explicite et tests près de minuit.
- **Statut : ouvert.**

## ACC-011 — Unicité et concurrence de génération à prouver au niveau DB

- **Gravité : haute**
- **Preuve :** le service recherche d’abord une écriture existante, mais la preuve d’une contrainte unique MySQL sur `(source_module, source_record_id)` n’a pas encore été établie dans cette passe.
- **Conséquence métier :** deux requêtes concurrentes peuvent théoriquement créer deux brouillons si la base ne protège pas l’unicité.
- **Correction minimale :** contrainte unique compatible avec le reversal et gestion `ER_DUP_ENTRY` idempotente.
- **Tests :** double génération concurrente MySQL.
- **Statut : impossible à vérifier.**

## ACC-012 — Immutabilité des écritures postées à prouver sur toutes les routes

- **Gravité : critique**
- **Preuve :** le service de posting ne modifie plus les lignes ; le reversal existe. Mais toutes les routes génériques de mise à jour / suppression des écritures et lignes n’ont pas encore été inventoriées.
- **Conséquence métier :** une écriture postée pourrait rester modifiable par un autre endpoint ou script.
- **Correction minimale :** recherche exhaustive, garde DB/service et tests négatifs.
- **Statut : impossible à vérifier.**

## ACC-013 — Affectations tiers et budget seulement transportées

- **Gravité : haute**
- **Preuve :** les lignes comptables possèdent `third_party_id` et `budget_line_id`; le reversal les recopie, mais la génération standard observée ne les renseigne pas.
- **Conséquence métier :** écritures équilibrées mais sans auxiliaire tiers ni consommation budgétaire exploitable.
- **Correction minimale :** dériver les affectations depuis le document source et refuser le posting lorsqu’elles sont obligatoires.
- **Tests :** fournisseur, client, salaire, avance, budget.
- **Statut : partiellement conforme.**

## ACC-014 — Plan OHADA non certifié fonctionnellement

- **Gravité : haute**
- **Preuve :** des comptes et mappings existent, mais leur conformité métier au référentiel OHADA n’est pas démontrée par le code seul.
- **Conséquence métier :** équilibre mathématique possible avec comptes incorrects.
- **Correction minimale :** validation du plan et des règles par un comptable habilité ; version du référentiel et date d’effet.
- **Tests :** scénarios comptables validés métier, pas seulement tests techniques.
- **Statut : impossible à vérifier techniquement.**

## 5. Matrice du workflow comptable

| État source | Action | Autorisation cible | Conditions | État cible | Effets | Transaction | Audit | Tests requis |
|---|---|---|---|---|---|---|---|---|
| opération effective | générer | accounting.entry.generate | période ouverte, mapping actif | écriture draft | lignes débit/crédit, status pending | oui dans service | oui | mapping absent, concurrence, idempotence |
| draft | poster | accounting.entry.post | période ouverte, >=2 lignes, équilibrée | posted | opération synced | oui | oui | double posting, déséquilibre, période close |
| posted | générer reversal | accounting.entry.reverse | motif, date >= origine, période ouverte | reversal draft | lignes inversées | oui | oui | double reversal, période close |
| reversal draft | poster | accounting.entry.post/reverse | équilibrée, période ouverte | posted | opération cancelled | oui | oui | concurrence et idempotence |

## 6. Conditions minimales pour qualifier le module exploitable

1. contrainte d’unicité prouvée sur les écritures sources ;
2. aucune route ne modifie une écriture postée ;
3. permissions effectives séparées ;
4. règles créées inactives ;
5. types de tiers et natures canoniques ;
6. compte de trésorerie dérivé de chaque position ;
7. comptabilité manquante bloquante à la clôture ;
8. tests MySQL de concurrence ;
9. exactitude décimale ;
10. validation métier du plan OHADA et des mappings.

## 7. Prochaine vérification

La suite logique est `07-budget.md`, car les lignes comptables et le PRD annoncent un lien budgétaire qui n’est pas encore prouvé dans le flux effectif.
