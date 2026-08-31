const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const service = fs.readFileSync(path.join(root, 'backend/services/notif.js'), 'utf8');

/* ── Le libellé vit en base, pas dans une copie du code ──
   Les rappels fiscaux s'affichaient sous leur code technique :
   RAP_DGI_MENSUEL, [ESCALADE] RAP_IS_ACOMPTE, RAP_CNSS_TRIMESTRE.

   _titreRappel portait un dictionnaire code en dur de 8 libelles, alors que
   notif_regles en compte 13 pour la famille rappel, toutes renseignees. Les
   cinq echeances fiscales manquaient a la copie, donc « ?? type » rendait le
   code brut — et ce sont celles qui inondaient la boite : 747 messages DGI,
   279 CNSS, 258 IS. */

const fonction = service.match(/function _titreRappel\([^)]*\) \{[\s\S]*?\n\}/)[0];

/* La copie en dur ne doit pas revenir : elle diverge de la base des qu'une
   regle est ajoutee. */
for (const code of ['RAP_SALAIRE_MENSUEL', 'RAP_CONTRAT_FIN', 'RAP_ESSAI_FIN']) {
  assert(
    !fonction.includes(code),
    `Un dictionnaire de libelles est reapparu dans le code (${code}) : la source est notif_regles.libelle`
  );
}
assert(
  /return rap\?\.libelle \|\| rap\?\.type \|\| 'Rappel';/.test(fonction),
  'Le titre doit venir du libelle de la regle, avec repli sur le type puis un mot generique'
);

/* Le code brut ne doit jamais etre le premier choix. */
const iLibelle = fonction.indexOf('rap?.libelle');
const iType = fonction.indexOf('rap?.type');
assert(iLibelle !== -1 && iType !== -1 && iLibelle < iType, 'Le libelle doit primer sur le type');

/* Les deux requetes joignent deja notif_regles : elles doivent en rapporter
   le libelle, sinon la fonction ne recevra jamais rien. */
const requetes = [...service.matchAll(/SELECT r\.\*, rg\.[^\n]*\n\s*FROM notif_rappels r/g)].map(m => m[0]);
assert.strictEqual(requetes.length, 2, `Deux requetes sur notif_rappels attendues, ${requetes.length} trouvee(s)`);
for (const q of requetes) {
  assert(/rg\.libelle/.test(q), `Une requete ne rapporte pas rg.libelle :\n${q}`);
}

/* Les deux appels doivent passer la ligne complete, pas le seul type. */
const appels = [...service.matchAll(/_titreRappel\(([^)]*)\)/g)]
  .map(m => m[1])
  .filter(a => a !== 'rap' || true);
for (const a of appels) {
  assert.strictEqual(a, 'rap', `_titreRappel doit recevoir la ligne complete, recu : ${a}`);
}
assert(appels.length >= 3, 'Les deux appels et la declaration doivent etre presents');

/* L escalade prefixe le meme libelle : elle ne doit pas reconstruire le sien. */
assert(
  /`\[ESCALADE\] \$\{_titreRappel\(rap\)\}`/.test(service),
  'L escalade doit prefixer le libelle de la regle, pas un titre reconstruit'
);

/* ── Les messages deja emis portent encore leur code ──
   Le correctif du code ne vaut que pour les rappels a venir. Les 97 messages
   restes en base apres la deduplication affichaient tous un code brut, et
   uniquement les cinq echeances fiscales. Ils sont reecrits depuis la meme
   source par la migration 052. */

const migration = fs.readFileSync(path.join(root, 'backend/migrations/052_notif_titres_lisibles.sql'), 'utf8');

assert(
  /SET m\.titre = rg\.libelle/.test(migration),
  'Les titres doivent etre reecrits depuis notif_regles.libelle, pas depuis une liste'
);
assert(
  /SET m\.titre = CONCAT\('\[ESCALADE\] ', rg\.libelle\)/.test(migration),
  'Une escalade doit garder son prefixe et ne remplacer que le code'
);

/* La condition doit rester etroite : un titre deja lisible, ou modifie a la
   main, ne doit pas etre ecrase. */
assert(
  /AND m\.titre = m\.type\b/.test(migration),
  'Seul un titre strictement egal au code doit etre reecrit'
);
assert(
  /AND m\.titre = CONCAT\('\[ESCALADE\] ', m\.type\)/.test(migration),
  'Seule une escalade strictement egale au code prefixe doit etre reecrite'
);
assert(
  !/WHERE m\.famille = 'rappel'\s*\n\s*AND rg\.libelle/.test(migration),
  'La reecriture ne doit pas s appliquer a tous les rappels sans distinction'
);

/* Les autres familles ne sont pas concernees. */
assert.strictEqual(
  (migration.match(/famille = 'rappel'/g) || []).length, 2,
  'Chacune des deux mises a jour doit se limiter a la famille rappel'
);

/* Un libelle vide ne doit pas remplacer un code par du vide. */
assert.strictEqual(
  (migration.match(/rg\.libelle <> ''/g) || []).length, 2,
  'Un libelle vide ne doit jamais remplacer le titre'
);
console.log(JSON.stringify({
  labelReadFromRuleNotCode: true,
  existingTitlesRewrittenFromSameSource: true,
  rewriteConditionNarrow: true,
  hardcodedCopyRemoved: true,
  bothQueriesCarryTheLabel: true,
  bothCallsPassTheRow: true,
  escalationReusesTheSameLabel: true,
}));
