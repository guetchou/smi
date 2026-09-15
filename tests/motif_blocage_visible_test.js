'use strict';
/*
 * Garde — un bouton grisé dit toujours pourquoi, à l'écran.
 *
 * Défaut du 15/09/2026, trouvé par la capture et non par le DOM. Les trois
 * fenêtres d'argent — encaissement, décaissement, transfert — grisent leur
 * bouton d'enregistrement tant que la saisie est incomplète, et écrivent le
 * motif dans le bloc « CONTRÔLE AVANT ENREGISTREMENT », au bas du corps
 * défilant.
 *
 * Mesuré sur l'écran de travail réel (1366×768, 543 px utiles), corps de
 * fenêtre de 368 px pour 765 px de contenu :
 *
 *   décaissement — bouton grisé visible à 512 px
 *                  motif « Sélectionnez une position, une rubrique, un
 *                  montant et un libellé » à 1130 px  → 587 px trop bas
 *   transfert    — bouton grisé visible à 476 px
 *                  motif « Solde insuffisant sur la source » à 831 px
 *                                                       → 288 px trop bas
 *
 * Vu de l'agent : un bouton mort, et rien qui l'explique. Une lecture du DOM
 * seule ne voit pas ce défaut — le motif y est bien présent, avec le bon
 * texte. Seule la capture confrontée aux coordonnées le révèle.
 *
 * Le correctif recopie le motif dans le pied de la fenêtre, qui ne défile
 * jamais, à côté du bouton. Aucun texte nouveau n'est créé : c'est la chaîne
 * que le bloc de contrôle calcule déjà.
 *
 * Cette garde vérifie que l'emplacement existe dans les trois pieds, qu'il est
 * bien alimenté quand la saisie est invalide, et vidé quand elle redevient
 * valide — sinon un motif périmé resterait sous les yeux.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'dashboard.html'), 'utf8');

const cas = [];
const verifier = (nom, fn) => { cas.push([nom, fn]); };

/* ── 1. l'emplacement existe, et il est dans le pied ───────────────────── */

for (const [prefixe, libelle] of [
  ['enc', "Enregistrer l'encaissement"],
  ['dec', 'Enregistrer le décaissement'],
  ['vir', 'Enregistrer le transfert'],
]) {
  verifier(`la fenetre ${prefixe} porte un emplacement de motif dans son pied`, () => {
    const idMotif = `id="${prefixe}-motif-blocage"`;
    assert.ok(
      source.includes(idMotif),
      `${prefixe} n a pas d emplacement pour le motif : le bouton grise reste `
      + 'muet, comme le 15/09/2026'
    );
    /* Il doit précéder immédiatement le bloc des boutons : c'est ce qui
       garantit qu'il partage le pied, qui ne défile pas. */
    const iMotif = source.indexOf(idMotif);
    const iBouton = source.indexOf(`id="${prefixe}-submit"`);
    assert.ok(iMotif !== -1 && iBouton !== -1);
    assert.ok(
      iMotif < iBouton && (iBouton - iMotif) < 400,
      `${prefixe} : le motif n est pas dans le meme pied que le bouton — `
      + `${iBouton - iMotif} caracteres les separent`
    );
    assert.ok(
      source.includes(`<button type="submit" id="${prefixe}-submit"`),
      `le bouton ${prefixe}-submit a change de forme, la garde doit etre relue`
    );
    assert.ok(source.includes(libelle), `le libelle « ${libelle} » a disparu`);
  });
}

/* ── 2. la fonction qui l'alimente ─────────────────────────────────────── */

verifier('une seule fonction porte le motif au pied', () => {
  assert.ok(
    /function porterLeMotifAuPied\s*\(/.test(source),
    'La recopie du motif doit etre nommee et unique, pas repetee dans chaque '
    + 'fonction d impact'
  );
});

/* Les appels, pas la déclaration : « function porterLeMotifAuPied(...) »
   répond au même motif et ferait passer la garde pour un test qu'elle ne fait
   pas. */
const appelsAuPied = () =>
  (source.match(/(?:^|[^\w])porterLeMotifAuPied\([^;]*\)/g) || [])
    .map(m => m.trim())
    .filter(m => !/^function\b/.test(m) && !/\bfunction\s*$/.test(m))
    .filter(m => !/^\(?\s*prefixe\s*,\s*motif\s*\)/.test(m.replace('porterLeMotifAuPied', '')));

verifier('le motif est vide quand la saisie est valide', () => {
  /* Un motif qui survit à la correction de la saisie est pire que pas de
     motif : il accuse une faute déjà réparée. Chaque appel passe une chaîne
     vide dans la branche valide. */
  const appels = appelsAuPied();
  assert.ok(appels.length >= 2, `seulement ${appels.length} appel(s) trouve(s)`);
  for (const appel of appels) {
    assert.ok(
      /valid\s*\?\s*''/.test(appel),
      `un appel ne vide pas le motif quand la saisie redevient valide : ${appel.slice(0, 90)}`
    );
  }
});

/* ── 3. les trois fenêtres sont couvertes ──────────────────────────────── */

verifier('les trois fenetres alimentent leur pied', () => {
  const appels = appelsAuPied().join(' ');
  assert.ok(/'vir'/.test(appels), 'le transfert n alimente pas son pied');
  assert.ok(/'enc'/.test(appels) && /'dec'/.test(appels),
    'l encaissement et le decaissement n alimentent pas leur pied');
});

verifier('le transfert prefere le solde insuffisant au resume generique', () => {
  const appel = (source.match(/porterLeMotifAuPied\('vir'[\s\S]{0,260}?\);/) || [])[0] || '';
  assert.ok(
    /warning/.test(appel) && /summary/.test(appel),
    'Quand le solde est insuffisant, c est ce motif-la qu il faut montrer, '
    + 'pas « Selectionnez une source, une destination et un montant » : '
    + `appel lu = ${appel.slice(0, 120)}`
  );
});

/* ── 4. ce qui ne doit pas avoir bougé ─────────────────────────────────── */

verifier('le bloc de controle garde son role et son texte', () => {
  for (const id of ['vir-impact-summary', 'vir-impact-warning',
                    'dec-impact-summary', 'enc-impact-summary']) {
    assert.ok(source.includes(id), `${id} a disparu — le correctif devait ajouter, pas remplacer`);
  }
  assert.ok(
    source.includes('Sélectionnez une position, une rubrique, un montant et un libellé.'),
    'Le motif du decaissement a ete reecrit : le correctif ne doit creer aucun texte'
  );
  assert.ok(
    source.includes('Sélectionnez une source, une destination et un montant.'),
    'Le motif du transfert a ete reecrit : le correctif ne doit creer aucun texte'
  );
});

let echecs = 0;
for (const [nom, fn] of cas) {
  try { fn(); console.log(`  ok   ${nom}`); }
  catch (e) { echecs++; console.error(`  ECHEC ${nom}\n        ${e.message}`); }
}
console.log(`\n${cas.length - echecs}/${cas.length} gardes vertes`);
process.exit(echecs ? 1 : 0);
