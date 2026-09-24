# Consignation avant déploiement — pile Finance du 24/09/2026

Ce document existe pour une raison précise : le déploiement de production ne doit
pas être déclenché avant que le SHA, les migrations, le retour arrière et les
résultats de tests soient consignés. Il n'est pas un compte rendu rédigé après
coup — il est la condition préalable.

Tout ce qui suit est **mesuré**, avec la commande qui l'établit. Ce qui n'est pas
mesuré est dit tel quel.

---

## 1. SHA

| | SHA | Commit |
|---|---|---|
| Production actuelle | `45b14590c0dbfea12fe41577d36fe43dab6cf0b1` | `fix: alertes par destinataire… (#224)` |
| Candidat au déploiement | `515445c3e256b6b629217455a97c3797017562a8` | `fix(finance): normaliser les décimaux au pilote… (#230)` |

La production a été lue sur le VPS (`git -C /opt/projet-smi rev-parse HEAD`), pas
reprise d'un document : la note de passation indiquait `c75a593`, qui était déjà
périmé.

Worktree de déploiement vérifié propre (`git status --porcelain
--untracked-files=all` vide) — le workflow refuse un worktree sali.

## 2. Ce que le déploiement apporte

Onze commits, dont cinq antérieurs à la pile du jour et jamais déployés :

```
515445c fix(finance): normaliser les décimaux au pilote (#230)
3926229 fix(finance): une seule garde de clôture pour tous les chemins (#234)
da9b0cc feat(finance): double approbation Finance + DG (#233)
8b38b61 feat(finance): appliquer les seuils d'approbation configurés (#229)
abf9c20 feat(finance): fermer le périmètre caisse + deux défauts de l'import (#235)
58ba588 docs+refactor(finance): nommer la classification du périmètre caisse (#231)
8c04d87 fix(finance): une clôture de caisse bloque les écritures de sa journée (#228)
d2da380 Merge #227 — rapprochement, signe du virement
654c5ac fix(finance): une seule convention de solde (#227)
19cabf3 fix(finance): appliquer le périmètre caisse aux opérations (#226)
8e5c796 docs: réviser l'audit des flux comptables (#225)
```

## 3. Migrations

**Aucune migration à appliquer.**

Mesuré par comparaison nom par nom entre `backend/migrations/*.sql` et la table
`schema_migrations` de la production (colonne `version`) : aucun fichier du dépôt
n'est absent de la production.

Mesuré aussi par `git diff --diff-filter=A 45b1459..515445c -- backend/migrations/` :
vide. La pile est du code, pas du schéma — c'est ce qui rend le retour arrière
simple.

### Écart préexistant relevé au passage

Deux migrations sont enregistrées comme appliquées en production alors que leur
fichier n'existe sur **aucune branche** actuelle :

- `041_unpaid_leave_payroll.sql`
- `042_unpaid_leave_late_rectifications.sql`

Elles ajoutaient des colonnes à la paie (`jours_sans_solde`, `retenue_sans_solde`,
`source_period`, …). **Aucune** n'est référencée par le code de `main` : ces
colonnes sont orphelines. Conséquence mesurée : nulle pour ce déploiement ; un
environnement reconstruit depuis `main` ne les aurait pas, et aucun code ne les
réclamerait. Gravité faible, mais la traçabilité est rompue.

Non corrigé volontairement : corriger signifierait soit restaurer les fichiers,
soit supprimer colonnes et lignes — une décision de produit, pas un nettoyage.

## 4. Retour arrière

Le workflow `deploy.yml` prend en entrée un `sha` présent sur `main` et un
`confirm` valant `DEPLOY`. Le retour arrière est donc **le même geste avec le SHA
précédent** :

```
sha     = 45b14590c0dbfea12fe41577d36fe43dab6cf0b1
confirm = DEPLOY
```

Ce retour est valide **parce qu'aucune migration n'accompagne le déploiement** :
le code revient en arrière sans qu'un schéma reste en avant. Si une migration
avait été présente, ce runbook porterait une procédure de dévalidation, et le
retour ne serait pas symétrique.

Point non vérifié, et il faut le dire : ce retour n'a pas été **exécuté** à blanc.
Le mécanisme est lu dans le workflow, pas éprouvé.

## 5. Résultats de tests

Tous obtenus sur le SHA candidat `515445c`, sur `main` fusionnée — pas sur les
branches avant fusion.

### Suite unitaire

`npm test` — vert.

### Bancs isolés, HTTP réel, MySQL réel

Onze bancs, base jetable, serveur réellement lancé, jeton signé, requêtes HTTP :

| Banc | Résultat |
|---|---|
| `test_caisse_operation_isolated` | vert |
| `test_parcours_roles_isolated` | vert |
| `test_alertes_destinataire_isolated` | vert |
| `test_perimetre_caisse_isolated` | vert |
| `test_perimetre_bascule_isolated` | vert |
| `test_rapprochement_virement_isolated` | vert |
| `test_cloture_verrou_isolated` | vert |
| `test_cloture_transaction_isolated` | vert |
| `test_seuils_approbation_isolated` | vert |
| `test_double_approbation_isolated` | vert |
| `test_decimaux_frontiere_isolated` | vert |

Les deux premiers tournent sur SQLite : ils gardent la logique, **pas** le
dialecte MySQL. Les neuf autres sont adossés au socle MySQL et sont la seule
mesure du comportement réel de la production.

### Intégration continue

Chaque PR de la pile a été fusionnée sur une CI verte dont le `head_sha` a été
comparé au commit poussé. Ce contrôle n'est pas décoratif : sur #230, `gh pr checks`
affichait vert pour un run appartenant à un commit périmé.

Dernier run vérifié : `36011962000`, `head_sha` = `cfe3229`, conclusion `success`,
onze étapes de bancs toutes en `success` — aucune `skipped`.

## 6. Ce qui reste à décider avant de déclencher

### Deux chaînes visibles nouvelles, non validées éditorialement

La règle de séparation spécification / interface impose de lister les chaînes
visibles ajoutées et de justifier chacune. Deux réemplois sont couverts
(`Accès refusé`, présent dans 18 fichiers avant la pile ; `Opération non trouvée`,
présent dans 1). Les deux suivantes sont **réellement nouvelles** :

| Fichier:ligne | Chaîne | Raison fonctionnelle |
|---|---|---|
| `backend/routes/operations.js:1649` | `Vous avez déjà approuvé ce décaissement` | distinguer le refus « même acteur deux fois » du refus d'autorité |
| `backend/routes/operations.js:1658` | `Décaissement sans dossier de parapheur — approbation impossible` | distinguer l'absence de dossier d'un refus de droit |

Aucune des deux ne provient d'une formulation de ticket ; elles nomment un état
que l'API doit distinguer. Elles n'ont pour autant **pas** été fournies comme copy
validée. Elles attendent donc un arbitrage : les valider telles quelles, les
reformuler, ou les remplacer par un libellé existant en acceptant de perdre la
distinction.

Rien n'est déployé : le choix reste entier.

### Deux défauts connus, volontairement non corrigés

1. **Le décaissement d'une avance sur salaire écrit la colonne `detail`**, absente
   en MySQL. Ce chemin est probablement cassé en production.
2. **Sous MySQL, `routes/agents.js` et `routes/salaires.js` n'ont aucune
   transaction** : la façade synchrone réduit `transaction(fn)` à un appel de `fn`.
   Dix blocs supposés atomiques ne le sont pas.

Réparer le premier sans le second transformerait un chemin **cassé** en chemin
**partiellement écrivant** — un défaut plus grave et plus discret. Les deux
demandent leur propre chantier, dont le vrai contenu est de porter ces deux
fichiers sur le pool asynchrone.

### Conséquence d'exploitation de la fermeture du périmètre

`admin`, `dg` et `finance` restent globaux ; tout autre rôle est soumis à
`user_cashboxes`. Mesuré sur la production : 0 délégation active, 0 compte de rôle
`delegue`, 0 délégué sans caisse — la bascule est sans effet de bord aujourd'hui.

Mais toute délégation créée à l'avenir devra être accompagnée d'une affectation de
caisse, sans quoi le délégué sera refusé par le périmètre avant même que son
autorité soit examinée. Le banc `test_seuils_approbation_isolated` épingle
désormais ce comportement dans les deux sens.

### Question produit ouverte

La tuile « dettes fournisseurs » ignore le statut `partiellement_payee` et
sous-estime donc la dette. Non corrigé : le comportement attendu est un choix de
produit.

---

## 7. Décision

Ce runbook est la condition préalable, pas l'autorisation. Le workflow de
production **n'a pas été déclenché**.
