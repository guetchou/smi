-- Budget et affectation « sans objet » pour le passé — décision du 28/09/2026.
--
-- Aucune ligne de code n'a jamais fait passer budget_status ni allocation_status
-- à un état final. Chaque opération validée ouvrait donc deux anomalies que
-- rien ne pouvait refermer : 14 encaissements de janvier à mars 2026
-- (12 425 000 XAF), 28 anomalies. Il n'y avait pourtant rien à rapprocher : la
-- table budgets était vide, aucune facture ni aucun document source n'existait.
--
-- Décision (option c) : pour le passé, une étape sans rien à rapprocher est
-- « sans objet » ; pour la suite, le rattachement aux prévisions et aux
-- factures sera construit.
--
-- La migration ne touche qu'une étape encore « pending », d'une opération
-- validée créée au plus tard le 28/09/2026, et seulement si rien n'existe à
-- quoi la rattacher. Une opération qui a une prévision budgétaire, une facture
-- ou une affectation reste « pending ». Chaque changement est inscrit au
-- journal d'audit, et les anomalies correspondantes sont résolues.
--
-- Retour arrière : les lignes d'audit « flow_not_applicable » désignent les
-- opérations touchées ; remettre leurs deux colonnes à 'pending' et rouvrir les
-- anomalies (status = 'open') restaure l'état antérieur.

UPDATE operations o
SET o.budget_status = 'not_applicable', o.updated_at = NOW()
WHERE o.statut = 'valide'
  AND o.budget_status = 'pending'
  AND o.created_at < '2026-09-29'
  AND NOT EXISTS (
    SELECT 1 FROM budgets b
    WHERE b.categorie_id = o.categorie_id
      AND b.mois = MONTH(o.date)
      AND b.annee = YEAR(o.date)
  );

UPDATE operations o
SET o.allocation_status = 'not_applicable', o.updated_at = NOW()
WHERE o.statut = 'valide'
  AND o.allocation_status = 'pending'
  AND o.created_at < '2026-09-29'
  AND o.source_document_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM payment_allocations pa WHERE pa.operation_id = o.id);

INSERT INTO audit_logs (table_name, record_id, action, details, user_id)
SELECT 'operations', o.id, 'flow_not_applicable',
       CONCAT('{"budget_status":"', o.budget_status, '","allocation_status":"', o.allocation_status,
              '","avant":"pending","decision":"2026-09-28 option c","migration":"059"}'),
       NULL
FROM operations o
WHERE o.budget_status = 'not_applicable' OR o.allocation_status = 'not_applicable';

UPDATE sync_errors se
JOIN operations o ON o.id = se.source_record_id
SET se.status = 'resolved', se.resolved_at = NOW(), se.updated_at = NOW()
WHERE se.source_module = 'operations'
  AND se.status = 'open'
  AND (
    (se.error_type = 'BUDGET_SYNC_PENDING' AND o.budget_status = 'not_applicable')
    OR (se.error_type = 'ALLOCATION_SYNC_PENDING' AND o.allocation_status = 'not_applicable')
  );
