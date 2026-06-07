# Tableau de contrôle des workflows

Dernière mise à jour : 7 juin 2026.

## Lot actif

**PRD :** `PRD_flux_encaissement_decaissement_tresorerie_comptabilite_budget.md`

**Tranche :** synchronisation comptable OHADA des opérations de trésorerie.

**Statut technique :** implémenté et testé localement.

## Chaîne contrôlée

```text
Opération éligible
→ mapping actif
→ brouillon équilibré
→ validation/posting
→ statut source synchronisé
→ anomalie visible
→ contre-écriture traçable si correction
```

## Terminé

- comptes OHADA et règles de mapping paramétrables ;
- règles créées inactives et activation explicitement confirmée ;
- génération idempotente des écritures ;
- validation équilibrée et blocage des périodes clôturées ;
- `sync_errors` et audit du cycle comptable ;
- verrouillage des opérations déjà comptabilisées ;
- contre-écriture comptable append-only ;
- vue unique Écritures / À comptabiliser / Règles ;
- responsive Playwright 320 à 1440 px ;
- test d'intégration SQLite isolé.

## Non exécuté automatiquement

- activation des mappings en production ;
- génération rétroactive des écritures historiques ;
- modification ou suppression de données comptables de production.

## Prochaines décisions métier

1. Validation écrite des mappings par le comptable.
2. Activation progressive sur un échantillon.
3. Rapport de simulation avant tout rattrapage historique.
4. Conception de la contre-opération de trésorerie pour les annulations métier.
5. Orchestration transactionnelle Budget / Affectations tiers.

## Rollback

Les fichiers sont suivis par Git. Aucune copie `.bak` n'est créée. Le rollback officiel est un `git revert` du commit concerné, suivi du pipeline CI/CD.
