# 07 — Audit Budget

## 1. Verdict provisoire

**Budget : non exploitable comme contrôle financier prouvé.**

Le PRD Finance exige que chaque opération puisse impacter un budget et que les dépassements soient contrôlés avant engagement ou réalisation. Le dépôt contient des indices d’intégration budgétaire :

- `operations.budget_status` ;
- `accounting_entry_lines.budget_line_id` ;
- des mentions du budget dans les PRD, le tableau de contrôle et les contrats UI ;
- des lignes comptables capables de transporter une référence budgétaire lors d’une contre-écriture.

Mais cette passe n’a pas trouvé de moteur budgétaire canonique complet, ni de schéma clairement identifié pour :

- budget annuel ou périodique ;
- ligne budgétaire ;
- enveloppe ;
- engagement ;
- consommation / réalisation ;
- disponible ;
- transfert budgétaire ;
- réservation concurrente ;
- annulation d’engagement ;
- dépassement autorisé ;
- clôture budgétaire.

La présence d’un champ `budget_status` ne vaut donc pas intégration budgétaire.

## 2. Exigence cible

La chaîne cible est :

```text
Besoin ou document source
→ contrôle de disponibilité
→ engagement budgétaire
→ approbation
→ commande / dette
→ paiement
→ réalisation budgétaire
→ comptabilité
→ reporting
→ audit
```

Un paiement ne doit pas être le premier moment où le budget est vérifié.

## 3. État observé

### 3.1 Opérations financières

Le service `finance-operation-canonical.js` initialise :

```text
budget_status = pending
```

pour les encaissements, décaissements et virements.

Lors du paiement canonique d’un décaissement, le service remet également :

```text
budget_status = pending
```

Aucun appel à un service budgétaire n’est visible dans ce flux observé.

### 3.2 Comptabilité

Les lignes comptables possèdent potentiellement `budget_line_id`.

La contre-écriture recopie cette valeur depuis l’écriture d’origine.

Mais la génération standard observée crée les lignes sans renseigner `budget_line_id`.

### 3.3 Fondation ERP finance

La migration `031_finance_operations_erp_foundation.sql` crée :

- `finance_source_documents` ;
- `payment_allocations` ;
- `finance_operation_events` ;
- les statuts métier, approbation, paiement et rapprochement.

Elle ne crée pas de tables budgétaires ni de mécanisme d’engagement.

## 4. Anomalies

## BUD-001 — Aucun moteur budgétaire canonique prouvé

- **Gravité : critique**
- **Exigence PRD :** contrôle du budget avant engagement ou réalisation.
- **Preuve :** présence de champs et références budgétaires, mais aucun service canonique de réservation / consommation identifié.
- **Scénario :** créer puis payer un décaissement avec `budget_status='pending'`.
- **Conséquence métier :** une dépense peut être autorisée et payée sans contrôle d’enveloppe.
- **Correction minimale :** créer d’abord le contrat et le schéma canonique, pas une simple mise à jour de statut.
- **Tests :** budget disponible, insuffisant, concurrent, clôturé, override.
- **Risque de régression :** élevé.
- **Statut : absent ou non prouvé.**

## BUD-002 — `budget_status` décoratif

- **Gravité : haute**
- **Preuve :** le statut est initialisé et réinitialisé à `pending`, sans effet observé sur le workflow.
- **Conséquence métier :** l’interface peut afficher un état budgétaire sans qu’aucun calcul réel ne le soutienne.
- **Correction minimale :** définir des états canoniques liés à des écritures d’engagement réelles.
- **Statut : ouvert.**

## BUD-003 — Absence de séparation engagement / réalisation

- **Gravité : critique**
- **Exigence PRD :** distinguer budget engagé et budget réalisé.
- **Preuve :** aucune structure canonique observée pour les deux dimensions.
- **Conséquence métier :** les commandes non payées peuvent ne pas réduire le disponible ; les paiements peuvent consommer deux fois si un engagement est ajouté plus tard.
- **Correction minimale :** ledger budgétaire append-only avec types `commitment`, `release`, `actual`, `reversal`, `transfer`.
- **Tests :** commande puis paiement, annulation, réception partielle, paiement partiel.
- **Statut : absent.**

## BUD-004 — Pas de verrouillage concurrent de l’enveloppe

- **Gravité : critique**
- **Scénario :** deux utilisateurs engagent simultanément la dernière tranche disponible.
- **Conséquence métier :** double consommation et dépassement malgré deux contrôles individuels verts.
- **Correction minimale :** verrou `FOR UPDATE` sur l’enveloppe ou modèle append-only avec contrôle transactionnel.
- **Tests :** deux transactions concurrentes MySQL, une seule réussite.
- **Statut : non prouvé.**

## BUD-005 — Pas de source budgétaire structurée dans l’opération

- **Gravité : haute**
- **Preuve :** `operations` ne démontre pas ici de référence obligatoire à une ligne budgétaire ; seule la ligne comptable peut transporter `budget_line_id`.
- **Conséquence métier :** le budget est affecté trop tard ou manuellement au niveau comptable.
- **Correction minimale :** rattacher le document source ou l’opération à une ligne budgétaire avant approbation.
- **Statut : ouvert.**

## BUD-006 — Aucun contrôle budgétaire dans le paiement canonique observé

- **Gravité : critique**
- **Preuve :** `payCanonicalDisbursement()` valide la position, le statut, le solde et le ledger, mais aucun budget.
- **Conséquence métier :** une caisse peut avoir les fonds tandis que la dépense dépasse le budget autorisé.
- **Correction minimale :** intégrer l’autorisation budgétaire dans la transaction d’approbation ou d’engagement, puis vérifier la cohérence au paiement.
- **Tests :** paiement d’une dépense non engagée refusé ou marqué en exception autorisée.
- **Statut : ouvert.**

## BUD-007 — Aucun lien prouvé avec achats et fournisseurs

- **Gravité : critique**
- **Exigence PRD :** Demande → validation → commande → réception → dette → paiement avec contrôle budget.
- **Preuve :** la chaîne budgétaire n’est pas démontrée dans les fichiers inspectés.
- **Conséquence métier :** le budget peut être contrôlé après la commande ou jamais.
- **Correction minimale :** définir le moment exact de l’engagement, probablement à l’approbation de la demande ou de la commande.
- **Statut : impossible à vérifier.**

## BUD-008 — Aucun workflow de dépassement / override

- **Gravité : haute**
- **Conséquence métier :** soit les dépassements sont silencieux, soit les utilisateurs contournent le système.
- **Correction minimale :** workflow explicite avec seuil, justification, autorité, audit, durée et impact reporting.
- **Tests :** dépassement refusé, override DG, override expiré.
- **Statut : absent.**

## BUD-009 — Aucun transfert budgétaire canonique

- **Gravité : haute**
- **Exigence :** déplacer une enveloppe sans modifier le budget total.
- **Correction minimale :** opération à deux jambes, source négative et destination positive, validée et auditée.
- **Tests :** double validation, période clôturée, transfert concurrent.
- **Statut : absent ou non prouvé.**

## BUD-010 — Aucun contrôle de période budgétaire

- **Gravité : haute**
- **Preuve :** les services inspectés contrôlent les périodes comptables mensuelles, pas une période budgétaire distincte.
- **Conséquence métier :** engagement possible sur budget expiré ou non approuvé.
- **Correction minimale :** cycle `draft → submitted → approved → active → closed` pour le budget et ses versions.
- **Statut : absent.**

## BUD-011 — Aucune preuve de versionnement

- **Gravité : haute**
- **Conséquence métier :** modifier une enveloppe historique peut recalculer silencieusement les rapports.
- **Correction minimale :** versions de budget et événements d’ajustement, jamais réécriture silencieuse du montant approuvé.
- **Statut : non prouvé.**

## BUD-012 — Reporting budgétaire non fiable tant que les sources ne sont pas canoniques

- **Gravité : haute**
- **Conséquence métier :** les indicateurs prévu / engagé / réalisé / payé peuvent agréger des données de statuts incompatibles.
- **Correction minimale :** reporting uniquement depuis le ledger budgétaire et les documents sources liés.
- **Statut : non prouvé.**

## 5. Modèle canonique proposé

### 5.1 Tables principales

```text
budgets
budget_versions
budget_lines
budget_events
budget_allocations
budget_overrides
```

### 5.2 Événements budgétaires

```text
opening
commitment
commitment_release
actual
actual_reversal
transfer_out
transfer_in
adjustment
closure
reopening
```

### 5.3 Invariants

1. Le budget approuvé est versionné.
2. Le disponible = approuvé + ajustements + transferts entrants - transferts sortants - engagements ouverts - réalisations non issues d’un engagement.
3. Une réalisation issue d’un engagement libère l’engagement correspondant et crée l’impact réel sans double consommation.
4. Une annulation produit un événement inverse.
5. Une période clôturée interdit tout nouvel événement rétroactif.
6. Aucun dépassement sans override explicite.
7. Toute écriture budgétaire a une source métier.
8. Toute opération payée nécessitant un budget est liée à une allocation budgétaire valide.

## 6. Workflow cible

| État source | Action | Rôle / permission | Condition | État cible | Effet |
|---|---|---|---|---|---|
| draft | soumettre budget | budget.submit | lignes complètes | submitted | audit |
| submitted | approuver | budget.approve | séparation des fonctions | approved | version figée |
| approved | activer | budget.activate | période valide | active | disponible calculable |
| active | engager | budget.commit | disponible suffisant | active | événement commitment |
| active | autoriser dépassement | budget.override | motif et plafond | active | override auditée |
| active | réaliser | budget.actualize | source valide | active | actual + libération engagement |
| active | transférer | budget.transfer | source suffisante | active | deux événements liés |
| active | clôturer | budget.close | aucune anomalie | closed | verrouillage |
| closed | réouvrir | budget.reopen | autorité + motif | active | audit renforcé |

## 7. Tests obligatoires

- création et approbation d’un budget ;
- engagement simple ;
- engagement concurrent ;
- engagement insuffisant ;
- commande annulée ;
- paiement partiel ;
- réception partielle ;
- paiement sans engagement ;
- réalisation avec et sans engagement ;
- transfert entre lignes ;
- override de dépassement ;
- clôture et réouverture ;
- rollback MySQL complet ;
- exactitude décimale ;
- reporting prévu / engagé / réalisé / payé.

## 8. Conclusion

Le budget est actuellement une exigence documentaire et un ensemble de champs d’intégration, pas encore un moteur prouvé. Il ne doit pas être présenté comme opérationnel tant qu’un ledger budgétaire, des engagements atomiques, des contrôles de concurrence et une liaison aux achats et décaissements ne sont pas démontrés.

La prochaine étape documentaire logique est `08-achats-stock-fournisseurs.md`, afin de déterminer précisément où naît l’engagement budgétaire et comment la dette fournisseur est créée puis soldée.
