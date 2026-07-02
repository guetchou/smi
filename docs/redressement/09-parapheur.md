# 09 — Audit parapheur

Référence : `PRD_parapheur_numerique.md`. Exigences clés de la mission : « Aucune approbation ne doit réussir si la source ne peut pas être synchronisée. Aucune source ne doit passer à l'état approuvé sans décision valable du parapheur. »

## 1. Architecture réelle
- Tables `parapheur`, `parapheur_actions`, `parapheur_interim` (conformes au PRD §8).
- Connecteur transactionnel : `parapheur_async.creerEntreeParapheurDansTransaction(tx, payload)` — validation type/titre/initiateur, anti-doublon `(ref_source_table, ref_source_id)` hors statuts terminaux, action `soumis` + audit dans la même transaction. **Conforme.**
- Notifications post-commit (`notifierParapheurTarget`), gestion intérim incluse (copie DG). **Conforme.**
- Décision : `/api/parapheur/:id/approuver|rejeter` intercepté par `parapheur_source_sync_safe.js` (monté avant le routeur principal) qui synchronise la source **avant** de laisser le routeur principal enregistrer la décision.

## 2. Exigence « approbation ⇒ source synchronisée » — état par type

| Type | Sync source | Atomicité | Statut |
|---|---|---|---|
| conge (`employes_conges`) | ✅ | tx (leave workflow) | conforme |
| avance_salaire (`employes_avances`) | ✅ | tx | conforme |
| offboarding (`employes_sortie` + `employes`) | ✅ | **tx depuis commit `025c512`** (avant : 2 UPDATE séparés) | conforme (branche) |
| revision_salariale (`demandes_revision_salaire` + `employes` + historique) | ✅ | **tx depuis `025c512`** (avant : 3 écritures séparées) | conforme (branche) |
| demande_achat (`demandes_achat` + création opération) | ✅ | **tx depuis `025c512`** | conforme (branche) |
| decaissement (`operations.dec_statut`) | routeur parapheur principal (`syncSourceDecision`) | à re-prouver sous MySQL | partiellement |
| contrat, attestation, facture_client, correspondance, réclamation, amélioration | pas de source à synchroniser (documentaires) | n/a | conforme par nature |

## 3. Exigence inverse « source approuvée ⇒ décision parapheur valable »
Les routeurs `*_parapheur_required_safe.js` (agents, achats, offboarding, operations) interceptent les transitions d'approbation directes et exigent l'entrée parapheur. Trou résiduel : toute route legacy non couverte par un intercepteur (voir `10-securite.md` ANO-SEC-02 — la paie n'est pas dans le circuit parapheur mais possède son propre circuit DG, cassé).

## 4. Points restant à prouver

### ANO-PAR-01 — Verrouillage concurrent de la décision — MOYENNE
Deux approbations simultanées du même item : l'anti-doublon protège la **création**, mais la décision concurrente (approuver vs rejeter en parallèle) doit être prouvée sous MySQL (UPDATE conditionnel sur le statut ou `FOR UPDATE`). La PR 64 ajoute précisément ce test (« one success, one 409 conflict ») — signe que le trou existait. À vérifier lors de l'arbitrage de la PR 64.

### ANO-PAR-02 — Séparation initiateur/valideur au parapheur — MOYENNE
Le PRD confie la décision au DG. Le code ne bloque pas explicitement un initiateur qui serait aussi DG/admin d'approuver sa propre demande (contrairement aux décaissements où `CASH_OUT_SELF_APPROVAL_FORBIDDEN` existe). Correction : garde générique dans l'intercepteur (initiateur_id ≠ acteur, override admin motivé).

### ANO-PAR-03 — Rejet assistante réservé à la titulaire — implémentée sans test
Règle PRD §4 (remplaçant ne peut pas rejeter/supprimer) : logique présente côté routeur ; aucun test de contrat. À couvrir.

### ANO-PAR-04 — Conflit imminent avec la PR 64 — **BLOQUANT process**
La PR 64 **réécrit** `parapheur_source_sync_safe.js` (−335 lignes, scindé en `parapheur_leave_source_sync_safe.js` + `parapheur_source_sync_other.js`). Les correctifs d'atomicité du commit `025c512` (cette branche) portent sur le fichier historique. Fusionner les deux sans arbitrage = soit perdre les correctifs, soit conflit git massif. **Décision requise avant toute fusion** : rebaser les correctifs d'atomicité sur la nouvelle découpe, ou fusionner cette branche d'abord et rebaser la PR 64.

## 5. Échéances légales et alertes (CNSS J-5/J-2)
`calendrier_fiscal.js` + crons notifs présents ; correspondance exacte aux seuils J-5/J-2 du PRD **non testée**. Classement : implémentée sans test.

## 6. Verdict module
**Exploitable sous conditions** : chaîne création→décision→sync solide après les correctifs de cette branche ; prouver le verrou concurrent (ANO-PAR-01), ajouter la séparation initiateur/valideur (ANO-PAR-02), et arbitrer d'urgence le conflit PR 64 (ANO-PAR-04).
