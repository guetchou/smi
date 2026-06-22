# Fonctions départementales

## Base de données

La production utilise exclusivement MySQL pour ce module. Le schéma est créé par `backend/migrations/033_department_functions.sql` via le runner MySQL du déploiement.

## Fonctions prises en charge

- Chef de département
- Premier adjoint
- Adjoint
- Responsable intérimaire
- Suppléant
- Chef de service
- Chef de section
- Coordonnateur

## Règles métier

- Le responsable historique de chaque département est repris comme chef titulaire.
- Un agent doit appartenir au département avant d’y recevoir une fonction.
- Un seul chef titulaire actif est conservé après nomination.
- L’intérim et la suppléance exigent une date de fin.
- Le chef titulaire ne peut pas être clôturé sans remplaçant.
- Un adjoint ou responsable interne actif peut être choisi comme supérieur fonctionnel dans une mutation RH.
- Les modifications organisationnelles restent soumises au workflow de mutation RH.
- Les nominations futures de chef sont refusées tant qu’un workflow de prise d’effet dédié n’existe pas.
