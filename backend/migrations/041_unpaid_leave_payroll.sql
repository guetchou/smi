ALTER TABLE bulletins_salaire
  ADD COLUMN salaire_base_contractuel DECIMAL(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN jours_payables_mois DECIMAL(8,2) NOT NULL DEFAULT 0,
  ADD COLUMN jours_sans_solde DECIMAL(8,2) NOT NULL DEFAULT 0,
  ADD COLUMN taux_journalier_sans_solde DECIMAL(15,4) NOT NULL DEFAULT 0,
  ADD COLUMN retenue_sans_solde DECIMAL(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN details_sans_solde TEXT NULL;

INSERT IGNORE INTO parametres (cle, valeur) VALUES
  ('paie_sans_solde_actif', '1'),
  ('paie_sans_solde_diviseur', 'jours_ouvres_mois'),
  ('paie_sans_solde_prorata_transport', '0'),
  ('paie_sans_solde_prorata_logement', '0'),
  ('paie_sans_solde_arrondi', 'franc');
