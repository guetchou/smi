'use strict';
/*
 * Garde — une première approbation ne se fait pas passer pour une validation.
 *
 * Constaté le 28/09/2026, jour du déploiement de la double approbation
 * (#233) : au-delà du seuil DG, la première approbation laisse le décaissement
 * SOUMIS, et le serveur le dit :
 *
 *   { ok: true, dec_statut: 'soumis', approbations_requises: 2,
 *     message: 'Approbation enregistrée — une seconde approbation est requise' }
 *
 * L'écran ignorait `message` et fabriquait son toast à partir de l'action :
 * `labels.valider` = 'validé'. Le premier approbateur lisait donc
 * « Décaissement validé » alors que rien ne l'était — il croyait avoir fini,
 * personne ne donnait la seconde approbation, la dépense attendait sans fin.
 * Premier concerné : le décaissement n° 13, 514 075 XAF, au-dessus du seuil.
 *
 * Le libellé du serveur a été validé tel quel par l'utilisateur le 28/09/2026.
 *
 * Cette garde n'inspecte pas la forme du code : elle EXÉCUTE decAction avec
 * les deux réponses réelles du serveur et regarde ce que l'agent lirait.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'dashboard.html'), 'utf8');

function extraire(nom) {
  const debut = html.indexOf('async function ' + nom + '(');
  assert.ok(debut !== -1, nom + ' introuvable');
  assert.strictEqual(html.indexOf('async function ' + nom + '(', debut + 1), -1, nom + ' doit être défini une seule fois');
  // On avance jusqu'à l'accolade qui referme la fonction.
  let i = html.indexOf('{', debut), profondeur = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') profondeur++;
    else if (html[i] === '}' && --profondeur === 0) break;
  }
  return html.slice(debut, i + 1);
}

/* Exécute decAction contre une réponse serveur donnée ; rend les toasts émis. */
async function jouer(reponse, action = 'valider') {
  const toasts = [];
  const bac = {
    decIdentifiantExploitable: () => true,
    showConfirm: async () => true,
    withLock: async (_cle, fn) => fn(),
    api: async () => reponse,
    showToast: (msg, type) => toasts.push({ msg, type }),
    loadPendingDec: () => {},
    loadOperations: () => {},
  };
  vm.createContext(bac);
  vm.runInContext(extraire('decAction'), bac);
  await vm.runInContext(`decAction(13, ${JSON.stringify(action)})`, bac);
  return toasts;
}

const PREMIERE = {
  ok: true, dec_statut: 'soumis', approbations: [3], approbations_requises: 2,
  message: 'Approbation enregistrée — une seconde approbation est requise',
};
const SECONDE = { ok: true, dec_statut: 'valide' };

let vertes = 0;
const attendus = [];
const verifier = (nom, fn) => attendus.push(async () => {
  try { await fn(); console.log('  ok   ' + nom); vertes++; }
  catch (e) { console.log('  ECHEC ' + nom + '\n        ' + e.message); process.exitCode = 1; }
});

verifier('une premiere approbation ne dit pas « validé »', async () => {
  const t = await jouer(PREMIERE);
  assert.strictEqual(t.length, 1, 'Un seul message attendu, reçu ' + t.length);
  assert.ok(!/validé/.test(t[0].msg),
    'L approbateur lit « ' + t[0].msg + ' » alors que le décaissement reste soumis : il croira avoir fini');
});

verifier('elle dit qu une seconde approbation est requise', async () => {
  const t = await jouer(PREMIERE);
  assert.strictEqual(t[0].msg, 'Approbation enregistrée — une seconde approbation est requise',
    'Le libellé validé le 28/09/2026 est celui que le serveur renvoie : c est lui qu il faut montrer');
});

verifier('et elle ne se présente pas comme un succès achevé', async () => {
  const t = await jouer(PREMIERE);
  assert.notStrictEqual(t[0].type, 'success',
    'Un toast vert « Succès » dit « c est fait » — or quelqu un d autre doit encore agir');
});

verifier('la seconde approbation, elle, annonce bien la validation', async () => {
  const t = await jouer(SECONDE);
  assert.strictEqual(t.length, 1);
  assert.ok(/validé, prêt au paiement/.test(t[0].msg),
    'Quand le décaissement passe réellement à « valide », il faut le dire : reçu « ' + t[0].msg + ' »');
  assert.strictEqual(t[0].type, 'success');
});

verifier('soumettre et payer ne changent pas', async () => {
  const s = await jouer({ ok: true, dec_statut: 'soumis' }, 'soumettre');
  assert.strictEqual(s[0].msg, 'Décaissement soumis');
  const p = await jouer({ ok: true, dec_statut: 'paye' }, 'payer');
  assert.strictEqual(p[0].msg, 'Décaissement payé');
});

(async () => {
  for (const f of attendus) await f();
  console.log(vertes + '/5 gardes vertes — toast de double approbation');
})();
