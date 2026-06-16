#!/usr/bin/env node
'use strict';

/**
 * Import controle du classeur caisse Top Center vers MySQL.
 *
 * Par defaut ce script est un dry-run. Il n'ecrit rien sans :
 *   --apply --replace-existing --i-understand-this-replaces-production-cash
 *
 * Les lignes dont le solde Excel contredit recette/depense bloquent l'import.
 * Pour les traiter, il faut une decision explicite :
 *   --trust-solde-column-for-balance-breaks
 */

const fs = require('fs');
const XLSX = require('../backend/node_modules/xlsx');
const db = require('../backend/db');

const DEFAULT_FILE = '/mnt/c/Users/Gess/OneDrive/Documents/GESTION CAISSE-TOP-CENTER 2025 (2).xlsx';
const DEFAULT_SHEET = 'Nov-Dec-2025';
const DEFAULT_USER_EMAIL = 'princilia.louvouezo@topcenter.cg';
const DEFAULT_POSITION_CODE = 'CAISSE';

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find(arg => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function parseAmount(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const normalized = String(value)
    .replace(/\u00a0/g, ' ')
    .replace(/\s/g, '')
    .replace(/,/g, '')
    .replace(/[A-Za-z]/g, '')
    .trim();
  if (!normalized || normalized === '-') return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) ? amount : null;
}

function parseDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  let match = raw.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
  if (match) {
    let year = Number(match[3]);
    if (year < 100) year += 2000;
    const month = Number(match[1]);
    const day = Number(match[2]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    return null;
  }
  match = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) {
    return `${match[1]}-${String(Number(match[2])).padStart(2, '0')}-${String(Number(match[3])).padStart(2, '0')}`;
  }
  return null;
}

function isHeaderRow(dateCell, detail) {
  return /date|d[ée]tail|etat|total/i.test(`${dateCell || ''} ${detail || ''}`);
}

function categorizeByName(libelle, typeOp, categories) {
  const text = String(libelle || '').toLowerCase();
  const want = (name) => categories.find(c => c.nom.toLowerCase() === name.toLowerCase());
  const contains = (...terms) => terms.some(term => text.includes(term));

  if (typeOp === 'encaissement') {
    if (contains('remboursement', 'dette')) return want('Remboursements reçus');
    if (contains('subvention', 'financement', 'appro caisse', 'retrait')) return want('Subventions & financements');
    if (contains('prestation', 'service')) return want('Prestations de services');
    return want('Autres recettes');
  }

  if (contains('stagiaire')) return want('Salaires stagiaires');
  if (contains('gratification', 'prime', 'anniversaire')) return want('Gratifications & primes');
  if (contains('salaire')) return want('Salaires permanents');
  if (contains('loyer')) return want('Loyer & charges locatives');
  if (contains('transport', 'taxi', 'bus')) return want('Transport & déplacements');
  if (contains('mtn', 'airtel', 'congo telecom', 'telecom', 'internet', 'forfait', 'recharge')) return want('Télécom (MTN/AIRTEL/CT)');
  if (contains('cnss', 'camu')) return want('Charges sociales CNSS/CAMU');
  if (contains('impot', 'impôt', 'declaration d\'impot', 'déclaration d’impôt')) return want('Impôts & taxes');
  if (contains('canva', 'chatgpt', 'vps', 'serveur', 'abonnement', 'carte visa')) return want('Abonnements numériques');
  if (contains('frais de gestion', 'frais gestion')) return want('Frais de gestion');
  if (contains('carburant')) return want('Carburant');
  if (contains('électricité', 'electricite')) return want('Électricité');
  if (contains('travaux', 'maintenance', 'reparation', 'réparation', 'installation', 'cablage', 'câblage', 'plombier', 'soudeur')) return want('Travaux & maintenance');
  if (contains('ordinateur', 'imprimante', 'batterie', 'onduleur', 'ram', 'usb', 'clavier', 'souris')) return want('Matériel informatique');
  if (contains('achat', 'fourniture', 'stylo', 'classeur', 'enveloppe', 'eau')) return want('Achats & fournitures');
  if (contains('frais bancaire', 'banque')) return want('Frais bancaires');
  return want('Autres dépenses');
}

function modeFromLibelle(libelle) {
  const text = String(libelle || '').toLowerCase();
  if (text.includes('cheque') || text.includes('chèque') || text.includes('chrque')) return 'cheque';
  if (text.includes('virement')) return 'virement_bancaire';
  if (text.includes('mtn') || text.includes('airtel') || text.includes('mobile money')) return 'mobile_money';
  return 'especes';
}

function parseWorkbook(filePath, sheetName, options = {}) {
  const workbook = XLSX.readFile(filePath, { cellDates: false });
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    const err = new Error(`Feuille introuvable: ${sheetName}`);
    err.availableSheets = workbook.SheetNames;
    throw err;
  }
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, blankrows: false, defval: '' });
  const directEntries = [];
  const importedEntries = [];
  const blockedRows = [];
  const balanceBreaks = [];
  let opening = null;
  let previousExcelBalance = null;

  rows.forEach((row, index) => {
    const excelRow = index + 1;
    const dateCell = row[2];
    const date = parseDate(dateCell);
    const detail = String(row[3] || '').trim();
    const piece = String(row[4] || '').trim();
    const recette = parseAmount(row[5]);
    const depense = parseAmount(row[6]);
    const solde = parseAmount(row[7]);

    if (!date && !detail && recette === null && depense === null && solde === null) return;
    if (isHeaderRow(dateCell, detail)) return;

    if (/report à nouveau|report a nouveau/i.test(detail) && solde !== null && recette === null && depense === null) {
      opening = { row: excelRow, date, detail, solde };
      previousExcelBalance = solde;
      return;
    }

    const hasRecette = recette !== null && recette > 0;
    const hasDepense = depense !== null && depense > 0;

    if (date && detail && hasRecette !== hasDepense) {
      const typeOp = hasRecette ? 'encaissement' : 'decaissement';
      const montant = hasRecette ? recette : depense;
      const entry = {
        source_row: excelRow,
        date,
        libelle: detail,
        num_piece: piece || null,
        type_op: typeOp,
        montant,
        excel_solde: solde,
      };
      directEntries.push(entry);

      if (previousExcelBalance !== null && solde !== null) {
        const expected = previousExcelBalance + (typeOp === 'encaissement' ? montant : -montant);
        if (Math.abs(expected - solde) > 0.01) {
          const desiredDelta = solde - previousExcelBalance;
          const correctedType = desiredDelta >= 0 ? 'encaissement' : 'decaissement';
          const correctedAmount = Math.abs(desiredDelta);
          balanceBreaks.push({
            row: excelRow,
            date,
            libelle: detail,
            type_op: typeOp,
            montant,
            corrected_type_op: correctedType,
            corrected_montant: correctedAmount,
            previous_solde: previousExcelBalance,
            expected_solde: expected,
            excel_solde: solde,
            delta: expected - solde,
          });
          if (options.trustSoldeColumn) {
            entry.type_op = correctedType;
            entry.montant = correctedAmount;
            entry.corrected_from_excel_solde = true;
            entry.original_type_op = typeOp;
            entry.original_montant = montant;
          }
        }
      }
      importedEntries.push(entry);
      if (solde !== null) previousExcelBalance = solde;
      return;
    }

    if (date && detail && !hasRecette && !hasDepense && solde !== null && previousExcelBalance !== null && Math.abs(solde - previousExcelBalance) <= 0.01) {
      blockedRows.push({
        row: excelRow,
        date,
        libelle: detail,
        reason: 'Ligne descriptive sans mouvement de solde',
      });
      return;
    }

    blockedRows.push({
      row: excelRow,
      date,
      libelle: detail,
      recette,
      depense,
      solde,
      reason: !date
        ? 'Date manquante ou invalide'
        : !detail
          ? 'Libelle manquant'
          : hasRecette && hasDepense
            ? 'Recette et depense simultanees'
            : 'Montant recette/depense manquant ou inexploitable',
    });
    if (solde !== null) previousExcelBalance = solde;
  });

  if (!opening) throw new Error('Report à Nouveau introuvable dans le classeur');

  return { opening, entries: importedEntries, directEntries, blockedRows, balanceBreaks };
}

function summarize(opening, entries, balanceBreaks, blockedRows) {
  let calculatedBalance = Number(opening.solde);
  const byMonth = {};
  let encaissements = 0;
  let decaissements = 0;
  let totalEnc = 0;
  let totalDec = 0;

  for (const entry of entries) {
    const month = entry.date.slice(0, 7);
    byMonth[month] ||= { count: 0, encaissements: 0, decaissements: 0 };
    byMonth[month].count += 1;
    if (entry.type_op === 'encaissement') {
      encaissements += 1;
      totalEnc += entry.montant;
      byMonth[month].encaissements += entry.montant;
      calculatedBalance += entry.montant;
    } else {
      decaissements += 1;
      totalDec += entry.montant;
      byMonth[month].decaissements += entry.montant;
      calculatedBalance -= entry.montant;
    }
  }

  return {
    opening,
    operations: entries.length,
    encaissements,
    decaissements,
    totalEnc,
    totalDec,
    calculatedBalance,
    lastExcelBalance: entries.at(-1)?.excel_solde ?? null,
    balanceDelta: entries.at(-1)?.excel_solde == null ? null : calculatedBalance - Number(entries.at(-1).excel_solde),
    balanceBreaks: balanceBreaks.length,
    blockedRows: blockedRows.length,
    byMonth,
  };
}

async function referenceCounts() {
  const checks = [
    ['demandes_achat', "SELECT COUNT(*) c FROM demandes_achat WHERE decaissement_id IS NOT NULL"],
    ['bulletins_salaire', "SELECT COUNT(*) c FROM bulletins_salaire WHERE operation_id IS NOT NULL"],
    ['sync_errors', "SELECT COUNT(*) c FROM sync_errors WHERE source_module='operations'"],
    ['cash_ledger', 'SELECT COUNT(*) c FROM cash_ledger WHERE operation_id IS NOT NULL'],
    ['accounting_entries', "SELECT COUNT(*) c FROM accounting_entries WHERE source_module IN ('cash_receipt','cash_disbursement','internal_transfer')"],
  ];
  const out = [];
  for (const [table, sql] of checks) {
    try {
      const row = await db.queryOne(sql);
      out.push({ table, count: Number(row?.c || 0) });
    } catch (err) {
      out.push({ table, error: err.message });
    }
  }
  return out;
}

async function loadContext({ userEmail, positionCode }) {
  const user = await db.queryOne(`
    SELECT id, nom, prenom, email, login_identifier, role, roles, actif
    FROM users
    WHERE actif = 1 AND (LOWER(email) = LOWER(?) OR LOWER(login_identifier) = LOWER(?))
    LIMIT 1
  `, [userEmail, userEmail]);
  if (!user) throw new Error(`Utilisateur actif introuvable pour ${userEmail}`);

  const position = await db.queryOne(`
    SELECT id, code, libelle, type, solde_initial, actif
    FROM positions
    WHERE actif = 1 AND code = ?
    LIMIT 1
  `, [positionCode]);
  if (!position) throw new Error(`Position active introuvable: ${positionCode}`);

  const categories = await db.query('SELECT id, nom, type, actif FROM categories WHERE actif = 1 ORDER BY id');
  return { user, position, categories };
}

async function backupCurrentOperations(filePath) {
  const payload = {
    created_at: new Date().toISOString(),
    operations: await db.query('SELECT * FROM operations ORDER BY id'),
    positions: await db.query('SELECT * FROM positions ORDER BY id'),
    bulletins_salaire_operation_links: await db.query(`
      SELECT id, employe_id, mois, annee, statut, operation_id
      FROM bulletins_salaire
      WHERE operation_id IS NOT NULL
      ORDER BY annee, mois, id
    `).catch(() => []),
  };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  return { path: filePath, operations: payload.operations.length, bytes: fs.statSync(filePath).size };
}

async function applyImport({ opening, entries, context, backupPath, detachPayrollOperationLinks = false }) {
  const references = await referenceCounts();
  const blockingReferences = references.filter(row => {
    if (row.error) return true;
    if (row.table === 'bulletins_salaire' && detachPayrollOperationLinks) return false;
    return row.count > 0;
  });
  if (blockingReferences.length) {
    const err = new Error('Remplacement refuse: des tables referencent deja operations');
    err.references = blockingReferences;
    throw err;
  }

  const backup = await backupCurrentOperations(backupPath);

  await db.transaction(async (tx) => {
    if (detachPayrollOperationLinks) {
      await tx.execute('UPDATE bulletins_salaire SET operation_id = NULL, updated_at = NOW() WHERE operation_id IS NOT NULL');
    }
    await tx.execute('DELETE FROM operations');
    await tx.execute('UPDATE positions SET solde_initial = ?, updated_at = NOW() WHERE id = ?', [
      Number(opening.solde),
      context.position.id,
    ]);

    let runningBalance = Number(opening.solde);
    for (const entry of entries) {
      const category = categorizeByName(entry.libelle, entry.type_op, context.categories);
      if (!category) throw new Error(`Categorie introuvable pour ligne ${entry.source_row}: ${entry.libelle}`);
      runningBalance += entry.type_op === 'encaissement' ? entry.montant : -entry.montant;
      const sourceRef = `EXCEL-CAISSE-2025-R${entry.source_row}`;
      await tx.execute(`
        INSERT INTO operations
          (date, num_piece, libelle, tiers, montant, type_op, position_id, solde_position,
           categorie_id, mode_reglement, ref_externe, statut, dec_statut,
           treasury_status, accounting_status, budget_status, allocation_status,
           created_by, created_at, updated_at)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'valide', NULL,
           'synced', 'pending', 'pending', 'pending',
           ?, NOW(), NOW())
      `, [
        entry.date,
        entry.num_piece || sourceRef,
        entry.libelle,
        null,
        Number(entry.montant),
        entry.type_op,
        context.position.id,
        runningBalance,
        category.id,
        modeFromLibelle(entry.libelle),
        sourceRef,
        context.user.id,
      ]);
    }
  });

  return backup;
}

async function main() {
  const filePath = argValue('file', DEFAULT_FILE);
  const sheet = argValue('sheet', DEFAULT_SHEET);
  const userEmail = argValue('user-email', DEFAULT_USER_EMAIL);
  const positionCode = argValue('position-code', DEFAULT_POSITION_CODE);
  const apply = hasFlag('apply');
  const replaceExisting = hasFlag('replace-existing');
  const confirmed = hasFlag('i-understand-this-replaces-production-cash');
  const trustSoldeColumn = hasFlag('trust-solde-column-for-balance-breaks');
  const detachPayrollOperationLinks = hasFlag('detach-payroll-operation-links');
  const backupPath = argValue(
    'backup',
    `/tmp/tala-cash-import-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  );

  if (!fs.existsSync(filePath)) throw new Error(`Fichier introuvable: ${filePath}`);

  const parsed = parseWorkbook(filePath, sheet, { trustSoldeColumn });
  const context = await loadContext({ userEmail, positionCode });
  const summary = summarize(parsed.opening, parsed.entries, parsed.balanceBreaks, parsed.blockedRows);
  const references = await referenceCounts();
  const dryRunReport = {
    mode: apply ? 'apply' : 'dry-run',
    file: filePath,
    sheet,
    actor: {
      id: context.user.id,
      email: context.user.email,
      role: context.user.role,
      roles: context.user.roles,
    },
    position: context.position,
    summary,
    balanceBreaks: parsed.balanceBreaks,
    blockedRows: parsed.blockedRows.filter(row => row.reason !== 'Ligne descriptive sans mouvement de solde'),
    descriptiveRowsIgnored: parsed.blockedRows.filter(row => row.reason === 'Ligne descriptive sans mouvement de solde').length,
    references,
    applyRequirements: [
      '--apply',
      '--replace-existing',
      '--i-understand-this-replaces-production-cash',
      parsed.balanceBreaks.length ? '--trust-solde-column-for-balance-breaks OU correction du fichier Excel' : null,
      references.some(row => row.table === 'bulletins_salaire' && row.count > 0) ? '--detach-payroll-operation-links OU correction manuelle des liens bulletins' : null,
    ].filter(Boolean),
  };

  console.log(JSON.stringify(dryRunReport, null, 2));

  if (!apply) return;
  if (!replaceExisting || !confirmed) {
    throw new Error('Application refusee: flags de remplacement production manquants');
  }
  if (parsed.balanceBreaks.length && !trustSoldeColumn) {
    throw new Error('Application refusee: ecarts de solde non arbitres');
  }

  const backup = await applyImport({
    opening: parsed.opening,
    entries: parsed.entries,
    context,
    backupPath,
    detachPayrollOperationLinks,
  });
  console.log(JSON.stringify({ ok: true, backup, imported: summary }, null, 2));
}

main().then(() => process.exit(0)).catch(err => {
  console.error(JSON.stringify({
    ok: false,
    error: err.message,
    references: err.references || undefined,
    availableSheets: err.availableSheets || undefined,
  }, null, 2));
  process.exit(1);
});
