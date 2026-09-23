'use strict';
/* ── Un compteur affiché ne se déduit pas de la longueur d'une page ──────────
 *
 * Les tuiles « FF en attente » et « contrats actifs » lisaient `rows.length`
 * sur des réponses demandées avec `limit=500`. Tant que la base tient sous 500
 * le nombre est juste par accident ; au-delà il plafonne sans rien dire. C'est
 * la même famille que le compteur du bandeau d'anomalies corrigé le
 * 18/09/2026 — un compte qui décrit la page rendue et non la réalité.
 *
 * La règle épinglée ici n'est pas une écriture, c'est une provenance : le
 * nombre affiché doit venir du serveur, seul à compter sans LIMIT. Une
 * reformulation qui conserve cette provenance doit passer ; une qui revient à
 * mesurer la page doit échouer.
 *
 * Et la règle a deux moitiés, dans deux fichiers. L'écran a le droit de faire
 * confiance au `total` seulement si la route le compte avec le même filtre que
 * les lignes. Épingler la moitié frontale et laisser la route libre de changer
 * son COUNT rendrait la garde décorative.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

const markup = read('frontend/dashboard.html');

/* ── 1. Côté écran : la provenance du nombre ─────────────────────────────── */

/* Renvoie l'instruction qui écrit dans la tuile, et ce qui la précède
   immédiatement — c'est là que le nombre est calculé. On ne cherche pas un nom
   de variable : on cherche d'où vient la valeur. */
function contexteTuile(id) {
  const marque = `document.getElementById('${id}')`;
  const pos = markup.indexOf(marque);
  assert.notStrictEqual(pos, -1, `La tuile ${id} doit exister dans le tableau de bord`);
  const finInstruction = markup.indexOf(';', pos);
  return {
    instruction: markup.slice(pos, finInstruction + 1),
    amont: markup.slice(Math.max(0, pos - 500), pos),
  };
}

for (const [id, reponse] of [['kpi-dettes-sub', 'dettes'], ['kpi-contrats', 'contrats']]) {
  const { instruction, amont } = contexteTuile(id);
  const ensemble = amont + instruction;

  assert(
    new RegExp(`${reponse}\\??\\.total`).test(ensemble),
    `${id} doit tirer son nombre du total renvoyé par la route (${reponse}.total), `
    + 'seul compté sans LIMIT — sinon la tuile plafonne en silence',
  );
  assert(
    !/rows\.length/.test(instruction),
    `${id} ne doit pas être écrite depuis rows.length : rows est la page rendue, `
    + 'bornée par limit=500, pas l\'ensemble des lignes qui existent',
  );
}

/* La prémisse de tout ceci : les deux lectures sont bien paginées. Si un jour
   le plafond disparaissait, cette garde devrait être relue — pas contournée. */
for (const appel of ['/achats/factures-fournisseurs?statut=validee&limit=', '/contrats?statut=actif&limit=']) {
  assert(
    markup.includes(appel),
    `L'appel ${appel}… doit rester borné : c'est ce qui rend la longueur de la page insuffisante`,
  );
}

/* ── 2. Côté route : le total compte le même périmètre que les lignes ────── */

/* Extrait le corps d'un gestionnaire depuis sa déclaration jusqu'à la
   fermeture de sa fonction. On borne sur la déclaration suivante plutôt que sur
   un nom de fonction : une garde qui balaie depuis un nom retombe sur un
   homonyme quelques centaines de lignes plus loin. */
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
  const corps = corpsRoute(read(fichier), declaration);

  /* On ne prend pas « le premier COUNT(*) » : la requête de lignes en contient
     elle-même, en sous-requêtes (nb_echeances, echeances_a_facturer). Une garde
     qui s'y accrocherait mesurerait la requête paginée et accuserait du code
     juste — c'est la version SQL de l'homonyme. On identifie le total par ce
     qui le définit : porter le même filtre que les lignes. */
  /* Le total est la requête dont le COUNT(*) est le SELECT extérieur. La
     requête de lignes porte le même filtre — c'est justement l'invariant — donc
     le filtre ne la distingue pas ; sa forme, si. */
  const totaux = corps
    .split('`')
    .filter(bloc => /^\s*SELECT\s+COUNT\(\*\)/i.test(bloc));
  assert(
    totaux.length === 1,
    `La route ${libelle} doit compter son total par une requête dont COUNT(*) est `
    + `le SELECT extérieur — trouvé ${totaux.length}`,
  );
  assert(
    /WHERE \$\{where\.join\(' AND '\)\}/.test(totaux[0]),
    `Le total de ${libelle} doit être compté avec le même filtre que les lignes `
    + `(WHERE \${where.join(' AND ')}) : un total plus large que la liste ferait `
    + 'mentir la tuile dans l\'autre sens',
  );
  assert(
    !/LIMIT/i.test(totaux[0]),
    `Le total de ${libelle} ne doit pas être borné — c'est précisément ce qu'il sert à dépasser`,
  );
}

console.log('kpi_compteurs_total_test: OK');
