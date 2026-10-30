# PRD — Finition du bloc accès agent

## 1. Résultat attendu
Le profil, l’email et le bouton de création de compte ne doivent pas occuper toute la largeur du dossier agent. Conserver les contrôles et le sens métier.

## 2. Inventaire
Défaut observé dans Chrome en production 803c933 : profil large de 694 px à 768 px de fenêtre et de 918 px sur bureau. Worktree dédié propre requis.

## 3. Plan
Retirer les largeurs pleines de ces trois contrôles, borner l’email et garder leur retour à la ligne. Clarifier les libellés de ce bloc et les demandes de note de la même fonction RH. Pas de logique métier ni de droits modifiés. Contrôles existants, CI et déploiement officiel autorisé puis vérification réelle à 320,768,1024,1440 px.

## 4. Sauvegarde
Aucune sauvegarde fichier séparée : rollback Git suffisant ; base 803c933839b3b26afbbb37bceaea7279d7ce917d.

## 5. Tests
Styles reconstruits ; gardes existantes et audit avant commit ; validation visuelle avant/après requise. Aucun nouvel enregistrement de compte.

## 6. Retour arrière
Commit inverse et déploiement officiel, aucune donnée à restaurer.

## 7. Diff
Markup du bloc accès et libellés associés, CSS régénérée, présent document.
