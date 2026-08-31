-- Refermer les anomalies de synchronisation des opérations annulées.
--
-- L'écran des mouvements affichait « ANOMALIES DE SYNCHRONISATION (8) », toutes
-- rattachées aux écritures de test neutralisées le 31/08/2026 : elles
-- réclamaient une ventilation comptable, une imputation budgétaire et une
-- affectation métier pour des opérations qui n'existent plus.
--
-- Vérifié en base : les 18 anomalies ouvertes sont toutes attachées à une
-- opération annulée. Aucune n'est légitime.
--
-- ensureOperationSyncErrors refusait déjà d'en créer pour une opération non
-- validée, mais rien ne refermait celles déjà ouvertes au moment de
-- l'annulation. Le correctif de code s'en charge désormais ; celles qui
-- existent sont refermées ici.
--
-- resolved_by reste nul : personne ne les a traitées, elles sont devenues sans
-- objet. Le distinguer d'une résolution par un humain a une valeur d'audit.

UPDATE sync_errors se
JOIN operations o ON o.id = se.source_record_id
SET se.status      = 'resolved',
    se.resolved_at = NOW(),
    se.updated_at  = NOW()
WHERE se.source_module = 'operations'
  AND se.status = 'open'
  AND o.statut = 'annule';
