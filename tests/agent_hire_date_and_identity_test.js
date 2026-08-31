const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const route = read('backend/routes/agents.js');
const markup = read('frontend/dashboard.html');
const offboarding = read('backend/services/offboarding_workflow.js');

/* ── 1. La date d'embauche conditionne des montants legaux ──
   Les 12 agents actifs n'en avaient aucune, la sortie produisait donc un solde
   de tout compte a zero. Le service refuse desormais de calculer sans elle ;
   il faut aussi cesser de creer des dossiers qui la laissent vide, sinon le
   probleme se reforme a chaque embauche. */

assert(
  /if \(!date_embauche\) return res\.status\(400\)/.test(route),
  'La creation d un agent doit exiger la date d embauche'
);
/* Le controle avait ete insere deux fois : un script de patch relance apres
   une restauration partielle, dont l ancre etait toujours presente. Un
   controle en double est du code mort ; on exige l unicite. */
assert.strictEqual(
  (route.match(/if \(!date_embauche\) return res\.status\(400\)/g) || []).length, 1,
  'Le controle de la date d embauche doit exister une seule fois'
);

const refus = route.match(/if \(!date_embauche\) return res\.status\(400\)[^\n]*/)[0];
for (const attendu of ['ancienneté', 'indemnités']) {
  assert(refus.includes(attendu), `Le refus doit dire a quoi sert la date : ${attendu}`);
}

/* Le controle serveur et le refus de la sortie doivent rester solidaires : si
   l un des deux disparait, les dossiers incomplets reviennent. */
assert(
  /if \(ancienneteAnnees === null\)/.test(offboarding),
  'Le refus cote sortie doit rester en place : c est lui qui rend la date indispensable'
);

/* Le formulaire doit le signaler avant l envoi, pas apres le refus. */
const champ = markup.match(/<input type="date" id="ag-date-embauche"[^>]*>/)[0];
assert(/\brequired\b/.test(champ), 'Le champ date d embauche doit etre marque requis dans le formulaire');
assert(
  /for="ag-date-embauche">Date d'embauche \*/.test(markup),
  'Le libelle doit porter la marque des champs obligatoires deja utilisee dans ce formulaire'
);

/* La marque * est l'idiome deja present : on ne l'invente pas. */
assert(/Raison sociale \*/.test(markup), 'La convention * pour un champ requis doit preexister');

/* ── 2. L'identite de l'entreprise s'affiche partout ──
   Le logo televerse n'apparaissait que sur l'ecran Parametres : le
   remplacement vivait dans loadEntreprise(), appelee a l'ouverture de cet
   onglet seulement. */

assert(
  /function appliquerIdentiteEntreprise\(ent, cacheBuster = ''\)/.test(markup),
  'L application de l identite doit etre une fonction a part, reutilisable'
);
assert(
  /async function chargerIdentiteEntreprise\(\)/.test(markup),
  'Le chargement au demarrage doit exister'
);
assert(
  /await loadCurrentAccessPermissions\(\);\n  await chargerIdentiteEntreprise\(\);/.test(markup),
  'L identite doit etre chargee dans la sequence de demarrage, pas a l ouverture d un onglet'
);
assert(
  /loadEntreprise[\s\S]{0,4000}appliquerIdentiteEntreprise\(ent, cbv\)/.test(markup),
  'loadEntreprise doit reutiliser la meme fonction, pour qu un nouveau logo se voie aussitot'
);

/* Le bloc d'origine ne doit pas subsister en double dans loadEntreprise. */
assert.strictEqual(
  (markup.match(/const sidebarLogo = document\.getElementById\('sidebar-logo-wrap'\)/g) || []).length, 1,
  'Le remplacement du logo ne doit exister qu a un seul endroit'
);

console.log(JSON.stringify({
  hireDateRequiredAtCreation: true,
  checkDeclaredOnce: true,
  offboardingRefusalStillInPlace: true,
  formMarksItRequired: true,
  companyIdentityLoadedAtStartup: true,
  singleImplementation: true,
}));
