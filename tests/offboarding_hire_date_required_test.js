const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const service = fs.readFileSync(path.join(root, 'backend/services/offboarding_workflow.js'), 'utf8');

/* ── Absent n'est pas zero ──
   Une sortie initiee le 31/08/2026 affichait un solde de tout compte de 0 :
   anciennete 0, indemnite de licenciement 0, indemnite de preavis 0. En base,
   l'agent n'avait pas de date d'embauche — et aucun des 12 agents actifs n'en
   a. calcAncienneteAnnees rendait 0 pour une date absente, et le service
   produisait un solde juridiquement faux presente comme un resultat calcule.

   Meme distinction que sur la pointeuse, ou une duree inconnue s'affiche « — »
   et non « 0h00 ». */

const calcul = service.match(/function calcAncienneteAnnees\(dateEmbauche\) \{[\s\S]*?\n\}/)[0];
assert(
  /if \(!dateEmbauche\) return null;/.test(calcul),
  'Une date d embauche absente doit rendre null : une anciennete inconnue n est pas une anciennete nulle'
);
assert(
  !/if \(!dateEmbauche\) return 0;/.test(calcul),
  'Le zero trompeur ne doit pas revenir'
);

/* Le refus doit intervenir avant tout calcul d'indemnite, pas apres. */
const iAnciennete = service.indexOf('const ancienneteAnnees = calcAncienneteAnnees(agent.date_embauche);');
const iRefus = service.indexOf('if (ancienneteAnnees === null)');
/* Ancrer sur l appel, pas sur la definition de calcIndemnites qui la precede. */
const iIndemnites = service.indexOf('} = calcIndemnites(typeSortie, ancienneteAnnees');
assert(iAnciennete !== -1 && iRefus !== -1 && iIndemnites !== -1, 'Structure du calcul introuvable');
assert(
  iAnciennete < iRefus && iRefus < iIndemnites,
  'Le refus doit se placer entre le calcul d anciennete et celui des indemnites'
);

/* Le refus passe par le mecanisme de validation deja utilise pour le type de
   sortie et la date de depart : rien de nouveau n'est introduit. */
const refus = service.slice(iRefus, iRefus + 500);
assert(/throw validationError\(/.test(refus), 'Le refus doit utiliser validationError, comme les autres controles');

/* Le message doit nommer ce qui manque, ce qui est bloque, et ou le corriger —
   sinon l utilisateur reste devant un refus sans issue. */
for (const attendu of ["Date d'embauche absente", 'ancienneté', 'indemnité de licenciement', 'fiche agent']) {
  assert(refus.includes(attendu), `Le message de refus doit mentionner : ${attendu}`);
}

/* Les controles preexistants restent en place. */
for (const controle of ['type_sortie invalide', 'date_depart_effectif requis']) {
  assert(service.includes(controle), `Controle preexistant perdu : ${controle}`);
}

console.log(JSON.stringify({
  missingHireDateIsNotZero: true,
  refusedBeforeComputingIndemnities: true,
  usesExistingValidationMechanism: true,
  messageNamesFieldAndRemedy: true,
}));
