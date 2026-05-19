-- Forcer UTF8MB4 pour tout le schéma (accents français)
ALTER DATABASE caisse_topcenter
  CHARACTER SET = utf8mb4
  COLLATE = utf8mb4_unicode_ci;

-- Mode strict : rejeter les données invalides au lieu de les tronquer silencieusement
SET GLOBAL sql_mode = 'STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
