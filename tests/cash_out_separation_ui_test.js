'use strict';
/*
 * Garde — l'écran n'offre pas « Valider » à qui ne peut pas valider.
 *
 * Le serveur applique la séparation des tâches : l'initiateur ou le
 * soumetteur d'un décaissement ne peut pas le valider lui-même
 * (CASH_OUT_SELF_APPROVAL_FORBIDDEN, 409). Le contrôle interne est bon et
 * n'est pas en cause ici.
 *
 * En revanche, le 10/09/2026, l'écran dessinait quand même le bouton
 * « Valider » sur la ligne de son propre décaissement. Le clic partait, le
 * serveur refusait, et l'agent recevait un message d'erreur pour une action
 * qui ne pouvait pas aboutir — mesuré sur la production, compte 165 :
 *
 *     PUT /api/operations/3/valider -> 409
 *     « L'initiateur ou le soumetteur ne peut pas valider son propre
 *       décaissement. »
 *
 * La réponse de la file porte created_by et submitted_by : l'écran a de quoi
 * ne pas proposer ce qu'il sait refusé.
 *
 * Deux critères, pas un. Ne tester que created_by laisserait passer le cas où
 * une personne soumet le brouillon d'une autre puis se propose de le valider —
 * exactement ce que la separation interdit.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const racine = path.join(__dirname, '..');

const ecran = fs.readFileSync(path.join(racine, 'frontend', 'dashboard.html'), 'utf8');
const service = fs.readFileSync(
  path.join(racine, 'backend', 'services', 'cash-out-separation.js'), 'utf8');

let echecs = 0;
const verifier = (nom, fn) => {
  try { fn(); console.log('  ok   ' + nom); }
  catch (e) { echecs++; console.error('  ECHEC ' + nom + '\n         ' + e.message); }
};

/* La ligne qui compose le bouton, isolée pour ne pas confondre avec le
   bouton « Valider » de la paie, qui obéit à d'autres règles. */
function compositionDuBoutonValider() {
  const debut = ecran.indexOf('const btnValider = statut === \'soumis\'');
  assert.notStrictEqual(debut, -1, 'la composition du bouton Valider est introuvable');
  return ecran.slice(debut, debut + 400);
}

verifier('le serveur garde sa regle de separation', () => {
  assert.ok(
    /created_by/.test(service) && /submitted_by/.test(service),
    'la separation doit continuer de viser l initiateur ET le soumetteur'
  );
  assert.ok(
    /CASH_OUT_SELF_APPROVAL_FORBIDDEN/.test(service),
    'le refus serveur doit rester nomme'
  );
});

verifier('l ecran conditionne « Valider » a la separation', () => {
  const bloc = compositionDuBoutonValider();
  assert.ok(
    /decValidableParMoi\(/.test(bloc),
    'le bouton Valider doit passer par le meme critere que le serveur, '
    + 'sinon l ecran propose une action vouee au 409'
  );
});

verifier('le critere de l ecran vise l initiateur ET le soumetteur', () => {
  const debut = ecran.indexOf('function decValidableParMoi');
  assert.notStrictEqual(debut, -1, 'la fonction decValidableParMoi est introuvable');
  const fn = ecran.slice(debut, debut + 700);
  assert.ok(/created_by/.test(fn), 'le critere doit regarder created_by');
  assert.ok(
    /submitted_by/.test(fn),
    'le critere doit aussi regarder submitted_by : quelqu un peut soumettre '
    + 'le brouillon d un autre, et la separation le vise aussi'
  );
});

verifier('« Rejeter » n est pas touche', () => {
  const debut = ecran.indexOf('const btnRejeter =');
  assert.notStrictEqual(debut, -1, 'la composition du bouton Rejeter est introuvable');
  const bloc = ecran.slice(debut, debut + 300);
  assert.ok(
    !/decValidableParMoi\(/.test(bloc),
    'le serveur n applique la separation qu a la validation : rejeter son '
    + 'propre decaissement reste permis, ne pas sur-corriger'
  );
});

if (echecs) { console.error(`\n${echecs} garde(s) en echec`); process.exit(1); }
console.log(`\n4 gardes vertes — separation des taches a l ecran`);
