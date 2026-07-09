# PRD - Integration Dolibarr avec Tala SMI

**Date** : 2026-07-08
**Statut** : PRD fonctionnel et technique initial
**Portee** : Integration ERP/API entre Tala SMI et Dolibarr
**Profil requis** : Lead Backend / ERP Integration Engineer

---

## 1. Executive summary

Tala SMI possede deja des workflows critiques pour les operations, la tresorerie, la comptabilite OHADA, les achats, les ventes, la paie, les agents et le controle d'acces ERP. L'integration Dolibarr ne doit pas remplacer ces workflows ni creer un second chemin metier parallele.

L'objectif est de connecter Tala SMI a Dolibarr par API REST, avec une synchronisation controlee, idempotente, auditable et reversible au niveau fonctionnel. L'ecriture directe dans la base Dolibarr est interdite car elle contourne les regles metier et expose les donnees a la corruption lors des upgrades.

La V1 doit couvrir un perimetre reduit mais complet : tiers, documents commerciaux selectionnes, paiements/encaissements valides, references externes, statuts de synchronisation, journal d'erreurs, retry manuel et preuve de non-doublon.

---

## 2. Probleme a resoudre

Sans contrat d'integration explicite, connecter Tala SMI a Dolibarr cree des risques majeurs :

- doublons de tiers, factures, paiements ou references externes ;
- operations validees dans Tala SMI mais absentes de Dolibarr ;
- documents crees dans Dolibarr sans lien avec le workflow Tala SMI ;
- paiement exporte plusieurs fois apres retry ;
- divergence entre solde de tresorerie Tala SMI et statut comptable Dolibarr ;
- exposition de cle API dans le code, les logs ou le frontend ;
- absence de rollback fonctionnel si Dolibarr accepte partiellement une operation ;
- confusion entre systeme maitre et systeme recepteur ;
- dette de synchronisation non visible par les utilisateurs.

Le besoin n'est donc pas seulement "appeler l'API Dolibarr". Le besoin est d'etablir une integration industrielle avec source de verite, mappings, statuts, controles, audit, erreurs, reprise et tests.

---

## 3. Comparaison avec les ERP industriels

Les solutions industrielles de type Dolibarr, Odoo, ERPNext ou Sage appliquent les memes principes :

- un objet metier possede un cycle de vie explicite ;
- chaque acteur a des droits limites ;
- une operation financiere validee n'est pas supprimee mais corrigee par annulation controlee ou contrepassation ;
- les ecritures sensibles sont tracees ;
- les integrations passent par API, webhooks ou connecteurs, pas par modification directe des tables ;
- les imports/exports sont idempotents ;
- les erreurs d'integration sont visibles dans une file de travail ;
- les secrets restent cote serveur ;
- les modules finances/comptabilite/tresorerie ont des statuts separes.

Tala SMI doit adopter ce niveau de controle : l'integration Dolibarr doit etre un connecteur auditable autour des workflows existants, pas une duplication de logique metier.

---

## 4. Objectifs

### 4.1 Objectif principal

Synchroniser les donnees selectionnees entre Tala SMI et Dolibarr en garantissant :

```text
Workflow Tala SMI valide
-> controle d'eligibilite
-> mapping Dolibarr
-> appel API REST
-> stockage de l'identifiant Dolibarr
-> journal d'audit
-> statut visible
-> retry controle en cas d'echec
```

### 4.2 Objectifs specifiques

1. Definir clairement quel systeme est maitre pour chaque donnee.
2. Empecher les doublons lors des retries.
3. Ne synchroniser que les operations ayant atteint un statut metier eligible.
4. Journaliser chaque tentative d'appel Dolibarr.
5. Rendre les erreurs visibles et exploitables par Finance/Admin.
6. Proteger les secrets d'API.
7. Preserver les workflows Tala SMI : approbation, paiement, tresorerie, comptabilite, audit.
8. Permettre une extension future vers webhooks Dolibarr ou synchronisation bidirectionnelle limitee.

---

## 5. Perimetre V1

### 5.1 Inclus

| Domaine | Inclus V1 | Sens |
|---|---:|---|
| Configuration Dolibarr serveur | Oui | Tala SMI -> Dolibarr |
| Test connexion API | Oui | Tala SMI -> Dolibarr |
| Tiers clients/fournisseurs | Oui | Tala SMI -> Dolibarr |
| Factures clients validees | Oui, si module facture actif | Tala SMI -> Dolibarr |
| Paiements/encaissements valides | Oui | Tala SMI -> Dolibarr |
| Decaissements fournisseurs payes | Oui, selon mapping | Tala SMI -> Dolibarr |
| References externes | Oui | Tala SMI -> Dolibarr |
| Statut de synchronisation | Oui | Interne Tala SMI |
| Journal d'integration | Oui | Interne Tala SMI |
| Retry manuel | Oui | Interne Tala SMI |
| Audit utilisateur | Oui | Interne Tala SMI |

### 5.2 Hors perimetre V1

| Domaine | Statut |
|---|---|
| Remplacement de Tala SMI par Dolibarr | Hors perimetre |
| Ecriture directe dans la base Dolibarr | Interdit |
| Synchronisation bidirectionnelle complete | Hors perimetre |
| Synchronisation RH, salaires et pointage | Hors perimetre V1 |
| Import massif historique sans validation metier | Hors perimetre V1 |
| Modification de firewall, DNS, certificats ou reverse proxy | Hors perimetre |
| Comptabilite generale complete pilotee par Dolibarr | Decision metier separee |
| Suppression automatique cote Dolibarr | Interdit en V1 |

---

## 6. Acteurs

| Acteur | Role dans l'integration |
|---|---|
| Admin technique | Configure URL Dolibarr, cle API, timeouts, activation connecteur |
| Responsable finance | Valide les objets eligibles a synchroniser, surveille erreurs |
| Comptable | Controle les mappings tiers/factures/paiements |
| Caissier | Ne declenche pas directement la synchronisation Dolibarr sauf permission explicite |
| Auditeur | Consulte les journaux, erreurs et preuves de synchronisation |
| Systeme Tala SMI | Source de workflows et de controles metier |
| Systeme Dolibarr | Receveur ERP/commercial/comptable selon modules actifs |

---

## 7. Source de verite

| Donnee | Source de verite V1 | Justification |
|---|---|---|
| Workflow d'approbation operation | Tala SMI | Deja central dans operations/tresorerie |
| Droits utilisateurs Tala SMI | Tala SMI | Modele ERP local existant |
| Tiers cree depuis operation Tala SMI | Tala SMI au depart, Dolibarr recoit copie | Eviter creation manuelle incoherente |
| Identifiant Dolibarr du tiers | Dolibarr | Reference externe officielle apres creation/recherche |
| Facture client issue de Tala SMI | Tala SMI jusqu'a export, Dolibarr pour reference externe | V1 unidirectionnelle |
| Paiement/encaissement valide Tala SMI | Tala SMI | Impact tresorerie deja controle |
| Statut de synchronisation | Tala SMI | File de travail interne |
| Comptes OHADA Tala SMI | Tala SMI | Mappings existants a preserver |

Regle : aucun objet exporte ne doit perdre son identifiant Tala SMI. Aucun objet Dolibarr cree par Tala SMI ne doit rester sans `external_ref` ou lien d'integration local.

---

## 8. Architecture cible

```text
Frontend Tala SMI
  -> routes backend existantes
    -> services metier Tala SMI
      -> DolibarrIntegrationService
        -> DolibarrApiClient
          -> API REST Dolibarr

DolibarrIntegrationService
  -> table integration_jobs
  -> table integration_links
  -> table integration_attempts
  -> audit logs Tala SMI
```

### 8.1 Services backend attendus

- `DolibarrApiClient` : client HTTP REST, headers, timeouts, parsing erreurs.
- `DolibarrIntegrationService` : orchestration metier, idempotence, mapping, retry.
- `DolibarrMappingService` : conversion Tala SMI -> payload Dolibarr.
- `DolibarrSyncAuditService` : journalisation lisible par Admin/Finance/Audit.

### 8.2 Endpoints Tala SMI attendus

| Endpoint | Role | Permission |
|---|---|---|
| `GET /api/integrations/dolibarr/status` | Etat connecteur | admin/finance/audit |
| `POST /api/integrations/dolibarr/test` | Test connexion API | admin |
| `GET /api/integrations/dolibarr/jobs` | Liste file sync | admin/finance/audit |
| `POST /api/integrations/dolibarr/jobs/:id/retry` | Relancer un echec | admin/finance |
| `GET /api/integrations/dolibarr/links/:type/:id` | Voir lien externe | admin/finance/audit |

Les routes d'operations ne doivent pas contenir directement le code HTTP Dolibarr.

---

## 9. Modele de donnees propose

### 9.1 `integration_links`

Associe un objet Tala SMI a son objet Dolibarr.

```sql
CREATE TABLE integration_links (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  provider VARCHAR(50) NOT NULL,
  local_type VARCHAR(80) NOT NULL,
  local_id BIGINT NOT NULL,
  remote_type VARCHAR(80) NOT NULL,
  remote_id VARCHAR(120) NOT NULL,
  remote_ref VARCHAR(160),
  idempotency_key VARCHAR(180) NOT NULL,
  created_by BIGINT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_provider_local (provider, local_type, local_id),
  UNIQUE KEY uq_provider_idempotency (provider, idempotency_key)
);
```

### 9.2 `integration_jobs`

File de synchronisation visible et relancable.

```sql
CREATE TABLE integration_jobs (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  provider VARCHAR(50) NOT NULL,
  job_type VARCHAR(80) NOT NULL,
  local_type VARCHAR(80) NOT NULL,
  local_id BIGINT NOT NULL,
  status ENUM('pending','running','synced','failed','retrying','cancelled','blocked') NOT NULL DEFAULT 'pending',
  attempts_count INT NOT NULL DEFAULT 0,
  next_retry_at DATETIME,
  last_error_code VARCHAR(120),
  last_error_message TEXT,
  created_by BIGINT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_provider_job_object (provider, job_type, local_type, local_id)
);
```

### 9.3 `integration_attempts`

Journal technique detaille sans secret.

```sql
CREATE TABLE integration_attempts (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  job_id BIGINT NOT NULL,
  provider VARCHAR(50) NOT NULL,
  method VARCHAR(10) NOT NULL,
  endpoint VARCHAR(255) NOT NULL,
  request_hash VARCHAR(128),
  response_status INT,
  success TINYINT(1) NOT NULL DEFAULT 0,
  error_code VARCHAR(120),
  error_message TEXT,
  duration_ms INT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

---

## 10. Regles fonctionnelles obligatoires

### 10.1 Eligibilite

- Un brouillon Tala SMI ne doit jamais etre envoye a Dolibarr.
- Une operation rejetee, annulee ou en litige ne doit pas etre exportee comme paiement valide.
- Un paiement doit etre valide/paye avant export.
- Une operation deja synchronisee ne doit pas etre recreee.
- Une correction post-validation doit produire un job separe, jamais modifier silencieusement l'objet distant.

### 10.2 Idempotence

Chaque export doit avoir une cle stable :

```text
provider + local_type + local_id + job_type
```

Avant tout `POST` create vers Dolibarr :

1. chercher un `integration_link` existant ;
2. chercher par reference externe si Dolibarr le permet ;
3. creer seulement si aucun lien fiable n'existe ;
4. enregistrer l'identifiant Dolibarr dans la meme transaction locale que le statut de job.

### 10.3 Erreurs et reprise

- Timeout reseau : job `failed`, retry possible.
- Erreur 4xx Dolibarr : job `blocked` si payload invalide ou permission manquante.
- Erreur 5xx Dolibarr : job `failed`, retry possible.
- Reponse partielle : rechercher l'objet Dolibarr par reference avant toute nouvelle creation.
- Secret ou cle invalide : connecteur `disabled` jusqu'a correction admin.

### 10.4 Audit

Chaque tentative doit tracer :

- utilisateur declencheur ou systeme ;
- objet local ;
- endpoint appele ;
- statut HTTP ;
- duree ;
- resultat ;
- message d'erreur nettoye ;
- lien Dolibarr cree ou reutilise.

Les logs ne doivent jamais contenir `DOLAPIKEY`, mot de passe, token JWT, contenu `.env` ou secret SMTP.

---

## 11. Securite OWASP

| Risque OWASP | Controle exige |
|---|---|
| A1 Broken Access Control | Permissions backend sur chaque endpoint integration |
| A2 Cryptographic Failures | Cle API en `.env`, jamais frontend/code/log |
| A3 Injection | Payloads construits par objets, pas concatenation SQL |
| A4 Insecure Design | Source de verite et idempotence obligatoires |
| A5 Security Misconfiguration | Connecteur desactive si URL/API key absente |
| A6 Vulnerable Components | `npm audit` avant livraison implementation |
| A7 Authentication Failures | Aucun appel Dolibarr depuis navigateur |
| A8 Data Integrity Failures | Liens uniques, jobs uniques, transactions locales |
| A9 Logging Monitoring Failures | Journal consultable et alertes erreurs |
| A10 SSRF | URL Dolibarr whitelist/config admin, refuser localhost/metadatas sauf environnement local valide |

---

## 12. Configuration attendue

Variables serveur uniquement :

```text
DOLIBARR_ENABLED=false
DOLIBARR_BASE_URL=https://dolibarr.example.com
DOLIBARR_API_KEY=...
DOLIBARR_ENTITY_ID=
DOLIBARR_TIMEOUT_MS=10000
DOLIBARR_SYNC_MODE=manual
```

Contraintes :

- `DOLIBARR_BASE_URL` doit etre HTTPS en production.
- `DOLIBARR_API_KEY` ne doit jamais etre exposee au frontend.
- Le compte API Dolibarr doit avoir uniquement les droits necessaires aux modules actives.
- Le mode initial doit etre `manual` pour eviter les exports automatiques non valides.

---

## 13. Workflow V1

### 13.1 Export manuel d'une operation eligible

```text
Finance ouvre operation validee
-> clique Synchroniser Dolibarr
-> backend verifie permission
-> backend verifie eligibilite
-> creation/reutilisation tiers Dolibarr
-> creation/reutilisation document/paiement Dolibarr
-> integration_link enregistre
-> operation affiche statut synced
```

### 13.2 Echec reseau

```text
Operation eligible
-> appel Dolibarr timeout
-> integration_attempt enregistre failed
-> integration_job status failed
-> UI affiche "Erreur reseau - Reessayer"
-> Finance/Admin peut relancer
-> avant nouveau POST, service recherche lien/reference distante
```

### 13.3 Payload invalide

```text
Operation eligible
-> Dolibarr retourne 400
-> job blocked
-> UI affiche erreur metier
-> correction mapping/configuration requise
-> retry interdit tant que blocage non resolu
```

---

## 14. UI minimale attendue

Dans l'espace Finance/Operations ou Admin/Integrations :

- badge `Dolibarr : non configure | pret | en erreur | synchronise` ;
- action `Synchroniser Dolibarr` uniquement si eligible et autorisee ;
- action `Reessayer` uniquement sur erreur relancable ;
- lien vers objet Dolibarr si `remote_ref` disponible ;
- drawer ou modal de detail avec tentatives, erreurs et payload resume ;
- filtres : pending, failed, blocked, synced ;
- aucun secret affiche.

---

## 15. Criteres d'acceptation

1. Un objet deja synchronise ne peut pas etre cree une deuxieme fois dans Dolibarr.
2. Un utilisateur sans permission ne peut pas declencher ni relancer une synchronisation.
3. Une operation non validee ne peut pas etre exportee.
4. Une erreur reseau laisse une trace et permet un retry.
5. Une erreur de mapping bloque le job avec un message exploitable.
6. Chaque tentative est visible en audit.
7. Le code ne contient aucune cle API Dolibarr en dur.
8. Le frontend ne recoit jamais la cle API.
9. Les tests prouvent l'idempotence et la gestion d'erreur.
10. Le connecteur peut etre desactive sans casser les workflows Tala SMI.

---

## 16. Tests obligatoires

### 16.1 Tests unitaires

- mapping tiers Tala SMI -> Dolibarr ;
- mapping paiement/encaissement -> Dolibarr ;
- construction headers sans fuite secret ;
- validation URL Dolibarr ;
- classification erreur retryable/non retryable.

### 16.2 Tests d'integration avec mock Dolibarr

- creation tiers puis paiement ;
- retry apres timeout sans doublon ;
- 400 Dolibarr -> job blocked ;
- 401/403 Dolibarr -> erreur configuration/permission ;
- 500 Dolibarr -> failed relancable ;
- lien existant -> aucune creation distante.

### 16.3 Tests de contrat Tala SMI

- permissions backend ;
- operation brouillon refusee ;
- operation validee acceptee ;
- operation deja synchronisee stable ;
- audit attempts cree ;
- UI masque actions non autorisees.

---

## 17. Plan d'implementation propose

### Phase 0 - Validation metier

- Confirmer URL Dolibarr, version, modules actifs et environnement de test.
- Confirmer les objets V1 : tiers, factures, paiements, decaissements.
- Confirmer le systeme maitre par donnee.

### Phase 1 - Socle technique non destructif

- Ajouter variables `.env.example`.
- Ajouter migrations `integration_links`, `integration_jobs`, `integration_attempts`.
- Ajouter client API Dolibarr mockable.
- Ajouter tests unitaires sans appel reseau reel.

### Phase 2 - Synchronisation manuelle

- Ajouter service de sync tiers.
- Ajouter service de sync paiement/operation.
- Ajouter endpoints admin/finance.
- Ajouter UI minimale statut/retry.

### Phase 3 - Durcissement

- Ajouter file de retry controlee.
- Ajouter monitoring erreurs.
- Ajouter audit lisible.
- Ajouter documentation exploitation.

### Phase 4 - Extension optionnelle

- Webhooks Dolibarr vers Tala SMI.
- Sync bidirectionnelle limitee, seulement apres arbitrage metier.
- Export historique par lots avec dry-run.

---

## 18. Rollback fonctionnel

Le rollback technique local doit passer par Git et migrations inverses si elles sont ajoutees dans une phase ulterieure.

Pour les objets deja crees dans Dolibarr, le rollback ne doit pas supprimer automatiquement. La procedure V1 est :

1. desactiver le connecteur `DOLIBARR_ENABLED=false` ;
2. marquer les jobs concernes `cancelled` ou `blocked` selon cas ;
3. documenter les references Dolibarr creees ;
4. corriger dans Dolibarr manuellement selon les droits Finance/Admin ;
5. conserver les `integration_attempts` comme preuve.

Aucune suppression distante automatique n'est autorisee en V1.

---

## 19. Preuves attendues avant livraison

Une livraison implementation ne sera acceptable que si le rapport demontre :

- liste des modules Tala SMI touches ;
- liste des endpoints Dolibarr utilises ;
- table de mapping champs Tala SMI -> champs Dolibarr ;
- resultats tests unitaires et integration mock ;
- preuve qu'aucun secret n'est expose ;
- preuve que retry ne cree pas de doublon ;
- preuve que les permissions backend refusent les utilisateurs non autorises ;
- preuve que les workflows existants restent fonctionnels ;
- diff Git complet ;
- rollback documente.

---

## 20. Questions ouvertes a valider avant code

1. Quelle est l'URL de l'instance Dolibarr de test ?
2. Quelle est la version Dolibarr ?
3. Quels modules Dolibarr sont actifs : tiers, factures, produits, paiements, comptabilite ?
4. Dolibarr doit-il recevoir seulement les objets valides ou aussi les brouillons commerciaux ?
5. Les factures sont-elles creees dans Tala SMI, dans Dolibarr, ou dans les deux ?
6. Quelle regle de numerotation doit dominer en cas d'export facture ?
7. Les paiements fournisseurs doivent-ils creer des paiements Dolibarr ou seulement des notes/audits ?
8. Le plan comptable OHADA doit-il rester dans Tala SMI ou etre mappe vers Dolibarr ?
9. Qui peut relancer une synchronisation bloquee ?
10. Faut-il un environnement sandbox Dolibarr obligatoire avant production ?

---

## 21. Definition of done

L'integration Dolibarr sera consideree livrable seulement quand :

- le connecteur fonctionne en mode manuel sans casser les workflows Tala SMI ;
- chaque objet synchronise possede un lien local et distant ;
- les erreurs sont visibles et relancables selon leur type ;
- aucun doublon n'est cree apres retry ;
- les permissions sont appliquees cote backend ;
- les secrets restent cote serveur ;
- les tests couvrent succes, echec, retry, permission et idempotence ;
- le rapport final prouve que les branchements metier, workflow, synchronisation et audit ne sont pas incomplets.
