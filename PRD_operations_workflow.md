# PRD — Workflow Encaissement / Décaissement (v2)

**Date** : 2026-05-18  
**Auteur** : Grill-me audit Q1–Q9  
**Scope** : Module Operations (encaissements, décaissements, virements internes)

---

## 1. Contexte

Le module Opérations actuel souffre de 14 lacunes critiques identifiées lors de l'audit Q1–Q9. Ce PRD définit les règles métier et les changements techniques à implémenter. L'application est **SaaS multi-tenant** : toutes les règles configurables doivent passer par le dashboard admin, jamais codées en dur.

---

## 2. RBAC Encaissements (Q1)

### Règle
Seuls les rôles `admin`, `caissier`, `finance`, `dg` peuvent créer un encaissement officiel.  
Les rôles `rh`, `assistante_direction`, `delegue` sont **interdits**.  
Exception : un utilisateur cumul rôle caissier + autre rôle → autorisé via le rôle caissier.

### Implémentation
- Middleware `requireRole(['admin','caissier','finance','dg'])` sur `POST /api/operations` (type encaissement)
- Filtrage côté serveur — jamais côté client uniquement

---

## 3. Workflow Décaissement (Q2)

### États
```
brouillon → soumis → en_attente_approbation → approuvé → payé
                                            ↘ rejeté → (correction) → soumis
                              annulé (avant paiement, rôles: dg/finance/admin)
                              contrepassé (après paiement — jamais annulé)
```

### Règles
- `rejeté` : motif obligatoire, notification initiateur, possibilité resoumission
- Annulation avant paiement : rôles `dg`, `finance`, `admin` uniquement
- Après paiement : **contrepassation** uniquement (nouvelle entrée compensatoire), jamais suppression
- Seuils d'approbation configurables (admin dashboard) :
  - Ex. < 50 000 XAF → finance seul suffit
  - 50 000–500 000 XAF → finance + DG
  - > 500 000 XAF → DG obligatoire
- Seuils stockés dans table `parametres` (clé: `seuil_approbation_finance`, `seuil_approbation_dg`)

---

## 4. Workflow Encaissement (Q3)

### États
```
brouillon → soumis → validé
                   ↘ litige → (résolution) → validé | annulé
                   correction post-validation : nouvelle entrée liée (pas modification)
```

### Règles
- Virements internes : type séparé `virement_interne` — **exclu** des KPIs encaissement
- Encaissement `litige` : initiable par finance/admin/dg, motif obligatoire
- Correction post-validation : entrée corrective (delta), référence à l'entrée originale

---

## 5. Pièces Jointes (Q4)

### Table `operation_attachments`
```sql
CREATE TABLE operation_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id INTEGER NOT NULL,
  filename TEXT NOT NULL,
  filepath TEXT NOT NULL,
  mimetype TEXT NOT NULL,
  size_bytes INTEGER,
  uploaded_by INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  archived INTEGER DEFAULT 0
);
```

### Règles
- Types acceptés : PDF, images (JPG/PNG), Excel, Word — configurables admin (`types_pj_acceptes`)
- Stockage local d'abord, migration S3 future
- Seuil montant pour PJ obligatoire : configurable (`seuil_pj_obligatoire`)
- Après validation : archivé (`archived=1`), pas supprimé
- Requête annulée : PJ conservées

---

## 6. Virements Internes (Q5)

### Règles
- Type distinct `virement_interne` dans la table `operations`
- **Exclus** des KPIs encaissement (`type_op = 'encaissement'` only, jamais `IN ('encaissement','virement')`)
- Double confirmation : caisse source valide → caisse destination confirme réception
- Statuts virement : `initié → confirmé_source → confirmé_destination → complété | litige`
- `litige` déclenché automatiquement si non-confirmé après délai configurable (`delai_confirmation_virement`)
- KPI dashboard "mouvements internes" séparé des encaissements/décaissements

---

## 7. Clôture et Rapprochement (Q6)

### Clôture quotidienne par caisse
- Table `cashbox_closures` :
```sql
CREATE TABLE cashbox_closures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  caisse_id INTEGER NOT NULL,
  date_cloture TEXT NOT NULL,
  solde_ouverture REAL NOT NULL,
  solde_cloture REAL NOT NULL,
  total_encaissements REAL NOT NULL,
  total_decaissements REAL NOT NULL,
  ecart REAL DEFAULT 0,
  cloture_par INTEGER NOT NULL,
  reouverture_par INTEGER,
  reouverture_motif TEXT,
  statut TEXT DEFAULT 'cloturee' CHECK(statut IN ('cloturee','reopened')),
  created_at TEXT DEFAULT (datetime('now'))
);
```
- Période clôturée : **aucune saisie rétroactive** possible
- Réouverture : Finance + DG + motif obligatoire
- Écarts → anomalies à valider

### Clôture mensuelle
- Agrégation des clôtures quotidiennes
- Rapport consolidé par caisse

---

## 8. Délégations Centralisées (Q7)

### Table `delegations`
```sql
CREATE TABLE delegations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delegant_id INTEGER NOT NULL,
  delegataire_id INTEGER NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('ponctuelle','temporaire_globale')),
  module TEXT,          -- NULL = tous modules
  action TEXT,          -- NULL = toutes actions
  montant_max REAL,     -- plafond délégation
  date_debut TEXT NOT NULL,
  date_fin TEXT,        -- NULL = ponctuelle sans fin auto
  motif TEXT NOT NULL,
  statut TEXT DEFAULT 'active' CHECK(statut IN ('active','revoquee','expiree')),
  created_at TEXT DEFAULT (datetime('now'))
);
```

### Règles
- Pas de re-délégation (délégué ne peut pas re-déléguer)
- Actions passées valides après révocation (immutabilité historique)
- Tag obligatoire sur actions par délégué : "Approuvé par [DG] — délégué [X]"
- Actions non-délégables : liste configurable admin (`actions_non_delegables`)
- Habilitation permanente ≠ délégation temporaire (champs distincts sur l'utilisateur)

---

## 9. Contrôle d'accès par Caisse (Q8)

### Table `user_cashboxes`
```sql
CREATE TABLE user_cashboxes (
  user_id INTEGER NOT NULL,
  caisse_id INTEGER NOT NULL,
  can_read INTEGER DEFAULT 1,
  can_write INTEGER DEFAULT 0,
  affecte_par INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, caisse_id)
);
```

### Règles
- Caissier : voit uniquement ses caisses affectées
- Finance/DG/Admin : voient toutes les caisses
- Caisse confidentielle (`is_confidential=1`) : DG uniquement
- Filtrage **server-side** obligatoire sur tous les endpoints `/api/operations`
- Solde dashboard filtré par caisses autorisées

---

## 10. Cohérence du Solde (Q9)

### Table `cash_ledger` (append-only)
```sql
CREATE TABLE cash_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  caisse_id INTEGER NOT NULL,
  operation_id INTEGER,
  type_mouvement TEXT NOT NULL CHECK(type_mouvement IN ('debit','credit','ouverture','cloture','correction')),
  montant REAL NOT NULL,
  solde_avant REAL NOT NULL,
  solde_apres REAL NOT NULL,
  reference TEXT,
  created_by INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
```

### Table `cashbox_balances` (solde courant)
```sql
CREATE TABLE cashbox_balances (
  caisse_id INTEGER PRIMARY KEY,
  solde_courant REAL NOT NULL DEFAULT 0,
  derniere_operation_id INTEGER,
  updated_at TEXT DEFAULT (datetime('now'))
);
```

### Règles
- Solde initial = entrée d'ouverture validée dans `cash_ledger` (pas champ libre)
- Toute écriture : `BEGIN IMMEDIATE` (SQLite) pour transactions atomiques
- Consultation solde historique : `SELECT solde_apres FROM cash_ledger WHERE caisse_id=? AND created_at<=? ORDER BY id DESC LIMIT 1`
- Aucune modification rétroactive après clôture
- Alerte solde minimum : paramètre `alerte_solde_minimum` (déjà en DB)

---

## 11. Critères de Succès

| # | Critère | Priorité |
|---|---------|----------|
| 1 | RBAC encaissements filtré server-side | 🔴 Critique |
| 2 | Statut `rejeté` décaissements + resoumission | 🔴 Critique |
| 3 | Virements internes exclus KPIs encaissement | 🔴 Critique |
| 4 | Tables cash_ledger + cashbox_closures créées | 🔴 Critique |
| 5 | user_cashboxes + filtrage server-side | 🟠 Haute |
| 6 | Seuils approbation configurables | 🟠 Haute |
| 7 | Clôture quotidienne par caisse | 🟠 Haute |
| 8 | Transactions atomiques (BEGIN IMMEDIATE) | 🟠 Haute |
| 9 | Pièces jointes (table + upload) | 🟡 Moyenne |
| 10 | Délégations centralisées | 🟡 Moyenne |
| 11 | Double confirmation virements | 🟡 Moyenne |

---

## 12. Rollback

- Toutes les nouvelles tables : `CREATE TABLE IF NOT EXISTS` (non-destructif)
- Colonnes ajoutées : `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` ou migration avec vérification
- Aucun `DROP`, `TRUNCATE` ni modification de données existantes
- Sauvegarde DB avant migration : `/backups/caisse_$(date +%Y%m%d_%H%M%S).db`
