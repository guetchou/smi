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

/* ── 2 bis. On ne va pas chercher des donnees qu on ne peut pas afficher ──
   Le verrou empeche deux init() concurrents, pas des reprises successives.
   Si render() sort sans rien creer, la condition de garde de l observateur
   reste vraie et init() repart : mesure en production apres le premier
   correctif, /admin/config et /corrections partaient encore 3 fois.
   Les conditions de rendu doivent donc etre evaluees avant le reseau. */

const adminUi = read('frontend/js/pages/pointeuse-v3-admin-ui.js');
assert(
  /function peutRendre\(\)\{ return allowed\(\) && location\.pathname\.startsWith\('\/app\/rh\/pointeuse'\) && !!document\.getElementById\('pointeuse-v3-root'\); \}/.test(adminUi),
  'La console doit savoir dire si elle peut rendre, sans appeler le reseau'
);
assert(
  /if\(chargementEnCours\)return; if\(!peutRendre\(\)\)return;/.test(adminUi),
  'La condition de rendu doit etre testee avant le chargement, pas apres'
);

/* Les memes conditions que render(), sinon init() chargerait pour rien
   ou refuserait de charger alors que le rendu etait possible. */
const rendu = adminUi.match(/function render\(\)\{[^\n]*/)[0];
for (const condition of ['allowed()', "location.pathname.startsWith('/app/rh/pointeuse')", "getElementById('pointeuse-v3-root')"]) {
  assert(rendu.includes(condition), `render() ne teste plus ${condition} : peutRendre() doit etre reajuste`);
}

/* La coquille agent applique deja cette discipline. */
const agentInit = read('frontend/js/pages/pointeuse-v3.js').match(/async function init\(\)\{[\s\S]*?\n  \}/)[0];
assert(
  /if\(!isRoute\(\)\)return; const t=target\(\); if\(!t\)return;[\s\S]*?await loadStatus/.test(agentInit),
  'La coquille agent doit continuer a verifier avant d appeler le reseau'
);

/* ── 2 ter. Les referentiels d organisation passent par le cache du transport ──
   postes 3 fois, departements 4, sites 3, arbre 3 par chargement. La duree
   doit rester courte : elle fond les appels d un meme chargement sans jamais
   masquer une creation faite depuis l interface. */

const transport = read('frontend/js/core/transport.js');
const markupOrg = read('frontend/dashboard.html');
const ttl = transport.match(/\[\/\\\/api\\\/org\\\/\(\?:postes\|departements\|sites\|arbre\)\(\?:\\\?\|\$\)\/, (\d+)\]/);
assert(ttl, 'Les referentiels d organisation doivent figurer dans la table de cache du transport');

/* Premiere version de ce test : « duree <= 5 s, sinon une creation resterait
   invisible ». C etait le mauvais invariant, et il a fallu la mesure pour le
   voir. Un chargement de cette page emet une quarantaine de requetes et dure
   plus de trois secondes : un cache plus court que le chargement ne fond rien.
   Et raccourcir la duree ne protege pas une creation — seul le contournement
   explicite la protege. La regle est donc double. */

assert(
  Number(ttl[1]) >= 10000,
  `Duree de cache trop courte (${ttl[1]} ms) : elle expire avant la fin du chargement qu elle doit fondre`
);
assert(
  Number(ttl[1]) <= 60000,
  `Duree de cache trop longue (${ttl[1]} ms) : ces donnees changent depuis l interface`
);

/* Toute lecture qui suit une ecriture doit contourner le cache, sinon la
   nouveaute n apparait pas. C est cela qui protege une creation, pas la duree. */
assert(
  /async function loadOrgRefs\(apresEcriture = false\) \{/.test(markupOrg),
  'Le rechargement des referentiels doit savoir qu il suit une ecriture'
);
assert(
  /const opts = apresEcriture \? \{ noCache: true \} : \{\};/.test(markupOrg),
  'Une lecture qui suit une ecriture doit contourner le cache du transport'
);

/* Chaque ecriture doit passer le drapeau : en oublier un ferait disparaitre
   la creation correspondante pendant toute la duree du cache. */
const rechargements = [...markupOrg.matchAll(/showToast\('(?:Poste|Site) (?:créé|modifié)', 'success'\); loadOrgRefs\((true)?\);/g)];
assert(rechargements.length >= 4, `Trop peu de rechargements apres ecriture analyses (${rechargements.length})`);
for (const r of rechargements) {
  assert(r[1] === 'true', `Rechargement apres ecriture sans contournement du cache : ${r[0]}`);
}
/* ── 3. Les appels independants doivent partir ensemble ── */

const agent = read('frontend/js/pages/pointeuse-v3.js');
assert(
  /Promise\.all\(\[api\('\/capabilities'\),api\('\/me\/status'\)\]\)/.test(agent),
  'Les capacites et l etat du jour sont independants : ils doivent partir en parallele'
);

assert(
  /Promise\.all\(\[api\('\/admin\/config'\),api\('\/corrections\?status=submitted'/.test(adminUi),
  'La configuration et les corrections sont independantes : elles doivent partir en parallele'
);

/* ── 4. Le null du transport ne doit plus etre deference ──
   Le transport notifie puis retourne null ; il ne leve pas. Un catch place
   apres ne rattrape donc pas l'echec HTTP mais le deferencement qui suit. */

assert(
  /corrections=c\?\.corrections\|\|\[\];/.test(adminUi),
  'La reponse du transport peut etre null : l acces doit etre optionnel'
);
assert(
  /api\('\/corrections\?status=submitted',\{silentStatuses:\[403\]\}\)/.test(adminUi),
  'Un 403 attendu doit etre declare silencieux, pas rattrape apres coup'
);
assert(
  !/catch\(_\)\{corrections=\[\];\}/.test(adminUi),
  'Le rattrapage apres coup doit avoir disparu'
);

console.log(JSON.stringify({
  observerMutedWhileRendering: true,
  observerResumesAfterFailure: true,
  concurrentInitPrevented: true,
  renderConditionsCheckedBeforeNetwork: true,
  referenceDataCacheCoversPageLoad: true,
  writesBypassCache: true,
  independentCallsParallel: true,
  transportNullNotDereferenced: true,
}));
