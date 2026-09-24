# Périmètre des caisses — audit et classification proposée

Date : 23 septembre 2026
Base mesurée : `caisse_topcenter`, production, en lecture seule
Code mesuré : `main` après la PR #228
Constat d'origine : C14 de l'audit des flux, « la table `user_cashboxes` existe
mais n'est pas utilisée dans `operations.js` »

**Aucun défaut d'accès n'est modifié par ce document ni par le commit qui le
porte.** Il établit l'état, nomme les groupes, et fournit l'outil qui dira quand
une bascule est sûre.

## 1. État mesuré en production

| Mesure | Valeur |
|---|---|
| Comptes | 7 — 4 actifs, 3 inactifs |
| Caisses actives | 3 |
| Lignes dans `user_cashboxes` | **0** |

Vocabulaire des rôles, tel que la contrainte de `users.role` l'admet :
`admin`, `caissier`, `finance`, `rh`, `lecteur`, `dg`, `assistante_direction`,
`delegue`.

**La colonne `role` ne suffit pas à classer un compte.** `hasRole` lit aussi
`users.roles`, un tableau JSON, et `admin` y vaut raccourci universel. Un compte
dont la colonne `role` vaut `assistante_direction` peut porter `finance` dans son
tableau, et être ainsi globalement habilité. Classer sur la seule colonne `role`
produit une classification fausse — c'est l'erreur que cet audit a commencé par
commettre avant de la mesurer.

Répartition réelle, rôles effectifs compris :

| Classe | Comptes | Dont actifs |
|---|---|---|
| Global | 5 | 4 |
| Soumis à affectation | 1 | 0 |
| En transition | 1 | 0 |

**Les quatre comptes actifs sont tous globaux** : trois par `admin`, un par
`finance` porté dans `users.roles`.

**Un compte inactif est déjà soumis au périmètre** : il porte `caissier` sans
rôle global, donc depuis la PR #226 il ne verrait aucune caisse. Ce n'est pas une
hypothèse sur l'avenir, c'est l'état actuel — masqué par le fait qu'il est
inactif.

## 2. Comportement actuel, rôle par rôle

| Rôle | Aujourd'hui | Nommé dans le code ? |
|---|---|---|
| `admin` | non restreint | oui |
| `dg` | non restreint | oui |
| `finance` | non restreint | oui |
| `caissier` | ses caisses affectées seulement | oui |
| `rh` | **non restreint** | non — retombée |
| `lecteur` | **non restreint** | non — retombée |
| `assistante_direction` | **non restreint** | non — retombée |
| `delegue` | **non restreint** | non — retombée |

Les quatre derniers obtenaient leur accès par le `else` implicite de
`hasScopedCashboxAccess` : aucune ligne ne l'assumait. C'est ce que ce commit
corrige — en les nommant, pas en les restreignant.

## 3. Classification proposée

`backend/services/perimetre-caisse.js` déclare trois groupes :

- **`ROLES_GLOBAUX`** — `admin`, `dg`, `finance`. Jamais restreints.
- **`ROLES_SOUMIS_A_AFFECTATION`** — `caissier`. Ne voit que ses caisses.
- **`ROLES_EN_TRANSITION`** — `rh`, `lecteur`, `assistante_direction`,
  `delegue`. Aujourd'hui non restreints, **en attente d'arbitrage**.

Un compte ne portant aucun rôle connu tombe en « transition », c'est-à-dire dans
la classe la moins restrictive : une donnée inattendue ne doit enfermer personne
dehors.

### Pourquoi « transition » plutôt qu'une bascule immédiate

`user_cashboxes` est vide. Fermer le périmètre sur une table d'affectations vide
ne restreint pas l'accès : il le supprime. L'ordre sûr est donc semer, vérifier,
puis basculer — dans cet ordre et pas un autre.

## 4. L'outil qui dit quand la bascule est sûre

`scripts/audit_perimetre_caisse.js`, strictement en lecture — il n'émet que des
`SELECT` et peut être exécuté contre la production sans précaution.

```
node scripts/audit_perimetre_caisse.js              état actuel
node scripts/audit_perimetre_caisse.js --bascule    état après bascule
```

Il sort en **0** si aucun compte **actif** ne serait privé de toute caisse, en
**1** sinon. C'est ce qui permet de s'en servir comme garde avant migration.

Le verrou porte sur les comptes actifs : eux seuls peuvent se connecter et donc
perdre un accès. Les comptes inactifs sont signalés sans bloquer — un verrou qui
refuse indéfiniment pour des comptes que personne n'utilise finit par être
contourné.

### Résultat au 23/09/2026, mode `--bascule`

```
Répartition : 5 global(aux), 2 soumis à affectation, 0 en transition
2 compte(s) INACTIFS n'auraient aucune caisse : id 4, id 5
Aucun compte ACTIF ne serait privé d'accès : la bascule est sans effet de bord.
sortie=0
```

**Conclusion mesurée : la bascule ne coûterait aujourd'hui l'accès à aucun compte
actif.** Elle laisserait deux comptes inactifs sans caisse — à semer avant de les
rouvrir, pas avant de basculer.

## 5. Ce qu'il reste à faire avant de fermer

1. Décider si les quatre rôles en transition doivent rejoindre
   « soumis à affectation ». C'est une décision produit, pas technique.
2. Si oui : semer `user_cashboxes` pour les comptes concernés — aucun actif
   aujourd'hui, mais la situation change dès qu'un compte est créé ou réactivé.
3. Rejouer le script en mode `--bascule` et exiger une sortie 0.
4. Alors seulement déplacer les rôles de `ROLES_EN_TRANSITION` vers
   `ROLES_SOUMIS_A_AFFECTATION` — un seul endroit à modifier.

## 6. Note de conformité

Ce document est un constat technique et une proposition. Il n'introduit aucun
texte visible dans l'interface, et aucune de ses formulations ne doit devenir un
libellé. Le commit qui le porte ne modifie aucun défaut d'accès : le banc
`scripts/test_perimetre_caisse_isolated.js` reste vert à l'identique, ce qui en
est la mesure.
