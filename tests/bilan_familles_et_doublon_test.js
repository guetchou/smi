const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const markup = read('frontend/dashboard.html');
const css = read('frontend/tailwind.css');

/* ── Les deux familles de tuiles portent enfin leur nom ──
   Le code les nommait dans ses commentaires — « ligne 1 : Tresorerie »,
   « ligne 2 : RH + Masse salariale + Achats » — mais l'ecran ne disait rien.
   Ces deux libelles ont ete valides par le Directeur General le 01/09/2026 ;
   ils ne sont donc pas inventes, et ne doivent pas etre modifies sans une
   nouvelle validation. */

const bilan = markup.slice(markup.indexOf('id="page-bilan"'), markup.indexOf('Soldes par position'));

const LIBELLES = ['Trésorerie', 'RH + Masse salariale + Achats'];

for (const libelle of LIBELLES) {
  assert(
    new RegExp(`<h2 class="[^"]*">${libelle.replace(/[+]/g, '\\+')}</h2>`).test(bilan),
    `Titre de famille manquant ou modifie : « ${libelle} » — libelle valide, ne pas le changer sans validation`
  );
}

/* Chaque titre doit preceder sa grille, sinon il coiffe la mauvaise famille. */
const iTreso = bilan.indexOf('>Trésorerie</h2>');
const iGrille1 = bilan.indexOf('data-famille="1"');
const iRh = bilan.indexOf('>RH + Masse salariale + Achats</h2>');
const iGrille2 = bilan.indexOf('data-famille="2"');
assert(iTreso !== -1 && iGrille1 !== -1 && iTreso < iGrille1, 'Le titre Tresorerie doit preceder sa grille');
assert(iRh !== -1 && iGrille2 !== -1 && iRh < iGrille2, 'Le second titre doit preceder sa grille');
assert(iTreso < iRh, 'Les deux familles doivent rester dans l ordre');

/* Les titres de famille doivent rester en retrait des titres de section :
   ils nomment un groupe, ils ne le concurrencent pas. */
const h2 = bilan.match(/<h2 class="([^"]*)">Trésorerie<\/h2>/)[1];
assert(/text-xs/.test(h2), 'Un titre de famille doit rester discret face aux chiffres qu il coiffe');
for (const classe of ['text-xs', 'uppercase', 'tracking-wide', 'font-semibold', 'mb-2']) {
  assert(new RegExp(`\\.${classe}\\{`).test(css), `La classe ${classe} est absente du CSS compile : le titre ne rendrait pas comme prevu`);
}

/* ── « Alertes actives » ne doit plus figurer deux fois ──
   Une tuile — « 0 · Aucune alerte critique » — et un bloc de detail —
   « ✅ Aucune alerte active » — disaient la meme chose. La tuile porte
   l'indicateur, le bloc porte la liste : le bloc se retire quand il n'y a
   rien a lister. */

assert(/id="bilan-alertes-bloc"/.test(markup), 'Le bloc de detail des alertes doit etre identifiable pour pouvoir se retirer');
assert(
  /blocAlertes\.classList\.toggle\('hidden', data\.alertes\.liste\.length === 0\)/.test(markup),
  'Le bloc doit se retirer quand la liste est vide'
);
assert(
  !/✅ Aucune alerte active/.test(markup),
  'Le message vide du bloc doit disparaitre : la tuile porte deja « Aucune alerte critique »'
);

/* La tuile, elle, reste : c'est elle qui porte l'indicateur en permanence. */
assert(/id="bilan-alertes-count"/.test(markup), 'La tuile Alertes actives doit rester');
assert(/Aucune alerte critique/.test(markup), 'Le message de la tuile doit rester : il porte seul l information quand le bloc se retire');

/* La banniere n'est pas un troisieme doublon : elle ne parait que pour les
   alertes BLOQUANTES, et dit ce que ni la tuile ni le bloc ne disent — que des
   decaissements sont suspendus. Elle reste, a cette condition. */
assert(/id="bilan-alertes-banner"/.test(markup), 'La banniere des alertes bloquantes doit rester : elle porte une escalade distincte');
assert(
  /par_priorite\.bloquant > 0\)\s*\{\s*\n\s*banner\.classList\.remove\('hidden'\)/.test(markup),
  'La banniere doit rester reservee aux alertes bloquantes, sinon elle devient un troisieme doublon'
);

/* ── Les alertes doivent etre lisibles ──
   Le Bilan est passe en theme clair ; les pastilles d'alerte etaient restees en
   nuance 300 sur un fond teinte a 10 % pose sur une carte blanche, soit environ
   1,6:1 la ou 4,5:1 est le minimum. Une alerte quasiment invisible, sur le bloc
   dont c'est justement la fonction. */

const NUANCE_CLAIRE = /text-(red|amber|yellow|blue)-(300|400)/;
const zoneAlertes = markup.match(/const prioStyle = \{[\s\S]*?\};/)[0];
assert(
  !NUANCE_CLAIRE.test(zoneAlertes),
  'Les pastilles d alerte ne doivent pas retomber en nuance claire : illisibles sur la carte blanche'
);
assert(
  /text-(red|amber|yellow|blue)-700/.test(zoneAlertes),
  'Les pastilles d alerte doivent porter une nuance foncee, lisible sur fond clair'
);
const banniere = markup.match(/<p id="bilan-alertes-text" class="([^"]+)"/)[1];
assert(
  !NUANCE_CLAIRE.test(banniere),
  `La banniere bloquante doit rester lisible sur fond clair (actuel : ${banniere})`
);

console.log(JSON.stringify({
  bothFamilyLabelsPresent: true,
  labelsPrecedeTheirGrid: true,
  labelsStayDiscreet: true,
  classesPresentInBuiltCss: true,
  alertBlockWithdrawsWhenEmpty: true,
  redundantEmptyMessageRemoved: true,
  tileKeepsTheIndicator: true,
  blockingBannerStaysDistinct: true,
  alertsReadableOnLightTheme: true,
}));
