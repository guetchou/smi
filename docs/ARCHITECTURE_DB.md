# Architecture base de donnees

## Regle de reference

La production SMI utilise MySQL via Docker sur le VPS-OVH. Les migrations de reference sont les fichiers `backend/migrations/0xx_*.sql`, appliques par le pipeline CI/CD.

`backend/database.js` contient un fallback SQLite uniquement pour le developpement local et certains tests. Il ne doit pas etre considere comme la source de verite de production.

## Regle de changement de schema

Tout changement de schema doit suivre cet ordre :

1. Ajouter une migration MySQL additive dans `backend/migrations/`.
2. Ajouter le miroir minimal dans `backend/database.js` pour eviter de casser le dev local.
3. Ajouter un controle statique si le changement protege un flux metier.
4. Deployer par CI/CD, jamais par modification manuelle de la base production.

## Comptabilite OHADA

Les comptes OHADA seeds dans SMI proviennent des documents locaux audites dans `/opt/frappe_docker/docs/` :

- `CONFIGURATION-COMPTES-OHADA.md`
- `GUIDE-COMPTES-OHADA-CONFIGURATION.md`
- `OHADA-COMPTES-LOYER-EAU-ELECTRICITE.md`

Les comptes peuvent etre ajoutes comme referentiel, mais les regles de mapping comptable ne doivent pas etre activees automatiquement sans validation comptable.
