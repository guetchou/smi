const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const route = read('backend/routes/pointeuse_v3_admin.js');
const ui = read('frontend/js/pages/pointeuse-v3-admin-ui.js');

new Function(ui);

/* ── 1. Les trois rôles nommés doivent pouvoir administrer ── */

assert(/const MANAGER = \['admin', 'dg', 'rh'\];/.test(route), 'Admin, DG et RH doivent administrer la pointeuse');
assert(/const MANAGER=new Set\(\['admin','dg','rh'\]\)/.test(ui), 'La console doit s’ouvrir aux mêmes rôles');

/* ── 2. Les réglages de pause deviennent modifiables ── */

assert(
  /pause_auto_deduction=VALUES\(pause_auto_deduction\),pause_seuil_minutes=VALUES\(pause_seuil_minutes\)/.test(route),
  'Les deux réglages de pause doivent être écrits par la route de planning'
);
assert(
  /b\.pause_auto_deduction === undefined \? 1 :/.test(route),
  'Une soumission sans le champ ne doit pas désactiver la déduction par surprise'
);
assert(/name="pause_auto_deduction"/.test(ui) && /name="pause_seuil_minutes"/.test(ui), 'Les deux champs doivent exister dans le formulaire');
assert(
  /'pause_seuil_minutes'/.test(ui) && /'pause_auto_deduction'\]/.test(ui),
  'Les deux champs doivent être convertis avant envoi : nombre et booléen'
);

/* ── 3. Désactivation, avec garde contre la coupure silencieuse ── */

for (const chemin of ['/admin/sites/:id/deactivate', '/admin/schedules/:id/deactivate', '/admin/calendars/:id/deactivate']) {
  assert(route.includes(chemin), `Route de désactivation manquante : ${chemin}`);
}
assert(
  /SCHEDULE_STILL_ASSIGNED/.test(route),
  'Désactiver un planning encore affecté doit être refusé : activeAssignment joint sur actif = 1, les agents ne pourraient plus pointer'
);
assert(
  /date_fin IS NULL OR date_fin >= CURDATE\(\)/.test(route),
  'Seules les affectations encore en cours doivent bloquer la désactivation'
);
assert(
  route.indexOf("if (!allowed(req.user)) return deny(res);\n    return await deactivate(res, 'pointeuse_sites'") > 0,
  'La désactivation doit rester réservée aux rôles autorisés'
);

/* ── 4. Les enregistrements existants sont listés et éditables ── */

for (const liste of ['listeSites', 'listePlannings', 'listeCalendriers', 'listeAffectations']) {
  assert(new RegExp(`function ${liste}\\(\\)`).test(ui), `Liste manquante : ${liste}`);
}
assert(/data-edit="\$\{kind\}"/.test(ui), 'Chaque ligne doit pouvoir être reprise dans le formulaire');
assert(/data-off="\$\{kind\}"/.test(ui), 'Chaque ligne active doit pouvoir être désactivée');
assert(
  /Number\(r\.actif\)===0\?'':/.test(ui),
  'Une ligne déjà désactivée ne doit pas proposer de la désactiver à nouveau'
);
assert(/function remplir\(kind,id\)/.test(ui), 'La reprise doit pré-remplir le formulaire correspondant');
assert(
  /const CHAMPS=\{[\s\S]*schedule:r=>\(\{[^}]*pause_auto_deduction/.test(ui),
  'La reprise d’un planning doit inclure les réglages de pause'
);

/* ── 5. Plus aucune boîte de dialogue native dans la console ── */

assert(!/\bprompt\(/.test(ui), 'Aucun prompt natif ne doit subsister');
assert(!/\bconfirm\(/.test(ui), 'Aucune confirmation native ne doit subsister');
const dlg = ui.match(/function dialogue\(\)\{[\s\S]*?\n  \}/)[0];
assert(/role="dialog"/.test(dlg) && /aria-modal="true"/.test(dlg), 'Le dialogue doit être annoncé aux technologies d’assistance');
const lier = ui.match(/function lierDialogue\(\)\{[\s\S]*?\n  \}/)[0];
assert(/e\.key==='Escape'/.test(lier), 'Échap doit fermer le dialogue');
assert(/v\.length<Number\(m\.dataset\.min\|\|0\)/.test(lier), 'La longueur minimale du motif doit être respectée');
assert(/minLength:10/.test(ui), 'La réouverture de période doit conserver son minimum de 10 caractères');

/* ── 6. Libellés : seuls deux sont nouveaux, les autres préexistent ── */

for (const libelle of ['Modifier', 'Désactiver', 'Actif', 'Désactivé', 'Actions', 'Annuler', 'Motif', 'Oui', 'Non']) {
  assert(ui.includes(libelle), `Libellé attendu : ${libelle}`);
}

/* ── 7. Un champ numérique laissé vide ne doit plus provoquer d'erreur interne ──
   Constaté en production : POST /admin/sites répondait 500 avec
   « Incorrect decimal value: '' for column 'latitude' ». Le code faisait
   `latitude ?? null`, or ?? ne rattrape pas la chaîne vide. */

assert(/function nombreOuNull\(valeur\)/.test(route), 'Une normalisation des champs numériques vides est requise');
assert(/function coordonneeOuNull\(valeur, max\)/.test(route), 'Les coordonnées doivent être bornées');
assert(
  !/latitude \?\? null/.test(route) && !/longitude \?\? null/.test(route),
  'La coercition fautive ne doit plus subsister sur les coordonnées'
);
assert(
  !/scheduled_minutes_override \?\? null/.test(route),
  'La coercition fautive ne doit plus subsister sur la durée planifiée'
);
assert(
  /coordonneeOuNull\(latitude, 90\)/.test(route) && /coordonneeOuNull\(longitude, 180\)/.test(route),
  'Latitude et longitude doivent être bornées à leurs domaines respectifs'
);
assert(
  /nombreOuNull\(scheduled_minutes_override\)/.test(route) && /nombreOuNull\(b\.min_duree_minutes\)/.test(route),
  'Les autres champs numériques optionnels doivent passer par la même normalisation'
);

const helpers = route.match(/function nombreOuNull[\s\S]*?\n}/)[0]
  + '\n' + route.match(/function coordonneeOuNull[\s\S]*?\n}/)[0];
const portee = {};
new Function('exports', helpers + '\nexports.nombreOuNull=nombreOuNull;exports.coordonneeOuNull=coordonneeOuNull;')(portee);

assert.strictEqual(portee.nombreOuNull(''), null, 'Une chaîne vide vaut « non renseigné », pas une valeur');
assert.strictEqual(portee.nombreOuNull('   '), null, 'Des espaces valent « non renseigné »');
assert.strictEqual(portee.nombreOuNull(undefined), null, 'Un champ absent vaut « non renseigné »');
assert.strictEqual(portee.nombreOuNull('abc'), null, 'Une saisie non numérique ne doit pas atteindre la base');
assert.strictEqual(portee.nombreOuNull(0), 0, 'Zéro est une valeur, pas une absence');
assert.strictEqual(portee.nombreOuNull('-4.2634'), -4.2634, 'Une coordonnée valide doit être conservée');
assert.strictEqual(portee.coordonneeOuNull('120', 90), null, 'Une latitude hors bornes doit être écartée');
assert.strictEqual(portee.coordonneeOuNull('-4.2634', 90), -4.2634, 'Une latitude valide doit passer');
assert.strictEqual(portee.coordonneeOuNull('15.2429', 180), 15.2429, 'Une longitude valide doit passer');

assert(
  /if\(k in o\)o\[k\]=\(o\[k\]===''\|\|o\[k\]==null\)\?null:Number\(o\[k\]\);/.test(ui),
  'Le formulaire ne doit plus envoyer de chaîne vide pour un champ numérique'
);

console.log(JSON.stringify({
  adminDgRhAllowed: true,
  emptyNumericFieldsAccepted: true,
  pauseSettingsEditable: true,
  deactivationGuarded: true,
  recordsListedAndEditable: true,
  noNativeDialogLeft: true,
}));
