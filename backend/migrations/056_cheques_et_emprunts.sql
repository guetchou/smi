-- ═══════════════════════════════════════════════════════════════════════════
-- Chèques remis à l'encaissement, et les emprunts.
--
-- Deux manques constatés le 04/09/2026, en confrontant le système au parcours
-- réel décrit par la direction : chèque reçu d'un client, remis en banque,
-- fonds retirés pour la caisse, paiement Airtel, prêt d'un tiers en complément,
-- et le chèque d'un autre client rejeté par la banque.
--
-- 1. LA REMISE EN BANQUE N'EXISTAIT PAS COMME ÉTAPE.
--
--    Saisir le chèque sur « Banque BCH » créditait le solde bancaire le jour
--    de la réception, alors que l'argent n'y était pas encore. Le chèque
--    rejeté l'a prouvé : le solde affichait comme acquis ce qui n'a jamais
--    été encaissé.
--
--    Une position d'attente sépare les deux moments. Le chèque y entre à la
--    réception ; un virement le porte en banque quand elle crédite ; un rejet
--    reste confiné à cette position, et le solde bancaire n'a jamais menti.
--
--    Type « autre » : ce n'est ni une caisse d'où l'on paie, ni un compte
--    bancaire — c'est une créance en cours de recouvrement.
--
-- 2. UN PRÊT N'EST PAS UNE SUBVENTION.
--
--    La seule rubrique de recette qui pouvait l'accueillir était
--    « Subventions & financements ». Or une subvention est un produit, un
--    emprunt est une dette à rembourser : les confondre fausse le résultat.
--    Et aucune rubrique n'existait pour le remboursement, qui serait tombé
--    dans « Autres dépenses ».
--
-- Libellés validés par la direction le 04/09/2026.
--
-- Idempotent : rejouable sans créer de doublon.
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO positions (code, libelle, type, solde_initial, actif, couleur, ordre)
SELECT 'CHQ_ENC', 'Chèques remis à l''encaissement', 'autre', 0, 1, '#f59e0b', 3
WHERE NOT EXISTS (SELECT 1 FROM positions WHERE code = 'CHQ_ENC');

INSERT INTO categories (nom, type, couleur, icone, actif)
SELECT 'Emprunts & prêts reçus', 'encaissement', '#0ea5e9', 'circle', 1
WHERE NOT EXISTS (
  SELECT 1 FROM categories WHERE nom = 'Emprunts & prêts reçus' AND type = 'encaissement'
);

INSERT INTO categories (nom, type, couleur, icone, actif)
SELECT 'Remboursement d''emprunt', 'decaissement', '#0ea5e9', 'circle', 1
WHERE NOT EXISTS (
  SELECT 1 FROM categories WHERE nom = 'Remboursement d''emprunt' AND type = 'decaissement'
);
