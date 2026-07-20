# PRD - Gestion des salaires et contrats de travail

## Source de verite

- PRD utilisateur : `C:\Users\Gess\Downloads\PRD salaire et contrat.md`
- Modele Word : `C:\Users\Gess\OneDrive\Documents\Contrats-Agents-TopCenter\Contrat de travail des nationaux  MATOKO2.docx`
- SHA-256 du modele : `c638f98d03d2a6167cb7c2b4f1fabb8ced740f596a0077529dbffb49383ec032`

## Objectif

Integrer au SMI existant un systeme RH de modeles contractuels versionnes, contrats individuels, remuneration parametree, validation, generation DOCX/PDF et archivage agent. Aucun taux fiscal ou social ne doit etre invente ni inscrit dans une vue.

## Parcours canonique

1. RH selectionne un agent existant et complete explicitement les donnees manquantes.
2. RH choisit une version publiee d'un modele de contrat.
3. Le systeme calcule les dates et compose la remuneration par rubriques distinctes.
4. Les assiettes sociale et fiscale sont expliquees; un calcul incomplet reste `a_verifier`.
5. RH personnalise les clauses locales sans modifier le modele global.
6. Le controle bloque les variables obligatoires absentes et les incoherences.
7. La direction valide ou rejette; une version validee devient immuable.
8. DOCX et PDF proviennent du meme snapshot et sont archives avec checksum.

## Principes d'architecture

- Reutiliser `employes`, `entreprise`, `permissions`, `audit_logs`, le stockage et le service PDF.
- Ne pas reutiliser directement `contrats`, oriente facturation commerciale et echeances.
- Lier les contrats RH a l'agent et, si necessaire, au contrat commercial historique.
- Versionner modeles, regles et snapshots; ne jamais recalculer retroactivement un contrat valide.
- Conserver le modele Word source jusqu'a validation fonctionnelle et juridique.

## Lots automatises

- `foundation` : schema, calculs, variables, dates, RBAC.
- `templates` : modeles, versions, clauses, catalogue de variables.
- `workflow` : brouillon, verification, validation, signature, archive, avenant.
- `documents` : DOCX editable, PDF coherent, stockage et checksums.
- `ui` : liste, assistant, controle, apercu et integration fiche agent.
- `verify` : tests, OWASP, Playwright 320/768/1024/1440 et comparaison Word.

## Validation humaine obligatoire

Les taux CNSS/CAMU, assiettes, baremes IRPP/ITS, parts fiscales, references legales, couverture medicale, conges, resiliation et visa ACPE doivent etre confirmes par RH/comptabilite/juriste avant publication d'un jeu de regles ou d'un modele.
