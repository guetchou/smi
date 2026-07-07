# Intégration Dolibarr invisible dans Tala SMI

## 1. Décision

Tala SMI reste l'interface métier unique.

Dolibarr peut être intégré comme moteur ERP/comptable invisible, mais il ne doit jamais devenir l'interface utilisateur principale.

Les utilisateurs métier travaillent uniquement dans Tala SMI.

## 2. Principe directeur

SMI décide.
Dolibarr enregistre.

Dolibarr ne doit pas piloter :
- les validations internes ;
- le parapheur ;
- les délégations ;
- les droits utilisateurs ;
- les workflows RH ;
- les workflows de caisse ;
- les arbitrages DG/Finance ;
- les règles SaaS propres à chaque entreprise.

## 3. Rôle de Tala SMI

Tala SMI reste responsable de :

- l'expérience utilisateur ;
- les workflows métier ;
- les rôles et permissions ;
- le parapheur ;
- les délégations ;
- les validations ;
- les notifications ;
- l'audit ;
- les règles Top Center ;
- les règles multi-tenant SaaS ;
- les rapports consolidés métier.

## 4. Rôle de Dolibarr

Dolibarr peut servir de moteur pour :

- les tiers ;
- les clients ;
- les fournisseurs ;
- les produits et services ;
- les factures ;
- les paiements ;
- les comptes banque/caisse ;
- les journaux comptables ;
- les exports comptables ;
- les stocks simples.

Dolibarr est un sous-système technique, pas le produit visible.

## 5. Architecture cible

Frontend SMI
↓
Backend SMI
↓
Services métier SMI
↓
Service de synchronisation Dolibarr
↓
API Dolibarr

Le frontend SMI ne doit jamais appeler Dolibarr directement.

## 6. Règles d'intégration

### 6.1 Source de vérité métier

La source de vérité métier reste SMI pour :

- les opérations de caisse ;
- les demandes d'achat ;
- les validations ;
- les décaissements ;
- les encaissements ;
- les statuts internes ;
- les utilisateurs ;
- les rôles ;
- les délégations.

### 6.2 Source de vérité ERP

Dolibarr peut devenir la source de vérité technique pour :

- l'identifiant ERP d'un tiers ;
- l'identifiant ERP d'une facture ;
- l'identifiant ERP d'un paiement ;
- l'identifiant ERP d'un produit ;
- l'identifiant ERP d'un mouvement comptable.

SMI doit conserver les références externes Dolibarr dans des champs dédiés.

## 7. Mapping initial

### 7.1 Tiers

SMI fournisseur/client
→ Dolibarr thirdparty

Champs minimum :
- nom ;
- type : client/fournisseur/mixte ;
- téléphone ;
- email ;
- adresse ;
- NIF/RCCM si disponible ;
- statut actif/inactif.

### 7.2 Encaissement

SMI encaissement validé
→ Dolibarr paiement ou écriture selon stratégie retenue

Condition :
- uniquement après validation SMI ;
- jamais à la simple saisie brouillon ;
- audit obligatoire.

### 7.3 Décaissement

SMI décaissement payé
→ Dolibarr paiement fournisseur / écriture de trésorerie

Condition :
- uniquement après paiement réel ;
- jamais à la soumission ;
- jamais à la validation seule ;
- séparation submitter/approver/payeur conservée dans SMI.

### 7.4 Facture fournisseur

SMI demande d'achat validée ou facture reçue
→ Dolibarr supplier invoice

Condition :
- fournisseur connu ou créé ;
- montant validé ;
- pièce justificative disponible si exigée.

### 7.5 Stock

SMI mouvement stock validé
→ Dolibarr stock movement

Condition :
- produit mappé ;
- entrepôt mappé ;
- mouvement audité.

## 8. Table de correspondance proposée

Créer une table de mapping générique :

- id
- tenant_id
- local_module
- local_table
- local_id
- external_system
- external_entity
- external_id
- sync_status
- last_sync_at
- last_error
- created_at
- updated_at

Exemple :

operations / 1366
→ dolibarr / payment / 987

## 9. Statuts de synchronisation

Statuts minimum :

- pending
- synced
- failed
- ignored
- conflict

Une erreur Dolibarr ne doit pas annuler automatiquement l'opération SMI.

Elle doit créer une anomalie de synchronisation visible dans SMI.

## 10. Anti-corruption layer

Toute communication avec Dolibarr doit passer par un service dédié :

- backend/services/dolibarr_client.js
- backend/services/dolibarr_sync_service.js

Interdit :
- appels API Dolibarr dispersés dans les routes ;
- accès direct à la base Dolibarr ;
- logique Dolibarr dans le frontend ;
- statuts Dolibarr mélangés aux statuts métier SMI.

## 11. Sécurité

Les clés API Dolibarr doivent être stockées côté serveur uniquement.

Variables attendues :

- DOLIBARR_ENABLED=false
- DOLIBARR_BASE_URL=
- DOLIBARR_API_KEY=
- DOLIBARR_TIMEOUT_MS=10000

Aucune clé Dolibarr ne doit apparaître dans le frontend, les logs ou les exports.

## 12. Mode de déploiement

L'intégration doit être désactivée par défaut.

Activation par variable :

DOLIBARR_ENABLED=true

Si Dolibarr est indisponible :
- SMI continue de fonctionner ;
- l'opération reste valide côté SMI ;
- une anomalie de synchronisation est ouverte ;
- une reprise manuelle ou automatique est possible.

## 13. Première tranche technique recommandée

Tranche 1 : socle de synchronisation invisible.

Contenu :
- configuration Dolibarr ;
- client API Dolibarr ;
- table de mapping externe ;
- healthcheck Dolibarr ;
- test de connexion ;
- aucun impact métier automatique.

Tranche 2 : synchronisation tiers.

Contenu :
- création fournisseur/client Dolibarr depuis SMI ;
- stockage external_id ;
- reprise en cas d'échec.

Tranche 3 : synchronisation encaissements/décaissements.

Contenu :
- encaissement validé vers Dolibarr ;
- décaissement payé vers Dolibarr ;
- audit ;
- anomalies de synchronisation.

Tranche 4 : factures fournisseurs.

Contenu :
- facture fournisseur SMI vers Dolibarr ;
- rattachement paiement ;
- pièce justificative.

Tranche 5 : stock.

Contenu :
- produits ;
- entrepôts ;
- mouvements stock.

## 14. Ce qui est explicitement hors périmètre au départ

- remplacer l'interface SMI par Dolibarr ;
- exposer Dolibarr aux utilisateurs ;
- synchroniser tous les modules d'un coup ;
- faire de Dolibarr la source des permissions ;
- faire de Dolibarr la source du parapheur ;
- faire de Dolibarr la source RH ;
- écrire directement dans la base Dolibarr.

## 15. Critères d'acceptation

L'intégration est acceptable si :

- un utilisateur ne voit jamais Dolibarr ;
- SMI fonctionne même si Dolibarr est coupé ;
- chaque synchronisation est auditée ;
- chaque échec est traçable ;
- aucun workflow SMI n'est remplacé par un statut Dolibarr ;
- les clés API restent côté serveur ;
- les tests prouvent que Dolibarr désactivé ne casse rien.
