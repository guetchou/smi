# 03 — Audit identité et accès

Invariant cible : `Agent actif → compte utilisateur lié → profils synchronisés → permissions effectives cohérentes → modules autorisés uniquement`.

## 1. Cartographie des chemins d'écriture `users` / `user_profiles`

| Chemin | Passe par IdentityAccessService ? | Sync profils ? | Audit ? |
|---|---|---|---|
| POST /api/users (création directe) | ✅ `createUserAccess` | ✅ dans la tx | ✅ |
| PUT /api/users/:id (modification) | ✅ `updateUserAccess` | ✅ dans la tx | ✅ |
| **DELETE /api/users/:id (désactivation)** | ❌ `users.js:120` UPDATE direct | ❌ | ❌ (notif seulement) |
| Provisioning RH (fiche agent → compte) | ✅ `user_provisioning.js` → `createUserAccess` | ✅ | ✅ + onboarding_events |
| Sortie agent (offboarding) | ✅ `revokeEmployeeAccess` | n/a | ✅ |
| Auth self-service (changement mdp) | UPDATE direct `auth.js:115,159` — acceptable (ne touche ni rôle ni lien) | n/a | ⚠ non audité |
| Migrations 015/017/018/019/020 | scripts SQL de resync/backfill | ✅ (resync 018) | n/a |
| Bootstrap admin (database.js:386,930) | direct — compte admin initial dev | ❌ | ❌ — à classer « dev only » |
| photo_url (`users.js:370`) | direct — bénin | n/a | ❌ |

## 2. Anomalies

### ANO-IAM-01 — Unicité du lien agent non garantie en base — **HAUTE**
- **Exigence PRD** : « A linked employee can have only one active user account. »
- **Preuve** : aucune contrainte `UNIQUE` sur `users.employe_id` (migrations 015, 020, 022, 023 vérifiées). Le seul rempart est `assertEmployeAvailableForUser` (`identity_access.js:81-107`), exécuté **hors transaction** (`:128`, `:201`).
- **Reproduction** : deux requêtes POST /api/users concurrentes avec le même `employe_id` → les deux SELECT ne voient rien → les deux INSERT réussissent.
- **Conséquence métier** : deux comptes actifs pour le même agent — pointeuse, paie et audit ambigus ; violation directe de la DoD.
- **Correction minimale** : migration additive `CREATE UNIQUE INDEX uq_users_employe_id ON users(employe_id)` (MySQL ignore les NULL multiples — compatible comptes non liés) ; mapper `ER_DUP_ENTRY` sur l'erreur métier existante.
- **Tests** : test MySQL de concurrence (2 inserts parallèles, 1 succès + 1 409).
- **Risque de régression** : si des doublons existent déjà en prod, la migration échoue → prévoir requête de détection + procédure de fusion avant.
- **Statut** : ouvert.

### ANO-IAM-02 — Exemption DG d'urgence absente — **MOYENNE** (contradiction PRD)
- `identity_access.js:16` n'exempte que `admin` du lien agent. Voir CONTRA-03. Décision métier requise ; si durcissement assumé, amender le PRD.
- **Statut** : ouvert (arbitrage).

### ANO-IAM-03 — Désactivation utilisateur contournant le service — **MOYENNE**
- **Preuve** : `users.js:116-135` — `db.prepare("UPDATE users SET actif = 0 WHERE id = ?")`, pas de `updated_at`, pas de `permission_audit_logs`, pas de motif.
- **Conséquence** : trou dans la piste d'audit d'accès ; contredit AUDIT_INDUSTRIEL (CONTRA-01).
- **Correction minimale** : router vers `identityAccess.updateUserAccess(id, { actif: false }, actorId)` ou nouvelle méthode `deactivateUser` avec audit.
- **Statut** : ouvert.

### ANO-IAM-04 — Révocation partielle si liens multiples — **BASSE**
- `revokeEmployeeAccess` (`identity_access.js:257`) fait `queryOne` : si l'anomalie IAM-01 a produit deux comptes liés, un seul est révoqué à la sortie. Corriger en `query` + boucle. Dépend de IAM-01.

### ANO-SEC-05/07 — voir `10-securite.md` (gardes async, auditPermission avaleur).

## 3. Points conformes prouvés
- **Sync profils atomique** : `syncUserProfilesFromRoles` appelé avec `tx` dans create/update (`identity_access.js:163,235`) ; les profils `manual` sont préservés (`permissions.js:263`).
- **Rôle opérationnel ⇒ lien agent** : refus 400 si absent (`identity_access.js:129-133,202-206`).
- **Agent sorti ⇒ pas de compte** : `assertEmployeAvailableForUser` filtre `statut_dossier != 'sorti'` ; provisioning refuse (`user_provisioning.js:29`).
- **Provisioning RH** : R1→R7 tenus (pas d'admin par défaut, mot de passe temporaire haché, must_change_password, tâche onboarding + événement + recalc statut dans une transaction — corrigé commit `354da3f`).
- **Séparation self-service / supervision (pointeuse)** : montage `/api/pointeuse` sans module (défaut agent) ; routes agents/* derrière `requireModule('hr')`.
- **Permissions asynchrones attendues** : correct dans access.js, agents.js, cash-operation-permissions, cash_receipt_workflow_router. **Incorrect** dans salaires.js/periodes_paie.js/operations.js internes (→ `10-securite.md`).

## 4. Tests de contrat à écrire avant corrections
1. `users.employe_id` unique sous concurrence MySQL (échec attendu aujourd'hui → prouve IAM-01).
2. DELETE /api/users/:id produit une ligne `permission_audit_logs` (échec attendu → IAM-03).
3. Sortie agent avec deux comptes liés → les deux révoqués (échec attendu → IAM-04).
4. Création compte rôle `dg` sans lien : décision attendue selon arbitrage CONTRA-03.
