-- Migration 026 : enrichissement comptes OHADA depuis referentiels Frappe locaux
-- Sources locales auditees :
-- /opt/frappe_docker/docs/CONFIGURATION-COMPTES-OHADA.md
-- /opt/frappe_docker/docs/GUIDE-COMPTES-OHADA-CONFIGURATION.md
-- /opt/frappe_docker/docs/OHADA-COMPTES-LOYER-EAU-ELECTRICITE.md

INSERT IGNORE INTO accounting_accounts (code, label, account_class) VALUES
  ('421', 'Personnel - rémunérations dues', '4'),
  ('422', 'Personnel, rémunérations dues', '4'),
  ('425', 'Avances au personnel', '4'),
  ('471', 'Comptes de régularisation', '4'),
  ('486', 'Charges constatées d avance', '4'),
  ('487', 'Produits constatés d avance', '4'),
  ('4011', 'Fournisseurs', '4'),
  ('4081', 'Fournisseurs - factures non parvenues', '4'),
  ('4086', 'Fournisseurs, intérêts courus', '4'),
  ('4111', 'Clients', '4'),
  ('5211', 'Banques en monnaie nationale', '5'),
  ('571001', 'Caisse principale', '5'),
  ('6011', 'Achats dans la région', '6'),
  ('6019', 'Rabais, remises et ristournes obtenus', '6'),
  ('603', 'Variation de stock', '6'),
  ('6031', 'Variation de stock de matières premières', '6'),
  ('6032', 'Variation de stock de fournitures', '6'),
  ('6051', 'Fournitures non stockables eau', '6'),
  ('6052', 'Fournitures non stockables électricité', '6'),
  ('606', 'Charges directes', '6'),
  ('607', 'Charges indirectes', '6'),
  ('608', 'Autres charges externes', '6'),
  ('6222', 'Locations de bâtiments', '6'),
  ('6226', 'Fermages et loyers du foncier', '6'),
  ('6228', 'Locations et charges locatives diverses', '6'),
  ('628', 'Frais de télécommunications', '6'),
  ('6281', 'Frais de téléphone', '6'),
  ('6288', 'Autres frais de télécommunications', '6'),
  ('6385', 'Charges de copropriété', '6'),
  ('6588', 'Autres charges diverses', '6'),
  ('661', 'Rabais, remises et ristournes accordés', '6'),
  ('681', 'Dotations aux amortissements', '6'),
  ('6812', 'Dotations aux amortissements', '6'),
  ('701', 'Ventes de produits finis', '7'),
  ('7011', 'Ventes dans la région', '7');
