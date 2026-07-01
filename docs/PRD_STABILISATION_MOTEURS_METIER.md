# PRD — Stabilisation des moteurs métier Tala-SMI

## 1. Problème

Tala-SMI couvre déjà les agents, congés, présence, paie, encaissements, décaissements, achats, délégations, audit et notifications. Plusieurs fonctionnalités existent, mais leurs moteurs restent partiellement consolidés : règles dispersées, statuts incohérents, calculs dupliqués, effets de bord non transactionnels, audit incomplet et UI parfois déconnectée du métier.

L’objectif est de stabiliser les moteurs existants avant d’ajouter de nouveaux modules.

## 2. Vision

Chaque opération critique doit reposer sur un moteur canonique, transactionnel, auditable, idempotent et testé sur MySQL.

Principes obligatoires :

1. une source de vérité ;
2. un workflow explicite ;
3. des transitions contrôlées ;
4. des règles centralisées dans un service métier ;
5. des permissions vérifiées côté serveur ;
6. des transactions ;
7. un audit complet ;
8. des notifications cohérentes ;
9. une UI dérivée du workflow ;
10. des tests unitaires, intégration, MySQL et concurrence.

## 3. Priorités

### P0

- Agents
- Congés, absences, présence et pointeuse
- Salaires et paie
- Encaissements
- Décaissements
- Demandes d’achat
- Délégations et permissions
- Audit transversal

### P1

Contrats, avances, fournisseurs, stock, réception, parapheur, notifications, clôtures et rapports.

## 4. Architecture cible

Chaque domaine doit avoir un service canonique :

```text
agent_service.js
leave_service.js
attendance_service.js
payroll_service.js
cash_receipt_service.js
cash_disbursement_service.js
purchase_request_service.js
delegation_engine.js
audit_service.js
```

Les routes HTTP doivent seulement authentifier, valider, appeler le service et retourner la réponse.

Toute opération multi-écriture doit être transactionnelle. Aucune transition sensible ne doit être faite par une simple mise à jour libre du champ `statut`.

## 5. Agents

Workflow cible :

```text
Brouillon → Pré-enregistré → Actif → Suspendu → Sorti → Archivé
```

À l’activation : créer ou lier le compte, attribuer le profil, créer l’affectation, initialiser contrat et paie, activer la pointeuse, créer la checklist et notifier RH/manager.

À la sortie : désactiver le compte, fermer les affectations, suspendre les droits, bloquer les nouveaux bulletins et déclencher la checklist de sortie.

UI attendue : assistant multiétape, fiche consolidée, statut, onboarding, affectation, alertes documentaires, historique et accès système.

## 6. Congés, absences, présence et pointeuse

Le moteur congés est avancé, mais le domaine temps reste incomplet.

Le moteur unifié doit gérer : congés, absences, présence, retards, sorties, missions, travail hors site, heures supplémentaires, anomalies, corrections et clôture mensuelle.

Situation journalière cible :

```text
Présent
Absent justifié
Absent injustifié
Congé payé
Congé non payé
Maladie
Mission
Repos
Jour férié
Télétravail
Suspension
Pointage incomplet
```

La pointeuse doit gérer entrée, sortie, pauses, multi-pointages, horaires fixes/variables, shifts, nuit, passage de minuit, week-ends, jours fériés, doublons, badge oublié, import machine et correction auditée.

Anomalies : retard, départ anticipé, absence sans justificatif, sortie sans retour, pointage hors plage, double pointage, absence de pointage et incohérence avec un congé.

Le moteur doit produire une synthèse mensuelle figée pour la paie. La paie ne doit pas recalculer les pointages bruts.

UI attendue : calendrier, vue journalière, feuille mensuelle, anomalies, corrections, validation manager, clôture RH et synthèse paie.

## 7. Salaires et paie

Workflow cible :

```text
Période ouverte → Préparation → Simulation → Contrôle → Validation → Paiement → Clôture
```

Chaque bulletin doit conserver la période, le salaire contractuel, les rubriques, quantités, taux, montants, origine des données, version de calcul, présence, congés non payés, avances, primes, retenues et corrections.

Un bulletin validé ne doit jamais être modifié silencieusement. Toute correction doit produire une rectification, une régularisation ou une réouverture explicite.

Le paiement doit être idempotent, créer l’écriture financière, tracer le mode de paiement et empêcher un second paiement.

## 8. Encaissements

Workflow cible :

```text
Brouillon → Soumis → Validé → Encaissé → Rapproché → Clôturé
```

Branches : rejeté, annulé, contre-passé, en litige.

Règles : caisse obligatoire, aucune modification après validation, correction par annulation/contre-écriture, pièce obligatoire selon seuil, distinction produit/remboursement/avance/transfert interne, numéro unique et date opérationnelle distincte de la date de saisie.

Le moteur doit fournir le solde courant, le solde à date, le solde avant/après opération, les clôtures, les écarts et la gouvernance du solde initial.

## 9. Décaissements

Workflow cible :

```text
Brouillon → Soumis → Contrôle finance → Validation hiérarchique → Autorisé → Payé → Rapproché → Clôturé
```

Branches : rejeté, à corriger, annulé, contre-passé, en litige.

Règles : séparation initiateur/validateur selon seuil, approbation DG au-delà du seuil, contrôle de disponibilité, pièces obligatoires, rubrique et bénéficiaire obligatoires, paiement idempotent, contre-écriture après paiement et motif obligatoire pour rejet/annulation/override.

## 10. Demandes d’achat

Workflow cible :

```text
Besoin → Demande → Validation → Consultation → Sélection → Commande → Réception → Contrôle → Facture → Paiement → Clôture
```

Règles : le demandeur ne valide pas seul, budget ou centre de coût obligatoire, seuils d’approbation, justification fournisseur, réception distincte de la commande, réception partielle, contrôle des écarts et paiement lié à facture et réception.

## 11. Délégations et permissions

État avancé : moteur canonique, permissions asynchrones corrigées, cycles directs/indirects, chevauchements, permissions non délégables, redélégation contrôlée, plafond hérité et compatibilité MySQL.

Travaux restants : audit de l’autorité représentée, intégration dans toutes les actions sensibles, suppression des moteurs parallèles, UI complète, révocation visible et chaîne d’autorité.

## 12. Audit transversal

Chaque action sensible doit enregistrer :

```text
actor_user_id
represented_user_id
delegation_id
module
entity_type
entity_id
action
old_state
new_state
reason
amount
metadata
created_at
```

Événements obligatoires : création, modification, soumission, validation, approbation, rejet, paiement, annulation, contre-passation, clôture, réouverture, délégation, révocation, override et correction rétroactive.

## 13. UI/UX

Chaque écran doit refléter le statut réel, les actions autorisées, les blocages, les pièces manquantes, la prochaine étape, l’impact financier ou RH et l’historique.

Composants communs : timeline, badges, panneau de validation, pièces jointes, audit, commentaires, délégation active, avertissements, résumé d’impact et confirmation avant action sensible.

## 14. Stratégie de livraison

### Phase 1 — Cartographie

Inventorier routes, services, tables, écrans, statuts, duplications et invariants.

### Phase 2 — Consolidation backend

Ordre : agents, présence/absences, paie, encaissements, décaissements, achats, délégations, audit.

### Phase 3 — Intégration

Présence → paie ; congés → paie ; avances → paie ; achats → stock ; achats → décaissements ; paiements → journal ; délégations → audit.

### Phase 4 — UI/UX

Construire les écrans après stabilisation du contrat backend du module.

### Phase 5 — Clôture et reporting

Clôtures journalières/mensuelles, rapports, exports, tableaux de bord et contrôles de cohérence.

## 15. Méthode

```text
Test rouge → Service métier → Transaction → Route → Audit → Notification → UI → Test MySQL → Test de concurrence → Documentation
```

## 16. Definition of Done

Un moteur est terminé uniquement si son workflow est documenté, ses statuts sont canoniques, ses transitions centralisées, ses permissions vérifiées, ses opérations transactionnelles et idempotentes, son audit complet, son UI cohérente, ses tests verts et sa documentation à jour.

## 17. Ordre d’exécution

### Lot 1 — Temps et RH

Agents, congés, absences, présence, pointeuse et liaison paie.

### Lot 2 — Paie

Périodes, calcul, bulletins, rectifications, paiement et clôture.

### Lot 3 — Trésorerie

Encaissements, décaissements, transferts internes, solde historique, rapprochement et clôture.

### Lot 4 — Achats

Demande, approbation, commande, réception, facture et paiement.

### Lot 5 — Gouvernance

Permissions, délégations, audit, notifications et reporting.

## 18. Première tranche à lancer

### Moteur canonique de présence et d’absence

Livrables : modèle journalier agent, statuts de présence, service de calcul, anomalies, import/saisie des pointages, correction auditée, clôture mensuelle, synthèse paie, tests unitaires, test MySQL et première UI calendrier/anomalies.
