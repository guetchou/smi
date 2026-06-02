-- Migration 027 : brouillons de mapping OHADA non actifs.
-- Ces regles servent de base de validation comptable et ne sont pas utilisees
-- tant que is_active reste a 0.
-- Sources : PRD section 12.3 + referentiels Frappe locaux OHADA.

INSERT IGNORE INTO accounting_mapping_rules
  (operation_type, operation_nature, payment_method, position_type, third_party_type,
   debit_account_id, credit_account_id, journal_code, is_active)
SELECT 'encaissement', '*', 'virement_bancaire', 'banque', 'tiers',
       da.id, ca.id, 'BQ', 0
FROM accounting_accounts da
JOIN accounting_accounts ca
WHERE da.code = '5211' AND ca.code = '4111';

INSERT IGNORE INTO accounting_mapping_rules
  (operation_type, operation_nature, payment_method, position_type, third_party_type,
   debit_account_id, credit_account_id, journal_code, is_active)
SELECT 'encaissement', '*', 'especes', 'caisse', 'tiers',
       da.id, ca.id, 'CA', 0
FROM accounting_accounts da
JOIN accounting_accounts ca
WHERE da.code = '571001' AND ca.code = '4111';

INSERT IGNORE INTO accounting_mapping_rules
  (operation_type, operation_nature, payment_method, position_type, third_party_type,
   debit_account_id, credit_account_id, journal_code, is_active)
SELECT 'decaissement', '*', 'virement_bancaire', 'banque', 'tiers',
       da.id, ca.id, 'BQ', 0
FROM accounting_accounts da
JOIN accounting_accounts ca
WHERE da.code = '4011' AND ca.code = '5211';

INSERT IGNORE INTO accounting_mapping_rules
  (operation_type, operation_nature, payment_method, position_type, third_party_type,
   debit_account_id, credit_account_id, journal_code, is_active)
SELECT 'decaissement', '*', 'especes', 'caisse', 'tiers',
       da.id, ca.id, 'CA', 0
FROM accounting_accounts da
JOIN accounting_accounts ca
WHERE da.code = '4011' AND ca.code = '571001';

INSERT IGNORE INTO accounting_mapping_rules
  (operation_type, operation_nature, payment_method, position_type, third_party_type,
   debit_account_id, credit_account_id, journal_code, is_active)
SELECT 'virement', '*', '*', 'caisse', '*',
       da.id, ca.id, 'VIR', 0
FROM accounting_accounts da
JOIN accounting_accounts ca
WHERE da.code = '571001' AND ca.code = '5211';

INSERT IGNORE INTO accounting_mapping_rules
  (operation_type, operation_nature, payment_method, position_type, third_party_type,
   debit_account_id, credit_account_id, journal_code, is_active)
SELECT 'virement', '*', '*', 'banque', '*',
       da.id, ca.id, 'VIR', 0
FROM accounting_accounts da
JOIN accounting_accounts ca
WHERE da.code = '5211' AND ca.code = '571001';
