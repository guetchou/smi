# Modèle de contrôle d'accès ERP

## Objectif

Le modèle d'accès évolue d'un système de rôles simples vers un modèle ERP compatible petite et grande entreprise.

Les rôles historiques restent actifs pendant la transition :

- `admin`
- `dg`
- `assistante_direction`
- `rh`
- `finance`
- `caissier`
- `delegue`
- `lecteur`

Ils sont synchronisés vers des profils ERP dans `user_profiles`.

## Tables

- `profiles` : profils métier par défaut.
- `permissions` : permissions fines par module.
- `profile_permissions` : permissions accordées par profil.
- `user_profiles` : profils activés par utilisateur.
- `user_permissions` : permissions directes, autorisations ou retraits.
- `delegations` : délégations temporaires par permission, profil ou module.
- `permission_audit_logs` : journal des changements d'accès.

## Service backend

Le service [permissions.js](/opt/projet-smi/backend/services/permissions.js) expose :

- `can(user, permission, context = {})`
- `requirePermission(permission)`
- `activePermissionsForUser(userId)`
- `auditPermission(...)`

`can()` tient compte de :

- superuser admin, sauf si `context.adminSuperuser === false`;
- permissions directes utilisateur;
- profils actifs;
- délégations actives;
- plafonds financiers via `context.amount`;
- expiration;
- fallback rôles historiques pendant la migration.

## Règles métier

Une permission sensible peut être retirée sans supprimer le compte.

Les petites structures peuvent cumuler plusieurs profils sur une même personne.

Les grandes structures peuvent séparer RH, Finance, Caisse, DG et Audit.

L'admin technique n'est pas automatiquement DG métier dans le modèle cible. Pendant la transition, `admin` conserve le superuser technique pour éviter de casser l'existant.

## Workflows migrés en première phase

- Paie : génération, validation bulletin, soumission DG, validation DG, paiement.
- Décaissements : création, validation, paiement.
- Achats : création, validation, paiement.
- Accès : lecture du modèle, profils utilisateur, permissions directes, délégations, audit.

## Effet frontend/backend

Le frontend masque progressivement les actions selon le modèle ERP.

Le backend reste l'autorité : une action masquée doit aussi être refusée par route si la permission manque.

Après retrait d'une permission, l'effet est visible au refresh et au prochain contrôle backend. Les jetons restent compatibles avec les rôles historiques tant que la migration n'est pas terminée.
