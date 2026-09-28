'use strict';
/*
 * Garde — une étape « sans objet » ne se présente pas comme « À traiter ».
 *
 * Décision du 28/09/2026 (option c) : pour le passé, une étape Budget ou
 * Affectation sans rien à rapprocher passe à 'not_applicable' (migration 059).
 * L'écran ne connaissait que quatre états et retombait sur « À traiter » pour
 * tout le reste : les 14 encaissements de janvier–mars auraient continué
 * d'avoir l'air en attente. Libellé « Sans objet » validé par l'utilisateur
 * le 28/09/2026.
 *
 * La garde exécute syncStep tel qu'il est dans la page et lit ce qu'elle rend.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'dashboard.html'), 'utf8');

const debut = html.indexOf('const syncLabels');
assert.ok(debut !== -1, 'syncLabels introuvable');
const finStep = html.indexOf('};', html.indexOf('const syncStep', debut));
assert.ok(finStep !== -1, 'syncStep introuvable');
const bac = {};
vm.createContext(bac);
vm.runInContext(html.slice(debut, finStep + 2).replace(/\bconst (\w+)/g, 'var $1'), bac);

let echecs = 0;
const verifier = (nom, fn) => {
  try { fn(); console.log('  ok   ' + nom); }
  catch (e) { console.log('  ECHEC ' + nom + '\n        ' + e.message); echecs++; }
};

const rendu = etat => bac.syncStep('Budget', etat);

verifier('not_applicable affiche « Sans objet »', () => {
  const r = rendu('not_applicable');
  assert.ok(r.includes('>Sans objet<'), 'Rendu : ' + r.replace(/\s+/g, ' '));
  assert.ok(!r.includes('À traiter'), 'Une étape sans objet ne doit pas dire « À traiter »');
});

verifier('elle ne porte pas le style « à traiter »', () => {
  const r = rendu('not_applicable');
  assert.ok(!/ops-flow-pending/.test(r), 'Classe pending sur une étape sans objet');
  const classe = (r.match(/ops-flow-item ([\w-]+)/) || [])[1];
  assert.ok(classe, 'aucune classe d état');
  assert.ok(new RegExp('\\.' + classe + '[\\s,{]').test(html), 'la classe ' + classe + ' n a aucune règle CSS');
});

verifier('les quatre états existants ne changent pas', () => {
  assert.ok(rendu('synced').includes('>Synchronisé<'));
  assert.ok(rendu('pending').includes('>À traiter<'));
  assert.ok(rendu('error').includes('>Erreur<'));
  assert.ok(rendu('cancelled').includes('>Annulé<'));
  assert.ok(rendu(undefined).includes('>À traiter<'));
});

if (echecs) process.exitCode = 1;
console.log((3 - echecs) + '/3 gardes vertes — étape sans objet');
