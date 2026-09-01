const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
/* La premiere ligne du SELECT porte les alias de colonnes : on les retire
   pour comparer toutes les lignes sous la meme forme. */
const migration = fs.readFileSync(path.join(root, 'backend/migrations/054_jours_feries_congo.sql'), 'utf8')
  .replace(/ +AS work_date/g, '').replace(/ +AS libelle/g, '').replace(/' +,/g, "',");

/* ── Un jour férié n'est pas un jour ouvré ──
   Le calendrier CG-STANDARD existait — Africa/Brazzaville, lundi-vendredi —
   mais aucun jour n'y etait declare. Chaque ferie comptait donc comme un jour
   ouvre et produisait une anomalie « Entree manquante » par agent : douze par
   ferie.

   Les dates fixes viennent de deux publications concordantes. Les dates
   mobiles ne sont pas recopiees : leurs resumes se contredisaient, l'un placant
   le lundi de Pentecote en juin avec une Ascension au 14 mai — impossible,
   la Pentecote suivant l'Ascension de dix jours. Elles sont donc calculees
   depuis Paques, ici comme dans la migration. */

function paques(annee) {
  const f = Math.floor;
  const G = annee % 19;
  const C = f(annee / 100);
  const H = (C - f(C / 4) - f((8 * C + 13) / 25) + 19 * G + 15) % 30;
  const I = H - f(H / 28) * (1 - f(29 / (H + 1)) * f((21 - G) / 11));
  const J = (annee + f(annee / 4) + I + 2 - C + f(C / 4)) % 7;
  const L = I - J;
  const mois = 3 + f((L + 40) / 44);
  const jour = L + 28 - 31 * f(mois / 4);
  return new Date(Date.UTC(annee, mois - 1, jour));
}
const iso = d => d.toISOString().slice(0, 10);
const depuisPaques = (annee, n) => {
  const d = paques(annee);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};

const FIXES = [
  ['01-01', "Jour de l''An"],
  ['05-01', 'Fête du Travail'],
  ['06-10', 'Journée de la Réconciliation'],
  ['08-15', 'Fête nationale'],
  ['11-01', 'Toussaint'],
  ['11-28', 'Jour de la République'],
  ['12-25', 'Noël'],
];
const MOBILES = [
  [1, 'Lundi de Pâques'],
  [39, 'Ascension'],
  [50, 'Lundi de Pentecôte'],
];
const ANNEES = [2026, 2027];

for (const annee of ANNEES) {
  for (const [suffixe, libelle] of FIXES) {
    const ligne = `'${annee}-${suffixe}', '${libelle}'`;
    assert(
      migration.includes(ligne),
      `Jour fixe manquant pour ${annee} : ${suffixe} ${libelle.replace("''", "'")}`
    );
  }
  for (const [decalage, libelle] of MOBILES) {
    const date = depuisPaques(annee, decalage);
    assert(
      migration.includes(`'${date}', '${libelle}'`),
      `Fête mobile mal datée pour ${annee} : ${libelle} attendu le ${date} (Pâques + ${decalage} jours)`
    );
  }
}

/* Dix jours par annee : ni plus, ni moins. */
for (const annee of ANNEES) {
  const compte = (migration.match(new RegExp(`'${annee}-\\d{2}-\\d{2}'`, 'g')) || []).length;
  assert.strictEqual(compte, 10, `${annee} declare ${compte} jours feries, 10 attendus`);
}

/* Les lundis doivent tomber un lundi : garde-fou sur le calcul de Paques. */
for (const annee of ANNEES) {
  for (const [decalage, libelle] of MOBILES.filter(([, l]) => l.startsWith('Lundi'))) {
    const jour = new Date(depuisPaques(annee, decalage) + 'T12:00:00Z').getUTCDay();
    assert.strictEqual(jour, 1, `${libelle} ${annee} ne tombe pas un lundi : le calcul de Pâques est faux`);
  }
}

/* Une saisie humaine ne doit jamais etre ecrasee : la console permet de
   declarer des jours a la main. */
assert(/INSERT IGNORE INTO pointeuse_calendar_days/.test(migration), 'L insertion doit ignorer un jour deja declare');
assert(!/ON DUPLICATE KEY UPDATE/.test(migration), 'La migration ne doit pas ecraser une declaration existante');

/* Le calendrier vise doit etre nomme, pas devine. */
assert(/WHERE c\.code = 'CG-STANDARD'/.test(migration), 'La migration doit viser le calendrier par son code');
assert(/day_type/.test(migration) && /'holiday'/.test(migration), 'Les jours doivent etre declares comme feries');

/* La limite doit rester dite : les annees suivantes ne se deduisent pas. */
assert(
  /Les années suivantes doivent être ajoutées/.test(migration),
  'La migration doit dire qu elle s arrete a 2027 et pourquoi'
);

console.log(JSON.stringify({
  fixedDatesDeclared: true,
  movableFeastsDerivedFromEaster: true,
  tenHolidaysPerYear: true,
  mondaysFallOnMondays: true,
  humanEntriesNeverOverwritten: true,
  calendarNamedExplicitly: true,
  limitDocumented: true,
}));
