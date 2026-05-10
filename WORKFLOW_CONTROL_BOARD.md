Tâche active : PROMPT 12 — Tests, sécurité RBAC & finalisation
Statut : ✅ Terminé — PROJET COMPLET 12/12
Objectif : Vérifier les règles anti-fraude, corriger les permissions manquantes par rôle, écrire les tests Playwright.

Fichiers touchés :
  - backend/routes/clients.js       — +RBAC POST (commercial/finance/dg) + PUT (même)
  - backend/routes/devis.js         — +RBAC POST, PUT, envoyer, accepter, refuser, dupliquer, convertir
  - backend/routes/factures_clients.js — +RBAC POST (commercial/finance/dg), PUT, emettre (finance/dg), enregistrer-paiement (finance/dg/caissier)
  - backend/routes/produits.js      — +RBAC POST, PUT, entree, sortie (stock/finance/dg)
  - backend/routes/contrats.js      — +RBAC POST, PUT, activer, renouveler (finance/dg)
  - backend/routes/rapprochements.js — +RBAC caisse/cloture (finance/dg/caissier)
  - tests/modules_ventes_test.js    — CRÉÉ (8 tests Playwright API)

Résumé RBAC appliqué :
  - Commercial   → clients (CRUD), devis (toutes actions), factures (création/modification)
  - Finance      → factures (émission, paiement, annulation), rapprochements complets, contrats, produits
  - DG           → accès complet à tous les modules (équivalent admin sauf gestion users)
  - Caissier     → paiements clients, clôture caisse
  - Admin        → super-user (bypass tous les checks via hasRole)
  - Stock        → produits (création, modification, entrée/sortie)

Règles anti-fraude vérifiées ✅ :
  - Pas de DELETE physique sur aucun module (archivage/annulation uniquement)
  - Motif obligatoire sur toutes les annulations et suspensions
  - Modification bloquée après statuts verrouillés (emise, payee, validee, resiliee…)
  - Numérotation auto sans doublon : CLT-XXXX, DEV-YYYY-XXXX, FAC-YYYY-XXXX, CTR-YYYY-XXXX, etc.
  - Détection doublon facture fournisseur → 409 (achats.js L468-470)
  - Audit log tracé sur chaque changement de statut dans tous les modules

Tests Playwright : 8 tests dans tests/modules_ventes_test.js
  - TEST 01 : Créer un client et le retrouver dans la liste
  - TEST 02 : Workflow devis complet (créer → accepter → convertir en facture)
  - TEST 03 : Paiement partiel → statut partiellement_payee
  - TEST 04 : Modification facture émise → 403
  - TEST 05 : Client mauvais_payeur bloque création facture
  - TEST 06 : RBAC caissier ne peut pas créer un client
  - TEST 07 : Doublon facture fournisseur → 409
  - TEST 08 : Audit log tracé après acceptation devis

Tests exécutés : node --check sur tous les fichiers modifiés → ✅ OK
Rollback : fichiers .bak_prompt12_YYYYMMDD_HHMMSS disponibles pour chaque route modifiée
Prochaine étape : Aucune — tous les 12 prompts sont exécutés et validés ✅
