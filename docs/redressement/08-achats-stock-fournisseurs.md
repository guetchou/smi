# 08 — Audit achats, fournisseurs et stock

Chaîne cible : `Demande → validation → commande → réception → stock → facture → dette → paiement → trésorerie → comptabilité`.

## 1. Points prouvés conformes

### Paiement fournisseur (`supplier_payment_workflow.js`) — solide
- Transaction unique : `FOR UPDATE` facture → contrôles → INSERT opération → mise à jour `montant_paye/reste_a_payer/statut` → audit. Hook de panne testé (`failAfterOperation`) + scénario MySQL (`scripts/test_supplier_payment_mysql.js`).
- Statut requis `validee|partiellement_payee` — pas de paiement sans validation. Montant plafonné au reste à payer (+0,01).
- **Rapprochement 3 voies** : calculé automatiquement au premier paiement si `non_rapproche` (commande vs réceptions conformes vs facture, seuil % paramétrable `rapprochement_seuil_pct`) ; `ecart_bloquant` bloque ; override réservé DG/Admin avec motif obligatoire et audité. Test `rapprochement_3voies_test.js`.
- Facture soldée sans décaissement : impossible par ce chemin (l'opération est créée dans la même transaction).

### Réception → stock (`stock_receipt_validation_workflow.js`) — solide avec réserves
- `FOR UPDATE` réception + produit ; mouvement `stock_mouvements` + mise à jour `produits.stock_disponible` + statut + audit dans une transaction ; test d'atomicité MySQL.
- Double réception de la même réception : bloquée (`statut='accepte'` refusé en ré-entrée).
- Mouvement sans pièce source : impossible par ce chemin (reference_type='reception').

## 2. Anomalies

### ANO-ACH-01 — Lignes de réception silencieusement ignorées — **MOYENNE**
- **Preuve** : `stock_receipt_validation_workflow.js:42,48` — `if (!productId || compliantQuantity <= 0) continue;` et `if (!product) continue;`.
- **Reproduction** : réception dont une ligne référence un `produit_id` supprimé/inconnu → la réception passe `accepte`, l'audit dit `stock_mis_a_jour: true`, mais aucun mouvement pour cette ligne.
- **Conséquence** : stock théorique < stock reçu, sans aucune alerte ; divergence facture/stock détectée seulement (peut-être) au paiement.
- **Correction minimale** : lever une erreur (rollback) si une ligne a une quantité conforme > 0 sans produit résoluble ; ou consigner explicitement les lignes ignorées dans l'audit et retourner un avertissement.
- **Tests** : réception avec produit orphelin → 409 attendu.

### ANO-ACH-02 — Sur-réception non plafonnée à la validation — **MOYENNE**
- La quantité conforme n'est pas comparée à la quantité commandée au moment de `validateStockReceipt` ; le contrôle n'existe qu'au paiement de la facture (écart 3 voies). Une double réception **de deux réceptions distinctes** sur le même BC gonfle le stock sans blocage.
- **Correction minimale** : à la validation, vérifier `Σ quantite_conforme (toutes réceptions du BC, la présente incluse) ≤ quantite commandée + tolérance paramétrable` ; sinon statut `non_conforme` ou erreur.
- **Tests** : deux réceptions totalisant 120 % du BC → seconde bloquée.

### ANO-ACH-03 — Chemins d'achats legacy dans `achats.js` (1 558 lignes) — À APPROFONDIR
`achats_parapheur_required_safe.js` intercepte l'approbation (parapheur obligatoire) et `parapheur_source_sync_safe.js` synchronise `demandes_achat` (rendu atomique par le commit `025c512`). Le reste du fichier (BC, réceptions CRUD, factures fournisseurs hors paiement) n'a pas été audité ligne à ligne dans cette passe — **classé : impossible à vérifier (dans cette passe)**, à couvrir dans la passe suivante avec tests de contrat sur : création BC depuis demande approuvée uniquement, suppression de pièce déjà comptabilisée, divergences facture/commande/réception hors paiement.

### Suppression d'une pièce comptabilisée
Pour `operations` : bloquée si écriture postée. Pour `factures_fournisseurs`/`receptions` : pas de garde équivalente trouvée dans cette passe → inclure dans ANO-ACH-03.

## 3. Stock négatif
Les entrées (réceptions) sont saines. Les sorties de stock (ventes/ajustements dans `produits.js`) n'ont pas été auditées dans cette passe — le contrôle « stock négatif interdit » reste **à prouver**. À couvrir avec ANO-ACH-03.

## 4. Verdict module
**Exploitable sous conditions** : les deux chemins critiques (paiement fournisseur, réception→stock) sont atomiques, testés MySQL et gouvernés ; corriger ANO-ACH-01/02, puis auditer le reste d'`achats.js` et les sorties de stock.
