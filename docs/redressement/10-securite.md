# 10 — Audit sécurité (permissions contournables)

## ANO-SEC-01 — Auto-validation DG de toute période de paie — **CRITIQUE**
- **Exigence PRD** : machine à états paie `submitted_to_dg → approved_by_dg` avec validation DG distincte ; user story 15 (séparation payer/approuver).
- **Preuve** : `backend/routes/periodes_paie.js:181,198,234`. Les helpers `canSubmitPayrollPeriod`/`canApprovePayrollPeriod` sont `async` (`services/permissions.js:111-117`). Les handlers sont **synchrones** et testent la Promise :
  - `:181` `if (!canSubmitPayrollPeriod(req.user))` → `!Promise` = false → jamais bloqué ;
  - `:198` `if (canApprovePayrollPeriod(req.user))` → Promise truthy → **branche d'auto-approbation toujours prise** : la période passe directement `validee_dg` avec `soumis_dg_by = valide_dg_by = l'appelant`, audit `soumettre_auto_valider_dg` ;
  - `:234` la route `valider-dg` ne bloque personne non plus (déjà sans objet puisque tout est auto-validé à la soumission).
- **Reproduction** : tout utilisateur passant `requireModule('salary')` appelle `POST /api/paie/periodes/:id/soumettre-dg` → réponse `{ statut: 'validee_dg', auto_approved: true }`.
- **Conséquence métier** : la validation DG de la masse salariale n'existe pas en production ; n'importe quel profil paie peut approuver la masse salariale du mois.
- **Correction minimale** : handlers `async` + `await` sur les trois gardes (le diff exact existe dans la PR 64 — **à extraire en PR dédiée immédiate**, sans attendre le mega-PR).
- **Tests** : contrat HTTP — utilisateur `rh` sans `salary.approve_period_dg` soumet → statut `soumis_dg` (pas `validee_dg`) ; utilisateur sans `salary.submit_to_dg` → 403.
- **Risque de régression** : nul (resserrement pur) ; vérifier que le DG légitime conserve l'auto-approbation voulue à la soumission.
- **Statut** : ouvert sur `main` ; correctif disponible dans PR 64 (non fusionnée).

## ANO-SEC-02 — Gardes de rôles paie no-op (~30 routes) — **CRITIQUE**
- **Preuve** : `salaires.js:87-96` — `canRHFinance/canWrite/canManagePayrollFinance` retournent `can(user,…) || hasRole(…)` : la Promise court-circuite le `||`, et les ~30 appels `if (!canX(req.user))` (`:287,471,997,1045,…,2562`) ne bloquent jamais. Idem `canValidateBulletin`/`canPaySalary` (`:1083,1138,1245,1410`) — fonctions async testées sans `await`.
- **Périmètre réel d'exposition** : la protection restante est le montage `requireModule('salary')` (`server.js:231`). Tout détenteur du module salary (quel que soit son rôle) peut : générer, éditer, **valider** et **payer** des bulletins, corriger des bulletins payés, piloter CNSS/DGI.
- **Correction minimale** : rendre les helpers `async`, `await` chaque site d'appel (PR 64 corrige `salaires.js` en partie — vérifier l'exhaustivité des ~30 sites lors de l'extraction).
- **Tests** : pour chaque transition sensible, un test 403 avec un utilisateur module-salary sans la permission.
- **Statut** : ouvert sur `main`.

## ANO-SEC-03 — `POST /api/operations/import` sans garde effective — **HAUTE**
- **Preuve** : `operations.js:2177` — `if (!canWrite(req.user))` avec `canWrite` = `can(...) || hasRole(...)` (`:183`) → no-op. Le middleware sûr (`operations_parapheur_required_safe.js:193-198`) couvre `POST /`, `PUT /:id`, `soumettre`, `resoumettre`, `payer`, `valider` — **pas `/import`**.
- **Conséquence** : tout détenteur du module cash peut importer en masse des opérations (Excel), y compris des encaissements directement `valide`.
- **Correction minimale** : ajouter `router.post('/import', requireWritePermission)` dans le routeur sûr (1 ligne) + await dans le legacy.
- **Statut** : ouvert.

## ANO-SEC-04 — Fuite de périmètre en lecture des opérations — **MOYENNE**
- **Preuve** : `operations.js:1195-1197` — `const canPay = canPayCashOut(req.user);` non attendu → truthy → le filtre `ownerOnly` (limiter un simple rédacteur à ses brouillons) ne s'applique jamais : tout détenteur du module voit toutes les opérations.
- **Correction** : `await` (et await de `canApproveDec` déjà présent) ; test de scope par rôle.

## ANO-SEC-05 — Désactivation utilisateur sans service ni audit — **MOYENNE**
Voir `03-identite-acces.md` (ANO-IAM-03) — `users.js:120`.

## ANO-SEC-06 — Plafonds de délégation ignorés sans contexte montant — **BASSE**
- `permissions.js:52-56` : si la route n'envoie pas `context.amount`, une délégation plafonnée autorise sans limite. Les chemins cash passent le montant (audit 23/06) ; recenser les autres appels `can()` avec permission à plafond et imposer le contexte.

## ANO-SEC-07 — `auditPermission` avale les erreurs — **BASSE**
- `permissions.js:149` `catch (_) {}` : un échec d'audit d'accès est silencieux, y compris dans les transactions où il devrait faire échouer l'opération (l'exécuteur `tx` est fourni mais l'erreur est neutralisée). Correction : ne pas avaler quand un `executor` transactionnel est passé.

## Recommandation transversale — interdire le motif à la racine
Ajouter un contrôle statique (dans `tests/static_checks.js`, qui garde déjà d'autres invariants) : interdire les motifs `if (!can*(req.user))` et `can(user, ...) ||` sans `await` dans `backend/routes/**`. C'est ce qui a permis au bug de survivre au correctif du 23 juin (qui n'a couvert que les décaissements) : sans garde CI, le motif reviendra.

## Périmètre non couvert par cette passe
Injection SQL (paramétrage systématique observé, mais pas de revue exhaustive), XSS frontend, gestion de session/JWT, rate limiting (présent sur login), CSP (désactivée dans helmet — `server.js:51`, à réévaluer). À traiter dans une passe sécurité dédiée.
