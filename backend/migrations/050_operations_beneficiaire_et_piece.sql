-- Décaissements : type de bénéficiaire et type de pièce justificative.
--
-- Les deux champs existaient dans l'interface depuis l'origine : le formulaire
-- de décaissement les propose, le front les envoie à chaque enregistrement et
-- les relit à la réouverture. Les colonnes, elles, n'ont jamais existé.
--
-- Deux conséquences constatées en production le 31/08/2026 :
--
--   1. À la réouverture d'un décaissement, les deux listes revenaient vides.
--      Le comptable devait resaisir le type de bénéficiaire à chaque
--      modification, et l'information n'était nulle part au moment du
--      contrôle.
--
--   2. L'import CSV d'opérations nommait beneficiaire_type dans son INSERT.
--      Il échouait donc systématiquement :
--      ER_BAD_FIELD_ERROR - Unknown column 'beneficiaire_type' in 'field list'
--
-- VARCHAR et non ENUM : l'import lit ces valeurs dans une colonne de tableur
-- saisie à la main. Un ENUM rejetterait le texte libre et casserait l'import
-- que cette migration répare. La normalisation est faite côté serveur, où elle
-- peut rester tolérante à l'import sans laisser entrer n'importe quoi.

ALTER TABLE operations
  ADD COLUMN beneficiaire_type VARCHAR(32) NULL AFTER tiers,
  ADD COLUMN type_piece VARCHAR(32) NULL AFTER piece_justificative;

-- Le contrôle d'un décaissement passe par le type de bénéficiaire : un
-- paiement à un organisme social ne se justifie pas comme un paiement à un
-- fournisseur.
CREATE INDEX idx_operations_beneficiaire_type ON operations (beneficiaire_type);
