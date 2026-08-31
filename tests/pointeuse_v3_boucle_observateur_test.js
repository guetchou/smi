const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const MODULES = [
  ['frontend/js/pages/pointeuse-v3.js', 'pointeuse-v3-root'],
  ['frontend/js/pages/pointeuse-v3-admin-ui.js', 'pointeuse-v3-admin-console'],
];

for (const [chemin] of MODULES) new Function(read(chemin));

/* ── 1. L'observateur ne doit pas se declencher sur ses propres ecritures ──
   Les deux modules surveillent documentElement en subtree et ecrivent dans
   ce meme arbre. Un chargement de page emettait 9 appels a /me/status,
   7 a /capabilities, 6 a /admin/config et 6 a /corrections. */

for (const [chemin] of MODULES) {
  const src = read(chemin);

  assert(
    /function sansObservateur\(fn\)\{ obs\.disconnect\(\);/.test(src),
    `${chemin} : le rendu doit se faire observateur deconnecte`
  );
  assert(
    /obs\.takeRecords\(\); obs\.observe\(document\.documentElement,SURVEILLANCE\);/.test(src),
    `${chemin} : la file accumulee pendant l'ecriture doit etre videe avant de reprendre`
  );
  assert(
    /finally \{ obs\.takeRecords\(\)/.test(src),
    `${chemin} : la reprise de l'observation doit survivre a une exception du rendu`
  );
  assert(
    /sansObservateur\(render\)/.test(src),
    `${chemin} : c'est le rendu qui doit etre mis en sourdine`
  );

  /* ── 2. Deux init() ne doivent jamais courir en parallele ──
     init() attend le reseau avant de creer sa racine ; le debounce est plus
     court que l'attente, donc la condition de garde de l'observateur reste
     vraie pendant tout ce temps. */

  assert(
    /let chargementEnCours=false;/.test(src),
    `${chemin} : un verrou doit exister contre les executions concurrentes`
  );
  assert(
    /if\(chargementEnCours\)return;/.test(src),
    `${chemin} : le verrou doit etre teste en entree d'init`
  );
  assert(
    /finally\{ chargementEnCours=false; \}/.test(src),
    `${chemin} : le verrou doit etre relache meme en cas d'echec reseau`
  );

  /* L'observation initiale et la reprise doivent porter les memes options :
     une reprise plus etroite laisserait passer des mutations. */
  assert(
    /const SURVEILLANCE=\{subtree:true,childList:true\};/.test(src),
    `${chemin} : les options d'observation doivent etre nommees une seule fois`
  );
  assert(
    !/obs\.observe\(document\.documentElement,\{/.test(src),
    `${chemin} : aucune option d'observation ne doit etre redeclaree en ligne`
  );
}

/* ── 3. Les appels independants doivent partir ensemble ── */

const agent = read('frontend/js/pages/pointeuse-v3.js');
assert(
  /Promise\.all\(\[api\('\/capabilities'\),api\('\/me\/status'\)\]\)/.test(agent),
  'Les capacites et l etat du jour sont independants : ils doivent partir en parallele'
);

const console_ = read('frontend/js/pages/pointeuse-v3-admin-ui.js');
assert(
  /Promise\.all\(\[api\('\/admin\/config'\),api\('\/corrections\?status=submitted'/.test(console_),
  'La configuration et les corrections sont independantes : elles doivent partir en parallele'
);

/* ── 4. Le null du transport ne doit plus etre deference ──
   Le transport notifie puis retourne null ; il ne leve pas. Un catch place
   apres ne rattrape donc pas l'echec HTTP mais le deferencement qui suit. */

assert(
  /corrections=c\?\.corrections\|\|\[\];/.test(console_),
  'La reponse du transport peut etre null : l acces doit etre optionnel'
);
assert(
  /api\('\/corrections\?status=submitted',\{silentStatuses:\[403\]\}\)/.test(console_),
  'Un 403 attendu doit etre declare silencieux, pas rattrape apres coup'
);
assert(
  !/catch\(_\)\{corrections=\[\];\}/.test(console_),
  'Le rattrapage apres coup doit avoir disparu'
);

console.log(JSON.stringify({
  observerMutedWhileRendering: true,
  observerResumesAfterFailure: true,
  concurrentInitPrevented: true,
  independentCallsParallel: true,
  transportNullNotDereferenced: true,
}));
