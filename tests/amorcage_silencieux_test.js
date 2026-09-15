'use strict';
/*
 * Garde — un amorçage déclenché par un minuteur réessaie, il n'alarme pas.
 *
 * Défaut du 15/09/2026, vu à l'écran sur la caisse, à zéro opération :
 *
 *     Erreur
 *     Erreur de chargement
 *
 * Or les trente-huit appels de la page répondaient tous 200. La requête en
 * cause n'était jamais partie : le transport la décline lui-même tant que les
 * droits du compte ne sont pas connus, et rend null. request() traduit ce null
 * en « Erreur de chargement », et l'amorçage le remontait à l'agent.
 *
 * Pile relevée :
 *
 *     notify  <- agent-organization.js:276
 *     (dans un setInterval, qui tourne quel que soit l'écran affiché)
 *
 * L'agent regardait la caisse et recevait une alerte rouge venue du module
 * d'organisation, sur une panne qui n'existait pas. Pour quelqu'un qui vient de
 * passer la journée à croire que rien ne s'enregistrait, c'est le pire moment
 * pour un faux signal.
 *
 * org-departments-core.js portait la même faute, en pire : son minuteur
 * s'arrêtait AVANT l'appel, donc un échec au démarrage était définitif — aucune
 * reprise possible, et l'alerte restait la seule trace.
 *
 * Un amorçage qui échoue se reprend au tour suivant. Ce qui échoue vraiment se
 * dira quand l'agent ouvrira l'écran concerné.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const racine = path.join(__dirname, '..');
const lire = (f) => fs.readFileSync(path.join(racine, f), 'utf8');

const cas = [];
const verifier = (nom, fn) => { cas.push([nom, fn]); };

/* ── 1. le défaut lui-même ─────────────────────────────────────────────── */

verifier('aucun amorcage par minuteur n alarme l agent', () => {
  const fautifs = [];
  for (const f of ['frontend/js/modules/agent-organization.js',
                   'frontend/js/modules/org-departments-core.js']) {
    const source = lire(f);
    /* On isole chaque setInterval et on refuse un notify d erreur a
       l interieur : ce minuteur tourne quel que soit l ecran affiche. */
    for (const m of source.matchAll(/setInterval\(\s*\(\)\s*=>\s*\{/g)) {
      let i = source.indexOf('{', m.index + 'setInterval('.length);
      let profondeur = 0, fin = i;
      for (; fin < source.length; fin++) {
        if (source[fin] === '{') profondeur++;
        else if (source[fin] === '}') { profondeur--; if (!profondeur) break; }
      }
      const corps = source.slice(i, fin);
      /* La flèche est À L'INTÉRIEUR des parenthèses : « catch(error => notify(…)) ».
         Une expression qui attend « catch(…) => notify » ne trouve rien et
         laisse passer le défaut — c'est le piège de la garde qui ne garde rien. */
      if (/catch\(\s*\w*\s*=>\s*notify\(/.test(corps)) {
        const ligne = source.slice(0, i).split('\n').length;
        fautifs.push(`${f}:~${ligne}`);
      }
    }
  }
  assert.deepStrictEqual(
    fautifs, [],
    'Un amorcage declenche par un minuteur qui remonte son echec a l agent : '
    + 'c est exactement le faux « Erreur de chargement » du 15/09/2026.\n'
    + '        ' + fautifs.join('\n        ')
  );
});

/* ── 2. ce qui doit remplacer l'alarme : une reprise ───────────────────── */

verifier('l amorcage des references se rearme apres un echec', () => {
  const source = lire('frontend/js/modules/agent-organization.js');
  assert.ok(
    /loadReferences\(true\)\s*\.catch\(\(\)\s*=>\s*\{\s*state\.controlsReady\s*=\s*false;\s*\}\)/.test(source),
    'Sans remise a faux de controlsReady, l amorcage ne repasserait jamais : '
    + 'l ecran resterait sans ses references, en silence'
  );
});

verifier('le minuteur des departements ne s arrete qu apres un succes', () => {
  const source = lire('frontend/js/modules/org-departments-core.js');
  const boot = (source.match(/function boot\(\)[\s\S]*?\n  \}/) || [])[0] || '';
  assert.ok(boot, 'boot() introuvable');
  assert.ok(
    /initialize\(\)[\s\S]{0,120}\.then\(\(\)\s*=>\s*\{\s*window\.clearInterval\(timer\);\s*\}\)/.test(boot),
    'Le minuteur doit s arreter sur le succes, pas avant l appel'
  );
  assert.ok(
    /\.catch\(\(\)\s*=>\s*\{[\s\S]{0,90}attempts >= 100[\s\S]{0,60}clearInterval\(timer\)/.test(boot),
    'Un echec doit laisser le minuteur reessayer, dans la limite deja prevue'
  );
  /* La borne existante ne doit pas sauter : sans elle, un echec durable
     ferait tourner le minuteur indefiniment. */
  assert.ok(/attempts >= 100/.test(boot), 'la borne de cent tentatives doit rester');
});

/* ── 3. ce qu'on ne touche pas ─────────────────────────────────────────── */

verifier('les echecs declenches par un geste de l agent restent visibles', () => {
  const source = lire('frontend/js/modules/agent-organization.js');
  assert.ok(
    /function notify\(/.test(source),
    'notify doit rester : un echec provoque par un geste de l agent doit se dire'
  );
  assert.ok(
    /addEventListener\('focusin'/.test(source),
    'Les gestes de l agent gardent leurs gestionnaires'
  );
});

verifier('le contrat de request est inchange', () => {
  const source = lire('frontend/js/modules/agent-organization.js');
  assert.ok(
    /if \(donnees === null\) throw new Error\('Erreur de chargement'\)/.test(source),
    'request() continue de lever : c est l appelant qui decide quoi en faire'
  );
});

let echecs = 0;
for (const [nom, fn] of cas) {
  try { fn(); console.log(`  ok   ${nom}`); }
  catch (e) { echecs++; console.error(`  ECHEC ${nom}\n        ${e.message}`); }
}
console.log(`\n${cas.length - echecs}/${cas.length} gardes vertes — amorcage silencieux`);
process.exit(echecs ? 1 : 0);
