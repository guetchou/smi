'use strict';
/*
 * Garde — on peut se photographier depuis l'application.
 *
 * « il manque la possibilite de prendre photo directement via camera pc
 * telephone tablette et autres », 17/09/2026. Le produit n'offrait qu'un
 * selecteur de fichier : il fallait se photographier ailleurs, retrouver le
 * fichier, puis le televerser. Sur telephone, trois applications pour une
 * photo.
 *
 * Deux defauts de la premiere version, vus a l'ecran et non dans le DOM —
 * c'est pour eux que cette garde existe :
 *
 *   1. Les six boutons s'affichaient tous a la fois, alors que le DOM
 *      rapportait « hidden » sur quatre. « .hidden » de Tailwind et « .btn »
 *      du produit ont la meme specificite, et « .btn » est ecrit apres.
 *
 *   2. La fenetre etait posee dans la barre du haut, qui porte un
 *      backdrop-filter. Un element filtre devient le bloc conteneur de ses
 *      enfants fixed : « fixed inset-0 » se resolvait sur une barre de 70 px,
 *      et la carte sortait de l'ecran par le haut, titre compris.
 *
 * Mesure apres correction, 1366x768 : carte de 360 px posee a 122 px du haut,
 * entierement visible, trois boutons au repos.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'dashboard.html'), 'utf8');

const cas = [];
const verifier = (nom, fn) => { cas.push([nom, fn]); };

verifier('la fenetre existe et propose les deux chemins', () => {
  assert.ok(html.includes('id="modal-photo"'), 'la fenetre doit exister');
  assert.ok(html.includes('Prendre une photo'), 'le chemin camera');
  assert.ok(html.includes('Choisir un fichier'),
    'et le chemin fichier, qui reste entier : jamais une impasse');
});

verifier('la fenetre vit hors de la barre du haut', () => {
  /* La barre porte un backdrop-filter, qui fait d elle le bloc conteneur de
     ses enfants en position fixed. */
  const barre = html.slice(html.indexOf('<header id="app-topbar"'), html.indexOf('</header>'));
  assert.ok(barre, 'barre du haut introuvable');
  assert.ok(!barre.includes('id="modal-photo"'),
    'Posee dans la barre, « fixed inset-0 » se resolvait sur 70 px de haut et '
    + 'la carte sortait de l ecran');
  assert.ok(!barre.includes('id="user-photo-input"'),
    'le selecteur de fichier suit la fenetre');
});

verifier('les boutons se masquent par le style, pas par la classe', () => {
  const f = (html.match(/function _photoBoutons\([\s\S]*?\n\}/) || [])[0] || '';
  assert.ok(f, '_photoBoutons introuvable');
  assert.ok(/el\.style\.display = visible \? '' : 'none'/.test(f),
    'Masquer par « hidden » ne marche pas ici : « .btn » du produit est ecrit '
    + 'apres et impose son display. Les six boutons s affichaient ensemble');
  assert.ok(!/classList\.toggle\('hidden'/.test(f), 'plus de masquage par classe');
  for (const id of ['photo-btn-capturer', 'photo-btn-reprendre', 'photo-btn-enregistrer']) {
    assert.ok(new RegExp(`id="${id}" style="display:none"`).test(html),
      `« ${id} » doit naitre masque : le style ne s applique qu au premier appel`);
  }
});

verifier('la camera ne s allume qu a la demande', () => {
  const ouvrir = (html.match(/function ouvrirModalPhoto\(\)[\s\S]*?\n\}/) || [])[0] || '';
  assert.ok(ouvrir, 'ouvrirModalPhoto introuvable');
  assert.ok(!/getUserMedia/.test(ouvrir),
    'Ouvrir la fenetre ne doit pas allumer la camera : il faut un geste');
  assert.ok(/_photoBoutons\(\{ camera: true \}\)/.test(ouvrir),
    'au repos, seul le bouton qui l allume est offert');
});

verifier('le flux est coupe, la ou il doit l etre', () => {
  const couper = (html.match(/function _couperCamera\(\)[\s\S]*?\n\}/) || [])[0] || '';
  assert.ok(/getTracks\(\)\.forEach\(t => t\.stop\(\)\)/.test(couper),
    'Un voyant de camera qui reste allume est un defaut, pas un detail');
  for (const f of ['function fermerModalPhoto()', 'function capturerPhoto()']) {
    const bloc = (html.match(new RegExp(f.replace(/[()]/g, '\\$&') + '[\\s\\S]*?\\n\\}')) || [])[0] || '';
    assert.ok(/_couperCamera\(\)/.test(bloc), `${f} doit couper le flux`);
  }
});

verifier('un refus de camera n est jamais une impasse', () => {
  const f = (html.match(/async function demarrerCameraPhoto\(\)[\s\S]*?\n\}/) || [])[0] || '';
  assert.ok(f, 'demarrerCameraPhoto introuvable');
  assert.ok(/navigator\.mediaDevices\?\.getUserMedia/.test(f),
    'L absence de camera se lit avant de l appeler');
  assert.ok(/catch/.test(f), 'et le refus d autorisation se rattrape');
  assert.ok((f.match(/Le choix d'un fichier reste possible/g) || []).length === 2,
    'Les deux raisons doivent rappeler que le fichier reste possible');
});

verifier('la photo prise est carree, comme l avatar', () => {
  const f = (html.match(/function capturerPhoto\(\)[\s\S]*?\n\}/) || [])[0] || '';
  assert.ok(/Math\.min\(v\.videoWidth, v\.videoHeight\)/.test(f),
    'Un avatar est rond : une photo rectangulaire y perdrait ses bords');
});

verifier('les deux avatars suivent, pas un seul', () => {
  const f = (html.match(/async function televerserPhotoDeProfil\([\s\S]*?\n\}/) || [])[0] || '';
  assert.ok(f, 'televerserPhotoDeProfil introuvable');
  for (const id of ['user-avatar-img', 'topbar-avatar-img']) {
    assert.ok(f.includes(id),
      'L ancienne fonction ne mettait a jour que la barre laterale : la photo '
      + 'changeait a un endroit sur deux jusqu au rechargement');
  }
  assert.ok(/fermerModalPhoto\(\)/.test(f), 'et la fenetre se referme sur un succes');
});

verifier('un seul selecteur, un seul envoi', () => {
  assert.strictEqual((html.match(/id="user-photo-input"/g) || []).length, 1);
  assert.strictEqual((html.match(/id="modal-photo"/g) || []).length, 1);
  assert.strictEqual((html.match(/async function televerserPhotoDeProfil\(/g) || []).length, 1);
});

let echecs = 0;
for (const [nom, fn] of cas) {
  try { fn(); console.log(`  ok   ${nom}`); }
  catch (e) { echecs++; console.error(`  ECHEC ${nom}\n        ${e.message}`); }
}
console.log(`\n${cas.length - echecs}/${cas.length} gardes vertes — prise de photo`);
process.exit(echecs ? 1 : 0);
