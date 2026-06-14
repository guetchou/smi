# Plan — Refactorisation progressive des gros fichiers

## Phase 1 — Frontend Paie

1. Extraire la rectification des bulletins payés. **Terminé — `167318f`.**
2. Extraire le cycle génération, validation et paiement. **Terminé — module `payroll-cycle.js`.**
3. Extraire les exports, PDF et envois.
4. Extraire les vues Périodes, Grilles et Révisions.

## Phase 2 — Autres domaines frontend

1. Achats et délégations.
2. Trésorerie et opérations.
3. Comptabilité.
4. Paramètres et accès.

## Phase 3 — Backend

1. Décomposer `database.js` par moteur et responsabilité.
2. Décomposer `routes/salaires.js` par workflow.
3. Décomposer `routes/agents.js`, `operations.js` et `achats.js`.

## Règles d’exécution

- une extraction par commit ;
- aucune modification de contrat dans un commit d’extraction ;
- un test au niveau de l’interface du module ;
- rollback par `git revert` ;
- déploiement seulement après tests locaux et conteneur.
