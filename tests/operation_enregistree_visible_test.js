'use strict';
/*
 * Garde — une opération enregistrée est visible là où on vient de la saisir.
 *
 * Défaut du 15/09/2026, mesuré en production. LOUVOUEZO enregistre une recette
 * de 1 200 000 XAF datée du 13 janvier. Le serveur crée REC-2026-000007,
 * l'écriture comptable est générée, le toast annonce « Opération enregistrée ».
 * Et l'écran ne bouge pas.
 *
 * Confronté à l'écran des mouvements, avec les droits réels :
 *
 *     vue par défaut  « Période affichée : 2026-09-15 au 2026-09-15 »
 *                     1 mouvement — la ligne de 1 200 000 XAF absente
 *     vue « Tout »    2 mouvements — 2026-01-13 Recette prestation
 *                     REC-2026-000007 présente
 *
 * L'opération était donc bien écrite. La liste est cadrée sur « aujourd'hui »
 * (scope today_or_latest) et le tableau de bord sur le mois choisi : une
 * opération antérieure n'apparaît ni sur l'une ni sur l'autre. Vu de l'agent,
 * rien ne s'enregistre — et il recommence, donc il double la ligne.
 *
 * Deuxième occurrence : la même invisibilité a ouvert l'enquête du 07/09 sur
 * REC-2026-000001, même montant, même date de janvier.
 *
 * Même famille que les brouillons du 10/09 : l'écriture part, l'écran ne la
 * montre pas, l'agent conclut à l'échec. La différence ici est que le défaut
 * ne tient pas à un droit mais à un cadrage de période.
 *
 * Cette garde vérifie que la date écrite parvient jusqu'à la fonction qui
 * recadre, que les deux écrans sont couverts, et que le recadrage ne se
 * déclenche pas quand il n'a pas lieu d'être — une saisie du jour, ou une date
 * déjà dans la période affichée, ne doit rien bousculer.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'dashboard.html'), 'utf8');

const cas = [];
const verifier = (nom, fn) => { cas.push([nom, fn]); };

const extraire = (nom) => {
  const m = html.match(new RegExp(`function ${nom}\\([^)]*\\)[\\s\\S]*?\\n}`));
  return m ? m[0] : '';
};

/* ── 1. la date écrite parvient jusqu'à l'écran ────────────────────────── */

verifier('afterOperationSaved recoit la date de l operation', () => {
  assert.ok(
    /function afterOperationSaved\(dateOperation\)/.test(html),
    'Sans la date de ce qui vient d etre ecrit, l ecran ne peut pas se '
    + 'recadrer dessus : c est le defaut du 15/09/2026'
  );
});

verifier('submitOperation transmet cette date', () => {
  const fonction = extraire('submitOperation') || (html.match(/async function submitOperation[\s\S]*?\n}/) || [])[0] || '';
  assert.ok(fonction, 'submitOperation introuvable');
  assert.ok(
    /afterOperationSaved\([^)]*date[^)]*\)/.test(fonction),
    `submitOperation appelle afterOperationSaved sans date : ${fonction.slice(-120)}`
  );
});

/* ── 2. les deux écrans sont couverts ──────────────────────────────────── */

verifier('la liste des mouvements se recadre sur la date ecrite', () => {
  const f = extraire('cadrerListeSurOperation');
  assert.ok(f, 'cadrerListeSurOperation introuvable');
  assert.ok(/f-debut/.test(f) && /f-fin/.test(f),
    'Le recadrage doit passer par les bornes de periode de la liste');
  assert.ok(/_opsUseDefaultScope = false/.test(f),
    'La portee « aujourd hui » doit etre levee, sinon la ligne reste invisible');
});

verifier('le tableau de bord bascule sur le mois de l operation', () => {
  const f = extraire('cadrerTableauDeBordSurOperation');
  assert.ok(f, 'cadrerTableauDeBordSurOperation introuvable');
  assert.ok(/sel-mois/.test(f) && /sel-annee/.test(f),
    'Le recadrage doit passer par les selecteurs de periode du tableau de bord');
  assert.ok(/NOM_MOIS/.test(f),
    'Les options du selecteur portent le nom du mois, pas son numero');
});

verifier('afterOperationSaved appelle le recadrage des deux cotes', () => {
  const f = extraire('afterOperationSaved');
  assert.ok(f, 'afterOperationSaved introuvable');
  assert.ok(/cadrerTableauDeBordSurOperation\(dateOperation\)/.test(f),
    'La branche tableau de bord ne recadre pas');
  assert.ok(/cadrerListeSurOperation\(dateOperation\)/.test(f),
    'La branche liste ne recadre pas');
  assert.ok(/refreshDashboard\(\)/.test(f) && /loadOperations\(\)/.test(f),
    'Le rechargement des deux ecrans doit rester');
});

/* ── 3. ce qui ne doit PAS bouger ──────────────────────────────────────── */

verifier('une saisie du jour ne bouscule aucune periode', () => {
  const f = extraire('cadrerListeSurOperation');
  assert.ok(
    /todayIso\(\)/.test(f) && /return false/.test(f),
    'Une operation du jour est deja couverte par la portee par defaut : '
    + 'la recadrer ferait bouger l ecran sans raison'
  );
});

verifier('une date deja dans la periode affichee ne la change pas', () => {
  const f = extraire('cadrerListeSurOperation');
  assert.ok(
    /dateOperation >= debut\.value && dateOperation <= fin\.value/.test(f),
    'Si la date tombe dans la periode que l agent a choisie, on n y touche pas'
  );
});

verifier('le tableau de bord ne bascule pas s il est deja sur le bon mois', () => {
  const f = extraire('cadrerTableauDeBordSurOperation');
  assert.ok(
    /selMois\.value === nomDuMois && selAnnee\.value === annee/.test(f),
    'Basculer vers le mois deja affiche ferait clignoter l ecran pour rien'
  );
});

verifier('une date absente ou illisible ne declenche aucun recadrage', () => {
  const f = extraire('estUneDateIso');
  assert.ok(f, 'estUneDateIso introuvable : la validation de la date doit etre nommee');
  assert.ok(
    /\\d\{4\}-\\d\{2\}-\\d\{2\}/.test(f) || /\d\{4\}/.test(f),
    'La forme de la date doit etre verifiee explicitement'
  );
  for (const nom of ['cadrerListeSurOperation', 'cadrerTableauDeBordSurOperation']) {
    assert.ok(
      /estUneDateIso\(dateOperation\)/.test(extraire(nom)),
      `${nom} doit refuser une date absente ou illisible plutot que de deviner`
    );
  }
});

verifier('un mois absent du selecteur ne provoque pas de bascule silencieuse', () => {
  const f = extraire('cadrerTableauDeBordSurOperation');
  assert.ok(
    /moisDisponible/.test(f) && /anneeDisponible/.test(f),
    'Une annee hors des options disponibles doit laisser l ecran tel quel, '
    + 'pas produire un selecteur vide'
  );
});

/* ── 4. rien n'a été inventé côté texte ────────────────────────────────── */

verifier('aucun message nouveau n est ajoute', () => {
  assert.ok(
    html.includes("showToast('Opération enregistrée', 'success')"),
    'Le message de succes existant doit rester inchange'
  );
  assert.ok(
    html.includes('Période affichée'),
    'La note de portee existante est ce qui enonce la periode : elle doit rester'
  );
});

let echecs = 0;
for (const [nom, fn] of cas) {
  try { fn(); console.log(`  ok   ${nom}`); }
  catch (e) { echecs++; console.error(`  ECHEC ${nom}\n        ${e.message}`); }
}
console.log(`\n${cas.length - echecs}/${cas.length} gardes vertes — operation enregistree visible`);
process.exit(echecs ? 1 : 0);
