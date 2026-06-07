# PRD — Synchronisation des flux Encaissement / Décaissement avec Trésorerie, Comptabilité, Budget et Finance

## 1. Résumé exécutif

Ce PRD décrit l’architecture fonctionnelle et technique nécessaire pour contrôler les flux d’encaissement et de décaissement dans une application de gestion déjà déployée.

L’objectif n’est pas seulement d’avoir des formulaires pour saisir des opérations. L’objectif est de garantir qu’une opération validée déclenche correctement tous ses impacts :

```text
Opération métier
→ Mouvement de trésorerie
→ Écriture comptable OHADA
→ Impact budget
→ Mise à jour dette ou créance
→ Reporting financier
→ Audit log
→ Contrôle interne
```

Le système doit éviter les omissions, les flux cassés, les paiements non affectés, les encaissements non imputés, les erreurs de direction, les mauvaises affectations comptables, les écarts de caisse, les dettes non soldées et les mouvements non justifiés.

---

## 2. Contexte

L’application dispose déjà de modules d’encaissement et de décaissement.

Le besoin actuel est de renforcer le fonctionnement des flux afin que chaque opération soit :

- contrôlée avant validation ;
- synchronisée avec la trésorerie ;
- traduite en écriture comptable selon le plan comptable OHADA ;
- rattachée au bon tiers ;
- rattachée au budget si nécessaire ;
- historisée ;
- vérifiable ;
- rapprochable avec les soldes réels de caisse, banque et mobile money.

Le système doit permettre de répondre clairement à ces questions :

```text
Qui a saisi l’opération ?
Qui l’a validée ?
Quel argent est entré ou sorti ?
Par quel canal ?
Dans quelle caisse, banque ou mobile money ?
Pour quel tiers ?
Pour quelle facture, dette, charge ou avance ?
Quel compte OHADA est impacté ?
Quel budget est consommé ou réalisé ?
Quelle preuve justifie l’opération ?
L’opération est-elle rapprochée ?
```

---

## 3. Problèmes à résoudre

| Problème | Risque |
|---|---|
| Encaissement saisi mais non affecté à une facture | Créance client toujours ouverte malgré paiement reçu |
| Décaissement saisi mais non lié à une dette | Fournisseur considéré impayé malgré paiement |
| Retrait banque traité directement comme paiement fournisseur | Traçabilité de caisse cassée |
| Mobile money utilisé comme mode simple et non comme position de trésorerie | Solde mobile money incontrôlable |
| Chèque client enregistré directement en banque | Argent considéré disponible alors qu’il ne l’est pas encore |
| Flux validé sans écriture comptable | Comptabilité incomplète |
| Écriture comptable déséquilibrée | Comptabilité fausse |
| Paiement sans justificatif | Risque de fraude ou d’erreur |
| Budget non contrôlé avant décaissement | Dépassement non maîtrisé |
| Suppression d’opération validée | Perte d’auditabilité |
| Référence externe doublonnée | Risque de double encaissement ou double paiement |
| Solde caisse négatif | Mauvais contrôle de trésorerie |
| Mauvais compte OHADA | Bilan et états financiers faussés |

---

## 4. Objectifs

### 4.1 Objectif principal

Mettre en place un workflow robuste qui synchronise les encaissements et décaissements avec la trésorerie, la comptabilité OHADA, le budget, les tiers, le reporting financier et l’audit.

### 4.2 Objectifs spécifiques

Le système doit permettre de :

1. contrôler chaque encaissement avant validation ;
2. contrôler chaque décaissement avant validation ;
3. créer automatiquement les mouvements de trésorerie ;
4. générer automatiquement les écritures comptables OHADA ;
5. empêcher les écritures déséquilibrées ;
6. rattacher les paiements aux factures, dettes, avances ou charges ;
7. mettre à jour les soldes de caisse, banque et mobile money ;
8. contrôler les budgets avant engagement ou réalisation ;
9. détecter les anomalies et doublons ;
10. gérer les statuts de validation, comptabilisation et rapprochement ;
11. journaliser toutes les actions ;
12. sécuriser les annulations par contre-opération ;
13. produire des tableaux de bord fiables.

---

## 5. Périmètre

### 5.1 Inclus

| Fonction | Inclus |
|---|---|
| Encaissements clients | Oui |
| Avances clients | Oui |
| Encaissements non affectés | Oui |
| Décaissements fournisseurs | Oui |
| Paiements agents / salariés | Oui |
| Dépenses directes | Oui |
| Avances fournisseurs | Oui |
| Mouvements de trésorerie automatiques | Oui |
| Comptabilité OHADA automatique | Oui |
| Gestion budget | Oui |
| Dettes et créances | Oui |
| Justificatifs | Oui |
| Validation | Oui |
| Annulation | Oui |
| Rapprochement | Oui |
| Audit log | Oui |
| Notifications et feedback UI | Oui |
| API backend | Oui |

### 5.2 Hors périmètre immédiat

| Fonction | Statut |
|---|---|
| Paie complète | Module lié |
| Facturation complète | Module lié |
| Gestion complète des achats | Module lié |
| Déclarations fiscales | Hors MVP |
| États financiers OHADA complets automatisés | Version avancée |
| Import automatique relevés bancaires | Version avancée |
| OCR justificatifs | Version avancée |

---

## 6. Définitions métier

### 6.1 Encaissement

Un encaissement est une opération où l’entreprise reçoit de l’argent ou un moyen de paiement.

Exemples :

```text
Paiement client
Avance client
Apport associé
Remboursement reçu
Paiement mobile money reçu
Virement bancaire reçu
Chèque reçu
```

### 6.2 Décaissement

Un décaissement est une opération où l’entreprise paie un tiers ou règle une dépense.

Exemples :

```text
Paiement fournisseur
Paiement agent
Paiement salaire
Achat direct
Frais de transport
Remboursement client
Paiement par banque
Paiement par caisse
Paiement par mobile money
```

### 6.3 Mouvement de trésorerie

Un mouvement de trésorerie est l’impact réel d’une opération sur une position d’argent.

Exemples :

```text
Caisse +500 000
Banque -300 000
Mobile Money +150 000
Chèques à encaisser +800 000
```

### 6.4 Position de trésorerie

Une position de trésorerie est un emplacement où l’entreprise détient de l’argent ou un moyen assimilé.

Exemples :

```text
Caisse bureau
Banque BCH
Banque LCB
MTN Mobile Money
Airtel Money
Chèques à encaisser
Espèces en transit
```

### 6.5 Comptabilisation

La comptabilisation est la génération d’une écriture comptable équilibrée selon le plan comptable OHADA.

Règle obligatoire :

```text
Total débit = Total crédit
```

### 6.6 Affectation

L’affectation consiste à rattacher une opération à sa cause métier réelle :

```text
Facture client
Dette fournisseur
Charge directe
Avance client
Avance fournisseur
Salaire
Projet
Campagne
Budget
```

---

## 7. Architecture fonctionnelle cible

```text
Finance
│
├── Tableau de bord financier
│
├── Encaissements
│   ├── Nouvel encaissement
│   ├── Liste des encaissements
│   ├── Encaissements à affecter
│   └── Encaissements en anomalie
│
├── Décaissements
│   ├── Nouveau décaissement
│   ├── Liste des décaissements
│   ├── Décaissements à justifier
│   └── Décaissements en anomalie
│
├── Trésorerie
│   ├── Positions de trésorerie
│   ├── Mouvements internes
│   ├── Soldes
│   └── Rapprochements
│
├── Comptabilité
│   ├── Plan comptable OHADA
│   ├── Journaux
│   ├── Écritures générées
│   ├── Écritures en anomalie
│   └── Grand livre
│
├── Budget
│   ├── Budgets prévus
│   ├── Budget engagé
│   ├── Budget réalisé
│   └── Écarts
│
└── Contrôles
    ├── Validations en attente
    ├── Anomalies
    ├── Audit log
    └── Rebuild synchronisation
```

---

## 8. Principe de synchronisation

### 8.1 Flux d’encaissement

```text
Encaissement saisi
→ Contrôle des données
→ Soumission
→ Validation
→ Création mouvement de trésorerie entrant
→ Augmentation position destination
→ Génération écriture comptable
→ Affectation facture / créance / avance / produit
→ Mise à jour budget réalisé
→ Mise à jour reporting
→ Audit log
→ Notification utilisateur
```

### 8.2 Flux de décaissement

```text
Décaissement saisi
→ Contrôle des données
→ Vérification solde
→ Vérification budget
→ Soumission
→ Validation
→ Création mouvement de trésorerie sortant
→ Diminution position source
→ Génération écriture comptable
→ Affectation dette / charge / avance / salaire
→ Mise à jour budget réalisé
→ Mise à jour reporting
→ Audit log
→ Notification utilisateur
```

### 8.3 Flux de transfert interne

```text
Transfert interne saisi
→ Contrôle source et destination
→ Validation
→ Diminution position source
→ Augmentation position destination
→ Génération écriture comptable interne
→ Aucun produit
→ Aucune charge sauf frais
→ Audit log
→ Notification utilisateur
```

---

## 9. Workflow d’encaissement

### 9.1 Étapes

```text
1. Création de l’encaissement
2. Sélection du payeur
3. Sélection de la nature d’encaissement
4. Sélection du mode de paiement
5. Sélection de la position destination
6. Saisie du montant
7. Rattachement facture / avance / produit / remboursement
8. Ajout référence externe
9. Ajout justificatif
10. Contrôles automatiques
11. Soumission à validation
12. Validation responsable
13. Synchronisation trésorerie
14. Synchronisation comptabilité
15. Synchronisation budget
16. Mise à jour tiers
17. Notification et audit
```

### 9.2 Natures d’encaissement

| Nature | Description |
|---|---|
| Paiement facture client | Règlement total ou partiel d’une facture |
| Avance client | Argent reçu avant facturation définitive |
| Produit direct | Recette sans facture préalable |
| Apport associé | Apport de fonds par associé |
| Remboursement reçu | Argent retourné par un tiers |
| Encaissement non affecté | Argent reçu sans affectation immédiate |

### 9.3 Modes d’encaissement

| Mode | Position destination attendue |
|---|---|
| Espèces | Caisse |
| Virement bancaire | Banque |
| Mobile Money | Position Mobile Money |
| Chèque | Chèques à encaisser |
| Carte bancaire | Banque ou passerelle |
| Compensation | Compte de compensation |

### 9.4 Contrôles obligatoires

Le système doit bloquer si :

```text
Montant vide ou inférieur à zéro
Position destination absente
Payeur absent si nature liée à un tiers
Facture absente si nature = paiement facture
Référence externe absente pour banque, chèque ou mobile money
Justificatif absent au-dessus du seuil
Compte OHADA non configuré
Doublon de référence externe
Écriture comptable déséquilibrée
```

---

## 10. Workflow de décaissement

### 10.1 Étapes

```text
1. Création du décaissement
2. Sélection du bénéficiaire
3. Sélection de la nature de dépense
4. Sélection du mode de paiement
5. Sélection de la position source
6. Saisie du montant
7. Vérification du solde disponible
8. Vérification du budget disponible
9. Rattachement facture fournisseur / charge / salaire / avance
10. Ajout référence externe
11. Ajout justificatif
12. Soumission à validation
13. Validation responsable
14. Synchronisation trésorerie
15. Synchronisation comptabilité
16. Synchronisation budget
17. Mise à jour dette ou charge
18. Notification et audit
```

### 10.2 Natures de décaissement

| Nature | Description |
|---|---|
| Paiement facture fournisseur | Règlement total ou partiel d’une dette fournisseur |
| Avance fournisseur | Paiement avant facture définitive |
| Dépense directe | Achat ou charge sans dette préalable |
| Paiement agent | Paiement lié à mission, campagne ou prestation |
| Paiement salaire | Paiement lié à une période de paie |
| Remboursement client | Restitution d’un trop-perçu ou remboursement |
| Frais bancaires | Frais prélevés par banque |
| Frais mobile money | Frais de transaction mobile money |
| Décaissement non affecté | Sortie temporaire à régulariser |

### 10.3 Modes de décaissement

| Mode | Position source attendue |
|---|---|
| Espèces | Caisse |
| Virement bancaire | Banque |
| Mobile Money | Position Mobile Money |
| Chèque | Banque |
| Carte bancaire | Banque ou compte passerelle |

### 10.4 Contrôles obligatoires

Le système doit bloquer si :

```text
Bénéficiaire absent
Position source absente
Montant vide ou inférieur à zéro
Solde source insuffisant
Budget dépassé sans autorisation
Nature de dépense absente
Justificatif absent selon seuil
Référence externe absente pour banque, chèque ou mobile money
Compte OHADA non configuré
Paiement fournisseur sans facture, avance ou dépense directe
Paiement salaire sans période de paie
Paiement agent sans mission ou motif
Écriture comptable déséquilibrée
```

---

## 11. Règles de direction des flux

### 11.1 Encaissement

```text
Tiers externe → Position de trésorerie
```

Exemples :

```text
Client → Caisse
Client → Banque
Client → Mobile Money
Client → Chèques à encaisser
```

### 11.2 Décaissement

```text
Position de trésorerie → Tiers externe
```

Exemples :

```text
Caisse → Fournisseur
Banque → Agent
Mobile Money → Prestataire
```

### 11.3 Transfert interne

```text
Position de trésorerie → Position de trésorerie
```

Exemples :

```text
Banque → Caisse
Caisse → Banque
Mobile Money → Banque
Chèques à encaisser → Banque
```

### 11.4 Règle d’alerte

Si l’utilisateur choisit une direction incohérente, l’interface doit afficher une infobulle ou bloquer selon la gravité.

Exemple :

```text
Un encaissement doit augmenter une position de trésorerie. Si vous déplacez l’argent entre deux positions internes, utilisez un transfert interne.
```

---

## 12. Synchronisation comptable OHADA

### 12.1 Principe

Chaque opération validée doit générer une écriture comptable équilibrée.

```text
Total débit = Total crédit
```

Si l’écriture ne peut pas être générée :

```text
La validation est bloquée.
Aucun solde n’est modifié.
Une anomalie est créée.
L’utilisateur reçoit un message clair.
```

### 12.2 Mapping comptable paramétrable

Le système doit contenir une table de correspondance entre :

```text
Nature opération
Mode de paiement
Position de trésorerie
Type de tiers
Compte débit
Compte crédit
Journal comptable
```

### 12.3 Exemples de correspondance OHADA

> Les comptes exacts doivent être validés avec le comptable de l’entreprise selon le plan OHADA interne. Le système doit permettre le paramétrage.

| Opération | Débit | Crédit |
|---|---|---|
| Encaissement client en banque | 521 Banque | 411 Clients |
| Encaissement client en caisse | 571 Caisse | 411 Clients |
| Paiement fournisseur banque | 401 Fournisseurs | 521 Banque |
| Paiement fournisseur caisse | 401 Fournisseurs | 571 Caisse |
| Retrait banque vers caisse | 571 Caisse | 521 Banque |
| Versement caisse vers banque | 521 Banque | 571 Caisse |
| Avance client | 521/571 Banque ou Caisse | 419 Clients créditeurs |
| Avance fournisseur | 409 Fournisseurs débiteurs | 521/571 Banque ou Caisse |
| Frais bancaire | 631/627 selon paramétrage | 521 Banque |
| Frais mobile money | 631/627 selon paramétrage | Position Mobile Money |
| Apport associé | 521/571 Banque ou Caisse | 462/101 selon cas |

### 12.4 Journaux comptables

| Journal | Usage |
|---|---|
| Journal de caisse | Opérations espèces |
| Journal de banque | Opérations bancaires |
| Journal mobile money | Opérations mobile money |
| Journal des opérations diverses | Corrections, régularisations |
| Journal d’achat | Factures fournisseurs |
| Journal de vente | Factures clients |

---

## 13. Synchronisation budget

### 13.1 Objectif

Le budget doit permettre de comparer :

```text
Prévu
Engagé
Réalisé
Écart
Taux d’exécution
```

### 13.2 Décaissement

Un décaissement doit impacter le budget réalisé.

Exemple :

```text
Budget transport mensuel : 300 000
Décaissement transport : 50 000
Budget consommé : 50 000
Solde budget : 250 000
```

Si dépassement :

```text
Bloquer
ou demander validation spéciale
ou autoriser avec justification
```

Message recommandé :

```text
Cette dépense dépasse le budget disponible de 35 000 FCFA. Une validation spéciale est requise.
```

### 13.3 Encaissement

Un encaissement peut impacter les objectifs de revenus.

Exemple :

```text
Prévision encaissement client : 2 000 000
Encaissement réalisé : 1 500 000
Reste à encaisser : 500 000
```

---

## 14. Synchronisation dettes et créances

### 14.1 Encaissement client

Un encaissement client doit être classé dans l’un des cas suivants :

```text
Paiement d’une facture existante
Avance client
Paiement partiel
Paiement non affecté
Remboursement reçu
Produit direct
```

Si aucune affectation n’est choisie, l’opération doit être classée :

```text
Encaissement à affecter
```

### 14.2 Décaissement fournisseur

Un décaissement fournisseur doit être classé dans l’un des cas suivants :

```text
Paiement d’une facture fournisseur
Avance fournisseur
Paiement partiel
Dépense directe
Remboursement client
Paiement non affecté
```

Si aucune dette n’est choisie, le système doit demander :

```text
Voulez-vous créer une dépense directe ?
Ou enregistrer une avance fournisseur ?
```

---

## 15. Statuts des opérations

### 15.1 Statuts principaux

| Statut | Signification |
|---|---|
| BROUILLON | Opération saisie mais non soumise |
| EN_ATTENTE_VALIDATION | Opération soumise pour contrôle |
| VALIDÉ | Opération approuvée |
| COMPTABILISÉ | Écriture comptable générée |
| RAPPROCHÉ | Confirmé par caisse, banque ou mobile money |
| REJETÉ | Refusé par le validateur |
| ANNULÉ | Neutralisé par annulation |
| ANOMALIE | Flux incomplet ou erreur détectée |

### 15.2 Statuts techniques complémentaires

| Statut | Signification |
|---|---|
| treasury_status | Synchronisation trésorerie |
| accounting_status | Synchronisation comptable |
| budget_status | Synchronisation budget |
| allocation_status | Affectation à facture, dette, avance ou charge |

Valeurs recommandées :

```text
PENDING
SUCCESS
FAILED
MANUAL_REQUIRED
NOT_APPLICABLE
```

---

## 16. Effets selon les statuts

| Statut | Trésorerie | Comptabilité | Budget |
|---|---:|---:|---:|
| BROUILLON | Aucun impact | Aucun impact | Aucun impact |
| EN_ATTENTE_VALIDATION | Aucun impact | Aucun impact | Réservation optionnelle |
| VALIDÉ | Impact oui | Génération automatique souhaitée | Impact oui |
| COMPTABILISÉ | Impact confirmé | Écriture générée | Impact confirmé |
| RAPPROCHÉ | Confirmé | Confirmé | Confirmé |
| REJETÉ | Aucun impact | Aucun impact | Aucun impact |
| ANNULÉ | Contre-mouvement | Contre-écriture | Correction |
| ANOMALIE | Selon cas | Selon cas | Selon cas |

Recommandation opérationnelle :

```text
Au moment de la validation, le système doit exécuter dans une transaction :
1. impact trésorerie ;
2. écriture comptable ;
3. impact budget ;
4. mise à jour tiers ;
5. audit log.
```

---

## 17. Anomalies à détecter automatiquement

| Anomalie | Détection |
|---|---|
| Encaissement non affecté | Argent reçu sans facture, client ou motif clair |
| Décaissement non affecté | Paiement sans dette, charge ou bénéficiaire clair |
| Dette fournisseur encore ouverte | Paiement non rattaché à facture |
| Créance client encore ouverte | Encaissement non imputé à facture |
| Solde caisse négatif | Décaissement supérieur au solde |
| Chèque non déposé | Chèque à encaisser trop ancien |
| Chèque rejeté non traité | Créance non réouverte |
| Mobile money non rapproché | Écart système / opérateur |
| Banque non rapprochée | Écart avec relevé |
| Budget dépassé | Réalisé supérieur au budget |
| Paiement en double | Même fournisseur, montant, facture ou référence |
| Encaissement doublon | Même référence virement ou transaction |
| Écriture comptable échouée | Mouvement validé sans écriture |
| Mouvement sans justificatif | Pièce absente |
| Mouvement modifié après validation | Action interdite ou auditée |

---

## 18. Automatisations de flux

### 18.1 Déclencheur : encaissement validé

Actions automatiques :

```text
Créer mouvement de trésorerie entrant
Mettre à jour solde destination
Générer écriture comptable
Affecter facture / créance / avance
Mettre à jour budget réalisé
Créer audit log
Envoyer notification
Mettre à jour dashboard
```

### 18.2 Déclencheur : décaissement validé

Actions automatiques :

```text
Créer mouvement de trésorerie sortant
Mettre à jour solde source
Générer écriture comptable
Solder dette / créer charge / enregistrer avance
Mettre à jour budget réalisé
Créer audit log
Envoyer notification
Mettre à jour dashboard
```

### 18.3 Déclencheur : rapprochement validé

Actions automatiques :

```text
Marquer les mouvements rapprochés
Calculer les écarts
Créer alertes si différence
Générer rapport de rapprochement
Verrouiller période si validé
```

### 18.4 Déclencheur : annulation

Actions automatiques :

```text
Créer contre-mouvement
Créer contre-écriture
Réouvrir dette ou créance si nécessaire
Corriger budget réalisé
Journaliser motif
Notifier responsable
```

---

## 19. Règles anti-omissions

### 19.1 Encaissement

Bloquer si :

```text
Pas de tiers ou pas de motif
Pas de position destination
Pas de mode d’encaissement
Pas de référence externe pour banque/mobile money/chèque
Pas de justificatif obligatoire
Facture non choisie alors que nature = paiement facture
Montant supérieur au reste à payer sans traitement du trop-perçu
Compte OHADA absent
```

### 19.2 Décaissement

Bloquer si :

```text
Pas de bénéficiaire
Pas de position source
Solde insuffisant
Budget dépassé sans autorisation
Pas de nature de dépense
Pas de justificatif obligatoire
Paiement fournisseur sans facture ni motif d’avance
Paiement salaire sans période de paie
Paiement agent sans campagne, mission ou motif
Compte OHADA absent
```

### 19.3 Transfert interne

Bloquer si :

```text
Source = destination
Source vide
Destination vide
Solde source insuffisant
Frais non rattachés à une position
Référence absente pour banque/mobile money
Justificatif absent pour retrait ou dépôt
```

---

## 20. UX, interactions et feedback

### 20.1 Toasts de succès

```text
Encaissement enregistré en brouillon.
Encaissement soumis à validation.
Encaissement validé et comptabilisé.
Décaissement validé. Le solde caisse a été mis à jour.
Transfert interne validé. Les deux positions ont été mises à jour.
```

### 20.2 Toasts d’erreur

```text
Impossible de valider : le solde de la caisse est insuffisant.
Impossible de comptabiliser : aucun compte OHADA n’est configuré pour cette nature d’opération.
Impossible d’enregistrer : la référence externe est obligatoire pour un virement bancaire.
Impossible de continuer : cette dépense dépasse le budget autorisé.
```

### 20.3 Infobulles

Sur “Position source” :

```text
Position d’où l’argent sort : caisse, banque ou mobile money.
```

Sur “Position destination” :

```text
Position où l’argent entre : caisse, banque, mobile money ou chèques à encaisser.
```

Sur “Paiement non affecté” :

```text
L’argent est reçu, mais il n’est pas encore rattaché à une facture ou à une créance. À traiter rapidement.
```

Sur “Compte OHADA” :

```text
Compte comptable utilisé pour générer automatiquement l’écriture.
```

### 20.4 États visuels

| État | Couleur recommandée |
|---|---|
| Brouillon | Gris |
| En attente | Orange |
| Validé | Bleu |
| Comptabilisé | Violet ou bleu foncé |
| Rapproché | Vert |
| Anomalie | Rouge |
| Annulé | Gris barré |

### 20.5 Résumé avant validation

Avant validation, afficher un résumé d’impact.

Exemple encaissement :

```text
Type : Encaissement client
Montant : 500 000 FCFA
Mode : Espèces
Destination : Caisse bureau
Client : Client ABC
Facture : FAC-2026-001
Impact trésorerie : Caisse +500 000
Impact comptable : Débit Caisse / Crédit Client
Impact budget : Recette réalisée +500 000
```

Exemple décaissement :

```text
Type : Paiement fournisseur
Montant : 150 000 FCFA
Mode : Espèces
Source : Caisse bureau
Bénéficiaire : Fournisseur XYZ
Impact trésorerie : Caisse -150 000
Impact comptable : Débit Fournisseur / Crédit Caisse
Impact budget : Dépense réalisée +150 000
```

---

## 21. Gestion des données

### 21.1 Tables principales

```text
cash_receipts              Encaissements
cash_disbursements         Décaissements
treasury_movements         Mouvements de trésorerie
treasury_positions         Caisses, banques, mobile money
accounting_accounts        Plan comptable OHADA
accounting_entries         Écritures comptables
accounting_entry_lines     Lignes débit/crédit
budget_lines               Lignes budgétaires
third_parties              Clients, fournisseurs, agents
attachments                Justificatifs
approval_workflows         Circuits de validation
audit_logs                 Historique
reconciliations            Rapprochements
sync_errors                Erreurs de synchronisation
```

### 21.2 Table `cash_receipts`

```sql
id
receipt_no
receipt_date
payer_type
payer_id
receipt_nature
payment_method
destination_position_id
amount
currency
external_reference
invoice_id
budget_line_id
accounting_status
treasury_status
budget_status
allocation_status
status
reason
created_by
submitted_by
submitted_at
validated_by
validated_at
cancelled_by
cancelled_at
cancellation_reason
created_at
updated_at
```

### 21.3 Table `cash_disbursements`

```sql
id
disbursement_no
disbursement_date
beneficiary_type
beneficiary_id
disbursement_nature
payment_method
source_position_id
amount
currency
external_reference
supplier_invoice_id
payroll_id
budget_line_id
accounting_status
treasury_status
budget_status
allocation_status
status
reason
created_by
submitted_by
submitted_at
validated_by
validated_at
cancelled_by
cancelled_at
cancellation_reason
created_at
updated_at
```

### 21.4 Table `treasury_movements`

```sql
id
movement_no
source_module
source_record_id
movement_type
source_position_id
destination_position_id
amount
fees_amount
fees_position_id
status
movement_date
created_by
created_at
updated_at
```

Valeurs `source_module` :

```text
cash_receipt
cash_disbursement
internal_transfer
manual_adjustment
reconciliation_adjustment
```

### 21.5 Table `accounting_entries`

```sql
id
entry_no
entry_date
journal_code
source_module
source_record_id
label
status
created_by
validated_by
created_at
updated_at
```

### 21.6 Table `accounting_entry_lines`

```sql
id
entry_id
account_id
third_party_id
debit
credit
label
position_id
budget_line_id
created_at
updated_at
```

### 21.7 Table `accounting_mapping_rules`

```sql
id
operation_type
operation_nature
payment_method
position_type
third_party_type
debit_account_id
credit_account_id
journal_code
is_active
created_at
updated_at
```

### 21.8 Table `sync_errors`

```sql
id
source_module
source_record_id
error_type
error_message
technical_details
status
resolved_by
resolved_at
created_at
updated_at
```

---

## 22. API recommandées

### 22.1 Encaissements

```http
GET    /api/finance/receipts
POST   /api/finance/receipts
GET    /api/finance/receipts/:id
PATCH  /api/finance/receipts/:id
POST   /api/finance/receipts/:id/submit
POST   /api/finance/receipts/:id/validate
POST   /api/finance/receipts/:id/reject
POST   /api/finance/receipts/:id/cancel
POST   /api/finance/receipts/:id/allocate
```

### 22.2 Décaissements

```http
GET    /api/finance/disbursements
POST   /api/finance/disbursements
GET    /api/finance/disbursements/:id
PATCH  /api/finance/disbursements/:id
POST   /api/finance/disbursements/:id/submit
POST   /api/finance/disbursements/:id/validate
POST   /api/finance/disbursements/:id/reject
POST   /api/finance/disbursements/:id/cancel
POST   /api/finance/disbursements/:id/allocate
```

### 22.3 Trésorerie

```http
GET    /api/treasury/positions
POST   /api/treasury/positions
GET    /api/treasury/movements
POST   /api/treasury/internal-transfers
GET    /api/treasury/balances
POST   /api/treasury/reconciliations
```

### 22.4 Comptabilité

```http
GET    /api/accounting/accounts
GET    /api/accounting/mapping-rules
POST   /api/accounting/mapping-rules
GET    /api/accounting/entries
POST   /api/accounting/entries/generate
POST   /api/accounting/entries/:id/validate
GET    /api/accounting/anomalies
```

### 22.5 Budget

```http
GET    /api/budget/lines
GET    /api/budget/availability
POST   /api/budget/check
GET    /api/budget/variance
```

### 22.6 Contrôles

```http
GET    /api/controls/pending-validations
GET    /api/controls/anomalies
GET    /api/controls/audit-logs
POST   /api/controls/rebuild-sync
POST   /api/controls/sync-errors/:id/resolve
```

---

## 23. Architecture technique recommandée

### 23.1 Services métier

```text
ReceiptService
DisbursementService
TreasuryService
AccountingService
BudgetService
ApprovalService
AuditLogService
NotificationService
ReconciliationService
SyncControlService
```

### 23.2 Flux backend encaissement

```text
ReceiptController
→ ReceiptService.validateInput()
→ ApprovalService.submitOrValidate()
→ TreasuryService.createInflow()
→ AccountingService.generateEntry()
→ BudgetService.updateRealized()
→ AllocationService.allocateReceipt()
→ AuditLogService.record()
→ NotificationService.notify()
```

### 23.3 Flux backend décaissement

```text
DisbursementController
→ DisbursementService.validateInput()
→ BudgetService.checkAvailability()
→ TreasuryService.checkBalance()
→ ApprovalService.submitOrValidate()
→ TreasuryService.createOutflow()
→ AccountingService.generateEntry()
→ BudgetService.updateRealized()
→ AllocationService.allocateDisbursement()
→ AuditLogService.record()
→ NotificationService.notify()
```

### 23.4 Transaction base de données obligatoire

Toutes les validations doivent s’exécuter dans une transaction.

```text
BEGIN TRANSACTION

Créer / valider opération
Créer mouvement de trésorerie
Mettre à jour solde
Créer écriture comptable
Créer lignes comptables
Mettre à jour dette ou créance
Mettre à jour budget
Créer audit log

COMMIT
```

Si une étape échoue :

```text
ROLLBACK
```

Aucun cas ne doit produire :

```text
Encaissement validé mais solde non mis à jour
Décaissement validé mais écriture comptable absente
Budget mis à jour mais paiement rejeté
Dette soldée mais trésorerie non impactée
```

---

## 24. Qualité du code

### 24.1 Règles générales

Le code doit respecter les principes suivants :

```text
Contrôleurs minces
Services métier explicites
Règles métier centralisées
Validation côté backend obligatoire
Validation côté frontend complémentaire
Transactions base de données
DTO typés
Enums pour les statuts
Tests unitaires sur règles critiques
Tests d’intégration sur synchronisation
Audit log systématique
```

### 24.2 À éviter

```text
Logique métier dans les composants frontend
Mise à jour directe des soldes depuis les contrôleurs
Comptes OHADA codés en dur
Statuts écrits en texte libre
Suppression physique des opérations validées
Validation sans transaction
Silence en cas d’échec de synchronisation
```

### 24.3 Tests indispensables

| Test | Objectif |
|---|---|
| Encaissement validé | Vérifier trésorerie + comptabilité + budget |
| Décaissement validé | Vérifier solde source + dette + écriture |
| Solde insuffisant | Vérifier blocage |
| Compte OHADA absent | Vérifier blocage |
| Écriture déséquilibrée | Vérifier rollback |
| Doublon référence | Vérifier alerte |
| Annulation | Vérifier contre-mouvement et contre-écriture |
| Encaissement non affecté | Vérifier statut à affecter |
| Budget dépassé | Vérifier validation spéciale |
| Période clôturée | Vérifier interdiction de modification |

---

## 25. Rôles et permissions

| Action | Admin | Responsable financier | Comptable | Caissier | Manager | Auditeur |
|---|---:|---:|---:|---:|---:|---:|
| Créer encaissement | Oui | Oui | Oui | Oui | Non | Non |
| Créer décaissement | Oui | Oui | Oui | Limité | Non | Non |
| Soumettre | Oui | Oui | Oui | Oui | Non | Non |
| Valider | Oui | Oui | Non | Non | Non | Non |
| Rejeter | Oui | Oui | Non | Non | Non | Non |
| Annuler validé | Oui | Oui | Non | Non | Non | Non |
| Voir soldes | Oui | Oui | Oui | Limité | Oui | Oui |
| Paramétrer comptes OHADA | Oui | Oui | Non | Non | Non | Non |
| Faire rapprochement | Oui | Oui | Oui | Non | Non | Non |
| Exporter | Oui | Oui | Oui | Non | Oui | Oui |
| Consulter audit log | Oui | Oui | Non | Non | Oui | Oui |

---

## 26. Critères d’acceptation

### CA-001 — Encaissement validé

```gherkin
Étant donné un encaissement complet
Quand le responsable valide l’opération
Alors le système crée un mouvement de trésorerie entrant
Et augmente la position destination
Et génère une écriture comptable équilibrée
Et met à jour la créance ou la facture liée
Et met à jour le budget si applicable
Et enregistre l’action dans l’audit log
```

### CA-002 — Décaissement validé

```gherkin
Étant donné un décaissement complet
Quand le responsable valide l’opération
Alors le système crée un mouvement de trésorerie sortant
Et diminue la position source
Et génère une écriture comptable équilibrée
Et met à jour la dette ou la charge concernée
Et met à jour le budget réalisé
Et enregistre l’action dans l’audit log
```

### CA-003 — Blocage écriture non équilibrée

```gherkin
Étant donné une opération à comptabiliser
Quand le total débit est différent du total crédit
Alors la validation est bloquée
Et aucun solde n’est modifié
Et une anomalie est créée
```

### CA-004 — Blocage solde insuffisant

```gherkin
Étant donné une caisse avec un solde de 100 000
Quand l’utilisateur tente de valider un décaissement de 150 000
Alors le système bloque la validation
Et affiche un message de solde insuffisant
```

### CA-005 — Encaissement non affecté

```gherkin
Étant donné un encaissement reçu sans facture liée
Quand l’utilisateur choisit “paiement client”
Alors le système classe l’opération en “encaissement à affecter”
Ou demande une facture avant validation
```

### CA-006 — Décaissement fournisseur sans dette

```gherkin
Étant donné un décaissement fournisseur sans facture liée
Quand l’utilisateur tente de valider
Alors le système demande de choisir entre dépense directe, avance fournisseur ou paiement d’une dette existante
```

### CA-007 — Annulation

```gherkin
Étant donné une opération validée et comptabilisée
Quand un utilisateur autorisé annule l’opération
Alors le système crée un contre-mouvement
Et une contre-écriture
Et conserve l’historique complet
```

### CA-008 — Doublon référence externe

```gherkin
Étant donné une opération déjà enregistrée avec une référence externe
Quand l’utilisateur saisit une opération avec la même référence, le même montant et le même tiers
Alors le système affiche une alerte de doublon
```

### CA-009 — Budget dépassé

```gherkin
Étant donné un budget disponible insuffisant
Quand l’utilisateur soumet un décaissement
Alors le système bloque ou demande une validation spéciale selon le paramétrage
```

### CA-010 — Rapprochement

```gherkin
Étant donné une position de trésorerie
Quand l’utilisateur saisit le solde réel constaté
Alors le système calcule automatiquement l’écart avec le solde théorique
Et signale l’écart si celui-ci est différent de zéro
```

---

## 27. Risques et mesures de contrôle

| Risque | Mesure |
|---|---|
| Encaissement oublié dans la comptabilité | Génération automatique d’écriture |
| Décaissement sans dette soldée | Affectation obligatoire |
| Paiement fournisseur doublon | Détection doublon |
| Caisse négative | Blocage solde insuffisant |
| Banque fausse | Rapprochement bancaire |
| Mobile money oublié | Position mobile money dédiée |
| Chèque non suivi | Position chèques à encaisser |
| Budget dépassé | Contrôle budget avant validation |
| Mauvais compte OHADA | Mapping paramétrable |
| Écriture déséquilibrée | Blocage validation |
| Flux cassé entre modules | Transaction base de données |
| Suppression frauduleuse | Annulation par contre-opération |
| Justificatif absent | Règle selon seuil |
| Mauvaise direction source/destination | Résumé d’impact avant validation |
| Erreur silencieuse | Table sync_errors et alertes |
| Modification après validation | Verrouillage et audit log |

---

## 28. MVP recommandé

### 28.1 À développer en priorité

```text
Statuts robustes
Validation encaissement
Validation décaissement
Mouvements de trésorerie automatiques
Calcul soldes
Mapping comptable OHADA
Génération écriture comptable
Contrôle écriture équilibrée
Contrôle solde insuffisant
Contrôle budget simple
Justificatifs
Audit log
Dashboard anomalies
```

### 28.2 À reporter en version suivante

```text
Workflow multi-niveaux avancé
Import relevés bancaires
Import relevés mobile money
Rapprochement automatique
OCR justificatifs
États financiers OHADA complets
Détection intelligente des fraudes
Prévisions de trésorerie avancées
```

---

## 29. Ordre de mise en œuvre

```text
1. Audit des formulaires existants encaissement / décaissement
2. Ajout ou correction des statuts
3. Création des tables de synchronisation manquantes
4. Création du mapping comptable OHADA
5. Création des services TreasuryService et AccountingService
6. Mise en place des transactions de validation
7. Mise en place des règles anti-omissions
8. Ajout des contrôles budget
9. Ajout des toasts, infobulles et résumé avant validation
10. Ajout audit log
11. Ajout dashboard anomalies
12. Tests de bout en bout
13. Mise en production progressive
```

---

## 30. Logique finale

Le système doit respecter ces règles :

```text
Encaissement
→ augmente une position de trésorerie
→ diminue une créance ou crée un produit / une avance
→ génère une écriture comptable
→ met à jour budget, reporting et audit
```

```text
Décaissement
→ diminue une position de trésorerie
→ diminue une dette ou crée une charge / une avance
→ génère une écriture comptable
→ met à jour budget, reporting et audit
```

```text
Transfert interne
→ diminue une position
→ augmente une autre position
→ ne crée ni produit ni charge
→ génère seulement une écriture interne de trésorerie
```

La règle structurante est la suivante :

```text
Une opération validée ne doit jamais rester seule.
Elle doit toujours produire ses impacts contrôlés dans la trésorerie, la comptabilité, le budget, les tiers, le reporting et l’audit.
```

---

## 31. Checklist de contrôle avant développement

| Point | Statut |
|---|---|
| Les types d’encaissement sont définis | À vérifier |
| Les types de décaissement sont définis | À vérifier |
| Les positions de trésorerie existent | À vérifier |
| Les comptes OHADA sont paramétrables | À vérifier |
| Le mapping comptable existe | À vérifier |
| Les statuts sont normalisés | À vérifier |
| Les validations sont centralisées backend | À vérifier |
| Les soldes sont mis à jour en transaction | À vérifier |
| Les écritures sont équilibrées | À vérifier |
| Les justificatifs sont contrôlés | À vérifier |
| Les doublons sont détectés | À vérifier |
| Les opérations validées ne sont pas supprimables | À vérifier |
| Les annulations créent des contre-opérations | À vérifier |
| Les écarts de rapprochement sont signalés | À vérifier |
| Les anomalies sont visibles dans un dashboard | À vérifier |

---

## 32. Nom de fichier recommandé

```text
PRD_flux_encaissement_decaissement_tresorerie_comptabilite_budget.md
```

---

## 33. Compte rendu d'implémentation du lot comptabilité OHADA

Date de contrôle : 7 juin 2026.

### 33.1 Scénario livré

```text
Opération validée et éligible
→ recherche de la règle comptable active la plus spécifique
→ génération idempotente d'un brouillon à deux lignes
→ contrôle période ouverte et débit = crédit
→ validation comptable séparée
→ accounting_status synchronisé
→ anomalie traçable si le mapping ou la période bloque le flux
→ contre-écriture append-only avec date et motif obligatoires
```

### 33.2 Éléments terminés et prouvés

| Élément | Statut | Preuve |
|---|---|---|
| Comptes OHADA de référence | Terminé | `accounting_accounts`, seeds MySQL/SQLite idempotents |
| Règles de mapping | Terminé techniquement | Création en brouillon, activation explicite Admin/Finance/DG |
| Matching spécifique puis wildcard | Terminé | Service central `selectAccountingMapping` |
| Génération automatique | Terminé | Encaissement validé, virement validé, décaissement payé |
| Idempotence | Terminé | Une seule écriture draft/posted par source |
| Équilibre comptable | Terminé | Validation refusée si moins de deux lignes ou débit différent du crédit |
| Période clôturée | Terminé | Génération, validation et contre-écriture refusées |
| Statut source | Terminé | `pending`, `error`, `synced`, `cancelled` synchronisés |
| Audit et anomalies | Terminé | `audit_logs`, `sync_errors`, file « À comptabiliser » |
| Immutabilité après posting | Terminé | Modification et annulation directe bloquées |
| Contre-écriture comptable | Terminé | Brouillon inverse idempotent, motif obligatoire, validation séparée |
| Interface comptable | Terminé | Écritures, anomalies et règles dans une vue canonique unique |
| File des anomalies | Terminé | KPI calculés sur l'ensemble, API paginée `limit/offset`, 50 lignes maximum dans le DOM |
| Responsive | Terminé | Contrôles Playwright 320, 390, 768, 1024 et 1440 px |

### 33.3 Décisions de sécurité des données

- Les règles initiales restent inactives tant qu'un responsable comptable ne valide pas les comptes débit/crédit.
- Aucun rattrapage historique n'est lancé automatiquement au déploiement.
- Aucune écriture de production n'est créée par une migration.
- Une écriture validée n'est jamais modifiée ou supprimée : sa correction passe par une contre-écriture.
- La contre-écriture comptable ne remplace pas une contre-opération de trésorerie. Les deux flux doivent rester explicitement distingués.

### 33.4 Étapes métier restantes

| Priorité | Étape | Condition de démarrage |
|---|---|---|
| P1 | Valider la matrice de mappings avec le comptable | Comptes OHADA et règles approuvés par écrit |
| P1 | Activer progressivement les mappings approuvés | Test sur un échantillon représentatif |
| P1 | Rattraper les opérations historiques par lots contrôlés | Simulation, rapport d'écarts et validation utilisateur |
| P2 | Automatiser la contre-opération de trésorerie liée à une annulation métier | Règles d'annulation, date de valeur et autorisations formalisées |
| P2 | Brancher budget et affectations tiers sur la même orchestration transactionnelle | Contrats BudgetService/AllocationService stabilisés |

### 33.5 Non-régression obligatoire

```text
npm test
node --check des services et routes modifiés
validation syntaxique des scripts inline du dashboard
git diff --check
Playwright desktop/mobile
contrôle production en lecture seule après CI/CD
```
