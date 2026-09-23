# Révision de l'audit « Maîtrise comptable des flux »

Date : 23 septembre 2026
Révise : [`accounting-flow-control-2026-06-23.md`](accounting-flow-control-2026-06-23.md)
Code mesuré : `45b14590c0dbfea12fe41577d36fe43dab6cf0b1` (production)
Cadrage : issue #49 — « P0 — Maîtrise comptable des encaissements, décaissements, virements, soldes et clôtures »

## Pourquoi une révision et non un nouvel audit

L'étape 1 du cadrage de l'issue #49 demande « un audit versionné et une matrice
des flux ». Cet audit existe déjà : le document du 23 juin 2026 porte le même
titre, contient la matrice des flux et quinze constats C1 à C15 dont le
diagnostic de l'issue #49 est une condensation quasi littérale.

Écrire un troisième document redondant n'apporterait rien. Ce qui manquait, c'est
de savoir **lesquels de ces quinze constats sont encore ouverts** après trois mois
de correctifs. Implémenter contre un diagnostic périmé, c'est corriger ce qui est
déjà corrigé en cassant ce qui fonctionne.

Chaque constat a donc été reconfronté au code et, quand c'était possible, à la
base de production.

## Tableau de révision

| Constat | État au 23/09/2026 | Preuve |
|---|---|---|
| C1 — Quatre sources de vérité des soldes | **En cours, éteint** | Trois écrivains de `cash_ledger` : `services/treasury-ledger.js:291`, `routes/agents_ecosystem_safe.js:311`, `routes/operations.js:1661`. En production, les **3 positions** sont en `ledger_status='legacy'` |
| C2 — Photographie `solde_position` non fiable | **Non re-vérifié** | Sonde sans résultat sur `recalculateSoldes` ; à reprendre |
| C3 — Contrôle du solde fondé sur l'identifiant | **Ouvert** | `operations.js:1593` appelle `getSoldePosition(op.position_id, op.id)` ; `getSoldePosition:356` ajoute `AND id < ?` |
| C4 — Encaissements sans workflow | **Ouvert** | `operations.js:674` : `const statutInsert = isWorkflowDec ? 'en_attente' : 'valide';` |
| C5 — Virements internes incomplets | **Ouvert** | Modèle à une seule ligne confirmé : `getSoldePosition:349-352` lit `position_id` et `position_source_id` sur la même ligne |
| C6 — Modification et annulation post-effet | **Partiel** | `PUT /:id:774-781` refuse si écriture `posted` et si période clôturée. Une opération **effective dont l'écriture n'est qu'un brouillon reste modifiable**. `DELETE /:id` marque `annule` sans mouvement inverse |
| C7a — Auto-validation des décaissements | **Fermé** | Corrigé le 23/06/2026, documenté dans `cash-out-separation-of-duties-2026-06-23.md` ; codes `CASH_OUT_APPROVER_REQUIRED`, `CASH_OUT_SELF_APPROVAL_FORBIDDEN`, contrôle monté avant le routeur historique |
| C7b — Seuils d'approbation du PRD | **Ouvert** | Aucune occurrence de « seuil » ni « threshold » dans `operations.js` ni `operations_parapheur_required_safe.js` |
| C8 — Audit non atomique | **Ouvert** | `auditDec:1298-1303` avale l'erreur (`catch (_) {}`) ; **19** `catch (_) {}` dans les deux fichiers de routes d'opérations |
| C9 — Comptabilité non atomique avec le mouvement | **Non re-vérifié** | Demande de suivre la transaction de bout en bout ; non fait dans cette passe |
| C10 — Séparation des fonctions comptables | **Non re-vérifié, signal négatif** | Aucun `requireRole(` ni `hasRole(req.user` trouvé dans `routes/accounting.js` — soit les rôles sont contrôlés au montage du routeur, soit ils ne le sont pas. À trancher |
| C11 — Deux modèles de clôture | **Ouvert, et sous-estimé** | La base porte **trois** notions : `caisses_clotures`, `cashbox_closures`, `periodes_cloturees` |
| C12 — Clôture journalière non bloquante | **Ouvert** | `operations.js` ne consulte que `periodes_cloturees` (année + mois) : `isPeriodeCloturee:263-268`, appelée en `647`, `781`, `864`. `caisses_clotures` et `cashbox_closures` ne sont **jamais lues** |
| C12b — Réouverture sans double approbation | **Ouvert** | `operations.js:2069` : `DELETE FROM periodes_cloturees` puis une seule ligne d'audit |
| C13 — Rapprochement mathématiquement incomplet | **Ouvert** | Aucune occurrence de `position_source_id` dans `routes/rapprochements.js` : un virement y est compté du mauvais signe |
| C14 — Affectation des caisses non appliquée | **Ouvert** | `user_cashboxes` : **zéro** occurrence dans `operations.js` |
| C15 — Tests incomplets | **Cause structurelle traitée, constat non re-vérifié** | Voir ci-dessous |

## Ce qui a changé depuis juin, et que l'audit ne pouvait pas savoir

### Une infrastructure de grand livre canonique existe — et elle est éteinte

La migration `037_treasury_ledger_canonical.sql` a introduit `cash_ledger.leg_code`,
`cash_ledger.reversal_of_ledger_id` et `positions.ledger_status`, et le service
`backend/services/treasury-ledger.js` sait poster une opération en jambes
canoniques avec contrôle d'existence et de cohérence.

**Mais en production les trois positions sont toutes en `ledger_status='legacy'`.**
Le grand livre canonique n'est donc source de vérité **nulle part**, et le solde
continue d'être calculé sur `operations`.

Cela change la nature de l'étape 2 du cadrage. Il ne s'agit pas de construire une
source de vérité unique : elle est construite. Il s'agit de

1. faire passer **tous** les écrivains par le service (trois aujourd'hui) ;
2. reprendre l'historique pour les positions à basculer ;
3. basculer `ledger_status` position par position, avec une vérification avant et
   après ;
4. retirer le chemin ancien une fois aucune position en `legacy`.

C'est un plan de migration, pas un développement neuf. La distinction porte sur
le risque : chaque bascule est réversible et vérifiable isolément.

### Le commentaire de `operations.js:1608-1617` documente un incident réel

Le verrou du paiement porte désormais sur `positions`, pas sur le cache
`cashbox_balances`, parce que ce cache n'est alimenté que par des chemins de
décaissement : sur une position `legacy` il ne peut que baisser. Le 21/09/2026 il
annonçait 0 quand la caisse tenait 2 402 000 XAF.

Conséquence pour C1 : le cache existe, il est faux sur les positions `legacy`, et
le code le sait et s'en protège. Ce n'est pas « quatre sources de vérité qui
divergent en silence », c'est « une source fausse, explicitement neutralisée ».
La correction reste nécessaire ; l'urgence n'est pas la même.

### C15 avait une cause structurelle, traitée le 23/09/2026

Les bancs isolés tournaient sur un socle SQLite reconstruit à la main, miroir des
migrations MySQL. Ce miroir s'était arrêté à la migration 036 : `hasCanonicalLedger()`
levait « no such column: leg_code » et **tout le chemin d'annulation d'une
opération était inatteignable par les bancs**, alors que la CI les exécute. Un vert
qui n'atteint pas un chemin ne dit rien de ce chemin.

Depuis `45b1459`, `scripts/lib/socle_mysql.js` fait venir le schéma des migrations
et ne recopie que les données de semis ; un premier banc tourne sur une base MySQL
jetable. Cela ne ferme pas C15 — la couverture comptable reste à établir — mais
cela retire l'obstacle qui la rendait invérifiable.

## Ce qui n'a pas été re-vérifié dans cette passe

C2, C9, C10 et C15 ne sont ni ouverts ni fermés ici. Mes sondes n'ont pas répondu,
et une conclusion par plausibilité vaudrait exactement ce que vaut le diagnostic
qu'on révise. Chacun demande une lecture suivie plutôt qu'un relevé :

- **C2** : suivre `recalculateSoldes` et ses appelants ;
- **C9** : suivre une création d'opération jusqu'au `COMMIT` et voir où la
  génération de l'écriture s'insère ;
- **C10** : établir où les rôles sont contrôlés pour `accounting.js` — le montage
  du routeur, ou nulle part ;
- **C15** : dresser la couverture réelle des chemins comptables.

## Conséquence sur l'ordre d'exécution de l'issue #49

L'ordre proposé reste valable, avec deux ajustements que cette révision motive :

1. **L'étape 1 est faite** : ce document la clôt. Elle n'a pas besoin d'un
   troisième audit, mais les quatre constats ci-dessus doivent être tranchés avant
   de chiffrer les étapes qui en dépendent.
2. **L'étape 2 est une migration, pas une construction.** Elle se découpe en
   bascules par position, chacune vérifiable et réversible, plutôt qu'en une
   refonte.

Les constats fermés — C7a — ne doivent pas être rouverts. Les constats ouverts les
plus indépendants les uns des autres, donc les plus faciles à traiter isolément,
sont **C13** (signe du virement au rapprochement), **C14** (filtrage par caisse) et
**C7b** (seuils d'approbation). Ils ne dépendent pas de la bascule du grand livre.

## Note de conformité

Ce document est une spécification et un constat technique. Il n'introduit aucun
texte visible dans l'interface, et aucune de ses formulations ne doit être reprise
comme libellé, titre, message ou bannière.
