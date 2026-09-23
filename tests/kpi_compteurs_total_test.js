'use strict';
/* ── Un compteur affiché ne se déduit pas de la page rendue ──────────────────
 *
 * Les tuiles « FF en attente », « dettes fournisseurs », « contrats actifs » et
 * leur valeur mensuelle se calculaient à partir d'une réponse demandée avec
 * `limit=500` : `rows.length` pour les nombres, `rows.reduce(...)` pour les
 * montants. Tant que la base tient sous 500 c'est juste par accident ; au-delà
 * ça plafonne sans rien dire. Même famille que le compteur du bandeau
 * d'anomalies corrigé le 18/09/2026.
 *
 * La règle épinglée n'est pas une écriture, c'est une provenance : le nombre et
 * le montant affichés doivent venir du serveur, seul à compter et sommer sans
 * LIMIT. Une reformulation qui conserve cette provenance doit passer ; une qui
 * revient à mesurer la page doit échouer.
 *
 * La règle a deux moitiés, dans deux fichiers. L'écran n'a le droit de faire
 * confiance au serveur que si la route compte et somme avec le même filtre que
 * les lignes. Épingler la moitié frontale et laisser la route libre de changer
 * son agrégat rendrait la garde décorative.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const markup = read('frontend/dashboard.html');

/* ── 1. Côté écran : la provenance des nombres ───────────────────────────── */

/* On borne la lecture au corps de la fonction qui remplit ces tuiles. Sans
   cette borne, une recherche dans 1,5 Mo retombe sur un homonyme d'une autre
   fonction et la garde mesure autre chose que ce qu'elle annonce. */
function corpsKpisEtendus() {
  const debut = markup.indexOf('async function loadDashboardKpisEtendus() {');
  assert.notStrictEqual(debut, -1, 'La fonction loadDashboardKpisEtendus doit exister');
  const fin = markup.indexOf('function kpisEtendusIndisponibles() {', debut);
  assert.notStrictEqual(fin, -1, 'La fonction de repli doit suivre : elle sert de borne de fin');
  return markup.slice(debut, fin);
}

const corps = corpsKpisEtendus();

/* Renvoie l'instruction qui écrit dans la tuile et ce qui la précède — c'est là
   que la valeur est calculée. On ne cherche pas un nom de variable, on cherche
   d'où vient la valeur. */
function contexteTuile(id) {
  const marque = `document.getElementById('${id}')`;
  const pos = corps.indexOf(marque);
  assert.notStrictEqual(pos, -1, `La tuile ${id} doit être remplie dans loadDashboardKpisEtendus`);
  const finInstruction = corps.indexOf(';', pos);
  return corps.slice(Math.max(0, pos - 600), finInstruction + 1);
}

/* Ce que chaque tuile doit lire, et le champ de réponse qui le porte. */
const TUILES = [
  { id: 'kpi-dettes-sub', champ: 'dettes?.total', quoi: 'le nombre de factures' },
  { id: 'kpi-dettes', champ: 'dettes?.total_montant', quoi: 'le montant dû' },
  { id: 'kpi-contrats', champ: 'contrats?.total', quoi: 'le nombre de contrats' },
  { id: 'kpi-contrats-sub', champ: 'contrats?.total_montant', quoi: 'la valeur mensuelle' },
];

for (const { id, champ, quoi } of TUILES) {
  const contexte = contexteTuile(id);
  assert(
    contexte.includes(champ),
    `${id} doit tirer ${quoi} de ${champ} : le serveur seul compte et somme sans LIMIT, `
    + 'la page rendue est bornée à 500 lignes',
  );
}

/* Les nombres du serveur passent par un lecteur unique. Un SUM MySQL revient en
   chaîne décimale : lu par un Number.isFinite() nu, il serait rejeté et le repli
   local s'appliquerait en silence — le plafond reviendrait sans prévenir. */
assert(
  /function nombreServeur\(/.test(markup),
  'Un lecteur unique doit convertir les agrégats du serveur (un SUM MySQL est une chaîne)',
);
for (const { id } of TUILES) {
  assert(
    /nombreServeur\(/.test(contexteTuile(id)),
    `${id} doit passer par nombreServeur() : une lecture directe casse sur un SUM rendu en chaîne`,
  );
}

/* La prémisse de tout ceci : les deux lectures sont bien paginées. Si le plafond
   disparaissait, cette garde devrait être relue — pas contournée. */
for (const appel of ['/achats/factures-fournisseurs?statut=validee&limit=', '/contrats?statut=actif&limit=']) {
  assert(
    markup.includes(appel),
    `L'appel ${appel}… doit rester borné : c'est ce qui rend la page insuffisante`,
  );
}

/* ── 2. Côté route : l'agrégat porte le même périmètre que les lignes ────── */

/* Borne le corps d'un gestionnaire sur la déclaration suivante plutôt que sur un
   nom de fonction : une garde qui balaie depuis un nom retombe sur un homonyme
   quelques centaines de lignes plus loin. */
function corpsRoute(source, declaration) {
  const debut = source.indexOf(declaration);
  assert.notStrictEqual(debut, -1, `La route ${declaration} doit exister`);
  const suivant = source.indexOf('\nrouter.', debut + declaration.length);
  const fin = source.indexOf('\n});', debut);
  const borne = suivant === -1 ? fin : Math.min(suivant, fin === -1 ? suivant : fin);
  return source.slice(debut, borne === -1 ? source.length : borne);
}

const routes = [
  {
    fichier: 'backend/routes/achats.js',
    declaration: "router.get('/factures-fournisseurs', async (req, res, next) => {",
    libelle: 'factures fournisseurs',
  },
  {
    fichier: 'backend/routes/contrats.js',
    declaration: "router.get('/',",
    libelle: 'contrats',
  },
];

for (const { fichier, declaration, libelle } of routes) {
  const corpsRte = corpsRoute(read(fichier), declaration);

  /* L'agrégat est la requête dont le COUNT(*) est le SELECT extérieur. La
     requête de lignes porte le même filtre — c'est justement l'invariant — donc
     le filtre ne la distingue pas ; sa forme, si. */
  const agregats = corpsRte.split('`').filter(bloc => /^\s*SELECT\s+COUNT\(\*\)/i.test(bloc));
  assert(
    agregats.length === 1,
    `La route ${libelle} doit agréger par une requête dont COUNT(*) est le SELECT `
    + `extérieur — trouvé ${agregats.length}`,
  );
  const agregat = agregats[0];

  assert(
    /WHERE \$\{where\.join\(' AND '\)\}/.test(agregat),
    `L'agrégat de ${libelle} doit porter le même filtre que les lignes `
    + `(WHERE \${where.join(' AND ')}) : un total plus large que la liste ferait `
    + 'mentir la tuile dans l\'autre sens',
  );
  assert(
    /\bSUM\s*\(/i.test(agregat),
    `L'agrégat de ${libelle} doit aussi sommer côté serveur : sans SUM, le montant `
    + 'reste calculé sur la page rendue même quand le nombre est juste',
  );
  assert(
    !/LIMIT/i.test(agregat),
    `L'agrégat de ${libelle} ne doit pas être borné — c'est précisément ce qu'il sert à dépasser`,
  );
}

console.log('kpi_compteurs_total_test: OK');
