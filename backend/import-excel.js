/**
 * Import des données depuis GESTION CAISSE-TOP-CENTER 2025.xlsx
 * Usage: node import-excel.js [chemin-vers-fichier-xlsx]
 *
 * Importe toutes les opérations de l'historique Excel dans la base SQLite.
 * Cet outil historique est volontairement SQLite-only et ne doit jamais charger
 * la façade MySQL synchrone.
 */
const path = require('path');

if ((process.env.DB_DRIVER || 'sqlite').toLowerCase() === 'mysql') {
  throw new Error('import-excel.js est un outil SQLite-only; utilisez une migration/import MySQL dédié.');
}

const db = require('./database');

const XLSX_PATH = process.argv[2] || path.join(__dirname, '../../GESTION CAISSE-TOP-CENTER 2025.xlsx');

async function importExcel() {
  // Charger xlsx dynamiquement
  let XLSX;
  try {
    XLSX = require('xlsx');
  } catch {
    console.error('Module xlsx manquant. Installation...');
    require('child_process').execSync('npm install xlsx', { cwd: __dirname, stdio: 'inherit' });
    XLSX = require('xlsx');
  }

  console.log('📂 Lecture du fichier:', XLSX_PATH);
  const wb = XLSX.readFile(XLSX_PATH);
  console.log('📋 Feuilles trouvées:', wb.SheetNames.join(', '));

  let totalImported = 0;
  let solde = 0;

  // Récupérer les catégories
  const cats = db.prepare('SELECT * FROM categories').all();
  const catMap = {};
  cats.forEach(c => catMap[c.nom.toLowerCase()] = c.id);

  // Catégorisation automatique basée sur le détail
  function findCat(...terms) {
    const normalized = terms.map(t => t.toLowerCase());
    return cats.find(c => normalized.some(t => c.nom.toLowerCase().includes(t)))?.id;
  }

  function detectCategorie(detail) {
    if (!detail) return null;
    const d = detail.toLowerCase();
    if (d.includes('remboursement') || d.includes('dette') && d.includes('remboursement')) return findCat('remboursement');
    if (d.includes('salaire') || d.includes('gratification') || d.includes('arrierés') || d.includes('arriérés')) return findCat('salaires permanents', 'gratification', 'salaire');
    if (d.includes('transport')) return findCat('transport');
    if (d.includes('loyer')) return findCat('loyer');
    if (d.includes('mtn') || d.includes('airtel') || d.includes('congo telecom')) return findCat('télécom', 'telecom');
    if (d.includes('canva') || d.includes('chatgpt') || d.includes('claude') || d.includes('cursor') || d.includes('vps') || d.includes('serveur') || d.includes('abonnement')) return findCat('abonnements numériques');
    if (d.includes('cnss') || d.includes('camu')) return findCat('charges sociales');
    if (d.includes('impots') || d.includes('impôts')) return findCat('impôts', 'taxes');
    if (d.includes('achat') || d.includes('confection') || d.includes('impression') || d.includes('materiel') || d.includes('matériel')) return findCat('achats', 'fournitures');
    if (d.includes('frais de gestion')) return findCat('frais de gestion');
    if (d.includes('carburant') || d.includes('essence')) return findCat('carburant');
    if (d.includes('electricité') || d.includes('électricité') || d.includes('electricite')) return findCat('électricité', 'electricité');
    if (d.includes('travaux') || d.includes('peinture') || d.includes('electricien') || d.includes('panneau') || d.includes('fenetre') || d.includes('fenêtre')) return findCat('travaux', 'maintenance');
    return null;
  }

  // Détecte l'employé dans le détail
  const employes = db.prepare('SELECT * FROM employes').all();
  function detectEmploye(detail) {
    if (!detail) return null;
    const d = detail.toLowerCase();
    for (const e of employes) {
      if (d.includes(e.nom.toLowerCase()) || d.includes(e.prenom.toLowerCase())) return e.id;
    }
    return null;
  }

  // Convertir une date Excel en ISO string
  function parseDate(val) {
    if (!val) return null;
    if (typeof val === 'string') {
      // Formats: "11/14/25", "17/11/2025", "1/5/26" etc.
      const str = val.trim();
      // mm/dd/yy
      let m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
      if (m) {
        let year = parseInt(m[3]);
        if (year < 100) year += 2000;
        const month = String(m[1]).padStart(2,'0');
        const day = String(m[2]).padStart(2,'0');
        return `${year}-${month}-${day}`;
      }
      // dd/mm/yyyy
      m = str.match(/^\s*(\d{1,2})\/(\d{2})\/(\d{4})\s*$/);
      if (m) {
        return `${m[3]}-${m[1].padStart(2,'0')}-${m[2]}`;
      }
    }
    return null;
  }

  // Nettoyer un montant (ex: " 2,000   " → 2000)
  function parseAmount(val) {
    if (!val) return 0;
    const str = String(val).replace(/\s/g,'').replace(/,/g,'').replace(/-/g,'0');
    const n = parseFloat(str);
    return isNaN(n) ? 0 : n;
  }

  // Vérifier si l'import a déjà été fait
  const existingCount = db.prepare('SELECT COUNT(*) as c FROM operations').get().c;
  if (existingCount > 0) {
    console.log(`⚠️  La base contient déjà ${existingCount} opérations.`);
    const answer = process.argv[3];
    if (answer !== '--force') {
      console.log('   Pour forcer l\'import, utilisez: node import-excel.js [fichier] --force');
      process.exit(0);
    }
    console.log('   Mode --force activé, import en cours...');
  }

  // Récupérer l'admin user ID
  const adminUser = db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get();
  const userId = adminUser?.id || 1;

  // Insert statement
  const insertOp = db.prepare(`INSERT INTO operations
    (date, num_piece, libelle, montant, type_op, position_id, solde_position,
     categorie_id, mode_reglement, decharge_signee, employe_id, created_by)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`);

  const importAll = db.transaction(() => {
    wb.SheetNames.forEach(sheetName => {
      const ws = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false });
      console.log(`\n📊 Feuille: "${sheetName}" — ${rows.length} lignes`);

      let imported = 0;
      let lastValidDate = null;

      rows.forEach((row, idx) => {
        // Colonnes: [0-1]=vide, [2]=date, [3]=detail, [4]=npiece, [5]=recette, [6]=depense, [7]=solde
        if (!row || row.length < 6) return;

        const rawDate = row[2];
        const rawDetail = row[3];
        const rawPiece = row[4];
        const rawRecette = row[5];
        const rawDepense = row[6];

        // Ignorer les lignes d'en-tête/résumé
        if (!rawDetail || typeof rawDetail !== 'string') return;
        const detailStr = rawDetail.trim();
        if (detailStr.length < 3) return;
        if (detailStr.toUpperCase().includes('DÉTAIL') || detailStr.toUpperCase().includes('DETAIL') ||
            detailStr.toUpperCase().includes('ETAT DE CAISSE') || detailStr.toUpperCase().includes('REPORT')) {
          // C'est le report à nouveau → on le traite comme une recette initiale
          if (detailStr.toLowerCase().includes('report à nouveau') || detailStr.toLowerCase().includes('report a nouveau')) {
            const soldeInit = parseAmount(row[7]);
            if (soldeInit > 0) {
              solde = soldeInit; // Le solde de départ sera le report
              return;
            }
          }
          return;
        }

        const dateStr = parseDate(rawDate) || lastValidDate;
        if (!dateStr) return; // Pas de date, ignorer
        if (rawDate) lastValidDate = dateStr;

        const recette = parseAmount(rawRecette);
        const depense = parseAmount(rawDepense);
        if (recette === 0 && depense === 0) return; // Ligne vide (ex: remise de chèque info)

        solde = solde + recette - depense;

        const catId = detectCategorie(detailStr);
        const empId = detectEmploye(detailStr);
        const isDecharge = detailStr.toLowerCase().includes('salaire') ? 1 : 0;
        const typeOp = recette > 0 ? 'encaissement' : 'decaissement';
        const montant = recette > 0 ? recette : depense;

        insertOp.run(
          dateStr, rawPiece || null, detailStr,
          montant, typeOp, solde,
          catId || null, 'especes', isDecharge,
          empId || null, userId
        );
        imported++;
        totalImported++;
      });

      console.log(`   ✅ ${imported} opérations importées`);
    });
  });

  importAll();

  console.log(`\n🎉 Import terminé ! ${totalImported} opérations importées au total.`);
  console.log(`   Solde final calculé: ${solde.toLocaleString('fr-FR')} XAF`);
}

importExcel().catch(err => {
  console.error('❌ Erreur import:', err.message);
  process.exit(1);
});
