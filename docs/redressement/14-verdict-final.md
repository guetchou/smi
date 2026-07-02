# 14 — Verdict final d’industrialisation

## 1. Décision globale

**Verdict global : exploitable sous conditions pour certains workflows isolés, non industrialisé comme SMI intégré.**

Le produit n’est pas vide ni factice. Plusieurs modules contiennent des mécanismes solides, parfois transactionnels et testés sous MySQL. Mais l’ensemble ne satisfait pas encore la définition d’un système de management intégré industrialisé, car les garanties transversales ne sont pas établies :

- une seule source d’autorisation ;
- une seule vérité de trésorerie ;
- atomicité des paiements ;
- synchronisation parapheur/source ;
- audit durable ;
- outbox et reprise ;
- cohérence MySQL réelle ;
- déploiement sûr d’un SHA exact ;
- restauration prouvée ;
- tests bout en bout des flux critiques.

La présence de tables, routes, écrans, migrations ou tests isolés ne suffit pas à qualifier un module d’exploitable.

## 2. Décision Go / No-Go

### Usage interne contrôlé

**GO sous conditions strictes** pour :

- consultation RH ;
- suivi administratif ;
- certaines réceptions stock testées ;
- certains congés testés ;
- consultation et traitement encadré du parapheur ;
- suivi de contrats sans valeur de signature probante ;
- notifications internes non critiques.

Conditions :

1. supervision humaine ;
2. rapprochement manuel régulier ;
3. accès limités ;
4. aucun automatisme financier non vérifié ;
5. sauvegarde préalable ;
6. procédures de correction documentées.

### Source financière officielle

**NO-GO** pour utiliser Tala SMI comme source comptable et financière unique tant que :

- les soldes réels n’ont pas été diagnostiqués et validés ;
- toutes les positions ne sont pas migrées vers le ledger canonique ;
- les paiements fournisseur et paie ne postent pas atomiquement le ledger ;
- les écritures comptables manquantes ne bloquent pas les clôtures ;
- les corrections et reversals ne sont pas canoniques ;
- les clôtures et rapprochements ne sont pas prouvés.

### Signature contractuelle probante

**NO-GO** pour considérer l’approbation actuelle du parapheur ou le statut `signe` d’un contrat comme signature numérique juridiquement probante.

### Déploiement industriel automatisé

**NO-GO** tant que la chaîne actuelle de déploiement root et mutable n’est pas remplacée. La PR 63 constitue une correction proposée, pas une protection active.

## 3. Verdict par module

| Module | Verdict | Motif principal |
|---|---|---|
| Identité et accès | Exploitable sous conditions | profils et permissions existent, mais rôles historiques et délégations parallèles contournent l’autorité unique |
| RH agents | Exploitable sous conditions | données riches, cycle de vie compte/agent/offboarding non prouvé atomique |
| Congés | Exploitable sous conditions | moteur et tests solides, intégration complète présence/paie encore incomplète |
| Présence | Non vérifiable comme source de paie | pas de clôture mensuelle canonique prouvée |
| Paie | Non exploitable comme chaîne financière autonome | SQLite historique, paiements non atomiques, règles non versionnées |
| Finance / Trésorerie | Non exploitable comme source unique | plusieurs sources de solde, migration ledger incomplète, historique non garanti |
| Comptabilité OHADA | Exploitable sous conditions | moteur structuré, rupture possible entre opération, ledger et posting comptable |
| Budget | Non exploitable | moteur d’engagement/réalisation non prouvé |
| Achats | Exploitable sous conditions | composants réels, mais approbation pouvant créer directement un décaissement |
| Stock | Exploitable sous conditions | réception MySQL et rollback testés, retours et synchronisation BC à compléter |
| Fournisseurs | Non exploitable comme chaîne complète | paiement hors ledger/comptabilité/budget canoniques |
| Contrats | Exploitable pour suivi administratif | activation sans signature, échéances modifiables, versions probantes absentes |
| Parapheur | Exploitable sous conditions | bonne file de décision, synchronisation source et confidentialité insuffisantes |
| Notifications | Exploitable pour confort | persistance présente, mais livraison critique non garantie |
| Audit | Non exploitable comme preuve complète | erreurs ignorées, formats dispersés, immutabilité non prouvée |
| Dashboard / Reporting | Non vérifiable | indicateurs dépendants de sources non canoniques |
| Production / CI-CD | Non exploitable industriellement | root, SHA mutable, SSH non durci, rollback/restauration non prouvés |

## 4. Points réellement solides

Les éléments suivants constituent de bonnes bases :

- ledger canonique conçu avec verrouillage et idempotence ;
- contrôle débit/crédit au posting comptable ;
- contre-écritures comptables ;
- moteur de délégation avec cycles, chevauchements et plafonds ;
- service congé sans solde isolé ;
- réception stock MySQL avec rollback complet ;
- rapprochement fournisseur 3 voies ;
- moteur notifications avec déduplication et suivi d’envoi ;
- connecteur transactionnel de création parapheur ;
- PR 63 de durcissement CI/CD ;
- scripts de diagnostic et tests spécialisés.

Ces éléments ne doivent pas être jetés. Ils doivent devenir les chemins uniques et obligatoires.

## 5. Causes racines

### 5.1 Coexistence de générations techniques

Le dépôt combine :

```text
SQLite historique
MySQL asynchrone
routes monolithiques
services récents
statuts historiques
statuts canoniques
rôles historiques
permissions effectives
```

Le problème n’est donc pas seulement le code ancien, mais le fait que les anciens chemins restent utilisables.

### 5.2 Logique métier dans les routes

Plusieurs routes :

- exécutent directement des SQL ;
- modifient des statuts ;
- créent des opérations financières ;
- choisissent des catégories ;
- auditent de manière non bloquante.

Cela rend impossible la garantie qu’un même invariant est appliqué partout.

### 5.3 Statuts utilisés comme preuve

Plusieurs modules assimilent :

```text
statut = valide
```

à une preuve d’exécution. Or un statut ne prouve ni paiement, ni mouvement ledger, ni écriture comptable, ni signature, ni livraison.

### 5.4 Tolérance excessive aux erreurs

De nombreux `catch` silencieux transforment une panne critique en succès apparent.

### 5.5 Tests spécialisés mais chaîne globale non prouvée

Des suites locales sont bonnes, mais le produit manque encore de tests bout en bout MySQL couvrant les parcours complets et leurs rollbacks.

## 6. Seuil minimal avant qualification “exploitable”

Un module critique ne peut être déclaré exploitable que si :

1. sa route réellement montée est identifiée ;
2. son schéma MySQL réel est vérifié ;
3. son workflow canonique est unique ;
4. ses permissions backend sont explicites ;
5. ses écritures sont transactionnelles ;
6. son audit est durable ;
7. ses tests MySQL passent ;
8. les doubles soumissions et accès concurrents sont testés ;
9. son rollback est démontré ;
10. son état production est vérifié sur le SHA réellement exécuté.

## 7. Seuil avant qualification “industrialisé”

Le produit entier ne pourra être qualifié d’industrialisé que lorsque :

- tous les P0 seront fermés ;
- aucun paiement ne pourra exister sans allocation et ledger ;
- aucune approbation finale ne pourra diverger de sa source ;
- aucun droit sensible ne dépendra d’un rôle historique ;
- toute action critique produira audit et outbox dans la transaction ;
- MySQL sera le seul runtime ;
- staging, rollback et restauration seront testés ;
- la production exposera son SHA exact ;
- les rapports seront alimentés uniquement par des sources canoniques ;
- les flux critiques auront des tests E2E MySQL verts.

## 8. Décision immédiate recommandée

### À autoriser

- poursuite de l’audit ;
- durcissement CI/CD ;
- diagnostic financier en lecture seule ;
- migration permissions/délégations ;
- outbox et audit durable ;
- tests MySQL de concurrence ;
- documentation des workflows canoniques.

### À geler temporairement

- nouvelles fonctionnalités financières ;
- nouveaux dashboards financiers ;
- nouveaux automatismes de paiement ;
- nouveaux chemins de validation ;
- nouveaux calculs budgétaires ;
- refonte visuelle majeure de modules critiques.

Le gel ne concerne pas les corrections de sécurité, d’intégrité et de fiabilité.

## 9. Preuves encore manquantes

Le verdict reste volontairement prudent car les éléments suivants ne sont pas encore prouvés :

- état exact de la base de production ;
- migrations réellement appliquées ;
- SHA réellement déployé ;
- routes effectivement montées pour tous les modules ;
- données historiques et écarts de solde ;
- restauration d’une sauvegarde récente ;
- conformité juridique des barèmes de paie ;
- conformité métier du plan OHADA ;
- comportement complet du frontend selon permissions ;
- couverture E2E de tous les flux critiques.

Ces éléments sont classés **non vérifiables**, pas conformes par présomption.

## 10. Conclusion finale

Tala SMI possède une base fonctionnelle sérieuse et plusieurs briques techniquement prometteuses. Il ne s’agit pas d’un prototype vide. Mais l’intégration transversale reste insuffisante pour garantir l’argent, les droits, les décisions, les preuves et la production.

La bonne stratégie n’est pas une réécriture générale. Elle consiste à :

```text
identifier les chemins canoniques déjà présents
→ les rendre obligatoires
→ neutraliser les anciens chemins
→ tester les invariants sous MySQL
→ prouver le déploiement et la restauration
```

**Verdict final : produit exploitable sous contrôle sur certains périmètres, non industrialisé, et non autorisé comme source financière, comptable ou juridique unique avant fermeture des P0.**
