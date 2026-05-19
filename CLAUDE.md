# CLAUDE.md — Règles de travail Caisse TOP CENTER

## Branche de travail

**Toujours travailler sur `main` directement.**

Ce projet est développé en solo (Gess GALOYI). Il n'y a pas d'équipe, pas de revue de code externe, pas de besoin de branches feature longues.

- La branche `main` est la **seule source de vérité**.
- Chaque push sur `main` déclenche **automatiquement** le déploiement en production via GitHub Actions → VPS OVH.
- Ne jamais créer une branche feature qui dure plus d'un seul commit ou d'une seule session.
- Si une branche feature est créée (hotfix ponctuel), la merger dans `main` **dans la même session**, puis la supprimer immédiatement.

## Flux de déploiement

```
commit local → git push origin main → GitHub Actions → deploy.sh (VPS) → docker compose build → conteneur port 3337
```

Le VPS (`/opt/caisse-topcenter/`) suit `origin/main` via `git reset --hard origin/main`.  
Le conteneur Docker `caisse-topcenter` est l'unique process en production.  
PM2 n'existe pas sur le VPS — ne pas l'utiliser en production.

## Environnements

| Environnement | Chemin | Process | DB |
|---|---|---|---|
| **Local (dev)** | `/opt/frappe_docker/caisse-topcenter/` | PM2 port 3337 | `backend/data/caisse.db` (locale) |
| **Production** | `/opt/caisse-topcenter/` (VPS OVH) | Docker port 3337 | Volume Docker `caisse-topcenter_caisse_data` |

Les deux bases de données sont **distinctes et indépendantes**. Ne jamais copier la DB locale en prod sans backup préalable.

## Règles de commit

- Committer et pusher sur `main` **à la fin de chaque tâche**, sans attendre.
- Ne jamais laisser du travail non pushé.
- Message de commit : `type(scope): description courte` (ex. `fix(operations): RBAC encaissements`).
