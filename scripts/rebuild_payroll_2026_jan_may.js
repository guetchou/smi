#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const BACKEND_DIR = path.join(ROOT_DIR, 'backend');
const Database = require(path.join(BACKEND_DIR, 'node_modules', 'better-sqlite3'));

const APPLY = process.argv.includes('--apply');
const YEAR = 2026;
const VALIDATED_MONTHS = [1, 2, 3, 4];
const PREPARATION_MONTHS = [5];
const TARGET_MONTHS = [...VALIDATED_MONTHS, ...PREPARATION_MONTHS];

class DryRunRollback extends Error {}

const DB_CANDIDATES = [
  process.env.DB_PATH,
  path.join(BACKEND_DIR, 'data', 'caisse.db'),
  '/var/lib/docker/volumes/caisse-topcenter_caisse_data/_data/caisse.db',
].filter(Boolean);

function findDb() {
  for (const candidate of DB_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('caisse.db introuvable. Définissez DB_PATH ou vérifiez backend/data/caisse.db');
}

function numberParam(rows, key, fallback) {
  const value = rows[key] == null ? fallback : Number(rows[key]);
  return Number.isFinite(value) ? value : fallback;
}

function getTaux(db) {
  const params = {};
  db.prepare('SELECT cle, valeur FROM parametres').all().forEach(row => {
    params[row.cle] = row.valeur;
  });
  return {
    cnss_employe: numberParam(params, 'cnss_employe_taux', 4.725),
    cnss_patron: numberParam(params, 'cnss_patron_taux', 20),
    camu_employe: numberParam(params, 'camu_employe_taux', 2.25),
    camu_patron: numberParam(params, 'camu_patron_taux', 5),
    irpp: {
      plafond_t1: numberParam(params, 'irpp_plafond_t1', 464000),
      taux_t2: numberParam(params, 'irpp_taux_t2', 10),
      plafond_t2: numberParam(params, 'irpp_plafond_t2', 1000000),
      taux_t3: numberParam(params, 'irpp_taux_t3', 25),
      plafond_t3: numberParam(params, 'irpp_plafond_t3', 3000000),
      taux_t4: numberParam(params, 'irpp_taux_t4', 40),
    },
  };
}

function calculer(base, taux) {
  const brut = Number(base) || 0;
  const cnss_employe = Math.round(brut * taux.cnss_employe / 100);
  const camu_employe = Math.round(brut * taux.camu_employe / 100);
  const net_imposable = brut - cnss_employe - camu_employe;
  const tranches = [
    { seuil: 0, plafond: taux.irpp.plafond_t1, taux: 0 },
    { seuil: taux.irpp.plafond_t1, plafond: taux.irpp.plafond_t2, taux: taux.irpp.taux_t2 / 100 },
    { seuil: taux.irpp.plafond_t2, plafond: taux.irpp.plafond_t3, taux: taux.irpp.taux_t3 / 100 },
    { seuil: taux.irpp.plafond_t3, plafond: Infinity, taux: taux.irpp.taux_t4 / 100 },
  ];
  let irpp = 0;
  for (const tranche of tranches) {
    if (net_imposable <= tranche.seuil) break;
    irpp += (Math.min(net_imposable, tranche.plafond) - tranche.seuil) * tranche.taux;
  }
  irpp = Math.round(irpp);
  const total_retenues = cnss_employe + camu_employe + irpp;
  const net_a_payer = brut - total_retenues;
  const cnss_patronal = Math.round(brut * taux.cnss_patron / 100);
  const camu_patronal = Math.round(brut * taux.camu_patron / 100);
  return {
    brut,
    cnss_employe,
    camu_employe,
    irpp,
    total_retenues,
    net_imposable,
    net_a_payer,
    cnss_patronal,
    camu_patronal,
    cout_total_employeur: brut + cnss_patronal + camu_patronal,
  };
}

function getOrCreatePeriod(db, mois, adminId, summary) {
  let period = db.prepare('SELECT * FROM periodes_paie WHERE mois=? AND annee=?').get(mois, YEAR);
  if (period) return period;

  const result = db.prepare(`
    INSERT INTO periodes_paie (mois, annee, statut, created_at, updated_at)
    VALUES (?, ?, 'ouverte', datetime('now'), datetime('now'))
  `).run(mois, YEAR);
  period = db.prepare('SELECT * FROM periodes_paie WHERE id=?').get(result.lastInsertRowid);
  summary.periodsCreated += 1;
  audit(db, 'periodes_paie', period.id, 'rebuild_2026_jan_may_create_period', { mois, annee: YEAR }, adminId);
  return period;
}

function audit(db, tableName, recordId, action, details, userId) {
  db.prepare(`
    INSERT INTO audit_logs (table_name, record_id, action, details, user_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(tableName, recordId, action, JSON.stringify(details || {}), userId);
}

function refreshPeriodStats(db, mois) {
  db.prepare(`
    UPDATE periodes_paie SET
      nb_bulletins_generes=(SELECT COUNT(*) FROM bulletins_salaire WHERE mois=? AND annee=?),
      nb_bulletins_valides=(SELECT COUNT(*) FROM bulletins_salaire WHERE mois=? AND annee=? AND statut='valide'),
      nb_bulletins_payes=(SELECT COUNT(*) FROM bulletins_salaire WHERE mois=? AND annee=? AND statut='paye'),
      total_brut=(SELECT COALESCE(SUM(brut),0) FROM bulletins_salaire WHERE mois=? AND annee=?),
      total_net=(SELECT COALESCE(SUM(net_a_payer),0) FROM bulletins_salaire WHERE mois=? AND annee=?),
      total_charges=(SELECT COALESCE(SUM(cout_total_employeur-brut),0) FROM bulletins_salaire WHERE mois=? AND annee=?),
      updated_at=datetime('now')
    WHERE mois=? AND annee=?
  `).run(mois, YEAR, mois, YEAR, mois, YEAR, mois, YEAR, mois, YEAR, mois, YEAR, mois, YEAR);
}

function main() {
  const dbPath = findDb();
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');

  const admin = db.prepare("SELECT id, email FROM users WHERE actif=1 AND role='admin' ORDER BY id LIMIT 1").get();
  if (!admin) throw new Error('Aucun utilisateur admin actif trouvé pour tracer le rattrapage');

  const taux = getTaux(db);
  const employees = db.prepare(`
    SELECT * FROM employes
    WHERE actif=1 AND statut_dossier='actif'
    ORDER BY type, nom, prenom
  `).all();
  const eligible = employees.filter(emp => Number(emp.salaire_base) > 0);
  const ignored = employees.filter(emp => !(Number(emp.salaire_base) > 0))
    .map(emp => ({ id: emp.id, nom: emp.nom, prenom: emp.prenom, raison: 'salaire_base non défini' }));

  const summary = {
    dbPath,
    mode: APPLY ? 'apply' : 'dry-run',
    admin: admin.email,
    periodsCreated: 0,
    payslipsInserted: 0,
    payslipsUpdatedDraft: 0,
    payslipsAttached: 0,
    payslipsValidated: 0,
    periodsValidatedDg: 0,
    periodStatsRefreshed: 0,
    ignored,
  };

  const tx = db.transaction(() => {
    const insertBulletin = db.prepare(`
      INSERT INTO bulletins_salaire
        (employe_id, mois, annee, salaire_base, prime_transport, prime_logement, autres_primes,
         brut, cnss_employe, camu_employe, irpp, total_retenues, net_imposable, net_a_payer,
         cnss_patronal, camu_patronal, cout_total_employeur, lignes_custom, statut,
         created_by, generated_by, periode_id, net_a_verser, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 'brouillon',
        ?, ?, ?, ?, datetime('now'), datetime('now'))
    `);
    const updateDraftBulletin = db.prepare(`
      UPDATE bulletins_salaire SET
        salaire_base=?, prime_transport=0, prime_logement=0, autres_primes=0,
        brut=?, cnss_employe=?, camu_employe=?, irpp=?, total_retenues=?,
        net_imposable=?, net_a_payer=?, cnss_patronal=?, camu_patronal=?,
        cout_total_employeur=?, lignes_custom='[]', generated_by=?, periode_id=?,
        net_a_verser=?, updated_at=datetime('now')
      WHERE id=?
    `);

    for (const mois of TARGET_MONTHS) {
      const period = getOrCreatePeriod(db, mois, admin.id, summary);
      for (const emp of eligible) {
        const calc = calculer(emp.salaire_base, taux);
        const existing = db.prepare(`
          SELECT * FROM bulletins_salaire WHERE employe_id=? AND mois=? AND annee=?
        `).get(emp.id, mois, YEAR);

        if (!existing) {
          insertBulletin.run(
            emp.id, mois, YEAR, emp.salaire_base,
            calc.brut, calc.cnss_employe, calc.camu_employe, calc.irpp,
            calc.total_retenues, calc.net_imposable, calc.net_a_payer,
            calc.cnss_patronal, calc.camu_patronal, calc.cout_total_employeur,
            admin.id, admin.id, period.id, calc.net_a_payer
          );
          summary.payslipsInserted += 1;
          continue;
        }

        if (existing.statut === 'brouillon') {
          updateDraftBulletin.run(
            emp.salaire_base,
            calc.brut, calc.cnss_employe, calc.camu_employe, calc.irpp,
            calc.total_retenues, calc.net_imposable, calc.net_a_payer,
            calc.cnss_patronal, calc.camu_patronal, calc.cout_total_employeur,
            admin.id, period.id, calc.net_a_payer, existing.id
          );
          summary.payslipsUpdatedDraft += 1;
        } else if (!existing.periode_id) {
          db.prepare("UPDATE bulletins_salaire SET periode_id=?, updated_at=datetime('now') WHERE id=?")
            .run(period.id, existing.id);
          summary.payslipsAttached += 1;
        }
      }

      if (VALIDATED_MONTHS.includes(mois)) {
        const changed = db.prepare(`
          UPDATE bulletins_salaire
          SET statut='valide',
              validated_by=COALESCE(validated_by, ?),
              updated_at=datetime('now')
          WHERE mois=? AND annee=? AND statut='brouillon'
        `).run(admin.id, mois, YEAR).changes;
        summary.payslipsValidated += changed;

        const periodChanged = db.prepare(`
          UPDATE periodes_paie
          SET statut='validee_dg',
              soumis_dg_by=COALESCE(soumis_dg_by, ?),
              soumis_dg_at=COALESCE(soumis_dg_at, datetime('now')),
              valide_dg_by=COALESCE(valide_dg_by, ?),
              valide_dg_at=COALESCE(valide_dg_at, datetime('now')),
              updated_at=datetime('now')
          WHERE mois=? AND annee=? AND statut!='validee_dg'
        `).run(admin.id, admin.id, mois, YEAR).changes;
        summary.periodsValidatedDg += periodChanged;
      } else {
        db.prepare(`
          UPDATE periodes_paie
          SET statut='ouverte',
              soumis_dg_by=NULL,
              soumis_dg_at=NULL,
              valide_dg_by=NULL,
              valide_dg_at=NULL,
              updated_at=datetime('now')
          WHERE mois=? AND annee=? AND statut!='ouverte'
        `).run(mois, YEAR);
      }

      refreshPeriodStats(db, mois);
      summary.periodStatsRefreshed += 1;
    }

    const changed = summary.periodsCreated + summary.payslipsInserted + summary.payslipsUpdatedDraft +
      summary.payslipsAttached + summary.payslipsValidated + summary.periodsValidatedDg;
    if (changed > 0) {
      audit(db, 'periodes_paie', 0, 'rebuild_2026_jan_may_summary', summary, admin.id);
    }

    if (!APPLY) throw new DryRunRollback('dry-run rollback');
  });

  let dryRunRolledBack = false;
  try {
    tx();
  } catch (err) {
    if (err instanceof DryRunRollback) {
      dryRunRolledBack = true;
    } else {
      throw err;
    }
  } finally {
    db.close();
  }

  console.log(JSON.stringify(summary, null, 2));
  if (!APPLY) {
    console.log('Dry-run seulement. Relancez avec --apply pour écrire les changements.');
  }
}

main();
