'use strict';
/*
 * Garde — chaque agent peut mettre sa propre photo.
 *
 * Vérifié en production le 16/09/2026 avant correction, jeton du compte 2
 * (LOUVOUEZO, assistante_direction) :
 *
 *   GET  /api/config/me        -> 200
 *   POST /api/config/me/photo  -> 403 « Module non assigné à votre compte »,
 *                                 module: settings,access
 *
 * La porte de /api/config exemptait la lecture de sa fiche et pas l'envoi de
 * sa photo : l'envoi retombait sur requireModule(['settings','access']).
 * L'avatar était cliquable, le sélecteur s'ouvrait, et rien ne partait.
 *
 * Deux choses sont gardées ici : la règle elle-même, et le fait que la porte
 * l'applique — une règle que personne n'appelle ne protège rien.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const cas = [];
const verifier = (nom, fn) => { cas.push([nom, fn]); };

const racine = path.join(__dirname, '..');
const serveur = fs.readFileSync(path.join(racine, 'backend', 'server.js'), 'utf8');
const html = fs.readFileSync(path.join(racine, 'frontend', 'dashboard.html'), 'utf8');

/* ── La règle ───────────────────────────────────────────────────────────── */

verifier('la regle existe et vit dans un seul endroit', () => {
  const f = path.join(racine, 'backend', 'services', 'photo-de-profil.js');
  assert.ok(fs.existsSync(f),
    'La regle « sa propre photo n est pas un reglage » doit etre nommee quelque part');
  const { estSaProprePhoto } = require(f);
  assert.strictEqual(typeof estSaProprePhoto, 'function');
});

verifier('envoyer sa propre photo passe la porte', () => {
  const { estSaProprePhoto } = require(path.join(racine, 'backend', 'services', 'photo-de-profil.js'));
  assert.strictEqual(estSaProprePhoto('POST', '/me/photo'), true,
    'C est exactement l appel que LOUVOUEZO recevait en 403');
});

verifier('la porte ne s ouvre pas plus loin que la photo', () => {
  const { estSaProprePhoto } = require(path.join(racine, 'backend', 'services', 'photo-de-profil.js'));
  /* Une exemption trop large rendrait les reglages de la societe accessibles
     a tout le monde : on verifie qu elle ne deborde pas. */
  for (const [m, c] of [
    ['POST', '/positions'],
    ['POST', '/parametres'],
    ['PUT',  '/me/photo'],
    ['GET',  '/me/photo'],
    ['POST', '/users'],
    ['POST', '/me/photo/autre'],
    ['POST', '/autre/me/photo'],
  ]) {
    assert.strictEqual(estSaProprePhoto(m, c), false,
      `« ${m} ${c} » ne doit pas profiter de l exemption de la photo`);
  }
});

/* ── La porte l'applique ────────────────────────────────────────────────── */

verifier('la porte de /api/config appelle la regle', () => {
  assert.ok(/require\(['"]\.\/services\/photo-de-profil['"]\)/.test(serveur),
    'server.js doit charger la regle');
  const porte = (serveur.match(/app\.use\('\/api\/config'[\s\S]*?\}\), usersRouter\);/) || [])[0] || '';
  assert.ok(porte, 'porte de /api/config introuvable');
  assert.ok(/estSaProprePhoto\(req\.method, req\.path\)/.test(porte),
    'Une regle que la porte n appelle pas ne protege rien');
});

verifier('l exemption precede le garde des reglages', () => {
  const porte = (serveur.match(/app\.use\('\/api\/config'[\s\S]*?\}\), usersRouter\);/) || [])[0] || '';
  const exemption = porte.indexOf('estSaProprePhoto');
  const repli = porte.indexOf("requireModule(['settings', 'access'])");
  assert.ok(exemption > -1 && repli > -1, 'les deux reperes sont attendus');
  assert.ok(exemption < repli,
    'Place apres le repli, l exemption ne serait jamais atteinte : c est '
    + 'exactement ce qui produisait le 403');
});

/* ── L'agent trouve où cliquer ──────────────────────────────────────────── */

verifier('changer sa photo reste joignable barre laterale repliee', () => {
  /* L avatar cliquable ne vivait que dans le pied de la barre laterale. Cette
     barre se replie en mode compact et disparait en mode masque : le seul
     chemin pour changer sa photo disparaissait avec elle. */
  /* Delimite par le dernier bouton du menu — « Deconnexion » — et non par une
     indentation : la barre du haut a change de niveau le 17/09/2026 pour ne
     plus former une seconde barre a cote de la barre laterale. */
  const debutMenu = html.indexOf('<div id="user-dropdown-menu"');
  const finMenu = html.indexOf('logout()', debutMenu);
  const menu = (debutMenu !== -1 && finMenu !== -1) ? html.slice(debutMenu, finMenu) : '';
  assert.ok(menu, 'menu utilisateur introuvable');
  /* Le menu ne clique plus le selecteur de fichier : il ouvre la fenetre qui
     propose les deux chemins — camera ou fichier. Le selecteur, unique, a
     quitte la barre laterale et la barre du haut. */
  assert.ok(/ouvrirModalPhoto()/.test(menu),
    'Le menu utilisateur de la barre du haut doit mener au changement de photo');
  assert.ok(menu.includes('Changer ma photo'),
    'Le libelle existe deja dans le produit (info-bulle de l avatar) : on le reprend tel quel');
});

verifier('le selecteur de fichier reste unique', () => {
  assert.strictEqual((html.match(/id="user-photo-input"/g) || []).length, 1,
    'Deux selecteurs finiraient par diverger : un seul, atteint de deux endroits');
  assert.strictEqual((html.match(/function uploadUserPhoto\(/g) || []).length, 1,
    'Un seul envoi');
});

let echecs = 0;
for (const [nom, fn] of cas) {
  try { fn(); console.log(`  ok   ${nom}`); }
  catch (e) { echecs++; console.error(`  ECHEC ${nom}\n        ${e.message}`); }
}
console.log(`\n${cas.length - echecs}/${cas.length} gardes vertes — chaque agent peut mettre sa photo`);
process.exit(echecs ? 1 : 0);
