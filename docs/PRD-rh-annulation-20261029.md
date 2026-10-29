# PRD
Annuler les demandes de note RH doit interrompre toute action. Aucun code interne dans le journal affiché ; bouton de départ ajusté au texte.

# Plan
Corriger deux gardes d’annulation, traduire l’événement constaté, protéger son texte et réduire le bouton. Tests des fonctions réelles avec API simulée, CI, déploiement officiel autorisé et Chrome. Aucun changement de données ni de droits.

# Rapport
## 1. Synthèse
Reproduit dans Chrome sans HTTP réel : null devenait undefined avant le test, provoquant une requête après annulation.
## 2. Inventaire
Worktree dédié propre, base origin/main, application saine. Dossier agent consulté sans enregistrement.
## 3. Actions
Priorité haute : annulation ; moyenne : textes et largeur. Corrections réversibles autorisées.
## 4. Sauvegarde
Aucune sauvegarde fichier séparée : rollback Git suffisant.
## 5. Tests
Huit cas sur fonctions réelles : deux actions avec null, undefined, chaîne vide et note. CI obligatoire. Avant observé dans Chrome, après à confirmer.
## 6. Retour arrière
Commit inverse et déploiement officiel. Aucune donnée à restaurer.
## 7. Diff
Dashboard, test dédié, npm test et présent document.
