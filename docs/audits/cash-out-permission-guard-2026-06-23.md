# Réparation du contrôle de permission des décaissements — 23 juin 2026

## Défaut

Le routeur historique utilisait la fonction asynchrone `can()` comme une valeur booléenne :

```js
return can(user, 'cash.out.pay') || hasRole(...)
```

Une promesse JavaScript étant toujours vraie, les contrôles synchrones pouvaient laisser passer une création, une modification ou un paiement avant résolution réelle de la permission.

## Correction

- service partagé `cash-operation-permissions.js` ;
- résolution obligatoire avec `await` ;
- montant transmis au moteur de permission pour respecter les plafonds ;
- gardes placés avant les moteurs canonique et historique ;
- encaissements et virements laissés à leurs propres workflows ;
- protection de la création, modification, soumission, resoumission et du paiement des décaissements.

## Non-régression

`tests/cash_operation_permission_guard_test.js` exécute le service avec de faux modules de permission et vérifie l’ordre des middlewares avant les routes métier.
