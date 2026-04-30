/**
 * BASE DE DONNÉES — CAISSE TOP CENTER
 * Convention OHADA / SYSCOHADA
 * Encaissement / Décaissement / Virement interne
 */
const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'caisse.db');
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function tableColumns(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(col => col.name);
}

function hasColumn(table, column) {
  return tableColumns(table).includes(column);
}

function addColumnIfMissing(table, column, definition) {
  if (!hasColumn(table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function migrateOperationsSchema() {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='operations'").get();
  if (!table) return;

  addColumnIfMissing('operations', 'num_piece', 'TEXT');
  addColumnIfMissing('operations', 'libelle', 'TEXT');
  addColumnIfMissing('operations', 'tiers', 'TEXT');
  addColumnIfMissing('operations', 'montant', 'REAL DEFAULT 0');
  addColumnIfMissing('operations', 'type_op', "TEXT DEFAULT 'decaissement'");
  addColumnIfMissing('operations', 'position_id', 'INTEGER DEFAULT 1');
  addColumnIfMissing('operations', 'position_source_id', 'INTEGER');
  addColumnIfMissing('operations', 'solde_position', 'REAL DEFAULT 0');
  addColumnIfMissing('operations', 'mode_reglement', "TEXT DEFAULT 'especes'");
  addColumnIfMissing('operations', 'ref_externe', 'TEXT');
  addColumnIfMissing('operations', 'piece_justificative', 'TEXT');
  addColumnIfMissing('operations', 'decharge_signee', 'INTEGER DEFAULT 0');
  addColumnIfMissing('operations', 'employe_id', 'INTEGER');
  addColumnIfMissing('operations', 'statut', "TEXT DEFAULT 'valide'");
  addColumnIfMissing('operations', 'created_by', 'INTEGER');
  addColumnIfMissing('operations', 'created_at', 'TEXT');
  addColumnIfMissing('operations', 'updated_at', 'TEXT');

  const cols = tableColumns('operations');
  const set = [];
  if (cols.includes('detail')) set.push("libelle = COALESCE(NULLIF(libelle, ''), detail)");
  if (cols.includes('n_piece')) set.push("num_piece = COALESCE(NULLIF(num_piece, ''), n_piece)");
  if (cols.includes('recette') && cols.includes('depense')) {
    set.push("montant = CASE WHEN COALESCE(montant, 0) > 0 THEN montant WHEN COALESCE(depense, 0) > 0 THEN depense WHEN COALESCE(recette, 0) > 0 THEN recette ELSE 0 END");
    set.push("type_op = CASE WHEN COALESCE(recette, 0) > 0 THEN 'encaissement' ELSE COALESCE(type_op, 'decaissement') END");
  }
  if (cols.includes('mode_paiement')) {
    set.push(`mode_reglement = CASE
      WHEN COALESCE(NULLIF(mode_reglement, ''), mode_paiement, 'especes') = 'virement' THEN 'virement_bancaire'
      WHEN COALESCE(NULLIF(mode_reglement, ''), mode_paiement, 'especes') = 'carte' THEN 'autres'
      ELSE COALESCE(NULLIF(mode_reglement, ''), mode_paiement, 'especes')
    END`);
  }
  if (cols.includes('solde')) set.push('solde_position = COALESCE(solde_position, solde, 0)');
  set.push("position_id = COALESCE(position_id, 1)");
  set.push("statut = COALESCE(NULLIF(statut, ''), 'valide')");
  set.push("created_at = COALESCE(created_at, datetime('now'))");
  set.push("updated_at = COALESCE(updated_at, created_at, datetime('now'))");

  db.prepare(`UPDATE operations SET ${set.join(', ')}`).run();
}

function init() {
  db.exec(`
    -- =============================================
    -- UTILISATEURS & ACCÈS
    -- =============================================
    CREATE TABLE IF NOT EXISTS users (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      nom       TEXT NOT NULL,
      email     TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role      TEXT NOT NULL DEFAULT 'caissier'
                CHECK(role IN ('admin','caissier','lecteur')),
      actif     INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- =============================================
    -- POSITIONS DE TRÉSORERIE
    -- Caisse physique | Comptes bancaires
    -- =============================================
    CREATE TABLE IF NOT EXISTS positions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      code          TEXT UNIQUE NOT NULL,          -- CAISSE, BCH, ATB, etc.
      libelle       TEXT NOT NULL,                 -- Caisse principale, Banque BCH
      type          TEXT NOT NULL DEFAULT 'caisse'
                    CHECK(type IN ('caisse','banque','autre')),
      solde_initial REAL DEFAULT 0,               -- Solde d'ouverture
      actif         INTEGER DEFAULT 1,
      couleur       TEXT DEFAULT '#6366f1',
      ordre         INTEGER DEFAULT 0
    );

    -- =============================================
    -- CATÉGORIES DE DÉPENSES/RECETTES
    -- =============================================
    CREATE TABLE IF NOT EXISTS categories (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      nom     TEXT NOT NULL,
      type    TEXT NOT NULL CHECK(type IN ('recette','depense')),
      couleur TEXT DEFAULT '#6366f1',
      icone   TEXT DEFAULT 'circle',
      actif   INTEGER DEFAULT 1
    );

    -- =============================================
    -- EMPLOYÉS
    -- =============================================
    CREATE TABLE IF NOT EXISTS employes (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      nom          TEXT NOT NULL,
      prenom       TEXT NOT NULL,
      poste        TEXT,
      type         TEXT NOT NULL DEFAULT 'permanent'
                   CHECK(type IN ('permanent','stagiaire')),
      salaire_base REAL DEFAULT 0,
      cnss         TEXT,
      camu         TEXT,
      email        TEXT,
      telephone    TEXT,
      actif        INTEGER DEFAULT 1,
      created_at   TEXT DEFAULT (datetime('now'))
    );

    -- =============================================
    -- JOURNAL DES OPÉRATIONS (OHADA)
    -- Convention : encaissement = argent ENTRANT
    --              décaissement = argent SORTANT
    --              virement = transfert interne (Banque→Caisse ou inverse)
    -- =============================================
    CREATE TABLE IF NOT EXISTS operations (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      date                  TEXT NOT NULL,
      num_piece             TEXT,

      -- Description
      libelle               TEXT NOT NULL,
      tiers                 TEXT,             -- Fournisseur / Client / Bénéficiaire

      -- Montant (toujours positif)
      montant               REAL NOT NULL DEFAULT 0,

      -- Nature de l'opération (OHADA)
      type_op               TEXT NOT NULL DEFAULT 'decaissement'
                            CHECK(type_op IN ('encaissement','decaissement','virement')),

      -- Position concernée (où entre ou sort l'argent)
      position_id           INTEGER NOT NULL DEFAULT 1,

      -- Pour virement interne seulement : d'où vient l'argent
      -- Ex: APPRO CAISSE → position_id=CAISSE, position_source_id=BANQUE
      position_source_id    INTEGER,

      -- Solde cumulé de la position (calculé et stocké)
      solde_position        REAL DEFAULT 0,

      -- Classification
      categorie_id          INTEGER,

      -- Mode de règlement
      mode_reglement        TEXT DEFAULT 'especes'
                            CHECK(mode_reglement IN (
                              'especes','cheque','virement_bancaire',
                              'mobile_money','compensation','autres'
                            )),

      -- Référence externe (n° chèque, ref virement, etc.)
      ref_externe           TEXT,

      -- Pièce justificative & décharge
      piece_justificative   TEXT,
      decharge_signee       INTEGER DEFAULT 0,

      -- Lien employé (pour paiements salaires)
      employe_id            INTEGER,

      -- Statut
      statut                TEXT DEFAULT 'valide'
                            CHECK(statut IN ('valide','annule','en_attente')),

      -- Audit
      created_by            INTEGER,
      created_at            TEXT DEFAULT (datetime('now')),
      updated_at            TEXT DEFAULT (datetime('now')),

      FOREIGN KEY (position_id)        REFERENCES positions(id),
      FOREIGN KEY (position_source_id) REFERENCES positions(id),
      FOREIGN KEY (categorie_id)       REFERENCES categories(id),
      FOREIGN KEY (employe_id)         REFERENCES employes(id),
      FOREIGN KEY (created_by)         REFERENCES users(id)
    );

    -- =============================================
    -- BUDGETS MENSUELS
    -- =============================================
    CREATE TABLE IF NOT EXISTS budgets (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      mois          INTEGER NOT NULL CHECK(mois BETWEEN 1 AND 12),
      annee         INTEGER NOT NULL,
      categorie_id  INTEGER NOT NULL,
      montant_prevu REAL DEFAULT 0,
      notes         TEXT,
      UNIQUE(mois, annee, categorie_id),
      FOREIGN KEY (categorie_id) REFERENCES categories(id)
    );

    -- =============================================
    -- PARAMÈTRES GÉNÉRAUX
    -- =============================================
    CREATE TABLE IF NOT EXISTS parametres (
      cle    TEXT PRIMARY KEY,
      valeur TEXT NOT NULL
    );

    -- =============================================
    -- BULLETINS DE SALAIRE
    -- Structure complète OHADA / Congo-Brazzaville
    -- =============================================
    CREATE TABLE IF NOT EXISTS bulletins_salaire (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      employe_id           INTEGER NOT NULL,
      mois                 INTEGER NOT NULL CHECK(mois BETWEEN 1 AND 12),
      annee                INTEGER NOT NULL,
      -- Éléments de rémunération
      salaire_base         REAL DEFAULT 0,
      prime_transport      REAL DEFAULT 0,
      prime_logement       REAL DEFAULT 0,
      autres_primes        REAL DEFAULT 0,
      brut                 REAL DEFAULT 0,
      -- Retenues salariales
      cnss_employe         REAL DEFAULT 0,
      camu_employe         REAL DEFAULT 0,
      irpp                 REAL DEFAULT 0,
      total_retenues       REAL DEFAULT 0,
      net_imposable        REAL DEFAULT 0,
      net_a_payer          REAL DEFAULT 0,
      -- Charges patronales
      cnss_patronal        REAL DEFAULT 0,
      camu_patronal        REAL DEFAULT 0,
      cout_total_employeur REAL DEFAULT 0,
      -- Statut & lien opération caisse
      statut               TEXT DEFAULT 'brouillon'
                           CHECK(statut IN ('brouillon','valide','paye')),
      operation_id         INTEGER,
      notes                TEXT,
      -- Audit
      created_by           INTEGER,
      created_at           TEXT DEFAULT (datetime('now')),
      updated_at           TEXT DEFAULT (datetime('now')),
      UNIQUE(employe_id, mois, annee),
      FOREIGN KEY (employe_id)   REFERENCES employes(id),
      FOREIGN KEY (operation_id) REFERENCES operations(id)
    );
  `);

  // =============================================
  // SEED: Utilisateur admin
  // =============================================
  const adminExists = db.prepare("SELECT id FROM users WHERE email = ?").get('admin@topcenter.cg');
  if (!adminExists) {
    const hash = bcrypt.hashSync('Admin@2025!', 10);
    db.prepare("INSERT INTO users (nom, email, password_hash, role) VALUES (?, ?, ?, 'admin')")
      .run('Administrateur', 'admin@topcenter.cg', hash);
  }

  // =============================================
  // SEED: Positions de trésorerie
  // =============================================
  const posCount = db.prepare('SELECT COUNT(*) as c FROM positions').get().c;
  if (posCount === 0) {
    const positions = [
      { code: 'CAISSE', libelle: 'Caisse principale (Bureau)', type: 'caisse', couleur: '#10b981', ordre: 1 },
      { code: 'BCH',    libelle: 'Banque BCH',                  type: 'banque', couleur: '#6366f1', ordre: 2 },
    ];
    const ins = db.prepare('INSERT INTO positions (code,libelle,type,solde_initial,couleur,ordre) VALUES (?,?,?,0,?,?)');
    positions.forEach(p => ins.run(p.code, p.libelle, p.type, p.couleur, p.ordre));
  }

  // =============================================
  // SEED: Catégories (OHADA-compatible)
  // =============================================
  const catCount = db.prepare('SELECT COUNT(*) as c FROM categories').get().c;
  if (catCount === 0) {
    const cats = [
      // RECETTES
      { nom: 'Prestations de services',  type: 'recette',  couleur: '#10b981', icone: 'trending-up' },
      { nom: 'Subventions & financements', type: 'recette', couleur: '#06b6d4', icone: 'award' },
      { nom: 'Remboursements reçus',      type: 'recette',  couleur: '#3b82f6', icone: 'rotate-ccw' },
      { nom: 'Autres recettes',           type: 'recette',  couleur: '#f59e0b', icone: 'plus-circle' },
      // DÉPENSES
      { nom: 'Salaires permanents',       type: 'depense',  couleur: '#ef4444', icone: 'users' },
      { nom: 'Salaires stagiaires',       type: 'depense',  couleur: '#f97316', icone: 'user' },
      { nom: 'Loyer & charges locatives', type: 'depense',  couleur: '#dc2626', icone: 'home' },
      { nom: 'Frais de gestion',          type: 'depense',  couleur: '#be185d', icone: 'settings' },
      { nom: 'Transport & déplacements',  type: 'depense',  couleur: '#0891b2', icone: 'truck' },
      { nom: 'Télécom (MTN/AIRTEL/CT)',   type: 'depense',  couleur: '#7c3aed', icone: 'wifi' },
      { nom: 'Abonnements numériques',    type: 'depense',  couleur: '#4f46e5', icone: 'monitor' },
      { nom: 'Charges sociales CNSS/CAMU',type: 'depense',  couleur: '#b45309', icone: 'shield' },
      { nom: 'Achats & fournitures',      type: 'depense',  couleur: '#059669', icone: 'shopping-bag' },
      { nom: 'Carburant',                 type: 'depense',  couleur: '#92400e', icone: 'droplet' },
      { nom: 'Électricité',               type: 'depense',  couleur: '#ca8a04', icone: 'zap' },
      { nom: 'Travaux & maintenance',     type: 'depense',  couleur: '#65a30d', icone: 'tool' },
      { nom: 'Matériel informatique',     type: 'depense',  couleur: '#0ea5e9', icone: 'cpu' },
      { nom: 'Frais bancaires',           type: 'depense',  couleur: '#6366f1', icone: 'credit-card' },
      { nom: 'Gratifications & primes',   type: 'depense',  couleur: '#ec4899', icone: 'gift' },
      { nom: 'Impôts & taxes',            type: 'depense',  couleur: '#64748b', icone: 'file-text' },
      { nom: 'Autres dépenses',           type: 'depense',  couleur: '#94a3b8', icone: 'minus-circle' },
    ];
    const ins = db.prepare('INSERT INTO categories (nom,type,couleur,icone) VALUES (?,?,?,?)');
    cats.forEach(c => ins.run(c.nom, c.type, c.couleur, c.icone));
  }

  // =============================================
  // SEED: Employés
  // =============================================
  const empCount = db.prepare('SELECT COUNT(*) as c FROM employes').get().c;
  if (empCount === 0) {
    const employes = [
      { nom:'KIKAME',         prenom:'Nidda',           poste:'Responsable',              type:'permanent',  salaire:250000 },
      { nom:'BAYI',           prenom:'Caley',           poste:'Agent Commercial',          type:'permanent',  salaire:150000 },
      { nom:'LOUVOUEZO',      prenom:'Dieuveille',      poste:'Agent',                    type:'permanent',  salaire:120000 },
      { nom:'MAMINGUI',       prenom:'Ricardo',         poste:'Agent',                    type:'permanent',  salaire:130000 },
      { nom:'MATOKO',         prenom:'Jerhnice',        poste:'Agent Technique',           type:'permanent',  salaire:110000 },
      { nom:'BOUESSO',        prenom:'Nahomi',          poste:'Agent',                    type:'permanent',  salaire:100000 },
      { nom:'KINKONDA',       prenom:'Emmanuel',        poste:'Agent',                    type:'permanent',  salaire:60000  },
      { nom:'ETOKA',          prenom:'Franklin',        poste:'Stagiaire Commercial',      type:'stagiaire',  salaire:60000  },
      { nom:'NGATSONO LANGUI',prenom:'Petruis',         poste:'Stagiaire',                type:'stagiaire',  salaire:55000  },
      { nom:'KOUNDA MFOUTOU', prenom:'Ravy',            poste:'Stagiaire',                type:'stagiaire',  salaire:55000  },
      { nom:'GAYIDO',         prenom:'Gloire Auriole',  poste:'Stagiaire',                type:'stagiaire',  salaire:55000  },
      { nom:'LOEMBA',         prenom:'Daniella',        poste:'Stagiaire Commercial',      type:'stagiaire',  salaire:60000  },
      { nom:'AWELE',          prenom:'Destie Prephina', poste:'Stagiaire',                type:'stagiaire',  salaire:30000  },
      { nom:'KANGA',          prenom:'Aurel',           poste:'Agent',                    type:'permanent',  salaire:60000  },
    ];
    const ins = db.prepare('INSERT INTO employes (nom,prenom,poste,type,salaire_base) VALUES (?,?,?,?,?)');
    employes.forEach(e => ins.run(e.nom, e.prenom, e.poste, e.type, e.salaire));
  }

  // =============================================
  // SEED: Paramètres
  // =============================================
  const settings = [
    ['societe',            'TOP CENTER'],
    ['devise',             'XAF'],
    ['seuil_alerte',       '100000'],
    ['seuil_critique',     '50000'],
    ['jour_budget',        '20'],
    ['exercice',           '2025'],
    // Taux cotisations sociales — Congo-Brazzaville
    ['cnss_employe_taux',  '4.725'],   // part salariale CNSS
    ['cnss_patron_taux',   '20'],      // part patronale CNSS
    ['camu_employe_taux',  '2.25'],    // part salariale CAMU
    ['camu_patron_taux',   '5'],       // part patronale CAMU
    // IRPP — tranches mensuelles (montants en XAF)
    ['irpp_plafond_t1',    '464000'],  // tranche 1 : 0 %
    ['irpp_taux_t2',       '10'],      // tranche 2 : 10 %
    ['irpp_plafond_t2',    '1000000'], // plafond tranche 2
    ['irpp_taux_t3',       '25'],      // tranche 3 : 25 %
    ['irpp_plafond_t3',    '3000000'],
    ['irpp_taux_t4',       '40'],      // tranche 4 : 40 %
  ];
  const insSetting = db.prepare('INSERT OR IGNORE INTO parametres (cle,valeur) VALUES (?,?)');
  settings.forEach(s => insSetting.run(s[0], s[1]));

  migrateOperationsSchema();
  migrateEmployesSchema();
}

function migrateEmployesSchema() {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='employes'").get();
  if (!table) return;
  addColumnIfMissing('employes', 'mode_paiement',          "TEXT DEFAULT 'especes'");
  addColumnIfMissing('employes', 'banque',                  'TEXT');
  addColumnIfMissing('employes', 'numero_compte',           'TEXT');
  // ── Colonnes manquantes sur certaines DB existantes ───────
  addColumnIfMissing('employes', 'cnss',                    'TEXT');
  addColumnIfMissing('employes', 'camu',                    'TEXT');
  addColumnIfMissing('employes', 'email',                   'TEXT');
  addColumnIfMissing('employes', 'telephone',               'TEXT');
  // ── Extension RH v2 ──────────────────────────────────────
  addColumnIfMissing('employes', 'matricule',               'TEXT');
  addColumnIfMissing('employes', 'sexe',                    "TEXT DEFAULT 'M'");
  addColumnIfMissing('employes', 'date_naissance',          'TEXT');
  addColumnIfMissing('employes', 'lieu_naissance',          'TEXT');
  addColumnIfMissing('employes', 'nationalite',             "TEXT DEFAULT 'Congolaise'");
  addColumnIfMissing('employes', 'situation_matrimoniale',  "TEXT DEFAULT 'celibataire'");
  addColumnIfMissing('employes', 'nb_enfants',              'INTEGER DEFAULT 0');
  addColumnIfMissing('employes', 'nb_enfants_charge',       'INTEGER DEFAULT 0');
  addColumnIfMissing('employes', 'telephone2',              'TEXT');
  addColumnIfMissing('employes', 'adresse',                 'TEXT');
  addColumnIfMissing('employes', 'num_piece_identite',      'TEXT');
  addColumnIfMissing('employes', 'type_piece_identite',     'TEXT');
  addColumnIfMissing('employes', 'date_expiration_identite','TEXT');
  addColumnIfMissing('employes', 'date_embauche',           'TEXT');
  addColumnIfMissing('employes', 'type_contrat',            "TEXT DEFAULT 'cdi'");
  addColumnIfMissing('employes', 'date_debut_contrat',      'TEXT');
  addColumnIfMissing('employes', 'date_fin_contrat',        'TEXT');
  addColumnIfMissing('employes', 'periode_essai_mois',      'INTEGER DEFAULT 0');
  addColumnIfMissing('employes', 'date_fin_essai',          'TEXT');
  addColumnIfMissing('employes', 'departement',             'TEXT');
  addColumnIfMissing('employes', 'superieur_hierarchique',  'TEXT');
  addColumnIfMissing('employes', 'site',                    'TEXT');
  addColumnIfMissing('employes', 'statut_dossier',          "TEXT DEFAULT 'actif'");
  addColumnIfMissing('employes', 'motif_sortie',            'TEXT');
  addColumnIfMissing('employes', 'date_sortie',             'TEXT');
  addColumnIfMissing('employes', 'prime_transport',         'REAL DEFAULT 0');
  addColumnIfMissing('employes', 'prime_logement',          'REAL DEFAULT 0');
}

function migrateExtendedSchema() {
  // ── Table fournisseurs ───────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS fournisseurs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      nom         TEXT NOT NULL,
      telephone   TEXT,
      reference   TEXT,
      nif_rccm    TEXT,
      adresse     TEXT,
      actif       INTEGER DEFAULT 1,
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS employes_enfants (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      employe_id     INTEGER NOT NULL,
      nom            TEXT,
      prenom         TEXT NOT NULL,
      date_naissance TEXT,
      sexe           TEXT DEFAULT 'M',
      est_charge     INTEGER DEFAULT 1,
      scolarise      INTEGER DEFAULT 0,
      observation    TEXT,
      FOREIGN KEY (employe_id) REFERENCES employes(id)
    );

    CREATE TABLE IF NOT EXISTS employes_documents (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      employe_id       INTEGER NOT NULL,
      type_document    TEXT NOT NULL,
      date_emission    TEXT,
      date_expiration  TEXT,
      statut           TEXT DEFAULT 'valide',
      observation      TEXT,
      created_at       TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (employe_id) REFERENCES employes(id)
    );
  `);

  // Générer matricules manquants pour les employés existants
  const emps = db.prepare("SELECT id FROM employes WHERE matricule IS NULL OR matricule = ''").all();
  const upd  = db.prepare("UPDATE employes SET matricule = ? WHERE id = ?");
  emps.forEach(e => {
    upd.run('MAT-' + String(e.id).padStart(4, '0'), e.id);
  });

  db.prepare("INSERT OR IGNORE INTO parametres (cle, valeur) VALUES (?, ?)").run('age_retraite', '60');

  // ── Colonnes photo ───────────────────────────────────────
  addColumnIfMissing('employes', 'photo_url', 'TEXT');
  addColumnIfMissing('users',    'photo_url', 'TEXT');

  // ── Dossier uploads (dans le volume Docker) ──────────────
  const uploadsDir = require('path').join(__dirname, 'data', 'uploads');
  if (!require('fs').existsSync(uploadsDir)) require('fs').mkdirSync(uploadsDir, { recursive: true });

  // ── Colonnes avances ──────────────────────────────────────
  addColumnIfMissing('employes_avances', 'solde_restant',  'REAL DEFAULT 0');
  addColumnIfMissing('employes_avances', 'annule_at',      'TEXT');
  addColumnIfMissing('employes_avances', 'annule_by',      'INTEGER');
  addColumnIfMissing('employes_avances', 'annule_motif',   'TEXT');
  addColumnIfMissing('employes_avances', 'updated_at',     "TEXT DEFAULT (datetime('now'))");
  // Initialiser solde_restant = montant pour les avances existantes en cours
  db.prepare(`UPDATE employes_avances SET solde_restant = montant
              WHERE (solde_restant IS NULL OR solde_restant = 0) AND statut = 'en_cours'`).run();

  // ── Colonnes congés ───────────────────────────────────────
  addColumnIfMissing('employes_conges', 'annule_at',   'TEXT');
  addColumnIfMissing('employes_conges', 'annule_by',   'INTEGER');
  addColumnIfMissing('employes_conges', 'annule_motif','TEXT');
  addColumnIfMissing('employes_conges', 'updated_by',  'INTEGER');
  addColumnIfMissing('employes_conges', 'updated_at',  "TEXT DEFAULT (datetime('now'))");

  // ── Colonnes bulletins ────────────────────────────────────
  addColumnIfMissing('bulletins_salaire', 'annule_at',    'TEXT');
  addColumnIfMissing('bulletins_salaire', 'annule_by',    'INTEGER');
  addColumnIfMissing('bulletins_salaire', 'annule_motif', 'TEXT');

  // ── Index unicité pièce d'identité (partiel : ignore NULL et '') ──────────────
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_employes_num_piece
    ON employes(num_piece_identite)
    WHERE num_piece_identite IS NOT NULL AND num_piece_identite != ''
  `);

  // ── Table journal d'audit ─────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      record_id  INTEGER NOT NULL,
      action     TEXT NOT NULL,
      details    TEXT,
      user_id    INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_audit_table_record ON audit_logs(table_name, record_id);
    CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);
  `);

  // ── Table remboursements partiels avances ──────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS employes_avances_remboursements (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      avance_id  INTEGER NOT NULL,
      date       TEXT NOT NULL,
      montant    REAL NOT NULL DEFAULT 0,
      notes      TEXT,
      created_by INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (avance_id) REFERENCES employes_avances(id)
    );
  `);

  // ── Index unicité matricule ─────────────────────────────────
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_employes_matricule
    ON employes(matricule)
    WHERE matricule IS NOT NULL AND matricule != ''
  `);

  // ── Sous-rôle fonctionnel utilisateurs ──────────────────────
  addColumnIfMissing('users', 'sous_role', 'TEXT');

  // ── Retenue avance sur bulletin ─────────────────────────────
  addColumnIfMissing('bulletins_salaire', 'retenue_avance', 'REAL DEFAULT 0');
  addColumnIfMissing('bulletins_salaire', 'avance_id',      'INTEGER');
  addColumnIfMissing('bulletins_salaire', 'net_a_verser',   'REAL DEFAULT 0');
  // Initialiser net_a_verser = net_a_payer pour bulletins existants
  db.prepare(`UPDATE bulletins_salaire SET net_a_verser = net_a_payer
              WHERE (net_a_verser IS NULL OR net_a_verser = 0) AND net_a_payer > 0`).run();

  // ── Tables RH étendues ────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS employes_diplomes (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      employe_id       INTEGER NOT NULL,
      intitule         TEXT NOT NULL,
      etablissement    TEXT,
      pays             TEXT DEFAULT 'Congo-Brazzaville',
      annee_obtention  INTEGER,
      niveau           TEXT DEFAULT 'autre',
      observation      TEXT,
      created_at       TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (employe_id) REFERENCES employes(id)
    );

    CREATE TABLE IF NOT EXISTS employes_experiences (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      employe_id   INTEGER NOT NULL,
      poste        TEXT NOT NULL,
      entreprise   TEXT,
      date_debut   TEXT,
      date_fin     TEXT,
      type_contrat TEXT,
      description  TEXT,
      created_at   TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (employe_id) REFERENCES employes(id)
    );

    CREATE TABLE IF NOT EXISTS employes_avances (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      employe_id       INTEGER NOT NULL,
      date             TEXT NOT NULL,
      montant          REAL NOT NULL DEFAULT 0,
      motif            TEXT,
      statut           TEXT DEFAULT 'en_cours'
                       CHECK(statut IN ('en_cours','rembourse','annule')),
      nb_echeances     INTEGER DEFAULT 1,
      montant_echeance REAL DEFAULT 0,
      montant_rembourse REAL DEFAULT 0,
      notes            TEXT,
      created_by       INTEGER,
      created_at       TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (employe_id) REFERENCES employes(id)
    );

    CREATE TABLE IF NOT EXISTS employes_conges (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      employe_id   INTEGER NOT NULL,
      type_conge   TEXT DEFAULT 'annuel'
                   CHECK(type_conge IN ('annuel','maladie','maternite','paternite','sans_solde','autre')),
      date_debut   TEXT NOT NULL,
      date_fin     TEXT NOT NULL,
      nb_jours     INTEGER DEFAULT 0,
      motif        TEXT,
      statut       TEXT DEFAULT 'demande'
                   CHECK(statut IN ('demande','approuve','refuse','termine')),
      notes        TEXT,
      created_by   INTEGER,
      created_at   TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (employe_id) REFERENCES employes(id)
    );
  `);
}

init();
migrateExtendedSchema();
migrateDecaissementWorkflow();
module.exports = db;

// ─── Migration : workflow décaissement + solidité paie ────────────────────────
function migrateDecaissementWorkflow() {
  // Colonnes workflow sur operations
  addColumnIfMissing('operations', 'dec_statut',    'TEXT DEFAULT NULL');
  addColumnIfMissing('operations', 'submitted_by',  'INTEGER DEFAULT NULL');
  addColumnIfMissing('operations', 'submitted_at',  'TEXT DEFAULT NULL');
  addColumnIfMissing('operations', 'validated_by',  'INTEGER DEFAULT NULL');
  addColumnIfMissing('operations', 'validated_at',  'TEXT DEFAULT NULL');
  addColumnIfMissing('operations', 'paid_by',        'INTEGER DEFAULT NULL');
  addColumnIfMissing('operations', 'paid_at',        'TEXT DEFAULT NULL');
  addColumnIfMissing('operations', 'annule_by',      'INTEGER DEFAULT NULL');
  addColumnIfMissing('operations', 'annule_at',      'TEXT DEFAULT NULL');
  addColumnIfMissing('operations', 'annule_motif',   'TEXT DEFAULT NULL');
  addColumnIfMissing('operations', 'bulletin_id',    'INTEGER DEFAULT NULL');

  // Solidité paie : une seule opération liée par bulletin
  // Déduplication préventive : si un operation_id apparaît sur 2 bulletins,
  // on le retire du plus ancien (cas improbable mais on sécurise la migration)
  db.prepare(`
    UPDATE bulletins_salaire SET operation_id = NULL
    WHERE operation_id IS NOT NULL
      AND id NOT IN (
        SELECT MAX(id) FROM bulletins_salaire
        WHERE operation_id IS NOT NULL
        GROUP BY operation_id
      )
  `).run();
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bulletin_operation_id
    ON bulletins_salaire(operation_id)
    WHERE operation_id IS NOT NULL
  `);
}
