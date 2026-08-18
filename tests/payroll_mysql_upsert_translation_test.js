'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { translate } = require('../backend/mysql_sync_runner');

const sql = `
  INSERT INTO bulletins_salaire
    (employe_id, mois, annee, salaire_base, brut, statut, updated_at)
  VALUES (?,?,?,?,?,'brouillon',datetime('now'))
  ON CONFLICT(employe_id, mois, annee) DO UPDATE SET
    salaire_base=excluded.salaire_base,
    brut=excluded.brut,
    updated_at=datetime('now')
  WHERE bulletins_salaire.statut = 'brouillon'
`;

const translated = translate(sql);
assert(!/ON\s+CONFLICT/i.test(translated), 'SQLite ON CONFLICT must not reach MySQL');
assert(translated.includes('ON DUPLICATE KEY UPDATE'));
assert(translated.includes("salaire_base=IF(bulletins_salaire.statut='brouillon', VALUES(salaire_base), salaire_base)"));
assert(translated.includes("brut=IF(bulletins_salaire.statut='brouillon', VALUES(brut), brut)"));
assert(translated.includes("updated_at=IF(bulletins_salaire.statut='brouillon', NOW(), updated_at)"));

const runnerSource = fs.readFileSync(path.join(__dirname, '..', 'backend/mysql_sync_runner.js'), 'utf8');
assert(runnerSource.includes('decimalNumbers: true'), 'MySQL DECIMAL values must be returned as numbers for payroll arithmetic');

console.log('OK - payroll MySQL upsert translation');
