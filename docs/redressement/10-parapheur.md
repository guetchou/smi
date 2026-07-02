# 10 — Audit Parapheur numérique

## 1. Verdict provisoire

**Parapheur : partiellement exploitable comme file de décision, non industrialisé comme moteur unique d’approbation, de signature et de synchronisation métier.**

Le dépôt contient :

- plusieurs types de documents ;
- transmission par assistante ;
- décision DG ;
- avis, délégation, correction et éclaircissement ;
- priorités et échéances ;
- intérim ;
- historique d’actions ;
- notifications et emails ;
- référence vers un document source ;
- connecteur transactionnel pour certains modules critiques ;
- prévention partielle des doublons ouverts.

Mais l’approbation du parapheur et l’état du document source ne sont pas encore garantis dans une transaction unique sur tous les chemins. La synchronisation source ne couvre actuellement qu’un sous-ensemble très limité, principalement les décaissements.

## 2. Modèle observé

### 2.1 Types acceptés

```text
decaissement
paiement_cnss
paiement_dgi
demande_achat
facture_fournisseur
conge
avance_salaire
revision_salariale
offboarding
contrat
attestation_stage
facture_client
correspondance
reclamation_agent
amelioration_agent
```

### 2.2 États principaux

Le code observé utilise notamment :

```text
en_attente_assistante
transmis_dg
en_avis
delegue
approuve
rejete
```

Les états `approuve` et `rejete` sont finaux.

### 2.3 Connecteur transactionnel

`creerEntreeParapheurDansTransaction()` :

- exige une transaction asynchrone ;
- valide type, titre et initiateur ;
- recherche une entrée ouverte existante pour la même source ;
- crée l’entrée ;
- crée l’action initiale ;
- crée l’audit dans la même transaction.

Cette brique est cohérente pour la création connectée.

### 2.4 Synchronisation vers la source

`syncSourceDecision()` ne démontre actuellement une synchronisation effective que pour :

```text
ref_source_table = operations
type = decaissement
```

Une approbation passe `dec_statut` à `valide`; un rejet passe `dec_statut` à `rejete`.

Les autres types retournent `unsupported_source_type`.

## 3. Anomalies

### PAR-001 — Décision parapheur et source non atomiques

- Gravité : critique.
- Preuve : synchronisation source, mise à jour du parapheur, journal d’action et audit sont exécutés par appels séparés dans les routes.
- Conséquence : source approuvée mais parapheur non finalisé, ou inversement.
- Correction : service de décision transactionnel unique.

### PAR-002 — Synchronisation source presque limitée au décaissement

- Gravité : critique.
- Preuve : les autres types sont explicitement marqués non supportés.
- Conséquence : congé, achat, contrat, facture ou offboarding peuvent être approuvés dans le parapheur sans effet fiable dans leur module.
- Correction : adaptateurs source typés et obligatoires pour chaque type décisionnel.

### PAR-003 — Approbation finale malgré synchronisation ignorée

- Gravité : critique.
- Preuve : la route met le parapheur à `approuve` même si le résultat est `skipped`.
- Conséquence : interface montrant une décision exécutée alors que le document source n’a pas changé.
- Correction : distinguer `decision_recorded`, `source_sync_pending`, `source_synced`, `source_sync_failed`; ne pas présenter la décision comme exécutée tant que la synchronisation requise échoue.

### PAR-004 — Source déjà validée traitée comme synchronisation ignorée

- Gravité : haute.
- Preuve : un décaissement déjà `valide` ou `paye` retourne `operation_already_paid_or_validated`.
- Conséquence : parapheur éventuellement créé trop tard sur une opération déjà effective.
- Correction : empêcher l’entrée au parapheur après effet financier ou signaler une anomalie bloquante.

### PAR-005 — Permissions par rôles

- Gravité : critique.
- Preuve : décisions et visibilité reposent sur `dg`, `manager`, `assistante_direction`, `admin` via `hasRole()`.
- Conséquence : contournement du modèle de permissions effectives.
- Correction : permissions distinctes : soumettre, filtrer, transmettre, demander avis, approuver, rejeter, consulter confidentiel, administrer intérim.

### PAR-006 — Visibilité trop large des demandes déléguées ou en avis

- Gravité : critique.
- Preuve : le détail est visible à tout utilisateur si le statut est `delegue` ou `en_avis`, sans preuve qu’il soit le destinataire.
- Conséquence : fuite de documents confidentiels.
- Correction : contrôle par destinataire, groupe autorisé, niveau de confidentialité et portée organisationnelle.

### PAR-007 — Priorité `confidentiel` traitée comme priorité et non comme classification d’accès

- Gravité : critique.
- Conséquence : un document confidentiel peut seulement être trié différemment sans restriction d’accès renforcée.
- Correction : séparer `priority` et `classification`.

### PAR-008 — Pièces jointes stockées comme JSON sans version documentaire prouvée

- Gravité : critique.
- Preuve : `pieces_jointes` est sérialisé dans la ligne parapheur.
- Conséquence : impossibilité de prouver quelle version exacte a été approuvée.
- Correction : document, version, empreinte, taille, type MIME, stockage, auteur et horodatage.

### PAR-009 — Aucune signature numérique probante

- Gravité : critique.
- Preuve : approbation et signature ne sont pas distinguées comme objets cryptographiquement liés à une version.
- Conséquence : le parapheur ne peut pas servir de preuve de signature contractuelle.
- Correction : signature séparée, identité forte, empreinte du document et politique juridique.

### PAR-010 — Audit de synchronisation non bloquant

- Gravité : critique.
- Preuve : `auditSourceSync()` ignore les erreurs.
- Conséquence : décision ou synchronisation sans preuve durable.
- Correction : audit dans la transaction ou outbox fiable.

### PAR-011 — Notifications non bloquantes sans reprise durable

- Gravité : haute.
- Preuve : erreurs de notification et email ignorées.
- Conséquence : décision valide mais acteur non informé.
- Correction : outbox, statut d’envoi, retry et supervision.

### PAR-012 — Création directe par route hors connecteur canonique

- Gravité : haute.
- Preuve : `POST /api/parapheur` insère directement dans les tables au lieu d’utiliser systématiquement le connecteur transactionnel.
- Conséquence : règles de doublon et audit différents selon le chemin.
- Correction : un seul service de création.

### PAR-013 — Prévention des doublons insuffisante au niveau base

- Gravité : haute.
- Preuve : recherche préalable d’une entrée ouverte, sans contrainte unique prouvée.
- Conséquence : deux requêtes concurrentes peuvent créer deux parapheurs pour la même source.
- Correction : clé d’idempotence ou contrainte unique adaptée.

### PAR-014 — Intermédiaires et délégations distincts du moteur canonique

- Gravité : critique.
- Preuve : `parapheur_interim` et états `delegue` existent indépendamment de `delegation_engine`.
- Conséquence : règles d’intérim, plafonds, cycles et droits incohérents avec le système global.
- Correction : intégrer l’autorité de décision au moteur canonique de délégation.

### PAR-015 — Un intérim global unique

- Gravité : haute.
- Preuve : récupération du dernier intérim actif sans périmètre explicite.
- Conséquence : un remplacement peut affecter tous les documents et rôles.
- Correction : périmètre, période, permission et titulaire précis.

### PAR-016 — Rôle de l’assistante ambigu

- Gravité : haute.
- Preuve : l’assistante peut transmettre et rejeter certaines demandes.
- Conséquence : confusion entre contrôle de forme et décision métier.
- Correction : définir si le rejet assistante est un retour pour correction ou une décision finale; ne pas confondre les deux.

### PAR-017 — Rejet assistante synchronise la source comme rejet final

- Gravité : critique.
- Preuve : `rejeter-assistante` appelle `syncSourceDecision(..., 'rejete')` puis clôture le parapheur.
- Conséquence : une assistante peut rejeter définitivement un décaissement source.
- Correction : statut `returned_for_correction` distinct, sauf permission explicite de rejet métier.

### PAR-018 — Manager assimilé au DG

- Gravité : critique.
- Preuve : approbation et rejet sont autorisés à `dg` ou `manager`.
- Conséquence : tout manager historique peut prendre une décision réservée au DG.
- Correction : permission et seuil de décision explicites.

### PAR-019 — Mise à jour source basée sur anciens statuts

- Gravité : haute.
- Preuve : manipulation directe de `dec_statut` et `statut` historiques.
- Conséquence : divergence avec workflow canonique multidimensionnel.
- Correction : appeler le service métier du module source, jamais modifier directement ses colonnes.

### PAR-020 — Historique limité et non immuable prouvé

- Gravité : haute.
- Preuve : liste limitée à 200 éléments; aucune politique d’immutabilité DB ou d’archivage n’est démontrée.
- Conséquence : audit incomplet pour contrôle ou contentieux.
- Correction : pagination complète, rétention, export et interdiction de modification/suppression.

### PAR-021 — Alertes d’échéance seulement consultables

- Gravité : moyenne.
- Preuve : endpoint de liste, sans preuve d’escalade durable.
- Conséquence : échéance dépassée sans traitement.
- Correction : job d’escalade, notification persistante et responsable.

### PAR-022 — Absence de matrice type → workflow

- Gravité : critique.
- Preuve : tous les types utilisent essentiellement la même structure générale.
- Conséquence : un congé, un contrat, une facture ou un décaissement peuvent exiger des étapes, pièces et autorités différentes non contrôlées.
- Correction : définition versionnée par type, montant, service, risque et confidentialité.

## 4. Points positifs

- Le connecteur transactionnel de création est une bonne base.
- Les actions sont historisées séparément.
- Les décisions finales sont protégées contre une nouvelle action simple.
- Les motifs de rejet DG sont obligatoires.
- La référence vers la source permet une orchestration future.
- La détection d’une entrée ouverte existante limite certains doublons.

## 5. Modèle canonique proposé

```text
approval_case
approval_case_source
approval_workflow_definition
approval_step
approval_assignment
approval_decision
approval_document_version
approval_signature
approval_event
approval_sync_outbox
```

### États séparés

```text
case_status
workflow_status
decision_status
source_sync_status
signature_status
notification_status
```

## 6. Invariants obligatoires

1. Une décision porte sur une version documentaire immuable.
2. Une décision finale et son effet source sont atomiques ou orchestrés durablement.
3. Un type ne peut être approuvé sans adaptateur source supporté.
4. Une synchronisation ignorée n’est jamais présentée comme exécutée.
5. Un document confidentiel n’est visible qu’aux personnes explicitement autorisées.
6. Toute délégation vient du moteur canonique.
7. L’assistante ne prend pas une décision finale sans permission explicite.
8. Une source ne possède qu’un dossier d’approbation actif par workflow.
9. Toute décision conserve acteur, autorité, délégation, commentaire, date et version.
10. Les notifications sont reprenables.
11. Les actions et audits sont immuables.
12. Aucun module source n’est modifié directement par SQL depuis le parapheur; son service métier est appelé.

## 7. Ordre de redressement

### P0

1. Corriger la visibilité `delegue/en_avis`.
2. Séparer confidentialité et priorité.
3. Interdire le rejet métier par l’assistante sans permission.
4. Remplacer les rôles par permissions effectives.
5. Créer un service transactionnel unique de décision.
6. Bloquer les types sans synchronisation source supportée.
7. Faire appeler les services métier sources.
8. Rendre audit et synchronisation durables.

### P1

1. Workflow versionné par type.
2. Versions documentaires avec empreinte.
3. Intégration au moteur de délégation.
4. Outbox de notifications et synchronisation.
5. Signature numérique selon le niveau juridique requis.

## 8. Conclusion

Le parapheur est une bonne file de traitement, mais pas encore un moteur probant de décision transversale. Le risque principal est qu’une demande apparaisse approuvée alors que son module source n’a pas été synchronisé. Le risque de confidentialité est également critique : un document en avis ou délégué peut être visible trop largement.

La prochaine étape logique est `11-audit-notifications.md`, afin de traiter les erreurs ignorées, la durabilité des traces, les notifications et les reprises après échec.
