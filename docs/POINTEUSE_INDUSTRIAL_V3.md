# Pointeuse industrielle V3 — architecture et critères de bascule

## Objectif
Remplacer progressivement le modèle historique `1 agent / 1 date / 1 ligne` par une architecture Time & Attendance orientée événements, sans casser la V2 pendant la transition.

## Invariants non négociables
- identité, date et heure dérivées côté serveur ;
- événements physiques append-only ;
- machine à états explicite `clock_in -> break_start -> break_end -> clock_out` ;
- idempotence obligatoire ;
- sérialisation des transitions concurrentes d’un agent ;
- `work_date` distinct de la date civile pour les shifts de nuit ;
- corrections par ajustements non destructifs ;
- séparation demandeur / approbateur ;
- anomalies bloquantes avant clôture ;
- périodes clôturées immuables hors procédure de réouverture ;
- flux paie issu d’un snapshot clôturé, versionné et hashé ;
- audit métier append-only avec correlation id et chaînage de hash.

## Modèle cible
### 1. Événements physiques
`pointeuse_events` conserve les faits bruts : type, UTC ms, heure locale, fuseau, source, mode, site, device, session, IP, GPS et clé d’idempotence.

### 2. Journée de travail
`work_date` représente la journée métier. Un shift 22:00–06:00 reste rattaché au jour de démarrage jusqu’au `clock_out`.

### 3. Planning
Les horaires sont versionnés et affectés avec dates d’effet, site, jours de semaine et mode autorisé. Le télétravail/terrain dépend d’une affectation explicite.

### 4. Calcul journalier
La synthèse matérialise : travaillé, pauses, retard, départ anticipé, heures supplémentaires, nuit, anomalies et version de calcul.

### 5. Anomalies
Workflow : `detected -> to_justify -> submitted -> approved/rejected -> regularized/dismissed`.

### 6. Corrections
L’agent soumet une demande. RH/DG/admin décide. L’approbation produit un `pointeuse_adjustment` (`add`, `void`, `replace`) sans réécrire l’événement physique d’origine. L’auto-approbation est interdite.

### 7. Clôture
Période : `open -> calculated -> review -> approved -> closed`. Une clôture est refusée tant qu’une anomalie non résolue subsiste.

### 8. Paie
Une période clôturée produit un snapshot `tala.pointeuse.payroll-feed.v1` contenant les agrégats par agent. Le JSON canonique est signé par SHA-256 et stocké avec totaux de contrôle. La consommation est idempotente et auditée.

### 9. Audit
Les événements métier sensibles écrivent dans `pointeuse_audit_events` : agrégat, action, acteur, correlation id, avant/après, métadonnées, hash précédent et hash courant.

## Menaces couvertes
- falsification d’heure ou d’identité client ;
- double clic/retry réseau ;
- deux transitions concurrentes ;
- sortie sans entrée ;
- répétition ou saut d’étape ;
- télétravail/terrain non autorisé ;
- correction destructive ;
- auto-approbation ;
- modification après clôture ;
- alimentation paie depuis une période non clôturée ;
- rejeu d’un snapshot paie ;
- perte de traçabilité d’une décision RH.

## Critères obligatoires avant bascule V3
1. migrations MySQL propres et restauration testée ;
2. tests Node de contrat et tests de concurrence verts ;
3. scénarios E2E : normal, pause, nuit, oubli sortie, retard, HS, hors planning, correction, refus, approbation, clôture, paie ;
4. routeur V3 monté derrière authentification et rate limiting ;
5. nouvelle UI agent/manager accessible clavier et responsive ;
6. observation en production en mode parallèle V2/V3 sans écriture double incohérente ;
7. procédure rollback documentée ;
8. rapprochement des agrégats V2/V3 sur une période témoin ;
9. validation RH + finance avant activation du flux paie ;
10. aucune fusion finale si un invariant ci-dessus n’est pas testé.

## Stratégie de déploiement
- Phase A : schéma + moteur + tests, V3 non exposée ;
- Phase B : API V3 exposée à un groupe pilote, V2 reste référence ;
- Phase C : calcul parallèle et comparaison quotidienne ;
- Phase D : clôture V3 et snapshot paie en lecture seule ;
- Phase E : V3 devient référence, V2 passe en lecture seule ;
- Phase F : retrait de V2 après période de stabilité et sauvegarde.
