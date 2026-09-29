# Vérification — Tala SMI, surcouche de Dolibarr

Date : 29 septembre 2026
Terrain : `dolibarr-sandbox` (Dolibarr 22.0.5), **jamais la production**
Contexte : [ADR 0002](../../adr/0002-dolibarr-fait-foi.md) — Dolibarr fait foi pour
les tiers, les factures et la comptabilité ; Tala SMI pour la caisse, les
approbations, la paie et le budget.

## La question

Tala SMI peut-il déposer ses mouvements de caisse dans Dolibarr **par l'API
REST**, et Dolibarr en tirer seul des écritures SYSCOHADA justes ?

## La méthode

Chaque script appelle le **code des classes d'API REST** de Dolibarr
(`BankAccounts`, `Invoices`, `SupplierInvoices`, `Salaries`, `Products`,
`Thirdparties`), l'administrateur du bac à sable tenant lieu d'appelant — même
code qu'une requête HTTP, sans le réseau ni la clé d'API. Les deux gestes que
l'API n'offre pas (ventilation, écriture au grand livre) sont exécutés par
l'écran même de Dolibarr, comme le comptable d'un clic.

Montants et dates : ceux des opérations n° 12 (vente) et n° 20 (retrait BCH)
de Tala SMI, plus une dépense de carburant et un salaire net d'essai.

```sh
sh docs/verifications/dolibarr-surcouche/lancer.sh            # tout
sh docs/verifications/dolibarr-surcouche/lancer.sh grand-livre # lire seulement
```

Le lanceur refuse tout conteneur dont le nom ne contient pas `sandbox`. Les
scripts sont idempotents. Sauvegarde du bac à sable prise avant le premier
essai : `/root/sauvegardes-dolibarr-sandbox/avant-verification-20260929-123933.sql`.

| Script | Rôle |
|---|---|
| `configurer-bac-a-sable.php` | Congo, XAF, modules, plan SYSCOHADA-CG, comptes par défaut, comptes Caisse (5711) et BCH (5211), exercice 2026 |
| `pousser-caisse.php` | ligne de banque « nue » et virement BCH → Caisse |
| `vente-comptant.php` | vente au comptant : facture, validation, paiement en caisse |
| `depenses.php` | dépense de carburant (facture fournisseur) et salaire net payé en caisse |
| `ecran.php` | exécute un écran de comptabilité (ventilation, journaux) |
| `grand-livre.php` | lit le grand livre |
| `diag-salaire.php` | diagnostic des paiements de salaire et de leurs lignes de banque |

## Résultats du 29/09/2026

| Mouvement Tala SMI | Appels d'API | Écritures produites par Dolibarr | Verdict |
|---|---|---|---|
| Vente au comptant 1 200 000 | `POST /invoices`, `/validate`, `/payments` | VT 411 D / 706 C ; BQ 5711 D / 411 C | Conforme |
| Retrait BCH → Caisse 600 000 | `POST /bankaccounts/transfer` | 5211 C / 585 D ; 585 C / 5711 D | Conforme |
| Dépense carburant 50 000 | `POST /products` (compte d'achat 6053), `/supplierinvoices`, `/lines`, `/validate`, `/payments` | AC 6053 D / 401 C ; BQ 401 D / 5711 C | Conforme |
| Salaire net 150 000 | `POST /salaries`, `/payments` | BQ 422 D / 5711 C | Conforme |
| Vente en ligne de banque « nue », code 706 | `POST /bankaccounts/{id}/lines` | 5711 D / **471** C | **À proscrire** |

## Ce qu'il faut retenir pour la passerelle

1. **Une vente passe par une facture**, même au comptant ; une ligne de banque
   seule part en 471 (attente), le code comptable transmis est ignoré.
2. **Une dépense passe par une facture fournisseur** ; la catégorie Tala SMI
   correspond à un **service Dolibarr** qui porte son compte de charge.
3. **Chaque mouvement demande plusieurs appels** ; la référence Tala SMI portée
   par la pièce (`ref_client`, `ref_supplier`) rend la reprise sans doublon.
4. **Ventilation et écriture au grand livre ne sont pas dans l'API** : c'est le
   geste du comptable dans Dolibarr — il remplace la validation des brouillons
   de Tala SMI.
5. **Un exercice ouvert est obligatoire** ; sans lui toute écriture est refusée.
6. **Pièges de l'API Salaires** : la validation exige `paiementtype`, la ligne de
   banque lit `fk_typepayment` — sans le second, le paiement est créé **sans
   ligne de banque** et l'appel répond par un succès. Contrôler `fk_bank` après
   coup. (Témoin laissé : le salaire « fevrier ».)
7. **Un objet d'API réutilisé après une validation perd sa connexion** : un objet
   neuf par appel.
8. **Non couvert** : l'écriture de paie (661 / 422, CNSS, IRPP) — l'API
   comptable n'offre que l'export, pas l'écriture. À trancher : import
   d'écritures, ou saisie dans Dolibarr.
9. **Non couvert** : l'appel HTTP réel avec une clé d'API dédiée.

## Données laissées dans le bac à sable

Tiers « ESSAI SMI - client comptant » et « ESSAI SMI - fournisseur », service
`SMI-CARBURANT`, factures IN2601-0001 et SI2602-0001, salaires « fevrier »
(paiement sans ligne de banque) et « mars », comptes CAISSE et BCH, lignes de
banque n° 3 à 8 et leurs écritures — dont le 5711/471 de la ligne « nue ».
Les 39 prospects du bac à sable ne sont pas touchés.
