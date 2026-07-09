# Audit securite final - Integration Dolibarr

**Date** : 2026-07-09  
**Perimetre** : connecteur Tala SMI -> Dolibarr V1  
**Statut** : pret pour revue PR, non deploye en production  
**Decision metier** : Dolibarr est maitre facture

## 1. Synthese

Le connecteur Dolibarr respecte le principe V1 defini dans le PRD : Tala SMI
reste maitre des workflows tresorerie, validation, paiement et audit ; Dolibarr
recoit les tiers et mouvements financiers eligibles par API REST.

Les factures client ne sont pas creees depuis Tala SMI en V1, car Dolibarr est
maitre facture. Le connecteur ne doit donc pas generer de facture client distante
tant que cette decision reste active.

## 2. Surface exposee

Routes backend ajoutees :

- `GET /api/integrations/dolibarr/status`
- `POST /api/integrations/dolibarr/test`
- `GET /api/integrations/dolibarr/jobs`
- `POST /api/integrations/dolibarr/jobs/:id/retry`
- `GET /api/integrations/dolibarr/links/:type/:id`

Services serveur :

- `backend/services/dolibarr_config.js`
- `backend/services/dolibarr_client.js`
- `backend/services/dolibarr_mapping.js`
- `backend/services/dolibarr_integration.js`

Tables locales :

- `integration_links`
- `integration_jobs`
- `integration_attempts`

## 3. OWASP Top 10 - Controle final

| Risque | Controle applique | Statut |
|---|---|---|
| A1 Broken Access Control | Routes protegees par `protectedRoute`; lecture limitee admin/finance/dg/audit, retry limite admin/finance/settings.manage | Conforme V1 |
| A2 Cryptographic Failures | Cle API lue depuis `.env` serveur uniquement ; `.env` ignore ; reponses publiques masquent la cle | Conforme V1 |
| A3 Injection | Pas de SQL dynamique utilisateur pour endpoints integration ; parametres DB passes via placeholders | Conforme V1 |
| A4 Insecure Design | Source de verite documentee ; idempotence via `integration_links`; retry controle | Conforme V1 |
| A5 Security Misconfiguration | Connecteur desactive par defaut ; HTTPS requis en production ; localhost bloque sauf `DOLIBARR_ALLOW_LOCAL=true` | Conforme V1 |
| A6 Vulnerable Components | Dolibarr sandbox version pinnee `22.0.5-php8.2`; dependances existantes testees par `npm test` | A surveiller |
| A7 Auth Failures | Aucun appel Dolibarr depuis frontend ; endpoint retry exige utilisateur authentifie | Conforme V1 |
| A8 Data Integrity Failures | Idempotency key stable ; double retry sur job `synced` refuse ; pas de suppression distante | Conforme V1 |
| A9 Logging Monitoring Failures | `integration_attempts` journalise chaque appel sans secret ; erreurs visibles dans jobs | Conforme V1 |
| A10 SSRF | Validation URL bloque localhost/metadata par defaut ; local autorise seulement pour sandbox explicite | Conforme V1 |

## 4. Secrets et donnees sensibles

Regles appliquees :

- `DOLIBARR_API_KEY` absent du frontend.
- `DOLIBARR_API_KEY` absent des reponses HTTP.
- `DOLIBARR_API_KEY` absent des rapports du runner.
- `.env` ignore par `.gitignore`.
- `reports/` ignore par `.gitignore`.
- Les tests utilisent uniquement des valeurs factices comme `test-api-key`.

Commande de verification recommandee avant PR :

```bash
rg -n "(DOLIBARR_API_KEY|DOLIBARR_SANDBOX_DB_PASSWORD|MARIADB_PASSWORD|MYSQL_PASSWORD|JWT_SECRET)" \
  --glob '!.env' --glob '!backend/node_modules/**' --glob '!reports/**' .
```

Les occurrences attendues doivent etre des placeholders, noms de variables ou
secrets de test non reutilisables.

## 5. Roles et permissions

Lecture integration :

- admin
- finance
- dg
- permission `audit.view`

Gestion/test/retry :

- admin
- finance
- permission `settings.manage`

Caissier :

- ne gere pas la file globale d'integration ;
- declenche indirectement un job uniquement via workflow metier eligible.

## 6. Flux eligibles V1

Eligibles :

- decaissement fournisseur paye ;
- encaissement client confirme ;
- tiers fournisseur associe ;
- tiers client associe ;
- ligne banque/caisse Dolibarr.

Non eligibles V1 :

- facture client creee depuis Tala SMI ;
- synchronisation bidirectionnelle complete ;
- suppression distante ;
- correction automatique de donnees Dolibarr ;
- RH, paie, pointage.

## 7. Preuves executees

Commande complete :

```bash
node scripts/dolibarr_lot_runner.js
```

Elle verifie :

- audit environnement ;
- preparation sandbox Dolibarr ;
- paiement fournisseur service-layer ;
- decaissement HTTP complet ;
- encaissement HTTP complet ;
- tests unitaires Dolibarr ;
- lecture SQL sandbox ;
- `npm test`.

Le dernier rapport local est genere dans `reports/` et n'est pas versionne.

## 8. Risques residuels

| Risque | Impact | Mitigation |
|---|---|---|
| Cle API trop privilegiee | Creation/modification excessive dans Dolibarr | Utilisateur API dedie, droits limites, rotation avant production |
| Mauvais compte banque/caisse | Mouvements dans mauvais journal Dolibarr | Verifier `DOLIBARR_BANK_ACCOUNT_ID` avec Finance avant activation |
| URL production mal configuree | Envoi de donnees test vers prod | `DOLIBARR_ENABLED=false` par defaut, test manuel `/status` puis `/test` |
| Retry production mal utilise | Multiplication tentatives visibles | Idempotence locale ; job `synced` non relancable |
| Divergence facture | Facture non creee par Tala | Decision assumee : Dolibarr maitre facture |

## 9. Conclusion

Le connecteur est acceptable pour PR et validation sandbox. La production requiert
encore validation explicite de l'URL Dolibarr, du compte API dedie, du compte
banque/caisse cible et d'une sauvegarde DB Tala SMI avant migration.
