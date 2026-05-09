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
module.exports = db;

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
      '["admin","finance","caissier"]',          null,null, 24,'{}');
    seedRegles.run('NOTIF_OP_ANNULE',          'notification','avertissement',
      'Opération annulée',                       1,0,0,0,
      '["admin","finance","caissier"]',          null,null, 24,'{}');
    seedRegles.run('NOTIF_BULLETIN_VALIDE',    'notification','info',
      'Bulletin validé',                         1,0,0,0,
      '["admin","rh"]',                          null,null, 24,'{}');
    seedRegles.run('NOTIF_BULLETIN_PAYE',      'notification','info',
      'Bulletin payé',                           1,1,0,0,
      '["admin","rh"]',                          null,null, 24,'{}');
    seedRegles.run('NOTIF_ACHAT_APPROUVE',     'notification','info',
      'Demande d\'achat approuvée',              1,1,0,0,
      '["admin","finance"]',                     null,null, 24,'{}');
    seedRegles.run('NOTIF_ACHAT_REJETE',       'notification','avertissement',
      'Demande d\'achat rejetée',                1,1,0,0,
      '["admin"]',                               null,null, 24,'{}');
    seedRegles.run('NOTIF_CONGE_APPROUVE',     'notification','info',
      'Congé approuvé',                          1,0,0,0,
      '["admin","rh"]',                          null,null, 24,'{}');
    seedRegles.run('NOTIF_CONGE_REFUSE',       'notification','avertissement',
      'Congé refusé',                            1,0,0,0,
      '["admin","rh"]',                          null,null, 24,'{}');
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
      '["admin","finance","caissier"]',          null,null,
      0,'{"seuil_cle":"seuil_alerte"}');
    seedRegles.run('ALRT_SOLDE_CRITIQUE',      'alerte','critique',
      'Solde position sous seuil critique',      1,1,0,1,
      '["admin","finance","caissier"]',          120,'["admin"]',
      0,'{"seuil_cle":"seuil_critique"}');
    seedRegles.run('ALRT_SOLDE_NEGATIF',       'alerte','bloquant',
      'Solde position négatif — décaissements bloqués', 1,1,0,1,
      '["admin","finance"]',                     30,'["admin"]',
      0,'{}');
    seedRegles.run('ALRT_DEC_SOUMIS',          'alerte','avertissement',
      'Décaissement soumis en attente de validation', 1,1,0,0,
      '["admin","finance"]',                     48,'["admin"]',
      0,'{"delai_h_cle":"alrt_dec_valid_h"}');
    seedRegles.run('ALRT_DEC_VALIDE_NON_PAYE', 'alerte','avertissement',
      'Décaissement validé non payé',            1,0,0,0,
      '["admin","finance","caissier"]',          null,null,
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
    'Congé validé par le supérieur — en attente RH',
    1, 1, 0, 0,
    '["admin","rh"]', null, null, 24, '{}'
  );
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
}
