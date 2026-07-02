# 09 — Audit Contrats

## 1. Verdict provisoire

**Contrats : partiellement exploitable pour le suivi administratif, non industrialisé comme moteur juridique et financier complet.**

Le dépôt contient :

- contrats clients, fournisseurs et employés ;
- numérotation ;
- dates de début et fin ;
- durée ;
- renouvellement automatique ;
- montant et périodicité ;
- conditions de paiement ;
- pénalités et obligations ;
- échéances récurrentes ;
- transitions de statut ;
- renouvellement avec contrat parent ;
- alertes d’expiration ;
- génération automatique de factures clients.

Mais le module confond encore contrat juridique, calendrier de facturation et activation opérationnelle. Il ne prouve pas la signature, la version documentaire, les signataires, l’approbation interne, le parapheur, les pièces contractuelles, les obligations exécutées, les avenants ni l’intégration complète avec paie, achats, facturation, comptabilité et budget.

## 2. Modèle observé

### 2.1 Types de parties

```text
client
fournisseur
employe
```

`partie_id` est polymorphe sans clé étrangère vers la table réelle. La cohérence dépend donc du code.

### 2.2 Types de contrats

```text
client
fournisseur
prestation
maintenance
abonnement
location
bail
salaire
cadre
```

### 2.3 Workflow

```text
brouillon
→ en_validation
→ signe
→ actif
→ suspendu / litige / resilie / expire / renouvele / cloture
```

Le code autorise cependant aussi :

```text
brouillon → signe
brouillon → actif
en_validation → actif
```

La signature n’est donc pas obligatoire avant activation.

### 2.4 Échéances

Les échéances sont générées à la création du contrat si le montant est positif. Elles reçoivent les statuts :

```text
a_facturer
facture
paye
en_retard
annule
```

La génération est plafonnée à 120 échéances.

### 2.5 Renouvellement

Le renouvellement crée un nouveau contrat relié par `contrat_parent_id`, avec statut directement `actif`, puis génère de nouvelles échéances.

### 2.6 Facturation récurrente

Un traitement périodique recherche les échéances du jour des contrats clients actifs et crée une facture client en brouillon. L’échéance passe ensuite à `facture`.

## 3. Anomalies

### CTR-001 — Activation sans signature

- Gravité : critique.
- Preuve : transitions `brouillon → actif` et `en_validation → actif` autorisées.
- Conséquence : contrat opérationnel et facturable sans preuve de signature.
- Correction : imposer `approved → signed → active`, sauf type explicitement exempté.

### CTR-002 — Signature seulement représentée par un statut

- Gravité : critique.
- Preuve : aucun signataire, fichier signé, empreinte, date de signature ou moyen de preuve n’est démontré dans le modèle observé.
- Conséquence : impossible de prouver qui a signé quoi et quelle version.
- Correction : entités document/version/signature avec empreinte et horodatage.

### CTR-003 — Permissions basées sur rôles larges

- Gravité : haute.
- Preuve : création, modification, activation, résiliation et renouvellement autorisés à `admin`, `finance`, `dg`.
- Conséquence : même utilisateur peut rédiger, approuver, activer, résilier et renouveler.
- Correction : permissions distinctes et séparation des fonctions.

### CTR-004 — Audit non bloquant

- Gravité : critique.
- Preuve : `auditLog()` ignore les erreurs.
- Conséquence : changement contractuel possible sans trace.
- Correction : audit transactionnel ou outbox durable.

### CTR-005 — Génération de numéro concurrente

- Gravité : haute.
- Preuve : lecture du dernier numéro puis incrément en mémoire.
- Conséquence : collisions lors de créations simultanées.
- Correction : séquence atomique MySQL ou compteur verrouillé.

### CTR-006 — Partie polymorphe sans intégrité référentielle

- Gravité : haute.
- Preuve : `partie_id + partie_type` sans clé étrangère vers client, fournisseur ou employé.
- Conséquence : contrats orphelins ou rattachés au mauvais type.
- Correction : table de parties contractuelles canonique ou contraintes applicatives centralisées et testées.

### CTR-007 — Échéances générées avant validation et signature

- Gravité : haute.
- Preuve : échéances créées dès le POST du contrat en brouillon.
- Conséquence : dette, facture ou alerte potentielle sur un projet non approuvé.
- Correction : générer à l’activation ou conserver un calendrier prévisionnel non exécutable.

### CTR-008 — Modification du contrat sans régénération des échéances

- Gravité : critique.
- Preuve : montant, dates et périodicité peuvent être modifiés en brouillon/en validation, mais les échéances existantes ne sont pas recalculées dans le chemin observé.
- Conséquence : contrat et calendrier financier divergents.
- Correction : régénération transactionnelle versionnée ou interdiction de modifier après génération.

### CTR-009 — Renouvellement directement actif

- Gravité : critique.
- Preuve : le nouveau contrat est inséré avec statut `actif`.
- Conséquence : contournement de validation et signature de la nouvelle version.
- Correction : renouvellement en brouillon ou en validation, puis signature et activation.

### CTR-010 — Ancien contrat non marqué renouvelé atomiquement

- Gravité : haute.
- Preuve : création du nouveau contrat observée, sans mise à jour explicite de l’ancien vers `renouvele` dans la même transaction.
- Conséquence : deux contrats actifs couvrant la même période.
- Correction : transaction unique ancien contrat + nouveau contrat + échéances.

### CTR-011 — Résiliation stockée dans notes

- Gravité : haute.
- Preuve : le motif est concaténé dans `notes`; les colonnes dédiées `motif_resiliation` et `date_resiliation` ne sont pas utilisées dans le chemin observé.
- Conséquence : reporting et preuve juridique faibles.
- Correction : champs dédiés obligatoires, date d’effet, auteur, pénalité et pièce.

### CTR-012 — Pénalité ambiguë

- Gravité : haute.
- Preuve : la route de résiliation remplace `penalites` par un nombre alors que le schéma définit un texte de conditions de pénalité.
- Conséquence : destruction ou confusion entre clause contractuelle et montant appliqué.
- Correction : séparer clause, calcul, montant et écriture financière.

### CTR-013 — Transition générique de statut sans motif obligatoire

- Gravité : haute.
- Preuve : `PUT /:id/statut` accepte un motif optionnel.
- Conséquence : suspension, litige, clôture ou annulation sans justification.
- Correction : commande dédiée par transition avec validations propres.

### CTR-014 — Échéance modifiable directement

- Gravité : critique.
- Preuve : endpoint permettant de mettre une échéance à `facture`, `payee` ou `annulee` directement.
- Conséquence : échéance déclarée payée sans encaissement, allocation ni preuve bancaire.
- Correction : statut dérivé de la facture et des paiements, jamais modifié manuellement.

### CTR-015 — Facturation cron avec utilisateur codé en dur

- Gravité : haute.
- Preuve : création de facture avec `created_by = 1`.
- Conséquence : audit attribué à un utilisateur arbitraire ou inexistant.
- Correction : compte de service identifié et gouverné.

### CTR-016 — Numérotation des factures concurrente

- Gravité : haute.
- Preuve : même modèle “dernier numéro + 1”.
- Conséquence : doublons et échec partiel du cron.
- Correction : séquence atomique.

### CTR-017 — Traitement cron sans revendication idempotente

- Gravité : critique.
- Preuve : sélection des échéances puis traitement ligne par ligne ; aucune réservation atomique préalable observée.
- Conséquence : deux instances peuvent facturer la même échéance.
- Correction : verrouillage `FOR UPDATE SKIP LOCKED`, statut de traitement et contrainte unique facture-échéance.

### CTR-018 — Erreurs cron seulement journalisées

- Gravité : haute.
- Preuve : erreurs imprimées en console puis traitement poursuivi.
- Conséquence : échéances oubliées sans file de reprise ni alerte durable.
- Correction : table de jobs/erreurs, retry idempotent et alerte.

### CTR-019 — Alerte d’expiration limitée au log console

- Gravité : moyenne.
- Conséquence : aucune garantie que les responsables reçoivent l’alerte.
- Correction : notification persistante avec destinataires et accusé de traitement.

### CTR-020 — Aucun avenant formel

- Gravité : critique.
- Preuve : seule la relation parent/enfant de renouvellement est visible.
- Conséquence : modification juridique d’un contrat actif sans chaîne d’avenant.
- Correction : avenant versionné, signé, avec date d’effet et champs modifiés.

### CTR-021 — Obligations non structurées

- Gravité : haute.
- Preuve : `obligations` est un texte libre.
- Conséquence : impossibilité de suivre livrables, SLA, garanties, pénalités et preuves d’exécution.
- Correction : obligations structurées avec responsable, échéance, statut et preuve.

### CTR-022 — Contrats employés non intégrés au moteur RH

- Gravité : critique.
- Preuve : type `employe/salaire` possible, mais aucune preuve que contrat actif gouverne poste, rémunération, paie et fin de relation.
- Conséquence : paie possible sans contrat applicable ou avec conditions divergentes.
- Correction : service canonique RH-contrat, une version applicable par période.

### CTR-023 — Contrats fournisseurs non reliés aux achats

- Gravité : haute.
- Preuve : aucune preuve que conditions, plafonds ou tarifs du contrat fournisseur contrôlent les BC et factures.
- Conséquence : achat hors contrat ou prix non conforme.
- Correction : rattachement obligatoire selon catégorie et contrôle contractuel.

### CTR-024 — Contrats clients et reconnaissance du revenu non reliés

- Gravité : haute.
- Preuve : facturation récurrente existe, mais prestations réalisées, taxes, comptabilité et allocations d’encaissement ne sont pas prouvées.
- Conséquence : facture automatique sans preuve de service ou écriture comptable complète.
- Correction : règle par type de contrat et chaîne facture → créance → encaissement → comptabilité.

### CTR-025 — Gestion des dates par `Date` JavaScript

- Gravité : moyenne.
- Preuve : génération des échéances par `setMonth`, `setFullYear`, `toISOString`.
- Conséquence : dérive de fin de mois et fuseau, notamment pour contrats démarrant les 29, 30 ou 31.
- Correction : moteur de calendrier métier explicite avec règle fin de mois.

### CTR-026 — Plafond silencieux de 120 échéances

- Gravité : haute.
- Preuve : `MAX_ECHEANCES = 120` sans erreur métier visible.
- Conséquence : contrat long tronqué silencieusement.
- Correction : validation de durée ou génération progressive documentée.

## 4. Modèle canonique proposé

```text
contract
contract_version
contract_party
contract_document
contract_signature
contract_approval
contract_amendment
contract_obligation
contract_schedule
contract_event
```

### États distincts

```text
drafting_status
approval_status
signature_status
execution_status
billing_status
termination_status
```

Le statut affiché est une projection, pas une seconde vérité.

## 5. Invariants obligatoires

1. Une version active est immuable.
2. Toute modification d’un contrat actif passe par avenant ou renouvellement.
3. Aucun contrat ne devient actif sans approbation et signature requises.
4. La signature référence exactement une version documentaire.
5. Une partie contractuelle existe et correspond au type annoncé.
6. Les échéances exécutables sont générées depuis la version active.
7. Une échéance payée est dérivée de paiements réels.
8. Une échéance facturée référence une facture unique.
9. Un renouvellement ne crée pas deux périodes actives incohérentes.
10. Résiliation, suspension et litige sont motivés et auditables.
11. Les contrats salariés gouvernent les données utilisées par la paie.
12. Les contrats fournisseurs gouvernent les achats concernés.
13. Les contrats clients gouvernent facturation et créance.
14. Les traitements automatiques sont idempotents et reprenables.

## 6. Ordre de redressement

### P0

1. Interdire activation sans signature.
2. Supprimer les mises à jour manuelles d’échéance vers `payee`.
3. Rendre le cron de facturation idempotent.
4. Corriger numérotation concurrente.
5. Rendre l’audit fiable.
6. Séparer permissions de rédaction, approbation, signature, activation et résiliation.
7. Régénérer ou versionner les échéances après modification.

### P1

1. Version et document signé.
2. Avenants.
3. Parties contractuelles canoniques.
4. Obligations structurées.
5. Intégration RH, achats, facturation et comptabilité.

## 7. Conclusion

Le module sait suivre des contrats et produire des échéances, mais il ne constitue pas encore un système contractuel probant. Le risque majeur est qu’un contrat puisse être activé sans signature et qu’une échéance puisse être marquée payée manuellement sans mouvement financier.

La prochaine étape logique est `10-parapheur.md`, car la validation, la signature et les versions contractuelles doivent converger avec le parapheur numérique.
