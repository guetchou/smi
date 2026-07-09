# Runbook sandbox Dolibarr pour integration Tala SMI

**Date** : 2026-07-08  
**Statut** : sandbox installee et API locale validee  
**Base** : `PRD_integration_dolibarr.md` et `PLAN_integration_dolibarr.md`

## 1. Decision immediate

Dolibarr est installe en sandbox locale isolee sur `127.0.0.1:18080`.
Le port `8080` etait occupe par Nginx au moment de l'audit et n'a pas ete
modifie.

La sandbox est branchee a Tala SMI via `.env` local avec `DOLIBARR_ENABLED=true`,
`DOLIBARR_SYNC_MODE=manual` et une cle API temporaire portee par le compte
technique `smi_api`. Cette cle devra etre remplacee apres validation metier et
durcissement des droits Dolibarr.

## 2. Etat observe

Ports deja occupes :

- `80` : Apache
- `8080`, `8081` : Nginx
- `9000`, `9443` : Portainer
- `3307` : MySQL Docker existant `caisse-mysql`
- `3337` : port applicatif Tala SMI reserve par `docker-compose.yml`

Conteneurs actifs observes :

- `caisse-mysql` : MySQL 8, donnees Tala SMI
- `portainer` : console d'administration Docker

Regle : ne pas ajouter Dolibarr dans le `docker-compose.yml` de production Tala
SMI tant que la sandbox n'a pas ete validee. Utiliser un fichier compose separe.

## 3. Comparaison industrielle

Une integration ERP industrielle ne connecte pas une application metier a une
instance ERP non qualifiee. Odoo, ERPNext, Sage et Dolibarr suivent la meme
logique operationnelle :

- environnement sandbox separe de la production ;
- modules actifs documentes avant mapping ;
- utilisateur API dedie avec droits limites ;
- donnees test identifiables et supprimables manuellement ;
- journal des tentatives et preuves d'idempotence ;
- aucun secret dans le frontend, le code source ou les logs applicatifs.

Tala SMI doit donc valider Dolibarr comme receveur ERP avant toute synchronisation
reelle.

## 4. Prerequis a valider avant installation

| Point | Decision attendue | Pourquoi |
|---|---|---|
| Port HTTP sandbox | `127.0.0.1:18080` retenu | Evite conflit avec `80`, `8080`, `8081` |
| Base Dolibarr | Conteneur DB dedie recommande | Ne jamais melanger avec `caisse-mysql` |
| Exposition publique | Non par defaut | Evite exposition d'une sandbox non durcie |
| Version Dolibarr | `dolibarr/dolibarr:22.0.5-php8.2` | Evite `latest` non reproductible |
| Modules Dolibarr | Tiers, factures, paiements, banque/caisse | Necessaires au PRD V1 |
| Compte API | `smi_api`, cle temporaire | Audit dedie ; droits a durcir apres validation |
| Donnees test | Prefixe `TALA-SANDBOX-*` | Nettoyage manuel et tracabilite |

## 5. Architecture sandbox proposee

```text
Tala SMI backend
  -> http://127.0.0.1:18080/api/index.php/...
    -> dolibarr-sandbox
      -> dolibarr-sandbox-db
```

Isolation attendue :

- compose separe : `docker-compose.dolibarr-sandbox.yml` ;
- reseau Docker separe : `dolibarr_sandbox_net` ;
- volumes separes : `dolibarr_sandbox_docs`, `dolibarr_sandbox_db` ;
- pas de reverse proxy public au depart ;
- pas de modification DNS, certificat, firewall ou Apache/Nginx.

## 6. Compose sandbox execute

Le fichier effectif est `docker-compose.dolibarr-sandbox.yml`.

```yaml
name: dolibarr-sandbox

services:
  dolibarr:
    image: dolibarr/dolibarr:22.0.5-php8.2
    container_name: dolibarr-sandbox
    restart: unless-stopped
    ports:
      - "127.0.0.1:18080:80"
    environment:
      DOLI_DB_HOST: dolibarr-db
      DOLI_DB_NAME: dolibarr_sandbox
      DOLI_DB_USER: dolibarr_user
      DOLI_DB_PASSWORD: ${DOLIBARR_SANDBOX_DB_PASSWORD}
      DOLI_URL_ROOT: http://127.0.0.1:18080
    volumes:
      - dolibarr_sandbox_docs:/var/www/documents
    depends_on:
      dolibarr-db:
        condition: service_healthy
    networks:
      - dolibarr_sandbox_net

  dolibarr-db:
    image: mariadb:10.11
    container_name: dolibarr-sandbox-db
    restart: unless-stopped
    environment:
      MARIADB_ROOT_PASSWORD: ${DOLIBARR_SANDBOX_DB_ROOT_PASSWORD}
      MARIADB_DATABASE: dolibarr_sandbox
      MARIADB_USER: dolibarr_user
      MARIADB_PASSWORD: ${DOLIBARR_SANDBOX_DB_PASSWORD}
    volumes:
      - dolibarr_sandbox_db:/var/lib/mysql
    healthcheck:
      test: ["CMD", "mariadb-admin", "ping", "-h", "localhost", "--silent"]
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 30s
    networks:
      - dolibarr_sandbox_net

volumes:
  dolibarr_sandbox_docs:
  dolibarr_sandbox_db:

networks:
  dolibarr_sandbox_net:
    driver: bridge
```

## 7. Variables Tala SMI apres installation

Configurer dans `.env` serveur uniquement, jamais dans Git :

```text
DOLIBARR_ENABLED=true
DOLIBARR_BASE_URL=http://127.0.0.1:18080
DOLIBARR_API_KEY=<cle_api_utilisateur_dedie>
DOLIBARR_ENTITY_ID=
DOLIBARR_BANK_ACCOUNT_ID=<id_compte_caisse_ou_banque_dolibarr>
DOLIBARR_TIMEOUT_MS=10000
DOLIBARR_SYNC_MODE=manual
DOLIBARR_ALLOW_LOCAL=true
```

`DOLIBARR_ALLOW_LOCAL=true` est necessaire uniquement parce que la sandbox est
locale. Ne pas l'utiliser pour une URL publique ou production.

`DOLIBARR_BANK_ACCOUNT_ID` est obligatoire quand l'export operation est actif :
Dolibarr 22.0.5 n'expose pas d'API globale `/payments` ; une operation de
tresorerie SMI sans facture Dolibarr preexistante est donc exportee comme ligne
de compte via `/api/index.php/bankaccounts/{id}/lines`.

## 8. Modules Dolibarr a activer dans la sandbox

Minimum PRD V1 :

- API REST / Web services : actif (`MAIN_MODULE_API=1`) ;
- Utilisateurs et permissions : actif ;
- Tiers / Third parties ;
- Factures clients si le flux facture est valide metier ;
- Paiements ;
- Fournisseurs ;
- Banque / caisse : actif, compte cible `DOLIBARR_BANK_ACCOUNT_ID` requis.

Chaque module actif doit etre capture dans le rapport de validation sandbox.

## 9. Sequence de validation apres installation

1. Acceder a `http://127.0.0.1:18080` : valide, HTTP 200.
2. Creer l'utilisateur API dedie : valide, `smi_api`.
3. Generer la cle API dans Dolibarr : valide, cle temporaire non exposee.
4. Configurer `.env` Tala SMI avec la cle : valide, fichier mode `600`.
5. Redemarrer uniquement le service applicatif Tala SMI cible : a faire si le
   service persistant est deja lance et doit recharger `.env`.
6. Appeler Dolibarr REST `/api/index.php/status` : valide, HTTP 200.
7. Tester le client Node SMI Dolibarr : valide, version `22.0.5`.
8. Appeler `GET /api/integrations/dolibarr/status` via l'API SMI authentifiee.
9. Appeler `POST /api/integrations/dolibarr/test` via l'API SMI authentifiee.
10. Creer une operation test Tala SMI avec tiers `TALA-SANDBOX-CLIENT-001`.
11. Verifier creation d'un seul job dans `integration_jobs`.
12. Lancer retry manuel depuis UI/API.
13. Verifier absence de doublon dans `integration_links`.
14. Capturer les preuves : statut UI, jobs, liens, tentatives, objet Dolibarr.

## 10. Stop conditions

Arreter sans poursuivre si :

- le port `18080` est occupe ;
- le tag Dolibarr n'est pas choisi ;
- une cle API est ajoutee au compte humain `admin` ;
- l'URL pointe vers production ;
- les modules paiement/tiers/API ne sont pas actifs ;
- le retry cree un doublon ;
- un secret apparait dans un log, une reponse HTTP ou le DOM ;
- une correction necessite suppression de donnees reelles.

## 11. Rollback

Si aucune donnee importante n'existe dans la sandbox :

```bash
docker compose -f docker-compose.dolibarr-sandbox.yml stop
```

Suppression des volumes sandbox uniquement apres validation explicite :

```bash
docker compose -f docker-compose.dolibarr-sandbox.yml down -v
```

Ne jamais executer `docker compose down -v` depuis le compose Tala SMI de
production.

Rollback Tala SMI :

```text
DOLIBARR_ENABLED=false
DOLIBARR_SYNC_MODE=disabled
```

Puis redemarrer uniquement le service applicatif cible selon la procedure validee.
