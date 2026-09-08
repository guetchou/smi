-- Journal des refus de saisie.
--
-- Le journal d'audit ne retenait que ce qui aboutissait. Une saisie rejetée —
-- montant invalide, période clôturée, permission manquante — s'affichait sur
-- l'écran de l'agent puis disparaissait sans laisser de trace. Personne ne
-- pouvait donc voir ce sur quoi les agents butent.
--
-- Les refus rejoignent la table existante plutôt qu'une nouvelle : l'écran
-- Journal d'audit, ses filtres et son export CSV les couvrent alors sans une
-- ligne d'interface en plus.
--
-- record_id vaut 0 quand le refus ne porte sur aucun enregistrement existant
-- (une création rejetée n'a pas encore d'identifiant).

-- L'écran filtre par période ; sans index, la table est parcourue entièrement.
-- Sans effet aujourd'hui à 1 800 lignes, mais les refus la feront grossir.
CREATE INDEX idx_audit_logs_created_at ON audit_logs (created_at);

-- Recherche « ce que cet agent a tenté ce jour-là », le cas d'usage visé.
CREATE INDEX idx_audit_logs_user_created ON audit_logs (user_id, created_at);
