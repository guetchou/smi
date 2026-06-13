# PRD — Refactorisation progressive des gros fichiers

## Problème

`frontend/dashboard.html` concentre le shell, le design, la navigation et plusieurs
domaines métier dans environ 1,5 Mo. `backend/database.js` et plusieurs routes
dépassent aussi une taille qui nuit à la localité des changements et des tests.

## Objectif

Extraire progressivement des modules profonds par domaine sans changer les
contrats HTTP, les parcours utilisateurs ni les données.

## Premier incrément

Extraire le workflow de rectification des bulletins payés dans
`frontend/js/modules/payroll-rectifications.js`.

Le module prend en charge :

- sélection et contrôle du bulletin payé ;
- état du formulaire ;
- validation du montant et du motif ;
- aperçu de l’impact ;
- appel de création de rectification ;
- remise à zéro et rechargement de la Paie.

Le bulletin payé reste verrouillé et les droits restent contrôlés côté interface
et côté backend.

## Critères d’acceptation

- aucun changement du contrat `/salaires/bulletin/:id/rectification` ;
- aucun `window.prompt` ;
- les fonctions appelées par le HTML restent disponibles ;
- tests existants et test isolé du nouveau module passent ;
- `dashboard.html` ne contient plus l’implémentation du workflow extrait.

