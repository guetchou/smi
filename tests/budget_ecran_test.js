'use strict';
/*
 * Garde — écran « Prévisions budgétaires » (maquette 1 validée le 29/09/2026).
 *
 * Exécute renderBudget et enregistrerBudget tels qu'ils sont dans la page,
 * avec un DOM minimal, et vérifie : l'échappement des noms, le « — » d'une
 * année sans prévision, l'envoi des seules cases modifiées (une case vidée
 * retire la prévision), la relecture sans cache, et l'accès réservé.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const racine = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(racine, 'frontend', 'dashboard.html'), 'utf8');
const nav = fs.readFileSync(path.join(racine, 'frontend', 'js', 'core', 'navigation.js'), 'utf8');

let vertes = 0;
let echecs = 0;
async function verifier(nom, fn) {
  try { await fn(); console.log('  ok   ' + nom); vertes++; }
  catch (e) { console.log('  ECHEC ' + nom + '\n        ' + e.message); echecs++; }
}

function bloc(debut, fin) {
  const i = html.indexOf(debut);
  assert.ok(i !== -1, debut + ' introuvable');
  const j = html.indexOf(fin, i);
  assert.ok(j !== -1, fin + ' introuvable');
  return html.slice(i, j);
}

function bac({ saisies = [], reponse = null } = {}) {
  const elements = {};
  const el = id => (elements[id] ||= {
    innerHTML: '', disabled: false, value: '2031', options: [1], attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; }, add() {},
  });
  const appels = [];
  const ctx = {
    document: {
      getElementById: el,
      querySelectorAll: () => saisies,
    },
    esc: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    fmt: n => new Intl.NumberFormat('fr-FR').format(n) + ' XAF',
    withLock: async (_k, fn) => fn(),
    api: async (url, opts) => { appels.push({ url, opts }); return reponse ?? { ok: true }; },
    Intl, Number, String, encodeURIComponent, Option: function () {}, Date,
  };
  vm.createContext(ctx);
  vm.runInContext(bloc('// ─── Prévisions budgétaires', 'function esc(s)').replace(/\b(const|let) /g, 'var '), ctx);
  return { ctx, el, appels };
}

const DONNEES = {
  annee: 2031, type: 'encaissement',
  totaux: { prevu: 0, realise: 3402000, realise_prevu: 0, a_une_prevision: false },
  lignes: [{
    categorie_id: 1, nom: 'Prestations <b>de</b> services', total_prevu: 0, total_realise: 3402000, a_une_prevision: false,
    mois: Array.from({ length: 12 }, (_, i) => ({ mois: i + 1, prevu: null, realise: i === 0 ? 3402000 : 0 })),
  }],
};

(async () => {
  await verifier('le nom d une catégorie est échappé', async () => {
    const { ctx, el } = bac();
    ctx.renderBudget(DONNEES);
    const g = el('bud-grille').innerHTML;
    assert.ok(g.includes('Prestations &lt;b&gt;de&lt;/b&gt; services'), 'nom non échappé');
    assert.ok(!g.includes('<b>de</b>'));
  });

  await verifier('sans aucune prévision, Prévu et Écart affichent « — », le réalisé est chiffré', async () => {
    const { ctx, el } = bac();
    ctx.renderBudget(DONNEES);
    // Intl sépare les milliers par une espace fine insécable (U+202F).
    const s = el('bud-synthese').innerHTML.replace(/[  ]/g, ' ');
    assert.ok(/Prévu 2031<\/span><span class="bud-valeur text-slate-400">—/.test(s), s);
    assert.ok(s.includes('Réalisé 2031') && s.includes('3 402 000'), s);
    assert.ok(/Écart<\/span><span class="bud-valeur text-slate-400">—/.test(s));
  });

  await verifier('l écart ne compare que le réalisé des cases prévues', async () => {
    const { ctx, el } = bac();
    // Constaté au banc le 29/09/2026 : 3 000 000 prévus en janvier, 1 200 000
    // réalisés en janvier et 2 000 000 en février (sans prévision). L'écran
    // affichait « +200 000 » en vert ; l'écart réel est −1 800 000.
    ctx.renderBudget({ ...DONNEES, totaux: { prevu: 3000000, realise: 3200000, realise_prevu: 1200000, a_une_prevision: true } });
    const s = el('bud-synthese').innerHTML.replace(/[  ]/g, ' ');
    const ecart = s.slice(s.indexOf('Écart'));
    assert.ok(/1 800 000/.test(ecart) && !/\+/.test(ecart), 'écart attendu −1 800 000 : ' + ecart);
    assert.ok(ecart.includes('text-rose-600'), 'un encaissement sous la prévision est défavorable');
  });

  await verifier('douze colonnes de mois, une case de saisie par mois', async () => {
    const { ctx, el } = bac();
    ctx.renderBudget(DONNEES);
    const g = el('bud-grille').innerHTML;
    assert.strictEqual((g.match(/<input /g) || []).length, 12);
    assert.ok(g.includes('>Janv<') && g.includes('>Déc<'));
  });

  await verifier('seules les cases modifiées partent ; une case vidée retire la prévision', async () => {
    const saisies = [
      { value: '1 000 000', dataset: { initial: '', cat: '1', mois: '3' } },
      { value: '', dataset: { initial: '500 000', cat: '1', mois: '4' } },
      { value: '250 000', dataset: { initial: '250 000', cat: '1', mois: '5' } },
    ];
    const { ctx, appels } = bac({ saisies, reponse: DONNEES });
    await ctx.enregistrerBudget();
    const put = appels.find(a => a.opts?.method === 'PUT');
    assert.ok(put, 'aucun envoi');
    assert.deepStrictEqual(JSON.parse(put.opts.body).lignes, [
      { categorie_id: 1, mois: 3, prevu: '1 000 000' },
      { categorie_id: 1, mois: 4, prevu: null },
    ]);
  });

  await verifier('rien de modifié : rien n est envoyé', async () => {
    const { ctx, appels } = bac({ saisies: [{ value: '250 000', dataset: { initial: '250 000', cat: '1', mois: '5' } }] });
    await ctx.enregistrerBudget();
    assert.strictEqual(appels.length, 0);
  });

  await verifier('la grille se relit sans cache après enregistrement', async () => {
    const saisies = [{ value: '1', dataset: { initial: '', cat: '1', mois: '1' } }];
    const { ctx, appels } = bac({ saisies, reponse: { ok: true, ...DONNEES } });
    await ctx.enregistrerBudget();
    const get = appels.find(a => a.url.startsWith('/budgets?'));
    assert.ok(get && get.opts && get.opts.noCache === true, 'relecture en cache : les montants saisis n apparaîtraient pas');
  });

  await verifier('la page est réservée à admin, finance et DG, et rangée en Comptabilité', async () => {
    assert.ok(/budget: \['admin', 'finance', 'dg'\]/.test(nav), 'rôles de page absents');
    assert.ok(/budget: 'nav-group-compta'/.test(nav));
    assert.ok(html.includes('data-page="budget"') && html.includes('id="page-budget"'));
  });

  console.log(`${vertes}/${vertes + echecs} gardes vertes — écran des prévisions`);
  if (echecs) process.exitCode = 1;
})();
