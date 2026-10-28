# Diagnostic financier en lecture seule

{
  "read_only": true,
  "summary": {
    "positions_checked": 3,
    "operations_checked": 75,
    "effective_operations": 64,
    "ledger_rows": 0,
    "accounting_entries": 65,
    "balance_mismatches": 2,
    "ledger_sequence_mismatches": 0,
    "operations_missing_ledger": 67,
    "duplicate_ledger_legs": 0,
    "ledger_orphans": 0,
    "ledger_invalid_operations": 0,
    "operations_missing_accounting": 64,
    "synced_without_posted": 0,
    "unbalanced_entries": 0,
    "cancelled_operations_without_reversal": 0
  },
  "positions": [
    {
      "position_id": 1,
      "code": "CAISSE",
      "libelle": "Caisse principale (Bureau)",
      "type": "caisse",
      "solde_initial": 0,
      "effective_operations": 64,
      "ledger_rows": 0,
      "operations_balance": 324303500,
      "ledger_balance": 0,
      "cached_balance": 0,
      "balance_mismatch": true,
      "issues": [
        "operations_vs_ledger",
        "operations_vs_cache"
      ]
    },
    {
      "position_id": 2,
      "code": "BCH",
      "libelle": "Banque BCH",
      "type": "banque",
      "solde_initial": 0,
      "effective_operations": 3,
      "ledger_rows": 0,
      "operations_balance": -1850000,
      "ledger_balance": 0,
      "cached_balance": null,
      "balance_mismatch": true,
      "issues": [
        "operations_vs_ledger",
        "cache_missing"
      ]
    },
    {
      "position_id": 38,
      "code": "CHQ_ENC",
      "libelle": "Chèques remis à l'encaissement",
      "type": "autre",
      "solde_initial": 0,
      "effective_operations": 0,
      "ledger_rows": 0,
      "operations_balance": 0,
      "ledger_balance": 0,
      "cached_balance": null,
      "balance_mismatch": false,
      "issues": []
    }
  ]
}

Le controle canonique signale un registre vide. Les routeurs rendent explicitement la main au moteur historique lorsque canonicalReadinessForInput.ready est faux. Les soldes affiches restent calcules depuis les operations. Aucune activation ou reprise historique executee ; preparer une reprise verifiee avant toute activation. Les brouillons comptables ne sont pas valides par ce lot.
