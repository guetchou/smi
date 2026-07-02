# 11 — Audit, Notifications et Reprise après échec

## 1. Verdict provisoire

**Audit et notifications : partiellement exploitables, non fiables comme preuve complète ni comme mécanisme garanti de livraison.**

Le dépôt possède un moteur de notifications plus structuré que de nombreux autres modules :

- notifications internes ;
- alertes actives ;
- rappels ;
- règles par type ;
- destinataires ;
- priorités ;
- préférences ;
- déduplication ;
- email ;
- SSE temps réel ;
- escalades ;
- historique d’envoi ;
- nombre de tentatives ;
- erreurs de livraison ;
- acquittement, résolution et override ;
- audit de certaines actions.

Mais le système n’est pas encore une outbox transactionnelle généralisée. Plusieurs modules appellent encore l’audit, les notifications ou l’email en mode non bloquant, avec erreurs ignorées. Une opération métier peut donc réussir sans trace complète ni notification durable.

## 2. Modèle observé

### 2.1 Notifications internes

`creerNotification()` :

- charge une règle active ;
- détermine les destinataires directs ou par rôles ;
- crée les notifications dans une transaction ;
- applique une déduplication par type, source, utilisateur et fenêtre d’une heure ;
- pousse ensuite le badge et le message par SSE ;
- déclenche éventuellement l’email après la transaction.

### 2.2 Livraison email

`envoyerEmail()` :

- calcule une clé de déduplication ;
- crée un enregistrement `notif_envois` avec `INSERT IGNORE` ;
- envoie l’email ;
- marque l’envoi `envoye` ou `echec` ;
- incrémente les tentatives ;
- stocke l’erreur et la dernière tentative.

### 2.3 Alertes

`declencherAlerte()` :

- déduplique les alertes actives par type, source et position ;
- actualise la dernière détection ;
- crée une alerte active ;
- crée des notifications destinataires ;
- pousse en temps réel ;
- distingue les alertes bloquantes.

Les routes permettent acquittement, résolution et override avec motif.

### 2.4 Audit

Le dépôt utilise principalement `audit_logs`, mais aussi des tables spécialisées comme `permission_audit_logs`, `parapheur_actions` et `finance_operation_events`.

Le problème principal est l’absence d’un contrat uniforme :

- certains services auditent dans leur transaction métier ;
- certains auditent après la mutation ;
- certains ignorent les erreurs ;
- certains utilisent une table spécifique ;
- certains chemins n’ont aucune preuve d’audit.

## 3. Anomalies

### AUD-001 — Erreurs d’audit fréquemment ignorées

- Gravité : critique.
- Preuve : plusieurs helpers utilisent `catch (_) {}` ou un commentaire `non-bloquant`.
- Conséquence : opération sensible réussie sans preuve durable.
- Correction : audit transactionnel pour les événements critiques ou outbox durable créée dans la même transaction.

### AUD-002 — Pas de schéma canonique d’événement

- Gravité : haute.
- Preuve : tables et formats différents selon modules.
- Conséquence : recherche, corrélation et export incohérents.
- Correction : contrat commun avec événement, acteur, autorité, source, avant/après, corrélation, transaction et horodatage.

### AUD-003 — Audit modifiable ou supprimable non interdit par preuve DB

- Gravité : critique.
- Conséquence : trace altérable après fraude ou erreur.
- Correction : permissions DB restreintes, append-only, archivage et chaîne d’intégrité ou export immuable.

### AUD-004 — Absence de corrélation transversale

- Gravité : critique.
- Preuve : aucun identifiant de corrélation commun n’est systématiquement transporté entre document, parapheur, paiement, ledger, comptabilité et notification.
- Conséquence : impossible de reconstruire simplement un parcours complet.
- Correction : `correlation_id` et `causation_id` obligatoires sur chaque événement critique.

### AUD-005 — Avant/après non systématiques

- Gravité : haute.
- Conséquence : l’action est connue sans pouvoir prouver précisément la modification.
- Correction : snapshot minimal avant/après ou diff structuré, avec protection des données sensibles.

### AUD-006 — Acteur technique et acteur métier confondus

- Gravité : haute.
- Preuve : certains traitements utilisent un identifiant fixe ou le rôle principal, d’autres un compte humain.
- Conséquence : responsabilité difficile à établir.
- Correction : distinguer `actor_user_id`, `service_account_id`, `on_behalf_of`, délégation et autorité utilisée.

### AUD-007 — Notifications non créées si règle absente

- Gravité : haute.
- Preuve : `creerNotification()` retourne une liste vide si aucune règle active n’existe.
- Conséquence : événement critique silencieux à cause d’un paramétrage incomplet.
- Correction : types critiques avec règle obligatoire validée au démarrage; alerte de configuration sinon.

### AUD-008 — Erreur globale de notification convertie en succès vide

- Gravité : haute.
- Preuve : `creerNotification()` capture l’erreur, journalise en console et retourne `[]`.
- Conséquence : l’appelant ne sait pas distinguer “aucun destinataire” de “échec technique”.
- Correction : résultat explicite ou outbox; ne jamais masquer l’échec d’un événement critique.

### AUD-009 — Audit appelé hors transaction de notification

- Gravité : haute.
- Preuve : la notification est créée via `tx`, mais `audit()` utilise le connecteur global `db`.
- Conséquence : notification validée sans audit ou audit validé alors que la transaction notification rollbacke.
- Correction : accepter l’exécuteur transactionnel dans l’audit.

### AUD-010 — Email déclenché par `setImmediate`

- Gravité : haute.
- Preuve : envoi lancé après la création, sans file persistante générale ni worker démontré.
- Conséquence : redémarrage du processus entre commit et callback, email jamais tenté.
- Correction : outbox persistante créée dans la transaction, worker avec retry.

### AUD-011 — SSE sans garantie de livraison

- Gravité : moyenne.
- Preuve : erreurs ignorées, diffusion mémoire.
- Conséquence : client déconnecté ne reçoit pas l’événement temps réel.
- Correction : SSE reste un accélérateur; la notification persistante doit rester la vérité.

### AUD-012 — Déduplication horaire trop grossière

- Gravité : haute.
- Preuve : clé email basée sur l’heure UTC et notification interne sur une fenêtre d’une heure.
- Conséquence : deux événements légitimes de même type/source peuvent être fusionnés; un retry après changement d’heure peut doubler.
- Correction : clé d’idempotence fournie par l’événement source, pas seulement une fenêtre temporelle.

### AUD-013 — Déduplication calculée avec l’horloge applicative

- Gravité : moyenne.
- Conséquence : divergence entre nœuds ou fuseaux.
- Correction : identifiant d’événement immuable et horloge DB/UTC cohérente.

### AUD-014 — Destinataires encore déduits par rôles historiques

- Gravité : haute.
- Preuve : `usersParRoles()` lit `role` et `roles` JSON.
- Conséquence : notification envoyée à des personnes non autorisées ou oubliée pour un profil effectif.
- Correction : destinataires par permission, responsabilité organisationnelle ou affectation explicite.

### AUD-015 — Fallback destinataire admin silencieux

- Gravité : haute.
- Preuve : règle absente ou JSON invalide peut retomber sur `admin`.
- Conséquence : fuite d’informations ou surcharge des administrateurs.
- Correction : configuration invalide bloquante pour types sensibles.

### AUD-016 — Alertes non filtrées réellement par destinataire

- Gravité : critique.
- Preuve : commentaire annonçant un filtrage selon le rôle, mais la requête liste les alertes sans jointure de destinataire.
- Conséquence : un utilisateur authentifié peut potentiellement voir toutes les alertes.
- Correction : table alerte-destinataire ou filtre par permission/position.

### AUD-017 — Alertes bloquantes accessibles sans garde spécialisée

- Gravité : haute.
- Preuve : endpoint de liste des alertes bloquantes sans contrôle métier spécifique observé.
- Conséquence : exposition de données financières et opérationnelles.
- Correction : permission dédiée et portée par position.

### AUD-018 — Acquittement autorisé à des rôles trop larges

- Gravité : haute.
- Preuve : admin, finance, RH et caissier peuvent acquitter des alertes système.
- Conséquence : une alerte peut être masquée par un acteur non responsable.
- Correction : permission et responsabilité selon type d’alerte.

### AUD-019 — Override réservé à admin superuser

- Gravité : critique.
- Conséquence : pouvoir trop large et absence de séparation des fonctions.
- Correction : permission sensible, double approbation éventuelle, durée, plafond et journal renforcé.

### AUD-020 — Résolution manuelle indépendante de la cause

- Gravité : critique.
- Preuve : une alerte peut être mise `resolue` manuellement sans preuve que l’anomalie source soit corrigée.
- Conséquence : dashboard vert alors que le défaut persiste.
- Correction : résolution automatique depuis l’invariant source, ou justification avec contrôle secondaire.

### AUD-021 — Suppression physique des notifications archivées

- Gravité : moyenne à haute.
- Preuve : endpoint DELETE sur `notif_messages` archivées.
- Conséquence : perte de preuve de livraison ou d’information utilisateur.
- Correction : rétention définie, anonymisation éventuelle et purge gouvernée, pas suppression libre.

### AUD-022 — Tentatives email sans worker de reprise prouvé

- Gravité : haute.
- Preuve : statut et compteur existent, mais aucun processus fiable de retry n’est démontré dans cette passe.
- Conséquence : envois en échec restent définitivement en échec.
- Correction : worker, backoff, limite, dead-letter et alerte.

### AUD-023 — Pas de suivi de remise email

- Gravité : moyenne.
- Conséquence : `envoye` signifie seulement accepté par le transport, pas livré au destinataire.
- Correction : webhooks fournisseur, statuts delivered/bounced/complaint lorsque disponibles.

### AUD-024 — Données sensibles dans les détails d’audit

- Gravité : haute.
- Preuve : `details` reçoit parfois le corps complet de requêtes ou snapshots.
- Conséquence : mots de passe, données RH, bancaires ou personnelles possibles dans les logs.
- Correction : schémas d’événements, masquage et classification des champs.

### AUD-025 — Rétention et archivage non prouvés

- Gravité : haute.
- Conséquence : croissance illimitée ou purge arbitraire.
- Correction : politique par type, exigences légales, export et restauration testée.

### AUD-026 — Supervision des échecs insuffisante

- Gravité : critique.
- Preuve : beaucoup d’erreurs finissent seulement dans `console.error`.
- Conséquence : panne silencieuse jusqu’à plainte utilisateur.
- Correction : métriques, alertes techniques, tableau de dead-letter et runbook.

## 4. Points positifs

- Les notifications internes sont persistantes.
- Les emails possèdent un statut, un compteur de tentatives et une erreur.
- La déduplication DB existe pour les emails.
- Les alertes ont acquittement, résolution et override motivé.
- Le SSE complète la persistance sans être la seule représentation.
- Le moteur de règles centralise une partie de la configuration.

## 5. Modèle canonique proposé

```text
domain_event
audit_event
outbox_event
delivery_attempt
notification_recipient
alert_instance
alert_resolution
```

### États de livraison

```text
pending
processing
sent
delivered
failed
retry_scheduled
dead_letter
cancelled
```

### Informations minimales d’audit

```text
event_id
correlation_id
causation_id
event_type
source_module
source_type
source_id
actor_user_id
actor_authority
delegation_id
before_digest
after_digest
details_sanitized
occurred_at
committed_at
```

## 6. Invariants obligatoires

1. Toute action critique produit une trace durable dans la même transaction.
2. L’audit est append-only.
3. Toute notification critique possède une outbox persistante.
4. Un redémarrage ne perd aucun envoi engagé.
5. Tout retry est idempotent.
6. Un échec finit en dead-letter visible.
7. Les destinataires sont calculés depuis permissions et responsabilités canoniques.
8. Les alertes respectent la portée des données.
9. Une alerte n’est résolue que si sa cause est corrigée ou par exception formelle.
10. Les détails sensibles sont masqués.
11. La rétention est définie et testée.
12. Le parcours complet est reconstructible par `correlation_id`.

## 7. Ordre de redressement

### P0

1. Corriger la visibilité des alertes.
2. Rendre les audits critiques transactionnels.
3. Introduire une outbox persistante.
4. Remplacer les erreurs masquées par des statuts explicites.
5. Mettre en place un worker de retry et une dead-letter.
6. Interdire la résolution d’alerte sans contrôle de la cause.
7. Retirer les destinataires basés uniquement sur rôles historiques.
8. Ajouter la corrélation transversale.

### P1

1. Normaliser les événements d’audit.
2. Durcir l’immutabilité et la rétention.
3. Ajouter métriques et supervision.
4. Intégrer les retours de livraison email.
5. Créer les écrans d’administration des échecs.

## 8. Conclusion

Le moteur de notifications possède de bonnes fondations, mais la stratégie globale reste “best effort”. Pour un SMI industriel, l’audit ne peut pas être optionnel et une notification critique ne peut pas dépendre d’un callback mémoire. La priorité est de rendre les événements métier, l’audit et l’outbox inséparables au moment du commit.

La prochaine étape logique est `12-production-ci-cd.md`, afin de vérifier déploiement, secrets, migrations, sauvegarde, restauration, supervision et version réellement exécutée.
