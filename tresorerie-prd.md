# PRD - Redressement industriel du module Tresorerie

## 1. Probleme a resoudre

Le module Tresorerie doit devenir un registre controle des flux d'argent de l'entreprise. L'etat actuel du formulaire "Nouveau virement interne" montre un ecran fonctionnel mais encore trop brut pour un usage industriel :

- le formulaire se presente comme une saisie simple, sans parcours de controle ni resume avant enregistrement ;
- les champs source et destination sont des listes simples, fragiles si le nombre de positions devient important ;
- des exemples de production restent dans les placeholders, par exemple `ex: VIR-001` ou `Approvisionnement caisse depuis banque` ;
- le numero de piece n'est pas clairement genere par le systeme ;
- le formulaire preselectionne des positions par defaut, ce qui augmente le risque d'erreur de caisse ou de banque ;
- le transfert interne est enregistre directement comme operation valide, sans circuit de validation visible ;
- l'utilisateur ne voit pas le solde disponible de la source, le solde apres transfert ni l'impact comptable attendu ;
- les controles metier sont partiels et disperses entre le front-end et le back-end ;
- la modal ne montre pas les preuves attendues, le statut, l'audit, les droits et la confirmation de responsabilite.

Ce n'est pas encore un niveau industriel. On ne peut pas affirmer une similarite avec les solutions industrielles tant que les controles, la tracabilite, les permissions, l'audit, les tests et l'experience utilisateur ne sont pas verifies module par module.

## 2. Objectif produit

Construire un module Tresorerie fiable, auditable et exploitable par un caissier, un comptable, un responsable financier et un auditeur.

Le module doit permettre de :

- gerer les positions de tresorerie : caisse, banque, mobile money, cheque a encaisser, transit ;
- enregistrer les entrees de tresorerie ;
- enregistrer les sorties de tresorerie ;
- enregistrer les transferts internes sans les confondre avec une charge ou un produit ;
- proteger les soldes contre les erreurs de saisie ;
- conserver l'historique complet des mouvements ;
- appliquer un circuit de validation avant impact definitif ;
- permettre les rapprochements caisse, banque et mobile money ;
- supprimer les doublons inutiles de contenu, formulaire, CSS, titres, headers, modals et composants caches.

## 3. Perimetre fonctionnel

Inclus :

- positions de tresorerie ;
- mouvements de tresorerie ;
- transferts internes ;
- validation et annulation controlee ;
- justificatifs ;
- journal de tresorerie ;
- rapprochements ;
- tableau de bord ;
- droits utilisateurs ;
- controles anti-doublons ;
- verification Playwright des parcours critiques.

Hors perimetre de cette PRD :

- comptabilite generale complete ;
- declaration fiscale ;
- refonte complete des achats, ventes ou paie ;
- import automatique de releves bancaires ;
- integration bancaire temps reel.

## 4. Acteurs et droits

### Administrateur

Acces complet a la configuration, aux positions, aux mouvements, aux validations, aux annulations et aux rapports.

### Responsable financier

Peut valider, rejeter, annuler selon regle, rapprocher et consulter les soldes.

### Comptable

Peut saisir, modifier les brouillons, soumettre a validation et consulter les journaux autorises.

### Caissier

Peut saisir des mouvements limites aux positions autorisees et consulter ses propres operations.

### Auditeur

Consultation seule, sans modification.

## 5. Architecture fonctionnelle cible

Le module doit etre organise ainsi :

```text
Tresorerie
  Tableau de bord
  Positions de tresorerie
    Caisses
    Banques
    Mobile money
    Cheques a encaisser
    Comptes de transit
  Mouvements
    Entrees
    Sorties
    Transferts internes
  Validations
  Justificatifs
  Rapprochements
    Caisse
    Banque
    Mobile money
  Journal
  Rapports
```

## 6. Modele metier cible

### Position de tresorerie

Une position represente un emplacement ou l'argent existe.

Types attendus :

- `CASH`
- `BANK`
- `MOBILE_MONEY`
- `CHEQUE_IN_TRANSIT`
- `CASH_IN_TRANSIT`
- `OTHER`

Chaque position doit avoir :

- un code unique ;
- un nom ;
- un type ;
- une devise ;
- un statut actif ou inactif ;
- un solde initial ;
- un solde courant calcule ou reconcilie ;
- une trace de creation et de modification.

### Mouvement de tresorerie

Un mouvement represente une operation qui affecte une ou plusieurs positions.

Types attendus :

- `INFLOW` : entree de tresorerie ;
- `OUTFLOW` : sortie de tresorerie ;
- `INTERNAL_TRANSFER` : transfert interne.

Statuts attendus :

- `DRAFT`
- `PENDING_VALIDATION`
- `VALIDATED`
- `REJECTED`
- `CANCELLED`
- `RECONCILED`

## 7. Regles metier obligatoires

### Regles generales

- Un mouvement doit avoir une date, un type, un montant et un motif.
- Le montant doit etre strictement superieur a zero.
- Une position inactive ne doit pas etre selectionnable.
- Un brouillon ne modifie aucun solde.
- Une operation en attente de validation ne modifie aucun solde.
- Seul un mouvement valide modifie les soldes.
- Un mouvement valide ne doit pas etre supprime physiquement.
- Une annulation doit conserver l'operation initiale et creer une trace d'audit.
- Toute modification d'un montant valide doit etre interdite ou realisee par contre-operation.
- Une periode cloturee interdit creation, modification et annulation.
- La reference externe est obligatoire pour banque, cheque et mobile money selon le type d'operation.
- Le justificatif est obligatoire au-dessus d'un seuil configurable et pour les operations bancaires sensibles.

### Regles transfert interne

- La source est obligatoire.
- La destination est obligatoire.
- La source et la destination doivent etre differentes.
- Le transfert interne ne doit pas creer de rubrique de charge ou de produit.
- Le total global de tresorerie doit rester inchange, hors frais explicites.
- Les frais eventuels doivent etre separes du montant transfere.
- Le solde source doit etre suffisant, sauf permission explicite d'exception.
- Le systeme doit afficher le solde source avant transfert et apres transfert.
- Le systeme doit afficher le solde destination avant transfert et apres transfert.
- Le numero de piece doit etre genere automatiquement si l'utilisateur ne le saisit pas.
- Aucun exemple de type `VIR-001` ne doit rester comme placeholder en production.

### Regles de calcul

```text
Solde position =
  solde initial
  + entrees validees
  + transferts entrants valides
  - sorties validees
  - transferts sortants valides
  - frais imputes
```

Pour un transfert interne :

```text
source = source - montant
destination = destination + montant
total tresorerie = stable
```

## 8. Experience utilisateur cible

### Diagnostic de l'ecran actuel

L'ecran actuel est lisible mais pas suffisant pour un usage financier controle. Les defauts a corriger sont :

- modal trop simple pour une operation a impact financier ;
- absence de resume d'impact ;
- absence de solde disponible ;
- absence de selection searchable pour les positions ;
- placeholders avec exemples de test ;
- iconographie SVG inline a remplacer par une bibliotheque d'icones professionnelle si disponible dans le projet ;
- bouton principal trop direct, sans confirmation metier ;
- aucune separation claire entre identification, positions, montant, preuve et validation ;
- aucune aide contextuelle sur les controles obligatoires ;
- aucune alerte visible si source et destination sont identiques avant soumission ;
- aucune protection UX contre les longues listes de positions.

### Formulaire cible

Le formulaire doit etre soit multi-etape, soit organise en sections compactes si le multi-etape n'est pas encore implemente.

Sections minimales :

1. Identification
   - date ;
   - numero de piece genere ;
   - statut ;
   - createur.

2. Positions
   - source ;
   - destination ;
   - recherche par code, nom et type ;
   - solde source visible ;
   - solde destination visible.

3. Montant et reference
   - montant formate XAF ;
   - reference externe si applicable ;
   - frais eventuels ;
   - position supportant les frais si applicable.

4. Motif et justificatif
   - motif obligatoire ;
   - justificatif selon seuil ou type ;
   - observations optionnelles.

5. Controle avant enregistrement
   - resume source vers destination ;
   - impact attendu ;
   - avertissement si solde insuffisant ;
   - bouton de soumission desactive tant que les regles ne sont pas respectees.

### Selection des positions

Les listes simples doivent etre remplacees ou encapsulees par un composant de recherche :

- recherche par code ;
- recherche par nom ;
- filtre par type ;
- affichage du solde ;
- limitation des resultats ;
- chargement pagine ou lazy si la liste depasse 50 elements ;
- aucune preselection automatique source/destination sur une nouvelle operation.

### Textes et placeholders

En production :

- ne pas utiliser de noms exemples ;
- ne pas utiliser de faux numeros ;
- ne pas utiliser d'exemples longs comme placeholder ;
- privilegier un libelle clair et un texte d'aide discret ;
- conserver les textes sur une seule ligne quand c'est lisible ;
- adapter la largeur des boutons au contenu ;
- verifier sidebar, topbar, header, footer, grilles et containers sur desktop et mobile.

## 9. Exigences techniques

### Back-end

Le back-end doit centraliser les validations critiques :

- date requise ;
- montant positif ;
- position source active ;
- position destination active ;
- source differente de destination ;
- solde source suffisant ;
- periode non cloturee ;
- permissions utilisateur ;
- statut autorise ;
- reference externe obligatoire selon mode ;
- justificatif obligatoire selon seuil.

Les operations qui modifient plusieurs soldes doivent etre atomiques. Une erreur partielle ne doit jamais laisser source et destination incoherentes.

### Front-end

Le front-end doit etre un assistant de saisie, pas la source de verite.

Il doit :

- afficher les erreurs avant soumission ;
- empecher les soumissions doubles ;
- desactiver le bouton si le formulaire est invalide ;
- afficher un etat de chargement ;
- afficher les erreurs API ;
- rester lisible sur mobile ;
- ne pas dupliquer header, topbar, sidebar, footer ou modal ;
- ne pas contenir de CSS cache qui contredit les classes visibles ;
- ne pas contenir de balises HTML mal fermees.

### Donnees et migrations

Avant toute migration :

- identifier les tables existantes ;
- verifier les colonnes legacy ;
- sauvegarder ;
- definir le rollback ;
- migrer sans perte ;
- conserver les references historiques.

## 10. API cible

Positions :

- `GET /api/treasury/positions`
- `POST /api/treasury/positions`
- `PATCH /api/treasury/positions/:id`
- `POST /api/treasury/positions/:id/deactivate`

Mouvements :

- `GET /api/treasury/movements`
- `POST /api/treasury/movements`
- `PATCH /api/treasury/movements/:id`
- `POST /api/treasury/movements/:id/submit`
- `POST /api/treasury/movements/:id/validate`
- `POST /api/treasury/movements/:id/reject`
- `POST /api/treasury/movements/:id/cancel`

Rapprochements :

- `GET /api/treasury/reconciliations`
- `POST /api/treasury/reconciliations`
- `POST /api/treasury/reconciliations/:id/validate`

Tableau de bord :

- `GET /api/treasury/dashboard`
- `GET /api/treasury/positions-balances`
- `GET /api/treasury/cash-flow-summary`

## 11. Checklist anti-doublons et qualite HTML/CSS

Avant chaque modification du module :

- chercher les duplications de modal ;
- chercher les duplications d'ID HTML ;
- verifier les labels et titres repetes inutilement ;
- verifier les headers, topbars, sidebars et footers dupliques ;
- verifier les composants caches non utilises ;
- verifier les CSS contradictoires ;
- verifier les SVG inline remplaçables par la bibliotheque d'icones du projet ;
- verifier les placeholders non professionnels ;
- verifier les balises `div`, `form`, `button`, `label` et `select` ;
- verifier que les textes ne debordent pas ;
- verifier que les boutons ne prennent pas une largeur excessive ;
- verifier les grilles mobile et desktop ;
- supprimer uniquement les doublons inutiles apres confirmation qu'ils ne servent pas a un autre module.

Commandes de recherche recommandees :

```bash
rg -n "modal-virement|form-virement|vir-source|vir-destination|Nouveau virement interne" frontend backend tests
rg -n "id=\"[^\"]+\"" frontend/dashboard.html
rg -n "placeholder=\"(Ex:|ex:|Jean|Dupont|VIR-|REC-|DEC-)" frontend
```

## 12. User stories

1. En tant que caissier, je veux saisir un transfert de banque vers caisse, afin que la caisse soit alimentee sans creer une fausse charge.
2. En tant que comptable, je veux voir le solde source avant transfert, afin d'eviter une operation impossible.
3. En tant que responsable financier, je veux valider un mouvement avant impact definitif, afin de garder le controle interne.
4. En tant qu'auditeur, je veux voir qui a cree, modifie, valide ou annule un mouvement, afin de reconstituer l'historique.
5. En tant qu'administrateur, je veux configurer les positions actives, afin d'empecher la saisie sur une caisse fermee.
6. En tant qu'utilisateur, je veux rechercher une position par code ou nom, afin de ne pas parcourir une liste longue.
7. En tant que responsable financier, je veux que source et destination identiques soient bloquees, afin d'eviter les mouvements sans sens.
8. En tant que comptable, je veux joindre un justificatif, afin de documenter l'operation.
9. En tant que manager, je veux consulter les transferts internes du jour, afin de suivre la liquidite.
10. En tant qu'auditeur, je veux que les mouvements valides ne soient pas supprimes, afin de proteger la piste d'audit.
11. En tant que caissier, je veux un formulaire lisible par sections, afin de reduire les erreurs de saisie.
12. En tant que responsable financier, je veux annuler par contre-operation ou statut audite, afin de ne pas effacer le passe.

## 13. Criteres d'acceptation

### CA-001 - Transfert interne valide

Etant donne deux positions actives differentes, quand l'utilisateur soumet un transfert avec montant positif et droits suffisants, alors le mouvement est cree dans le statut attendu et l'impact sur les soldes respecte source moins montant et destination plus montant.

### CA-002 - Source identique destination

Etant donne un transfert interne, quand la source et la destination sont identiques, alors le front-end affiche une erreur et le back-end refuse aussi la requete.

### CA-003 - Solde insuffisant

Etant donne une source sans solde suffisant, quand l'utilisateur tente de soumettre un transfert, alors le systeme bloque l'operation sauf permission explicite et tracee.

### CA-004 - Numero de piece

Etant donne une nouvelle operation, quand le formulaire s'ouvre, alors le numero interne est genere ou affiche comme generation systeme, sans faux exemple en placeholder.

### CA-005 - Liste longue

Etant donne plus de 100 positions, quand l'utilisateur ouvre la selection, alors le composant reste performant, searchable et ne casse pas la modal.

### CA-006 - Justificatif

Etant donne une operation au-dessus du seuil configure, quand l'utilisateur soumet sans justificatif, alors le systeme bloque l'enregistrement.

### CA-007 - Pas de doublons UI

Etant donne le module Tresorerie, quand l'audit statique est execute, alors aucun ID duplique, modal duplique inutile, placeholder de test ou CSS cache contradictoire ne reste dans le parcours critique.

### CA-008 - Verification navigateur

Etant donne l'application lancee en local ou en production controlee, quand Playwright ouvre la page et le modal, alors le formulaire est visible, lisible, sans chevauchement, sans texte coupe et avec les controles attendus.

## 14. Plan de redressement

### Phase 1 - Audit sans modification

- confirmer le bon repertoire ;
- verifier `git status` ;
- localiser tous les composants Tresorerie ;
- localiser les routes API ;
- identifier les tables et migrations existantes ;
- verifier les logs et services sans redemarrage ;
- lister les doublons HTML, CSS et JS ;
- comparer le local WSL et la production VPS uniquement en lecture.

### Phase 2 - Stabilisation metier

- centraliser les regles de validation back-end ;
- supprimer les preselection source/destination sur nouveau virement ;
- imposer source differente destination ;
- ajouter controle solde source ;
- clarifier statut brouillon, attente, valide, annule ;
- definir le comportement exact des encaissements et virements directs.

### Phase 3 - Refonte UX ciblee

- restructurer le modal en sections ou multi-etape ;
- remplacer les listes simples par un select searchable ;
- retirer les placeholders de test ;
- afficher soldes et impact ;
- ajouter resume avant soumission ;
- ajuster boutons, grilles, containers, sidebar et textes longs.

### Phase 4 - Audit et preuves

- ajouter justificatif obligatoire selon seuil ;
- tracer createur, validateur, annulateur ;
- bloquer suppression physique ;
- afficher journal consultable ;
- ajouter export controle si necessaire.

### Phase 5 - Tests et CI/CD

- tests unitaires des regles metier ;
- tests API creation, validation, annulation ;
- tests statiques anti-doublons ;
- tests Playwright desktop et mobile ;
- `npm test` avant commit ;
- commit propre ;
- push ;
- controle GitHub Actions ;
- verification production par lecture uniquement apres deploiement.

## 15. Strategie de tests

Tests back-end :

- creation entree ;
- creation sortie ;
- creation transfert ;
- refus montant nul ;
- refus source egale destination ;
- refus position inactive ;
- refus solde insuffisant ;
- refus periode cloturee ;
- annulation auditee.

Tests front-end :

- ouverture modal ;
- formulaire vide invalide ;
- bouton desactive quand invalide ;
- selection searchable ;
- affichage soldes ;
- resume impact ;
- prevention double submit ;
- affichage erreurs API.

Tests statiques :

- IDs dupliques ;
- placeholders de test ;
- SVG inline dans zones professionnelles ;
- balises HTML mal fermees ;
- classes CSS contradictoires ;
- textes trop longs dans boutons et sidebar.

Tests Playwright :

- desktop ;
- mobile ;
- liste de 100 positions ;
- source identique destination ;
- solde insuffisant ;
- creation reussie avec verification API et donnees.

## 16. Deploiement et rollback

Le site de production ne doit pas etre modifie directement sur le VPS. Toute correction passe par :

1. modification locale dans le bon repertoire ;
2. tests locaux ;
3. commit Git ;
4. push ;
5. CI/CD ;
6. verification production en lecture ;
7. rapport.

Rollback :

- revenir au commit precedent si la CI/CD deploie une regression ;
- restaurer la sauvegarde du fichier modifie si le probleme est documentaire ;
- pour les migrations, fournir un script de rollback avant execution ;
- ne jamais supprimer de donnees de tresorerie sans validation explicite.

## 17. Definition du niveau industriel

Le module pourra etre considere industriel seulement si :

- les regles critiques sont centralisees cote serveur ;
- les flux financiers sont atomiques ;
- les soldes sont coherents et verifiables ;
- les mouvements valides sont immuables ou corriges par contre-operation ;
- les permissions sont appliquees partout ;
- l'audit est complet ;
- l'interface reduit le risque d'erreur ;
- les listes longues restent utilisables ;
- les tests couvrent les parcours critiques ;
- les doublons inutiles et composants caches sont supprimes ;
- la production est mise a jour uniquement par CI/CD ;
- Playwright confirme l'affichage reel, pas seulement le code.

## 18. Notes sur l'etat actuel inspecte

Inspection locale du 2026-06-02 :

- le formulaire visible correspond au modal `modal-virement` dans `frontend/dashboard.html` ;
- le formulaire utilise les champs `vir-date`, `vir-piece`, `vir-libelle`, `vir-source`, `vir-destination`, `vir-montant`, `vir-ref` ;
- le front-end bloque deja source identique destination a la soumission ;
- le back-end bloque aussi source identique destination ;
- les virements sont actuellement inseres avec statut `valide`, donc impact immediat ;
- les decaissements suivent un flux different avec `en_attente` et `brouillon` ;
- les placeholders de type exemple existent encore dans le formulaire ;
- les positions sont remplies par une fonction de liste simple ;
- la PRD exige de corriger ces points avant d'affirmer un niveau industriel.
