# ADR 0001 — Le journal des approbations est `parapheur_actions`

Date : 23 septembre 2026
Statut : **proposé** — une question de produit reste ouverte, voir §6
Contexte : chantiers 3 et 4 du programme « maîtrise comptable » ; constat C7b de
l'audit des flux, bande intermédiaire du PRD `PRD_operations_workflow.md` §3

## 1. Le problème

Le PRD décrit trois bandes d'approbation pour un décaissement :

- en deçà du seuil finance : un approbateur suffit ;
- **entre les deux seuils : Finance ET DG** ;
- au-delà du seuil DG : le DG est obligatoire.

Les bandes haute et basse sont appliquées depuis la PR #229. La bande
intermédiaire ne l'est pas : elle demande **deux décisions distinctes**, par deux
personnes distinctes, à deux instants distincts — et `operations` ne porte qu'un
seul `validated_by` / `validated_at`.

Représenter deux décisions dans un champ prévu pour une seule est faux quelle que
soit l'astuce employée : on perdrait soit le premier approbateur, soit le second,
soit l'ordre.

## 2. La décision

**Ne pas créer de table. Ne pas ajouter de colonnes.** Le journal demandé existe
déjà : `parapheur_actions`.

| Besoin | Colonne existante |
|---|---|
| quelle décision | `action_type` |
| par qui | `acteur_id` |
| à quel titre | `acteur_role` |
| à quel instant | `created_at` |
| par délégation ? | `is_interim` |
| sur quel objet | `parapheur.ref_source_table` / `ref_source_id` |

L'énumération de `action_type` contient **déjà** `soumis`, `transmis_dg`,
`approuve`, `rejete`, `delegue`. Aucune migration de schéma n'est nécessaire.

Créer une seconde table d'approbations à côté de celle-ci serait exactement la
duplication que le programme interdit — et la pire espèce, puisque les deux
diraient la même chose sans jamais être d'accord.

## 3. Ce qui manque réellement

`creerEntreeParapheur` n'écrit qu'**une seule** action, `soumis`, au moment de la
soumission. Mesuré en production : les trois dossiers de décaissement ne portent
que cette action. La validation, elle, écrit `operations.validated_by` et ne laisse
**aucune trace dans le journal**.

Le travail est donc du comportement, pas de la structure :

1. à chaque décision d'approbation, ajouter une ligne au journal, avec la
   **capacité** de l'acteur dans `acteur_role` — c'est elle qui distingue une
   approbation Finance d'une approbation DG ;
2. lire le journal pour répondre à « cette opération a-t-elle les approbations
   que son montant exige ? » ;
3. conserver `operations.validated_by` / `validated_at` comme **projection** de la
   décision finale.

## 4. Compatibilité et réversibilité

**Lecture des anciennes opérations.** `validated_by` et `validated_at` ne sont ni
supprimés ni détournés : ils continuent de porter la décision finale, et tout
lecteur existant — API, écrans, exports — continue de fonctionner sans changement.

**Backfill.** Mesuré : `SELECT COUNT(*) FROM operations WHERE validated_by IS NOT
NULL` renvoie **0**. Aucun décaissement n'a jamais été validé en production. Il
n'y a donc **rien à reprendre**. Si cela changeait avant la mise en service, le
backfill serait strictement additif : une ligne `approuve` par opération validée,
avec l'acteur et l'horodatage déjà connus, sans toucher à `operations`.

**Rollback.** Aucune migration de schéma, donc aucun rollback de schéma. Revenir
en arrière consiste à cesser d'écrire dans le journal et à ne plus le lire ; les
lignes déjà écrites restent de l'historique valide, et `operations` n'a pas bougé.

**Migration.** Aucune. C'est le principal mérite de cette décision.

## 5. Ce que la règle devra garantir

- deux approbations **par deux `acteur_id` distincts** — un même utilisateur
  portant les deux capacités ne peut pas approuver deux fois ;
- la séparation des fonctions existante est préservée : ni le créateur ni le
  soumetteur ne peuvent approuver, contrôle déjà en place depuis le 23/06/2026 ;
- la délégation suit la règle établie pour les seuils : l'autorité du DG se
  transmet par une délégation **émanant d'un porteur du rôle `dg`**, et
  `is_interim` en garde la trace ;
- l'opération ne passe à `valide` que lorsque le journal porte les approbations
  que son montant exige — la projection suit le journal, jamais l'inverse.

## 6. La question qui reste ouverte

Le PRD dit « Finance **+** DG ». Il ne dit pas **dans quel ordre**.

- **Ordre libre** : les deux approbations valent quel que soit leur ordre
  d'arrivée. Plus simple, plus tolérant aux absences.
- **Ordre imposé** : Finance instruit, puis le DG tranche. Plus proche d'un
  circuit de parapheur classique, et l'énumération porte d'ailleurs déjà
  `transmis_dg`, ce qui suggère cette lecture.

Les deux sont implémentables sur le même journal ; le choix change ce que voit
l'utilisateur et ce que le banc doit prouver. **Cette décision appartient au
produit et n'est pas prise ici.**

## 7. Note de conformité

Ce document est une décision d'architecture. Il n'introduit aucun texte visible
dans l'interface, et aucune de ses formulations ne doit devenir un libellé.
