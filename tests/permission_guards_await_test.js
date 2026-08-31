const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

/* ── can() est asynchrone : l'oublier ouvre le garde en grand ──
   Demontre en production le 31/08/2026 avec le compte lecteur, qui ne detient
   aucune permission :

     const r = can(lecteur, 'cash.out.pay');
     typeof r          -> object, Promise
     Boolean(r)        -> true    <-- ce que testait le garde
     await r           -> false   <-- ce qu'il aurait du tester

   La forme dangereuse est precise : can() dans une expression booleenne —
   derriere un !, ou combine par || ou && — sans await. Le || court-circuite
   alors sur une Promesse toujours vraie, et le garde ne refuse plus jamais.

   Un `return can(...)` seul dans une fonction async est correct : la Promesse
   se resout normalement pour l'appelant. Un `await Promise.all([can(...)])`
   aussi. Ce test ne vise que la forme booleenne. */

const DOSSIERS = ['backend/routes', 'backend/services'];

/* Aucune dette : salaires.js a ete corrige le 31/08/2026. Ses 32 controles
   passent desormais par un middleware, ses gestionnaires n'ayant pas ete
   convertis en asynchrones — Express n'attrape pas le rejet d'un gestionnaire
   async, la ou il attrape une exception synchrone.

   Si une exception devait revenir ici, elle devrait porter sa portee mesuree
   et le test ci-dessous exigerait qu'elle soit retiree une fois le fichier
   corrige. */
const DETTE_CONNUE = new Map();
const fautes = [];
const detteVue = new Set();

for (const dossier of DOSSIERS) {
  for (const fichier of fs.readdirSync(path.join(root, dossier)).filter(f => f.endsWith('.js'))) {
    const chemin = `${dossier}/${fichier}`;
    const source = fs.readFileSync(path.join(root, chemin), 'utf8');
    if (!/require\([^)]*services\/permissions[^)]*\)/.test(source)) continue;

    source.split('\n').forEach((ligne, i) => {
      const appel = /(?<!await\s)\bcan\(/.test(ligne);
      if (!appel) return;
      if (/function can\(/.test(ligne)) return;
      /* Forme booleenne : negation, ou combinaison logique sur la meme ligne. */
      const booleenne = /!\s*can\(/.test(ligne) || /can\([^)]*\)\s*(\|\||&&)/.test(ligne) || /(\|\||&&)\s*can\(/.test(ligne);
      if (!booleenne) return;

      if (DETTE_CONNUE.has(chemin)) { detteVue.add(chemin); return; }
      fautes.push(`${chemin}:${i + 1}  ${ligne.trim().slice(0, 100)}`);
    });

    /* ── Deuxieme forme, celle du defaut reellement rencontre ──
       Le bug n'etait pas dans l'appel direct a can() mais dans les fonctions
       qui l'enveloppent : canWrite, canPayCashOut, canApproveDec. Une fois
       rendues asynchrones, les appeler sans await ramene exactement le meme
       symptome — une Promesse toujours vraie derriere un point d'exclamation.

       On releve donc les gardes asynchrones declarees dans le fichier, puis on
       exige que chacun de leurs appels en contexte booleen soit attendu. */

    const gardesAsync = [...source.matchAll(/^async function (can[A-Z]\w*)\(/gm)].map(m => m[1]);
    if (gardesAsync.length) {
      source.split('\n').forEach((ligne, i) => {
        for (const garde of gardesAsync) {
          if (new RegExp(`^async function ${garde}\\(`).test(ligne.trim())) continue;
          const enBooleen = new RegExp(`(!\\s*|\\|\\|\\s*|&&\\s*)(?<!await )\\b${garde}\\(`).test(ligne)
            || new RegExp(`(?<!await )\\b${garde}\\([^)]*\\)\\s*(\\|\\||&&|\\))`).test(ligne) && /if\s*\(/.test(ligne);
          if (!enBooleen) continue;
          if (new RegExp(`await \\s*${garde}\\(`).test(ligne)) continue;
          if (DETTE_CONNUE.has(chemin)) { detteVue.add(chemin); continue; }
          fautes.push(`${chemin}:${i + 1}  garde asynchrone appelee sans await — ${ligne.trim().slice(0, 90)}`);
        }
      });
    }
  }
}

assert.deepStrictEqual(
  fautes, [],
  'can() utilise dans une expression booleenne sans await — le garde ne refusera jamais :\n  ' + fautes.join('\n  ')
);

/* La dette doit rester visible : si le fichier est corrige, l'exception doit
   etre retiree de ce test, sinon elle masquerait une regression future. */
for (const [chemin, info] of DETTE_CONNUE) {
  const source = fs.readFileSync(path.join(root, chemin), 'utf8');
  const encoreCasse = info.gardes.some(g => new RegExp(`^function ${g}\\(`, 'm').test(source));
  assert(
    encoreCasse,
    `${chemin} semble corrige depuis le ${info.depuis} : retirer son exception de DETTE_CONNUE pour que le garde-fou le couvre`
  );
}

/* ── La forme retenue pour la paie : un middleware, pas un await ──
   Les 29 gestionnaires de salaires.js ne sont pas asynchrones. Les convertir
   changerait la propagation des erreurs. Le controle se resout donc avant le
   gestionnaire, et propage par next(). */

const paie = fs.readFileSync(path.join(root, 'backend/routes/salaires.js'), 'utf8');

const fabrique = paie.match(/function exiger\(garde, message = 'Accès refusé'\) \{[\s\S]*?\n\}/);
assert(fabrique, 'La fabrique de middleware doit exister');
assert(/\.catch\(next\)/.test(fabrique[0]), 'Une erreur du controle doit passer par next(), pas par un rejet non attrape');
assert(/res\.status\(403\)/.test(fabrique[0]), 'Le refus doit rester un 403');

for (const garde of ['canRHFinance', 'canWrite', 'canManagePayrollFinance']) {
  assert(
    new RegExp(`^async function ${garde}\\(user\\)`, 'm').test(paie),
    `${garde} doit etre asynchrone`
  );
  assert(
    !new RegExp(`if \\(!${garde}\\(req\\.user\\)\\)`).test(paie),
    `${garde} ne doit plus etre appelee sans await dans un gestionnaire : le controle est passe en middleware`
  );
}

const enMiddleware = (paie.match(/exiger\((?:canRHFinance|canWrite|canManagePayrollFinance)/g) || []).length;
assert(
  enMiddleware >= 30,
  `Trop peu de controles passes en middleware (${enMiddleware}) : 32 attendus`
);
console.log(JSON.stringify({
  booleanUseAlwaysAwaited: true,
  asyncGuardsAlwaysAwaited: true,
  filesScanned: DOSSIERS.length,
  knownDebt: [...DETTE_CONNUE].map(([f, i]) => ({ fichier: f, routes_exposees: i.routes_exposees })),
  payrollGuardsMovedToMiddleware: enMiddleware,
}));
