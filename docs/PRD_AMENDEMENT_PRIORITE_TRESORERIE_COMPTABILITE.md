# Amendement au PRD — Priorité Trésorerie et Comptabilité journalière

## 1. Décision de priorité

À compter de cet amendement, la stabilisation du domaine Temps/RH est suspendue après la tranche 1C.

Les tranches 1D, 1E et 1F restent prévues, mais ne sont plus prioritaires.

La priorité opérationnelle immédiate devient :

```text
Trésorerie journalière
→ Encaissements
→ Décaissements
→ Versements en banque
→ Retraits bancaires
→ Transferts internes
→ Corrections et contre-passations
→ Soldes historiques
→ Clôture journalière
→ Génération comptable
→ Rapprochement bancaire et de caisse
```

Cet amendement prévaut sur l’ordre d’exécution précédent du PRD principal.

## 2. Problème métier critique

Tala-SMI ne permet pas actuellement d’obtenir avec suffisamment de fiabilité :

- la position financière exacte d’une journée ;
- le total réel des encaissements du jour ;
- le total réel des décaissements du jour ;
- les versements de caisse vers banque ;
- les retraits de banque vers caisse ;
- les transferts entre caisses, banques et Mobile Money ;
- le solde d’ouverture et le solde de clôture par position ;
- la correction propre d’une opération erronée ;
- l’explication complète d’un écart ;
- une comptabilité journalière cohérente et traçable.

Les données financières sont confuses parce que plusieurs notions sont mélangées : recette, dépense, transfert interne, paiement, mouvement bancaire, correction, annulation et écriture comptable.

## 3. Principe de reconstruction

Nous ne supprimerons pas immédiatement les données existantes.

La reconstruction doit suivre cette séquence :

```text
Cartographier
→ Classifier les données existantes
→ Définir le modèle canonique
→ Bloquer les nouvelles incohérences
→ Migrer ou rattacher les historiques
→ Corriger par contre-écriture
→ Clôturer les journées
→ Produire les écritures comptables
```

Aucune donnée financière validée ne doit être modifiée ou supprimée silencieusement.

Une erreur doit être corrigée par :

- annulation explicite avant validation ;
- rejet avec motif avant paiement ou encaissement ;
- contre-passation après validation ;
- écriture de régularisation après clôture ;
- réouverture contrôlée dans les cas exceptionnels.

## 4. Source de vérité financière

Chaque mouvement financier doit posséder au minimum :

```text
id
numero_operation
type_mouvement
sens
position_source_id
position_destination_id
montant
devise
date_operationnelle
date_saisie
statut
mode_paiement
reference_externe
beneficiaire_ou_payeur
motif
source_module
source_entity_type
source_entity_id
created_by
validated_by
paid_or_collected_by
reversed_operation_id
created_at
validated_at
executed_at
closed_at
```

Le type de mouvement doit distinguer clairement :

- encaissement externe ;
- décaissement externe ;
- transfert interne ;
- versement en banque ;
- retrait bancaire ;
- transfert caisse vers Mobile Money ;
- transfert Mobile Money vers caisse ;
- remboursement ;
- avance ;
- régularisation ;
- contre-passation ;
- solde initial ou reprise historique.

## 5. Positions de trésorerie

Une position de trésorerie représente un contenant réel de fonds :

- caisse espèces ;
- compte bancaire ;
- portefeuille Mobile Money ;
- caisse de site ;
- petite caisse ;
- compte transitoire autorisé.

Chaque position doit avoir :

- un identifiant unique ;
- un type ;
- un site ou service ;
- une devise ;
- un responsable ;
- un solde initial gouverné ;
- une date d’ouverture ;
- un statut actif ou clôturé ;
- des droits de visibilité et d’action.

Un transfert interne ne constitue ni un produit ni une charge. Il doit créer deux impacts liés : sortie de la position source et entrée de la position destination, sans modifier la trésorerie consolidée.

## 6. Journal financier journalier cible

Pour chaque date et chaque position, l’interface doit afficher :

```text
Solde d’ouverture
+ Encaissements externes
- Décaissements externes
+ Transferts reçus
- Transferts émis
+ Retraits reçus en caisse
- Versements remis en banque
± Régularisations
= Solde théorique de clôture

Solde physique ou relevé déclaré
Écart constaté
Statut de rapprochement
```

Le journal doit permettre de descendre jusqu’à chaque opération et chaque pièce justificative.

## 7. Nouveau workflow canonique

### 7.1 Encaissement

```text
Brouillon
→ Soumis
→ Contrôlé
→ Validé
→ Encaissé
→ Rapproché
→ Clôturé
```

Branches : rejeté, à corriger, annulé, contre-passé, en litige.

### 7.2 Décaissement

```text
Brouillon
→ Soumis
→ Contrôle finance
→ Validation hiérarchique
→ Autorisé
→ Payé
→ Rapproché
→ Clôturé
```

Branches : rejeté, à corriger, annulé, contre-passé, en litige.

### 7.3 Transfert interne

```text
Brouillon
→ Soumis par la source
→ Autorisé
→ Fonds remis ou envoyés
→ Réception confirmée par la destination
→ Rapproché
→ Clôturé
```

La confirmation par la destination est obligatoire lorsque les fonds changent de responsable ou de canal.

## 8. Corrections financières

L’application doit permettre de corriger par jour sans altérer l’historique.

### Avant validation

- modification du brouillon ;
- suppression contrôlée du brouillon ;
- rejet et resoumission.

### Après validation mais avant clôture

- annulation avec motif si aucun mouvement réel n’a eu lieu ;
- contre-passation si le mouvement a déjà eu un impact ;
- nouvelle opération corrigée liée à l’ancienne.

### Après clôture

- aucune modification directe ;
- régularisation datée de la période ouverte ;
- lien vers l’opération historique ;
- autorisation Finance ou DG ;
- justification obligatoire ;
- audit avant/après.

## 9. Clôture journalière

Une journée doit pouvoir être clôturée par position de trésorerie.

La clôture doit vérifier :

- aucune opération en brouillon ou soumise non traitée ;
- aucun transfert envoyé non confirmé ;
- aucun paiement sans justificatif requis ;
- solde théorique calculé ;
- solde physique ou relevé déclaré ;
- écart expliqué ou signalé ;
- identité du clôturant ;
- date et heure de clôture.

Après clôture, les mouvements de la journée sont figés.

La réouverture doit être exceptionnelle, motivée, auditée et réservée à des rôles autorisés.

## 10. Comptabilité journalière

Les écritures comptables doivent être générées à partir des mouvements financiers validés, jamais saisies comme une seconde vérité indépendante sans lien avec la source.

Chaque écriture doit conserver :

- l’opération source ;
- le journal comptable ;
- le compte débité ;
- le compte crédité ;
- le montant ;
- la date comptable ;
- la règle de mapping utilisée ;
- le statut brouillon ou comptabilisé ;
- l’utilisateur ayant validé ;
- l’écriture de contre-passation éventuelle.

Une écriture comptabilisée doit être équilibrée et immuable.

## 11. Nouvelle série de tranches verticales prioritaires

### Tranche F0 — Cartographie et diagnostic des données existantes

Backend : inventaire des tables, statuts, types, doublons, opérations orphelines, soldes incohérents et écritures sans source.

Frontend : écran de diagnostic en lecture seule avec compteurs, anomalies et export.

Livrable : rapport de santé financière et plan de reprise des données.

### Tranche F1 — Positions de trésorerie canoniques

Backend : modèle unique des caisses, banques et Mobile Money ; gouvernance du solde initial.

Frontend : liste, création, modification contrôlée, solde courant et responsables.

### Tranche F2 — Journal financier journalier

Backend : endpoint canonique par date et position avec solde d’ouverture, mouvements et solde théorique.

Frontend : vue journalière unique permettant de comprendre tous les encaissements et décaissements d’une journée.

### Tranche F3 — Classification des opérations

Backend : types canoniques et distinction externe/interne.

Frontend : formulaires guidés selon encaissement, décaissement, versement, retrait ou transfert.

### Tranche F4 — Correction et contre-passation

Backend : annulation, contre-écriture, régularisation, motif obligatoire, audit et protection après clôture.

Frontend : action de correction par jour, aperçu de l’impact et historique avant/après.

### Tranche F5 — Transferts internes, versements et retraits

Backend : double impact lié, confirmation de réception et idempotence.

Frontend : suivi source/destination, fonds en transit et confirmation.

### Tranche F6 — Clôture journalière et rapprochement

Backend : solde théorique, solde déclaré, écarts, verrouillage et réouverture contrôlée.

Frontend : assistant de clôture par caisse ou banque.

### Tranche F7 — Génération comptable

Backend : mappings OHADA, génération équilibrée, validation et contre-passation.

Frontend : aperçu des écritures générées, anomalies de mapping et validation comptable.

### Tranche F8 — Reprise des historiques

Backend : classification, migration et rattachement des anciennes opérations sans destruction de preuve.

Frontend : file de traitement des données ambiguës et validation humaine.

## 12. Ordre d’exécution révisé

```text
1. Trésorerie et comptabilité journalière
2. Finalisation du temps et de la présence
3. Paie et liaison présence
4. Achats et fournisseurs
5. Gouvernance transversale
```

## 13. Point de reprise immédiat

La prochaine étape n’est pas de coder directement un nouveau solde.

Elle est de réaliser la tranche F0 : cartographier précisément l’existant et produire un diagnostic chiffré avant toute migration ou refonte destructive.
