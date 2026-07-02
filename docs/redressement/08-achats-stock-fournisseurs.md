# 08 — Audit Achats, Stock et Fournisseurs

## 1. Verdict provisoire

**Achats / Stock / Fournisseurs : partiellement exploitable, chaîne bout en bout non conforme et non prouvée.**

Le dépôt contient plusieurs briques réelles et parfois bien testées :

- demandes d’achat ;
- bons de commande fournisseurs ;
- réceptions partielles ou totales ;
- lignes de réception ;
- factures fournisseurs ;
- rapprochement commande / réception / facture ;
- paiement fournisseur transactionnel ;
- mouvements de stock ;
- tests MySQL de réception stock et de paiement fournisseur ;
- audit de certaines transitions.

Mais la chaîne complète reste fragmentée entre anciens chemins SQLite, nouveaux services MySQL, routes historiques, services spécialisés et opérations financières génériques.

La faiblesse majeure est la suivante : une demande d’achat approuvée peut encore générer directement un décaissement avant qu’un bon de commande, une réception conforme et une facture validée existent.

## 2. Chaîne métier cible

```text
Demande d’achat
→ contrôle budget
→ approbation
→ bon de commande
→ envoi fournisseur
→ réception physique
→ contrôle qualité et quantité
→ entrée en stock
→ facture fournisseur
→ rapprochement 3 voies
→ dette fournisseur
→ autorisation de paiement
→ paiement
→ trésorerie
→ comptabilité OHADA
→ réalisation budgétaire
→ audit
```

Aucune étape ne doit être remplacée silencieusement par une autre.

## 3. Modèle observé

### 3.1 Demandes d’achat

La migration `008_achats.sql` définit :

- `demandes_achat` ;
- `demandes_achat_lignes` ;
- statuts principalement `brouillon`, `soumis`, `approuve`, `rejete` ;
- lien direct `decaissement_id` vers `operations`.

La route historique `backend/routes/achats.js` documente explicitement :

```text
Workflow : brouillon → soumis → approuve | rejete
Approbation génère automatiquement un décaissement
```

### 3.2 Bons de commande

`bons_commandes_fournisseurs` possède un workflow plus détaillé :

```text
brouillon
soumis
valide
envoye
accepte_fournisseur
partiellement_livre
livre
annule
cloture
```

Les lignes portent quantité commandée, quantité reçue, prix, taxe et référence produit.

### 3.3 Réceptions

`receptions` possède les états :

```text
en_cours
reception_partielle
reception_totale
ecart_quantite
non_conforme
retourne
accepte
```

Les lignes distinguent quantité commandée, reçue, conforme, écart et motif.

### 3.4 Stock

Un service spécialisé `stock_receipt_validation_workflow` est testé sous MySQL.

Le scénario de test prouve qu’une validation de réception :

- augmente `produits.stock_disponible` ;
- crée un `stock_mouvements` de type `entree` ;
- stocke quantité avant et après ;
- passe la réception à `accepte` ;
- écrit un audit ;
- rollbacke stock, mouvement, statut et audit en cas d’erreur forcée.

Cette partie est l’une des briques les mieux prouvées du domaine.

### 3.5 Factures fournisseurs

`factures_fournisseurs` stocke :

- fournisseur ;
- bon de commande ;
- réception ;
- montant HT / TTC ;
- échéance ;
- montant payé ;
- reste à payer ;
- statut ;
- rapprochement ;
- écarts de montant et de quantité ;
- opération de paiement liée.

Une contrainte unique empêche le même numéro de facture chez le même fournisseur.

### 3.6 Rapprochement 3 voies

`supplier_payment_workflow.js` calcule le rapprochement entre :

- bon de commande ;
- réceptions ;
- facture fournisseur.

Le paiement est bloqué si :

- aucun BC n’est lié ;
- aucune réception n’existe ;
- une réception désignée est non conforme ;
- la facture dépasse le montant reçu conforme ;
- l’écart de montant dépasse le seuil configuré ;
- le rapprochement est contesté ou bloquant, sauf override autorisé et motivé.

### 3.7 Paiement fournisseur

Le service `paySupplierInvoice()` :

- verrouille la facture avec `FOR UPDATE` ;
- exige une facture validée ou partiellement payée ;
- contrôle le rapprochement ;
- interdit de payer au-delà du reste ;
- sélectionne une position de trésorerie ;
- crée une opération de décaissement directement `valide/paye` ;
- met à jour montant payé, reste et statut facture ;
- audite ;
- effectue le tout dans une transaction.

Il ne démontre cependant pas, dans ce service, le posting vers le ledger canonique, la génération comptable, le contrôle budget ou l’allocation à un document financier canonique.

## 4. Anomalies

## PUR-001 — Approbation d’une demande génère directement un décaissement

- **Gravité : critique**
- **Exigence :** demande → BC → réception → facture → paiement.
- **Preuve :** `approuverDemandeAchat()` insère immédiatement une opération de décaissement validée après approbation de la demande.
- **Scénario :** approuver une demande avant choix final du fournisseur ou réception.
- **Conséquence métier :** création prématurée d’une dette ou d’un paiement sans facture ni service fait.
- **Correction minimale :** l’approbation doit créer une autorisation d’achat ou un engagement budgétaire, jamais un décaissement payé ou payable.
- **Tests :** approbation sans BC, sans réception, sans facture ; aucun mouvement financier.
- **Risque de régression :** critique.
- **Statut : ouvert.**

## PUR-002 — Route achats historique utilise `backend/database.js`

- **Gravité : critique**
- **Preuve :** `backend/routes/achats.js` importe `../database`, utilise `db.prepare`, `date('now')`, `datetime('now')` et syntaxe SQLite.
- **Conséquence métier :** divergence avec le contrat MySQL de production et comportement potentiellement différent selon montage de route.
- **Correction minimale :** identifier si cette route est réellement montée ; migrer vers `backend/db.js` et services MySQL, ou la désactiver après preuve de non-utilisation.
- **Tests :** smoke API MySQL sur toutes les routes achats.
- **Risque :** élevé.
- **Statut : ouvert.**

## PUR-003 — Deux chemins de paiement fournisseur

- **Gravité : critique**
- **Preuve :** la route historique contient `syncPaiementFournisseur()` ; un service MySQL dédié `supplier_payment_workflow.js` existe également.
- **Conséquence métier :** un chemin peut appliquer rapprochement et rollback, l’autre les contourner.
- **Correction minimale :** un seul service public canonique de paiement fournisseur ; interdiction des insertions directes dans `operations` depuis les routes.
- **Tests :** recherche de dépendances et tests négatifs contre les chemins historiques.
- **Statut : ouvert.**

## PUR-004 — Paiement fournisseur hors ledger canonique

- **Gravité : critique**
- **Preuve :** `paySupplierInvoice()` insère directement une opération `valide/paye` mais n’appelle pas `postOperationToLedgerInContext()` dans le code observé.
- **Conséquence métier :** facture marquée payée sans mouvement dans `cash_ledger` ni mise à jour garantie de `cashbox_balances`.
- **Correction minimale :** utiliser `payCanonicalDisbursement()` ou intégrer le posting ledger dans la même transaction.
- **Tests :** paiement fournisseur → exactement une jambe débit, cache mis à jour, rollback global.
- **Statut : ouvert.**

## PUR-005 — Paiement fournisseur hors comptabilité automatique prouvée

- **Gravité : critique**
- **Preuve :** le service crée l’opération et met à jour la facture, mais ne génère ni ne poste l’écriture comptable dans la transaction observée.
- **Conséquence métier :** dette soldée et trésorerie potentiellement affectée sans comptabilité fournisseur.
- **Correction minimale :** créer un document financier source puis une écriture comptable liée ; anomalie bloquante si génération impossible.
- **Tests :** facture payée avec écriture fournisseur / trésorerie équilibrée.
- **Statut : ouvert.**

## PUR-006 — Aucun contrôle budgétaire prouvé

- **Gravité : critique**
- **Preuve :** ni l’approbation de demande ni le paiement fournisseur observé n’appellent un moteur budgétaire.
- **Conséquence métier :** achat et paiement possibles sans enveloppe disponible.
- **Correction minimale :** engagement à l’approbation ou au BC, réalisation à la facture/réception selon règle métier.
- **Tests :** budget insuffisant, engagement concurrent, annulation de commande.
- **Statut : ouvert.**

## PUR-007 — Sélection automatique dangereuse de position de trésorerie

- **Gravité : haute**
- **Preuve :** si aucune position n’est fournie, le service choisit la première caisse ou banque active.
- **Conséquence métier :** paiement imputé à la mauvaise caisse ou banque.
- **Correction minimale :** position obligatoire, autorisée pour le payeur et cohérente avec le mode de paiement.
- **Tests :** absence de position refusée ; caisse non affectée refusée.
- **Statut : ouvert.**

## PUR-008 — Catégorie comptable sélectionnée heuristiquement

- **Gravité : haute**
- **Preuve :** recherche par nom contenant achat, fournisseur ou charge, sinon première catégorie de dépense.
- **Conséquence métier :** mauvaise imputation comptable et budgétaire.
- **Correction minimale :** catégorie canonique issue de la facture, du BC ou du document source ; aucun fallback silencieux.
- **Tests :** catégorie absente bloque le paiement.
- **Statut : ouvert.**

## PUR-009 — Référence de paiement fallback potentiellement dupliquée

- **Gravité : haute**
- **Preuve :** fallback `FF-${invoice.id}` ; l’unicité n’est pas contrôlée dans ce service avant insertion.
- **Conséquence métier :** risque de double paiement ou collision selon les contraintes réelles.
- **Correction minimale :** référence externe obligatoire selon mode et contrôle d’unicité canonique.
- **Tests :** deuxième paiement avec même référence refusé, sauf paiement partiel explicitement séquencé.
- **Statut : ouvert.**

## PUR-010 — Une facture ne conserve qu’un seul `operation_id`

- **Gravité : haute**
- **Preuve :** `factures_fournisseurs.operation_id` est remplacé à chaque paiement ; le modèle autorise pourtant `partiellement_payee`.
- **Conséquence métier :** perte du lien vers les paiements précédents ou impossibilité de reconstituer l’historique complet.
- **Correction minimale :** table d’allocation paiement ↔ facture, une ligne par paiement, avec reversal.
- **Tests :** trois paiements partiels, annulation du deuxième, reste exact.
- **Statut : ouvert.**

## PUR-011 — Rapprochement quantité agrégé sans contrôle des doublons de réception

- **Gravité : haute**
- **Preuve :** somme de toutes les quantités conformes par ligne de BC.
- **Conséquence métier :** une réception dupliquée peut surévaluer le reçu conforme.
- **Correction minimale :** idempotence de validation, unicité des mouvements et contrôle quantité cumulée <= commandée sauf tolérance approuvée.
- **Tests :** double validation de la même réception, réception excédentaire.
- **Statut : à vérifier.**

## PUR-012 — Statut du BC et réception non prouvés synchronisés atomiquement

- **Gravité : haute**
- **Preuve :** la réception et le stock sont transactionnels, mais la mise à jour des quantités reçues et du statut global du BC n’est pas prouvée dans cette passe.
- **Conséquence métier :** stock accepté avec BC encore `partiellement_livre` ou quantités incohérentes.
- **Correction minimale :** service unique réception → lignes BC → mouvement stock → statut BC → audit.
- **Tests :** réception partielle, totale, retour, non-conformité.
- **Statut : impossible à vérifier.**

## PUR-013 — Retour fournisseur et décrément de stock non prouvés

- **Gravité : haute**
- **Preuve :** statuts `retourne` existent, mais aucun workflow de sortie de stock lié n’a été démontré.
- **Conséquence métier :** produits retournés toujours comptés disponibles.
- **Correction minimale :** mouvement stock inverse lié à la réception d’origine.
- **Tests :** retour partiel, total, double retour interdit.
- **Statut : non prouvé.**

## PUR-014 — Dette fournisseur non portée par le document financier canonique

- **Gravité : haute**
- **Preuve :** `finance_source_documents` existe mais la facture fournisseur observée conserve elle-même `reste_a_payer` et `operation_id`.
- **Conséquence métier :** deux modèles de dette et d’allocation peuvent diverger.
- **Correction minimale :** synchroniser la facture validée vers `finance_source_documents`, puis utiliser `payment_allocations` pour chaque règlement.
- **Tests :** facture, avoir, paiement partiel, reversal, solde auxiliaire fournisseur.
- **Statut : ouvert.**

## PUR-015 — Permissions hybrides

- **Gravité : haute**
- **Preuve :** routes achats utilisent permissions effectives et fallback de rôles historiques ; délégations anciennes `delegations_approbation` coexistent avec le moteur canonique de délégation.
- **Conséquence métier :** approbation ou paiement possible via un ancien rôle ou une ancienne délégation.
- **Correction minimale :** permissions effectives uniquement et moteur canonique de délégation.
- **Tests :** rôle seul sans permission refusé ; délégation expirée refusée.
- **Statut : ouvert.**

## PUR-016 — Audit historique non fiable

- **Gravité : haute**
- **Preuve :** `auditOperation()` dans la route historique capture et ignore toute erreur.
- **Conséquence métier :** approbation et création de décaissement possibles sans trace.
- **Correction minimale :** audit dans la transaction métier, erreur bloquante ou mécanisme outbox fiable.
- **Statut : ouvert.**

## PUR-017 — Quantité de demande stockée en texte

- **Gravité : moyenne**
- **Preuve :** `demandes_achat_lignes.quantite` est `VARCHAR(100)` alors que les BC utilisent `DECIMAL(10,3)`.
- **Conséquence métier :** conversion ambiguë, unités mélangées et impossibilité de comparaison fiable demande / commande.
- **Correction minimale :** quantité décimale + unité structurée.
- **Tests :** pièces, kilogrammes, litres, quantités fractionnaires.
- **Statut : ouvert.**

## PUR-018 — Validation métier de la facture insuffisamment séparée

- **Gravité : haute**
- **Preuve :** le service de paiement exige seulement statut `validee` ou `partiellement_payee`; la séparation entre contrôleur facture, approbateur paiement et payeur n’est pas démontrée ici.
- **Conséquence métier :** cumul de fonctions et fraude.
- **Correction minimale :** permissions et acteurs distincts, seuils d’approbation et interdiction d’auto-approbation.
- **Tests :** créateur ≠ validateur ≠ payeur selon politique.
- **Statut : non prouvé.**

## 5. Points positifs prouvés

### POS-001 — Réception stock transactionnelle sous MySQL

Le script `test_stock_receipt_validation_mysql.js` prouve :

- mouvement d’entrée ;
- quantité avant / après ;
- mise à jour du stock ;
- changement de statut ;
- audit ;
- rollback complet après erreur forcée.

Verdict : **conforme sur le scénario testé**, sous réserve que toutes les routes utilisent ce service.

### POS-002 — Paiement fournisseur verrouillé et atomique sur facture/opération

`paySupplierInvoice()` verrouille la facture et met à jour opération + facture + audit dans une transaction.

Verdict : **partiellement conforme**, car ledger, comptabilité, budget et allocation canonique restent hors chaîne prouvée.

### POS-003 — Rapprochement 3 voies réel

Le service vérifie BC, réception, quantités conformes, montant et seuil d’écart.

Verdict : **partiellement conforme**, avec nécessité de durcir idempotence, acteurs et liens financiers.

## 6. Workflow canonique proposé

| Document | États canoniques |
|---|---|
| Demande d’achat | draft → submitted → controlled → approved → rejected → cancelled |
| Engagement budget | pending → committed → released → realized → reversed |
| Bon de commande | draft → approved → sent → supplier_accepted → partially_received → received → closed / cancelled |
| Réception | draft → submitted → quality_checked → accepted / partially_accepted / rejected / returned |
| Facture fournisseur | received → under_review → matched → approved → partially_paid → paid → disputed → reversed |
| Paiement | draft → submitted → authorized → paid → reconciled → reversed |

## 7. Invariants obligatoires

1. Une demande approuvée ne crée aucun mouvement de trésorerie.
2. Un paiement exige une facture validée et une autorisation.
3. Une facture liée à un achat exige un rapprochement 3 voies, sauf exception formalisée.
4. Une réception acceptée crée exactement une fois les mouvements de stock.
5. Un retour crée un mouvement inverse.
6. Les quantités reçues cumulées sont contrôlées contre le BC.
7. Chaque paiement est une allocation distincte à la facture.
8. Le reste à payer est reconstructible depuis les allocations.
9. Le paiement poste le ledger dans la même transaction.
10. La comptabilité manquante bloque la clôture.
11. Le budget est engagé avant commande et réalisé sans double consommation.
12. Les acteurs création, contrôle, approbation et paiement respectent la séparation des fonctions.

## 8. Ordre de correction recommandé

### P0

1. identifier quelle route achats est réellement montée en production ;
2. supprimer le contournement “approbation → décaissement” ;
3. forcer tous les paiements fournisseur par un service canonique unique ;
4. intégrer ledger, facture et allocation dans une transaction ;
5. rendre la position et la catégorie explicites ;
6. interdire les audits ignorés.

### P1

1. synchroniser factures vers `finance_source_documents` ;
2. utiliser `payment_allocations` ;
3. intégrer comptabilité et anomalies bloquantes ;
4. créer le lien budget ;
5. formaliser retours et avoirs.

### P2

1. reporting fournisseurs ;
2. délais et performance fournisseur ;
3. alertes échéances ;
4. contrôles qualité avancés.

## 9. Conclusion

Le domaine Achats dispose de composants fonctionnels sérieux mais de générations différentes. La réception stock MySQL est bien plus robuste que la route historique de demande d’achat. Le risque principal est la coexistence : les nouveaux services contrôlés peuvent être contournés par des routes anciennes qui créent directement des opérations financières.

La prochaine étape logique est `09-contrats.md` ou, avant cela, la vérification transversale `03-identite-acces.md`, car les permissions hybrides affectent maintenant finance, comptabilité, achats et parapheur.
