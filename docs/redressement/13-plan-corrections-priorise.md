# 13 — Plan de corrections priorisé

## 1. Verdict de pilotage

Le produit ne doit pas être traité comme un ensemble de modules indépendants. Les risques sont transversaux : identité, permissions, audit, données financières, parapheur, paie et production se contaminent mutuellement.

L’ordre de redressement doit donc suivre les dépendances suivantes :

```text
Production sûre
→ identité et permissions
→ audit et outbox
→ modèle financier canonique
→ parapheur et synchronisation source
→ achats / fournisseurs
→ RH / paie
→ contrats
→ budget
→ reporting et UX
```

Aucune correction fonctionnelle majeure ne doit être fusionnée avant :

- reproduction du défaut ;
- test qui échoue ;
- correctif minimal ;
- test MySQL ;
- analyse des effets de bord ;
- mise à jour documentaire ;
- revue humaine ;
- procédure de rollback.

## 2. Priorité P0 — Sécurité, argent, intégrité et production

### P0.1 — Sécuriser le déploiement de production

**Anomalies liées :** PROD-001 à PROD-008, PROD-010 à PROD-016, PROD-019, PROD-024.

Actions :

1. Finaliser la PR 63 sans fusion automatique.
2. Passer à un déclenchement manuel avec approbation d’environnement.
3. Déployer un SHA complet exact.
4. Supprimer SSH root.
5. Supprimer `StrictHostKeyChecking=no`.
6. Déplacer IP, utilisateur et empreinte SSH dans les secrets.
7. Interdire toute modification automatique de `.env`.
8. Retirer SQLite du chemin normal de déploiement.
9. Ajouter tests MySQL critiques au quality gate.
10. Exposer le SHA réellement servi.
11. Définir rollback code + base.
12. Tester une restauration réelle.

Critère de sortie :

```text
SHA approuvé = SHA déployé = SHA exposé par l’application
```

### P0.2 — Bloquer les contournements d’autorisation

**Anomalies liées :** IAM-001 à IAM-011, PAR-005, PAR-006, PAR-018, PAY-007, PUR-015, ACC-003.

Actions :

1. Faire passer création et révocation des délégations par `delegation_engine`.
2. Interdire les insertions directes dans les tables de délégation.
3. Cartographier chaque route sensible vers une permission unique.
4. Désactiver progressivement les fallbacks `hasRole()`.
5. Limiter le superuser admin aux opérations techniques.
6. Formaliser un compte break-glass séparé.
7. Corriger la visibilité des documents parapheur et alertes.
8. Vérifier comptes actifs sans agent et agents sortis avec compte actif.

Critère de sortie : aucun droit métier sensible ne dépend uniquement d’un rôle historique.

### P0.3 — Rendre l’audit et les événements durables

**Anomalies liées :** AUD-001 à AUD-010, AUD-016, AUD-020, AUD-022, AUD-024, AUD-026.

Actions :

1. Introduire une outbox persistante.
2. Créer l’événement métier et l’audit dans la transaction source.
3. Ajouter `correlation_id` et `causation_id`.
4. Interdire les `catch` silencieux pour opérations critiques.
5. Ajouter worker de retry, backoff et dead-letter.
6. Rendre l’audit append-only.
7. Corriger la visibilité des alertes.
8. Lier la résolution d’une alerte à la correction de sa cause.

Critère de sortie : un redémarrage ne perd ni audit ni notification critique.

### P0.4 — Établir une seule vérité de trésorerie

**Anomalies liées :** FIN-001 à FIN-003, FIN-008 à FIN-010, FIN-012.

Actions :

1. Exécuter un diagnostic MySQL en lecture seule sur copie restaurée.
2. Comparer `operations`, `cash_ledger`, `cashbox_balances`, écritures et clôtures.
3. Produire les écarts par position et par journée.
4. Valider les soldes d’ouverture avec Finance/DG.
5. Définir la date opérationnelle canonique du ledger.
6. Implémenter le reversal canonique.
7. Interdire les corrections rétroactives après clôture.
8. Rendre le ledger obligatoire pour les positions `ready`.
9. Interdire les recalculs historiques depuis `operations` pour ces positions.
10. Produire un journal financier journalier canonique.

Critère de sortie : le solde reconstruit depuis le ledger égale le cache et le solde validé métier.

### P0.5 — Rendre les paiements atomiques

**Anomalies liées :** PAY-002 à PAY-006, PUR-003 à PUR-010, ACC-001, FIN-010.

Actions :

1. Supprimer les insertions directes dans `operations` depuis Paie et Achats.
2. Utiliser un service canonique de paiement.
3. Verrouiller facture, bulletin, position, allocation et ledger dans la même transaction.
4. Rendre position et référence externe obligatoires.
5. Créer une allocation par paiement.
6. Générer l’anomalie comptable bloquante si l’écriture échoue.
7. Refuser tout paiement au-delà du reste.
8. Tester les doubles clics et requêtes concurrentes.

Critère de sortie : aucune facture ou paie ne peut être marquée payée sans mouvement ledger correspondant.

### P0.6 — Corriger le parapheur transversal

**Anomalies liées :** PAR-001 à PAR-004, PAR-012 à PAR-019, PAR-022.

Actions :

1. Créer un service transactionnel unique de décision.
2. Appeler les services métier sources, jamais modifier leurs colonnes directement.
3. Bloquer les types sans adaptateur source supporté.
4. Séparer décision enregistrée et synchronisation exécutée.
5. Retirer le rejet final à l’assistante, sauf permission explicite.
6. Ne plus assimiler `manager` au DG.
7. Intégrer le moteur canonique de délégation.
8. Ajouter une clé d’idempotence par source et workflow.

Critère de sortie : une approbation finale ne peut pas exister avec une source non synchronisée sans statut d’erreur explicite et bloquant.

## 3. Priorité P1 — Cohérence métier et workflows

### P1.1 — Comptabilité OHADA

Actions :

1. Créer toutes les règles inactives par défaut.
2. Séparer permissions de mapping, génération, posting et reversal.
3. Introduire les codes de nature comptable stables.
4. Structurer les types de tiers.
5. Lier chaque position à son compte comptable.
6. Prouver l’unicité source au niveau MySQL.
7. Interdire toute modification d’écriture postée.
8. Renseigner tiers et budget sur les lignes obligatoires.
9. Faire valider le plan et les mappings par un comptable habilité.

Critère de sortie : chaque opération effective est comptabilisée ou bloque la clôture.

### P1.2 — Achats, stock et fournisseurs

Actions :

1. Supprimer le chemin `demande approuvée → décaissement`.
2. Faire créer un engagement ou une autorisation d’achat.
3. Unifier les paiements fournisseur.
4. Synchroniser les factures vers `finance_source_documents`.
5. Utiliser `payment_allocations`.
6. Rendre réception, stock, lignes BC et statut BC atomiques.
7. Implémenter retours et mouvements inverses.
8. Structurer quantité et unité.
9. Appliquer la séparation créateur, contrôleur, approbateur, payeur.

Critère de sortie : aucun paiement fournisseur sans facture validée, rapprochement applicable, allocation et ledger.

### P1.3 — RH et Paie

Actions :

1. Migrer les routes Paie vers MySQL.
2. Créer une clôture mensuelle de présence.
3. Figurer contrat, rémunération, présence, congés et heures supplémentaires dans des snapshots.
4. Versionner taux et règles de paie.
5. Rendre périodes payées et clôturées immuables.
6. Utiliser rectifications formelles.
7. Créer un ledger des avances.
8. Créer les allocations de paiement par bulletin.
9. Produire les écritures complètes de paie.
10. Rendre la sortie agent atomique avec désactivation compte et paie finale.

Critère de sortie : un bulletin payé est reconstructible depuis ses entrées figées et ses allocations réelles.

### P1.4 — Contrats

Actions :

1. Interdire activation sans approbation et signature requise.
2. Créer versions documentaires et empreintes.
3. Introduire signataires, dates et preuves.
4. Gérer les avenants.
5. Versionner ou régénérer les échéances après modification.
6. Rendre facturation récurrente idempotente.
7. Supprimer les changements manuels d’échéance vers `payee`.
8. Lier contrats salariés à la paie.
9. Lier contrats fournisseurs aux achats.
10. Lier contrats clients à facturation, créance et comptabilité.

Critère de sortie : une version active est immuable et toute échéance exécutée est dérivée d’un document financier réel.

### P1.5 — Budget

Actions :

1. Créer le modèle canonique budget/version/ligne/événement/allocation/override.
2. Distinguer engagement et réalisation.
3. Verrouiller les enveloppes en concurrence.
4. Lier demande, commande, facture et paiement à une ligne budgétaire.
5. Implémenter transferts à deux jambes.
6. Gérer dépassements et overrides.
7. Clôturer et versionner les périodes budgétaires.
8. Alimenter le reporting depuis le ledger budgétaire.

Critère de sortie : le disponible budgétaire est reconstructible et aucun dépassement n’est silencieux.

## 4. Priorité P2 — Industrialisation, UX et reporting

Actions :

1. Créer staging représentatif.
2. Produire images ou artefacts immuables signés.
3. Ajouter SBOM et scan de dépendances.
4. Centraliser logs, métriques et traces.
5. Créer dashboard de dead-letter et anomalies.
6. Unifier les statuts présentés dans l’UI.
7. Ajouter la matrice route → permission → écran → test E2E.
8. Créer les vues journalières Finance, Paie, Achats et Parapheur.
9. Formaliser rétention, archivage et export.
10. Réduire les gros fichiers et extraire les services métier.

## 5. Dépendances bloquantes

| Correction | Dépend de |
|---|---|
| Ledger obligatoire | diagnostic réel + soldes validés |
| Comptabilité bloquante | ledger canonique + statuts d’effectivité |
| Budget au paiement | moteur budget + allocations source |
| Paiement fournisseur canonique | ledger + allocations + permissions |
| Paie canonique | présence clôturée + ledger + comptabilité |
| Contrat probant | version documentaire + parapheur + signature |
| Parapheur fiable | permissions + délégations + outbox |
| Reporting fiable | sources canoniques stabilisées |

## 6. Découpage recommandé en lots indépendants

### Lot A — CI/CD et production

PR dédiée. Aucun changement métier.

### Lot B — Permissions et délégations

PR dédiée. Aucun changement de solde ou paiement.

### Lot C — Audit et outbox

PR dédiée. Ajout transversal, sans modifier les règles métier.

### Lot D — Diagnostic finance lecture seule

PR dédiée. Aucun backfill automatique.

### Lot E — Ledger et reversal

PR dédiée après validation du diagnostic.

### Lot F — Paiement fournisseur canonique

PR dédiée après Lot E.

### Lot G — Paiement de paie canonique

PR dédiée après Lot E et snapshots Paie.

### Lot H — Parapheur transactionnel

PR dédiée après permissions et outbox.

### Lot I — Budget

PR dédiée après stabilisation Achats et Finance.

## 7. Definition of Done par correction

Une correction n’est terminée que si :

1. l’anomalie est reproductible ;
2. un test échoue avant correction ;
3. le correctif est minimal ;
4. le test réussit sous MySQL ;
5. les cas concurrents sont testés si nécessaire ;
6. les permissions backend sont testées ;
7. l’audit est vérifié ;
8. les effets de bord sont documentés ;
9. le rollback est défini ;
10. les PRD et documents de redressement sont mis à jour ;
11. la PR est revue ;
12. aucune fusion automatique n’est effectuée.

## 8. Ordre d’exécution recommandé

```text
1. CI/CD et production
2. Permissions et délégations
3. Audit et outbox
4. Diagnostic finance lecture seule
5. Ledger, cache, reversal et clôtures
6. Paiements fournisseur
7. Parapheur transactionnel
8. Comptabilité OHADA
9. Présence et paie
10. Contrats
11. Budget
12. Reporting, UX et dette technique
```

## 9. Verdict final de planification

Le premier développement ne doit pas être une nouvelle fonctionnalité. Il doit être l’un des trois travaux suivants :

```text
A. sécuriser le déploiement
B. fermer les contournements de permissions
C. produire le diagnostic financier MySQL en lecture seule
```

Tout autre chantier avant ces trois points augmente la dette et le risque de corruption métier.
