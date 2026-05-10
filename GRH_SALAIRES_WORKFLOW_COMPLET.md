# GRH / SALAIRES — Cartographie Workflow Complet
**Projet : Caisse Top Center (Tala SMI)**
**Auteur : Audit Claude Code — 2026-05-10 (mis à jour : analyse RBAC saisie salaire + grilles)**
**Base : Diagnostic complet backend + DB + routes (15 fichiers routes, 1 500+ colonnes)**

---

## 0. ANALYSE RBAC SAISIE SALAIRE — Qui saisit, qui valide, qui peut corriger ?

### 0.1 Flux de saisie des données salariales d'un agent

```
SAISIE DOSSIER        GÉNÉRATION          MODIFICATION         VALIDATION        PAIEMENT
(agents.js)           BULLETIN            BULLETIN              BULLETIN          BULLETIN
     │                     │                   │                   │                 │
PUT /api/agents/:id   POST /generer       PUT /bulletin/:id   PUT /bulletin/     POST /bulletin/
salaire_base          (masse ou 1 agent)  primes librement    :id/valider        :id/payer
prime_transport                           tant que brouillon                      (+ opération
prime_logement        ─────────────────→  ──────────────────→ ──────────────→    caisse auto)
autres_primes         statut=brouillon    statut=brouillon    statut=valide
mode_paiement         snapshot du                                                 statut=paye
banque / compte       dossier agent       BLOQUÉ si valide    BLOQUÉ si paye
     │                     │              ou payé             ou brouillon
     ↓                     ↓                   │                   │
QUI PEUT :            QUI PEUT :          QUI PEUT :          QUI PEUT :        QUI PEUT :
admin, rh, finance    admin, rh,          admin, rh,          admin, finance    admin, caissier
dg, caissier          finance, dg,        finance, dg,        caissier          finance
assistante_dir        caissier,           caissier,
delegue               assistante_dir,     assistante_dir,
                      delegue             delegue
```

### 0.2 Matrice RBAC complète — Qui peut faire quoi sur les bulletins

| Action | admin | finance | rh | dg | caissier | assistante_dir | delegue | commercial |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| Saisir salaire_base agent | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| Générer bulletin | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| Modifier bulletin (brouillon) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| Attacher retenue avance | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| **Valider bulletin** | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| **Payer bulletin** | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| **Annuler bulletin** (valide→brouillon) | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Supprimer bulletin** (brouillon) | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Envoyer bulletin email | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |

> **Lacune RBAC identifiée :** Le rôle `dg` ne peut pas valider ni payer un bulletin (exclu de `FINANCE_ROLES`). C'est intentionnel ou un oubli ? À confirmer.
> **Lacune RBAC identifiée :** Aucune séparation entre "créer un bulletin" et "modifier le salaire_base" — n'importe quel rôle WRITE peut changer le salaire d'un agent.

### 0.3 Flux de correction / rectification d'un bulletin

```
SITUATION              ACTION REQUISE             QUI PEUT ?         PROCÉDURE
─────────────────────────────────────────────────────────────────────────────────
Bulletin brouillon      Modifier directement        WRITE_ROLES       PUT /bulletin/:id
  → erreur primes       sans workflow               (7 rôles)

Bulletin validé         Annuler (valide→brouillon)  ADMIN ONLY        PUT /bulletin/:id/annuler
  → erreur détectée     puis re-modifier                              + motif obligatoire
                        puis re-valider

Bulletin payé           ❌ IMPOSSIBLE               —                 Aucune route de correction
  → erreur              Régularisation mois suivant                   ⚠️ Lacune critique
  (trop-payé/trop-dû)

Salaire_base agent      Modifier directement le     WRITE_ROLES       PUT /api/agents/:id
  → modification        dossier + re-générer        (sans approbation salaire_base
                        bulletin du mois            DG ni RH)         ⚠️ Lacune critique
```

### 0.4 Lacunes RBAC critiques identifiées

**L1 — Modification salaire sans workflow d'approbation**
N'importe quel rôle WRITE (7 rôles dont `delegue`, `assistante_direction`) peut modifier
le `salaire_base` d'un agent directement. Aucune approbation DG/Finance requise.
Aucun historique des révisions salariales (seulement l'audit_log générique).

**L2 — Bulletin payé non rectifiable**
Si un bulletin est payé avec une erreur (mauvais montant), aucune procédure de régularisation
n'existe dans le système. Le trop-payé / trop-dû doit être traité manuellement hors système.

**L3 — Ségrégation des tâches absente sur la paie**
Le même rôle `finance` ou `caissier` peut générer ET valider ET payer un bulletin.
Risque de fraude : un seul agent peut déclencher tout le cycle sans contre-signature.

**L4 — DG exclu de la validation bulletins**
Le Directeur Général (`dg`) ne peut pas valider ni payer un bulletin (exclu de `FINANCE_ROLES`).
Il peut saisir les données mais pas approuver le paiement.

---

## 0bis. GRILLES SALARIALES — Ce qui manque totalement

### Structure actuelle (flat)
```
employes
  salaire_base     REAL   ← saisie libre, pas de référence
  prime_transport  REAL   ← saisie libre
  prime_logement   REAL   ← saisie libre
  autres_primes    REAL   ← champ fourre-tout
```

### Ce qui devrait exister

**Table `grilles_salariales`** — Référentiel de rémunération par poste/catégorie
```sql
CREATE TABLE grilles_salariales (
  id              INTEGER PRIMARY KEY,
  categorie       TEXT NOT NULL,    -- ex: "Cadre A", "Technicien B", "Agent C"
  echelon         INTEGER DEFAULT 1,-- 1 à 5 ou 1 à 10
  coefficient     REAL,             -- indice multiplicateur
  salaire_min     REAL NOT NULL,    -- plancher légal ou conventionnel
  salaire_max     REAL,             -- plafond catégorie
  prime_transport REAL DEFAULT 0,   -- forfait transport par catégorie
  prime_logement  REAL DEFAULT 0,   -- forfait logement par catégorie
  actif           INTEGER DEFAULT 1,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);
```

**Table `historique_salaires`** — Audit des révisions salariales
```sql
CREATE TABLE historique_salaires (
  id              INTEGER PRIMARY KEY,
  employe_id      INTEGER NOT NULL REFERENCES employes(id),
  date_effet      TEXT NOT NULL,    -- date d'entrée en vigueur
  ancien_salaire  REAL,
  nouveau_salaire REAL,
  motif           TEXT,             -- augmentation annuelle, promotion, correction, etc.
  type_revision   TEXT,             -- augmentation|correction|promotion|indexation
  approuve_par    INTEGER REFERENCES users(id),
  approuve_at     TEXT,
  created_by      INTEGER REFERENCES users(id),
  created_at      TEXT DEFAULT (datetime('now'))
);
```

**Table `revision_salariale_workflow`** — Circuit d'approbation révision salaire
```sql
-- Proposition RH → Validation DG → Effet au 1er du mois suivant
statuts : propose | soumis_dg | approuve | rejete | applique
```

### Processus de révision salariale manquant

```
RH/Finance          DG                  SYSTÈME
    │                │                     │
[Propose révision]   │                     │
 ancien → nouveau    │                     │
 date effet         │                     │
 motif              │                     │
    │──────────→[Notifié]                  │
    │           [Approuve/Refuse]          │
    │                │──────────→[Applique au 1er du mois]
    │                │           UPDATE employes SET salaire_base
    │                │           INSERT INTO historique_salaires
    │                │           Génère avenant PDF
    │←──────────────────────────[Email agent + RH]
```

### Grilles et tableaux de référence manquants

| Table / Fonctionnalité | Impact | Priorité |
|---|---|---|
| `grilles_salariales` (catégories + échelons + coefficients) | Aucune cohérence inter-agents | P1 |
| `historique_salaires` (audit révisions) | Impossibilité de justifier une paie passée | P1 |
| `revision_salariale_workflow` (circuit DG) | Modification salaire sans approbation | P1 |
| Prime ancienneté auto (taux × années) | Calcul 100% manuel | P2 |
| Simulation coût embauche (net voulu → coût employeur) | Aucun outil de budgétisation | P3 |
| Rapport comparatif masse salariale N/N-1 par département | Pilotage aveugle | P2 |
| Grille IRPP (tranches modifiables par l'admin) | ✅ Existe déjà dans parametres | ✅ |
| Grille CNSS/CAMU (taux modifiables par l'admin) | ✅ Existe déjà dans parametres | ✅ |

---

---

## 1. ÉTAT DES LIEUX — Ce qui existe déjà ✅

### 1.1 Module AGENTS (RH Core)
| Fonctionnalité | Route | Statut |
|---|---|---|
| Dossier agent complet (50+ champs) | `GET/POST/PUT /api/agents/` | ✅ |
| Matricule auto (AGT-XXXX) | `GET /api/agents/next-matricule` | ✅ |
| Statuts dossier : brouillon → actif → suspendu → sorti | `PUT /api/agents/:id` | ✅ |
| Réactivation (sorti → actif) | `PUT /api/agents/:id/reactiver` | ✅ |
| KPIs RH (total, actifs, masse salariale) | `GET /api/agents/kpis` | ✅ |
| Enfants / famille | `GET/POST/DELETE /api/agents/:id/enfants` | ✅ |
| Documents (CNI, contrat, diplôme…) avec expiration | `GET/POST/DELETE /api/agents/:id/documents` | ✅ |
| Diplômes & formations initiales | `GET/POST/DELETE /api/agents/:id/diplomes` | ✅ |
| Expériences professionnelles antérieures | `GET/POST/DELETE /api/agents/:id/experiences` | ✅ |
| Photo agent | `POST/DELETE /api/agents/:id/photo` | ✅ |
| Export CSV agents | `GET /api/agents/export-csv` | ✅ |
| Historique / audit trail agent | `GET /api/agents/:id/historique` | ✅ |
| Alertes documents expirant | `GET /api/agents/documents/alertes` | ✅ |

### 1.2 Module CONGÉS
| Fonctionnalité | Route | Statut |
|---|---|---|
| Solde congés (acquis / pris / disponible / report N-1) | `GET /api/agents/:id/conges/solde` | ✅ |
| Accrual 2,5 jours/mois | calcul automatique | ✅ |
| Report N-1 (plafond configurable) | `PUT /api/agents/:id/conges/solde/report` | ✅ |
| Demande de congé (types : annuel, maladie, maternité, paternité, sans solde, autre) | `POST /api/agents/:id/conges` | ✅ |
| Validation N+1 | `PUT /api/agents/:id/conges/:cid/valider-sup` | ✅ |
| Approbation RH | `PUT /api/agents/:id/conges/:cid/approuver` | ✅ |
| Refus avec motif | `PUT /api/agents/:id/conges/:cid/refuser` | ✅ |
| Clôture retour | `PUT /api/agents/:id/conges/:cid/terminer` | ✅ |
| Annulation | `PUT /api/agents/:id/conges/:cid/annuler` | ✅ |
| Vue calendrier (tous agents) | `GET /api/agents/conges/calendrier` | ✅ |
| Liste tous congés + filtres | `GET /api/agents/conges/all` | ✅ |
| Export CSV congés | `GET /api/agents/conges/all/export-csv` | ✅ |

### 1.3 Module AVANCES SUR SALAIRE
| Fonctionnalité | Route | Statut |
|---|---|---|
| Demande avance (montant, motif, nb échéances) | `POST /api/agents/:id/avances` | ✅ |
| Calcul échéance automatique | calcul backend | ✅ |
| Remboursement partiel | `POST /api/agents/:id/avances/:aid/remboursements` | ✅ |
| Passage automatique `en_cours` → `rembourse` à solde zéro | logique backend | ✅ |
| Annulation avance (avec motif, audit) | `PUT /api/agents/:id/avances/:aid/annuler` | ✅ |
| Blocage : agent doit être actif pour avance | validat. backend | ✅ |
| Alerte avance en souffrance (`ALRT_AVANCE_EN_SOUFFRANCE`) | notif.js | ✅ |

### 1.4 Module BULLETINS DE PAIE
| Fonctionnalité | Route | Statut |
|---|---|---|
| Génération bulletin (1 agent ou masse) | `POST /api/salaires/generer` | ✅ |
| Calcul brut (base + primes transport, logement, autres) | moteur calcul | ✅ |
| CNSS salarié 4,725% + patronal 20% | moteur calcul | ✅ |
| CAMU salarié 2,25% + patronal 5% | moteur calcul | ✅ |
| IRPP progressif 4 tranches (Congo-Brz) | moteur calcul | ✅ |
| Retenue avance sur bulletin | `POST /api/salaires/bulletin/:id/retenue-avance` | ✅ |
| Lignes custom (primes/retenues libres) | champ `lignes_custom` JSON | ✅ |
| Workflow brouillon → validé → payé | via PUT + `/valider` + `/payer` | ✅ |
| Envoi email PDF bulletin | `POST /api/salaires/bulletin/:id/email` | ✅ |
| Envoi groupe (masse) | `POST /api/salaires/envoyer-groupe` | ✅ |
| Génération PDF bulletin | `GET /api/salaires/bulletin/:id/pdf` | ✅ |
| Rapport masse salariale mensuel | `GET /api/salaires/salaires/rapport` | ✅ |
| Audit trail bulletin | `GET /api/salaires/bulletin/:id/historique` | ✅ |
| Historique envois | `GET /api/salaires/bulletin/:id/envois` | ✅ |

### 1.5 Module CNSS
| Fonctionnalité | Route | Statut |
|---|---|---|
| Paramètres taux CNSS (modifiables) | `GET/PUT /api/salaires/cnss/params` | ✅ |
| Génération déclaration mensuelle | `POST /api/salaires/cnss/declaration` | ✅ |
| Détail déclaration par mois/année | `GET /api/salaires/cnss/declaration/:mois/:annee` | ✅ |
| Suivi statut déclaration | `PUT /api/salaires/cnss/declaration/:id/statut` | ✅ |
| Enregistrement paiement CNSS | `POST /api/salaires/cnss/paiement` | ✅ |
| Export bordereau PDF | `GET /api/salaires/cnss/bordereau-pdf/:mois/:annee` | ✅ |
| Export bordereau CSV | `GET /api/salaires/cnss/bordereau-csv/:mois/:annee` | ✅ |

### 1.6 Module DGI / IRPP
| Fonctionnalité | Route | Statut |
|---|---|---|
| Paramètres taux IRPP (4 tranches modifiables) | `GET/PUT /api/salaires/dgi/params` | ✅ |
| Génération déclaration mensuelle | `POST /api/salaires/dgi/declaration` | ✅ |
| Détail déclaration | `GET /api/salaires/dgi/declaration/:mois/:annee` | ✅ |
| Suivi statut | `PUT /api/salaires/dgi/declaration/:id/statut` | ✅ |
| Enregistrement paiement IRPP | `POST /api/salaires/dgi/paiement` | ✅ |
| Export bordereau PDF | `GET /api/salaires/dgi/bordereau-pdf/:mois/:annee` | ✅ |
| Export bordereau CSV | `GET /api/salaires/dgi/bordereau-csv/:mois/:annee` | ✅ |
| Export fiscal annuel | `GET /api/salaires/dgi/export-fiscal/:annee` | ✅ |

### 1.7 Module ORGANIGRAMME
| Fonctionnalité | Route | Statut |
|---|---|---|
| Arbre org hiérarchique | `GET /api/organigramme/arbre` | ✅ |
| Arbre par département | `GET /api/organigramme/arbre/departement/:dept` | ✅ |
| Gestion départements | CRUD `/api/organigramme/departements` | ✅ |
| Gestion postes/fonctions | CRUD `/api/organigramme/postes` | ✅ |
| Gestion sites | CRUD `/api/organigramme/sites` | ✅ |
| Mutations / transferts | `POST /api/organigramme/mutations` | ✅ |
| Historique mutations agent | `GET /api/organigramme/:id/mutations` | ✅ |
| Assignation supérieur hiérarchique | `PUT /api/organigramme/:id/superieur` | ✅ |

---

## 2. WORKFLOW COMPLET GRH/SALAIRES — Processus d'entreprise

### CYCLE DE VIE AGENT (de l'embauche à la sortie)

```
RECRUTEMENT          ONBOARDING          ACTIVITÉ           SORTIE
    │                    │                   │                  │
[Candidat]          [Création dossier]   [Paie mensuelle]  [Décision]
    │               statut=brouillon         │              │
    │                    │               [Congés]          démission
    │               [Complétion]         [Avances]         licenciement
    │               documents            [Mutations]       retraite
    │               diplômes             [Évaluation]      fin contrat
    │               famille                  │                  │
    │                    │               [CNSS/DGI]         [Solde compte]
    │               statut=actif         déclarations       préavis
    │                    │               paiements          indemnités
    │                    ↓                   ↓                  │
    └──────────────→ [ACTIF] ←──────────────→ ─────────────→ [SORTI]
                         ↕                                      ↑
                   [SUSPENDU] ──────────────────────────────────┘
                   (avec motif)
```

### CYCLE MENSUEL DE PAIE (processus complet)

```
J-5                J-2              J0              J+3            J+5
 │                  │                │               │               │
[Vérif dossiers]  [Saisie primes]  [Génération]   [Validation]   [Paiement]
 statuts actifs   lignes_custom    bulletins       DG/Finance     opération
 soldes avances   transport        masse           comparaison    caisse
 fin contrats     logement         +saisonniers    N-1
 congés en cours  autres primes    statut=brouillon statut=valide  statut=paye
                                                                    │
                                                               [Envoi PDF]
                                                               email agents
                                                                    │
                                                    ┌──────────────┐│
                                                    │              ↓│
                                                [CNSS décl.]  [DGI décl.]
                                                bordereau     bordereau
                                                paiement      IRPP
                                                              paiement
```

### WORKFLOW CONGÉS (processus hiérarchique)

```
AGENT              N+1 (Sup)        RH              SYSTÈME
  │                   │              │                 │
[Demande]             │              │                 │
type + dates          │              │                 │
motif                 │              │                 │
  │                   │              │             [Vérif solde]
  │──────────────→[Notifié]          │             [Vérif chevauchement]
  │              valide_sup          │              statut=demande
  │                   │              │                 │
  │              [Validation]        │                 │
  │              ou refus+motif      │                 │
  │                   │──────────→[Notifiée]           │
  │                   │          approuve              │
  │                   │          ou refus              │
  │                   │              │──────────→[Débit solde]
  │                   │              │           statut=approuve
  │←──────────────────│──────────────│           email agent
  │                   │              │                 │
[Au retour]           │              │            [Terminer]
  │                   │              │            statut=termine
  │←─────────────────────────────────│────────→ [Recalcul solde]
```

### WORKFLOW AVANCES SUR SALAIRE

```
AGENT         RH/FINANCE         CAISSE          BULLETINS
  │               │                 │                │
[Demande]         │                 │                │
montant           │                 │                │
nb échéances      │                 │                │
motif             │                 │                │
  │──────────→[Examen]              │                │
  │           vérif solde           │                │
  │           historique            │                │
  │               │──────────→[Décaissement]         │
  │               │           opération              │
  │               │           caisse                 │
  │←──────────────│           statut=en_cours         │
  │                                 │                │
  │  [Remboursement mensuel]        │                │
  │       ↓                         │                │
  │  [Retenue bulletin] ────────────────────────→[Déduction]
  │  montant_echeance               │           retenue_avance
  │       ↓                         │           net_a_verser
  │  [Solde décrémenté]             │                │
  │       ↓                         │                │
  │  [Clôture automatique]          │                │
  │  solde=0 → statut=rembourse     │                │
```

---

## 3. LACUNES IDENTIFIÉES — Ce qui manque ❌⚠️

### 3.1 CRITIQUE — Processus métier incomplets

#### ❌ A. Gestion disciplinaire (inexistante)
**Processus absent complet :**
- Avertissement verbal → écrit → mise à pied → licenciement
- Aucune table `sanctions_disciplinaires` / `avertissements`
- Aucun workflow approbation DG
- Aucune pièce jointe à sanction
- Impact sur bulletin (retenue mise à pied) non automatisé

**Ce qui manque :**
```
Table : employes_sanctions
  - id, employe_id, type (avertissement_verbal|avertissement_ecrit|
                           mise_a_pied|licenciement_cause_reelle)
  - date_sanction, motif_detaille, document_url
  - nb_jours_mise_a_pied (si applicable)
  - statut (projet|notifie|conteste|clos)
  - created_by, updated_at, audit_trail

Route : POST /api/agents/:id/sanctions
Route : GET  /api/agents/:id/sanctions
Route : PUT  /api/agents/:id/sanctions/:sid/statut
```

#### ❌ B. Gestion de la sortie / offboarding (partielle)
**Ce qui existe :** champ `motif_sortie`, `date_sortie`, `statut_dossier=sorti`
**Ce qui manque :**
- Calcul automatique indemnités de licenciement
- Calcul indemnité de préavis (non effectué)
- Solde de tout compte (génération document)
- Certificat de travail (génération PDF)
- Récupération matériel / accès (checklist)
- Blocage accès système à la date de sortie
- Archivage dossier (conservation légale 5 ans)

```
Table : employes_sortie
  - employe_id, type_sortie (démission|licenciement|retraite|fin_contrat|décès)
  - date_depart_effectif, date_fin_preavis
  - indemnite_licenciement, indemnite_preavis, conges_payes_restants
  - solde_tout_compte_total, solde_tout_compte_pdf
  - checklist_materiel JSON, checklist_acces JSON
  - created_by, validated_by, validated_at

Route : POST /api/agents/:id/sortie/initier
Route : GET  /api/agents/:id/sortie/calcul-indemnites
Route : GET  /api/agents/:id/sortie/solde-tout-compte-pdf
Route : POST /api/agents/:id/sortie/valider
```

#### ❌ C. Évaluations de performance (inexistantes)
**Processus absent complet :**
- Aucune table `evaluations` ni `objectifs`
- Aucun cycle annuel/semestriel
- Aucun lien évaluation → augmentation salariale
- Aucune grille de compétences

```
Tables : employes_evaluations, employes_objectifs
  - Cycle, période, note globale, axes évalués, commentaires
  - Workflow : brouillon → soumis → validé DG
  - Lien vers revision salariale

Routes : POST/GET/PUT /api/agents/:id/evaluations
```

#### ❌ D. Gestion des formations (inexistante)
**Ce qui existe :** champ `diplomes` (formations passées uniquement)
**Ce qui manque :**
- Plan de formation annuel
- Sessions de formation planifiées
- Inscription agents aux formations
- Suivi présence / résultat
- Budget formation
- Certifications obtenues → mise à jour compétences

```
Tables : formations, formations_sessions, formations_inscriptions
Routes : CRUD /api/formations/
```

#### ❌ E. Heures supplémentaires (inexistantes)
**Ce qui manque :**
- Saisie heures supp (par agent, par période)
- Taux majoration (125%, 150%, 200% selon jour)
- Intégration automatique dans le bulletin
- Plafond légal heures supp / mois

```
Table : employes_heures_sup
  - employe_id, date, nb_heures, type (normal|dimanche|ferie)
  - taux_majoration, montant_brut
  - valide_par, statut (saisi|valide|integre_bulletin)

Route : POST /api/agents/:id/heures-sup
Route : GET  /api/salaires/bulletin/:id/integrer-heures-sup
```

#### ❌ F. Pointage / Présences (inexistant)
**Ce qui manque :**
- Registre journalier présence/absence
- Motifs absences non-justifiées
- Retards / départs anticipés
- Impact sur bulletin (déduction absences injustifiées)
- Reporting mensuel présences

```
Table : employes_pointages
  - employe_id, date, heure_entree, heure_sortie
  - statut (present|absent|retard|conge|mission)
  - justifie (boolean), motif, valide_par
```

---

### 3.2 IMPORTANT — Manques dans les processus existants

#### ⚠️ G. Workflow mutations — approbation manquante
**Ce qui existe :** `POST /api/organigramme/mutations` (création directe, sans workflow)
**Ce qui manque :**
- Workflow : proposition → approbation DG → effective
- Avenant contrat généré automatiquement à la mutation
- Délai de prise de fonction
- Impact sur supérieur (nouveau N+1)

**Fix minimal :**
```javascript
// Ajouter dans employes_mutations :
statut TEXT DEFAULT 'propose'  -- propose|approuve|effectif|annule
approuve_par INTEGER
approuve_at TEXT
date_effective TEXT  -- date réelle d'entrée en vigueur
```

#### ⚠️ H. Prime ancienneté — non automatisée
**Ce qui existe :** champ `autres_primes` (saisie manuelle)
**Ce qui manque :**
- Calcul automatique ancienneté (date_embauche → aujourd'hui)
- Barème configurable (ex. 2% par an, plafonné à 20%)
- Intégration automatique dans `lignes_custom` du bulletin

**Fix minimal :**
```javascript
// Dans moteur calcul bulletins (salaires.js)
const anciennete_ans = diffYears(employe.date_embauche, periode);
const prime_anciennete = Math.min(anciennete_ans * taux.anciennete_pct / 100, taux.anciennete_plafond_pct / 100) * brut_base;
```

#### ⚠️ I. 13ème mois / Gratification — non structuré
**Ce qui existe :** `autres_primes` (saisie libre)
**Ce qui manque :**
- Paramètre "13ème mois actif" (oui/non, mois de versement)
- Calcul automatique (1/12 du salaire annuel ou autre règle)
- Bulletin distinct du mois ordinaire (type=`treizieme_mois`)
- Déclaration CNSS/DGI spécifique

#### ⚠️ J. Réconciliation bulletin ↔ opération caisse
**Ce qui existe :** `bulletin.operation_id` (lien existe)
**Ce qui manque :**
- Rapport réconciliation : bulletins payés sans opération caisse
- Bulletins validés non payés depuis N jours → alerte bloquante
- Détail du versement par mode (virement, espèces, chèque)

#### ⚠️ K. Délégation approbation congés
**Ce qui existe :** table `delegations_approbation` (système général)
**Ce qui manque :**
- Application concrète sur workflow congés (le supérieur peut déléguer)
- Interface de configuration des délégations congés
- Notification au délégataire

#### ⚠️ L. Solde congés maladie distinct
**Ce qui existe :** type_conge='maladie' mais débite le solde annuel
**Ce qui manque :**
- Compteur congés maladie séparé (avec certificat médical obligatoire)
- Règle : X jours maladie/an sans impact solde annuel
- Au-delà : basculement sur congés sans solde automatique

#### ⚠️ M. Contrats CDD — renouvellement automatique
**Ce qui existe :** alertes expiration contrat (30j, 15j, 7j, 1j)
**Ce qui manque :**
- Workflow décision à l'échéance : renouveler CDD / transformer CDI / non-renouveler
- Avenant automatique (PDF) à la décision de renouvellement
- Compteur renouvellements CDD (limite légale 2 renouvellements Congo)
- Blocage si 3ème renouvellement → alerte transformation CDI obligatoire

---

### 3.3 MINEUR — Améliorations ergonomiques

#### ⚠️ N. Rapport masse salariale comparative
**Ce qui existe :** rapport mois en cours
**Ce qui manque :** comparaison N / N-1, évolution % par département

#### ⚠️ O. Simulation d'embauche
Calculer coût total employeur avant embauche (salaire net voulu → coût brut + charges)

#### ⚠️ P. Attestations automatiques
- Attestation de travail (PDF auto)
- Attestation de salaire (PDF auto)
- Attestation congés (PDF auto)
Ces documents sont dans `types_docs` mais aucune génération PDF automatisée.

#### ⚠️ Q. Tableau de bord RH — indicateurs manquants
**Ce qui existe :** KPIs basiques (total, actifs, masse salariale)
**Ce qui manque :**
- Turnover mensuel / annuel
- Ancienneté moyenne
- Répartition H/F
- Pyramide des âges
- Taux d'absentéisme
- Coût moyen par département

---

## 4. TODO LIST — Priorisation implémentation

### PRIORITÉ 1 — Critique métier (à implémenter)

- [ ] **P1-A** : `employes_sanctions` — table + routes CRUD + workflow + audit
- [ ] **P1-B** : Offboarding complet — calcul indemnités + solde tout compte PDF + blocage accès
- [ ] **P1-C** : Heures supplémentaires — saisie + calcul + intégration bulletin
- [ ] **P1-D** : Prime ancienneté automatique — paramètre taux + calcul moteur paie

### PRIORITÉ 2 — Important (processus existants à compléter)

- [ ] **P2-A** : Workflow mutations avec approbation DG + avenant PDF
- [ ] **P2-B** : 13ème mois — paramètre + bulletin type dédié + CNSS/DGI
- [ ] **P2-C** : Solde congés maladie séparé du solde annuel
- [ ] **P2-D** : Rapport réconciliation bulletins ↔ opérations caisse
- [ ] **P2-E** : Renouvellement CDD — workflow + compteur + alerte CDI obligatoire

### PRIORITÉ 3 — Amélioration (valeur ajoutée)

- [ ] **P3-A** : Module formations — plan + sessions + inscriptions + budget
- [ ] **P3-B** : Évaluations de performance — cycle annuel + objectifs + grille
- [ ] **P3-C** : Pointage / présences — registre + absences + impact bulletin
- [ ] **P3-D** : Délégation approbation congés — interface + notification délégataire
- [ ] **P3-E** : Attestations PDF auto (travail, salaire, congés)
- [ ] **P3-F** : Tableau de bord RH avancé (turnover, absentéisme, pyramide âges)
- [ ] **P3-G** : Simulation coût embauche (net voulu → coût employeur)

---

## 5. SYNCHRONISATION AVEC LES AUTRES MODULES

### GRH ↔ Trésorerie/Caisse
| Événement GRH | Impact Caisse | Lien actuel |
|---|---|---|
| Bulletin `paye` | Décaissement opération | ✅ `bulletin.operation_id` |
| Avance accordée | Décaissement opération | ⚠️ Lien décaissement pas créé automatiquement |
| CNSS paiement | Décaissement externe | ⚠️ Non lié à opérations caisse |
| DGI paiement | Décaissement externe | ⚠️ Non lié à opérations caisse |
| Mise à pied (retenue) | Réduction décaissement | ❌ Manuel uniquement |

**Synchronisation manquante :**
```
CNSS paiement → créer automatiquement opération caisse (décaissement)
DGI paiement  → créer automatiquement opération caisse (décaissement)
Avance accordée → créer automatiquement opération caisse (décaissement)
```

### GRH ↔ Contrats
| Événement GRH | Impact Contrat | Lien actuel |
|---|---|---|
| Embauche agent | Contrat de travail | ❌ Aucun lien `employes ↔ contrats` |
| Mutation | Avenant contrat | ❌ Non généré |
| Promotion/augmentation | Avenant salaire | ❌ Non généré |
| Renouvellement CDD | Nouveau contrat | ❌ Non lié |

**Synchronisation manquante :**
```
Table employes : ajouter contrat_id FK → contrats
À l'embauche : générer contrat RH dans module Contrats
À la mutation : créer avenant
```

### GRH ↔ Notifications
| Règle | Configurée | Déclenchée |
|---|---|---|
| `RAP_SALAIRE_MENSUEL` | ✅ | ✅ |
| `RAP_CONTRAT_FIN` | ✅ | ✅ |
| `RAP_ESSAI_FIN` | ✅ | ✅ |
| `RAP_DOCUMENT_EXPIRATION` | ✅ | ✅ |
| `RAP_RETRAITE` | ✅ | ✅ |
| `RAP_AVANCE_ECHEANCE` | ✅ | ✅ |
| `ALRT_AVANCE_EN_SOUFFRANCE` | ✅ | ✅ |
| `NOTIF_BULLETIN_VALIDE` | ✅ | ✅ |
| `NOTIF_BULLETIN_PAYE` | ✅ | ✅ |
| `NOTIF_CONGE_REFUSE` | ✅ | ✅ |
| Sanction disciplinaire | ❌ | ❌ |
| Fin préavis sortie | ❌ | ❌ |
| CDD 3ème renouvellement | ❌ | ❌ |
| Heures supp plafond | ❌ | ❌ |

---

## 6. ARCHITECTURE DONNÉES — Schéma relations GRH

```
employes (master)
    │
    ├── employes_enfants         (famille)
    ├── employes_documents       (pièces, contrats, diplômes)
    ├── employes_diplomes        (formations initiales)
    ├── employes_experiences     (carrière antérieure)
    │
    ├── employes_conges          (workflow 5 statuts)
    ├── employes_avances         (avances + remboursements)
    │       └── employes_avances_remboursements
    │
    ├── employes_mutations       (⚠️ sans workflow)
    │
    ├── bulletins_salaire        (mensuel, statut brouillon→valide→paye)
    │       └── bulletin_envois  (historique emails)
    │
    ├── [MANQUE] employes_sanctions       (❌ à créer)
    ├── [MANQUE] employes_heures_sup      (❌ à créer)
    ├── [MANQUE] employes_evaluations     (❌ à créer)
    ├── [MANQUE] employes_sortie          (❌ à créer)
    │
    ├── cnss_declarations        (mensuel, lié aux bulletins)
    │       └── cnss_paiements
    ├── dgi_declarations         (mensuel, IRPP)
    │       └── dgi_paiements
    │
    └── org_departements / org_postes / org_sites  (structure)
```

---

## 7. RBAC — Rôles sur modules GRH

| Module | admin | rh | dg | finance | caissier | commercial |
|---|---|---|---|---|---|---|
| Agents CRUD | ✅ | ✅ | 👁 | ❌ | ❌ | ❌ |
| Congés approuver | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Avances créer | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| Bulletins générer | ✅ | ✅ | 👁 | ✅ | ❌ | ❌ |
| Bulletins valider | ✅ | ❌ | ✅ | ✅ | ❌ | ❌ |
| Bulletins payer | ✅ | ❌ | ✅ | ✅ | ✅ | ❌ |
| CNSS/DGI déclarer | ✅ | ❌ | ✅ | ✅ | ❌ | ❌ |
| Organigramme | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Sanctions | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| Offboarding | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |

---

## 8. RÉSUMÉ EXÉCUTIF

### Ce qui fonctionne (production-ready)
Le cœur du cycle paie **embauche → bulletin mensuel → CNSS/DGI → paiement** est complet et conforme OHADA Congo-Brazzaville. Les congés, avances, organigramme et audit trail sont opérationnels.

### Ce qui manque (processus d'entreprise)
3 processus RH critiques sont **totalement absents** :
1. **Gestion disciplinaire** — aucun registre sanctions
2. **Offboarding structuré** — sortie sans calcul indemnités ni documents
3. **Heures supplémentaires** — aucune saisie ni calcul automatique

### Synchronisation manquante
- CNSS/DGI paiements ne génèrent **pas** d'opération caisse automatique
- Avances accordées ne génèrent **pas** de décaissement caisse automatique
- **Aucun lien** entre contrats de travail (module Contrats) et dossiers agents (module RH)

### Prochaine étape recommandée
Implémenter **P1-A** (sanctions) + **P1-B** (offboarding) + synchronisation CNSS/DGI → caisse en priorité. Ce sont les manques les plus visibles en usage quotidien.
