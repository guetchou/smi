# Tala SMI — Système de Management Intégré

> Gestion financière et RH pour **TOP CENTER** · Congo-Brazzaville  
> Développé par **Gess GALOYI**

---

## Présentation

Tala SMI est une application web monopage (SPA) de gestion intégrée couvrant :

- **Caisse** — encaissements, décaissements, virements internes, journal comptable
- **Salaires** — génération de bulletins, workflow brouillon → validé → payé, primes, retenues
- **Agents / RH** — dossiers employés, contrats, avances sur salaire, congés, absences
- **Rapports** — tableau de bord, rapport hebdomadaire, export Excel
- **Paramètres** — rubriques comptables, positions de caisse, utilisateurs, fournisseurs, localisation

Production : **[https://talatala.topcenter.cg](https://talatala.topcenter.cg)**

---

## Stack technique

| Couche | Technologie |
|--------|-------------|
| Backend | Node.js 20 + Express 4 |
| Base de données | SQLite (better-sqlite3) — fichier `caisse.db` |
| Frontend | Vanilla JS, Tailwind CSS (CDN), Chart.js v4, Flatpickr |
| Auth | JWT (jsonwebtoken), bcrypt |
| Email | Nodemailer — SMTP Infomaniak |
| Conteneur | Docker + Docker Compose |
| CI/CD | GitHub Actions → SSH → VPS OVH |

---

## Structure du projet

```
caisse-topcenter/
├── backend/
│   ├── server.js           # Point d'entrée Express (port 3337)
│   ├── database.js         # Connexion SQLite + migrations
│   ├── routes/
│   │   ├── auth.js         # Login, captcha, JWT
│   │   ├── operations.js   # Encaissements, décaissements, workflow
│   │   ├── salaires.js     # Bulletins de paie
│   │   ├── agents.js       # Dossiers RH, congés, avances
│   │   ├── users.js        # Gestion utilisateurs, paramètres
│   │   └── entreprise.js   # Infos entreprise, logo
│   ├── services/
│   │   └── email.js        # Envoi d'emails (notifications, bulletins)
│   └── data/               # Volume Docker — caisse.db + uploads/
├── frontend/
│   ├── index.html          # Page de connexion
│   ├── dashboard.html      # SPA principale (~6800 lignes)
│   └── sw.js               # Service Worker v6 (offline partiel)
├── docker-compose.yml
├── Dockerfile
├── .github/workflows/      # CI/CD GitHub Actions
└── DANGER.md               # ⛔ À lire avant toute intervention
```

---

## Installation locale

```bash
# Prérequis : Node.js 20+, Docker (optionnel)

git clone <repo>
cd caisse-topcenter
npm install

# Lancer en développement
node backend/server.js
# → http://localhost:3337
```

### Avec Docker

```bash
docker compose up -d --build
# → http://localhost:3337
```

> **Ne jamais utiliser `docker compose down -v`** — cela détruit toutes les données. Lire [DANGER.md](DANGER.md).

---

## Comptes par défaut

| Email | Mot de passe | Rôle |
|-------|-------------|------|
| admin@topcenter.cg | Admin@2025! | Administrateur |

---

## Rôles utilisateurs

| Rôle | Droits |
|------|--------|
| `admin` | Accès complet |
| `finance` | Opérations + validation décaissements |
| `caissier` | Saisie encaissements/décaissements |
| `rh` | Module agents et salaires |
| `lecteur` | Consultation uniquement |

---

## Workflow décaissement

```
brouillon → soumis → validé → payé
                ↑
         Email automatique aux admin/finance à chaque soumission
```

Les encaissements sont validés directement à la saisie.

---

## Déploiement production

Le déploiement est **automatique** à chaque push sur `main` via GitHub Actions.
La source officielle servie est documentée dans
[DEPLOYMENT_SOURCE_OF_TRUTH.md](DEPLOYMENT_SOURCE_OF_TRUTH.md).

```bash
# Ne PAS déployer manuellement sauf panne CI/CD
ssh vps-ovh
cd /opt/caisse-topcenter
git pull origin main
docker compose up -d --build   # ← jamais de -v
```

**Serveur :** VPS OVH — 5.196.22.149  
**Chemin officiel VPS :** `/opt/caisse-topcenter`
**Données :** volume Docker `caisse-topcenter_caisse_data` → `/var/lib/docker/volumes/caisse-topcenter_caisse_data/_data/`

Le dossier local `/opt/frappe_docker/caisse-topcenter` est un workspace de travail
agent. Il ne prouve pas qu'un changement est servi en production.

---

## Backup

```bash
DATE=$(date +%Y%m%d_%H%M%S)
cp /var/lib/docker/volumes/caisse-topcenter_caisse_data/_data/caisse.db \
   /opt/backups/caisse-topcenter/caisse_${DATE}.db
```

---

## Variables d'environnement

| Variable | Défaut | Description |
|----------|--------|-------------|
| `PORT` | 3337 | Port Express |
| `JWT_SECRET` | *(voir docker-compose)* | Secret de signature JWT |
| `DB_PATH` | `/app/backend/data/caisse.db` | Chemin base SQLite |
| `SMTP_HOST` | — | Serveur SMTP (Infomaniak) |
| `SMTP_USER` | — | Adresse expéditeur |
| `SMTP_PASS` | — | Mot de passe SMTP |

---

## Raccourcis clavier

| Raccourci | Action |
|-----------|--------|
| `Ctrl+E` | Nouvel encaissement |
| `Ctrl+D` | Nouveau décaissement |
| `G H` | Tableau de bord |
| `G O` | Opérations |
| `G J` | Journal |
| `D` | Mode sombre |
| `M` | Menu sidebar |
| `?` | Aide raccourcis |
| `Échap` | Fermer modal/dialog |

---

*Tala SMI — TOP CENTER · Congo-Brazzaville · © 2025 Gess GALOYI*
