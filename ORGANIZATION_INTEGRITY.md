# Règles d'intégrité organisationnelle

- Le responsable actif du département est le supérieur imposé aux agents ordinaires de ce département.
- Le responsable du département peut avoir un supérieur de niveau plus élevé, sans auto-supervision ni cycle.
- Toute création ou modification d'agent est validée par le service central d'affectation.
- Tout changement de responsable resynchronise les agents actifs du département et journalise les changements effectifs.
- Un département actif doit avoir un responsable actif.
- Un département contenant des agents actifs ne peut pas être désactivé ni renommé directement.
- Les mutations RH reprennent automatiquement le responsable du département cible.
- La migration complète vers `employee_assignments` reste une évolution ultérieure.

## Diagnostic des données historiques

`GET /api/org/anomalies`

Le rapport distingue notamment :

- départements sans responsable ou avec responsable inactif ;
- agents sans département, avec département inconnu ou désactivé ;
- supérieur différent du responsable officiel du département ;
- supérieur introuvable, auto-supervision et boucles hiérarchiques ;
- noms historiques de supérieurs devenus obsolètes.

Chaque anomalie indique si elle est réparable automatiquement. Les cas ambigus restent manuels.

## Réparation contrôlée

Simulation sans écriture :

```json
POST /api/org/reparer-integrite
{
  "dry_run": true
}
```

Exécution réelle :

```json
POST /api/org/reparer-integrite
{
  "dry_run": false,
  "confirmation": "REPARER"
}
```

La réparation :

- n'applique que les changements ne créant pas de cycle ;
- refuse d'écraser une modification concurrente ;
- journalise chaque agent modifié dans les mutations RH et l'audit ;
- produit un rapport avant/après et conserve les anomalies nécessitant une décision RH.
