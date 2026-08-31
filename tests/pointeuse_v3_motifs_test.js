const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const migration = read('backend/migrations/049_pointeuse_v3_motifs.sql');
const route = read('backend/routes/pointeuse_v3_admin.js');
const bootstrap = read('backend/services/pointeuse_v3_sqlite_bootstrap.js');
const ui = read('frontend/js/pages/pointeuse-v3-admin-ui.js');

new Function(ui);

/* ── 1. Le référentiel existe et distingue ce qui compte ── */

assert(/CREATE TABLE IF NOT EXISTS pointeuse_event_reasons/.test(migration), 'Le référentiel des motifs doit exister');
for (const colonne of ['code', 'libelle', 'categorie', 'paye', 'validation_requise', 'actif']) {
  assert(new RegExp(`\\b${colonne}\\b`).test(migration), `Colonne manquante : ${colonne}`);
}
assert(
  /categorie ENUM\('pause','sortie'\)/.test(migration),
  'Une pause et une sortie ne sont pas la même chose : la pause est intra-journée, la sortie met fin à la journée'
);
assert(/UNIQUE KEY uk_pointeuse_event_reason_code/.test(migration), 'Le code doit être unique pour servir de clé d’upsert');

/* ── 2. Le seed est rejouable ── */

const inserts = migration.match(/INSERT INTO pointeuse_event_reasons/g) || [];
assert(inserts.length >= 10, `Le référentiel doit être amorcé (trouvé ${inserts.length})`);
assert.strictEqual(
  (migration.match(/WHERE NOT EXISTS \(SELECT 1 FROM pointeuse_event_reasons WHERE code = /g) || []).length,
  inserts.length,
  'Chaque insertion doit être idempotente : la migration peut être rejouée'
);

/* ── 3. Les distinctions qui portent une conséquence de paie ── */

const ligne = code => migration.match(new RegExp(`SELECT '${code}'[^\\n]*`))[0];
assert(/'pause', 0, 0$/.test(ligne('PAUSE-REPAS')), 'La pause repas est non payée : c’est elle que déduit pause_auto_deduction');
assert(/'pause', 1, 0$/.test(ligne('PAUSE-COURTE')), 'Une pause courte reste du temps payé');
assert(/'sortie', 1, 1$/.test(ligne('MALADIE')), 'Un départ pour maladie est payé et doit être validé');
assert(/'sortie', 0, 1$/.test(ligne('SORTIE-PERSONNELLE')), 'Une sortie personnelle n’est pas payée et doit être validée');
assert(/PERMISSION-FAMILIALE/.test(migration), 'Les permissions exceptionnelles de l’article 119 doivent figurer au référentiel');
assert(/article 119/.test(migration), 'La source légale doit être citée dans la migration');

/* ── 4. Administration : mêmes garanties que les autres référentiels ── */

assert(/router\.post\('\/admin\/event-reasons'/.test(route), 'Un motif doit pouvoir être créé et modifié');
assert(/router\.post\('\/admin\/event-reasons\/:id\/deactivate'/.test(route), 'Un motif doit pouvoir être retiré du service');
assert(/ON DUPLICATE KEY UPDATE libelle=VALUES\(libelle\),categorie=VALUES\(categorie\)/.test(route), 'La modification doit passer par le même upsert que les autres');
assert(/\['pause', 'sortie'\]\.includes\(b\.categorie\)/.test(route), 'La catégorie doit être validée côté serveur');
assert(/Code motif invalide/.test(route) && /Libellé requis/.test(route), 'Code et libellé doivent être exigés');

const config = route.match(/res\.json\(\{ schedules[^}]*\}\)/)[0];
assert(config.includes('event_reasons'), 'Le référentiel doit être renvoyé avec la configuration');

/* ── 5. Parité SQLite ── */

assert(/CREATE TABLE IF NOT EXISTS pointeuse_event_reasons/.test(bootstrap), 'Parité SQLite requise');
for (const colonne of ['categorie', 'paye', 'validation_requise']) {
  assert(new RegExp(`${colonne}`).test(bootstrap), `Parité SQLite incomplète : ${colonne}`);
}

/* ── 6. Console ── */

assert(/function listeMotifs\(\)/.test(ui), 'Les motifs doivent être listés');
assert(/id="p3a-reason"/.test(ui), 'Un formulaire doit permettre de les saisir');
assert(/data-edit="\$\{kind\}"/.test(ui) && /reason:'p3a-reason'/.test(ui), 'Un motif doit pouvoir être repris dans le formulaire');
assert(/reason:'event-reasons'/.test(ui), 'La désactivation doit viser la bonne route');
assert(
  /const SOURCES=\{[^}]*reason:'event_reasons'/.test(ui),
  'La reprise doit lire la collection renvoyée par la configuration, dont le nom diffère de celui de la route'
);
assert(/'paye','validation_requise'\]/.test(ui), 'Les deux drapeaux doivent être convertis en booléens avant envoi');

console.log(JSON.stringify({
  referentialExists: true,
  seedIsReplayable: true,
  payrollDistinctionsHeld: true,
  legalSourceCited: true,
  manageableLikeOtherReferentials: true,
  sqliteParity: true,
}));
