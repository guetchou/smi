'use strict';
/* « Incomprehensible ces boutons et champs »
   « Utilise jargon finance-comptabilite »
   Les deux vont ensemble : le vocabulaire comptable reste, c'est son
   application qui n'etait pas tenue.

   Releve des trois ecrans d'argent, 17/09/2026 — une meme notion, plusieurs
   mots selon l'ecran :

     le libelle    Libelle comptable *   Libelle de l'operation *   Motif du transfert *
     la piece      N° piece / recu       N° piece justificative     N° piece / ordre
     la position   Position qui recoit * Position qui paie *        Position source * / destination *
     le tiers      Tiers / origine des fonds                        Beneficiaire

   Trois mots pour le libelle, trois pour la piece, quatre pour la position.
   S'y ajoutait le begaiement des listes : l'etiquette « Rubrique de recette *»
   surmontait l'option « — Rubrique de recette — », et « Position qui recoit *»
   surmontait « — Position de tresorerie — ». Lu a la suite, le formulaire
   redisait deux fois chaque chose sans jamais rien expliquer.

   Aucun mot n'est invente ici. Chaque terme retenu est deja celui du produit :

     « Position source » et « Position destination » viennent du virement ;
     « N° piece justificative » vient du decaissement ;
     « Libelle comptable » vient de l'encaissement et de la colonne Libelle
       du journal comptable ;
     « — Selectionner — » est le placeholder generique du produit, six emplois ;
     « Tiers » et « Beneficiaire » restent distincts : ce sont deux notions
       comptables differentes, pas deux facons de dire la meme.

   Enfin « Solde actuel : — » sous la liste redisait ce que le panneau de
   gauche affiche depuis le 16/09, a deux lignes de la : il part. */
const fs = require('fs');
const path = require('path');
const p = path.join(process.argv[2], 'frontend/dashboard.html');
const avant = fs.readFileSync(p, 'utf8');
let s = avant;

const remplacer = (nom, ancien, nouveau) => {
  const n = s.split(ancien).length - 1;
  if (n !== 1) throw new Error('« ' + nom + ' » : ' + n + ' occurrence(s), une seule attendue');
  s = s.replace(ancien, nouveau);
};

/* ══ La position : les quatre formulations se rangent sur la paire ═════
      source / destination, deja employee par le virement. */
remplacer('position de l encaissement',
  'for="enc-position-search">Position qui reçoit *',
  'for="enc-position-search">Position destination *');
remplacer('position du decaissement',
  'for="dec-position-search">Position qui paie *',
  'for="dec-position-search">Position source *');

/* ══ La piece : le terme complet du decaissement l'emporte ════════════ */
remplacer('piece de l encaissement',
  'for="enc-piece">N° pièce / reçu',
  'for="enc-piece">N° pièce justificative');
remplacer('piece du virement',
  'for="vir-piece">N° pièce / ordre',
  'for="vir-piece">N° pièce justificative');

/* ══ Le libelle : celui de l'ecriture comptable ═══════════════════════ */
remplacer('libelle du decaissement',
  'for="dec-libelle">Libellé de l\'opération *',
  'for="dec-libelle">Libellé comptable *');
remplacer('libelle du virement',
  'for="vir-libelle">Motif du transfert *',
  'for="vir-libelle">Libellé comptable *');

/* ══ Le tiers : la glose tombe, le terme comptable reste ══════════════ */
remplacer('tiers de l encaissement',
  'for="enc-tiers">Tiers / origine des fonds',
  'for="enc-tiers">Tiers');

/* ══ Les listes cessent de repeter leur etiquette ═════════════════════ */
remplacer('placeholder des positions',
  '<option value="">— Position de trésorerie —</option>',
  '<option value="">— Sélectionner —</option>');
remplacer('placeholder des rubriques',
  "fillOptions(id, rows, type === 'recette' ? '— Rubrique de recette —' : '— Rubrique de dépense —', selected);",
  [
    "/* L'etiquette au-dessus dit deja « Rubrique de recette » ou « Rubrique de",
    "   depense » : l'option repetait le meme mot deux lignes plus bas. Le",
    "   placeholder generique du produit suffit. */",
    "  fillOptions(id, rows, '— Sélectionner —', selected);",
  ].join('\n'));

/* ══ Le solde dit une fois, pas deux ══════════════════════════════════
      Les quatre lignes de solde sous les listes redisent ce que le panneau
      de gauche affiche depuis le 16/09, a deux lignes de la — et il le dit
      mieux : solde avant ET solde apres l'operation. Le code qui les
      remplissait part avec elles, sinon il ecrirait dans le vide. */
for (const idSolde of ['enc-position-solde', 'dec-position-solde', 'vir-source-solde', 'vir-destination-solde']) {
  const re = new RegExp('\\n\\s*<div class="text-xs text-slate-500">Solde [^<]*<span id="' + idSolde + '"[^>]*>—</span></div>');
  const trouve = s.match(re);
  if (!trouve) throw new Error('ligne de solde « ' + idSolde + ' » introuvable');
  s = s.replace(re, '');
}

remplacer('code de solde du virement',
[
"  const sourceSolde = document.getElementById('vir-source-solde');",
"  const destinationSolde = document.getElementById('vir-destination-solde');",
"  if (sourceSolde) sourceSolde.textContent = source ? fmt(source.solde) : '—';",
"  if (destinationSolde) destinationSolde.textContent = destination ? fmt(destination.solde) : '—';",
].join('\n'),
"  /* Les soldes sont portes par le panneau de gauche, qui dit l'avant et l'apres. */");

remplacer('identifiant de solde enc/dec',
"  const soldeId = isEnc ? 'enc-position-solde' : 'dec-position-solde';\n", '');
remplacer('lecture du solde enc/dec',
"  const solde = document.getElementById(soldeId);\n", '');
remplacer('ecriture du solde enc/dec',
"  if (solde) solde.textContent = position ? fmt(position.solde) : '—';\n", '');

if (s === avant) throw new Error('remplacement sans effet');
for (const clef of [
  'id="enc-position"', 'id="dec-position"', 'id="vir-destination"',
  'id="enc-rubrique"', 'id="dec-rubrique"', 'function fillOptions(',
  'Bénéficiaire', 'Référence externe', 'op-nuit',
]) {
  if (!s.includes(clef)) throw new Error('« ' + clef + ' » manque — refus');
}
/* Les identifiants retires ne doivent plus etre cherches nulle part. */
for (const mort of ['enc-position-solde', 'dec-position-solde', 'vir-source-solde', 'vir-destination-solde']) {
  if (s.includes(mort)) {
    throw new Error('« ' + mort + ' » est encore reference : le code le remplirait dans le vide');
  }
}
fs.writeFileSync(p, s, 'utf8');
console.log('  OK frontend/dashboard.html — vocabulaire (' + avant.length + ' -> ' + s.length + ')');
