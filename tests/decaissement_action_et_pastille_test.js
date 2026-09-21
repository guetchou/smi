'use strict';
/*
 * Garde — un decaissement n'agit pas sans identifiant, et sa pastille ne ment pas.
 *
 * Defaut 1 — mesure du 10/09/2026 a 10:56:33, ligne 42 du journal des refus :
 *     PUT /api/operations/undefined/soumettre   ->   HTTP 404
 * L'agent avait clique « Soumettre » dans la file des decaissements ; la ligne
 * qui avait dessine le bouton ne portait pas d'« id » ; la requete est partie
 * avec un identifiant vide, le serveur a refuse, et l'ecran n'a rien dit. Du
 * point de vue de l'agent : « ca n'a pas marche », sans explication.
 * Deux exigences, donc : ne pas partir avec un identifiant vide, et ne pas
 * rester muet — le produit signale deja ses echecs par showToast.
 *
 * Defaut 2 — le badge lateral #badge-ops avait DEUX ecrivains :
 *   — pollPendingBadge, toutes les 30 s, a partir du vrai compteur
 *     GET /operations/decaissements/pending-count ;
 *   — loadPendingDec, a partir de rows.length — or la route
 *     GET /operations/decaissements/pending plafonne a LIMIT 200
 *     (backend/routes/operations.js). Des la 201e ligne, ce second ecrivain
 *     ecrasait le premier avec 200, indefiniment.
 * Le plafond n'est que le symptome ; le defaut est le second ecrivain. Motif
 * retenu : celui de loadOperationSyncErrors (PR #218) — la liste est plafonnee,
 * la pastille vient du compteur serveur.
 *
 * Ce qui est garde ici, c'est la regle et non la syntaxe : chaque fonction est
 * decoupee avant d'etre lue (un nom de fonction balaye sur tout le fichier
 * retombe sur un homonyme), et la validation d'identifiant est reellement
 * executee sur la valeur meme qui est partie le 10/09.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'dashboard.html'), 'utf8');

const cas = [];
const verifier = (nom, fn) => { cas.push([nom, fn]); };

/* Decoupe la fonction nommee, et elle seule. Une definition unique est exigee :
   sans cela la garde peut lire un homonyme situe des centaines de lignes plus
   loin et signer vert sur du code qui n'est pas celui qu'elle protege. */
function decouper(nom) {
  const signature = new RegExp(`(?:async\\s+)?function ${nom}\\s*\\(`, 'g');
  const trouves = html.match(signature) || [];
  assert.strictEqual(trouves.length, 1,
    `${nom} doit etre definie une seule fois (trouvee ${trouves.length} fois) : `
    + 'une garde qui lit un homonyme ne protege rien');
  const debut = html.search(new RegExp(`(?:async\\s+)?function ${nom}\\s*\\(`));
  const fin = html.indexOf('\n}', debut);
  assert.ok(fin > debut, `fin de ${nom} introuvable`);
  return html.slice(debut, fin + 2);
}

const ACTIONS = ['decAction', 'decAnnuler', 'decRejeter', 'decResoumettre'];
/* « if (!<validation>(id)) { ... } » — le nom de la validation n'est pas
   impose, seule compte la coupure. */
const COUPURE = /if\s*\(\s*!\s*([A-Za-z_$][\w$]*)\s*\(\s*id\s*\)\s*\)\s*\{([^}]*)\}/;

function premierDepart(corps) {
  const jalons = ['api(', 'withLock(', 'showConfirm(', 'showPrompt(']
    .map(j => corps.indexOf(j))
    .filter(i => i >= 0);
  return jalons.length ? Math.min(...jalons) : corps.length;
}

let nomValidation = null;

verifier('aucune action de decaissement ne part avec un identifiant vide', () => {
  for (const nom of ACTIONS) {
    const corps = decouper(nom);
    const coupure = corps.match(COUPURE);
    assert.ok(coupure,
      `${nom} doit refuser un identifiant inexploitable avant toute autre chose : `
      + 'le 10/09/2026 a 10:56:33, PUT /api/operations/undefined/soumettre est parti '
      + 'et le serveur a repondu 404');
    assert.ok(coupure.index < premierDepart(corps),
      `${nom} : la coupure doit precedes la premiere demande faite a l'utilisateur `
      + "ou au serveur — confirmer puis echouer, c'est faire perdre le geste");
    nomValidation = nomValidation || coupure[1];
    assert.strictEqual(coupure[1], nomValidation,
      'les quatre actions doivent partager la meme validation : quatre regles tenues '
      + 'separement finissent par diverger');
  }
});

verifier('le refus est dit a l ecran, il ne reste pas muet', () => {
  for (const nom of ACTIONS) {
    const corps = decouper(nom);
    const bloc = (corps.match(COUPURE) || [])[2] || '';
    assert.ok(/showToast\s*\(/.test(bloc),
      `${nom} : l'agent doit apprendre pourquoi rien ne se passe — c'est le silence `
      + 'qui a rendu le defaut du 10/09 incomprehensible, pas le 404');
    assert.ok(/\breturn\b/.test(bloc),
      `${nom} : la coupure doit interrompre l'action, pas seulement la commenter`);
  }
});

verifier('la validation refuse ce qui est parti le 10/09 et accepte un vrai identifiant', () => {
  assert.ok(nomValidation, 'aucune validation reperee dans les actions');
  const source = decouper(nomValidation);
  const valider = new Function(`${source}\nreturn ${nomValidation};`)();
  /* La valeur reellement partie ce jour-la est la chaine « undefined » une fois
     interpolee dans l'attribut onclick ; la valeur d'origine est undefined. */
  for (const refuse of [undefined, null, '', '   ', 'undefined', 'null', NaN, 0, -1, 1.5, 'abc', '7abc', {}, []]) {
    assert.strictEqual(valider(refuse), false,
      `${JSON.stringify(String(refuse))} n'est pas un identifiant de decaissement : `
      + 'il ne doit jamais atteindre /operations/:id/...');
  }
  for (const accepte of [1, 42, '42', 12345]) {
    assert.strictEqual(valider(accepte), true,
      `${accepte} est un identifiant legitime : la coupure ne doit pas bloquer le travail`);
  }
});

verifier('le badge lateral des operations n a qu un seul ecrivain', () => {
  const ecrivains = (html.match(/getElementById\('badge-ops'\)/g) || []).length;
  assert.strictEqual(ecrivains, 1,
    'Deux fonctions ecrivant #badge-ops, dont une plafonnee par LIMIT 200, le font '
    + "mentir des la 201e ligne — et c'est le badge qu'on croit");
  assert.ok(decouper('pollPendingBadge').includes("getElementById('badge-ops')"),
    'le seul ecrivain doit rester celui qui lit le compteur serveur');
});

verifier('la file des decaissements ne recopie plus le badge lateral', () => {
  const corps = decouper('loadPendingDec');
  assert.ok(!/getElementById\(\s*'badge-ops'\s*\)/.test(corps),
    'loadPendingDec ecrivait #badge-ops avec rows.length, plafonne a LIMIT 200 par '
    + 'la route /operations/decaissements/pending');
  assert.ok(/pollPendingBadge\s*\(\s*\)/.test(corps),
    'elle doit demander au seul ecrivain de se rafraichir, sinon le badge reste en '
    + "retard jusqu'au prochain tour de 30 s");
});

verifier('la pastille « en attente » vient du compteur serveur, pas de la page de 200', () => {
  const corps = decouper('loadPendingDec');
  assert.ok(!/countEl\.textContent\s*=\s*rows\.length/.test(corps),
    'rows.length est la page rendue, plafonnee a LIMIT 200 : au-dela, la pastille '
    + 'ment indefiniment');
  assert.ok(corps.includes('decaissements/pending-count'),
    'le vrai compte existe deja cote serveur — meme motif que loadOperationSyncErrors '
    + '(PR #218), qui lit « counts » plutot que la liste plafonnee a huit');
});

let echecs = 0;
for (const [nom, fn] of cas) {
  try { fn(); console.log(`  ok   ${nom}`); }
  catch (e) { echecs++; console.error(`  ECHEC ${nom}\n        ${e.message}`); }
}
console.log(`\n${cas.length - echecs}/${cas.length} gardes vertes — action de decaissement et pastille en attente`);
process.exit(echecs ? 1 : 0);
