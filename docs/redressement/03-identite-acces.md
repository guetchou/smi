# 03 — Audit Identité et Accès

## 1. Verdict provisoire

**Identité et accès : partiellement conforme, non industrialisé comme source d’autorisation unique.**

Le dépôt possède une architecture d’accès avancée :

- permissions unitaires ;
- profils de permissions ;
- permissions directes par utilisateur ;
- refus explicites ;
- dates d’expiration ;
- plafonds de montant ;
- délégations ;
- redélégation contrôlée ;
- audit des changements d’accès ;
- endpoint d’explication des droits effectifs.

Mais plusieurs modèles coexistent encore :

```text
users.role
users.roles
profils
permissions directes
permissions déléguées
fallback rôles historiques
délégations historiques
délégations ERP canoniques
```

La fonction `can()` n’est donc pas encore une source d’autorisation exclusivement fondée sur les permissions effectives. Elle conserve un super-pouvoir administrateur et un fallback explicite vers les rôles historiques.

## 2. Modèle observé

### 2.1 Permission effective

Le service `backend/services/permissions.js` résout un droit dans l’ordre suivant :

1. administrateur superuser ;
2. permission directe utilisateur ;
3. délégation active ;
4. profil actif ;
5. fallback vers les rôles historiques.

Une permission directe négative est prise en compte dans `activePermissionsForUser()` et masque les permissions issues des profils ou délégations.

### 2.2 Profils

`user_profiles` permet :

- activation ou désactivation ;
- source manuelle ou issue d’un rôle historique ;
- date d’expiration ;
- audit de l’affectation.

`syncUserProfilesFromRoles()` transforme automatiquement certains rôles historiques en profils marqués `legacy_role`.

Cette fonction protège les profils manuels lors d’une synchronisation ultérieure.

### 2.3 Permissions directes

`user_permissions` permet :

- autoriser ou refuser ;
- activer ou désactiver ;
- motif ;
- plafond ;
- expiration ;
- audit.

### 2.4 Délégations

Le moteur `delegation_engine.js` vérifie notamment :

- délégant et délégataire actifs ;
- interdiction de l’auto-délégation ;
- exactement un périmètre ;
- période valide ;
- plafond valide ;
- absence de chevauchement ;
- absence de cycle ;
- possession du droit par le délégant ;
- permission active et délégable ;
- redélégation explicitement autorisée ;
- plafond et expiration hérités de l’autorité source.

Cette gouvernance est solide en conception.

### 2.5 Administration des accès

`backend/routes/access.js` expose :

- vue d’ensemble profils / permissions / utilisateurs ;
- droits effectifs d’un utilisateur ;
- affectation de profils ;
- affectation de permissions directes ;
- création / désactivation de délégations ;
- consultation de l’audit.

L’accès à ces routes utilise lui-même `can()`.

## 3. Anomalies

## IAM-001 — Fallback rôles historiques toujours actif

- **Gravité : critique**
- **Exigence :** permissions effectives comme seule source d’autorisation métier.
- **Preuve :** `LEGACY_PERMISSION_ROLES` autorise encore de nombreuses actions selon `hasRole()`.
- **Scénario :** utilisateur possédant un rôle historique mais aucun profil ni permission explicite.
- **Conséquence métier :** droits implicites difficiles à administrer, auditer et révoquer.
- **Correction minimale :** migrer les rôles vers des profils, comparer les droits, puis désactiver le fallback module par module.
- **Tests :** rôle seul refusé après migration ; profil équivalent autorisé.
- **Risque de régression :** critique.
- **Statut : ouvert.**

## IAM-002 — Superuser administrateur implicite

- **Gravité : critique**
- **Preuve :** `can()` retourne immédiatement vrai pour le rôle `admin`, sauf `context.adminSuperuser=false`.
- **Conséquence métier :** l’administrateur peut cumuler toutes les fonctions sensibles, même si une permission directe lui est refusée.
- **Correction minimale :** limiter le superuser aux opérations techniques documentées ; exiger des permissions effectives pour les actes métier sensibles.
- **Tests :** refus explicite d’une permission sensible à un admin ; compte d’urgence séparé.
- **Statut : ouvert.**

## IAM-003 — Refus direct non appliqué avant le superuser

- **Gravité : haute**
- **Preuve :** le court-circuit administrateur intervient avant la lecture de `user_permissions`.
- **Conséquence métier :** impossible de retirer ponctuellement un droit à un administrateur sans désactiver le superuser.
- **Correction minimale :** définir une politique canonique : refus explicite prioritaire, sauf compte break-glass distinct.
- **Statut : ouvert.**

## IAM-004 — Deux représentations des rôles dans `users`

- **Gravité : haute**
- **Preuve :** le code lit `users.role` et `users.roles`, le second sous forme JSON.
- **Conséquence métier :** incohérence possible entre rôle principal, liste de rôles, profils synchronisés et affichage frontend.
- **Correction minimale :** déprécier progressivement `roles`, garder un éventuel rôle organisationnel non autorisant et administrer les droits par profils.
- **Tests :** divergences role/roles, JSON invalide, synchronisation répétée.
- **Statut : ouvert.**

## IAM-005 — Synchronisation rôles → profils non universellement prouvée

- **Gravité : haute**
- **Preuve :** `syncUserProfilesFromRoles()` existe, mais tous les chemins de création ou modification d’utilisateur ne sont pas encore prouvés comme l’appelant.
- **Conséquence métier :** deux utilisateurs ayant le même rôle peuvent recevoir des profils différents selon leur origine : UI, import, script ou migration.
- **Correction minimale :** service unique de création / modification d’identité ; contrainte de passage obligatoire.
- **Tests :** création UI, import, migration, modification, restauration.
- **Statut : impossible à vérifier.**

## IAM-006 — Service central `IdentityAccessService` absent

- **Gravité : haute**
- **Exigence PRD :** un service central pour identité, liaison agent, profils, permissions et désactivation.
- **Preuve :** plusieurs services existent, mais aucun point d’entrée unique couvrant le cycle de vie complet n’est prouvé.
- **Conséquence métier :** routes et scripts peuvent modifier directement `users`, profils ou permissions sans appliquer toutes les règles.
- **Correction minimale :** façade transactionnelle unique pour création, activation, liaison, changement d’accès et départ.
- **Statut : absent ou non prouvé.**

## IAM-007 — Audit des permissions non bloquant

- **Gravité : critique**
- **Preuve :** `auditPermission()` capture et ignore toutes les erreurs.
- **Conséquence métier :** un changement de droit peut réussir sans trace d’audit.
- **Correction minimale :** audit dans la même transaction ou outbox durable ; jamais d’erreur avalée pour une action sensible.
- **Tests :** panne audit provoque rollback ou événement de reprise garanti.
- **Statut : ouvert.**

## IAM-008 — Routes d’accès modifient directement les tables

- **Gravité : haute**
- **Preuve :** les routes profils, permissions et délégations exécutent directement des `INSERT/UPDATE`.
- **Conséquence métier :** validation, audit et règles de gouvernance peuvent diverger entre routes.
- **Correction minimale :** services métier transactionnels dédiés.
- **Statut : ouvert.**

## IAM-009 — Création de délégation dans la route contourne le moteur canonique

- **Gravité : critique**
- **Preuve :** `access.js` importe `createDelegation`, mais la route `POST /delegations` observée insère directement dans `delegations` au lieu d’appeler le moteur.
- **Conséquence métier :** auto-délégation, cycle, chevauchement, permission non possédée, droit sensible ou redélégation non autorisée peuvent contourner les contrôles.
- **Correction minimale :** supprimer l’insertion directe et appeler exclusivement `createDelegation()`.
- **Tests :** tous les cas de refus du moteur via l’API réelle.
- **Risque de régression :** élevé.
- **Statut : ouvert.**

## IAM-010 — Désactivation de délégation contourne le moteur de révocation

- **Gravité : haute**
- **Preuve :** la route met directement `active=0`, alors que `revokeDelegation()` est importé.
- **Conséquence métier :** absence potentielle de motif, auteur, date de révocation et règles de droit à révoquer.
- **Correction minimale :** utiliser `revokeDelegation()` et conserver `revoked_at`, `revoked_by`, `revoke_reason`.
- **Statut : ouvert.**

## IAM-011 — Modèles de délégation historiques coexistants

- **Gravité : critique**
- **Preuve :** l’application détecte dynamiquement les colonnes et bascule entre un modèle ERP et un ancien modèle `delegant_id / delegataire_id / statut / date_fin`. Les achats utilisent aussi `delegations_approbation`.
- **Conséquence métier :** le même utilisateur peut disposer de délégations provenant de plusieurs moteurs et règles différentes.
- **Correction minimale :** inventaire, migration, gel des anciennes tables puis suppression des lectures historiques.
- **Tests :** utilisateur avec délégations concurrentes anciennes et nouvelles.
- **Statut : ouvert.**

## IAM-012 — Permissions par module trop larges dans les délégations

- **Gravité : haute**
- **Preuve :** `activePermissionsForUser()` accepte une délégation si `d.scope_module = p.module`.
- **Conséquence métier :** déléguer un module peut transmettre des permissions sensibles futures ajoutées ensuite au même module.
- **Correction minimale :** privilégier les permissions explicites ; profils versionnés pour les lots ; module seulement pour lecture non sensible si maintenu.
- **Statut : ouvert.**

## IAM-013 — Limite de montant non appliquée aux profils

- **Gravité : haute**
- **Preuve :** `amountAllowed()` s’applique aux permissions directes ; une permission obtenue par profil retourne vrai sans plafond propre observé.
- **Conséquence métier :** impossible de modéliser proprement des seuils par profil ou fonction.
- **Correction minimale :** plafond au niveau profil-permission, affectation utilisateur ou règle d’approbation dédiée.
- **Statut : ouvert.**

## IAM-014 — Autorité de délégation et `can()` pas parfaitement alignées

- **Gravité : haute**
- **Preuve :** le moteur strict exige une permission explicite et vérifie `delegable`; mais la route directe accepte profil ou module et ne passe pas par cette gouvernance.
- **Conséquence métier :** une délégation visible dans l’interface peut être résolue différemment par le moteur d’autorisation.
- **Correction minimale :** contrat unique de délégation, mêmes validations à la création et à la résolution.
- **Statut : ouvert.**

## IAM-015 — Gestion du fuseau dans les délégations

- **Gravité : moyenne**
- **Preuve :** normalisation JavaScript en ISO puis comparaisons MySQL `NOW()`.
- **Conséquence métier :** décalage possible si processus et base n’utilisent pas le même fuseau.
- **Correction minimale :** politique UTC ou `Africa/Brazzaville` explicite de bout en bout.
- **Tests :** début / expiration près de minuit.
- **Statut : ouvert.**

## IAM-016 — Compte actif non suffisant pour prouver une identité agent

- **Gravité : haute**
- **Exigence :** un agent actif lié à un compte unique et désactivation cohérente au départ.
- **Preuve :** le moteur de délégation vérifie `users.actif`, mais la liaison systématique `users ↔ employes` n’est pas démontrée dans cette passe.
- **Conséquence métier :** compte actif sans agent, agent sorti avec compte actif, doublons ou comptes partagés.
- **Correction minimale :** relation unique gouvernée, workflow de création et offboarding atomique.
- **Statut : impossible à vérifier.**

## IAM-017 — Permissions frontend non équivalentes à la sécurité backend

- **Gravité : haute**
- **Preuve :** l’endpoint `effective` permet d’alimenter l’interface, mais tous les menus et boutons ne sont pas encore cartographiés contre les gardes backend.
- **Conséquence métier :** bouton visible mais refusé, ou écran masqué alors que l’API reste accessible.
- **Correction minimale :** matrice route → permission → composant UI → test E2E.
- **Statut : impossible à vérifier.**

## IAM-018 — Comptes d’urgence non formalisés dans le moteur

- **Gravité : haute**
- **Preuve :** le superuser admin joue de fait le rôle de compte d’urgence, sans contrat break-glass observé.
- **Conséquence métier :** usage quotidien d’un pouvoir absolu, absence de justification et de surveillance renforcée.
- **Correction minimale :** compte d’urgence séparé, désactivé par défaut, activation limitée, alerte et audit immuable.
- **Statut : absent.**

## 4. Points positifs

### POS-IAM-001 — Refus explicite

`activePermissionsForUser()` exclut une permission si une permission directe négative active existe.

### POS-IAM-002 — Expiration

Profils, permissions et délégations prennent en compte une date d’expiration.

### POS-IAM-003 — Gouvernance de délégation solide dans le service

Le moteur canonique traite cycles, chevauchements, redélégation, plafonds et permissions non délégables.

### POS-IAM-004 — Explication des droits effectifs

L’API peut retourner profils, permissions directes, délégations et droits effectifs d’un utilisateur.

## 5. Modèle canonique proposé

```text
Identity
  user account
  linked employee/person
  active status
  authentication factors

Authorization
  permission
  profile
  user_profile
  user_permission override
  delegation

Governance
  access event
  approval for sensitive grants
  emergency access
  periodic review
```

### Priorité de résolution

```text
deny explicite
→ permission directe
→ profil
→ délégation explicite
→ aucun fallback rôle
```

Le rôle devient une information organisationnelle ou de compatibilité, pas une autorisation métier.

## 6. Invariants obligatoires

1. Un compte humain correspond à une seule personne ou agent.
2. Un agent sorti ne peut plus s’authentifier.
3. Toute permission sensible est explicite.
4. Un refus explicite est prioritaire.
5. Aucun rôle historique n’accorde directement un droit métier après migration.
6. Toute délégation passe par le moteur canonique.
7. Une permission non possédée ou non délégable ne peut être transmise.
8. Toute modification d’accès est auditée durablement.
9. Toute expiration est appliquée côté serveur.
10. Le frontend ne constitue jamais la barrière de sécurité.
11. Les comptes d’urgence sont distincts et surveillés.
12. La séparation des fonctions est testée pour finance, comptabilité, achats, paie et parapheur.

## 7. Ordre de redressement recommandé

### P0

1. faire passer création et révocation des délégations par `delegation_engine` ;
2. rendre l’audit d’accès transactionnel ;
3. inventorier tous les `hasRole()` et fallbacks ;
4. cartographier chaque route sensible vers une permission ;
5. vérifier les comptes sans agent et agents sans compte ;
6. vérifier les comptes actifs des agents sortis.

### P1

1. créer `IdentityAccessService` ;
2. migrer rôles vers profils ;
3. désactiver le fallback module par module ;
4. formaliser les comptes d’urgence ;
5. harmoniser frontend et backend.

### P2

1. revue périodique des accès ;
2. workflow d’approbation des permissions sensibles ;
3. MFA et politiques de session selon criticité ;
4. rapports de séparation des fonctions.

## 8. Conclusion

Le système d’accès dispose de bons composants, mais ils ne sont pas encore assemblés en autorité unique. Le risque le plus urgent n’est pas l’absence de permissions : c’est la possibilité de contourner le moteur canonique par les rôles historiques, les routes directes et les anciens modèles de délégation.

La prochaine étape logique est `04-rh-paie.md`, afin de vérifier le cycle agent → compte → présence → congé → paie → sortie, puis ses contrôles d’accès.
