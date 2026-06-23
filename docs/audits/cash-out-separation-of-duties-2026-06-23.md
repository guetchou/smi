# Séparation des tâches sur les décaissements — 23 juin 2026

## Défaut

Un utilisateur habilité à valider pouvait soumettre un décaissement et obtenir immédiatement son passage à l’état `valide`. La route de validation historique ne vérifiait pas non plus si le validateur était l’initiateur ou le soumetteur.

## Correction

- la soumission conduit toujours à l’état `soumis` ;
- le parapheur est créé dans la même transaction que la soumission ;
- un validateur distinct doit intervenir ensuite ;
- le créateur et le soumetteur ne peuvent pas valider leur propre décaissement ;
- les tentatives interdites sont journalisées sous l’action `dec_auto_validation_bloquee` ;
- le contrôle est monté avant le routeur historique afin de couvrir les positions canoniques et non encore migrées.

## Codes métier

- `CASH_OUT_APPROVER_REQUIRED` ;
- `CASH_OUT_SELF_APPROVAL_FORBIDDEN`.

## Non-régression

`tests/cash_out_separation_of_duties_test.js` vérifie le service métier, l’ordre des middlewares et l’absence d’auto-validation dans le routeur sécurisé.
