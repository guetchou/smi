# Modèle d'organisation ERP

## Objectif

Le modèle organisationnel doit représenter Top Center aujourd'hui et permettre une évolution vers une structure plus grande sans recoder les modules.

## Départements par défaut

- `direction_generale`
- `support_administration`
- `ressources_humaines`
- `finance_comptabilite_caisse`
- `commercial_marketing`
- `operations_callcenter_projets`
- `technique_infrastructure`
- `moyens_generaux`
- `audit_controle_conformite`

Ces départements sont seedés dans `departments` et répliqués comme unités dans `organization_units`.

## Tables

- `departments` : départements métier.
- `organization_units` : pôles, départements, équipes, sites logiques.
- `employee_assignments` : affectations d'un agent à une unité.
- `org_postes`, `org_departements`, `employes_mutations` : référentiels existants conservés.

La table `positions` existe déjà dans l'application et représente les positions de trésorerie. Pour éviter toute rupture de caisse, les postes organisationnels ne réutilisent pas ce nom de table. Ils restent dans `org_postes` et dans `employee_assignments.position_title`.

## Affectations

Une affectation peut porter :

- poste occupé;
- rattachement hiérarchique;
- rattachement fonctionnel;
- classification;
- catégorie;
- niveau;
- intérim;
- date de début;
- date de fin;
- type d'affectation : principale, secondaire, intérim, projet.

## Petite entreprise

Une même personne peut cumuler plusieurs profils et plusieurs responsabilités :

- DG + Finance + RH;
- Assistante Direction + Caisse + RH + Moyens Généraux;
- Chargée Projet + Commercial + intérim Direction.

## Grande entreprise

Le même modèle supporte la séparation stricte :

- RH prépare;
- Finance contrôle;
- DG valide;
- Caisse paie;
- Audit contrôle.

## Évolution prévue

Les anciennes colonnes `employes.poste`, `employes.departement`, `employes.superieur_id` restent utilisables pendant la transition.

Les nouveaux développements doivent privilégier `employee_assignments` pour les rattachements avancés et l'historique.
