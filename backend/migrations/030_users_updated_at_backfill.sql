-- Migration 030 : colonne de suivi manquante sur les comptes utilisateurs.
-- IdentityAccessService met a jour cette colonne lors de toute modification
-- d'identite, de roles ou de rattachement a une fiche agent.

ALTER TABLE users
  ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;
