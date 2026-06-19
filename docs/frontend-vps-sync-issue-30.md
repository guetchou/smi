# Issue #30 — Inventaire frontend servi sur le VPS

## PRD

Synchroniser dans GitHub le frontend réellement servi par le VPS afin que la correction design finance parte d'un état source complet, reproductible et sans artefacts sensibles.

Le frontend réel est servi par `backend/server.js` via `express.static(path.join(__dirname, '..', 'frontend'))`, avec des routes directes no-cache pour `/`, `/index.html`, `/dashboard.html`, `/sw.js` et `/app/*`.

## Plan

1. Identifier les reverse proxies et le chemin applicatif qui sert le frontend.
2. Inventorier les fichiers frontend suivis, non suivis et ignorés.
3. Classer les dépendances runtime à inclure.
4. Exclure secrets, uploads, logs, caches, dumps et `node_modules`.
5. Valider par tests statiques et suite projet.
6. Publier une PR dédiée sans fusion automatique.

## Fichiers frontend réels inclus

- `frontend/dashboard.html`
- `frontend/index.html`
- `frontend/tailwind.css`
- `frontend/tailwind.input.css`
- `frontend/sw.js`
- `frontend/manifest.json`
- `frontend/favicon.ico`
- `frontend/favicon.png`
- `frontend/favicon.svg`
- `frontend/icons/icon-192.png`
- `frontend/icons/icon-512.png`
- `frontend/js/core/navigation.js`
- `frontend/js/core/transport.js`
- `frontend/js/modules/agents.js`
- `frontend/js/modules/payroll-cycle.js`
- `frontend/js/modules/payroll-documents.js`
- `frontend/js/modules/payroll-grids.js`
- `frontend/js/modules/payroll-periods.js`
- `frontend/js/modules/payroll-rectifications.js`
- `frontend/js/modules/payroll-revisions.js`
- `frontend/maquettes/agent_dashboard_desktop.html`
- `frontend/maquettes/agent_dashboard_mobile.html`
- `frontend/maquettes/attestation_conges.html`
- `frontend/maquettes/attestation_salaire.html`
- `frontend/maquettes/attestation_travail.html`
- `frontend/maquettes/bon_commande.html`
- `frontend/maquettes/bordereau_cnss.html`
- `frontend/maquettes/bordereau_dgi.html`
- `frontend/maquettes/bulletin_paie.html`
- `frontend/maquettes/certificat_travail.html`
- `frontend/maquettes/devis.html`
- `frontend/maquettes/facture_client.html`
- `frontend/maquettes/index.html`
- `frontend/maquettes/org_maquette_cards.html`
- `frontend/maquettes/org_maquette_horizontal.html`
- `frontend/maquettes/org_maquette_matrix.html`
- `frontend/maquettes/org_maquette_radial.html`
- `frontend/maquettes/solde_tout_compte.html`

## Fichier de design ajoute

- `frontend/maquettes/finance_operations_refonte_prototype.html`

Ce fichier n'est pas reference par `dashboard.html`, `index.html`, `frontend/js/*`, `sw.js` ou `manifest.json`. Il est classe comme maquette utile pour la correction design finance, pas comme dependance runtime obligatoire.

## Exclusions confirmees

- `.env` et secrets: exclus.
- `backend/data/uploads`: exclu, servi separement via `/uploads`, donnees utilisateur.
- `logs`: exclu.
- `node_modules`: exclu.
- `test-results` et `playwright-report`: exclus.
- Dumps SQL, caches et fichiers temporaires frontend: aucun fichier detecte sous `frontend/`.

## Points d'audit

- `nginx.conf` du projet proxy vers l'application Node, il ne sert pas directement `frontend/`.
- `docker-compose.yml` decrit le service `caisse` sur `3337`, mais le compose ne peut pas etre introspecte sans `.env` chargee car `JWT_SECRET` est requis.
- Les services systemd ne sont pas consultables depuis le sandbox: `Failed to connect to bus: Operation not permitted`.
- Le GitHub CLI local est installe mais non authentifie: le token GitHub est invalide.
