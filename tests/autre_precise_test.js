'use strict';
/*
 * Garde — « Autre » dit lequel, et un encaissement a toujours son tiers.
 *
 * Deux constats du 17/09/2026.
 *
 * 1. « dans les menus deroulants en mettant Autre... il doit avoir un truc qui
 *    sort pour dire autre la c'est quoi ». Le decaissement proposait « Autre
 *    justificatif » et « Autre tiers », et rien ne demandait lequel. C'est la
 *    que « n'importe quoi » s'accumule, et c'est invisible ensuite.
 *
 *    Chez les industriels, un fourre-tout n'est jamais muet : l'option
 *    « Autre » s'accompagne toujours d'une precision obligatoire, rangee dans
 *    son propre champ, et relue periodiquement — ce qui revient souvent
 *    devient une vraie rubrique. La colonne « piece_justificative » existait
 *    deja en base et la route de creation l'acceptait deja ; aucun formulaire
 *    ne l'alimentait.
 *
 * 2. Essai reel en production avec le profil d'une assistante de direction,
 *    ce meme jour : l'encaissement s'enregistre, l'ecran le montre, et deux
 *    erreurs de synchronisation s'ouvrent en silence derriere —
 *    ACCOUNTING_MAPPING_MISSING.
 *
 *    Cause, dans backend/services/accounting.js : une operation sans tiers
 *    prend le critere « * », qui veut dire « inconnu ». Le rapprochement le
 *    compare litteralement, et la seule regle couvrant « encaissement,
 *    especes, caisse » exige « tiers ». Aucune regle ne correspond : pas
 *    d'ecriture comptable, et personne n'en est averti.
 *
 *    Le champ Tiers n'etait pas obligatoire. Il l'est.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const racine = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(racine, 'frontend', 'dashboard.html'), 'utf8');
const operations = fs.readFileSync(path.join(racine, 'backend', 'routes', 'operations.js'), 'utf8');

const cas = [];
const verifier = (nom, fn) => { cas.push([nom, fn]); };

/* ── 1. « Autre » dit lequel ─────────────────────────────────────────── */

verifier('la precision existe et se range quelque part', () => {
  assert.ok(html.includes('id="dec-piece-autre"'),
    'Le champ de precision doit exister');
  assert.ok(/piece_justificative: document\.getElementById\('dec-piece-autre'\)/.test(html),
    'Il doit partir dans « piece_justificative » — la colonne existait deja et '
    + 'la route l acceptait deja ; aucun formulaire ne l alimentait');
  assert.ok(/piece_justificative/.test(operations),
    'et le serveur doit toujours l accepter');
});

verifier('la precision ne parait que sur « Autre »', () => {
  const f = (html.match(/function surTypeDePieceChange\(\)[\s\S]*?\n\}/) || [])[0] || '';
  assert.ok(f, 'surTypeDePieceChange introuvable');
  assert.ok(/[!=]== 'autre'/.test(f),
    'Elle se declenche sur la valeur « autre », pas sur un libelle qui peut changer');
  assert.ok(/style\.display/.test(f),
    'Masquee par le style : « .hidden » et les classes du produit se disputent '
    + 'la meme specificite, le style en ligne tranche');
});

verifier('la precision est exigee quand elle parait', () => {
  const f = (html.match(/function surTypeDePieceChange\(\)[\s\S]*?\n\}/) || [])[0] || '';
  assert.ok(/\.required = /.test(f),
    'Un fourre-tout muet ne vaut pas mieux qu un fourre-tout : la precision '
    + 'est obligatoire des lors qu on choisit « Autre »');
  assert.ok(/champ\.value = ''/.test(f) || /\.value = ''/.test(f),
    'et elle se vide quand on repasse sur un type nomme, sinon une precision '
    + 'd hier accompagne un justificatif d aujourd hui');
});

verifier('« Autre tiers » exige de nommer le tiers', () => {
  const f = (html.match(/function onBenefTypeChange\(\)[\s\S]*?\n\}/) || [])[0] || '';
  assert.ok(f, 'onBenefTypeChange introuvable');
  assert.ok(/'autre'/.test(f),
    'Choisir « Autre tiers » sans nommer personne laisse la ligne sans '
    + 'contrepartie : le beneficiaire devient obligatoire');
});

/* ── 2. Un encaissement a toujours son tiers ─────────────────────────── */

verifier('le tiers de l encaissement est obligatoire a l ecran', () => {
  const champ = (html.match(/<input type="text" id="enc-tiers"[^>]*>/) || [])[0] || '';
  assert.ok(champ, 'champ enc-tiers introuvable');
  assert.ok(/required/.test(champ),
    'Sans tiers, aucune regle comptable ne correspond et l ecriture ne se fait '
    + 'pas — constate en production le 17/09/2026');
  assert.ok(/for="enc-tiers">Tiers \*/.test(html),
    'et l etiquette doit porter l asterisque, comme les autres champs exiges');
});

verifier('le motif de blocage nomme le tiers', () => {
  const f = (html.match(/function updateSimpleOperationImpact\(kind\)[\s\S]*?\n\}/) || [])[0] || '';
  assert.ok(f, 'updateSimpleOperationImpact introuvable');
  assert.ok(/tiers/.test(f),
    'Le pied de la fenetre doit dire ce qui manque : un bouton gris sans '
    + 'raison est ce qui a fait croire que « ca ne s enregistre pas »');
});

verifier('le serveur refuse aussi, pas seulement l ecran', () => {
  /* Masquer un bouton n est pas une regle. Un appel direct doit etre refuse
     de la meme facon. */
  assert.ok(/Tiers requis pour un encaissement/.test(operations),
    'Le refus doit exister cote serveur : l ecran seul se contourne');
  const bloc = (operations.match(/Tiers requis pour un encaissement[\s\S]{0,120}/) || [])[0] || '';
  assert.ok(/400/.test(operations.slice(Math.max(0, operations.indexOf('Tiers requis') - 200), operations.indexOf('Tiers requis') + 120)),
    'et refuser franchement');
});

let echecs = 0;
for (const [nom, fn] of cas) {
  try { fn(); console.log(`  ok   ${nom}`); }
  catch (e) { echecs++; console.error(`  ECHEC ${nom}\n        ${e.message}`); }
}
console.log(`\n${cas.length - echecs}/${cas.length} gardes vertes — « Autre » precise, tiers exige`);
process.exit(echecs ? 1 : 0);
