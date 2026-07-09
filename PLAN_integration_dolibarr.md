# Plan technique - Integration Dolibarr avec Tala SMI

**Date** : 2026-07-08
**Base PRD** : `PRD_integration_dolibarr.md`
**Mode d'execution** : lots courts, non destructifs, testables, rollback documente

---

## 1. Objectif du plan

Transformer le PRD d'integration Dolibarr en sequence d'implementation executable par un profil Lead Backend / ERP Integration Engineer.

Le plan interdit les raccourcis suivants :

- appel HTTP Dolibarr directement depuis les routes metier ;
- appel Dolibarr depuis le frontend ;
- ecriture directe dans la base Dolibarr ;
- synchronisation automatique avant validation metier ;
- creation distante sans cle d'idempotence ;
- logs contenant une cle API ou un secret ;
- suppression distante automatique.

---

## 2. Prerequis bloquants avant code

Ces informations doivent etre confirmees avant toute implementation connectee a une vraie instance Dolibarr :

| Prerequis | Statut | Impact si absent |
|---|---|---|
| URL Dolibarr de test | A fournir | Impossible de tester le connecteur reel |
| Version Dolibarr | A fournir | Endpoints/payloads potentiellement differents |
| Modules Dolibarr actifs | A fournir | Impossible de garantir les ressources API disponibles |
| Compte API dedie | A fournir | Risque de droits excessifs ou d'audit incomplet |
| Cle API de test | A fournir via `.env`, jamais dans le chat | Impossible d'appeler API |
| Regle source de verite factures | A valider | Risque de doublon facture |
| Regle source de verite paiements | A valider | Risque de double paiement |
| Numerotation facture/piece | A valider | Risque de conflit reference |
| Environnement sandbox | Recommande fortement | Risque production inutile |

Tant que ces elements manquent, seules les phases mockees/locales sont executables.

---

## 3. Audit technique initial a faire avant code

### 3.1 Commandes passives

```bash
pwd
git status --short --branch
git log -3 --oneline
df -h /opt/projet-smi /tmp
ss -ltnp
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
find backend/routes backend/services backend/migrations tests -maxdepth 2 -type f | sort
```

### 3.2 Fichiers a lire

- `PRD_integration_dolibarr.md`
- `PRD_flux_encaissement_decaissement_tresorerie_comptabilite_budget.md`
- `PRD_operations_workflow.md`
- `docs/finance-operations-ui-contract.md`
- `ACCESS_CONTROL_MODEL.md`
- `backend/routes/operations.js`
- `backend/services/finance-operations.js`
- `backend/services/permissions.js`
- `backend/db.js`
- `backend/migrations/runner.js`
- `tests/finance_operations_model_test.js`
- `tests/finance_integrity_contract_test.js`

### 3.3 Decision attendue apres audit

Produire une note courte avant code :

```text
Modules touches :
Routes touchees :
Services reutilises :
Migrations necessaires :
Tests a ajouter :
Risques :
Rollback :
```

---

## 4. Architecture cible a implementer

```text
backend/routes/integrations_dolibarr.js
  -> backend/services/dolibarr_integration.js
    -> backend/services/dolibarr_mapping.js
    -> backend/services/dolibarr_client.js
    -> backend/services/permissions.js
    -> backend/db.js
```

### 4.1 Regles de separation

| Couche | Responsabilite | Interdit |
|---|---|---|
| Route | Auth, permission, validation entree, reponse HTTP | Construire payload Dolibarr complexe |
| Integration service | Orchestration job, idempotence, statut | Connaitre le DOM/frontend |
| Mapping service | Traduction Tala SMI -> Dolibarr | Faire des appels HTTP |
| Client Dolibarr | HTTP, headers, timeout, erreurs | Lire directement les operations |
| Migration | Tables locales de sync | Modifier donnees metier existantes |

---

## 5. Lots d'implementation

## Lot 0 - Documentation et garde-fous

**Type** : non-destructif
**Risque** : faible
**Validation requise** : non

### Actions

1. Ajouter ce plan.
2. Ne pas ajouter de secret.
3. Confirmer que le PRD et le plan sont non suivis ou prets a commit.

### Preuves

- `git status --short --branch`
- `git diff --stat --no-index -- /dev/null PRD_integration_dolibarr.md`
- `git diff --stat --no-index -- /dev/null PLAN_integration_dolibarr.md`

---

## Lot 1 - Variables et configuration serveur

**Type** : non-destructif
**Risque** : faible
**Validation requise** : non pour `.env.example`, oui pour vraie cle API

### Actions

1. Ajouter a `.env.example` :

```text
DOLIBARR_ENABLED=false
DOLIBARR_BASE_URL=
DOLIBARR_API_KEY=
DOLIBARR_ENTITY_ID=
DOLIBARR_TIMEOUT_MS=10000
DOLIBARR_SYNC_MODE=manual
```

2. Ajouter un service de configuration qui :
   - lit uniquement `process.env` ;
   - refuse une URL vide quand le connecteur est active ;
   - refuse `http://` en production ;
   - masque la cle API dans toute sortie de diagnostic ;
   - refuse les cibles SSRF evidentes : localhost, 127.0.0.0/8, 169.254.169.254, metadata cloud, sauf mode local explicitement autorise.

### Tests

- config desactivee par defaut ;
- config active sans URL -> erreur controlee ;
- config active sans API key -> erreur controlee ;
- URL locale refusee hors developpement ;
- diagnostic ne contient pas la cle API.

### Rollback

- revert Git du diff `.env.example` et du service de config.

---

## Lot 2 - Migrations locales d'integration

**Type** : migration additive
**Risque** : faible a moyen
**Validation requise** : non si tables nouvelles uniquement ; oui avant production

### Actions

Ajouter une migration idempotente :

- `integration_links`
- `integration_jobs`
- `integration_attempts`

Contraintes :

- aucune modification de table metier existante ;
- aucun backfill ;
- index uniques sur idempotence ;
- timestamps ;
- champs erreurs sans secret.

### Tests

- migration runner passe ;
- migration relancee deux fois sans erreur ;
- contraintes uniques empechent doublon local ;
- rollback documente.

### Rollback

En preproduction/dev :

```sql
DROP TABLE integration_attempts;
DROP TABLE integration_jobs;
DROP TABLE integration_links;
```

En production : rollback destructif interdit sans sauvegarde DB et validation explicite.

---

## Lot 3 - Client API Dolibarr mockable

**Type** : non-destructif
**Risque** : faible
**Validation requise** : non

### Actions

Creer `backend/services/dolibarr_client.js`.

Responsabilites :

- construire URL `/api/index.php/<resource>` ;
- envoyer `DOLAPIKEY` cote serveur uniquement ;
- ajouter `DOLAPIENTITY` si configure ;
- timeout ;
- parser JSON ;
- normaliser erreurs `retryable`, `blocked`, `auth_failed`, `misconfigured` ;
- ne jamais logger header secret.

### Tests

- headers corrects en memoire ;
- secret absent des erreurs/logs ;
- 400 -> non retryable ;
- 401/403 -> auth/permission ;
- 408/429/500/502/503/504 -> retryable ;
- timeout -> retryable ;
- JSON invalide -> erreur controlee.

### Rollback

- revert fichier service + tests.

---

## Lot 4 - Mapping Tala SMI vers Dolibarr

**Type** : non-destructif
**Risque** : moyen, car erreurs metier possibles
**Validation requise** : oui metier pour champs obligatoires

### Actions

Creer `backend/services/dolibarr_mapping.js`.

Mappings V1 :

| Objet Tala SMI | Objet Dolibarr cible | Regle |
|---|---|---|
| Tiers client | Thirdparty customer | `client=1`, reference externe Tala |
| Tiers fournisseur | Thirdparty supplier | `fournisseur=1`, reference externe Tala |
| Encaissement valide | Payment/customer payment | seulement apres validation |
| Decaissement fournisseur paye | Supplier payment ou note/audit selon module actif | a valider |
| Facture client validee | Customer invoice | seulement si Tala SMI maitre facture |

### Tests

- tiers minimal valide ;
- tiers sans nom refuse ;
- paiement sans montant positif refuse ;
- operation non validee refusee ;
- external ref stable ;
- devise par defaut documentee.

### Rollback

- revert mapping + tests.

---

## Lot 5 - Service d'integration et idempotence

**Type** : non-destructif applicatif, ecrit dans nouvelles tables
**Risque** : moyen
**Validation requise** : non en mock ; oui avant Dolibarr reel

### Actions

Creer `backend/services/dolibarr_integration.js`.

Fonctions attendues :

- `getStatus()`
- `testConnection(actor)`
- `enqueueSync(localType, localId, jobType, actor)`
- `runJob(jobId, actor)`
- `retryJob(jobId, actor)`
- `findExistingLink(provider, localType, localId)`
- `recordAttempt(jobId, attempt)`

Regles :

- transaction locale autour du changement de statut job ;
- idempotency key stable ;
- si lien existe, ne pas recreer ;
- si erreur retryable, status `failed` ;
- si erreur mapping/auth, status `blocked` ;
- aucune suppression distante.

### Tests

- double enqueue -> un seul job ;
- double run avec lien existant -> pas de POST create ;
- timeout -> failed ;
- 400 -> blocked ;
- succes -> synced + integration_link ;
- tentative enregistree dans tous les cas.

### Rollback

- desactiver `DOLIBARR_ENABLED=false` ;
- revert service/routes/tests si non deploye ;
- en production, conserver tables d'audit sauf validation explicite de drop.

---

## Lot 6 - Routes backend securisees

**Type** : non-destructif
**Risque** : moyen
**Validation requise** : non si connecteur desactive par defaut

### Actions

Ajouter routeur :

- `GET /api/integrations/dolibarr/status`
- `POST /api/integrations/dolibarr/test`
- `GET /api/integrations/dolibarr/jobs`
- `POST /api/integrations/dolibarr/jobs/:id/retry`
- `GET /api/integrations/dolibarr/links/:type/:id`

Permissions :

- admin : config/test/retry ;
- finance : voir/retry metier ;
- audit : lecture seule ;
- caissier : pas de retry global.

### Tests

- anonyme refuse ;
- role non autorise refuse ;
- audit lecture seule ;
- admin autorise test ;
- finance autorise retry metier ;
- aucune reponse ne contient cle API.

### Rollback

- retirer montage routeur et fichiers associes par revert Git.

---

## Lot 7 - UI minimale

**Type** : frontend non destructif
**Risque** : moyen
**Validation requise** : oui UX/metier

### Actions

Ajouter dans Finance/Operations ou Admin/Integrations :

- badge statut Dolibarr ;
- file des jobs ;
- bouton retry ;
- lien distant si disponible ;
- detail erreur ;
- message clair si connecteur desactive.

Contraintes :

- aucun secret dans le DOM ;
- actions masquees selon permissions ;
- tailles stables ;
- responsive 320, 768, 1024, 1440 ;
- pas d'emoji.

### Tests

- static checks ;
- Playwright smoke si serveur disponible ;
- screenshots responsive si UI modifiee ;
- action non autorisee invisible ou desactivee et refusee backend.

### Rollback

- revert frontend + route UI.

---

## Lot 8 - Validation Dolibarr sandbox

**Type** : integration externe
**Risque** : moyen a eleve selon donnees sandbox
**Validation requise** : oui, obligatoire

### Actions

1. Configurer `.env` local/sandbox avec URL et cle API.
2. Appeler `/api/integrations/dolibarr/test`.
3. Synchroniser un tiers test.
4. Relancer le meme job pour prouver absence de doublon.
5. Simuler erreur reseau.
6. Simuler payload invalide.

### Preuves

- endpoint explorer Dolibarr confirme modules actifs ;
- logs sans secret ;
- `integration_links` contient un seul lien par objet ;
- `integration_attempts` contient chaque tentative ;
- screenshots UI statut.

### Rollback

- desactiver connecteur ;
- annuler/corriger manuellement dans sandbox Dolibarr ;
- conserver journaux comme preuve.

---

## 6. Tests de non-regression globaux

Apres implementation code :

```bash
npm test
```

Si trop long ou indisponible :

```bash
node tests/finance_integrity_contract_test.js
node tests/finance_operations_model_test.js
node tests/static_checks.js
node tests/migration_runner_test.js
```

Smoke checks attendus si serveur disponible :

- login ;
- dashboard ;
- operations list ;
- operation validee existante toujours lisible ;
- statut Dolibarr visible sans secret ;
- retry refuse si role non autorise.

---

## 7. Plan de rollback global

### Connecteur non active

Rollback simple par Git :

```bash
git revert <commit>
```

### Connecteur active sans donnees distantes creees

1. `DOLIBARR_ENABLED=false`
2. redemarrer uniquement le service applicatif cible selon procedure validee ;
3. verifier routes operations existantes ;
4. conserver tables d'integration.

### Donnees creees dans Dolibarr

1. ne pas supprimer automatiquement ;
2. exporter liste `integration_links` ;
3. faire validation Finance/Admin ;
4. corriger manuellement dans Dolibarr sandbox/production ;
5. garder `integration_attempts`.

---

## 8. Definition de preuve scientifique

La livraison doit demontrer :

- le PRD est respecte ;
- chaque flux a un test ;
- chaque statut a une transition explicite ;
- chaque erreur a une classification ;
- chaque creation distante a une cle d'idempotence ;
- chaque retry prouve l'absence de doublon ;
- chaque endpoint est protege par permission backend ;
- aucune cle API n'apparait dans code, logs, DOM ou reponses HTTP ;
- chaque table nouvelle a migration idempotente ;
- chaque action UI a son refus backend equivalent ;
- le rollback est executable et documente.

---

## 9. Ordre recommande des commits

1. `docs(dolibarr): add integration PRD and implementation plan`
2. `chore(dolibarr): add server-side configuration guard`
3. `feat(dolibarr): add integration persistence schema`
4. `feat(dolibarr): add mockable API client`
5. `feat(dolibarr): add mapping and idempotent sync service`
6. `feat(dolibarr): expose secured integration routes`
7. `feat(dolibarr): add integration status UI`
8. `test(dolibarr): add sandbox and retry coverage`

Chaque commit doit rester revertable seul.

---

## 10. Stop conditions

Arreter et demander validation si :

- l'URL Dolibarr pointe vers production sans sandbox ;
- la cle API fournie appartient a un superadmin non dedie ;
- Dolibarr n'a pas les modules requis actifs ;
- une operation necessite suppression ou correction de donnees reelles ;
- le mapping facture/paiement est ambigu ;
- un test montre une creation doublon ;
- un secret apparait dans un log ou une reponse ;
- une migration doit modifier une table metier existante.
