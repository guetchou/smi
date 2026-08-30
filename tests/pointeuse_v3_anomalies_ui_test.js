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

console.log(JSON.stringify({
  nativeDialogRemoved: true,
  accessibleDialog: true,
  escapeAndBackdropClose: true,
  existingLabelsReused: true,
  unknownIsNotZero: true,
}));
