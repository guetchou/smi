# Plan d'implémentation — Caisse Top Center
> Basé sur workflow.md — À cocher au fur et à mesure de l'exécution

**Progression : 5 / 12 prompts exécutés**

---

## Légende
- [ ] Prompt non exécuté
- [x] Prompt exécuté et validé

---

## État de l'existant (avant démarrage)

| Module | État |
|---|---|
| Caisse / Opérations (encaissement, décaissement, virement) | ✅ Complet |
| Salaires / Paie (bulletins, avances, email PDF) | ✅ Complet |
| RH / Agents (congés, mutations, documents, dossiers) | ✅ Complet |
| Demandes d'achat (partiel, sans BC ni réception) | ⚠️ Partiel |
| Notifications / Alertes (règles, cron, push) | ⚠️ Partiel |
| Tableaux de bord (KPIs basiques) | ⚠️ Partiel |
| Clients / Devis / Factures clients | ❌ Manquant |
| Bon de commande → Réception → Facture fournisseur | ❌ Manquant |
| Stock / Produits | ❌ Manquant |
| Contrats / Paiements récurrents | ❌ Manquant |
| Rapprochement bancaire / Clôture caisse | ❌ Manquant |
| Relances automatiques clients | ❌ Manquant |

---

## Checklist des prompts

---

### [x] PROMPT 1 — Module Clients (backend : table + API)

**Objectif :** Créer la base clients avec numérotation auto, statuts, plafond crédit, encours.

**Fichiers à créer / modifier :**
- `backend/database.js` — ajouter table `clients`
- `backend/routes/clients.js` — créer (nouveau fichier)
- `backend/server.js` — monter `/api/clients`

**Tables créées :**
- `clients`

**Endpoints créés :**
- `GET    /api/clients`
- `POST   /api/clients`
- `GET    /api/clients/:id`
- `PUT    /api/clients/:id`
- `POST   /api/clients/:id/suspendre`
- `GET    /api/clients/:id/solde`

**Règles métier clés :**
- Numérotation auto CLT-XXXX
- Blocage si client suspendu ou mauvais payeur
- Alerte si encours > plafond_credit
- Audit log sur chaque modification

**Dépendances :** aucune

---

### [x] PROMPT 2 — Module Devis (backend : tables + API)

**Objectif :** Workflow complet devis avec lignes, calculs auto, gestion versions, conversion en facture.

**Fichiers à créer / modifier :**
- `backend/database.js` — ajouter tables `devis`, `devis_lignes`
- `backend/routes/devis.js` — créer (nouveau fichier)
- `backend/server.js` — monter `/api/devis`

**Tables créées :**
- `devis`
- `devis_lignes`

**Endpoints créés :**
- `GET    /api/devis`
- `POST   /api/devis`
- `GET    /api/devis/:id`
- `PUT    /api/devis/:id`
- `POST   /api/devis/:id/envoyer`
- `POST   /api/devis/:id/accepter`
- `POST   /api/devis/:id/refuser`
- `POST   /api/devis/:id/dupliquer`
- `POST   /api/devis/:id/convertir`

**Règles métier clés :**
- Numérotation auto DEV-YYYY-XXXX
- Calcul HT / Taxes / TTC automatique
- Statut auto → `expire` si date_validite dépassée (cron 24h)
- Modification bloquée après statut ≠ brouillon
- Audit log sur chaque changement de statut

**Dépendances :** PROMPT 1 (clients)

---

### [x] PROMPT 3 — Module Factures Client (backend : tables + API)

**Objectif :** Facturation client complète avec paiements partiels, statuts, rapport impayés.

**Fichiers à créer / modifier :**
- `backend/database.js` — ajouter tables `factures_clients`, `factures_clients_lignes`
- `backend/routes/factures_clients.js` — créer (nouveau fichier)
- `backend/server.js` — monter `/api/factures-clients`

**Tables créées :**
- `factures_clients`
- `factures_clients_lignes`

**Endpoints créés :**
- `GET    /api/factures-clients`
- `POST   /api/factures-clients`
- `GET    /api/factures-clients/:id`
- `PUT    /api/factures-clients/:id`
- `POST   /api/factures-clients/:id/emettre`
- `POST   /api/factures-clients/:id/enregistrer-paiement`
- `POST   /api/factures-clients/:id/annuler`
- `GET    /api/factures-clients/rapport/impayes`

**Règles métier clés :**
- Numérotation auto FAC-YYYY-XXXX
- Interdiction de modifier après statut=emise
- Mise à jour solde client après paiement
- Alerte si date_echeance dépassée (cron 24h)
- Annulation avec motif obligatoire — jamais DELETE

**Dépendances :** PROMPT 1 (clients), PROMPT 2 (devis)

---

### [x] PROMPT 4 — Module Stock / Produits (backend : tables + API)

**Objectif :** Gestion produits avec stock disponible / réservé / minimum, mouvements traçés.

**Fichiers à créer / modifier :**
- `backend/database.js` — ajouter tables `produits`, `categories_produits`, `stock_mouvements`
- `backend/routes/produits.js` — créer (nouveau fichier)
- `backend/server.js` — monter `/api/produits`

**Tables créées :**
- `produits`
- `categories_produits`
- `stock_mouvements`

**Endpoints créés :**
- `GET    /api/produits`
- `POST   /api/produits`
- `GET    /api/produits/:id`
- `PUT    /api/produits/:id`
- `POST   /api/produits/:id/entree`
- `POST   /api/produits/:id/sortie`
- `POST   /api/produits/inventaire`
- `GET    /api/produits/alertes/stock-bas`

**Règles métier clés :**
- Numérotation auto PROD-XXXX
- stock_disponible = stock_physique - stock_reserve
- Blocage sortie si stock insuffisant
- Alerte si stock_disponible <= stock_minimum
- Mouvement créé à chaque opération (traçabilité complète)

**Dépendances :** aucune (indépendant)

---

### [x] PROMPT 5 — Module Achat complet : BC → Réception → Facture fournisseur

**Objectif :** Compléter le module achat existant avec le workflow complet jusqu'au paiement fournisseur.

**Fichiers à créer / modifier :**
- `backend/database.js` — ajouter 5 nouvelles tables
- `backend/routes/achats.js` — compléter sans écraser l'existant

**Tables créées :**
- `bons_commandes_fournisseurs`
- `bons_commandes_lignes`
- `receptions`
- `receptions_lignes`
- `factures_fournisseurs`

**Endpoints ajoutés (dans /api/achats) :**
- `POST   /api/achats/bons-commandes`
- `GET    /api/achats/bons-commandes`
- `GET    /api/achats/bons-commandes/:id`
- `PUT    /api/achats/bons-commandes/:id/statut`
- `POST   /api/achats/bons-commandes/:id/valider`
- `POST   /api/achats/receptions`
- `GET    /api/achats/receptions/:id`
- `PUT    /api/achats/receptions/:id/valider`
- `POST   /api/achats/factures-fournisseurs`
- `GET    /api/achats/factures-fournisseurs`
- `GET    /api/achats/factures-fournisseurs/:id`
- `POST   /api/achats/factures-fournisseurs/:id/valider`
- `POST   /api/achats/factures-fournisseurs/:id/payer`

**Règles métier clés :**
- Paiement fournisseur = facture validée + réception confirmée (règle absolue)
- Réception validée → mise à jour stock_mouvements (entree)
- Détection doublon facture fournisseur (même numéro + même fournisseur → 409)
- Numérotation auto BC-YYYY-XXXX, REC-YYYY-XXXX
- Audit log sur chaque transition de statut

**Dépendances :** PROMPT 4 (stock / produits)

---

### [ ] PROMPT 6 — Module Contrats & Paiements récurrents

**Objectif :** Gestion des contrats avec échéanciers, génération automatique de factures et alertes expiration.

**Fichiers à créer / modifier :**
- `backend/database.js` — ajouter tables `contrats`, `contrats_echeances`
- `backend/routes/contrats.js` — créer (nouveau fichier)
- `backend/server.js` — monter `/api/contrats` + compléter cron 24h

**Tables créées :**
- `contrats`
- `contrats_echeances`

**Endpoints créés :**
- `GET    /api/contrats`
- `POST   /api/contrats`
- `GET    /api/contrats/:id`
- `PUT    /api/contrats/:id`
- `POST   /api/contrats/:id/activer`
- `POST   /api/contrats/:id/suspendre`
- `POST   /api/contrats/:id/resilier`
- `POST   /api/contrats/:id/renouveler`
- `GET    /api/contrats/alertes/echeances`

**Cron 24h (à ajouter) :**
- Passer contrats expirés → statut=expire
- Générer facture client pour échéances du jour (contrats clients)
- Créer décaissement prévu pour charges récurrentes
- Alerte 30j avant expiration contrat

**Règles métier clés :**
- Numérotation auto CTR-YYYY-XXXX
- Génération automatique des échéances à la création du contrat
- Facturation automatique pour contrats clients actifs
- Suspension automatique si impayé > seuil

**Dépendances :** PROMPT 1 (clients), PROMPT 3 (factures clients)

---

### [ ] PROMPT 7 — Rapprochement bancaire & Clôture de caisse

**Objectif :** Module de rapprochement bancaire ligne à ligne et clôture journalière de caisse avec écart.

**Fichiers à créer / modifier :**
- `backend/database.js` — ajouter tables `rapprochements_bancaires`, `rapprochements_lignes`, `caisses_clotures`
- `backend/routes/rapprochements.js` — créer (nouveau fichier)
- `backend/server.js` — monter `/api/rapprochements`

**Tables créées :**
- `rapprochements_bancaires`
- `rapprochements_lignes`
- `caisses_clotures`

**Endpoints créés :**
- `POST   /api/rapprochements/bancaire`
- `GET    /api/rapprochements/bancaire`
- `GET    /api/rapprochements/bancaire/:id`
- `POST   /api/rapprochements/bancaire/:id/ligne`
- `PUT    /api/rapprochements/bancaire/:id/ligne/:ligneId/rapprocher`
- `POST   /api/rapprochements/bancaire/:id/valider`
- `POST   /api/rapprochements/caisse/cloture`
- `GET    /api/rapprochements/caisse/historique`
- `GET    /api/rapprochements/caisse/:id`

**Règles métier clés :**
- Calcul automatique de l'écart (solde physique - solde logiciel)
- Interdiction de créer des opérations sur une période rapprochée et validée
- Audit log sur chaque validation

**Dépendances :** aucune (indépendant)

---

### [ ] PROMPT 8 — Frontend : Clients + Devis + Factures clients

**Objectif :** Ajouter les 3 modules UI dans dashboard.html avec formulaires, tableaux, actions et calculs auto.

**Fichiers à modifier :**
- `frontend/dashboard.html` — ajouter sections + navigation sidebar

**Sections ajoutées :**
- `section-clients` — tableau, fiche client, modal formulaire, badges statuts
- `section-devis` — tableau, modal avec lignes dynamiques, calcul HT/TTC temps réel, actions statuts
- `section-factures-clients` — tableau, modal paiement, onglet impayés, indicateurs retard

**Navigation sidebar :**
- Groupe "Ventes" avec liens : Clients / Devis / Factures clients

**Points clés UI :**
- Autocomplete client sur devis et factures
- Tableau de lignes dynamique (ajouter/supprimer) avec calcul automatique
- Badges couleur sur tous les statuts
- Actions contextuelles par ligne (Envoyer, Accepter, Refuser, Convertir, Annuler)
- Confirmation avec motif obligatoire pour actions irréversibles

**Dépendances :** PROMPT 1 + PROMPT 2 + PROMPT 3 (backend en place)

---

### [ ] PROMPT 9 — Frontend : Stock + Achats complets + Contrats

**Objectif :** Ajouter les modules Stock, workflow achat complet (BC/Réception/FF) et Contrats dans dashboard.html.

**Fichiers à modifier :**
- `frontend/dashboard.html` — ajouter sections + sous-onglets achats

**Sections ajoutées / modifiées :**
- `section-produits` — tableau stock avec alertes visuelles, entrée/sortie, historique mouvements
- `section-achats` (existante) — ajouter sous-onglets : Bons de commande / Réceptions / Factures fournisseurs
- `section-contrats` — tableau, échéancier, actions statuts

**Navigation sidebar :**
- "Stock" (nouveau)
- "Contrats" (nouveau groupe)

**Points clés UI :**
- Badge rouge sur produits sous stock minimum
- Formulaire réception avec saisie quantité par ligne de BC
- Tableau échéancier contrat avec statut facturé/payé par échéance
- Visualisation progression livraison sur BC (barres)

**Dépendances :** PROMPT 4 + PROMPT 5 + PROMPT 6 (backend en place)

---

### [ ] PROMPT 10 — Frontend : Tableaux de bord DG + Rapports + Rapprochement

**Objectif :** Enrichir le dashboard direction, ajouter rapports manquants et UI rapprochement bancaire/caisse.

**Fichiers à modifier :**
- `frontend/dashboard.html` — améliorer section dashboard + section rapports + ajouter section rapprochement

**Améliorations dashboard :**
- KPIs complets : CA, encaissements, décaissements, bénéfice brut, trésorerie totale
- KPIs créances/dettes : créances clients, dettes fournisseurs, contrats actifs, impayés
- Graphiques Chart.js : courbe CA 6 mois, barres enc/déc par semaine, camembert dépenses

**Rapports ajoutés :**
- Onglet "Impayés clients" → export CSV
- Onglet "Dettes fournisseurs" → export CSV
- Onglet "Journal comptable" → filtres + export CSV
- Onglet "Rapport mensuel" → résumé consolidé

**Section rapprochement ajoutée :**
- Sous-onglet "Clôture caisse" — formulaire avec écart temps réel
- Sous-onglet "Rapprochement bancaire" — session, cochage lignes, calcul écart, validation

**Navigation sidebar :**
- "Rapprochement" dans groupe Finance

**Dépendances :** PROMPT 7 + PROMPT 8 + PROMPT 9 (tout le backend en place)

---

### [ ] PROMPT 11 — Alertes automatiques & Relances clients

**Objectif :** Compléter le moteur d'alertes avec tous les nouveaux modules et activer les relances email clients.

**Fichiers à modifier :**
- `backend/services/notif.js` — ajouter 5 nouvelles fonctions de vérification
- `backend/server.js` — brancher les nouvelles fonctions dans les crons existants
- `backend/routes/factures_clients.js` — ajouter endpoints relances
- `backend/database.js` — ajouter table `relances`

**Table créée :**
- `relances`

**Fonctions ajoutées dans notif.js :**
- `checkFacturesClientEnRetard()` — alerte critique + rappel relance J+7
- `checkContratsExpirants()` — avertissement 30j, critique 7j
- `checkStockBas()` — avertissement stock bas, critique stock nul
- `checkEncoursCreditClient()` — bloquant si encours > plafond
- `checkFacturesFournisseursEchues()` — critique par facture fournisseur échue

**Endpoints ajoutés :**
- `GET    /api/factures-clients/relances/dues`
- `POST   /api/factures-clients/:id/relancer`

**Crons mis à jour :**
- Cron 24h → + checkFacturesClientEnRetard, checkContratsExpirants, checkStockBas, checkFacturesFournisseursEchues
- Cron 5min → + checkEncoursCreditClient

**Dépendances :** PROMPT 1 à PROMPT 7 (tous les modules backend en place)

---

### [ ] PROMPT 12 — Tests, sécurité RBAC & finalisation

**Objectif :** Vérifier toutes les règles anti-fraude, les permissions par rôle, écrire les tests Playwright et mettre à jour la documentation.

**Fichiers à créer / modifier :**
- Tous les fichiers routes créés aux prompts 1-7 — vérification règles métier
- `tests/modules_ventes_test.js` — créer (nouveau fichier)
- `WORKFLOW_CONTROL_BOARD.md` — mettre à jour avec tableau d'avancement complet

**Vérifications règles anti-fraude (dans chaque route) :**
- [ ] Aucun DELETE physique sur enregistrements validés
- [ ] Motif obligatoire sur toute annulation
- [ ] Blocage modification après statuts verrouillés (emise, payee, validee)
- [ ] Numérotation auto sans doublon imposable
- [ ] Détection doublon facture fournisseur (409)
- [ ] Audit log présent sur chaque changement de statut

**Vérifications RBAC par rôle :**
- [ ] Commercial → clients, devis, lecture factures (pas validation paiements)
- [ ] Finance → validation encaissements, rapprochements, factures
- [ ] DG → tout en lecture + validation grosses dépenses
- [ ] Caissier → encaissements/décaissements uniquement
- [ ] Admin → utilisateurs + paramètres
- [ ] RH → agents + salaires uniquement

**Tests Playwright (tests/modules_ventes_test.js) :**
- [ ] Créer un client → vérifier dans la liste
- [ ] Créer un devis → l'accepter → le convertir en facture
- [ ] Enregistrer un paiement partiel → vérifier statut partiellement_payee
- [ ] Tenter de modifier une facture émise → vérifier rejet 403
- [ ] Vérifier qu'un client mauvais_payeur bloque la création facture

**Dépendances :** tous les prompts précédents (dernier à exécuter)

---

## Suivi global

| # | Prompt | Statut | Date exécution |
|---|---|---|---|
| 1 | Module Clients — backend | ✅ Fait | 2026-05-09 |
| 2 | Module Devis — backend | ✅ Fait | 2026-05-09 |
| 3 | Module Factures Client — backend | ✅ Fait | 2026-05-09 |
| 4 | Module Stock / Produits — backend | ✅ Fait | 2026-05-09 |
| 5 | Achat complet BC→Réception→FF — backend | ✅ Fait | 2026-05-10 |
| 6 | Contrats & Récurrences — backend | ⏳ À faire | — |
| 7 | Rapprochement bancaire & Clôture caisse — backend | ⏳ À faire | — |
| 8 | Frontend Clients + Devis + Factures clients | ⏳ À faire | — |
| 9 | Frontend Stock + Achats + Contrats | ⏳ À faire | — |
| 10 | Frontend Dashboard DG + Rapports + Rapprochement | ⏳ À faire | — |
| 11 | Alertes automatiques & Relances | ⏳ À faire | — |
| 12 | Tests + Sécurité RBAC + Finalisation | ⏳ À faire | — |

---

## Règles de travail

1. **Exécuter un seul prompt à la fois** — ne jamais mélanger deux prompts dans la même session.
2. **Cocher la case `[ ]` → `[x]`** et mettre la date dans le tableau de suivi dès qu'un prompt est terminé et validé.
3. **Ne pas passer au prompt suivant** tant que le précédent n'est pas coché.
4. **Les prompts 8, 9, 10 nécessitent** que leurs dépendances backend soient validées (prompts 1-7).
5. **Le prompt 12 est toujours le dernier** — il vérifie et consolide tout le reste.
