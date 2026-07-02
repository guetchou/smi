# 04 — Audit RH et Paie

## Verdict provisoire

**RH / Paie : partiellement exploitable, chaîne complète non industrialisée.**

Le dépôt contient : agents, congés, présence, avances, heures supplémentaires, périodes de paie, bulletins, calcul CNSS/CAMU/IRPP, validation DG, paiement, rectifications et contrôles d’anomalies. Mais les routes principales restent fortement couplées à `backend/database.js`, à SQLite et à des insertions directes dans `operations`.

La chaîne cible n’est pas encore prouvée comme unique :

```text
Agent actif
→ contrat et rémunération
→ présence / congés / heures supplémentaires
→ bulletin
→ contrôles RH et Finance
→ approbation DG
→ paiement
→ trésorerie
→ comptabilité
→ déclarations sociales et fiscales
→ clôture
```

## État observé

### Calcul de paie

`backend/routes/salaires.js` calcule salaire de base, primes, ancienneté, CNSS, CAMU, IRPP, retenues, net à payer et coût employeur. Les montants utilisent `Number`, `parseFloat` et des arrondis.

### Congés sans solde

`backend/services/unpaid_leave_payroll.js` gère jours ouvrés, week-ends, jours fériés, fuseau, intersection avec la période, déduplication, plusieurs diviseurs et plafonnement de la retenue. Cette brique est correctement isolée.

### Périodes de paie

`backend/routes/periodes_paie.js` définit :

```text
ouverte → preparation → controle_rh → controle_finance
→ soumis_dg → validee_dg → paiement_en_cours
→ payee_partielle → payee → cloturee → rouverte_exception
```

Le module détecte notamment : net négatif, agent sorti avec bulletin actif, salaire hors grille, créateur = validateur et modification salariale dans le mois.

### Paiement et trésorerie

Le helper `_creerDecaissementCaisse()` :

- choisit automatiquement la première position active ;
- choisit une catégorie par recherche textuelle ;
- insère directement une opération validée ;
- déclenche `recalculateSoldes()` ;
- considère la synchronisation financière comme non bloquante ;
- laisse le paiement valide même si la création du décaissement échoue.

Ce comportement est incompatible avec le ledger canonique.

## Anomalies prioritaires

### PAY-001 — Routes paie SQLite

- Gravité : critique.
- Preuve : `salaires.js` et `periodes_paie.js` importent `../database` et utilisent `db.prepare`, `datetime('now')`, `strftime`.
- Conséquence : divergence avec MySQL de production.
- Correction : migrer vers `backend/db.js` et services transactionnels MySQL.

### PAY-002 — Paiement valide sans mouvement financier

- Gravité : critique.
- Preuve : la synchronisation du décaissement est explicitement non bloquante.
- Conséquence : CNSS, DGI ou salaire marqués payés sans sortie réelle de trésorerie.
- Correction : paiement et ledger dans une transaction unique, ou statut bloquant de synchronisation.

### PAY-003 — Insertions directes dans `operations`

- Gravité : critique.
- Conséquence : contournement des statuts canoniques, références externes, permissions, ledger, comptabilité et budget.
- Correction : service canonique de décaissement obligatoire.

### PAY-004 — Mauvaise position ou catégorie possible

- Gravité : haute.
- Preuve : première position active et catégorie trouvée par mots-clés.
- Correction : position et catégorie explicites, configurées par code stable.

### PAY-005 — Ancien recalcul des soldes encore actif

- Gravité : critique.
- Preuve : dépendance à `recalculateSoldes()`.
- Conséquence : coexistence avec `cash_ledger` et `cashbox_balances`.
- Correction : supprimer après migration ledger.

### PAY-006 — Audit non bloquant

- Gravité : critique.
- Preuve : erreurs d’audit ignorées.
- Correction : audit transactionnel ou outbox durable.

### PAY-007 — Permissions hybrides

- Gravité : haute.
- Preuve : combinaison `can()` + `hasRole()`.
- Correction : permissions effectives uniquement après migration.

### PAY-008 — Auto-approbation DG

- Gravité : haute.
- Preuve : un utilisateur autorisé à soumettre et approuver passe directement à `validee_dg`.
- Conséquence : absence de séparation des fonctions.
- Correction : actions séparées et acteurs distincts.

### PAY-009 — Ouverture forcée d’une nouvelle période

- Gravité : haute.
- Preuve : admin ou DG peuvent forcer malgré période précédente non clôturée.
- Correction : workflow d’exception motivé et audité.

### PAY-010 — Paramètres de paie non versionnés

- Gravité : critique.
- Preuve : taux lus depuis `parametres` au moment du calcul.
- Conséquence : recalcul historique différent après changement de taux.
- Correction : snapshot des taux, règles et version sur chaque bulletin.

### PAY-011 — Calcul réglementaire non certifié

- Gravité : critique.
- Conséquence : calcul équilibré mais juridiquement incorrect.
- Correction : validation par spécialiste paie/fiscalité congolaise et date d’effet des barèmes.

### PAY-012 — Présence non clôturée comme source unique

- Gravité : critique.
- Preuve : congé sans solde intégré, mais pointages, absences, retards, shifts et heures supplémentaires ne sont pas encore prouvés comme snapshot mensuel unique.
- Correction : clôture mensuelle de présence avant paie.

### PAY-013 — Corrections après paie

- Gravité : critique.
- Conséquence : modification rétroactive sans rectification formelle.
- Correction : période payée immuable ; correction via rectification.

### PAY-014 — Avances et retenues non entièrement prouvées

- Gravité : critique.
- Risques : avance non payée mais retenue, double retenue, solde erroné.
- Correction : ledger d’avances et allocations par bulletin.

### PAY-015 — Statuts période et bulletins potentiellement divergents

- Gravité : haute.
- Preuve : `payee_partielle` au niveau période et statuts propres aux bulletins.
- Correction : statut période dérivé des allocations de paiement.

### PAY-016 — Comptabilité complète de paie non prouvée

- Gravité : critique.
- Conséquence : salaires et charges payés sans journal de paie complet.
- Correction : écritures de charges, dettes sociales/fiscales, net salarié et lettrage des paiements.

### PAY-017 — Sortie agent non atomique

- Gravité : critique.
- Risque : ancien agent encore connecté, pointé ou payé.
- Correction : offboarding unique : sortie RH, désactivation compte, arrêt pointage, paie finale et solde de tout compte.

## Points positifs

- Le moteur congé sans solde est correctement isolé.
- Le cycle mensuel de paie est explicite.
- Plusieurs anomalies métier sont détectées avant soumission DG.
- La branche de durcissement possède 145 tests congés verts.

## Modèle canonique requis

Chaque bulletin doit conserver des snapshots :

```text
agent
contrat
rémunération
version des règles
clôture de présence
congés
heures supplémentaires
allocations d’avances
entrées et résultats du calcul
```

Les états doivent être séparés :

```text
payroll_period_status
payslip_status
approval_status
payment_status
accounting_status
reconciliation_status
```

## Invariants obligatoires

1. Agent sorti : aucun bulletin normal après date de sortie.
2. Période payée ou clôturée : immuable.
3. Correction post-clôture : rectification obligatoire.
4. Bulletin : version exacte des règles conservée.
5. Présence utilisée : clôturée et figée.
6. Avance : retenue une seule fois.
7. Bulletin payé : allocation de paiement réelle.
8. Paiement et ledger : même transaction.
9. Paie validée : écritures équilibrées.
10. Séparation génération, validation, approbation et paiement.
11. Audit jamais silencieux.

## Ordre de redressement

### P0

1. Identifier les routes Paie réellement montées.
2. Migrer SQLite vers MySQL.
3. Supprimer les insertions directes dans `operations`.
4. Rendre paiement et ledger atomiques.
5. Rendre l’audit fiable.
6. Figer les périodes payées et clôturées.
7. Contrôler comptes actifs et agents sortis.

### P1

1. Clôture mensuelle de présence.
2. Snapshots de calcul.
3. Ledger des avances.
4. Allocations de paiement.
5. Comptabilité complète de paie.
6. Rectifications post-paiement.

## Conclusion

Le domaine RH/Paie est riche fonctionnellement mais repose encore sur un noyau historique SQLite et fortement couplé. Le risque prioritaire est financier : un paiement peut être déclaré valide alors que le décaissement échoue. Cette règle doit être supprimée avant de qualifier le module d’exploitable.
