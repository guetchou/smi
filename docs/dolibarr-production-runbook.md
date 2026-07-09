# Runbook production - Integration Dolibarr

**Date** : 2026-07-09  
**Perimetre** : deploiement controle du connecteur Tala SMI -> Dolibarr  
**Statut** : procedure prete, execution production non realisee  
**Decision metier** : Dolibarr est maitre facture

## 1. Principe de deploiement

Le deploiement doit etre progressif :

1. deployer le code avec `DOLIBARR_ENABLED=false` ;
2. appliquer uniquement les migrations additives ;
3. verifier que Tala SMI fonctionne sans connecteur actif ;
4. configurer l'URL Dolibarr et la cle API dediee ;
5. tester `/api/integrations/dolibarr/status` ;
6. tester `/api/integrations/dolibarr/test` ;
7. activer progressivement sur sandbox/preproduction ;
8. activer production seulement apres validation Finance/Admin.

Aucune suppression distante Dolibarr n'est automatisee.

## 2. Prerequis obligatoires

| Prerequis | Responsable | Statut attendu |
|---|---|---|
| URL Dolibarr production | Admin technique | HTTPS obligatoire |
| Version Dolibarr | Admin technique | Documentee |
| Modules Dolibarr | Admin/Finance | API, tiers, banque/caisse, fournisseurs, paiements |
| Compte API dedie | Admin Dolibarr | Pas un compte humain admin |
| Cle API | Admin Dolibarr | Stockee dans `.env`, jamais dans Git |
| Compte banque/caisse | Finance | `DOLIBARR_BANK_ACCOUNT_ID` valide |
| Sauvegarde DB Tala | Admin technique | Dump verifie avant migration |
| Fenetre de maintenance | Admin/Direction | Validee si service critique |

## 3. Variables production

Fichier `.env` serveur uniquement :

```text
DOLIBARR_ENABLED=false
DOLIBARR_BASE_URL=https://dolibarr.example.tld
DOLIBARR_API_KEY=<cle_api_compte_dedie>
DOLIBARR_ENTITY_ID=
DOLIBARR_BANK_ACCOUNT_ID=<id_compte_banque_ou_caisse>
DOLIBARR_TIMEOUT_MS=10000
DOLIBARR_SYNC_MODE=manual
```

Interdits en production :

```text
DOLIBARR_ALLOW_LOCAL=true
DOLIBARR_BASE_URL=http://...
```

## 4. Sauvegarde avant migration

Sauvegarde logique minimale de la DB Tala SMI avant activation :

```bash
mysqldump --single-transaction --routines --triggers \
  -h "$MYSQL_HOST" -P "$MYSQL_PORT" -u "$MYSQL_USER" -p"$MYSQL_PASSWORD" \
  "$MYSQL_DATABASE" > "/backup/tala_smi_before_dolibarr_$(date +%Y%m%d_%H%M%S).sql"
```

Verifier :

```bash
test -s /backup/tala_smi_before_dolibarr_YYYYMMDD_HHMMSS.sql
sha256sum /backup/tala_smi_before_dolibarr_YYYYMMDD_HHMMSS.sql
```

Si la sauvegarde echoue ou si l'espace disque est insuffisant, arreter le
deploiement.

## 5. Migration

La migration Dolibarr V1 est additive :

- creation `integration_links` ;
- creation `integration_jobs` ;
- creation `integration_attempts` ;
- index d'idempotence ;
- aucun backfill ;
- aucune modification destructive de donnees metier.

Procedure :

```bash
DOLIBARR_ENABLED=false npm test
```

Puis deploiement applicatif selon procedure habituelle du projet.

## 6. Smoke checks apres deploiement code

Connecteur encore desactive :

```bash
curl -sS http://127.0.0.1:3337/api/health
```

Verifier dans l'UI :

- login ;
- dashboard ;
- operations lisibles ;
- decaissement existant lisible ;
- encaissement existant lisible.

Verifier que le statut integration affiche `enabled=false` tant que `.env` n'est
pas active.

## 7. Activation controlee

Apres validation Admin/Finance :

1. renseigner `.env` production ;
2. garder `DOLIBARR_ENABLED=false` ;
3. redemarrer uniquement le service Tala SMI cible ;
4. tester la configuration avec utilisateur admin/finance ;
5. passer `DOLIBARR_ENABLED=true` seulement apres test.

Checks API :

```bash
GET /api/integrations/dolibarr/status
POST /api/integrations/dolibarr/test
```

Les reponses ne doivent jamais contenir la cle API.

## 8. Verification fonctionnelle production

Premier test production : utiliser une operation reelle eligible uniquement apres
validation Finance.

Verifier :

- un seul job dans `integration_jobs` ;
- deux tentatives maximum pour un flux complet tiers + ligne bancaire ;
- un lien tiers dans `integration_links` ;
- un lien operation dans `integration_links` ;
- objet Dolibarr visible cote ERP ;
- aucun doublon apres retry.

SQL local de controle Tala :

```sql
SELECT * FROM integration_jobs ORDER BY id DESC LIMIT 10;
SELECT * FROM integration_links ORDER BY id DESC LIMIT 10;
SELECT * FROM integration_attempts ORDER BY id DESC LIMIT 20;
```

## 9. Rollback

Rollback fonctionnel immediat :

```text
DOLIBARR_ENABLED=false
DOLIBARR_SYNC_MODE=disabled
```

Puis redemarrer uniquement le service Tala SMI cible.

Ne pas supprimer automatiquement les objets Dolibarr deja crees. Procedure :

1. exporter `integration_links` ;
2. identifier les objets distants ;
3. faire valider Finance/Admin ;
4. corriger manuellement dans Dolibarr si necessaire ;
5. conserver `integration_attempts` comme preuve.

Rollback DB destructif interdit sans validation explicite. Les tables
`integration_*` peuvent rester en base meme connecteur desactive.

## 10. Stop conditions production

Arreter le deploiement si :

- URL Dolibarr non HTTPS ;
- API key appartient a un superadmin humain ;
- `DOLIBARR_BANK_ACCOUNT_ID` non valide par Finance ;
- modules API/tiers/banque non actifs ;
- sauvegarde DB absente ou non verifiee ;
- `/test` retourne 401/403 ;
- un secret apparait dans reponse HTTP, DOM, logs ou rapport ;
- un retry cree un doublon ;
- une correction necessite suppression de donnees reelles.

## 11. Commandes de preuve

Sandbox/preproduction :

```bash
node scripts/dolibarr_lot_runner.js
```

Rapport local :

```text
reports/dolibarr_sandbox_verification_YYYYMMDD_HHMMSS.md
```

Les rapports sont ignores par Git.

## 12. Commits et PR

Decoupage recommande :

1. `docs(dolibarr): add PRD and implementation plan`
2. `chore(dolibarr): add sandbox compose and env configuration`
3. `feat(dolibarr): add integration schema and services`
4. `feat(dolibarr): enqueue operation sync from treasury workflows`
5. `feat(dolibarr): expose secured integration routes and dashboard UI`
6. `test(dolibarr): add sandbox E2E proofs and verification runner`
7. `docs(dolibarr): add security audit and production runbook`

PR doit inclure :

- decision Dolibarr maitre facture ;
- preuves sandbox ;
- commandes executees ;
- rollback ;
- risques residuels ;
- confirmation qu'aucun secret n'est versionne.
