# TODOLIST — Implémentation Workflow GRH / Salaires
# Caisse Top Center (Tala SMI) — 2026-05-10
# Source : processus_worklow_salaires (workflow complet) + audit code (12 prompts existants)
#
# RÈGLE : chaque prompt = 1 commit, 1 sauvegarde .bak, 1 node --check final.
# ORDRE : respecter les phases (DB → routes → frontend).
# ──────────────────────────────────────────────────────────────────────────────

## RAPPEL — 21 RÈGLES MÉTIER NON NÉGOCIABLES (du workflow)

1. Aucun salaire validé ne se modifie directement → passer par une révision
2. Toute modification salariale requiert motif + date effet + validateur
3. Un bulletin payé est verrouillé — correction = document de rectification
4. Le créateur d'un bulletin ne peut pas être son seul validateur
5. Le payeur ne peut pas être celui qui a validé le bulletin
6. Un bulletin sans validation DG ne peut pas être payé
7. Une période clôturée ne se réouvre qu'en exception tracée
8. Un agent sorti ne génère plus de paie normale
9. Un agent suspendu ne peut pas être payé sans levée de suspension
10. Les avances ne diminuent leur solde qu'après paiement effectif
11. Les grilles validées ne sont pas modifiables : on archive et remplace
12. Toute exception doit avoir motif + pièce + validation
13. delegue et assistante_direction ne peuvent pas modifier un salaire
14. Le caissier exécute le paiement — il ne génère pas, ne valide pas
15. DG approuve la masse salariale globale, pas bulletin par bulletin
16. Un salaire hors borne de grille déclenche une alerte bloquante
17. Le doublon bulletin même agent/même période est interdit
18. Toute action sensible est auditée (old_value + new_value + motif + ip)
19. Avance > seuil paramétrable → validation DG obligatoire
20. Période précédente non clôturée → alerte avant ouverture mois suivant
21. La CNSS, DGI et avances génèrent automatiquement des décaissements caisse

---

## PHASE 1 — FONDATIONS BASE DE DONNÉES
*(Tables à créer dans database.js — aucune dépendance entre elles)*

---

### PROMPT 13 — Grilles salariales (tables DB)

> But : Référentiel rémunération 3 niveaux : grille → catégorie → échelon.

- [ ] **13-A** `grilles_salariales` — id, code (ex: GRILLE-2026-A), libelle,
  date_debut, date_fin, statut `[brouillon|soumis|valide|archive]`,
  created_by FK users, approved_by FK users, approved_at, created_at, updated_at

- [ ] **13-B** `grille_categories` — id, grille_id FK, code (A/B/C/D),
  libelle (cadre/maîtrise/exécution), salaire_min, salaire_max,
  coefficient_min, coefficient_max, actif INT DEFAULT 1

- [ ] **13-C** `grille_echelons` — id, categorie_id FK, echelon INT,
  salaire_reference, salaire_min, salaire_max,
  prime_transport DEFAULT 0, prime_logement DEFAULT 0,
  anciennete_min_ans INT DEFAULT 0, actif INT DEFAULT 1

- [ ] **13-D** `employes` — addColumnIfMissing :
  `grille_categorie_id INTEGER` (FK nullable),
  `grille_echelon_id INTEGER` (FK nullable)

- [ ] **13-E** `node --check backend/database.js`

**Fichiers :** `backend/database.js`

---

### PROMPT 14 — Historique salaires + verrou salaire_base (DB + agents.js)

> But : Tracer chaque changement salarial. Bloquer la modification directe.
> Règle métier n°1 : "Aucun salaire validé ne se modifie directement."

- [ ] **14-A** `historique_salaires` — id, employe_id FK, date_effet,
  ancien_salaire, nouveau_salaire, ancien_transport, nouveau_transport,
  ancien_logement, nouveau_logement,
  ancienne_categorie_id (nullable), nouvelle_categorie_id (nullable),
  ancien_echelon_id (nullable), nouvel_echelon_id (nullable),
  motif TEXT NOT NULL,
  type_revision `[embauche|augmentation|correction|promotion|indexation|regularisation]`,
  demande_revision_id (nullable FK),
  approved_by FK users, approved_at,
  created_by FK users, created_at

- [ ] **14-B** `demandes_revision_salaire` — id, employe_id FK,
  type_revision `[augmentation|promotion|correction|indexation]`,
  date_effet TEXT NOT NULL, salaire_actuel, salaire_propose,
  transport_actuel, transport_propose, logement_actuel, logement_propose,
  nouvelle_categorie_id (nullable FK), nouvel_echelon_id (nullable FK),
  motif TEXT NOT NULL, document_url TEXT,
  statut `[brouillon|soumis_rh|soumis_dg|approuve|rejete|ajourne|annule|applique]`,
  avis_rh TEXT, valide_rh_by FK, valide_rh_at,
  avis_dg TEXT, valide_dg_by FK, valide_dg_at,
  motif_rejet TEXT, created_by FK, created_at, updated_at

- [ ] **14-C** `bulletins_salaire` — addColumnIfMissing :
  `generated_by INTEGER` (FK users),
  `validated_by INTEGER` (FK users),
  `periode_id INTEGER` (FK periodes_paie — sera créée prompt 15),
  `type TEXT DEFAULT 'normal'` `[normal|regularisation|treizieme]`,
  `reference_bulletin_id INTEGER` (pour régularisations)

- [ ] **14-D** `employes_avances` — addColumnIfMissing :
  `statut_workflow TEXT DEFAULT 'approuve'`
  `[brouillon|soumis|approuve_rh|approuve_daf|approuve_dg|rejete|decaisse|annule|solde]`,
  `operation_id INTEGER` (FK operations),
  `approuve_par FK users`, `approuve_at`,
  `rejete_par FK users`, `rejete_at`, `motif_rejet TEXT`

- [ ] **14-E** `cnss_paiements` — addColumnIfMissing : `operation_id INTEGER`
- [ ] **14-F** `dgi_paiements` — addColumnIfMissing : `operation_id INTEGER`
- [ ] **14-G** `employes` — addColumnIfMissing : `contrat_id INTEGER`

- [ ] **14-H** `node --check backend/database.js`

**Fichiers :** `backend/database.js`

---

### PROMPT 15 — Période de paie + rectifications (DB)

> But : Cycle mensuel avec ses propres statuts + table rectifications bulletins.

- [ ] **15-A** `periodes_paie` — id, mois INT, annee INT, UNIQUE(mois,annee),
  statut `[ouverte|preparation|controle_rh|controle_finance|soumis_dg|validee_dg|
  paiement_en_cours|payee_partielle|payee|cloturee|rouverte_exception]`,
  nb_bulletins_generes, nb_bulletins_valides, nb_bulletins_payes INT DEFAULT 0,
  total_brut, total_net, total_charges REAL DEFAULT 0,
  soumis_dg_by FK, soumis_dg_at,
  valide_dg_by FK, valide_dg_at,
  cloture_by FK, cloture_at,
  notes TEXT, created_at, updated_at

- [ ] **15-B** `rectifications_bulletins` — id, bulletin_id FK, employe_id FK,
  periode_id FK,
  type `[trop_percu|moins_percu|erreur_prime|erreur_retenue|autre]`,
  sens `[debit_agent|credit_agent]`,
  montant REAL NOT NULL CHECK(montant > 0),
  motif TEXT NOT NULL,
  statut `[brouillon|soumis|approuve|rejete|applique]`,
  approuve_par FK, approuve_at,
  applied_bulletin_id FK nullable,
  created_by FK, created_at, updated_at

- [ ] **15-C** `employes_sanctions` — id, employe_id FK,
  type `[avertissement_verbal|avertissement_ecrit|mise_a_pied|licenciement_cause_reelle|autre]`,
  date_sanction, motif_detaille TEXT NOT NULL,
  nb_jours_mise_a_pied INT DEFAULT 0, retenue_calculee REAL DEFAULT 0,
  document_url TEXT,
  statut `[projet|notifie|conteste|clos]`,
  conteste_motif TEXT,
  created_by FK, updated_at, annule_at, annule_by, annule_motif

- [ ] **15-D** `employes_sortie` — id, employe_id FK UNIQUE,
  type_sortie `[demission|licenciement|retraite|fin_contrat|deces|rupture_conventionnelle]`,
  date_annonce, date_fin_preavis, date_depart_effectif,
  anciennete_annees REAL, indemnite_licenciement REAL DEFAULT 0,
  indemnite_preavis REAL DEFAULT 0, conges_payes_restants REAL DEFAULT 0,
  conges_payes_montant REAL DEFAULT 0, autres_indemnites REAL DEFAULT 0,
  solde_tout_compte_total REAL,
  statut `[initie|calcule|valide|solde]`,
  checklist_materiel TEXT, checklist_acces TEXT,
  notes TEXT, created_by FK, validated_by FK, validated_at, created_at, updated_at

- [ ] **15-E** `employes_heures_sup` — id, employe_id FK, mois INT, annee INT,
  date_heures, nb_heures REAL,
  type `[normal|dimanche|ferie]`,
  taux_majoration REAL, montant_brut REAL,
  statut `[saisi|valide|integre_bulletin]`,
  valide_par FK, bulletin_id FK nullable,
  motif TEXT, created_by FK, created_at

- [ ] **15-F** Paramètres dans `parametres` (si absents) :
  `anciennete_actif=0`, `anciennete_taux_pct=2`, `anciennete_plafond_pct=20`,
  `treizieme_actif=0`, `treizieme_mois=12`, `treizieme_mode=annuel_divise_12`,
  `heures_sup_taux_normal=1.25`, `heures_sup_taux_dimanche=1.50`,
  `heures_sup_taux_ferie=2.00`, `heures_sup_plafond_mois=40`,
  `avance_plafond_mois=1`

- [ ] **15-G** `employes` — addColumnIfMissing :
  `conges_maladie_droit REAL DEFAULT 15`,
  `conges_maladie_pris REAL DEFAULT 0`,
  `conges_maladie_solde REAL DEFAULT 15`

- [ ] **15-H** `employes_mutations` — addColumnIfMissing :
  `statut TEXT DEFAULT 'propose'`,
  `approuve_par FK`, `approuve_at`,
  `date_effective TEXT`, `avenant_pdf TEXT`, `motif_refus TEXT`

- [ ] **15-I** `node --check backend/database.js`

**Fichiers :** `backend/database.js`

---

## PHASE 2 — ROUTES BACKEND
*(Dépendent des tables Phase 1)*

---

### PROMPT 16 — Routes API grilles salariales

> RBAC : lecture = tous rôles ; écriture = admin/rh/finance/dg

- [ ] **16-A** Créer `backend/routes/grilles.js`
- [ ] **16-B** `GET /api/grilles/` — liste + filtres statut
- [ ] **16-C** `POST /api/grilles/` — créer (admin/rh/finance)
- [ ] **16-D** `PUT /api/grilles/:id` — modifier si brouillon
- [ ] **16-E** `POST /api/grilles/:id/soumettre` — brouillon → soumis
- [ ] **16-F** `POST /api/grilles/:id/valider-dg` — soumis → valide (dg/admin) + audit
- [ ] **16-G** `POST /api/grilles/:id/archiver` — valide → archive (admin/dg)
- [ ] **16-H** `GET/POST /api/grilles/:id/categories` — CRUD catégories
- [ ] **16-I** `PUT /api/grilles/:id/categories/:cid` — modifier catégorie
- [ ] **16-J** `GET/POST /api/grilles/categories/:cid/echelons` — CRUD échelons
- [ ] **16-K** `PUT /api/grilles/echelons/:eid` — modifier échelon
- [ ] **16-L** `GET /api/grilles/agent/:id` — catégorie+échelon d'un agent
- [ ] **16-M** `PUT /api/grilles/agent/:id/affecter` — affecter catégorie+échelon
  (admin/rh/finance — pas delegue ni assistante)
- [ ] **16-N** Monter dans `server.js`
- [ ] **16-O** `node --check backend/routes/grilles.js backend/server.js`

**Fichiers :** `backend/routes/grilles.js` (nouveau), `backend/server.js`
**Dépendance :** Prompt 13

---

### PROMPT 17 — Verrou salaire_base + historique (agents.js)

> Règle métier n°1 appliquée dans le code.

- [ ] **17-A** `agents.js` — Créer route `PUT /api/agents/:id/salaire`
  Rôles : admin/rh/finance/dg UNIQUEMENT
  → lire anciens montants → UPDATE → INSERT historique_salaires (type=correction)
  → audit_log renforcé avec old_value/new_value
  → bloquer si révision en cours (statut ≠ rejete|applique|annule)

- [ ] **17-B** `agents.js` — Dans `PUT /api/agents/:id` générique
  → si body contient salaire_base/prime_transport/prime_logement
  → si rôle insuffisant : 403 "Utilisez /api/agents/:id/salaire"
  → si rôle suffisant : rediriger vers logique 17-A

- [ ] **17-C** `agents.js` — `GET /api/agents/:id/historique-salaires`
  → historique_salaires trié DESC

- [ ] **17-D** `node --check backend/routes/agents.js`

**Fichiers :** `backend/routes/agents.js`
**Dépendance :** Prompt 14

---

### PROMPT 18 — Workflow révision salariale (revisions_salaire.js)

> Circuit : brouillon → soumis_rh → soumis_dg → approuve|rejete|ajourne → applique

- [ ] **18-A** Créer `backend/routes/revisions_salaire.js`

- [ ] **18-B** `POST /api/revisions-salaire/` — créer demande (admin/rh/finance)
  Contrôle : si grille affectée, salaire_propose dans bornes échelon

- [ ] **18-C** `PUT /api/revisions-salaire/:id` — modifier si brouillon

- [ ] **18-D** `POST /api/revisions-salaire/:id/soumettre-rh`
  → brouillon → soumis_rh ; notifier rh/admin

- [ ] **18-E** `POST /api/revisions-salaire/:id/valider-rh`
  → soumis_rh → soumis_dg (admin/rh) ; avis_rh obligatoire ; notifier dg

- [ ] **18-F** `POST /api/revisions-salaire/:id/valider-dg`
  → soumis_dg → approuve (dg/admin) ; avis_dg obligatoire
  → si date_effet ≤ aujourd'hui : appliquer immédiatement
    (UPDATE employes salaire + INSERT historique_salaires statut=applique)
  → sinon : statut=approuve (cron/job applique à date_effet)

- [ ] **18-G** `POST /api/revisions-salaire/:id/rejeter`
  → rejete (rh ou dg selon étape) ; motif_rejet obligatoire ; notif créateur

- [ ] **18-H** `POST /api/revisions-salaire/:id/ajourner` (dg/admin)

- [ ] **18-I** `POST /api/revisions-salaire/:id/annuler`

- [ ] **18-J** `GET /api/revisions-salaire/` — liste globale filtrable
- [ ] **18-K** `GET /api/revisions-salaire/en-attente` — soumis_dg (dashboard DG)
- [ ] **18-L** `GET /api/revisions-salaire/:id` — détail

- [ ] **18-M** Monter dans `server.js`
- [ ] **18-N** `node --check backend/routes/revisions_salaire.js backend/server.js`

**Fichiers :** `backend/routes/revisions_salaire.js` (nouveau), `backend/server.js`
**Dépendance :** Prompt 14

---

### PROMPT 19 — Période de paie + validation masse salariale (periodes_paie.js)

> "La validation DG porte sur la masse entière, pas bulletin par bulletin."

- [ ] **19-A** Créer `backend/routes/periodes_paie.js`

- [ ] **19-B** `POST /api/paie/periodes` — créer/récupérer période du mois (admin/rh/finance)

- [ ] **19-C** `GET /api/paie/periodes` — liste périodes avec statuts

- [ ] **19-D** `GET /api/paie/periodes/:id` — détail + synthèse + **anomalies auto** :
  - bulletins hors grille (salaire_base > max échelon)
  - agent avec salaire modifié ce mois (vs historique)
  - doublon bulletin même agent/période
  - agent sorti avec bulletin actif
  - même user créateur = validateur (ségrégation, règle n°4)
  - bulletin net négatif

- [ ] **19-E** `POST /api/paie/periodes/:id/soumettre-dg`
  → controle_finance → soumis_dg (finance/admin)
  → vérifie 0 anomalie bloquante

- [ ] **19-F** `POST /api/paie/periodes/:id/valider-dg`
  → soumis_dg → validee_dg (dg/admin) ; motif si anomalies présentes
  → déverrouille paiement groupé

- [ ] **19-G** `POST /api/paie/periodes/:id/cloturer`
  → payee → cloturee (admin) ; vérifie tous bulletins payés

- [ ] **19-H** `POST /api/paie/periodes/:id/rouvrir-exception`
  → cloturee → rouverte_exception (admin) ; motif + pièce + audit renforcé

- [ ] **19-I** `salaires.js` — Dans `POST /generer` :
  créer/récupérer periode_paie du mois ; stocker `generated_by` dans bulletins_salaire

- [ ] **19-J** `salaires.js` — Dans `POST /bulletin/:id/payer` :
  vérifier `periode.statut IN ('validee_dg','paiement_en_cours','payee_partielle')`
  sinon → 403 "Masse salariale non validée par le DG"

- [ ] **19-K** Monter `/api/paie` dans `server.js`
- [ ] **19-L** `node --check` tous les fichiers modifiés

**Fichiers :** `backend/routes/periodes_paie.js` (nouveau),
`backend/routes/salaires.js`, `backend/server.js`
**Dépendance :** Prompt 15

---

### PROMPT 20 — Corrections RBAC bulletins (4 lacunes)

> L1 = salaire libre → résolu prompt 17 | L2 = rectification ci-dessous
> L3 = ségrégation | L4 = DG exclu

- [ ] **20-A** `salaires.js` — Ajouter `dg` dans `FINANCE_ROLES`
  `['admin','caissier','finance','dg']`

- [ ] **20-B** `salaires.js` — `PUT /bulletin/:id/valider` :
  `if (bul.generated_by === req.user.id && !isAdmin && !isDG) → 403`
  Stocker `validated_by = req.user.id`

- [ ] **20-C** `salaires.js` — `POST /bulletin/:id/payer` :
  `if (bul.validated_by === req.user.id && !isAdmin && !isDG) → 403`

- [ ] **20-D** `salaires.js` — Retirer `caissier` de `WRITE_ROLES`
  Le caissier ne génère pas, ne modifie pas — il paie seulement

- [ ] **20-E** `node --check backend/routes/salaires.js backend/database.js`

**Fichiers :** `backend/routes/salaires.js`, `backend/database.js`
**Dépendance :** Prompt 14

---

### PROMPT 21 — Rectification bulletin payé

- [ ] **21-A** `salaires.js` — `POST /api/salaires/bulletin/:id/rectification`
  (admin/finance/dg) — vérifie bulletin payé — crée rectification statut=brouillon — motif obligatoire

- [ ] **21-B** `salaires.js` — `POST /api/salaires/rectification/:rid/approuver`
  (dg/admin) → statut=approuve

- [ ] **21-C** `salaires.js` — Dans `POST /generer` :
  chercher rectifications approuvées non appliquées pour l'agent
  → injecter lignes_custom "Régularisation MM/AAAA : motif"
  → marquer statut=applique + applied_bulletin_id

- [ ] **21-D** `salaires.js` — `GET /api/salaires/rectifications` (admin/finance/dg)

- [ ] **21-E** `node --check backend/routes/salaires.js`

**Fichiers :** `backend/routes/salaires.js`
**Dépendance :** Prompts 14, 19

---

### PROMPT 22 — Workflow avances sécurisé (agents.js)

> Ajouter circuit approbation manquant avant décaissement.

- [ ] **22-A** `agents.js` — `POST /api/agents/:id/avances` :
  statut_workflow initial = `brouillon` (plus de décaissement immédiat)
  Plafond = paramètre `avance_plafond_mois` (défaut : 1 × salaire_base)

- [ ] **22-B** `agents.js` — `POST /api/agents/:id/avances/:aid/soumettre`
  → brouillon → soumis ; notifier rh/finance

- [ ] **22-C** `agents.js` — `POST /api/agents/:id/avances/:aid/approuver`
  (finance/dg/admin) → approuve_dg ; motif si > seuil

- [ ] **22-D** `agents.js` — `POST /api/agents/:id/avances/:aid/decaisser`
  (finance/caissier/admin) → decaisse
  → créer opération caisse : type=decaissement,
    libelle="Avance salaire [Nom Prénom]", montant=avance.montant
  → stocker operation_id dans l'avance

- [ ] **22-E** `agents.js` — `POST /api/agents/:id/avances/:aid/rejeter`
  (finance/dg/admin) + motif obligatoire + notif

- [ ] **22-F** `node --check backend/routes/agents.js`

**Fichiers :** `backend/routes/agents.js`
**Dépendance :** Prompt 14

---

### PROMPT 23 — Synchronisation CNSS/DGI → opérations caisse

- [ ] **23-A** `salaires.js` — `POST /cnss/paiement` :
  après INSERT cnss_paiements → créer opération caisse
  libelle="CNSS MM/AAAA — décl.#id", catégorie=charges_sociales
  → stocker operation_id (try/catch : log si échec, ne bloque pas le paiement)

- [ ] **23-B** `salaires.js` — `POST /dgi/paiement` : idem
  libelle="IRPP/DGI MM/AAAA — décl.#id"

- [ ] **23-C** `node --check backend/routes/salaires.js backend/database.js`

**Fichiers :** `backend/routes/salaires.js`, `backend/database.js`
**Dépendance :** Prompt 14

---

### PROMPT 24 — Lien FK agents ↔ contrats de travail

- [ ] **24-A** `agents.js` — `GET /api/agents/:id` : JOIN contrats si contrat_id
- [ ] **24-B** `agents.js` — `PUT /api/agents/:id/lier-contrat` (admin/rh/finance)
- [ ] **24-C** `contrats.js` — si contrat résilié et employe.contrat_id pointe dessus
  → notifier RH "agent sans contrat actif"
- [ ] **24-D** `node --check agents.js contrats.js`

**Fichiers :** `backend/routes/agents.js`, `backend/routes/contrats.js`
**Dépendance :** Prompt 14

---

### PROMPT 25 — Sanctions disciplinaires (sanctions.js)

- [ ] **25-A** Créer `backend/routes/sanctions.js`
- [ ] **25-B** `GET /api/agents/:id/sanctions` (rh/admin/dg)
- [ ] **25-C** `POST /api/agents/:id/sanctions` (rh/admin)
- [ ] **25-D** `PUT /api/agents/:id/sanctions/:sid` (si statut=projet)
- [ ] **25-E** `PUT /api/agents/:id/sanctions/:sid/notifier` (rh/dg)
- [ ] **25-F** `PUT /api/agents/:id/sanctions/:sid/contester`
- [ ] **25-G** `PUT /api/agents/:id/sanctions/:sid/clore` (dg/admin)
- [ ] **25-H** `GET /api/sanctions/registre` (admin/dg — vue globale + export CSV)
- [ ] **25-I** `salaires.js` — Dans `POST /generer` :
  si mise_a_pied avec nb_jours et dates chevauchant la période :
  retenue = (nb_jours / 26) × salaire_base
  → injecter lignes_custom "Retenue mise à pied (N jours)"
- [ ] **25-J** Monter dans `server.js`
- [ ] **25-K** `node --check backend/routes/sanctions.js backend/routes/salaires.js backend/server.js`

**Fichiers :** `backend/routes/sanctions.js` (nouveau), `backend/routes/salaires.js`, `backend/server.js`
**Dépendance :** Prompt 15

---

### PROMPT 26 — Offboarding : sortie + indemnités + PDFs (agents.js)

- [ ] **26-A** `agents.js` — `POST /api/agents/:id/sortie/initier` (rh/admin/dg)
  Calculs auto : ancienneté, indemnite_licenciement (1 mois/tranche 5 ans Congo),
  indemnite_preavis (1/2/3 mois selon ancienneté), congés payés restants

- [ ] **26-B** `agents.js` — `GET /api/agents/:id/sortie`
- [ ] **26-C** `agents.js` — `PUT /api/agents/:id/sortie/valider` (dg/admin)
  → statut=valide, employe statut_dossier=sorti

- [ ] **26-D** `agents.js` — `GET /api/agents/:id/sortie/solde-tout-compte-pdf`
  PDF : identification, calculs détaillés, total, lignes signatures

- [ ] **26-E** `agents.js` — `GET /api/agents/:id/sortie/certificat-travail-pdf`
  PDF : dates, postes occupés, mentions légales Congo-Brazzaville

- [ ] **26-F** `node --check backend/routes/agents.js`

**Fichiers :** `backend/routes/agents.js`
**Dépendance :** Prompt 15

---

### PROMPT 27 — Heures supplémentaires (heures_sup.js + salaires.js)

- [ ] **27-A** Créer `backend/routes/heures_sup.js`
- [ ] **27-B** `GET /api/agents/:id/heures-sup` (rh/finance/admin)
- [ ] **27-C** `POST /api/agents/:id/heures-sup` (rh/finance/admin)
- [ ] **27-D** `PUT /api/agents/:id/heures-sup/:hid/valider` (finance/dg/admin)
- [ ] **27-E** `DELETE /api/agents/:id/heures-sup/:hid` (si non intégré)
- [ ] **27-F** `GET /api/heures-sup/periode/:mois/:annee` (vue consolidée)
- [ ] **27-G** `salaires.js` — `POST /generer` :
  chercher heures_sup statut=valide ; salaire_horaire = salaire_base/(26×8)
  montant = nb_heures × salaire_horaire × taux_majoration
  → lignes_custom "Heures sup Nh (type)" ; marquer integre_bulletin
- [ ] **27-H** Monter dans `server.js`
- [ ] **27-I** `node --check` tous les fichiers modifiés

**Fichiers :** `backend/routes/heures_sup.js` (nouveau), `backend/routes/salaires.js`, `backend/server.js`
**Dépendance :** Prompt 15

---

### PROMPT 28 — Prime ancienneté + 13ème mois (salaires.js)

- [ ] **28-A** `salaires.js` — `getTaux()` : inclure params ancienneté et 13ème mois

- [ ] **28-B** `salaires.js` — `calculer()` :
  Si anciennete_actif=1 ET date_embauche fourni :
  années = floor(diff jours / 365)
  taux_effectif = MIN(années × taux_pct/100, plafond_pct/100)
  prime = taux_effectif × salaire_base → lignes_custom "Prime ancienneté (N ans)"

- [ ] **28-C** `salaires.js` — `POST /generer` : passer date_embauche à calculer()

- [ ] **28-D** `salaires.js` — `POST /api/salaires/generer-treizieme`
  (admin/finance/dg) ; bloque si déjà généré pour l'année
  Calcul selon mode=annuel_divise_12 ; bulletins type='treizieme'

- [ ] **28-E** `salaires.js` — Inclure type=treizieme dans CNSS/DGI du mois

- [ ] **28-F** `node --check backend/routes/salaires.js`

**Fichiers :** `backend/routes/salaires.js`
**Dépendance :** Prompt 15

---

### PROMPT 29 — Congés maladie séparés + mutations workflow (agents.js + organigramme.js)

- [ ] **29-A** `agents.js` — Congé type=maladie : débiter conges_maladie_solde
  Si épuisé → bascule type=sans_solde + alerte RH

- [ ] **29-B** `agents.js` — `POST /api/agents/:id/conges` type=maladie :
  certificat médical obligatoire (document_url)

- [ ] **29-C** `agents.js` — `GET /api/agents/:id/conges/solde` :
  inclure solde_maladie dans la réponse

- [ ] **29-D** `organigramme.js` — `POST /api/organigramme/mutations` :
  statut initial = 'propose' (plus d'application immédiate) ; notif DG

- [ ] **29-E** `organigramme.js` — `PUT /api/organigramme/mutations/:id/approuver`
  (dg/admin) → appliquer si date_effective ≤ aujourd'hui
  → UPDATE employes (dept, poste, superieur, site)
  → générer avenant PDF via wkhtmltopdf

- [ ] **29-F** `organigramme.js` — `PUT /api/organigramme/mutations/:id/refuser`
  (dg/admin) + motif_refus

- [ ] **29-G** `node --check backend/routes/agents.js backend/routes/organigramme.js`

**Fichiers :** `backend/routes/agents.js`, `backend/routes/organigramme.js`
**Dépendance :** Prompt 15

---

### PROMPT 30 — Service PDF partagé + attestations automatiques

- [ ] **30-A** Extraire helper wkhtmltopdf de `salaires.js`
  → créer `backend/services/pdf.js` : `async function generatePdf(html) → Buffer`

- [ ] **30-B** Adapter `salaires.js` pour importer et utiliser `services/pdf.js`
  (refactor sans changement fonctionnel)

- [ ] **30-C** `agents.js` — `GET /api/agents/:id/attestation/travail-pdf`
  Contenu : logo entreprise, matricule, poste, date_embauche,
  type_contrat, mentions légales, cachet + signature DG

- [ ] **30-D** `agents.js` — `GET /api/agents/:id/attestation/salaire-pdf`
  + dernier net (dernier bulletin payé), mode_paiement, banque

- [ ] **30-E** `agents.js` — `GET /api/agents/:id/attestation/conges-pdf`
  + solde actuel : acquis, pris, disponible, solde maladie, date situation

- [ ] **30-F** `node --check backend/services/pdf.js backend/routes/salaires.js backend/routes/agents.js`

**Fichiers :** `backend/services/pdf.js` (nouveau), `backend/routes/salaires.js`, `backend/routes/agents.js`
**Dépendance :** Aucune (refactor)

---

### PROMPT 31 — KPIs RH avancés + rapport comparatif masse salariale

- [ ] **31-A** `agents.js` — `GET /api/agents/kpis` — enrichir :
  turnover_mois (sorties/effectif moyen×100), turnover_annee (12 mois glissants),
  anciennete_moyenne (AVG années), repartition_sexe {H, F},
  repartition_contrat {CDI, CDD, Stage}, taux_absenteisme,
  nb_sanctions_actives_30j

- [ ] **31-B** `salaires.js` — `GET /api/salaires/rapport-comparatif`
  Paramètres : mois, annee ; comparaison mois-1 et mois-12
  Réponse : masse courant/précédent/variation_pct/an_dernier,
  par_departement[], nb_bulletins {generes, valides, payes},
  cout_patronal_total, top5_salaires (anonymisé si rh, nominatif si admin/dg)

- [ ] **31-C** `node --check backend/routes/agents.js backend/routes/salaires.js`

**Fichiers :** `backend/routes/agents.js`, `backend/routes/salaires.js`
**Dépendance :** Prompts 15, 25

---

## PHASE 3 — FRONTEND
*(Dépend des routes Phase 2)*

---

### PROMPT 32 — UI Grilles salariales

- [ ] **32-A** Ajouter "Grilles salariales" dans menu RH/PAIE
- [ ] **32-B** Tableau CRUD grilles avec badges statut colorés
- [ ] **32-C** Modal créer/éditer grille
- [ ] **32-D** Vue détail : tableau catégories + tableau échelons inline
- [ ] **32-E** Boutons workflow : Soumettre / Valider DG / Archiver (masqués selon rôle)
- [ ] **32-F** Fiche agent — Onglet "Rémunération" :
  affichage catégorie+échelon, lien grille, badge si hors borne
- [ ] **32-G** Bouton "Modifier affectation" (admin/rh/finance uniquement)

**Fichiers :** `frontend/dashboard.html`
**Dépendance :** Prompts 16, 17

---

### PROMPT 33 — UI Révisions salariales + Dashboard DG

- [ ] **33-A** Fiche agent — Onglet "Rémunération" :
  Section "Révisions" : timeline historique + bouton "Proposer révision"
- [ ] **33-B** Modal "Proposer révision" :
  type, date_effet, salaire_propose (delta affiché), transport, logement,
  motif obligatoire, upload pièce ; comparateur coût employeur en temps réel
- [ ] **33-C** Section "Révisions salariales" dans menu RH/PAIE :
  liste globale filtrable, badges statut
- [ ] **33-D** Dashboard DG — Bandeau "En attente" :
  badge rouge si soumis_dg > 0 ; boutons Approuver / Ajourner / Rejeter + motif
- [ ] **33-E** Notification in-app au DG à chaque nouvelle demande soumis_dg

**Fichiers :** `frontend/dashboard.html`
**Dépendance :** Prompt 18

---

### PROMPT 34 — UI Période de paie + tableau validation masse DG

- [ ] **34-A** Section "Périodes de paie" dans menu RH/PAIE :
  timeline mensuelle avec badges statut colorés
- [ ] **34-B** Vue détail période (écran de contrôle) :
  nb agents actifs | bulletins générés/bloqués/validés/payés
  total brut | net | avances | primes | charges patronales
  variation vs mois précédent | anomalies (bloquantes en rouge)
  agents entrants/sortants | ventilation par mode de paiement
- [ ] **34-C** Boutons : Soumettre DG / Valider DG / Clôturer (selon rôle+statut)
- [ ] **34-D** Dashboard DG — Carte "Période de paie en attente"
  si soumis_dg → bouton Valider + résumé chiffres

**Fichiers :** `frontend/dashboard.html`
**Dépendance :** Prompt 19

---

### PROMPT 35 — UI Sanctions disciplinaires

- [ ] **35-A** Fiche agent — Onglet "Discipline" : liste sanctions + badges
- [ ] **35-B** Modal nouvelle sanction : type, date, motif, nb_jours si mise_a_pied,
  calcul retenue en temps réel, upload document
- [ ] **35-C** Section "Registre disciplinaire" dans menu RH/PAIE :
  tableau filtrable + export CSV
- [ ] **35-D** KPI RH : "Sanctions actives (30j)"

**Fichiers :** `frontend/dashboard.html`
**Dépendance :** Prompt 25

---

### PROMPT 36 — UI Offboarding + UI Heures sup + UI Attestations

- [ ] **36-A** Fiche agent — Bouton "Initier sortie" (rh/admin/dg, si actif/suspendu)
- [ ] **36-B** Modal sortie : type, dates, calculs auto, checklist matériel+accès
- [ ] **36-C** Bouton "Valider sortie" (dg/admin) + PDFs auto
- [ ] **36-D** Badge "SORTIE EN COURS" (orange) dans liste agents
- [ ] **36-E** Fiche agent — Onglet "Heures sup" :
  tableau par mois, badge statut, bouton saisir
- [ ] **36-F** Modal saisie heures sup : date, nb_heures, type, calcul temps réel
- [ ] **36-G** Section "Heures sup" dans menu RH/PAIE :
  vue consolidée tous agents + validation groupée
- [ ] **36-H** Alerte si agent dépasse plafond mensuel heures sup
- [ ] **36-I** Fiche agent — Onglet "Documents" :
  boutons "Attestation de travail" / "Attestation de salaire" / "Attestation congés"

**Fichiers :** `frontend/dashboard.html`
**Dépendance :** Prompts 26, 27, 30

---

### PROMPT 37 — UI Tableau de bord RH avancé + paramètres paie

- [ ] **37-A** Section "Tableau de bord RH" (accès dg/admin/rh) :
  Cartes KPI : turnover | ancienneté moy. | absentéisme | sanctions actives 30j
  Graphique barres : masse salariale 12 mois glissants
  Graphique camembert : répartition H/F + types contrats
  Tableau rapport comparatif par département

- [ ] **37-B** Onglet Paramètres → Paie :
  Toggle prime ancienneté (actif/inactif) + taux % + plafond %
  Toggle 13ème mois (actif/inactif) + mois de versement
  Paramètres heures sup (taux normal/dimanche/férié + plafond mensuel)
  Plafond avances sur salaire (× mois)

- [ ] **37-C** Bouton "Générer 13ème mois" dans section Bulletins
  (visible si treizieme_actif=1 ET mois courant = treizieme_mois)

**Fichiers :** `frontend/dashboard.html`
**Dépendance :** Prompts 28, 31

---

## RÉCAPITULATIF — 25 PROMPTS (13 → 37)

| # | Prompt | Bloc | Statut |
|---|--------|------|--------|
| 13 | Tables grilles salariales (DB) | A | [x] ✅ 2026-05-10 |
| 14 | Table historique_salaires + verrous + avances + bulletins (DB) | B | [x] ✅ 2026-05-10 |
| 15 | Tables période paie + rectifications + sanctions + sortie + heures_sup (DB) | C | [x] ✅ 2026-05-10 |
| 16 | Routes API grilles | A | [x] ✅ 2026-05-10 |
| 17 | Verrou salaire_base + historique (agents.js) | B | [x] ✅ 2026-05-11 |
| 18 | Workflow révision salariale (revisions_salaire.js) | B | [x] ✅ 2026-05-11 |
| 19 | Période de paie + validation masse (periodes_paie.js + salaires.js) | C | [x] ✅ 2026-05-11 |
| 20 | Corrections RBAC bulletins (4 lacunes) | D | [x] ✅ 2026-05-11 |
| 21 | Rectification bulletin payé | D | [x] ✅ 2026-05-11 |
| 22 | Workflow avances sécurisé | E | [x] ✅ 2026-05-11 |
| 23 | Synchronisation CNSS/DGI → caisse | F | [x] ✅ 2026-05-11 |
| 24 | Lien FK agents ↔ contrats | F | [x] ✅ 2026-05-11 |
| 25 | Sanctions disciplinaires (backend) | G | [x] ✅ 2026-05-11 |
| 26 | Offboarding : sortie + indemnités + PDFs | H | [ ] |
| 27 | Heures supplémentaires (backend) | I | [ ] |
| 28 | Prime ancienneté + 13ème mois (moteur paie) | J | [ ] |
| 29 | Congés maladie séparés + mutations workflow | K | [ ] |
| 30 | Services PDF partagé + attestations | L | [ ] |
| 31 | KPIs RH avancés + rapport comparatif | L | [ ] |
| 32 | UI Grilles salariales | A | [ ] |
| 33 | UI Révisions salariales + Dashboard DG | B | [ ] |
| 34 | UI Période de paie + validation masse DG | C | [ ] |
| 35 | UI Sanctions disciplinaires | G | [ ] |
| 36 | UI Offboarding + Heures sup + Attestations | H/I/L | [ ] |
| 37 | UI Tableau de bord RH + paramètres paie | L | [ ] |

---

## ORDRE D'EXÉCUTION RECOMMANDÉ

```
Phase 1 (DB — parallélisables) : 13 → 14 → 15
Phase 2 (Routes — dans cet ordre) :
  16 (grilles) → 17 (verrou salaire) → 18 (révision) → 19 (période paie)
  → 20 (RBAC) → 21 (rectif) → 22 (avances) → 23 (synchro caisse)
  → 24 (contrats) → 25 (sanctions) → 26 (offboarding) → 27 (heures sup)
  → 28 (primes) → 29 (congés/mutations) → 30 (PDF) → 31 (KPIs)
Phase 3 (Frontend) : 32 → 33 → 34 → 35 → 36 → 37
```

**Contrainte absolue :** ne jamais sauter 14 (verrou salaire_base).
C'est la règle métier n°1 — tout le reste en dépend.
