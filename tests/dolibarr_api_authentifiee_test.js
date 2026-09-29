'use strict';
/*
 * Garde — une classe d'API livrée à Dolibarr exige l'authentification.
 *
 * Constaté le 29/09/2026 sur le bac à sable : sans les annotations
 * « @access protected » et « @class DolibarrApiAccess {@requires user,external} »
 * dans le bloc de la classe, Restler publie les points d'API SANS
 * authentification. Le module « smi » répondait 500 au lieu de 401 sans clé ;
 * il n'a rien exposé parce qu'aucun utilisateur n'était chargé, pas parce qu'il
 * était protégé.
 *
 * La règle vaut pour toute classe api_*.class.php sous integrations/dolibarr,
 * présente ou à venir.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const racine = path.join(__dirname, '..', 'integrations', 'dolibarr');

function fichiersApi(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return fichiersApi(p);
    return /^api_.+\.class\.php$/.test(e.name) ? [p] : [];
  });
}

const fichiers = fichiersApi(racine);
assert.ok(fichiers.length >= 1, 'Aucune classe d API trouvee sous integrations/dolibarr : la garde ne mesurerait rien');

let echecs = 0;
for (const f of fichiers) {
  const src = fs.readFileSync(f, 'utf8');
  const classes = [...src.matchAll(/class\s+(\w+)\s+extends\s+DolibarrApi\b/g)];
  assert.ok(classes.length, path.relative(racine, f) + ' : aucune classe DolibarrApi');
  for (const m of classes) {
    // Le bloc de commentaire qui précède immédiatement la déclaration de classe.
    const avant = src.slice(0, m.index);
    const bloc = (avant.match(/\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*$/) || [])[1] || '';
    const protege = /@access\s+protected\b/.test(bloc);
    const exige = /@class\s+DolibarrApiAccess\s*\{@requires\s+user,external\}/.test(bloc);
    const nom = path.relative(racine, f) + ' / ' + m[1];
    if (protege && exige) { console.log('  ok   ' + nom + ' exige l authentification'); continue; }
    console.log('  ECHEC ' + nom + ' : ' + [!protege && '@access protected', !exige && '@class DolibarrApiAccess {@requires user,external}'].filter(Boolean).join(' et ') + ' manquant — points d API publics');
    echecs++;
  }
}
if (echecs) process.exitCode = 1;
console.log(`${fichiers.length - echecs}/${fichiers.length} classes d API Dolibarr authentifiees`);
