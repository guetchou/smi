const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const markup = fs.readFileSync(path.join(root, 'frontend/dashboard.html'), 'utf8');

const panelFn = markup.match(/function _ptRenderAgentPanel\(\) \{[\s\S]*?\n\}/)[0];

/* ── Un responsable est aussi un salarié qui pointe ── */

assert(
  !/if \(_ptIsManager\) \{[\s\S]*?panel\.innerHTML = '';[\s\S]*?return;/.test(panelFn),
  'Le panneau de pointage personnel ne doit plus être supprimé pour un responsable'
);
assert(
  /panel\.classList\.remove\('hidden'\)/.test(panelFn),
  'Le panneau doit être rendu visible quel que soit le rôle'
);
assert(
  !/panel\.classList\.add\('hidden'\)/.test(panelFn),
  'Aucun chemin ne doit re-masquer le panneau personnel'
);

/* ── Ce que le panneau doit continuer de porter ── */

assert(/ptOpenSortie\(\$\{p\.id\}\)/.test(panelFn), 'Le bouton de sortie contextuel doit rester dans le panneau');
assert(/Pointer sortie/.test(panelFn) && /Pointer entrée/.test(panelFn), 'Les deux libellés d’action doivent rester disponibles');
assert(/pinLabel/.test(panelFn), 'L’état du PIN doit rester visible');
assert(/Compte non lié à une fiche agent/.test(panelFn), 'Le cas du compte non rattaché doit rester traité');

/* ── Le bandeau ne doit pas afficher une action qui ment ── */

const ui = fs.readFileSync(path.join(root, 'frontend/js/pages/pointeuse-v3.js'), 'utf8');
assert(
  /btn\.style\.display=\(mode==='active'\|\|agentPanelUsable\(\)\)\?'none':''/.test(ui),
  'Le bouton figé du bandeau doit s’effacer dès qu’un contrôle contextuel est disponible'
);
assert(
  /function agentPanelUsable\(\)\{[^}]*!n\.classList\.contains\('hidden'\)[^}]*n\.childElementCount>0/.test(ui),
  'Le bandeau ne doit s’effacer que si le panneau est réellement exploitable'
);

/* ── Un chronomètre, pas un compteur rafraîchi deux fois par minute ── */

assert(/let _ptChronoTimer = null;/.test(markup), 'Le chronomètre doit avoir sa propre minuterie');
assert(
  /_ptChronoTimer = setInterval\(_ptRefreshChrono, 1000\)/.test(markup),
  'Le chronomètre doit battre à la seconde'
);
assert(
  /_ptDurationTimer = setInterval\(_ptRefreshDurations, 30000\)/.test(markup),
  'Le rafraîchissement des tableaux doit rester à 30 s : un tableau ne se redessine pas chaque seconde'
);

const fmtChrono = markup.match(/function _ptFmtChrono\(secs\) \{[\s\S]*?\n\}/)[0];
assert(/Math\.floor\(secs \/ 3600\)/.test(fmtChrono), 'Les heures doivent être dérivées des secondes');
assert(/padStart\(2, '0'\)/.test(fmtChrono) && /join\(':'\)/.test(fmtChrono), 'Format horloge heures:minutes:secondes attendu');

const refreshChrono = markup.match(/function _ptRefreshChrono\(\) \{[\s\S]*?\n\}/)[0];
assert(
  /if \(!cells\.length\) \{ _ptStopChrono\(\); return; \}/.test(refreshChrono),
  'Le chronomètre doit s’arrêter seul quand plus rien ne le porte'
);
assert(
  /document\.visibilityState !== 'visible'/.test(refreshChrono),
  'Le chronomètre ne doit pas tourner dans un onglet masqué'
);
assert(
  /secs > PT_DUREE_CUTOFF_MINUTES \* 60/.test(refreshChrono),
  'Le chronomètre doit respecter la borne de journée'
);

assert(
  /const chronoActif = !!p\?\.heure_entree && !p\?\.heure_sortie/.test(markup),
  'Le chronomètre ne doit tourner que sur un pointage ouvert'
);
assert(
  /\['absent','teletravail','terrain'\]\.includes\(p\?\.statut\)/.test(markup),
  'Aucun chronomètre sur un statut qui n’est pas une présence au poste'
);
assert(/data-pt-chrono/.test(markup), 'Le panneau doit porter l’élément chronométré');
assert(
  /if \(chronoActif\) _ptStartChrono\(\); else _ptStopChrono\(\);/.test(markup),
  'Le chronomètre doit démarrer et s’arrêter avec le pointage'
);
assert(
  /Compteur : \$\{chrono\}/.test(markup),
  'Le libellé existant doit être conservé : aucun texte nouveau'
);

console.log(JSON.stringify({
  managerKeepsPersonalClock: true,
  exitButtonReachable: true,
  tickingChronometer: true,
  chronoStopsOnExit: true,
  tablesStayOnCheapRefresh: true,
  topbarNoLongerLies: true,
}));
