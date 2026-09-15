'use strict';
/*
 * Garde — un CONCAT imbriqué se traduit jusqu'au bout pour SQLite.
 *
 * Défaut trouvé le 15/09/2026 par la CI, pas par la lecture du code.
 *
 * backend/db.js traduit le SQL MySQL vers SQLite. Il marque chaque CONCAT(
 * par un octet nul, puis resolveConcat remplace CONCAT(a, b) par (a || b).
 * La résolution ne faisait qu'UNE passe : elle consommait le CONCAT extérieur
 * d'un bloc, curseur compris, et recopiait son contenu tel quel — marqueur du
 * CONCAT intérieur inclus.
 *
 * Sur l'expression qui compose un nom :
 *
 *     CONCAT(u.nom, CASE WHEN COALESCE(u.prenom,'') != ''
 *                        THEN CONCAT(' ', u.prenom) ELSE '' END)
 *
 * le SQL rendu à SQLite contenait encore « \x00CONCAT\x00( ». SQLite refusait
 * avec « incomplete input », et GET /api/parapheur rendait 500. Mesuré :
 *
 *     version main       → 200 {"ok":true,"data":[]}
 *     version imbriquee  → 500 {"ok":false,"error":"incomplete input"}
 *
 * Le defaut etait latent : il n attendait que quelqu un ecrive un CONCAT dans
 * un CONCAT. La correction repete la passe tant qu un marqueur subsiste.
 */
const assert = require('assert');

process.env.DB_DRIVER = process.env.DB_DRIVER || 'sqlite';
const { mysqlToSqlite } = require('../backend/db');

const cas = [];
const verifier = (nom, fn) => { cas.push([nom, fn]); };

assert.strictEqual(
  typeof mysqlToSqlite, 'function',
  'La traduction MySQL vers SQLite doit etre exposee pour etre testable'
);

const MARQUEUR = '\x00CONCAT\x00(';

verifier('aucun marqueur ne survit a la traduction d un CONCAT imbrique', () => {
  const sql = "SELECT TRIM(CONCAT(u.nom, CASE WHEN COALESCE(u.prenom,'') != '' "
    + "THEN CONCAT(' ', u.prenom) ELSE '' END)) AS n FROM users u";
  const rendu = mysqlToSqlite(sql);
  assert.ok(
    !rendu.includes(MARQUEUR) && !rendu.includes('\x00'),
    'Un marqueur survit : SQLite refusera avec « incomplete input » et la route '
    + 'rendra 500. Rendu = ' + JSON.stringify(rendu.slice(0, 160))
  );
  assert.ok(
    !/CONCAT/i.test(rendu),
    'Il ne doit plus rester de CONCAT litteral apres traduction : ' + rendu.slice(0, 160)
  );
});

verifier('le CONCAT imbrique devient bien une concatenation SQLite', () => {
  const rendu = mysqlToSqlite("SELECT CONCAT('a', CONCAT('b', 'c')) AS r");
  assert.ok(rendu.includes('||'), 'la concatenation SQLite doit apparaitre : ' + rendu);
  assert.ok(!rendu.includes('\x00'), 'aucun octet nul ne doit subsister : ' + JSON.stringify(rendu));
});

verifier('trois niveaux d imbrication passent aussi', () => {
  const rendu = mysqlToSqlite("SELECT CONCAT('a', CONCAT('b', CONCAT('c', 'd'))) AS r");
  assert.ok(!rendu.includes('\x00'), 'aucun octet nul : ' + JSON.stringify(rendu));
});

verifier('un CONCAT simple rend exactement ce qu il rendait avant', () => {
  const rendu = mysqlToSqlite("SELECT CONCAT(a, ' ', b) AS r FROM t");
  assert.strictEqual(
    rendu, "SELECT (a || ' ' || b) AS r FROM t",
    'La correction ne doit rien changer au cas sans imbrication'
  );
});

verifier('une requete sans CONCAT traverse intacte', () => {
  const sql = 'SELECT id, nom FROM users WHERE actif = 1';
  assert.strictEqual(mysqlToSqlite(sql), sql);
});

/* La boucle doit s arreter : une chaine qui contiendrait un marqueur
   irreductible ne doit pas figer le serveur. */
verifier('la resolution ne boucle pas indefiniment', () => {
  const depart = Date.now();
  mysqlToSqlite("SELECT " + "CONCAT('a', ".repeat(20) + "'z'" + ')'.repeat(20) + ' AS r');
  assert.ok(Date.now() - depart < 2000, 'la traduction doit rester bornee en temps');
});

/* Le vrai SQL du parapheur, celui qui rendait 500. */
verifier('la requete du parapheur se traduit sans marqueur', () => {
  const sql = `
    SELECT p.*,
           TRIM(CONCAT(u.nom, CASE WHEN COALESCE(u.prenom,'') != '' THEN CONCAT(' ', u.prenom) ELSE '' END)) AS initiateur_nom,
           TRIM(CONCAT(t.nom, CASE WHEN COALESCE(t.prenom,'') != '' THEN CONCAT(' ', t.prenom) ELSE '' END)) AS transmis_par_nom
    FROM parapheur p
    LEFT JOIN users u ON u.id = p.initiateur_id
    LEFT JOIN users t ON t.id = p.transmis_par_id`;
  const rendu = mysqlToSqlite(sql);
  assert.ok(!rendu.includes('\x00'),
    'C est exactement la requete qui rendait 500 le 15/09/2026');
  assert.ok((rendu.match(/\|\|/g) || []).length >= 4,
    'les quatre concatenations doivent etre rendues : ' + rendu.slice(0, 200));
});

let echecs = 0;
for (const [nom, fn] of cas) {
  try { fn(); console.log(`  ok   ${nom}`); }
  catch (e) { echecs++; console.error(`  ECHEC ${nom}\n        ${e.message}`); }
}
console.log(`\n${cas.length - echecs}/${cas.length} gardes vertes — CONCAT imbrique`);
process.exit(echecs ? 1 : 0);
