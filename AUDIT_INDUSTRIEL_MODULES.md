# Audit industriel module par module

Date: 2026-06-01

## Référentiel de contrôle

Un module est considéré industrialisable seulement si les points suivants sont vérifiés :

- accès: module activable/assignable, permissions backend, menu visible selon droits, aucune fuite de données par rôle;
- navigation: une entrée menu mène à une page existante, titre/sous-titre présents, topbar cohérente;
- UI: pas d'ID HTML statique dupliqué, balises équilibrées, aucun bouton vers une fonction/page absente;
- données: endpoints connectés à MySQL, migrations versionnées, pas de colonnes fantômes;
- métier: statuts explicites, workflow documenté, validations obligatoires côté backend;
- non-régression: test statique ou smoke endpoint couvrant le cas critique;
- dette: pas de fichier temporaire actif, pas de doublon inutile, pas de logique cachée non testée.

## Checklist modules

| Module | Pages | Backend principal | Points critiques à vérifier |
| --- | --- | --- | --- |
| Accès & utilisateurs | parametres | access.js, users.js, permissions.js | Profils, modules assignés, lien user-agent, compte non-admin lié à agent, suppression/modification admin/DG |
| Pointeuse | pointeuse | pointeuse.js | Agent connecté, entrée/sortie, retard, absence, PIN/GPS, séparation vue agent vs manager, lien heures sup/absences |
| RH agents | rh-overview, agents | agents.js, onboarding.js, offboarding.js | Actifs/sortis, onboarding compte, salaire sans faux changement, dossiers incomplets |
| Absences & congés | absences | agents.js | Soldes, demandes, validations, impacts paie/pointeuse |
| Paie | salaires, periodes, grilles, revisions, cnss, dgi, calendrier-fiscal | salaires.js, periodes_paie.js, grilles.js, revisions_salaire.js, calendrier_fiscal.js | Bulletins, périodes, validation DG/RH/finance, déclarations, rubriques |
| Discipline | sanctions | sanctions.js | Avertissements, sanctions, retenues, workflow et historique agent |
| Finance caisse | dashboard, operations, journal, rapports, rapprochement | operations.js, rapprochements.js, dashboard.js | Encaissement/décaissement, rubriques, positions, clôture, journal, exports |
| Commercial | clients, devis, factures-clients | clients.js, devis.js, factures_clients.js | Conversion devis/facture, paiement, impayés, plafond crédit |
| Achats | achats, bons-commandes, receptions, factures-fournisseurs | achats.js | Demande, approbation, BC, réception, rapprochement 3 voies, facture, paiement |
| Stock | produits | produits.js | Catégories, mouvements, alertes, liens achat/vente |
| Contrats | contrats | contrats.js | Échéances, facturation récurrente, alertes, renouvellement/résiliation |
| Direction | bilan, parapheur, audit | dashboard.js, parapheur.js, notifs.js | File DG, délégation, audit, alertes, actions validables |
| Organisation | organigramme | organigramme.js | Départements, postes, liens hiérarchiques, historique mutations |

## Défauts silencieux corrigés dans ce passage

- Bouton topbar clôture: `showPage('rapprochements')` pointait vers une page inexistante; corrigé vers `rapprochement`.
- Collision HTML: deux éléments statiques utilisaient `id="pd-titre"`; le champ parapheur est renommé `parapheur-demande-titre`.
- Topbar parapheur: titre explicite ajouté et sous-titre dupliqué consolidé.
- Tests: ajout d'une garde contre les IDs HTML statiques dupliqués, les anciennes clés token et les pages inexistantes.
- Accès & utilisateurs: création/modification des comptes et provisioning RH passent par `IdentityAccessService`.
- Propreté dépôt: les répertoires actifs `backend`, `frontend`, `tests` et `scripts` ne contiennent plus de fichiers `.tmp`, `.bak` ou `~`.
- Navigation: chaque entrée `data-page`, cible `showPage`, titre, sous-titre et zone topbar mappée est couvert par `checkFrontendModuleMapping`.
- RH agents: création et modification générale de fiche agent sont tracées dans `audit_logs`, avec horodatage `updated_at`.

## Dettes restantes non bloquantes

- `frontend/dashboard.html` reste monolithique: 24k lignes. Ce n'est pas industriel à long terme; il faut découper par module.
- Plusieurs routes backend sont trop volumineuses: `salaires.js`, `agents.js`, `operations.js`, `achats.js`.
- Le menu `achats` apparaît dans Direction et Achats. C'est fonctionnel mais ambigu; cible industrielle: page ou filtre dédié `achats-approbations`.
- Les doublons d'ID dans templates JS dynamiques doivent être inspectés par rendu navigateur, pas uniquement par scan statique.

## Passes validées

| Passe | Module | Preuve |
| --- | --- | --- |
| 2026-06-01 | Accès & utilisateurs | `IdentityAccessService`, routes `users.js` sans écriture directe users/profils, garde `checkUserAgentLinkInvariant` |
| 2026-06-01 | Propreté dépôt actif | garde `checkNoActiveTempArtifacts`, recherche active sans `.tmp/.bak/~` |
| 2026-06-01 | Navigation & topbar | garde `checkFrontendModuleMapping`: pages, titres, sous-titres, cibles `showPage`, zones topbar |
| 2026-06-01 | RH agents | garde `checkAgentAuditTraceabilityGuard`: audit création/modification agent et `updated_at` |

## Prochaine passe sans omission

Ordre de revue:

1. Accès & utilisateurs.
2. Pointeuse.
3. RH agents.
4. Absences & congés.
5. Paie complète.
6. Finance caisse.
7. Achats.
8. Commercial.
9. Stock.
10. Contrats.
11. Direction/parapheur/audit.
12. Organisation.

Pour chaque module: audit permissions, audit navigation, audit DOM, smoke endpoints, test rôle admin/RH/DG/agent, correction, puis preuve.
