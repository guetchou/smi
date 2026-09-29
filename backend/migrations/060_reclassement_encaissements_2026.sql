-- Reclassement des 14 encaissements de janvier à mars 2026 — décision du 29/09/2026.
--
-- Les 14 opérations avaient toutes été saisies en « encaissement », catégorie
-- « Prestations de services ». L'utilisateur a validé leur nature réelle,
-- opération par opération, en vocabulaire SYSCOHADA :
--
--   n° 12, 16, 17, 19, 21 à 26 : recettes de prestation au comptant, en caisse,
--     sans TVA. Écriture : 571001 Caisse (D) / 706 Services vendus (C).
--     Elles passaient en 571001 / 4111 Clients, ce qui supposait une facture
--     comptabilisée ; il n'en existe aucune.
--   n° 15, 18, 20 : virements de fonds Banque BCH → Caisse (retraits en banque).
--     Écriture : 571001 (D) / 5211 Banque (C), journal VIR.
--   n° 27 : avance sur salaire de M. MATOKO récupérée par retenue sur paie.
--     Une retenue n'est pas un encaissement : aucun argent n'est entré en
--     caisse. L'opération est annulée, jamais supprimée.
--
-- Le compte 706 manquait au plan : il est ajouté, et les règles des
-- encaissements sans facture le prennent au lieu de 4111.
--
-- Chaque instruction vérifie l'état attendu (identifiant, type, statut,
-- montant) : si la donnée a changé depuis la décision, elle ne touche rien.
-- Seuls des brouillons comptables sont modifiés ; aucune écriture validée.
--
-- Retour arrière (ligne d'audit « reclassement_060 » pour chaque opération) :
--   n° 15, 18, 20 : type_op='encaissement', position_source_id=NULL,
--     categorie_id=1 ; leur brouillon : journal CA, source cash_receipt,
--     entry_no CA-ENC-000000NN, ligne créditrice en 4111 sans position.
--   recettes : ligne créditrice du brouillon en 4111.
--   n° 27 : statut='valide', flux 'pending', motif et date d'annulation à NULL,
--     brouillon en 'draft', anomalies rouvertes.
--   règles 1 et 2 : crédit en 4111.

INSERT IGNORE INTO accounting_accounts (code, label, account_class) VALUES ('706', 'Services vendus', '7');

UPDATE accounting_mapping_rules
SET credit_account_id = (SELECT id FROM accounting_accounts WHERE code = '706'), updated_at = NOW()
WHERE operation_type = 'encaissement'
  AND credit_account_id = (SELECT id FROM accounting_accounts WHERE code = '4111');

UPDATE operations
SET type_op = 'virement',
    position_source_id = (SELECT id FROM positions WHERE code = 'BCH'),
    categorie_id = NULL,
    updated_at = NOW()
WHERE type_op = 'encaissement' AND statut = 'valide'
  AND position_id = (SELECT id FROM positions WHERE code = 'CAISSE')
  AND ((id = 15 AND montant = 250000) OR (id = 18 AND montant = 1000000) OR (id = 20 AND montant = 600000));

UPDATE accounting_entry_lines l
JOIN accounting_entries e ON e.id = l.entry_id
JOIN operations o ON o.id = e.source_record_id
SET l.account_id = (SELECT id FROM accounting_accounts WHERE code = '5211'),
    l.position_id = o.position_source_id,
    l.updated_at = NOW()
WHERE e.source_module = 'cash_receipt' AND e.status = 'draft'
  AND o.id IN (15, 18, 20) AND o.type_op = 'virement'
  AND l.credit > 0
  AND l.account_id = (SELECT id FROM accounting_accounts WHERE code = '4111');

UPDATE accounting_entries e
JOIN operations o ON o.id = e.source_record_id
SET e.journal_code = 'VIR',
    e.source_module = 'internal_transfer',
    e.entry_no = CONCAT('VIR-VIR-', LPAD(o.id, 8, '0')),
    e.updated_at = NOW()
WHERE e.source_module = 'cash_receipt' AND e.status = 'draft'
  AND o.id IN (15, 18, 20) AND o.type_op = 'virement';

UPDATE accounting_entry_lines l
JOIN accounting_entries e ON e.id = l.entry_id
JOIN operations o ON o.id = e.source_record_id
SET l.account_id = (SELECT id FROM accounting_accounts WHERE code = '706'),
    l.updated_at = NOW()
WHERE e.source_module = 'cash_receipt' AND e.status = 'draft'
  AND o.id IN (12, 16, 17, 19, 21, 22, 23, 24, 25, 26)
  AND o.type_op = 'encaissement' AND o.statut = 'valide'
  AND l.credit > 0
  AND l.account_id = (SELECT id FROM accounting_accounts WHERE code = '4111');

UPDATE operations
SET statut = 'annule',
    annule_at = NOW(),
    annule_motif = 'Retenue sur paie',
    treasury_status = 'cancelled',
    accounting_status = 'cancelled',
    budget_status = 'cancelled',
    allocation_status = 'cancelled',
    updated_at = NOW()
WHERE id = 27 AND type_op = 'encaissement' AND statut = 'valide' AND montant = 60000;

UPDATE accounting_entries
SET status = 'cancelled', updated_at = NOW()
WHERE source_module = 'cash_receipt' AND source_record_id = 27 AND status = 'draft'
  AND EXISTS (SELECT 1 FROM operations WHERE id = 27 AND statut = 'annule');

UPDATE sync_errors
SET status = 'ignored', resolved_at = NOW(), updated_at = NOW()
WHERE source_module = 'operations' AND source_record_id = 27 AND status = 'open'
  AND EXISTS (SELECT 1 FROM operations WHERE id = 27 AND statut = 'annule');

INSERT INTO audit_logs (table_name, record_id, action, details, user_id)
SELECT 'operations', o.id, 'reclassement_060',
       CASE
         WHEN o.id IN (15, 18, 20) THEN '{"avant":"encaissement / Prestations de services / 571001-4111","apres":"virement BCH vers Caisse / 571001-5211","decision":"2026-09-29"}'
         WHEN o.id = 27 THEN '{"avant":"encaissement valide","apres":"annule — Retenue sur paie","decision":"2026-09-29"}'
         ELSE '{"avant":"571001-4111","apres":"571001-706 vente au comptant sans TVA","decision":"2026-09-29"}'
       END,
       NULL
FROM operations o
WHERE ((o.id IN (15, 18, 20) AND o.type_op = 'virement')
    OR (o.id = 27 AND o.statut = 'annule')
    OR (o.id IN (12, 16, 17, 19, 21, 22, 23, 24, 25, 26) AND o.type_op = 'encaissement' AND o.statut = 'valide'))
  AND NOT EXISTS (SELECT 1 FROM audit_logs a WHERE a.action = 'reclassement_060' AND a.record_id = o.id);
