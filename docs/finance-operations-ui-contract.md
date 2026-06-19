# Finance > Opérations — contrat fonctionnel et UI cible

## Décision d’architecture

La page `/app/finance/operations` n’est plus considérée comme un simple registre d’entrées/sorties. Elle devient un espace de pilotage réunissant des objets distincts :

1. document métier d’origine ;
2. demande et circuit d’approbation ;
3. paiement ou encaissement ;
4. allocation du paiement ;
5. écriture comptable ;
6. mouvement de trésorerie ;
7. rapprochement bancaire ou caisse ;
8. correction par contrepassation.

La table `operations` reste une façade de compatibilité. Elle ne doit plus être l’unique source de vérité.

## Structure d’écran

### Indicateurs

- Solde disponible ;
- Encaissements de la période ;
- Décaissements de la période ;
- À approuver ;
- À payer ;
- Non alloués ;
- Non comptabilisés ;
- Non rapprochés ;
- Anomalies bloquantes.

Chaque indicateur doit être cliquable et appliquer un filtre explicite.

### Onglets

- Vue générale ;
- Encaissements ;
- Demandes de paiement ;
- Paiements ;
- Virements internes ;
- À rapprocher ;
- Anomalies.

### Files de travail

- Mes brouillons ;
- À soumettre ;
- À approuver ;
- À exécuter ;
- À allouer ;
- À comptabiliser ;
- À rapprocher ;
- Terminées ;
- Rejetées ou contrepassées.

## Tableau principal

Colonnes obligatoires :

| Colonne | Rôle |
|---|---|
| Référence | Identifiant de l’opération |
| Date | Date de valeur |
| Nature | Encaissement, règlement fournisseur, avance, transfert… |
| Tiers | Client, fournisseur, employé, administration |
| Objet | Libellé métier |
| Montant | Montant et devise |
| Position | Caisse ou compte bancaire |
| Document d’origine | Facture, achat, paie, note de frais… |
| Approbation | Brouillon, soumis, approuvé, rejeté |
| Paiement | Non payé, partiel, payé, contrepassé |
| Allocation | Non alloué, partiel, alloué |
| Comptabilité | En attente, erreur, comptabilisé |
| Rapprochement | Non rapproché, partiel, rapproché |
| Action suivante | Action métier autorisée pour l’utilisateur |

Un badge unique « statut » est interdit : il masque des états indépendants.

## Formulaire multi-étapes

### 1. Nature métier

- règlement d’une facture fournisseur ;
- encaissement d’une facture client ;
- dépense directe ;
- avance fournisseur ;
- avance ou remboursement employé ;
- paie ;
- taxe ou cotisation ;
- immobilisation ;
- virement interne ;
- correction ou contrepassation ;
- opération exceptionnelle.

### 2. Document source

Recherche et sélection du document existant. Une saisie sans document source doit être explicitement classée « dépense directe » ou « opération exceptionnelle ».

### 3. Imputation

- tiers ;
- rubrique et compte comptable ;
- analytique ;
- centre de coût ;
- projet ;
- budget ;
- taxe ;
- échéance.

### 4. Paiement

- position de trésorerie ;
- mode ;
- référence externe ;
- montant ;
- date de valeur ;
- bénéficiaire ;
- justificatifs.

### 5. Allocation

Un paiement peut régler plusieurs documents et un document peut recevoir plusieurs paiements. Le montant non alloué est affiché en permanence.

### 6. Validation

Le système calcule les approbateurs selon le montant, le rôle, la délégation, le budget et la séparation des tâches.

## Règles non négociables

- aucune suppression d’une opération validée ;
- correction après validation uniquement par contrepassation ;
- aucune écriture rétroactive dans une période clôturée ;
- référence externe unique pour chèque, virement et mobile money ;
- virement interne exclu du chiffre d’affaires et des encaissements ;
- écriture de trésorerie append-only ;
- paiement validé non comptabilisé visible comme anomalie ;
- paiement non alloué visible comme file de travail ;
- action impossible masquée ou désactivée avec justification ;
- tous les contrôles appliqués côté serveur.

## Compatibilité progressive

Les anciens champs sont projetés vers les nouveaux états par `backend/services/finance-operations.js`. Cette projection permet de moderniser l’écran sans réécrire immédiatement toutes les données historiques.
