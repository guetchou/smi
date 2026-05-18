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

function tableExists(table) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}

function addColumnIfMissing(table, column, definition) {
  if (!tableExists(table)) return;
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
    ['cnss_employe_taux',  '4.725'],
    ['cnss_patron_taux',   '20'],
    ['camu_employe_taux',  '2.25'],
    ['camu_patron_taux',   '5'],
    // IRPP — tranches mensuelles (montants en XAF)
    ['irpp_plafond_t1',    '464000'],
    ['irpp_taux_t2',       '10'],
    ['irpp_plafond_t2',    '1000000'],
    ['irpp_taux_t3',       '25'],
    ['irpp_plafond_t3',    '3000000'],
    ['irpp_taux_t4',       '40'],
    // Numérotation automatique des pièces
    ['num_prefixe',        'TC-'],
    ['num_compteur',       '0'],
    ['num_auto',           '0'],
    // Modes de paiement — libellés personnalisables (actifs par défaut = 1)
    ['mode_active_especes',          '1'],
    ['mode_label_especes',           'Espèces / Caisse'],
    ['mode_active_cheque',           '1'],
    ['mode_label_cheque',            'Chèque'],
    ['mode_active_virement_bancaire','1'],
    ['mode_label_virement_bancaire', 'Virement bancaire'],
    ['mode_active_mobile_money',     '1'],
    ['mode_label_mobile_money',      'Mobile Money'],
    ['mode_active_compensation',     '1'],
    ['mode_label_compensation',      'Compensation'],
    ['mode_active_autres',           '1'],
    ['mode_label_autres',            'Autres'],
    // Motifs suggestions (séparés par |)
    ['motifs_enc', 'Recette prestation|Remboursement reçu|Avance client|Règlement facture|Subvention'],
    ['motifs_dec', 'Fournitures bureau|Frais de déplacement|Prestataire externe|Avance employé|Charges locatives|Frais communication'],
    // Rubriques paie custom (JSON)
    ['rubriques_custom', '[]'],
    // Types de documents RH (séparés par |)
    ['types_docs', 'contrat_travail|avenant|cni|passeport|diplome|attestation|lettre_embauche|fiche_poste|evaluation|discipline'],
    // Localisation
    ['loc_pays_defaut',    'CG'],
    ['loc_code_pays',      'CG'],
    ['loc_devise',         'XAF'],
    ['loc_libelle_devise', 'FCFA'],
    ['loc_indicatif',      '+242'],
    ['loc_fuseau_horaire', 'Africa/Brazzaville'],
    ['loc_format_date',    'DD/MM/YYYY'],
    ['loc_langue',         'fr'],
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
  addColumnIfMissing('employes', 'photo_url',   'TEXT');
  addColumnIfMissing('employes', 'updated_at',  'TEXT');
  addColumnIfMissing('users',    'photo_url', 'TEXT');

  // ── Dossier uploads (dans le volume Docker) ──────────────
  const uploadsDir = require('path').join(__dirname, 'data', 'uploads');
  if (!require('fs').existsSync(uploadsDir)) require('fs').mkdirSync(uploadsDir, { recursive: true });

  // (Colonnes avances déplacées après CREATE TABLE employes_avances ci-dessous)

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
  `);

  // ── Colonnes avances (après création de la table) ─────────
  addColumnIfMissing('employes_avances', 'solde_restant',  'REAL DEFAULT 0');
  addColumnIfMissing('employes_avances', 'annule_at',      'TEXT');
  addColumnIfMissing('employes_avances', 'annule_by',      'INTEGER');
  addColumnIfMissing('employes_avances', 'annule_motif',   'TEXT');
  addColumnIfMissing('employes_avances', 'updated_at',     "TEXT DEFAULT (datetime('now'))");
  // Initialiser solde_restant = montant pour les avances existantes en cours
  db.prepare(`UPDATE employes_avances SET solde_restant = montant
              WHERE (solde_restant IS NULL OR solde_restant = 0) AND statut = 'en_cours'`).run();

  db.exec(`

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
migrateUsersRoles();
migrateEntrepriseSchema();
migrateSessionsSchema();
migrateAchatsSchema();
migrateMultiRoles();
migrateNotificationsSchema();
migrateCloturePeriode();
migrateCategoriesActif();
migrateDecStatutHistorique();
migrateBulletinsCustom();
migrateCongesComplet();
migrateCongesWorkflow();
migrateOrganigramme();
migrateBulletinEnvois();
migrateCnss();
migrateDgi();
migrateGrillesSalariales();
migrateHistoriqueSalaires();
migratePeriodesPaieEtRH();
migrateAccessPermissionsErp();
migrateEmployesSortieDropUnique();
migrateCalendrierFiscal();
migrateFixLouvouezo();
module.exports = db;

function migrateFixLouvouezo() {
  const bcrypt = require('bcryptjs');

  // Supprimer les opérations de test injectées le 2026-05-15
  db.prepare(`
    DELETE FROM operations
    WHERE libelle LIKE 'TEST_%' AND created_at >= '2026-05-15'
  `).run();

  // Mettre à jour l'email professionnel si la colonne existe déjà
  const cols = db.prepare("PRAGMA table_info(employes)").all().map(c => c.name);
  if (cols.includes('email_professionnel')) {
    db.prepare(`
      UPDATE employes
      SET email_professionnel = 'princilia.louvouezo@topcenter.cg'
      WHERE nom = 'LOUVOUEZO' AND (email_professionnel IS NULL OR email_professionnel = '')
    `).run();
  }

  // Créer le compte utilisateur LOUVOUEZO si absent
  const existing = db.prepare(
    "SELECT id FROM users WHERE email = 'princilia.louvouezo@topcenter.cg'"
  ).get();
  if (!existing) {
    const employe = db.prepare(
      "SELECT id FROM employes WHERE nom = 'LOUVOUEZO'"
    ).get();
    const hash = bcrypt.hashSync('Topcenter2024!', 10);
    db.prepare(`
      INSERT INTO users (nom, email, password_hash, role, actif, must_change_password, employe_id, created_at)
      VALUES ('LOUVOUEZO Dieuveille', 'princilia.louvouezo@topcenter.cg', ?, 'caissier', 1, 1, ?, datetime('now'))
    `).run(hash, employe?.id || null);
  }
}

function migrateAccessPermissionsErp() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      libelle TEXT NOT NULL,
      description TEXT,
      system INTEGER NOT NULL DEFAULT 1,
      actif INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      module TEXT NOT NULL,
      action TEXT NOT NULL,
      libelle TEXT NOT NULL,
      description TEXT,
      sensitive INTEGER NOT NULL DEFAULT 0,
      actif INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS profile_permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id),
      permission_id INTEGER NOT NULL REFERENCES permissions(id),
      allowed INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(profile_id, permission_id)
    );
    CREATE TABLE IF NOT EXISTS user_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      profile_id INTEGER NOT NULL REFERENCES profiles(id),
      active INTEGER NOT NULL DEFAULT 1,
      source TEXT NOT NULL DEFAULT 'manual',
      expires_at TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, profile_id)
    );
    CREATE TABLE IF NOT EXISTS user_permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      permission_id INTEGER NOT NULL REFERENCES permissions(id),
      allowed INTEGER NOT NULL DEFAULT 1,
      active INTEGER NOT NULL DEFAULT 1,
      reason TEXT,
      amount_limit REAL,
      expires_at TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, permission_id)
    );
    CREATE TABLE IF NOT EXISTS delegations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      delegator_id INTEGER NOT NULL REFERENCES users(id),
      delegate_id INTEGER NOT NULL REFERENCES users(id),
      permission_id INTEGER REFERENCES permissions(id),
      profile_id INTEGER REFERENCES profiles(id),
      scope_module TEXT,
      amount_limit REAL,
      starts_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      reason TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS permission_audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_user_id INTEGER REFERENCES users(id),
      target_user_id INTEGER REFERENCES users(id),
      table_name TEXT NOT NULL,
      record_id INTEGER,
      action TEXT NOT NULL,
      details TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS departments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      libelle TEXT NOT NULL,
      parent_id INTEGER REFERENCES departments(id),
      manager_employee_id INTEGER REFERENCES employes(id),
      actif INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS organization_units (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      libelle TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'department',
      parent_id INTEGER REFERENCES organization_units(id),
      department_id INTEGER REFERENCES departments(id),
      manager_employee_id INTEGER REFERENCES employes(id),
      actif INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS employee_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employe_id INTEGER NOT NULL REFERENCES employes(id),
      organization_unit_id INTEGER REFERENCES organization_units(id),
      department_id INTEGER REFERENCES departments(id),
      position_title TEXT NOT NULL,
      assignment_type TEXT NOT NULL DEFAULT 'primary',
      classification TEXT,
      category TEXT,
      level TEXT,
      manager_hierarchical_id INTEGER REFERENCES employes(id),
      manager_functional_id INTEGER REFERENCES employes(id),
      interim_for_employee_id INTEGER REFERENCES employes(id),
      starts_at TEXT NOT NULL DEFAULT (date('now')),
      ends_at TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_user_profiles_user ON user_profiles(user_id, active);
    CREATE INDEX IF NOT EXISTS idx_user_permissions_user ON user_permissions(user_id, active);
    CREATE INDEX IF NOT EXISTS idx_delegations_delegate ON delegations(delegate_id, active, starts_at, expires_at);
    CREATE INDEX IF NOT EXISTS idx_employee_assignments_emp ON employee_assignments(employe_id, active);
  `);

  const profiles = [
    ['admin','Administrateur technique'], ['dg','Direction Générale'], ['assistante_direction','Assistante de Direction'],
    ['rh','Ressources Humaines'], ['finance','Finance / Comptabilité'], ['caissier','Caisse'],
    ['chargee_projet','Chargée de Projet'], ['commercial_marketing','Commercial & Marketing'],
    ['manager_technique','Manager Technique'], ['superviseur_callcenter','Superviseur Call Center'],
    ['assistant_it','Assistant IT'], ['agent_commercial','Agent Commercial'], ['agent_callcenter','Agent Call Center'],
    ['moyens_generaux','Moyens Généraux'], ['achats_logistique','Achats / Logistique'],
    ['technicien_surface','Technicien de Surface'], ['stagiaire','Stagiaire'], ['audit_controle','Audit / Contrôle'],
    ['lecteur','Lecture seule']
  ];
  const insProfile = db.prepare('INSERT OR IGNORE INTO profiles (code, libelle) VALUES (?,?)');
  profiles.forEach(p => insProfile.run(...p));

  const perms = [
    ['access.manage','access','manage','Gérer les accès',1], ['access.profile.manage','access','profile.manage','Gérer les profils',1],
    ['access.permission.manage','access','permission.manage','Gérer les permissions',1], ['access.delegation.manage','access','delegation.manage','Gérer les délégations',1],
    ['settings.manage','settings','manage','Gérer les paramètres',1], ['audit.view','audit','view','Voir audit',1], ['notification.manage','notification','manage','Gérer notifications',0],
    ['org.view','org','view','Voir organigramme',0], ['org.department.create','org','department.create','Créer département',0], ['org.department.update','org','department.update','Modifier département',0],
    ['org.position.create','org','position.create','Créer poste',0], ['org.position.update','org','position.update','Modifier poste',0], ['org.assignment.manage','org','assignment.manage','Gérer affectations',0], ['org.hierarchy.manage','org','hierarchy.manage','Gérer hiérarchie',1],
    ['cash.in.create','cash','in.create','Créer encaissement',0], ['cash.in.validate','cash','in.validate','Valider encaissement',1], ['cash.out.create','cash','out.create','Créer décaissement',0], ['cash.out.submit','cash','out.submit','Soumettre décaissement',0], ['cash.out.validate','cash','out.validate','Valider décaissement',1], ['cash.out.pay','cash','out.pay','Payer décaissement',1], ['cash.out.cancel','cash','out.cancel','Annuler décaissement',1], ['cash.report.view','cash','report.view','Voir rapports caisse',0],
    ['salary.view','salary','view','Voir salaires',1], ['salary.generate','salary','generate','Générer bulletins',1], ['salary.edit','salary','edit','Modifier bulletins',1], ['salary.edit_primes','salary','edit_primes','Modifier primes',1], ['salary.validate_bulletin','salary','validate_bulletin','Valider bulletins',1], ['salary.submit_to_dg','salary','submit_to_dg','Soumettre au DG',1], ['salary.approve_period_dg','salary','approve_period_dg','Valider période DG',1], ['salary.pay','salary','pay','Payer salaires',1], ['salary.cancel_validation','salary','cancel_validation','Annuler validation',1], ['salary.report.view','salary','report.view','Voir rapports paie',1],
    ['hr.agent.create','hr','agent.create','Créer agent',1], ['hr.agent.update','hr','agent.update','Modifier agent',1], ['hr.agent.archive','hr','agent.archive','Archiver agent',1], ['hr.salary_base.change','hr','salary_base.change','Modifier salaire base',1], ['hr.contract.manage','hr','contract.manage','Gérer contrats',1], ['hr.leave.approve','hr','leave.approve','Approuver congés',1], ['hr.discipline.manage','hr','discipline.manage','Gérer discipline',1], ['hr.offboarding.manage','hr','offboarding.manage','Gérer sorties',1], ['hr.classification.manage','hr','classification.manage','Gérer classification',1], ['hr.training.manage','hr','training.manage','Gérer formations',0],
    ['purchase.create','purchase','create','Créer achat',0], ['purchase.submit','purchase','submit','Soumettre achat',0], ['purchase.validate','purchase','validate','Valider achat',1], ['purchase.pay','purchase','pay','Payer achat',1], ['purchase.cancel','purchase','cancel','Annuler achat',1], ['supplier.manage','purchase','supplier.manage','Gérer fournisseurs',0], ['stock.manage','purchase','stock.manage','Gérer stock',0], ['assets.manage','purchase','assets.manage','Gérer parc matériel',0], ['logistics.manage','purchase','logistics.manage','Gérer logistique',0], ['vehicle.manage','purchase','vehicle.manage','Gérer véhicules',0], ['maintenance.manage','purchase','maintenance.manage','Gérer maintenance',0],
    ['commercial.client.manage','commercial','client.manage','Gérer clients',0], ['commercial.prospect.manage','commercial','prospect.manage','Gérer prospects',0], ['commercial.quote.create','commercial','quote.create','Créer devis',0], ['commercial.quote.validate','commercial','quote.validate','Valider devis',1], ['commercial.invoice.create','commercial','invoice.create','Créer factures',0], ['commercial.invoice.followup','commercial','invoice.followup','Suivre factures',0], ['marketing.campaign.manage','commercial','campaign.manage','Gérer campagnes',0], ['sales.report.view','commercial','report.view','Voir rapports ventes',0],
    ['project.manage','project','manage','Gérer projets',0], ['project.report.view','project','report.view','Voir rapports projets',0], ['callcenter.agent.view','callcenter','agent.view','Voir agents call center',0], ['callcenter.report.view','callcenter','report.view','Voir rapports call center',0], ['callcenter.campaign.manage','callcenter','campaign.manage','Gérer campagnes call center',0], ['callcenter.quality.manage','callcenter','quality.manage','Gérer qualité call center',0], ['callcenter.performance.view','callcenter','performance.view','Voir performance call center',0],
    ['technical.incident.manage','technical','incident.manage','Gérer incidents',0], ['technical.asset.manage','technical','asset.manage','Gérer assets techniques',0], ['technical.network.manage','technical','network.manage','Gérer réseau',1], ['technical.purchase.request','technical','purchase.request','Demande achat technique',0], ['technical.report.view','technical','report.view','Voir rapports techniques',0]
  ];
  const insPerm = db.prepare('INSERT OR IGNORE INTO permissions (code,module,action,libelle,sensitive) VALUES (?,?,?,?,?)');
  perms.forEach(p => insPerm.run(...p));

  const departments = [
    ['direction_generale','Direction Générale'], ['support_administration','Support & Administration'],
    ['ressources_humaines','Ressources Humaines'], ['finance_comptabilite_caisse','Finance / Comptabilité / Caisse'],
    ['commercial_marketing','Commercial & Marketing'], ['operations_callcenter_projets','Opérations / Call Center / Projets'],
    ['technique_infrastructure','Technique & Infrastructure'], ['moyens_generaux','Moyens Généraux'],
    ['audit_controle_conformite','Audit / Contrôle / Conformité']
  ];
  const insDept = db.prepare('INSERT OR IGNORE INTO departments (code, libelle) VALUES (?,?)');
  const insUnit = db.prepare("INSERT OR IGNORE INTO organization_units (code, libelle, type, department_id) VALUES (?,?,'department',(SELECT id FROM departments WHERE code=?))");
  departments.forEach(([code, libelle]) => { insDept.run(code, libelle); insUnit.run(code, libelle, code); });

  const grant = db.prepare(`INSERT OR IGNORE INTO profile_permissions (profile_id, permission_id, allowed)
    SELECT p.id, pm.id, 1 FROM profiles p, permissions pm WHERE p.code=? AND pm.code=?`);
  const grantMany = (profile, codes) => codes.forEach(code => grant.run(profile, code));
  const all = perms.map(p => p[0]);
  grantMany('admin', all);
  grantMany('dg', all.filter(c => !c.startsWith('technical.network')));
  grantMany('rh', all.filter(c => c.startsWith('hr.') || c.startsWith('org.') || c.startsWith('salary.') || c === 'audit.view'));
  grantMany('finance', all.filter(c => c.startsWith('cash.') || c.startsWith('salary.') || c.startsWith('purchase.') || c.endsWith('report.view') || c === 'audit.view'));
  grantMany('caissier', ['cash.in.create','cash.out.pay','cash.report.view','salary.pay','salary.view']);
  grantMany('assistante_direction', ['cash.in.create','cash.out.create','cash.out.submit','cash.report.view','salary.view','salary.generate','salary.submit_to_dg','hr.agent.create','hr.agent.update','supplier.manage','stock.manage','logistics.manage','org.view']);
  grantMany('chargee_projet', ['project.manage','project.report.view','commercial.client.manage','commercial.prospect.manage','callcenter.campaign.manage','callcenter.performance.view','org.view']);
  grantMany('commercial_marketing', all.filter(c => c.startsWith('commercial.') || c.startsWith('marketing.') || c === 'sales.report.view'));
  grantMany('manager_technique', all.filter(c => c.startsWith('technical.') || c === 'purchase.create'));
  grantMany('superviseur_callcenter', all.filter(c => c.startsWith('callcenter.') || c === 'project.report.view'));
  grantMany('assistant_it', ['technical.incident.manage','technical.asset.manage','technical.report.view']);
  grantMany('agent_commercial', ['commercial.client.manage','commercial.prospect.manage','commercial.quote.create']);
  grantMany('agent_callcenter', ['callcenter.agent.view','callcenter.campaign.manage']);
  grantMany('moyens_generaux', ['supplier.manage','stock.manage','assets.manage','logistics.manage','vehicle.manage','maintenance.manage','purchase.create','purchase.submit']);
  grantMany('achats_logistique', ['purchase.create','purchase.submit','purchase.validate','supplier.manage','stock.manage','assets.manage','logistics.manage']);
  grantMany('audit_controle', ['audit.view','cash.report.view','salary.report.view','sales.report.view','project.report.view','technical.report.view','org.view']);
  grantMany('lecteur', ['org.view','cash.report.view','salary.report.view','sales.report.view','project.report.view','technical.report.view']);

  const sync = db.prepare(`INSERT OR IGNORE INTO user_profiles (user_id, profile_id, source)
    SELECT ?, id, 'legacy_role' FROM profiles WHERE code=?`);
  db.prepare('SELECT id, role, roles FROM users WHERE actif=1').all().forEach(u => {
    let roles = [u.role];
    try { roles = u.roles ? JSON.parse(u.roles) : [u.role]; } catch {}
    [...new Set([u.role, ...roles].filter(Boolean))].forEach(role => sync.run(u.id, role));
  });
}

// Supprime la contrainte UNIQUE sur employes_sortie.employe_id pour permettre la réembauche.
// SQLite ne supporte pas ALTER TABLE DROP CONSTRAINT — recréation de la table.
function migrateEmployesSortieDropUnique() {
  try {
    // Vérifier si la contrainte UNIQUE existe encore (via sqlite_master)
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='employes_sortie'").get();
    if (!sql || !sql.sql.includes('UNIQUE')) return; // déjà migré
    db.transaction(() => {
      db.prepare(`CREATE TABLE IF NOT EXISTS employes_sortie_v2 (
        id                        INTEGER PRIMARY KEY AUTOINCREMENT,
        employe_id                INTEGER NOT NULL REFERENCES employes(id),
        type_sortie               TEXT NOT NULL DEFAULT 'demission'
                                  CHECK(type_sortie IN (
                                    'demission','licenciement','retraite',
                                    'fin_contrat','deces','rupture_conventionnelle'
                                  )),
        date_annonce              TEXT,
        date_fin_preavis          TEXT,
        date_depart_effectif      TEXT,
        anciennete_annees         REAL NOT NULL DEFAULT 0,
        indemnite_licenciement    REAL NOT NULL DEFAULT 0,
        indemnite_preavis         REAL NOT NULL DEFAULT 0,
        conges_payes_restants     REAL NOT NULL DEFAULT 0,
        conges_payes_montant      REAL NOT NULL DEFAULT 0,
        autres_indemnites         REAL NOT NULL DEFAULT 0,
        solde_tout_compte_total   REAL NOT NULL DEFAULT 0,
        statut                    TEXT NOT NULL DEFAULT 'initie'
                                  CHECK(statut IN ('initie','calcule','valide','solde')),
        checklist_materiel        TEXT,
        checklist_acces           TEXT,
        notes                     TEXT,
        created_by                INTEGER REFERENCES users(id),
        validated_by              INTEGER REFERENCES users(id),
        validated_at              TEXT,
        created_at                TEXT DEFAULT (datetime('now')),
        updated_at                TEXT DEFAULT (datetime('now'))
      )`).run();
      db.prepare(`INSERT OR IGNORE INTO employes_sortie_v2 SELECT * FROM employes_sortie`).run();
      db.prepare(`DROP TABLE employes_sortie`).run();
      db.prepare(`ALTER TABLE employes_sortie_v2 RENAME TO employes_sortie`).run();
    })();
  } catch (e) {
    console.error('[DB] migrateEmployesSortieDropUnique:', e.message);
  }
}

// ─── Migration : Calendrier Fiscal & CNSS ─────────────────────────────────────
function migrateCalendrierFiscal() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS calendrier_fiscal (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      annee            INTEGER NOT NULL,
      type_obligation  TEXT    NOT NULL
                       CHECK(type_obligation IN (
                         'CNSS_TRIMESTRE',
                         'DGI_MENSUEL',
                         'IS_ACOMPTE',
                         'DAS_ANNUELLE',
                         'DECLARATION_STAT'
                       )),
      periode_libelle  TEXT    NOT NULL,
      date_echeance    TEXT    NOT NULL,
      statut           TEXT    NOT NULL DEFAULT 'a_faire'
                       CHECK(statut IN ('a_faire','en_cours','depose','paye','en_retard','non_applicable')),
      ref_cnss_id      INTEGER REFERENCES cnss_declarations(id),
      ref_dgi_id       INTEGER REFERENCES dgi_declarations(id),
      montant_du       REAL    DEFAULT 0,
      notes            TEXT,
      rappels_ids      TEXT    DEFAULT '[]',
      created_at       TEXT    DEFAULT (datetime('now')),
      updated_at       TEXT    DEFAULT (datetime('now')),
      UNIQUE(annee, type_obligation, periode_libelle)
    );
    CREATE INDEX IF NOT EXISTS idx_cal_fiscal_annee
      ON calendrier_fiscal(annee DESC, date_echeance ASC);
    CREATE INDEX IF NOT EXISTS idx_cal_fiscal_statut
      ON calendrier_fiscal(statut, date_echeance ASC);
    CREATE INDEX IF NOT EXISTS idx_cal_fiscal_type
      ON calendrier_fiscal(type_obligation, annee DESC);
  `);

  const insp = db.prepare("INSERT OR IGNORE INTO parametres (cle, valeur) VALUES (?, ?)");
  insp.run('fiscal_cnss_mode',       'trimestriel');
  insp.run('fiscal_dgi_mode',        'mensuel');
  insp.run('fiscal_is_actif',        '1');
  insp.run('fiscal_das_actif',       '1');
  insp.run('fiscal_decl_stat_actif', '1');
  insp.run('fiscal_annee_courante',  String(new Date().getFullYear()));

  const insRegle = db.prepare(`
    INSERT OR IGNORE INTO notif_regles
      (type, famille, priorite_defaut, libelle,
       canal_inapp, canal_email, canal_push, canal_son,
       roles_dest, escalade_delai_h, escalade_roles, grace_h, params)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  insRegle.run(
    'RAP_CNSS_TRIMESTRE', 'rappel', 'critique',
    'Échéance cotisations CNSS trimestrielles',
    1, 1, 1, 1,
    '["dg","admin","finance","rh"]',
    48, '["dg","admin"]', 0,
    JSON.stringify({ delais_j: [-15, -7, -3, -1] })
  );
  insRegle.run(
    'RAP_DGI_MENSUEL', 'rappel', 'critique',
    'Échéance déclaration et versement IRPP mensuel (DGI)',
    1, 1, 1, 1,
    '["dg","admin","finance"]',
    48, '["dg","admin"]', 0,
    JSON.stringify({ delais_j: [-5, -3, -1] })
  );
  insRegle.run(
    'RAP_IS_ACOMPTE', 'rappel', 'critique',
    "Acompte provisionnel IS (Impôt sur les Sociétés)",
    1, 1, 1, 1,
    '["dg","admin","finance"]',
    72, '["dg","admin"]', 0,
    JSON.stringify({ delais_j: [-30, -15, -7, -1] })
  );
  insRegle.run(
    'RAP_DAS_ANNUELLE', 'rappel', 'critique',
    "Déclaration Annuelle des Salaires (DAS) — DGI",
    1, 1, 1, 1,
    '["dg","admin","finance","rh"]',
    72, '["dg","admin"]', 0,
    JSON.stringify({ delais_j: [-60, -30, -15, -7, -1] })
  );
  insRegle.run(
    'RAP_DECLARATION_STAT', 'rappel', 'avertissement',
    'Déclaration statistique annuelle (CNSEE / SCPK)',
    1, 1, 0, 0,
    '["dg","admin","finance"]',
    24, '["dg","admin"]', 0,
    JSON.stringify({ delais_j: [-30, -7] })
  );

  // Mise à jour si déjà existantes
  const updRegle = db.prepare(`
    UPDATE notif_regles
    SET libelle=?, roles_dest=?, params=?, updated_at=datetime('now')
    WHERE type=?
  `);
  updRegle.run('Échéance cotisations CNSS trimestrielles',
    '["dg","admin","finance","rh"]', JSON.stringify({ delais_j: [-15,-7,-3,-1] }), 'RAP_CNSS_TRIMESTRE');
  updRegle.run('Échéance déclaration et versement IRPP mensuel (DGI)',
    '["dg","admin","finance"]', JSON.stringify({ delais_j: [-5,-3,-1] }), 'RAP_DGI_MENSUEL');
  updRegle.run("Acompte provisionnel IS (Impôt sur les Sociétés)",
    '["dg","admin","finance"]', JSON.stringify({ delais_j: [-30,-15,-7,-1] }), 'RAP_IS_ACOMPTE');
  updRegle.run("Déclaration Annuelle des Salaires (DAS) — DGI",
    '["dg","admin","finance","rh"]', JSON.stringify({ delais_j: [-60,-30,-15,-7,-1] }), 'RAP_DAS_ANNUELLE');
  updRegle.run('Déclaration statistique annuelle (CNSEE / SCPK)',
    '["dg","admin","finance"]', JSON.stringify({ delais_j: [-30,-7] }), 'RAP_DECLARATION_STAT');
}

// A1 — Colonne actif sur categories (soft-delete)
function migrateCategoriesActif() {
  addColumnIfMissing('categories', 'actif', 'INTEGER DEFAULT 1');
  // Toutes les catégories existantes sont actives par défaut
  db.prepare("UPDATE categories SET actif = 1 WHERE actif IS NULL").run();
}

// A2 — Initialiser dec_statut sur les décaissements existants
function migrateDecStatutHistorique() {
  // Les décaissements valides sont "paye" dans l'ancien système (pas de workflow)
  db.prepare(`
    UPDATE operations
    SET dec_statut = 'paye'
    WHERE type_op = 'decaissement'
      AND statut  = 'valide'
      AND dec_statut IS NULL
  `).run();
  // Les annulés
  db.prepare(`
    UPDATE operations
    SET dec_statut = 'annule'
    WHERE type_op  = 'decaissement'
      AND statut   = 'annule'
      AND dec_statut IS NULL
  `).run();
  // Les en_attente sans dec_statut → brouillon
  db.prepare(`
    UPDATE operations
    SET dec_statut = 'brouillon'
    WHERE type_op = 'decaissement'
      AND dec_statut IS NULL
  `).run();
}

// A3 — Colonnes manquantes sur bulletins_salaire
function migrateBulletinsCustom() {
  addColumnIfMissing('bulletins_salaire', 'lignes_custom',   "TEXT DEFAULT '[]'");
  addColumnIfMissing('bulletins_salaire', 'decharge_signee', 'INTEGER DEFAULT 0');
}

// B1 — Colonnes solde congés sur employes + traçabilité sur employes_conges
function migrateCongesComplet() {
  // Solde congés sur employes
  addColumnIfMissing('employes', 'conges_acquis_annuel', 'REAL DEFAULT 0');
  addColumnIfMissing('employes', 'conges_pris_annuel',   'REAL DEFAULT 0');
  addColumnIfMissing('employes', 'conges_solde_annuel',  'REAL DEFAULT 0');
  addColumnIfMissing('employes', 'conges_report_n1',     'REAL DEFAULT 0');

  // Traçabilité approbateur/refus sur employes_conges
  addColumnIfMissing('employes_conges', 'approuve_par',  'INTEGER');
  addColumnIfMissing('employes_conges', 'approuve_at',   'TEXT');
  addColumnIfMissing('employes_conges', 'refuse_par',    'INTEGER');
  addColumnIfMissing('employes_conges', 'refuse_at',     'TEXT');
  addColumnIfMissing('employes_conges', 'refuse_motif',  'TEXT');
  addColumnIfMissing('employes_conges', 'annule_statut', 'TEXT');

  // Paramètres congés (INSERT OR IGNORE pour ne pas écraser les valeurs existantes)
  const insParam = db.prepare("INSERT OR IGNORE INTO parametres (cle, valeur) VALUES (?, ?)");
  insParam.run('conges_jours_par_mois',    '2.5');
  insParam.run('conges_report_max_jours',  '15');
  insParam.run('conges_preavis_min_jours', '3');
  insParam.run('conges_email_demandeur',   '1');

  // Index performance
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_conges_employe_annee
      ON employes_conges(employe_id, date_debut);
    CREATE INDEX IF NOT EXISTS idx_conges_statut_date
      ON employes_conges(statut, date_debut);
  `);

  // Recalculer les soldes existants à partir des données réelles
  _recalculerSoldesCongesAll();
}

function _recalculerSoldesCongesAll() {
  const annee = new Date().getFullYear().toString();
  const employes = db.prepare("SELECT id FROM employes WHERE actif = 1").all();
  const updEmp = db.prepare(`
    UPDATE employes
    SET conges_pris_annuel  = ?,
        conges_solde_annuel = conges_acquis_annuel + conges_report_n1 - ?
    WHERE id = ?
  `);
  const tx = db.transaction(() => {
    for (const e of employes) {
      const row = db.prepare(`
        SELECT COALESCE(SUM(nb_jours), 0) as pris
        FROM employes_conges
        WHERE employe_id = ?
          AND type_conge = 'annuel'
          AND statut IN ('approuve', 'termine')
          AND strftime('%Y', date_debut) = ?
      `).get(e.id, annee);
      updEmp.run(row.pris, row.pris, e.id);
    }
  });
  tx();
}

function migrateCloturePeriode() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS periodes_clôturees (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      annee      INTEGER NOT NULL,
      mois       INTEGER NOT NULL,
      cloture_by INTEGER REFERENCES users(id),
      cloture_at TEXT DEFAULT (datetime('now')),
      notes      TEXT,
      UNIQUE(annee, mois)
    );
    CREATE INDEX IF NOT EXISTS idx_periodes_cloturees ON periodes_clôturees(annee, mois);
  `);
}

// ─── Migration : module notifications / rappels / alertes ────────────────────
function migrateNotificationsSchema() {
  // ── 1. notif_regles : configuration par type (seed immuable) ─────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS notif_regles (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      type             TEXT    NOT NULL UNIQUE,
      famille          TEXT    NOT NULL CHECK(famille IN ('notification','rappel','alerte')),
      priorite_defaut  TEXT    NOT NULL DEFAULT 'info'
                       CHECK(priorite_defaut IN ('info','avertissement','critique','bloquant')),
      libelle          TEXT    NOT NULL,
      actif            INTEGER NOT NULL DEFAULT 1,
      canal_inapp      INTEGER NOT NULL DEFAULT 1,
      canal_email      INTEGER NOT NULL DEFAULT 0,
      canal_push       INTEGER NOT NULL DEFAULT 0,
      canal_son        INTEGER NOT NULL DEFAULT 0,
      roles_dest       TEXT    NOT NULL DEFAULT '["admin"]',
      escalade_delai_h INTEGER,
      escalade_roles   TEXT,
      grace_h          INTEGER DEFAULT 24,
      params           TEXT    NOT NULL DEFAULT '{}',
      created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_notifregles_famille
      ON notif_regles(famille, actif);
  `);

  // Seed des règles — INSERT OR IGNORE : idempotent, jamais d'écrasement
  const seedRegles = db.prepare(`
    INSERT OR IGNORE INTO notif_regles
      (type, famille, priorite_defaut, libelle,
       canal_inapp, canal_email, canal_push, canal_son,
       roles_dest, escalade_delai_h, escalade_roles, grace_h, params)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const txRegles = db.transaction(() => {
    // ── Notifications ────────────────────────────────────────────────────────
    seedRegles.run('NOTIF_OP_CREE',            'notification','info',
      'Opération créée',                        1,0,0,0,
      '["dg","admin","finance","caissier"]',     null,null, 24,'{}');
    seedRegles.run('NOTIF_OP_ANNULE',          'notification','avertissement',
      'Opération annulée',                       1,0,0,0,
      '["admin","finance","caissier"]',          null,null, 24,'{}');
    seedRegles.run('NOTIF_BULLETIN_VALIDE',    'notification','info',
      'Bulletin validé',                         1,0,0,0,
      '["admin","rh"]',                          null,null, 24,'{}');
    seedRegles.run('NOTIF_BULLETIN_PAYE',      'notification','info',
      'Bulletin payé',                           1,1,0,0,
      '["admin","rh"]',                          null,null, 24,'{}');
    seedRegles.run('NOTIF_PERIODE_PAIE',       'notification','avertissement',
      'Masse salariale soumise à validation DG', 1,1,0,0,
      '["dg","admin"]',                          null,null, 24,'{}');
    seedRegles.run('NOTIF_ACHAT_APPROUVE',     'notification','info',
      'Demande d\'achat approuvée',              1,1,0,0,
      '["dg","admin","finance"]',                null,null, 24,'{}');
    seedRegles.run('NOTIF_ACHAT_REJETE',       'notification','avertissement',
      'Demande d\'achat rejetée',                1,1,0,0,
      '["dg","admin"]',                          null,null, 24,'{}');
    seedRegles.run('NOTIF_ACHAT_SOUMIS',       'notification','avertissement',
      'Demande d\'achat soumise à approbation',  1,1,0,0,
      '["dg","admin","assistante_direction"]',  null,null, 24,'{}');
    seedRegles.run('NOTIF_CONGE_APPROUVE',     'notification','info',
      'Congé approuvé',                          1,0,0,0,
      '["dg","admin","rh"]',                     null,null, 24,'{}');
    seedRegles.run('NOTIF_CONGE_REFUSE',       'notification','avertissement',
      'Congé refusé',                            1,0,0,0,
      '["dg","admin","rh"]',                     null,null, 24,'{}');
    seedRegles.run('NOTIF_USER_CREE',          'notification','info',
      'Utilisateur créé',                        1,0,0,0,
      '["admin"]',                               null,null, 24,'{}');
    seedRegles.run('NOTIF_USER_DESACTIVE',     'notification','avertissement',
      'Utilisateur désactivé',                   1,0,0,0,
      '["admin"]',                               null,null, 24,'{}');
    seedRegles.run('NOTIF_SMTP_ECHEC',         'notification','avertissement',
      'Échec envoi email',                       1,0,0,0,
      '["admin"]',                               null,null, 24,'{}');
    seedRegles.run('NOTIF_IMPORT_OK',          'notification','info',
      'Import Excel terminé',                    1,0,0,0,
      '["admin"]',                               null,null, 24,'{}');
    seedRegles.run('NOTIF_IMPORT_ERREUR',      'notification','critique',
      'Import Excel échoué',                     1,1,0,0,
      '["admin"]',                               null,null, 24,'{}');
    // ── Rappels ──────────────────────────────────────────────────────────────
    seedRegles.run('RAP_SALAIRE_MENSUEL',      'rappel','avertissement',
      'Préparer les bulletins du mois',          1,1,0,0,
      '["admin","rh"]',                          24,'["admin"]',
      24,'{"delais_j":[-10,-5,-1],"seuil_cle":"jour_budget"}');
    seedRegles.run('RAP_CONTRAT_FIN',          'rappel','critique',
      'Fin de contrat à venir',                  1,1,0,0,
      '["admin","rh"]',                          24,'["admin"]',
      24,'{"delais_j":[-30,-15,-7,-1]}');
    seedRegles.run('RAP_ESSAI_FIN',            'rappel','avertissement',
      'Fin de période d\'essai',                 1,0,0,0,
      '["admin","rh"]',                          null,null,
      24,'{"delais_j":[-7,-3,-1]}');
    seedRegles.run('RAP_DOCUMENT_EXPIRATION',  'rappel','avertissement',
      'Document identité/contrat expirant',      1,0,0,0,
      '["admin","rh"]',                          null,null,
      24,'{"delais_j":[-60,-30,-7]}');
    seedRegles.run('RAP_RETRAITE',             'rappel','info',
      'Âge de retraite approchant',              1,0,0,0,
      '["admin","rh"]',                          null,null,
      24,'{"delais_j":[-730,-365,-180]}');
    seedRegles.run('RAP_AVANCE_ECHEANCE',      'rappel','avertissement',
      'Échéance remboursement avance',           1,0,0,0,
      '["admin","rh","finance"]',                null,null,
      24,'{"delais_j":[-3,-1]}');
    seedRegles.run('RAP_BUDGET_DEPASSE',       'rappel','avertissement',
      'Budget mensuel dépassé',                  1,0,0,0,
      '["admin","finance"]',                     null,null,
      24,'{"seuils_pct":[80,100]}');
    seedRegles.run('RAP_ACHAT_SOUMIS_SANS_SUITE','rappel','avertissement',
      'Demande d\'achat sans suite',             1,1,0,0,
      '["admin","dg"]',                          24,'["admin"]',
      24,'{"delais_h":[48,72]}');
    // ── Alertes ──────────────────────────────────────────────────────────────
    seedRegles.run('ALRT_SOLDE_AVERTISSEMENT', 'alerte','avertissement',
      'Solde position sous seuil d\'alerte',     1,0,0,1,
      '["dg","admin","finance","caissier"]',     null,null,
      0,'{"seuil_cle":"seuil_alerte"}');
    seedRegles.run('ALRT_SOLDE_CRITIQUE',      'alerte','critique',
      'Solde position sous seuil critique',      1,1,0,1,
      '["dg","admin","finance","caissier"]',     120,'["dg","admin"]',
      0,'{"seuil_cle":"seuil_critique"}');
    seedRegles.run('ALRT_SOLDE_NEGATIF',       'alerte','bloquant',
      'Solde position négatif — décaissements bloqués', 1,1,0,1,
      '["dg","admin","finance"]',                30,'["dg","admin"]',
      0,'{}');
    seedRegles.run('ALRT_DEC_SOUMIS',          'alerte','avertissement',
      'Décaissement soumis en attente de validation', 1,1,0,0,
      '["dg","admin","finance"]',                48,'["dg","admin"]',
      0,'{"delai_h_cle":"alrt_dec_valid_h"}');
    seedRegles.run('ALRT_DEC_VALIDE_NON_PAYE', 'alerte','avertissement',
      'Décaissement validé non payé',            1,0,0,0,
      '["dg","admin","finance","caissier"]',     null,null,
      0,'{"delai_h_cle":"alrt_dec_paiement_h"}');
    seedRegles.run('ALRT_AVANCE_EN_SOUFFRANCE','alerte','critique',
      'Avance salariale en souffrance',          1,0,0,0,
      '["admin","rh","finance"]',                48,'["admin"]',
      0,'{}');
    seedRegles.run('ALRT_CONTRAT_EXPIRE',      'alerte','critique',
      'Contrat expiré — agent non sorti',        1,0,0,0,
      '["admin","rh"]',                          null,null,
      0,'{}');
    seedRegles.run('ALRT_DOCUMENT_EXPIRE',     'alerte','avertissement',
      'Document identité expiré',                1,0,0,0,
      '["admin","rh"]',                          null,null,
      0,'{}');
    seedRegles.run('ALRT_SMTP_HORS_SERVICE',   'alerte','critique',
      'Serveur SMTP inaccessible',               1,0,0,1,
      '["admin"]',                               60,'["admin"]',
      0,'{"nb_echecs_seuil":3}');
    seedRegles.run('ALRT_DB_VOLUME',           'alerte','avertissement',
      'Base de données volumineuse',             1,0,0,0,
      '["admin"]',                               null,null,
      0,'{"seuil_cle":"alrt_db_volume_mo"}');
    seedRegles.run('ALRT_CONNEXION_SUSPECTE',  'alerte','critique',
      'Tentatives de connexion suspectes',       1,0,0,0,
      '["admin"]',                               null,null,
      0,'{"nb_cle":"alrt_connexion_nb_echecs","fenetre_cle":"alrt_connexion_fenetre_min"}');
    seedRegles.run('ALRT_UTILISATEUR_INACTIF', 'alerte','info',
      'Utilisateur inactif depuis longtemps',    1,0,0,0,
      '["admin"]',                               null,null,
      0,'{"jours_cle":"alrt_user_inactif_jours"}');
  });
  txRegles();

  const alignDirectionRegles = db.transaction(() => {
    [
      ['NOTIF_OP_CREE',            '["dg","admin","finance","caissier"]', null],
      ['NOTIF_ACHAT_APPROUVE',     '["dg","admin","finance"]', null],
      ['NOTIF_ACHAT_REJETE',       '["dg","admin"]', null],
      ['NOTIF_ACHAT_SOUMIS',       '["dg","admin","assistante_direction"]', null],
      ['NOTIF_CONGE_APPROUVE',     '["dg","admin","rh"]', null],
      ['NOTIF_CONGE_REFUSE',       '["dg","admin","rh"]', null],
      ['ALRT_SOLDE_AVERTISSEMENT', '["dg","admin","finance","caissier"]', null],
      ['ALRT_SOLDE_CRITIQUE',      '["dg","admin","finance","caissier"]', '["dg","admin"]'],
      ['ALRT_SOLDE_NEGATIF',       '["dg","admin","finance"]', '["dg","admin"]'],
      ['ALRT_DEC_SOUMIS',          '["dg","admin","finance"]', '["dg","admin"]'],
      ['ALRT_DEC_VALIDE_NON_PAYE', '["dg","admin","finance","caissier"]', null],
    ].forEach(([type, rolesDest, escaladeRoles]) => {
      db.prepare(`
        UPDATE notif_regles
        SET roles_dest = ?,
            escalade_roles = COALESCE(?, escalade_roles),
            updated_at = datetime('now')
        WHERE type = ?
      `).run(rolesDest, escaladeRoles, type);
    });
  });
  alignDirectionRegles();

  // ── 2. notif_messages : file de messages par utilisateur ─────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS notif_messages (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      type         TEXT    NOT NULL,
      famille      TEXT    NOT NULL DEFAULT 'notification'
                   CHECK(famille IN ('notification','rappel','alerte')),
      priorite     TEXT    NOT NULL DEFAULT 'info'
                   CHECK(priorite IN ('info','avertissement','critique','bloquant')),
      titre        TEXT    NOT NULL,
      message      TEXT    NOT NULL,
      user_id      INTEGER NOT NULL REFERENCES users(id),
      src_table    TEXT,
      src_id       INTEGER,
      statut       TEXT    NOT NULL DEFAULT 'non_lue'
                   CHECK(statut IN ('non_lue','lue','archivee')),
      acquitte_at  TEXT,
      acquitte_par INTEGER REFERENCES users(id),
      expires_at   TEXT,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_notifmsg_user_statut
      ON notif_messages(user_id, statut, created_at);
    CREATE INDEX IF NOT EXISTS idx_notifmsg_user_nonlue
      ON notif_messages(user_id, statut)
      WHERE statut = 'non_lue';
    CREATE INDEX IF NOT EXISTS idx_notifmsg_src
      ON notif_messages(src_table, src_id)
      WHERE src_table IS NOT NULL;
  `);

  // ── 3. notif_rappels : échéances planifiées ───────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS notif_rappels (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      type            TEXT    NOT NULL,
      src_table       TEXT    NOT NULL,
      src_id          INTEGER NOT NULL,
      declenchement_j INTEGER,
      declenchement_h INTEGER,
      declenche_a     TEXT    NOT NULL,
      statut          TEXT    NOT NULL DEFAULT 'planifie'
                      CHECK(statut IN ('planifie','declenche','acquitte','retarde','escalade','annule')),
      acquitte_par    INTEGER REFERENCES users(id),
      acquitte_at     TEXT,
      annule_motif    TEXT,
      escalade_at     TEXT,
      escalade_vers   TEXT,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_notifrap_unique_actif
      ON notif_rappels(type, src_table, src_id, COALESCE(declenchement_j,-9999), COALESCE(declenchement_h,-9999))
      WHERE statut NOT IN ('annule','acquitte');
    CREATE INDEX IF NOT EXISTS idx_notifrap_cron
      ON notif_rappels(statut, declenche_a)
      WHERE statut = 'planifie';
    CREATE INDEX IF NOT EXISTS idx_notifrap_src
      ON notif_rappels(src_table, src_id);
  `);

  // ── 4. alertes_actives : états d'anomalie courants ────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS alertes_actives (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      type                TEXT    NOT NULL,
      priorite            TEXT    NOT NULL
                          CHECK(priorite IN ('info','avertissement','critique','bloquant')),
      bloquant            INTEGER NOT NULL DEFAULT 0,
      src_table           TEXT,
      src_id              INTEGER,
      position_id         INTEGER REFERENCES positions(id),
      titre               TEXT    NOT NULL,
      message             TEXT    NOT NULL,
      details             TEXT,
      statut              TEXT    NOT NULL DEFAULT 'active'
                          CHECK(statut IN ('active','acquittee','resolue','retardee','escaladee')),
      acquitte_par        INTEGER REFERENCES users(id),
      acquitte_at         TEXT,
      resolu_at           TEXT,
      resolu_auto         INTEGER NOT NULL DEFAULT 0,
      escalade_at         TEXT,
      escalade_vers       TEXT,
      override_par        INTEGER REFERENCES users(id),
      override_at         TEXT,
      override_motif      TEXT,
      derniere_detection  TEXT    NOT NULL DEFAULT (datetime('now')),
      created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at          TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_alerte_unique_active
      ON alertes_actives(
        type,
        COALESCE(src_table,''),
        COALESCE(CAST(src_id       AS TEXT),''),
        COALESCE(CAST(position_id  AS TEXT),'')
      )
      WHERE statut NOT IN ('resolue');
    CREATE INDEX IF NOT EXISTS idx_alerte_statut
      ON alertes_actives(statut, priorite)
      WHERE statut IN ('active','acquittee','retardee','escaladee');
    CREATE INDEX IF NOT EXISTS idx_alerte_bloquant
      ON alertes_actives(bloquant, position_id, statut)
      WHERE bloquant = 1;
  `);

  // ── 5. notif_canaux : surcharge canaux par utilisateur ───────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS notif_canaux (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id),
      type       TEXT    NOT NULL,
      canal      TEXT    NOT NULL
                 CHECK(canal IN ('inapp','email','push','son')),
      actif      INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(user_id, type, canal)
    );
    CREATE INDEX IF NOT EXISTS idx_notifcanaux_user
      ON notif_canaux(user_id, type);
  `);

  // ── 6. notif_envois : log des livraisons physiques ────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS notif_envois (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      notif_id            INTEGER REFERENCES notif_messages(id),
      alerte_id           INTEGER REFERENCES alertes_actives(id),
      rappel_id           INTEGER REFERENCES notif_rappels(id),
      canal               TEXT    NOT NULL CHECK(canal IN ('email','push','sms')),
      destinataire        TEXT    NOT NULL,
      user_id             INTEGER REFERENCES users(id),
      statut              TEXT    NOT NULL DEFAULT 'en_attente'
                          CHECK(statut IN ('en_attente','envoye','echec','ignore')),
      tentatives          INTEGER NOT NULL DEFAULT 0,
      derniere_tentative  TEXT,
      erreur              TEXT,
      dedup_key           TEXT    UNIQUE,
      created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
      sent_at             TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_notifenvois_attente
      ON notif_envois(statut, created_at)
      WHERE statut IN ('en_attente','echec');
    CREATE INDEX IF NOT EXISTS idx_notifenvois_notif
      ON notif_envois(notif_id)
      WHERE notif_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_notifenvois_alerte
      ON notif_envois(alerte_id)
      WHERE alerte_id IS NOT NULL;
  `);

  // ── 7. user_preferences : préférences sons et digest par utilisateur ─────
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id              INTEGER PRIMARY KEY REFERENCES users(id),
      son_actif            INTEGER NOT NULL DEFAULT 1,
      son_info_actif       INTEGER NOT NULL DEFAULT 0,
      son_avert_actif      INTEGER NOT NULL DEFAULT 1,
      son_critique_actif   INTEGER NOT NULL DEFAULT 1,
      son_volume           REAL    NOT NULL DEFAULT 0.5
                           CHECK(son_volume BETWEEN 0.0 AND 1.0),
      son_plage_debut      TEXT    NOT NULL DEFAULT '07:00',
      son_plage_fin        TEXT    NOT NULL DEFAULT '21:00',
      notif_digest         INTEGER NOT NULL DEFAULT 0,
      push_actif           INTEGER NOT NULL DEFAULT 0,
      updated_at           TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // ── 8. push_souscriptions : endpoints Web Push par appareil ──────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_souscriptions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       INTEGER NOT NULL REFERENCES users(id),
      endpoint      TEXT    NOT NULL UNIQUE,
      key_p256dh    TEXT    NOT NULL,
      key_auth      TEXT    NOT NULL,
      user_agent    TEXT,
      actif         INTEGER NOT NULL DEFAULT 1,
      erreur_410_at TEXT,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      last_used_at  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pushsub_user_actif
      ON push_souscriptions(user_id, actif)
      WHERE actif = 1;
  `);

  // ── 9. Nouvelles clés parametres (INSERT OR IGNORE — n'écrase jamais) ────
  const insParam = db.prepare('INSERT OR IGNORE INTO parametres (cle, valeur) VALUES (?,?)');
  const txParams = db.transaction(() => {
    // Interrupteur global du module
    insParam.run('notif_actif',                  '1');
    // Rétention et digest
    insParam.run('notif_retention_jours',         '90');
    insParam.run('notif_digest_heure',            '08:00');
    insParam.run('notif_son_silence_global',      '0');
    // Délais workflow alertes
    insParam.run('alrt_dec_valid_h',              '48');
    insParam.run('alrt_dec_paiement_h',           '24');
    insParam.run('alrt_achat_sans_suite_h',       '48');
    // Alertes sécurité
    insParam.run('alrt_connexion_nb_echecs',      '5');
    insParam.run('alrt_connexion_fenetre_min',    '10');
    insParam.run('alrt_user_inactif_jours',       '30');
    // Alerte volume DB
    insParam.run('alrt_db_volume_mo',             '500');
    // Push VAPID (vide — activé en v2)
    insParam.run('push_vapid_public',             '');
    insParam.run('push_vapid_email',              '');
    // SMS (réservé v3)
    insParam.run('sms_actif',                     '0');
    insParam.run('sms_provider',                  '');
  });
  txParams();
}

// ─── Migration : multi-rôles (colonne roles JSON) ─────────────────────────────
function migrateMultiRoles() {
  const cols = tableColumns('users');
  if (cols.includes('roles')) return; // déjà migré

  // Ajoute la colonne roles (JSON array), initialisée depuis role existant
  db.exec(`ALTER TABLE users ADD COLUMN roles TEXT`);
  // Initialise roles = ["role_actuel"] pour tous les users existants
  const users = db.prepare('SELECT id, role FROM users').all();
  const upd = db.prepare('UPDATE users SET roles = ? WHERE id = ?');
  for (const u of users) {
    upd.run(JSON.stringify([u.role]), u.id);
  }
}

// ─── Migration : table entreprise (référentiel central) ───────────────────────
function migrateEntrepriseSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entreprise (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,

      -- Identité légale
      raison_sociale         TEXT NOT NULL DEFAULT '',
      nom_commercial         TEXT DEFAULT '',
      forme_juridique        TEXT DEFAULT '',
      rccm                   TEXT DEFAULT '',
      nif                    TEXT DEFAULT '',
      secteur_activite       TEXT DEFAULT '',
      date_creation          TEXT DEFAULT '',
      capital_social         TEXT DEFAULT '',
      regime_fiscal          TEXT DEFAULT '',

      -- Coordonnées
      adresse                TEXT DEFAULT '',
      ville                  TEXT DEFAULT 'Brazzaville',
      pays                   TEXT DEFAULT 'Congo-Brazzaville',
      telephone              TEXT DEFAULT '',
      email                  TEXT DEFAULT '',
      site_web               TEXT DEFAULT '',

      -- Représentants
      directeur_general      TEXT DEFAULT '',
      responsable_rh         TEXT DEFAULT '',
      responsable_finance    TEXT DEFAULT '',
      signataire_paie        TEXT DEFAULT '',
      signataire_decaissement TEXT DEFAULT '',

      -- Paramètres
      devise                 TEXT DEFAULT 'XAF',
      exercice_debut         TEXT DEFAULT '01-01',
      exercice_fin           TEXT DEFAULT '12-31',
      fuseau_horaire         TEXT DEFAULT 'Africa/Brazzaville',

      -- Assets (chemins fichiers uploadés)
      logo_path              TEXT DEFAULT '',
      cachet_path            TEXT DEFAULT '',
      signature_path         TEXT DEFAULT '',

      -- Statut & audit
      actif                  INTEGER DEFAULT 1,
      created_at             TEXT DEFAULT (datetime('now')),
      updated_at             TEXT DEFAULT (datetime('now')),
      created_by             INTEGER,
      updated_by             INTEGER
    );

    -- Historique des modifications (snapshot avant chaque PUT)
    CREATE TABLE IF NOT EXISTS entreprise_historique (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      entreprise_id   INTEGER NOT NULL,
      snapshot        TEXT NOT NULL,   -- JSON de l'état avant modification
      modifie_par     INTEGER,
      modifie_le      TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (entreprise_id) REFERENCES entreprise(id)
    );

    CREATE INDEX IF NOT EXISTS idx_entreprise_hist
    ON entreprise_historique(entreprise_id);
  `);

  // Si aucune entreprise n'existe, créer une entrée vide à partir des paramètres existants
  const count = db.prepare('SELECT COUNT(*) as c FROM entreprise').get().c;
  if (count === 0) {
    const prm = db.prepare('SELECT cle, valeur FROM parametres').all()
      .reduce((o, p) => ({ ...o, [p.cle]: p.valeur }), {});
    db.prepare(`
      INSERT INTO entreprise
        (raison_sociale, nom_commercial, nif, rccm, adresse, telephone, email, devise)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      prm.societe || 'TOP CENTER',
      prm.societe || 'TOP CENTER',
      prm.nif || '',
      prm.rccm || '',
      prm.adresse || '',
      prm.telephone || '',
      prm.email_societe || '',
      prm.devise || 'XAF'
    );
  }

  // Colonnes supplémentaires potentiellement manquantes sur DB existantes
  addColumnIfMissing('entreprise', 'nom_commercial',          "TEXT DEFAULT ''");
  addColumnIfMissing('entreprise', 'forme_juridique',         "TEXT DEFAULT ''");
  addColumnIfMissing('entreprise', 'secteur_activite',        "TEXT DEFAULT ''");
  addColumnIfMissing('entreprise', 'capital_social',          "TEXT DEFAULT ''");
  addColumnIfMissing('entreprise', 'regime_fiscal',           "TEXT DEFAULT ''");
  addColumnIfMissing('entreprise', 'site_web',                "TEXT DEFAULT ''");
  addColumnIfMissing('entreprise', 'directeur_general',       "TEXT DEFAULT ''");
  addColumnIfMissing('entreprise', 'responsable_rh',          "TEXT DEFAULT ''");
  addColumnIfMissing('entreprise', 'responsable_finance',     "TEXT DEFAULT ''");
  addColumnIfMissing('entreprise', 'signataire_paie',         "TEXT DEFAULT ''");
  addColumnIfMissing('entreprise', 'signataire_decaissement', "TEXT DEFAULT ''");
  addColumnIfMissing('entreprise', 'exercice_debut',          "TEXT DEFAULT '01-01'");
  addColumnIfMissing('entreprise', 'exercice_fin',            "TEXT DEFAULT '12-31'");
  addColumnIfMissing('entreprise', 'fuseau_horaire',          "TEXT DEFAULT 'Africa/Brazzaville'");
  addColumnIfMissing('entreprise', 'logo_path',               "TEXT DEFAULT ''");
  addColumnIfMissing('entreprise', 'cachet_path',             "TEXT DEFAULT ''");
  addColumnIfMissing('entreprise', 'signature_path',          "TEXT DEFAULT ''");
  addColumnIfMissing('entreprise', 'updated_by',              'INTEGER');
}

// ─── Migration : sessions utilisateurs (last_seen_at) ─────────────────────────
function migrateSessionsSchema() {
  addColumnIfMissing('users', 'last_seen_at', 'TEXT');
  addColumnIfMissing('users', 'last_ip',      'TEXT');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users(last_seen_at);
  `);
}

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

// ─── Migration : extension rôles utilisateurs (rh / finance) ─────────────────
function migrateUsersRoles() {
  // Vérifie si la contrainte CHECK actuelle est déjà étendue
  const tblInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
  if (!tblInfo) return;
  // Si la définition contient déjà 'finance', la migration a déjà été appliquée
  if (tblInfo.sql && tblInfo.sql.includes('finance')) return;

  // SQLite ne supporte pas ALTER TABLE … MODIFY COLUMN.
  // On recrée la table avec le nouveau CHECK, puis on recopie les données.
  db.pragma('foreign_keys = OFF');
  db.exec(`DROP TABLE IF EXISTS users_v2;`);
  db.exec(`
    CREATE TABLE users_v2 (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      nom          TEXT NOT NULL,
      email        TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role         TEXT NOT NULL DEFAULT 'caissier'
                   CHECK(role IN ('admin','caissier','finance','rh','lecteur')),
      actif        INTEGER NOT NULL DEFAULT 1,
      created_at   TEXT DEFAULT (datetime('now')),
      sous_role    TEXT,
      photo_url    TEXT
    );
  `);

  // Copie des données (la colonne photo_url peut être absente de l'ancienne table)
  const cols = tableColumns('users');
  const haveSousRole  = cols.includes('sous_role')  ? 'sous_role'  : 'NULL';
  const havePhotoUrl  = cols.includes('photo_url')  ? 'photo_url'  : 'NULL';

  db.exec(`
    INSERT INTO users_v2 (id, nom, email, password_hash, role, actif, created_at, sous_role, photo_url)
    SELECT id, nom, email, password_hash, role, actif, created_at,
           ${haveSousRole}, ${havePhotoUrl}
    FROM users;
  `);

  db.exec(`DROP TABLE users;`);
  db.exec(`ALTER TABLE users_v2 RENAME TO users;`);
  db.pragma('foreign_keys = ON');
}

// ─── Migration : module demandes d'achat ─────────────────────────────────────
function migrateAchatsSchema() {
  // Étendre les rôles users pour inclure les nouveaux rôles achats
  // (si la table users ne contient pas encore 'dg')
  const tblInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
  if (tblInfo && tblInfo.sql && !tblInfo.sql.includes('dg')) {
    db.pragma('foreign_keys = OFF');
    db.exec(`DROP TABLE IF EXISTS users_v3;`);
    db.exec(`
      CREATE TABLE users_v3 (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        nom           TEXT NOT NULL,
        email         TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role          TEXT NOT NULL DEFAULT 'caissier'
                      CHECK(role IN ('admin','caissier','finance','rh','lecteur',
                                     'dg','assistante_direction','delegue')),
        actif         INTEGER NOT NULL DEFAULT 1,
        created_at    TEXT DEFAULT (datetime('now')),
        sous_role     TEXT,
        photo_url     TEXT,
        last_seen_at  TEXT,
        last_ip       TEXT
      );
    `);

    const cols = tableColumns('users');
    const fields = ['id','nom','email','password_hash','role','actif','created_at',
                    'sous_role','photo_url','last_seen_at','last_ip'];
    const sel = fields.map(f => cols.includes(f) ? f : 'NULL').join(', ');
    db.exec(`
      INSERT INTO users_v3 (id,nom,email,password_hash,role,actif,created_at,sous_role,photo_url,last_seen_at,last_ip)
      SELECT ${sel} FROM users;
    `);
    db.exec(`DROP TABLE users;`);
    db.exec(`ALTER TABLE users_v3 RENAME TO users;`);
    db.pragma('foreign_keys = ON');
  }

  // Tables demandes d'achat
  db.exec(`
    CREATE TABLE IF NOT EXISTS demandes_achat (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      numero            TEXT UNIQUE,
      date_demande      TEXT NOT NULL DEFAULT (date('now')),
      service_demandeur TEXT NOT NULL,
      demandeur_id      INTEGER REFERENCES users(id),
      demandeur_nom     TEXT NOT NULL,
      statut            TEXT NOT NULL DEFAULT 'brouillon',
      commentaires      TEXT,
      transport         INTEGER DEFAULT 0,
      total_articles    INTEGER DEFAULT 0,
      total_general     INTEGER DEFAULT 0,
      approuve_par_id   INTEGER REFERENCES users(id),
      approuve_par_nom  TEXT,
      date_approbation  TEXT,
      motif_rejet       TEXT,
      decaissement_id   INTEGER REFERENCES operations(id),
      created_at        TEXT DEFAULT (datetime('now')),
      updated_at        TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS demandes_achat_lignes (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      demande_id             INTEGER NOT NULL REFERENCES demandes_achat(id) ON DELETE CASCADE,
      designation            TEXT NOT NULL,
      quantite               TEXT NOT NULL,
      montant                INTEGER NOT NULL DEFAULT 0,
      fournisseur_recommande TEXT,
      ordre                  INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS delegations_approbation (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      delegant_id  INTEGER NOT NULL REFERENCES users(id),
      delegue_id   INTEGER NOT NULL REFERENCES users(id),
      date_debut   TEXT NOT NULL,
      date_fin     TEXT,
      motif        TEXT,
      actif        INTEGER DEFAULT 1,
      created_at   TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_demandes_achat_statut  ON demandes_achat(statut);
    CREATE INDEX IF NOT EXISTS idx_demandes_achat_demandeur ON demandes_achat(demandeur_id);
  `);
}

// ─── Migration : workflow congés — étape validation supérieur hiérarchique ────
// SQLite ne supporte pas ALTER TABLE MODIFY COLUMN.
// On recrée employes_conges avec le CHECK étendu si nécessaire (idempotent).
function migrateCongesWorkflow() {
  // Vérifier si le CHECK contient déjà 'valide_sup'
  const tbl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='employes_conges'").get();
  if (!tbl) return;

  if (!tbl.sql.includes("'valide_sup'")) {
    // Récréer la table avec le CHECK étendu en préservant toutes les données
    db.pragma('foreign_keys = OFF');

    db.exec(`
      CREATE TABLE IF NOT EXISTS employes_conges_v2 (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        employe_id       INTEGER NOT NULL,
        type_conge       TEXT DEFAULT 'annuel'
                         CHECK(type_conge IN ('annuel','maladie','maternite','paternite','sans_solde','autre')),
        date_debut       TEXT NOT NULL,
        date_fin         TEXT NOT NULL,
        nb_jours         INTEGER DEFAULT 0,
        motif            TEXT,
        statut           TEXT DEFAULT 'demande'
                         CHECK(statut IN ('demande','valide_sup','approuve','refuse','termine','annule')),
        notes            TEXT,
        created_by       INTEGER,
        created_at       TEXT DEFAULT (datetime('now')),
        annule_at        TEXT,
        annule_by        INTEGER,
        annule_motif     TEXT,
        updated_by       INTEGER,
        updated_at       TEXT DEFAULT (datetime('now')),
        approuve_par     INTEGER,
        approuve_at      TEXT,
        refuse_par       INTEGER,
        refuse_at        TEXT,
        refuse_motif     TEXT,
        annule_statut    TEXT,
        valide_sup_par   INTEGER,
        valide_sup_at    TEXT,
        valide_sup_notes TEXT,
        FOREIGN KEY (employe_id) REFERENCES employes(id)
      );
    `);

    // Copier toutes les lignes existantes — colonnes présentes détectées dynamiquement
    const existingCols = tableColumns('employes_conges');
    const v2Cols = [
      'id','employe_id','type_conge','date_debut','date_fin','nb_jours','motif',
      'statut','notes','created_by','created_at','annule_at','annule_by','annule_motif',
      'updated_by','updated_at','approuve_par','approuve_at','refuse_par','refuse_at',
      'refuse_motif','annule_statut','valide_sup_par','valide_sup_at','valide_sup_notes'
    ];
    const sel = v2Cols.map(c => existingCols.includes(c) ? c : 'NULL').join(', ');
    db.exec(`INSERT INTO employes_conges_v2 (${v2Cols.join(',')}) SELECT ${sel} FROM employes_conges`);
    db.exec(`DROP TABLE employes_conges`);
    db.exec(`ALTER TABLE employes_conges_v2 RENAME TO employes_conges`);

    db.pragma('foreign_keys = ON');
  }

  // Colonnes traçabilité supérieur (idempotentes — pour les DB déjà migrées)
  addColumnIfMissing('employes_conges', 'valide_sup_par',  'INTEGER');
  addColumnIfMissing('employes_conges', 'valide_sup_at',   'TEXT');
  addColumnIfMissing('employes_conges', 'valide_sup_notes','TEXT');

  // Index performance
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_conges_statut_valide_sup
      ON employes_conges(statut)
      WHERE statut = 'valide_sup';
    CREATE INDEX IF NOT EXISTS idx_conges_employe_annee
      ON employes_conges(employe_id, date_debut);
    CREATE INDEX IF NOT EXISTS idx_conges_statut_date
      ON employes_conges(statut, date_debut);
  `);

  // Paramètre : activer/désactiver la validation supérieur (0 = désactivée)
  db.prepare("INSERT OR IGNORE INTO parametres (cle, valeur) VALUES (?, ?)").run('conges_workflow_sup', '1');

  // Seed règle notification validation supérieur (idempotent)
  db.prepare(`
    INSERT OR IGNORE INTO notif_regles
      (type, famille, priorite_defaut, libelle,
       canal_inapp, canal_email, canal_push, canal_son,
       roles_dest, escalade_delai_h, escalade_roles, grace_h, params)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    'NOTIF_CONGE_VALIDE_SUP', 'notification', 'info',
    'Congé validé par le supérieur — en attente DG/RH',
    1, 1, 0, 0,
    '["dg","admin","rh"]', null, null, 24, '{}'
  );
  db.prepare(`
    UPDATE notif_regles
    SET roles_dest='["dg","admin","rh"]',
        libelle='Congé validé par le supérieur — en attente DG/RH',
        updated_at=datetime('now')
    WHERE type='NOTIF_CONGE_VALIDE_SUP'
  `).run();
}

// ─── Migration : organigramme — référentiels + hiérarchie + mutations ─────────
function migrateOrganigramme() {
  // ── 1. Référentiels postes, départements, sites ────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS org_postes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      libelle     TEXT    NOT NULL,
      description TEXT,
      actif       INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(libelle)
    );
    CREATE TABLE IF NOT EXISTS org_departements (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      libelle         TEXT    NOT NULL,
      code            TEXT,
      responsable_id  INTEGER REFERENCES employes(id),
      description     TEXT,
      actif           INTEGER NOT NULL DEFAULT 1,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(libelle)
    );
    CREATE TABLE IF NOT EXISTS org_sites (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      libelle     TEXT    NOT NULL,
      ville       TEXT,
      adresse     TEXT,
      actif       INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(libelle)
    );
  `);

  // ── 2. Colonne superieur_id sur employes (FK souple — TEXT conservé) ───────
  addColumnIfMissing('employes', 'superieur_id', 'INTEGER');

  // ── 3. Table historique mutations ──────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS employes_mutations (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      employe_id      INTEGER NOT NULL REFERENCES employes(id),
      date_effet      TEXT    NOT NULL,
      -- avant
      ancien_poste    TEXT,
      ancien_dept     TEXT,
      ancien_site     TEXT,
      ancien_sup_id   INTEGER,
      ancien_sup_nom  TEXT,
      -- après
      nouveau_poste   TEXT,
      nouveau_dept    TEXT,
      nouveau_site    TEXT,
      nouveau_sup_id  INTEGER,
      nouveau_sup_nom TEXT,
      -- meta
      type_mutation   TEXT    NOT NULL DEFAULT 'modification'
                      CHECK(type_mutation IN ('embauche','promotion','transfert',
                                              'modification','reintegration','sortie')),
      motif           TEXT,
      valide_par      INTEGER REFERENCES users(id),
      created_by      INTEGER REFERENCES users(id),
      created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_mutations_employe
      ON employes_mutations(employe_id, date_effet DESC);
    CREATE INDEX IF NOT EXISTS idx_mutations_date
      ON employes_mutations(date_effet DESC);
  `);

  // ── 4. Peupler les référentiels depuis les données TEXT libres existantes ──
  const insPoste = db.prepare(
    "INSERT OR IGNORE INTO org_postes (libelle) VALUES (?)");
  const insDept  = db.prepare(
    "INSERT OR IGNORE INTO org_departements (libelle) VALUES (?)");
  const insSite  = db.prepare(
    "INSERT OR IGNORE INTO org_sites (libelle) VALUES (?)");

  const postes = db.prepare(
    "SELECT DISTINCT poste FROM employes WHERE poste IS NOT NULL AND poste != ''").all();
  const depts  = db.prepare(
    "SELECT DISTINCT departement FROM employes WHERE departement IS NOT NULL AND departement != ''").all();
  const sites  = db.prepare(
    "SELECT DISTINCT site FROM employes WHERE site IS NOT NULL AND site != ''").all();

  const tx = db.transaction(() => {
    postes.forEach(r => insPoste.run(r.poste));
    depts.forEach(r  => insDept.run(r.departement));
    sites.forEach(r  => insSite.run(r.site));
  });
  tx();

  // ── 5. Peupler superieur_id depuis superieur_hierarchique (TEXT → ID) ──────
  // Idempotent : ne met à jour que les lignes où superieur_id est NULL
  const agents = db.prepare(
    "SELECT id, superieur_hierarchique FROM employes WHERE superieur_id IS NULL AND superieur_hierarchique IS NOT NULL AND superieur_hierarchique != ''"
  ).all();

  const findSup = db.prepare(
    "SELECT id FROM employes WHERE (nom || ' ' || COALESCE(prenom,'')) = ? OR (nom || ' ' || prenom) LIKE ? LIMIT 1"
  );
  const updSup  = db.prepare("UPDATE employes SET superieur_id = ? WHERE id = ?");

  const tx2 = db.transaction(() => {
    for (const a of agents) {
      const found = findSup.get(a.superieur_hierarchique.trim(), a.superieur_hierarchique.trim() + '%');
      if (found) updSup.run(found.id, a.id);
    }
  });
  tx2();

  // ── 6. Paramètres organigramme ─────────────────────────────────────────────
  const insParam = db.prepare("INSERT OR IGNORE INTO parametres (cle, valeur) VALUES (?, ?)");
  insParam.run('org_mutation_auto', '1'); // enregistrer mutation auto sur PUT /agents/:id
  insParam.run('org_boucle_strict', '1'); // bloquer en cas de cycle hiérarchique
}

// ─── Migration : logs d'envoi bulletins de paie ───────────────────────────────
function migrateBulletinEnvois() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bulletin_envois (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      bulletin_id  INTEGER NOT NULL REFERENCES bulletins_salaire(id),
      employe_id   INTEGER NOT NULL REFERENCES employes(id),
      mois         INTEGER NOT NULL,
      annee        INTEGER NOT NULL,
      canal        TEXT    NOT NULL DEFAULT 'email'
                   CHECK(canal IN ('email','pdf_download','impression')),
      destinataire TEXT,          -- adresse email ou 'impression'
      statut       TEXT    NOT NULL DEFAULT 'envoye'
                   CHECK(statut IN ('envoye','echec','en_attente')),
      erreur       TEXT,          -- message d'erreur si echec
      avec_pdf     INTEGER NOT NULL DEFAULT 0,  -- 1 si PDF joint
      groupe       INTEGER NOT NULL DEFAULT 0,  -- 1 si envoi groupé
      envoye_par   INTEGER REFERENCES users(id),
      created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_bul_envois_bulletin
      ON bulletin_envois(bulletin_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_bul_envois_mois
      ON bulletin_envois(mois, annee, statut);
    CREATE INDEX IF NOT EXISTS idx_bul_envois_employe
      ON bulletin_envois(employe_id, created_at DESC);
  `);

  // Colonnes dernier_envoi sur bulletins_salaire (idempotentes)
  addColumnIfMissing('bulletins_salaire', 'dernier_envoi_at',  'TEXT');
  addColumnIfMissing('bulletins_salaire', 'dernier_envoi_dest', 'TEXT');
  addColumnIfMissing('bulletins_salaire', 'nb_envois',         'INTEGER DEFAULT 0');
}

// ─── Migration : module CNSS complet ──────────────────────────────────────────
function migrateCnss() {
  db.exec(`
    -- Déclarations CNSS mensuelles
    CREATE TABLE IF NOT EXISTS cnss_declarations (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      mois           INTEGER NOT NULL CHECK(mois BETWEEN 1 AND 12),
      annee          INTEGER NOT NULL,
      date_limite    TEXT,           -- date limite légale de dépôt
      date_depot     TEXT,           -- date de dépôt effective
      statut         TEXT NOT NULL DEFAULT 'en_attente'
                     CHECK(statut IN ('en_attente','deposee','payee','rejetee')),
      -- Totaux agrégés depuis les bulletins
      nb_employes    INTEGER DEFAULT 0,
      masse_salariale REAL DEFAULT 0,
      cotis_employe   REAL DEFAULT 0,  -- CNSS salarié
      cotis_patronal  REAL DEFAULT 0,  -- CNSS patronal
      camu_employe    REAL DEFAULT 0,
      camu_patronal   REAL DEFAULT 0,
      total_du        REAL DEFAULT 0,  -- total à verser
      -- Référence paiement
      ref_paiement    TEXT,
      mode_paiement   TEXT DEFAULT 'virement_bancaire',
      montant_paye    REAL DEFAULT 0,
      date_paiement   TEXT,
      -- Notes & audit
      notes          TEXT,
      created_by     INTEGER REFERENCES users(id),
      updated_by     INTEGER REFERENCES users(id),
      created_at     TEXT DEFAULT (datetime('now')),
      updated_at     TEXT DEFAULT (datetime('now')),
      UNIQUE(mois, annee)
    );

    CREATE INDEX IF NOT EXISTS idx_cnss_decl_periode
      ON cnss_declarations(annee DESC, mois DESC);
    CREATE INDEX IF NOT EXISTS idx_cnss_decl_statut
      ON cnss_declarations(statut);

    -- Paiements CNSS (un déclaration peut avoir plusieurs paiements partiels)
    CREATE TABLE IF NOT EXISTS cnss_paiements (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      declaration_id  INTEGER NOT NULL REFERENCES cnss_declarations(id),
      montant         REAL NOT NULL,
      date_paiement   TEXT NOT NULL,
      mode_paiement   TEXT NOT NULL DEFAULT 'virement_bancaire'
                      CHECK(mode_paiement IN ('virement_bancaire','cheque','especes','autre')),
      ref_paiement    TEXT,
      banque          TEXT,
      notes           TEXT,
      operation_id    INTEGER REFERENCES operations(id),
      created_by      INTEGER REFERENCES users(id),
      created_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_cnss_paiements_decl
      ON cnss_paiements(declaration_id);
  `);

  // Paramètres CNSS spécifiques
  const insp = db.prepare("INSERT OR IGNORE INTO parametres (cle, valeur) VALUES (?, ?)");
  insp.run('cnss_numero_adherent',  '');
  insp.run('cnss_numero_camu',      '');
  insp.run('cnss_date_limite_jour', '15');
  insp.run('cnss_adresse_depot',    'CNSS Brazzaville — Avenue des Forces Armées');
}

// ─── Migration : module DGI / Fiscalité paie ──────────────────────────────────
function migrateDgi() {
  db.exec(`
    -- Déclarations fiscales mensuelles DGI (IRPP sur salaires)
    CREATE TABLE IF NOT EXISTS dgi_declarations (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      mois             INTEGER NOT NULL CHECK(mois BETWEEN 1 AND 12),
      annee            INTEGER NOT NULL,
      date_limite      TEXT,           -- 15 du mois suivant en général
      date_depot       TEXT,
      statut           TEXT NOT NULL DEFAULT 'en_attente'
                       CHECK(statut IN ('en_attente','deposee','payee','rejetee','archivee')),
      -- Totaux agrégés depuis les bulletins
      nb_employes      INTEGER DEFAULT 0,
      masse_salariale  REAL DEFAULT 0,
      total_net_imposable REAL DEFAULT 0,
      total_irpp       REAL DEFAULT 0,  -- montant IRPP retenu à reverser à la DGI
      -- Référence légale et paiement
      ref_declaration  TEXT,           -- numéro de déclaration DGI
      ref_paiement     TEXT,
      mode_paiement    TEXT DEFAULT 'virement_bancaire',
      montant_paye     REAL DEFAULT 0,
      date_paiement    TEXT,
      -- Archive
      archive_at       TEXT,
      notes            TEXT,
      created_by       INTEGER REFERENCES users(id),
      updated_by       INTEGER REFERENCES users(id),
      created_at       TEXT DEFAULT (datetime('now')),
      updated_at       TEXT DEFAULT (datetime('now')),
      UNIQUE(mois, annee)
    );

    CREATE INDEX IF NOT EXISTS idx_dgi_decl_periode
      ON dgi_declarations(annee DESC, mois DESC);
    CREATE INDEX IF NOT EXISTS idx_dgi_decl_statut
      ON dgi_declarations(statut);

    -- Paiements DGI (versements IRPP partiels ou intégraux)
    CREATE TABLE IF NOT EXISTS dgi_paiements (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      declaration_id  INTEGER NOT NULL REFERENCES dgi_declarations(id),
      montant         REAL NOT NULL,
      date_paiement   TEXT NOT NULL,
      mode_paiement   TEXT NOT NULL DEFAULT 'virement_bancaire'
                      CHECK(mode_paiement IN ('virement_bancaire','cheque','especes','autre')),
      ref_paiement    TEXT,
      banque          TEXT,
      notes           TEXT,
      operation_id    INTEGER REFERENCES operations(id),
      created_by      INTEGER REFERENCES users(id),
      created_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_dgi_paiements_decl
      ON dgi_paiements(declaration_id);
  `);

  // Paramètres DGI spécifiques
  const insp = db.prepare("INSERT OR IGNORE INTO parametres (cle, valeur) VALUES (?, ?)");
  insp.run('dgi_numero_contribuable', '');      // N° contribuable DGI
  insp.run('dgi_centre_impot',        'Centre des Impôts de Brazzaville');
  insp.run('dgi_date_limite_jour',    '15');    // jour limite du mois suivant
  insp.run('dgi_formulaire',          'IRPP-Salaires');

  // =============================================
  // MODULE CLIENTS (Prompt 1)
  // =============================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      id                        INTEGER PRIMARY KEY AUTOINCREMENT,
      numero_client             TEXT UNIQUE NOT NULL,
      nom                       TEXT NOT NULL,
      type                      TEXT NOT NULL DEFAULT 'particulier'
                                CHECK(type IN ('particulier','entreprise','administration','ong','association')),
      telephone                 TEXT,
      whatsapp                  TEXT,
      email                     TEXT,
      adresse                   TEXT,
      ville                     TEXT,
      pays                      TEXT DEFAULT 'Congo',
      rccm                      TEXT,
      nif                       TEXT,
      contact_principal         TEXT,
      categorie_client          TEXT,
      plafond_credit            REAL NOT NULL DEFAULT 0,
      delai_paiement_autorise   INTEGER NOT NULL DEFAULT 30,
      statut                    TEXT NOT NULL DEFAULT 'actif'
                                CHECK(statut IN ('actif','suspendu','mauvais_payeur','archive')),
      solde_crediteur           REAL NOT NULL DEFAULT 0,
      notes                     TEXT,
      created_by                INTEGER REFERENCES users(id),
      created_at                TEXT DEFAULT (datetime('now')),
      updated_at                TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_clients_statut    ON clients(statut);
    CREATE INDEX IF NOT EXISTS idx_clients_nom       ON clients(nom);
    CREATE INDEX IF NOT EXISTS idx_clients_numero    ON clients(numero_client);
  `);

  // Migrations colonnes clients (idempotentes)
  addColumnIfMissing('clients', 'whatsapp',               'TEXT');
  addColumnIfMissing('clients', 'rccm',                   'TEXT');
  addColumnIfMissing('clients', 'nif',                    'TEXT');
  addColumnIfMissing('clients', 'contact_principal',      'TEXT');
  addColumnIfMissing('clients', 'categorie_client',       'TEXT');
  addColumnIfMissing('clients', 'solde_crediteur',        'REAL NOT NULL DEFAULT 0');
  addColumnIfMissing('clients', 'notes',                  'TEXT');

  // =============================================
  // MODULE DEVIS (Prompt 2)
  // =============================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS devis (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      numero              TEXT UNIQUE NOT NULL,
      client_id           INTEGER NOT NULL REFERENCES clients(id),
      objet               TEXT NOT NULL,
      date_devis          TEXT NOT NULL,
      date_validite       TEXT,
      statut              TEXT NOT NULL DEFAULT 'brouillon'
                          CHECK(statut IN (
                            'brouillon','envoye','vu_par_client','en_negociation',
                            'accepte','refuse','expire','annule','converti'
                          )),
      montant_ht          REAL NOT NULL DEFAULT 0,
      montant_taxes       REAL NOT NULL DEFAULT 0,
      montant_ttc         REAL NOT NULL DEFAULT 0,
      remise_globale      REAL NOT NULL DEFAULT 0,
      conditions_paiement TEXT,
      delai_livraison     TEXT,
      commercial_id       INTEGER REFERENCES users(id),
      motif_refus         TEXT,
      motif_annulation    TEXT,
      version             INTEGER NOT NULL DEFAULT 1,
      devis_parent_id     INTEGER REFERENCES devis(id),
      notes               TEXT,
      date_envoi          TEXT,
      date_acceptation    TEXT,
      preuve_acceptation  TEXT,
      created_by          INTEGER REFERENCES users(id),
      created_at          TEXT DEFAULT (datetime('now')),
      updated_at          TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_devis_client   ON devis(client_id);
    CREATE INDEX IF NOT EXISTS idx_devis_statut   ON devis(statut);
    CREATE INDEX IF NOT EXISTS idx_devis_numero   ON devis(numero);
    CREATE INDEX IF NOT EXISTS idx_devis_date     ON devis(date_devis DESC);

    CREATE TABLE IF NOT EXISTS devis_lignes (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      devis_id      INTEGER NOT NULL REFERENCES devis(id) ON DELETE CASCADE,
      type          TEXT NOT NULL DEFAULT 'service'
                    CHECK(type IN ('produit','service')),
      designation   TEXT NOT NULL,
      quantite      REAL NOT NULL DEFAULT 1,
      prix_unitaire REAL NOT NULL DEFAULT 0,
      remise        REAL NOT NULL DEFAULT 0,
      taux_taxe     REAL NOT NULL DEFAULT 0,
      montant_ht    REAL NOT NULL DEFAULT 0,
      montant_ttc   REAL NOT NULL DEFAULT 0,
      ordre         INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_devis_lignes_devis ON devis_lignes(devis_id);
  `);

  // Migrations colonnes devis (idempotentes)
  addColumnIfMissing('devis', 'motif_annulation',   'TEXT');
  addColumnIfMissing('devis', 'date_envoi',         'TEXT');
  addColumnIfMissing('devis', 'date_acceptation',   'TEXT');
  addColumnIfMissing('devis', 'preuve_acceptation', 'TEXT');

  // =============================================
  // MODULE FACTURES CLIENTS (Prompt 3)
  // =============================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS factures_clients (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      numero               TEXT UNIQUE NOT NULL,
      client_id            INTEGER NOT NULL REFERENCES clients(id),
      devis_id             INTEGER REFERENCES devis(id),
      contrat_id           INTEGER,
      type                 TEXT NOT NULL DEFAULT 'definitive'
                           CHECK(type IN (
                             'proforma','definitive','acompte','solde',
                             'recurrente','avoir','corrective','partielle','mixte'
                           )),
      objet                TEXT NOT NULL,
      date_facture         TEXT NOT NULL,
      date_echeance        TEXT,
      statut               TEXT NOT NULL DEFAULT 'brouillon'
                           CHECK(statut IN (
                             'brouillon','emise','envoyee','partiellement_payee',
                             'payee','en_retard','contestee','annulee','avoir_emis','irrecouvrable'
                           )),
      montant_ht           REAL NOT NULL DEFAULT 0,
      montant_taxes        REAL NOT NULL DEFAULT 0,
      montant_ttc          REAL NOT NULL DEFAULT 0,
      montant_paye         REAL NOT NULL DEFAULT 0,
      reste_a_payer        REAL NOT NULL DEFAULT 0,
      mode_paiement_attendu TEXT DEFAULT 'especes',
      commercial_id        INTEGER REFERENCES users(id),
      motif_annulation     TEXT,
      notes                TEXT,
      created_by           INTEGER REFERENCES users(id),
      created_at           TEXT DEFAULT (datetime('now')),
      updated_at           TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_fac_cli_client   ON factures_clients(client_id);
    CREATE INDEX IF NOT EXISTS idx_fac_cli_statut   ON factures_clients(statut);
    CREATE INDEX IF NOT EXISTS idx_fac_cli_numero   ON factures_clients(numero);
    CREATE INDEX IF NOT EXISTS idx_fac_cli_echeance ON factures_clients(date_echeance);
    CREATE INDEX IF NOT EXISTS idx_fac_cli_devis    ON factures_clients(devis_id);

    CREATE TABLE IF NOT EXISTS factures_clients_lignes (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      facture_id    INTEGER NOT NULL REFERENCES factures_clients(id) ON DELETE CASCADE,
      type          TEXT NOT NULL DEFAULT 'service'
                    CHECK(type IN ('produit','service')),
      designation   TEXT NOT NULL,
      quantite      REAL NOT NULL DEFAULT 1,
      prix_unitaire REAL NOT NULL DEFAULT 0,
      remise        REAL NOT NULL DEFAULT 0,
      taux_taxe     REAL NOT NULL DEFAULT 0,
      montant_ht    REAL NOT NULL DEFAULT 0,
      montant_ttc   REAL NOT NULL DEFAULT 0,
      ordre         INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_fac_cli_lignes ON factures_clients_lignes(facture_id);

    CREATE TABLE IF NOT EXISTS factures_clients_paiements (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      facture_id      INTEGER NOT NULL REFERENCES factures_clients(id),
      operation_id    INTEGER REFERENCES operations(id),
      montant         REAL NOT NULL,
      date_paiement   TEXT NOT NULL,
      mode_paiement   TEXT NOT NULL DEFAULT 'especes',
      reference       TEXT,
      notes           TEXT,
      created_by      INTEGER REFERENCES users(id),
      created_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_fac_paiements ON factures_clients_paiements(facture_id);

    CREATE TABLE IF NOT EXISTS relances (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      reference_type  TEXT NOT NULL DEFAULT 'facture_client'
                      CHECK(reference_type IN ('facture_client','devis')),
      reference_id    INTEGER NOT NULL,
      client_id       INTEGER NOT NULL REFERENCES clients(id),
      type_relance    TEXT NOT NULL DEFAULT 'J7'
                      CHECK(type_relance IN ('J1','J7','J15','J30')),
      date_relance    TEXT NOT NULL,
      statut          TEXT NOT NULL DEFAULT 'envoyee'
                      CHECK(statut IN ('envoyee','echec','ignoree')),
      canal           TEXT NOT NULL DEFAULT 'email'
                      CHECK(canal IN ('email','whatsapp','telephone')),
      notes           TEXT,
      created_by      INTEGER REFERENCES users(id),
      created_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_relances_ref ON relances(reference_type, reference_id);
  `);

  // Migrations colonnes factures_clients (idempotentes)
  addColumnIfMissing('factures_clients', 'contrat_id',           'INTEGER');
  addColumnIfMissing('factures_clients', 'motif_annulation',     'TEXT');
  addColumnIfMissing('factures_clients', 'notes',                'TEXT');
  addColumnIfMissing('factures_clients', 'mode_paiement_attendu','TEXT DEFAULT \'especes\'');

  // =============================================
  // MODULE STOCK / PRODUITS (Prompt 4)
  // =============================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS categories_produits (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      nom         TEXT NOT NULL UNIQUE,
      description TEXT,
      actif       INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS produits (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      code_produit      TEXT UNIQUE NOT NULL,
      designation       TEXT NOT NULL,
      categorie_id      INTEGER REFERENCES categories_produits(id),
      unite             TEXT NOT NULL DEFAULT 'piece'
                        CHECK(unite IN ('piece','boite','kg','litre','paquet','carton','autre')),
      prix_achat        REAL NOT NULL DEFAULT 0,
      prix_vente        REAL NOT NULL DEFAULT 0,
      marge             REAL GENERATED ALWAYS AS (
                          CASE WHEN prix_achat > 0
                          THEN ROUND((prix_vente - prix_achat) * 100.0 / prix_achat, 2)
                          ELSE 0 END
                        ) VIRTUAL,
      taux_taxe         REAL NOT NULL DEFAULT 0,
      stock_disponible  REAL NOT NULL DEFAULT 0,
      stock_reserve     REAL NOT NULL DEFAULT 0,
      stock_minimum     REAL NOT NULL DEFAULT 0,
      emplacement       TEXT,
      date_expiration   TEXT,
      numero_lot        TEXT,
      code_barres       TEXT,
      statut            TEXT NOT NULL DEFAULT 'actif'
                        CHECK(statut IN ('actif','archive')),
      notes             TEXT,
      created_by        INTEGER REFERENCES users(id),
      created_at        TEXT DEFAULT (datetime('now')),
      updated_at        TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_produits_code      ON produits(code_produit);
    CREATE INDEX IF NOT EXISTS idx_produits_statut    ON produits(statut);
    CREATE INDEX IF NOT EXISTS idx_produits_categorie ON produits(categorie_id);
    CREATE INDEX IF NOT EXISTS idx_produits_stock_bas ON produits(stock_disponible, stock_minimum);

    CREATE TABLE IF NOT EXISTS stock_mouvements (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      produit_id      INTEGER NOT NULL REFERENCES produits(id),
      type            TEXT NOT NULL
                      CHECK(type IN (
                        'entree','sortie','reservation','liberation',
                        'retour','perte','transfert','inventaire','ajustement'
                      )),
      quantite        REAL NOT NULL,
      quantite_avant  REAL NOT NULL DEFAULT 0,
      quantite_apres  REAL NOT NULL DEFAULT 0,
      reference_id    INTEGER,
      reference_type  TEXT CHECK(reference_type IN (
                        'facture_client','bon_commande','reception',
                        'inventaire','retour','perte','ajustement','autre'
                      )),
      motif           TEXT,
      created_by      INTEGER REFERENCES users(id),
      created_at      TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_stock_mv_produit ON stock_mouvements(produit_id);
    CREATE INDEX IF NOT EXISTS idx_stock_mv_type    ON stock_mouvements(type);
    CREATE INDEX IF NOT EXISTS idx_stock_mv_date    ON stock_mouvements(created_at DESC);
  `);

  // Migrations colonnes produits (idempotentes)
  addColumnIfMissing('produits', 'notes',   'TEXT');
  addColumnIfMissing('produits', 'statut',  "TEXT NOT NULL DEFAULT 'actif'");

  // =============================================
  // MODULE ACHAT COMPLET (Prompt 5)
  // BC → Réception → Facture fournisseur → Paiement
  // =============================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS bons_commandes_fournisseurs (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      numero               TEXT UNIQUE NOT NULL,
      demande_achat_id     INTEGER REFERENCES demandes_achat(id),
      fournisseur_id       INTEGER REFERENCES fournisseurs(id),
      statut               TEXT NOT NULL DEFAULT 'brouillon'
                           CHECK(statut IN (
                             'brouillon','soumis','valide','envoye',
                             'accepte_fournisseur','partiellement_livre',
                             'livre','annule','cloture'
                           )),
      montant_ht           REAL NOT NULL DEFAULT 0,
      montant_taxes        REAL NOT NULL DEFAULT 0,
      montant_ttc          REAL NOT NULL DEFAULT 0,
      delai_livraison      TEXT,
      lieu_livraison       TEXT,
      conditions_paiement  TEXT,
      responsable_achat_id INTEGER REFERENCES users(id),
      motif_annulation     TEXT,
      notes                TEXT,
      created_by           INTEGER REFERENCES users(id),
      created_at           TEXT DEFAULT (datetime('now')),
      updated_at           TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_bc_fournisseur ON bons_commandes_fournisseurs(fournisseur_id);
    CREATE INDEX IF NOT EXISTS idx_bc_statut      ON bons_commandes_fournisseurs(statut);
    CREATE INDEX IF NOT EXISTS idx_bc_numero      ON bons_commandes_fournisseurs(numero);
    CREATE INDEX IF NOT EXISTS idx_bc_da          ON bons_commandes_fournisseurs(demande_achat_id);

    CREATE TABLE IF NOT EXISTS bons_commandes_lignes (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      bc_id         INTEGER NOT NULL REFERENCES bons_commandes_fournisseurs(id) ON DELETE CASCADE,
      produit_id    INTEGER REFERENCES produits(id),
      designation   TEXT NOT NULL,
      quantite      REAL NOT NULL DEFAULT 1,
      quantite_recue REAL NOT NULL DEFAULT 0,
      prix_unitaire REAL NOT NULL DEFAULT 0,
      taux_taxe     REAL NOT NULL DEFAULT 0,
      montant_ht    REAL NOT NULL DEFAULT 0,
      montant_ttc   REAL NOT NULL DEFAULT 0,
      ordre         INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_bc_lignes_bc ON bons_commandes_lignes(bc_id);

    CREATE TABLE IF NOT EXISTS receptions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      numero       TEXT UNIQUE NOT NULL,
      bc_id        INTEGER NOT NULL REFERENCES bons_commandes_fournisseurs(id),
      statut       TEXT NOT NULL DEFAULT 'en_cours'
                   CHECK(statut IN (
                     'en_cours','reception_partielle','reception_totale',
                     'ecart_quantite','non_conforme','retourne','accepte'
                   )),
      date_reception TEXT NOT NULL,
      notes        TEXT,
      created_by   INTEGER REFERENCES users(id),
      created_at   TEXT DEFAULT (datetime('now')),
      updated_at   TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_receptions_bc     ON receptions(bc_id);
    CREATE INDEX IF NOT EXISTS idx_receptions_statut ON receptions(statut);

    CREATE TABLE IF NOT EXISTS receptions_lignes (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      reception_id       INTEGER NOT NULL REFERENCES receptions(id) ON DELETE CASCADE,
      bc_ligne_id        INTEGER NOT NULL REFERENCES bons_commandes_lignes(id),
      quantite_commandee REAL NOT NULL DEFAULT 0,
      quantite_recue     REAL NOT NULL DEFAULT 0,
      quantite_conforme  REAL NOT NULL DEFAULT 0,
      ecart              REAL NOT NULL DEFAULT 0,
      motif_ecart        TEXT,
      statut_ligne       TEXT NOT NULL DEFAULT 'conforme'
                         CHECK(statut_ligne IN ('conforme','ecart','non_conforme','retourne'))
    );

    CREATE INDEX IF NOT EXISTS idx_rec_lignes_rec ON receptions_lignes(reception_id);
    CREATE INDEX IF NOT EXISTS idx_rec_lignes_bc  ON receptions_lignes(bc_ligne_id);

    CREATE TABLE IF NOT EXISTS factures_fournisseurs (
      id                        INTEGER PRIMARY KEY AUTOINCREMENT,
      numero_facture_fournisseur TEXT NOT NULL,
      fournisseur_id            INTEGER NOT NULL REFERENCES fournisseurs(id),
      bc_id                     INTEGER REFERENCES bons_commandes_fournisseurs(id),
      reception_id              INTEGER REFERENCES receptions(id),
      statut                    TEXT NOT NULL DEFAULT 'recue'
                                CHECK(statut IN (
                                  'recue','a_verifier','validee',
                                  'contestee','partiellement_payee','payee','annulee'
                                )),
      montant_ht                REAL NOT NULL DEFAULT 0,
      montant_ttc               REAL NOT NULL DEFAULT 0,
      date_facture              TEXT NOT NULL,
      date_echeance             TEXT,
      montant_paye              REAL NOT NULL DEFAULT 0,
      reste_a_payer             REAL NOT NULL DEFAULT 0,
      motif_contestation        TEXT,
      notes                     TEXT,
      created_by                INTEGER REFERENCES users(id),
      created_at                TEXT DEFAULT (datetime('now')),
      updated_at                TEXT DEFAULT (datetime('now')),
      UNIQUE(numero_facture_fournisseur, fournisseur_id)
    );

    CREATE INDEX IF NOT EXISTS idx_ff_fournisseur ON factures_fournisseurs(fournisseur_id);
    CREATE INDEX IF NOT EXISTS idx_ff_statut      ON factures_fournisseurs(statut);
    CREATE INDEX IF NOT EXISTS idx_ff_bc          ON factures_fournisseurs(bc_id);
    CREATE INDEX IF NOT EXISTS idx_ff_echeance    ON factures_fournisseurs(date_echeance);
  `);

  // Migrations colonnes achat (idempotentes)
  addColumnIfMissing('bons_commandes_fournisseurs', 'motif_annulation', 'TEXT');
  addColumnIfMissing('bons_commandes_fournisseurs', 'notes',            'TEXT');
  addColumnIfMissing('factures_fournisseurs',       'motif_contestation','TEXT');
  addColumnIfMissing('factures_fournisseurs',       'notes',            'TEXT');
  addColumnIfMissing('factures_fournisseurs',       'operation_id',     'INTEGER');

  // =============================================
  // MODULE CONTRATS & PAIEMENTS RÉCURRENTS (Prompt 6)
  // =============================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS contrats (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      numero               TEXT UNIQUE NOT NULL,
      partie_id            INTEGER NOT NULL,
      partie_type          TEXT NOT NULL
                           CHECK(partie_type IN ('client','fournisseur','employe')),
      type_contrat         TEXT NOT NULL
                           CHECK(type_contrat IN (
                             'client','fournisseur','prestation','maintenance',
                             'abonnement','location','bail','salaire','cadre'
                           )),
      objet                TEXT NOT NULL,
      date_debut           TEXT NOT NULL,
      date_fin             TEXT,
      duree_mois           INTEGER,
      renouvellement_auto  INTEGER NOT NULL DEFAULT 0,
      montant              REAL NOT NULL DEFAULT 0,
      periodicite          TEXT NOT NULL DEFAULT 'mois'
                           CHECK(periodicite IN (
                             'jour','semaine','mois','trimestre','semestre','annee'
                           )),
      conditions_paiement  TEXT,
      penalites            TEXT,
      obligations          TEXT,
      statut               TEXT NOT NULL DEFAULT 'brouillon'
                           CHECK(statut IN (
                             'brouillon','en_validation','signe','actif',
                             'suspendu','resilie','expire','renouvele','cloture','litige'
                           )),
      motif_suspension     TEXT,
      motif_resiliation    TEXT,
      date_resiliation     TEXT,
      contrat_parent_id    INTEGER REFERENCES contrats(id),
      notes                TEXT,
      created_by           INTEGER REFERENCES users(id),
      created_at           TEXT DEFAULT (datetime('now')),
      updated_at           TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_contrats_partie    ON contrats(partie_id, partie_type);
    CREATE INDEX IF NOT EXISTS idx_contrats_statut    ON contrats(statut);
    CREATE INDEX IF NOT EXISTS idx_contrats_numero    ON contrats(numero);
    CREATE INDEX IF NOT EXISTS idx_contrats_date_fin  ON contrats(date_fin);

    CREATE TABLE IF NOT EXISTS contrats_echeances (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      contrat_id   INTEGER NOT NULL REFERENCES contrats(id) ON DELETE CASCADE,
      date_echeance TEXT NOT NULL,
      montant      REAL NOT NULL DEFAULT 0,
      statut       TEXT NOT NULL DEFAULT 'a_facturer'
                   CHECK(statut IN (
                     'a_facturer','facture','paye','en_retard','annule'
                   )),
      facture_id   INTEGER,
      created_at   TEXT DEFAULT (datetime('now')),
      updated_at   TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_ech_contrat ON contrats_echeances(contrat_id);
    CREATE INDEX IF NOT EXISTS idx_ech_date    ON contrats_echeances(date_echeance);
    CREATE INDEX IF NOT EXISTS idx_ech_statut  ON contrats_echeances(statut);
  `);

  // Migrations colonnes contrats (idempotentes)
  addColumnIfMissing('contrats', 'motif_suspension',  'TEXT');
  addColumnIfMissing('contrats', 'motif_resiliation', 'TEXT');
  addColumnIfMissing('contrats', 'date_resiliation',  'TEXT');
  addColumnIfMissing('contrats', 'contrat_parent_id', 'INTEGER');
  addColumnIfMissing('contrats', 'notes',             'TEXT');

  // =============================================
  // MODULE RAPPROCHEMENT BANCAIRE & CLÔTURE CAISSE (Prompt 7)
  // =============================================
  db.exec(`
    CREATE TABLE IF NOT EXISTS rapprochements_bancaires (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      compte_id             INTEGER NOT NULL REFERENCES positions(id),
      periode_debut         TEXT NOT NULL,
      periode_fin           TEXT NOT NULL,
      solde_releve_bancaire REAL NOT NULL DEFAULT 0,
      solde_systeme         REAL NOT NULL DEFAULT 0,
      ecart                 REAL NOT NULL DEFAULT 0,
      statut                TEXT NOT NULL DEFAULT 'en_cours'
                            CHECK(statut IN (
                              'en_cours','conforme','ecart_positif',
                              'ecart_negatif','a_expliquer','valide','corrige'
                            )),
      notes_ecart           TEXT,
      validateur_id         INTEGER REFERENCES users(id),
      date_validation       TEXT,
      created_by            INTEGER REFERENCES users(id),
      created_at            TEXT DEFAULT (datetime('now')),
      updated_at            TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_rapproch_compte  ON rapprochements_bancaires(compte_id);
    CREATE INDEX IF NOT EXISTS idx_rapproch_statut  ON rapprochements_bancaires(statut);
    CREATE INDEX IF NOT EXISTS idx_rapproch_periode ON rapprochements_bancaires(periode_debut, periode_fin);

    CREATE TABLE IF NOT EXISTS rapprochements_lignes (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      rapprochement_id  INTEGER NOT NULL REFERENCES rapprochements_bancaires(id) ON DELETE CASCADE,
      operation_id      INTEGER REFERENCES operations(id),
      description       TEXT NOT NULL,
      montant           REAL NOT NULL DEFAULT 0,
      type              TEXT NOT NULL DEFAULT 'autre'
                        CHECK(type IN (
                          'encaissement','decaissement','frais_bancaire',
                          'cheque_en_attente','depot_non_credite','erreur','autre'
                        )),
      rapproche         INTEGER NOT NULL DEFAULT 0,
      created_at        TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_rapl_rapproch ON rapprochements_lignes(rapprochement_id);
    CREATE INDEX IF NOT EXISTS idx_rapl_op       ON rapprochements_lignes(operation_id);

    CREATE TABLE IF NOT EXISTS caisses_clotures (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      position_id              INTEGER NOT NULL REFERENCES positions(id),
      date_cloture             TEXT NOT NULL,
      caissier_id              INTEGER NOT NULL REFERENCES users(id),
      solde_logiciel_ouverture REAL NOT NULL DEFAULT 0,
      solde_logiciel_cloture   REAL NOT NULL DEFAULT 0,
      solde_physique_declare   REAL NOT NULL DEFAULT 0,
      ecart                    REAL NOT NULL DEFAULT 0,
      statut                   TEXT NOT NULL DEFAULT 'en_attente'
                               CHECK(statut IN (
                                 'en_attente','conforme','ecart_positif',
                                 'ecart_negatif','a_expliquer','valide'
                               )),
      validateur_id            INTEGER REFERENCES users(id),
      notes                    TEXT,
      created_at               TEXT DEFAULT (datetime('now')),
      updated_at               TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_cloture_position ON caisses_clotures(position_id);
    CREATE INDEX IF NOT EXISTS idx_cloture_date     ON caisses_clotures(date_cloture DESC);
    CREATE INDEX IF NOT EXISTS idx_cloture_statut   ON caisses_clotures(statut);
  `);

  // Migrations idempotentes rapprochement
  addColumnIfMissing('rapprochements_bancaires', 'notes_ecart',     'TEXT');
  addColumnIfMissing('rapprochements_bancaires', 'date_validation',  'TEXT');
  addColumnIfMissing('caisses_clotures',         'notes',            'TEXT');
}

// ─── PROMPT 13 — Grilles salariales ──────────────────────────────────────────
function migrateGrillesSalariales() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS grilles_salariales (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      code         TEXT NOT NULL UNIQUE,
      libelle      TEXT NOT NULL,
      date_debut   TEXT NOT NULL,
      date_fin     TEXT,
      statut       TEXT NOT NULL DEFAULT 'brouillon'
                   CHECK(statut IN ('brouillon','soumis','valide','archive')),
      created_by   INTEGER REFERENCES users(id),
      approved_by  INTEGER REFERENCES users(id),
      approved_at  TEXT,
      created_at   TEXT DEFAULT (datetime('now')),
      updated_at   TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS grille_categories (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      grille_id       INTEGER NOT NULL REFERENCES grilles_salariales(id) ON DELETE CASCADE,
      code            TEXT NOT NULL,
      libelle         TEXT NOT NULL,
      salaire_min     REAL NOT NULL DEFAULT 0,
      salaire_max     REAL,
      coefficient_min REAL,
      coefficient_max REAL,
      actif           INTEGER NOT NULL DEFAULT 1,
      UNIQUE(grille_id, code)
    );

    CREATE TABLE IF NOT EXISTS grille_echelons (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      categorie_id        INTEGER NOT NULL REFERENCES grille_categories(id) ON DELETE CASCADE,
      echelon             INTEGER NOT NULL DEFAULT 1,
      salaire_reference   REAL NOT NULL DEFAULT 0,
      salaire_min         REAL NOT NULL DEFAULT 0,
      salaire_max         REAL,
      prime_transport     REAL NOT NULL DEFAULT 0,
      prime_logement      REAL NOT NULL DEFAULT 0,
      anciennete_min_ans  INTEGER NOT NULL DEFAULT 0,
      actif               INTEGER NOT NULL DEFAULT 1,
      UNIQUE(categorie_id, echelon)
    );

    CREATE INDEX IF NOT EXISTS idx_grille_cat_grille ON grille_categories(grille_id);
    CREATE INDEX IF NOT EXISTS idx_grille_ech_cat    ON grille_echelons(categorie_id);
  `);

  addColumnIfMissing('employes', 'grille_categorie_id', 'INTEGER');
  addColumnIfMissing('employes', 'grille_echelon_id',   'INTEGER');
}

// ─── PROMPT 14 — Historique salaires + verrous + colonnes bulletins/avances ──
function migrateHistoriqueSalaires() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS demandes_revision_salaire (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      employe_id            INTEGER NOT NULL REFERENCES employes(id),
      type_revision         TEXT NOT NULL DEFAULT 'augmentation'
                            CHECK(type_revision IN (
                              'augmentation','promotion','correction','indexation'
                            )),
      date_effet            TEXT NOT NULL,
      salaire_actuel        REAL,
      salaire_propose       REAL NOT NULL,
      transport_actuel      REAL,
      transport_propose     REAL,
      logement_actuel       REAL,
      logement_propose      REAL,
      nouvelle_categorie_id INTEGER REFERENCES grille_categories(id),
      nouvel_echelon_id     INTEGER REFERENCES grille_echelons(id),
      motif                 TEXT NOT NULL,
      document_url          TEXT,
      statut                TEXT NOT NULL DEFAULT 'brouillon'
                            CHECK(statut IN (
                              'brouillon','soumis_rh','soumis_dg',
                              'approuve','rejete','ajourne','annule','applique'
                            )),
      avis_rh               TEXT,
      valide_rh_by          INTEGER REFERENCES users(id),
      valide_rh_at          TEXT,
      avis_dg               TEXT,
      valide_dg_by          INTEGER REFERENCES users(id),
      valide_dg_at          TEXT,
      motif_rejet           TEXT,
      created_by            INTEGER REFERENCES users(id),
      created_at            TEXT DEFAULT (datetime('now')),
      updated_at            TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS historique_salaires (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      employe_id            INTEGER NOT NULL REFERENCES employes(id),
      date_effet            TEXT NOT NULL,
      ancien_salaire        REAL,
      nouveau_salaire       REAL,
      ancien_transport      REAL,
      nouveau_transport     REAL,
      ancien_logement       REAL,
      nouveau_logement      REAL,
      ancienne_categorie_id INTEGER REFERENCES grille_categories(id),
      nouvelle_categorie_id INTEGER REFERENCES grille_categories(id),
      ancien_echelon_id     INTEGER REFERENCES grille_echelons(id),
      nouvel_echelon_id     INTEGER REFERENCES grille_echelons(id),
      motif                 TEXT NOT NULL,
      type_revision         TEXT NOT NULL DEFAULT 'correction'
                            CHECK(type_revision IN (
                              'embauche','augmentation','correction',
                              'promotion','indexation','regularisation','sanction'
                            )),
      demande_revision_id   INTEGER REFERENCES demandes_revision_salaire(id),
      approved_by           INTEGER REFERENCES users(id),
      approved_at           TEXT,
      created_by            INTEGER REFERENCES users(id),
      created_at            TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_hist_sal_employe ON historique_salaires(employe_id);
    CREATE INDEX IF NOT EXISTS idx_hist_sal_date    ON historique_salaires(date_effet DESC);
    CREATE INDEX IF NOT EXISTS idx_rev_sal_employe  ON demandes_revision_salaire(employe_id);
    CREATE INDEX IF NOT EXISTS idx_rev_sal_statut   ON demandes_revision_salaire(statut);
  `);

  // Colonnes bulletins_salaire
  addColumnIfMissing('bulletins_salaire', 'generated_by',          'INTEGER');
  addColumnIfMissing('bulletins_salaire', 'validated_by',          'INTEGER');
  addColumnIfMissing('bulletins_salaire', 'type',                  "TEXT NOT NULL DEFAULT 'normal'");
  addColumnIfMissing('bulletins_salaire', 'reference_bulletin_id', 'INTEGER');

  // Colonnes employes_avances (workflow approbation)
  addColumnIfMissing('employes_avances', 'statut_workflow', "TEXT NOT NULL DEFAULT 'approuve'");
  addColumnIfMissing('employes_avances', 'operation_id',    'INTEGER');
  addColumnIfMissing('employes_avances', 'approuve_par',    'INTEGER');
  addColumnIfMissing('employes_avances', 'approuve_at',     'TEXT');
  addColumnIfMissing('employes_avances', 'rejete_par',      'INTEGER');
  addColumnIfMissing('employes_avances', 'rejete_at',       'TEXT');
  addColumnIfMissing('employes_avances', 'motif_rejet',     'TEXT');

  // Colonnes paiements CNSS/DGI pour lien caisse
  addColumnIfMissing('cnss_paiements', 'operation_id', 'INTEGER');
  addColumnIfMissing('dgi_paiements',  'operation_id', 'INTEGER');

  // Lien agent → contrat de travail
  addColumnIfMissing('employes', 'contrat_id', 'INTEGER');
}

// ─── PROMPT 15 — Périodes paie + rectifications + sanctions + sortie + heures_sup
function migratePeriodesPaieEtRH() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS periodes_paie (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      mois                  INTEGER NOT NULL CHECK(mois BETWEEN 1 AND 12),
      annee                 INTEGER NOT NULL,
      statut                TEXT NOT NULL DEFAULT 'ouverte'
                            CHECK(statut IN (
                              'ouverte','preparation','controle_rh',
                              'controle_finance','soumis_dg','validee_dg',
                              'paiement_en_cours','payee_partielle',
                              'payee','cloturee','rouverte_exception'
                            )),
      nb_bulletins_generes  INTEGER NOT NULL DEFAULT 0,
      nb_bulletins_valides  INTEGER NOT NULL DEFAULT 0,
      nb_bulletins_payes    INTEGER NOT NULL DEFAULT 0,
      total_brut            REAL NOT NULL DEFAULT 0,
      total_net             REAL NOT NULL DEFAULT 0,
      total_charges         REAL NOT NULL DEFAULT 0,
      soumis_dg_by          INTEGER REFERENCES users(id),
      soumis_dg_at          TEXT,
      valide_dg_by          INTEGER REFERENCES users(id),
      valide_dg_at          TEXT,
      cloture_by            INTEGER REFERENCES users(id),
      cloture_at            TEXT,
      notes                 TEXT,
      created_at            TEXT DEFAULT (datetime('now')),
      updated_at            TEXT DEFAULT (datetime('now')),
      UNIQUE(mois, annee)
    );

    CREATE TABLE IF NOT EXISTS rectifications_bulletins (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      bulletin_id          INTEGER NOT NULL REFERENCES bulletins_salaire(id),
      employe_id           INTEGER NOT NULL REFERENCES employes(id),
      periode_id           INTEGER REFERENCES periodes_paie(id),
      type                 TEXT NOT NULL DEFAULT 'erreur_prime'
                           CHECK(type IN (
                             'trop_percu','moins_percu','erreur_prime',
                             'erreur_retenue','autre'
                           )),
      sens                 TEXT NOT NULL DEFAULT 'debit_agent'
                           CHECK(sens IN ('debit_agent','credit_agent')),
      montant              REAL NOT NULL CHECK(montant > 0),
      motif                TEXT NOT NULL,
      statut               TEXT NOT NULL DEFAULT 'brouillon'
                           CHECK(statut IN (
                             'brouillon','soumis','approuve','rejete','applique'
                           )),
      approuve_par         INTEGER REFERENCES users(id),
      approuve_at          TEXT,
      applied_bulletin_id  INTEGER REFERENCES bulletins_salaire(id),
      created_by           INTEGER REFERENCES users(id),
      created_at           TEXT DEFAULT (datetime('now')),
      updated_at           TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS employes_sanctions (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      employe_id            INTEGER NOT NULL REFERENCES employes(id),
      type                  TEXT NOT NULL DEFAULT 'avertissement_ecrit'
                            CHECK(type IN (
                              'avertissement_verbal','avertissement_ecrit',
                              'mise_a_pied','licenciement_cause_reelle','autre'
                            )),
      date_sanction         TEXT NOT NULL,
      motif_detaille        TEXT NOT NULL,
      nb_jours_mise_a_pied  INTEGER NOT NULL DEFAULT 0,
      retenue_calculee      REAL NOT NULL DEFAULT 0,
      document_url          TEXT,
      statut                TEXT NOT NULL DEFAULT 'projet'
                            CHECK(statut IN ('projet','notifie','conteste','clos')),
      conteste_motif        TEXT,
      annule_at             TEXT,
      annule_by             INTEGER REFERENCES users(id),
      annule_motif          TEXT,
      created_by            INTEGER REFERENCES users(id),
      created_at            TEXT DEFAULT (datetime('now')),
      updated_at            TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS employes_sortie (
      id                        INTEGER PRIMARY KEY AUTOINCREMENT,
      employe_id                INTEGER NOT NULL UNIQUE REFERENCES employes(id),
      type_sortie               TEXT NOT NULL DEFAULT 'demission'
                                CHECK(type_sortie IN (
                                  'demission','licenciement','retraite',
                                  'fin_contrat','deces','rupture_conventionnelle'
                                )),
      date_annonce              TEXT,
      date_fin_preavis          TEXT,
      date_depart_effectif      TEXT,
      anciennete_annees         REAL NOT NULL DEFAULT 0,
      indemnite_licenciement    REAL NOT NULL DEFAULT 0,
      indemnite_preavis         REAL NOT NULL DEFAULT 0,
      conges_payes_restants     REAL NOT NULL DEFAULT 0,
      conges_payes_montant      REAL NOT NULL DEFAULT 0,
      autres_indemnites         REAL NOT NULL DEFAULT 0,
      solde_tout_compte_total   REAL NOT NULL DEFAULT 0,
      statut                    TEXT NOT NULL DEFAULT 'initie'
                                CHECK(statut IN ('initie','calcule','valide','solde')),
      checklist_materiel        TEXT,
      checklist_acces           TEXT,
      notes                     TEXT,
      created_by                INTEGER REFERENCES users(id),
      validated_by              INTEGER REFERENCES users(id),
      validated_at              TEXT,
      created_at                TEXT DEFAULT (datetime('now')),
      updated_at                TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS employes_heures_sup (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      employe_id       INTEGER NOT NULL REFERENCES employes(id),
      mois             INTEGER NOT NULL CHECK(mois BETWEEN 1 AND 12),
      annee            INTEGER NOT NULL,
      date_heures      TEXT NOT NULL,
      nb_heures        REAL NOT NULL CHECK(nb_heures > 0),
      type             TEXT NOT NULL DEFAULT 'normal'
                       CHECK(type IN ('normal','dimanche','ferie')),
      taux_majoration  REAL NOT NULL DEFAULT 1.25,
      montant_brut     REAL NOT NULL DEFAULT 0,
      statut           TEXT NOT NULL DEFAULT 'saisi'
                       CHECK(statut IN ('saisi','valide','integre_bulletin')),
      valide_par       INTEGER REFERENCES users(id),
      bulletin_id      INTEGER REFERENCES bulletins_salaire(id),
      motif            TEXT,
      created_by       INTEGER REFERENCES users(id),
      created_at       TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_periodes_paie_periode  ON periodes_paie(annee DESC, mois DESC);
    CREATE INDEX IF NOT EXISTS idx_rectif_bul_bulletin    ON rectifications_bulletins(bulletin_id);
    CREATE INDEX IF NOT EXISTS idx_rectif_bul_employe     ON rectifications_bulletins(employe_id);
    CREATE INDEX IF NOT EXISTS idx_rectif_bul_statut      ON rectifications_bulletins(statut);
    CREATE INDEX IF NOT EXISTS idx_sanction_employe       ON employes_sanctions(employe_id);
    CREATE INDEX IF NOT EXISTS idx_sanction_statut        ON employes_sanctions(statut);
    CREATE INDEX IF NOT EXISTS idx_heures_sup_employe     ON employes_heures_sup(employe_id);
    CREATE INDEX IF NOT EXISTS idx_heures_sup_periode     ON employes_heures_sup(annee DESC, mois DESC);
  `);

  // Lien bulletins → période de paie
  addColumnIfMissing('bulletins_salaire', 'periode_id', 'INTEGER');

  // Congés maladie compteur séparé
  addColumnIfMissing('employes', 'conges_maladie_droit',  'REAL DEFAULT 15');
  addColumnIfMissing('employes', 'conges_maladie_pris',   'REAL DEFAULT 0');
  addColumnIfMissing('employes', 'conges_maladie_solde',  'REAL DEFAULT 15');

  // Mutations : colonnes workflow approbation
  addColumnIfMissing('employes_mutations', 'statut',       "TEXT DEFAULT 'propose'");
  addColumnIfMissing('employes_mutations', 'approuve_par', 'INTEGER');
  addColumnIfMissing('employes_mutations', 'approuve_at',  'TEXT');
  addColumnIfMissing('employes_mutations', 'date_effective','TEXT');
  addColumnIfMissing('employes_mutations', 'avenant_pdf',  'TEXT');
  addColumnIfMissing('employes_mutations', 'motif_refus',  'TEXT');

  // ── Rapprochement 3 voies BC↔Réception↔Facture (idempotent) ──
  addColumnIfMissing('factures_fournisseurs', 'rapprochement_statut',
    "TEXT DEFAULT 'non_rapproche' CHECK(rapprochement_statut IN " +
    "('non_rapproche','conforme','ecart_acceptable','ecart_bloquant','conteste'))");
  addColumnIfMissing('factures_fournisseurs', 'rapprochement_at',  'TEXT');
  addColumnIfMissing('factures_fournisseurs', 'rapprochement_by',  'INTEGER');
  addColumnIfMissing('factures_fournisseurs', 'ecart_montant',     'REAL DEFAULT 0');
  addColumnIfMissing('factures_fournisseurs', 'ecart_quantite',    'REAL DEFAULT 0');
  addColumnIfMissing('factures_fournisseurs', 'ecart_motif',       'TEXT');
  addColumnIfMissing('factures_fournisseurs', 'operation_id',      'INTEGER');

  // Paramètres rapprochement 3 voies (insérés si absents)
  const insParamRapp = db.prepare("INSERT OR IGNORE INTO parametres (cle, valeur) VALUES (?, ?)");
  insParamRapp.run('rapprochement_seuil_pct', '2'); // seuil d'écart toléré en %
  insParamRapp.run('rapprochement_auto_avant_paiement', '1'); // 1 = actif

  // Paramètres paie avancés (insérés si absents)
  const insParam = db.prepare(
    "INSERT OR IGNORE INTO parametres (cle, valeur) VALUES (?, ?)"
  );
  insParam.run('anciennete_actif',        '0');
  insParam.run('anciennete_taux_pct',     '2');
  insParam.run('anciennete_plafond_pct',  '20');
  insParam.run('treizieme_actif',         '0');
  insParam.run('treizieme_mois',          '12');
  insParam.run('treizieme_mode',          'annuel_divise_12');
  insParam.run('heures_sup_taux_normal',   '1.25');
  insParam.run('heures_sup_taux_dimanche', '1.50');
  insParam.run('heures_sup_taux_ferie',    '2.00');
  insParam.run('heures_sup_plafond_mois',  '40');
  insParam.run('avance_plafond_mois',      '1');
}
