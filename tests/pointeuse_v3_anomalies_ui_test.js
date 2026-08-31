const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const ui = read('frontend/js/pages/pointeuse-v3.js');
const markup = read('frontend/dashboard.html');

new Function(ui);

/* ── 1. Plus aucune boîte de dialogue native ──
   Le prompt() a figé le navigateur en session : il bloque la page entière
   jusqu'à intervention extérieure. */
assert(!/\bprompt\(/.test(ui), 'Aucune boîte de dialogue native ne doit subsister dans la coquille');

/* Le seul appel natif restant est un repli conditionnel de notify(), atteint
   uniquement si ni showToast ni toast n'existent — ce qui n'arrive pas dans
   l'application. Il doit rester confiné à cette fonction. */
const notify = ui.match(/function notify\(msg,type='success'\)\{[\s\S]*?\n  \}/)[0];
assert(/if\(type==='error'\) alert\(msg\);/.test(notify), 'Le repli d’erreur doit rester conditionnel');
assert.strictEqual(
  (ui.match(/\balert\(/g) || []).length, 1,
  'Aucune alerte native ne doit exister hors de ce repli'
);

const dialogue = ui.match(/function resolveDialog\(\)\{[\s\S]*?\n  \}/)[0];
assert(/role="dialog"/.test(dialogue) && /aria-modal="true"/.test(dialogue), 'La boîte de dialogue doit être annoncée aux technologies d’assistance');
assert(/aria-labelledby="p3-resolve-title"/.test(dialogue), 'Le dialogue doit être relié à son titre');
assert(/minlength="5"/.test(dialogue), 'La contrainte de longueur doit rester portée par le champ');

const liaison = ui.match(/function bindResolveDialog\(\)\{[\s\S]*?\n  \}/)[0];
assert(/e\.key==='Escape'/.test(liaison), 'Échap doit fermer le dialogue');
assert(/e\.target===modal/.test(liaison), 'Un clic hors du dialogue doit le fermer');
assert(/justification\.length<5/.test(liaison), 'La justification trop courte doit être refusée');

/* Les libellés doivent préexister dans le produit, aucun n'est inventé. */
for (const libelle of ['Justification de résolution (minimum 5 caractères)', 'Traiter']) {
  assert(ui.includes(libelle), `Libellé attendu dans la coquille : ${libelle}`);
}
assert(markup.includes('>Annuler<'), 'Annuler doit être un libellé déjà présent dans le produit');
assert(/>Annuler<\/button>/.test(dialogue), 'Le dialogue doit réutiliser ce libellé');

/* ── 2. Une valeur non calculée ne doit pas s'afficher comme un zéro ──
   En mode shadow aucun événement V3 n'existe : afficher 0h00 affirmait
   « zéro minute travaillée » à côté d'un chronomètre V2 qui tourne. */
assert(
  /const sansEvenement=!s\.last_event; const compteur=v=>sansEvenement\?'—':fmtMinutes\(v\);/.test(ui),
  'L’absence d’événement doit être distinguée d’une durée nulle'
);
for (const champ of ['d.worked_minutes??d.workedMinutes', 'd.break_minutes??d.breakMinutes', 'd.late_minutes', 'd.overtime_minutes']) {
  assert(ui.includes(`compteur(${champ})`), `Le compteur ${champ} doit passer par la distinction inconnu / zéro`);
  assert(!ui.includes(`<b>\${fmtMinutes(${champ})}`), `Le compteur ${champ} ne doit plus afficher un zéro trompeur`);
}
assert(/return '—'/.test(ui) || /'—'/.test(ui), 'Le tiret est déjà la convention du fichier pour une valeur inconnue');

/* ── 3. Aucun identifiant technique ne doit atteindre l'écran ──
   missing_in, critical, teletravail sont des valeurs de colonne. Un responsable
   RH lit un tableau, pas un schéma de base. Le dictionnaire doit couvrir
   l'intégralité de ce que la base peut stocker, sinon un type non traduit
   ressort tel quel le jour où le moteur l'émet. */

const enumMigration = read('backend/migrations/047_pointeuse_v3_missing_assignment_anomaly.sql');
const enumBloc = enumMigration.match(/MODIFY COLUMN anomaly_type ENUM\(([\s\S]*?)\)/)[1];
const typesStockables = [...enumBloc.matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
assert(typesStockables.length >= 12, `Liste des types trop courte (${typesStockables.length})`);

const dictionnaire = ui.match(/function anomalyLabel\(type\)\{[\s\S]*?\}\)\[type\]\|\|'Situation à vérifier'; \}/)[0];
for (const type of typesStockables) {
  assert(
    new RegExp(`\\b${type}:'`).test(dictionnaire),
    `Type d'anomalie sans libellé : ${type}. Tout type stockable doit être traduit avant d'atteindre l'écran.`
  );
}

/* Le repli garantit qu'un type inconnu n'affiche jamais son identifiant. */
assert(/\|\|'Situation à vérifier'/.test(dictionnaire), 'Un type inconnu doit afficher une formulation métier, pas son identifiant');

/* Les autres colonnes techniques du même tableau. */
for (const [fonction, valeurs] of [
  ['severityLabel', ['critical', 'warning', 'info']],
  ['anomalyStatusLabel', ['detected', 'to_justify', 'submitted', 'approved', 'rejected', 'regularized', 'dismissed']],
  ['modeLabel', ['bureau', 'teletravail', 'terrain']],
  ['eventLabel', ['clock_in', 'break_start', 'break_end', 'clock_out']],
]) {
  const bloc = ui.match(new RegExp(`function ${fonction}\\(v?t?y?p?e?\\)\\{[^\\n]*`))[0];
  for (const v of valeurs) assert(new RegExp(`\\b${v}:'`).test(bloc), `${fonction} : valeur non traduite ${v}`);
}

/* Aucun identifiant brut ne doit plus être injecté dans le tableau. */
for (const brut of ['esc(a.anomaly_type)', 'esc(a.severity)', 'esc(a.status)', 'esc(e.mode)']) {
  assert(!ui.includes(brut), `Valeur technique affichée sans traduction : ${brut}`);
}
assert(!/Aucun événement V3/.test(ui), 'Le numéro de version interne ne doit pas apparaître à l’écran');

/* Les domaines de valeurs affiches ailleurs que dans le tableau des anomalies.
   Repere le 31/08/2026 par capture d'ecran de production : le bloc « journee »
   affichait « workday » et « bureau » en clair. */
for (const [migration, colonne, fonction] of [
  ['backend/migrations/046_pointeuse_v3_workforce_policy.sql', 'day_type', 'dayTypeLabel'],
  ['backend/migrations/043_pointeuse_industrial_v3.sql', 'mode_autorise', 'modeLabel'],
]) {
  const sql = read(migration);
  const bloc = sql.match(new RegExp(`${colonne} ENUM\\(([^)]*)\\)`))[1];
  const valeurs = [...bloc.matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
  assert(valeurs.length >= 3, `Domaine ${colonne} trop court`);
  const dico = ui.match(new RegExp(`function ${fonction}\\(v\\)\\{[^\\n]*`))[0];
  for (const v of valeurs) assert(new RegExp(`\\b${v}:'`).test(dico), `${fonction} : valeur non traduite ${v}`);
}

/* Le bloc « journée » ne doit plus injecter ces colonnes sans traduction. */
for (const brut of ["esc(cal.libelle||cal.day_type||'Standard')", "esc(a.mode_autorise||'bureau')"]) {
  assert(!ui.includes(brut), `Valeur technique affichée sans traduction : ${brut}`);
}
/* ── 4. Ce qui distingue le mode observation doit rester ── */
assert(/Mode observation — actions V2 maintenues/.test(ui), 'Le mode observation doit rester annoncé tant que la V3 n’enregistre pas');
assert(/mode==='active'\?`<button class="p3-action"/.test(ui), 'Le bouton de pointage ne doit exister qu’en mode actif');
assert(/<small>Mode autorisé<\/small>/.test(ui), 'Le mode autorisé doit rester lisible sur la journée');
console.log(JSON.stringify({
  nativeDialogRemoved: true,
  accessibleDialog: true,
  escapeAndBackdropClose: true,
  existingLabelsReused: true,
  unknownIsNotZero: true,
  everyStorableAnomalyHasALabel: true,
  noRawIdentifierReachesTheScreen: true,
  dayTypeAndWorkModeTranslated: true,
  shadowModeIndicatorsPreserved: true,
}));
