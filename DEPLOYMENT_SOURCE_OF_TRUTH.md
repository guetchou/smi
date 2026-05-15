# Source officielle servie

Ce document fixe la source officielle pour eviter les confusions entre code local,
GitHub, VPS, Docker et PM2.

## Regle officielle

La production officielle est :

```text
GitHub main -> GitHub Actions -> VPS OVH -> /opt/caisse-topcenter -> Docker Compose -> port 3337
```

La branche `main` sur GitHub est la seule source de deploiement production.
Un correctif n'est pas considere livre en production tant qu'il n'est pas :

1. fusionne dans `main`,
2. deployee par GitHub Actions sur le VPS,
3. verifie sur `https://talatala.topcenter.cg`.

## Workspace local

Le dossier local de travail agent est :

```text
/opt/frappe_docker/caisse-topcenter
```

Ce dossier sert a coder, tester, preparer les branches et ouvrir les PR. Il ne doit
pas etre traite comme preuve qu'un changement est servi en production.

## Runtime local observe

Le runtime local peut utiliser PM2 sur le dossier de travail :

```text
PM2 caisse-topcenter -> /opt/frappe_docker/caisse-topcenter -> port 3337
```

Ce runtime local est utile pour les tests rapides, mais il n'est pas le contrat de
deploiement officiel.

## Verification obligatoire

Avant de conclure qu'un changement est livre, verifier :

```bash
git status --short --branch
git branch -vv
git worktree list
scripts/check_source_served.sh
curl -sk https://talatala.topcenter.cg/api/health
curl -I https://talatala.topcenter.cg/dashboard.html
```

## Interdictions pratiques

- Ne pas copier manuellement un fichier local vers un conteneur pour appeler cela un deploiement.
- Ne pas confondre une branche locale poussee avec une production deployee.
- Ne pas merger une PR sans validation fonctionnelle sur la branche concernee.
- Ne pas utiliser un chemin absent comme `/opt/caisse-topcenter` sur la machine locale comme preuve d'erreur : ce chemin est le chemin officiel attendu sur le VPS.
