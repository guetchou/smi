'use strict';
/*
 * Garde — les ecrans de direction sont reserves, et la reserve est executee.
 *
 * Constat du 17/09/2026, compte 2 (LOUVOUEZO, assistante_direction) :
 * elle voyait 31 des 32 ecrans du menu, seul « Parametres » lui etait cache.
 *
 * Le groupe de menu portait pourtant « data-roles="admin,dg" » depuis
 * toujours. Cet attribut n'apparaissait qu'une fois dans tout le fichier :
 * aucun « dataset.roles », aucun selecteur « [data-roles] ». Une intention
 * ecrite, jamais executee.
 *
 * Mesure des sept entrees du groupe avec son jeton :
 *
 *   Parapheur             200   requireParapheurAccess nomme assistante_direction
 *   Bilan Dirigeant       200   garde seulement par requireModule('cash')
 *   A approuver           200   requireModule('purchase')
 *   Revisions salariales  ok    garde salary franchi
 *   Calendrier fiscal     200   requireModule('salary')
 *   Rapprochement         ok    garde cash franchi
 *   Journal d'audit       403   « Admin ou DG requis »
 *
 * Six sur sept lui sont donc accordes volontairement : l'etiquette du groupe
 * etait perimee, pas les permissions. Deux ecrans seulement relevent vraiment
 * de la direction, et le produit se contredisait sur les deux :
 *
 *   - « Bilan Dirigeant » porte le compte de resultat mensuel de la societe
 *     et n'etait garde que par le module « cash », que tout caissier detient ;
 *   - « Journal d'audit » etait affiche au menu puis refuse par le serveur :
 *     une porte montree, puis fermee.
 *
 * Ce qui est garde ici : la reserve existe, elle vit dans un seul endroit,
 * les deux cotes disent la meme chose, et le metier quotidien n'est pas casse
 * au passage.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const racine = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(racine, 'frontend', 'dashboard.html'), 'utf8');
const navigation = fs.readFileSync(path.join(racine, 'frontend', 'js', 'core', 'navigation.js'), 'utf8');
const operations = fs.readFileSync(path.join(racine, 'backend', 'routes', 'operations.js'), 'utf8');

const cas = [];
const verifier = (nom, fn) => { cas.push([nom, fn]); };

const cheminRegle = path.join(racine, 'backend', 'services', 'ecrans-de-direction.js');

/* ── La regle ───────────────────────────────────────────────────────── */

verifier('la reserve est nommee en un seul endroit', () => {
  assert.ok(fs.existsSync(cheminRegle),
    'Deux listes tenues separement finissent toujours par diverger : la '
    + 'reserve a besoin d un endroit qui la nomme');
  const { ECRANS_DE_DIRECTION } = require(cheminRegle);
  assert.deepStrictEqual(Object.keys(ECRANS_DE_DIRECTION).sort(), ['audit', 'bilan'],
    'Deux ecrans, pas sept : les cinq autres sont accordes volontairement par '
    + 'le serveur, les fermer casserait le travail quotidien');
  for (const ecran of ['bilan', 'audit']) {
    assert.deepStrictEqual([...ECRANS_DE_DIRECTION[ecran]].sort(), ['admin', 'dg'],
      `« ${ecran} » se gouverne par role, pas par module`);
  }
});

verifier('les deux cotes disent la meme chose', () => {
  /* Le menu vit dans le navigateur, le refus vit sur le serveur. Ce test est
     le seul lien entre les deux : sans lui, fermer un ecran d un cote et pas
     de l autre ne se verrait jamais. */
  const { ECRANS_DE_DIRECTION } = require(cheminRegle);
  const bloc = (navigation.match(/const PAGE_ROLES = \{[\s\S]*?\n  \};/) || [])[0] || '';
  assert.ok(bloc, 'PAGE_ROLES doit exister cote navigation');
  for (const [ecran, roles] of Object.entries(ECRANS_DE_DIRECTION)) {
    assert.ok(new RegExp(`${ecran}:\\s*\\[`).test(bloc), `« ${ecran} » manque cote menu`);
    for (const role of roles) {
      assert.ok(new RegExp(`${ecran}:\\s*\\[[^\\]]*'${role}'`).test(bloc),
        `« ${ecran} » doit admettre « ${role} » des deux cotes`);
    }
  }
});

/* ── Le menu l'applique ─────────────────────────────────────────────── */

verifier('le menu interroge le role avant le module', () => {
  const f = (navigation.match(/function canAccessPage\(page\) \{[\s\S]*?\n    \}/) || [])[0] || '';
  assert.ok(f, 'canAccessPage introuvable');
  assert.ok(/PAGE_ROLES\[page\]/.test(f),
    'Le module « cash » ouvrait le bilan a tout caissier : sur ces ecrans-la '
    + 'c est le role qui decide, et il doit etre consulte en premier');
  const posRole = f.indexOf('PAGE_ROLES[page]');
  const posModule = f.indexOf('PAGE_MODULES[page]');
  assert.ok(posRole > -1 && posModule > -1 && posRole < posModule,
    'Consulte apres le module, le role n aurait jamais le dernier mot');
});

verifier('l attribut decoratif a disparu', () => {
  /* Sur le balisage debarrasse de ses commentaires : le commentaire qui
     explique le retrait cite l attribut, et n est pas l attribut. */
  const balisage = html.replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(!/data-roles=/.test(balisage),
    'Une declaration que personne ne lit vaut moins que rien : elle fait '
    + 'croire que la regle existe. Elle est remplacee par une regle executee');
});

/* ── Le serveur l'applique ──────────────────────────────────────────── */

verifier('le serveur refuse le bilan hors direction', () => {
  const bloc = (operations.match(/router\.get\('\/bilan-mensuel'[\s\S]{0,600}/) || [])[0] || '';
  assert.ok(bloc, 'route bilan-mensuel introuvable');
  assert.ok(/hasRole\(req\.user, \.\.\.rolesAdmisSurLEcran\('bilan'\)\)/.test(bloc),
    'Le refus doit lire la meme regle que le menu, pas une liste recopiee');
  assert.ok(/403/.test(bloc), 'et refuser franchement');
});

/* ── Sans casser le metier quotidien ────────────────────────────────── */

verifier('le parapheur reste ouvert a l assistante de direction', () => {
  const { ECRANS_DE_DIRECTION } = require(cheminRegle);
  assert.ok(!('parapheur' in ECRANS_DE_DIRECTION),
    'requireParapheurAccess nomme « assistante_direction » a la main : c est '
    + 'son metier. Le fermer au nom d une etiquette de menu perimee serait '
    + 'casser le travail pour faire propre');
  for (const ecran of ['rapprochement', 'achats', 'revisions', 'calendrier-fiscal']) {
    assert.ok(!(ecran in ECRANS_DE_DIRECTION),
      `« ${ecran} » est accorde par module, volontairement : il reste ouvert`);
  }
});

let echecs = 0;
for (const [nom, fn] of cas) {
  try { fn(); console.log(`  ok   ${nom}`); }
  catch (e) { echecs++; console.error(`  ECHEC ${nom}\n        ${e.message}`); }
}
console.log(`\n${cas.length - echecs}/${cas.length} gardes vertes — ecrans de direction`);
process.exit(echecs ? 1 : 0);
