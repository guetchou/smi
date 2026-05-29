# CLAUDE.md — Règles de travail Caisse TOP CENTER

## Il n'y a qu'une seule branche : `main`

**Toujours travailler sur `main` directement. Sans exception.**

- Avant chaque session : `git checkout main && git pull origin main`
- Après chaque tâche terminée : `git add ... && git commit && git push origin main`
- Ne jamais créer de branche feature. Ne jamais laisser du travail non pushé.
- Un push sur `main` = déploiement automatique en production dans la foulée.

## Il y a deux environnements distincts — ils ne se mélangent jamais

| | Local (développement) | Production (VPS OVH) |
|---|---|---|
| **Chemin** | `/opt/frappe_docker/caisse-topcenter/` | `/opt/caisse-topcenter/` |
| **Process** | PM2 (`caisse-topcenter`) | Docker (`caisse-topcenter`) |
| **Port** | 3337 | 3337 |
| **DB** | `backend/data/caisse.db` (locale, données de test) | MySQL Docker `caisse-mysql`, volume `caisse-topcenter_mysql_data` |
| **NODE_ENV** | `development` | `production` |
| **Déployé par** | Manuel (`pm2 reload`) | GitHub Actions automatique |

Ces deux environnements sont **physiquement séparés** (machines différentes). Il n'y a aucun lien entre la DB locale et la DB de production.

## Flux de déploiement

```
git push origin main
       ↓
GitHub Actions (déclenché automatiquement)
       ↓
VPS OVH : git reset --hard origin/main
       ↓
docker compose build && docker compose up -d
       ↓
Conteneur Docker port 3337 — Production opérationnelle
```

## Accès VPS

```bash
ssh vps-ovh                          # connexion
git -C /opt/caisse-topcenter log --oneline -3   # vérifier le commit en prod
docker ps --filter name=caisse-topcenter        # vérifier le conteneur
curl http://localhost:3337/api/health           # vérifier la santé
```

## Règles absolues

- Ne jamais modifier des fichiers directement sur le VPS.
- Ne jamais copier la DB de production en local (risque de données personnelles).
- Ne jamais faire `docker compose down -v` sur le VPS (détruit les données).
- PM2 n'existe pas sur le VPS — ne pas l'utiliser en production.
- En production Docker, `DB_DRIVER` doit être `mysql`. SQLite est interdit comme runtime de production.

## Identités métier

- `users.id` désigne le compte applicatif : connexion, rôles, permissions, audit.
- `employes.id` désigne la fiche agent RH : pointeuse, paie, congés, absences, sanctions.
- `users.employe_id` est le lien optionnel entre un compte et une fiche agent.
- Les comptes système (`admin`, comptes techniques) peuvent rester sans fiche agent.
- Une fiche agent ne doit pas être liée à plusieurs comptes.
