# 07 — Audit budget

## Constat unique et structurant

### ANO-BUD-01 — Le moteur budgétaire n'existe pas — **HAUTE** (classement : absente)

Ce qui existe :
- table `budgets` (migration 001 : mois, annee, categorie_id, montant — `uq_budget_periode`) ;
- colonne `operations.budget_status` (migration 024, défaut `'pending'`) ;
- affichage du statut dans les réponses API (`operations.js:979,2323`) avec message « Impact budget non confirmé » (`operations.js:99-101`).

Ce qui n'existe pas :
- aucun service ne calcule le budget **engagé** ni **réalisé** ;
- aucun contrôle de disponibilité budgétaire avant soumission ou paiement d'un décaissement (exigence PRD flux §10.4 : « Budget dépassé sans autorisation » doit bloquer) ;
- `budget_status` ne passe jamais à `'synced'` : seules les valeurs `'pending'` (création/paiement) et `'cancelled'` (annulation) sont écrites ;
- aucune route CRUD budgets exploitée par un écran de gestion budgétaire à jour ;
- aucun test.

Preuve d'absence : `grep budget_status backend/` ne montre que des SET 'pending'/'cancelled' et des SELECT d'affichage ; aucun UPDATE vers 'synced', aucun SELECT de contrôle `budgets` dans un chemin d'écriture.

Confirmation externe : la PR 64 embarque `docs/PRD_MOTEUR_BUDGETAIRE_GOUVERNANCE_FINANCIERE.md` (593 lignes) — un PRD complet pour construire ce moteur, ce qui acte son inexistence.

## Conséquence métier
Les exigences du PRD flux « contrôler les budgets avant engagement ou réalisation », « budgets engagés et réalisés », « écarts » sont sans objet aujourd'hui : un décaissement peut dépasser n'importe quel budget sans avertissement. Le tableau `Budget prévu / engagé / réalisé / écarts` de l'architecture cible (§7) n'a pas de source de données.

## Correction minimale (ordre)
1. Service `budget-engine` : `engage(operation)` à l'approbation, `realise(operation)` au paiement, clés (annee, mois, categorie_id) ; écrit dans la transaction de la transition.
2. Contrôle bloquant paramétrable avant approbation de décaissement (`budget_control_mode` ∈ off/warn/block — démarrer en `warn`).
3. Passage de `budget_status` à `'synced'` dans la même transaction.
4. Reconstruction : script de recalcul engagé/réalisé depuis l'historique, idempotent.
5. Tests MySQL : dépassement bloqué, annulation qui libère l'engagement, contre-opération qui reverse le réalisé.

À séquencer **après** l'activation du ledger canonique (le réalisé doit se brancher sur la prise d'effet, pas sur le statut legacy).

## Verdict module
**Non exploitable** (absent). Ne pas afficher d'écrans budget en production tant que le moteur n'existe pas — l'affichage actuel de `budget_status='pending'` est déjà trompeur pour l'utilisateur.
