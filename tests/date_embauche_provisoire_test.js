const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root      = path.join(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'backend/migrations/055_date_embauche_provisoire.sql'), 'utf8');
const service   = fs.readFileSync(path.join(root, 'backend/services/offboarding_workflow.js'), 'utf8');

/* ── Une valeur posee n'est pas une valeur etablie ──
   Aucun des 18 agents n'avait de date d'embauche au 01/09/2026 — 0 sur 18.
   Cette absence bloquait l'offboarding, et c'etait le comportement sur : sans
   date, pas d'anciennete, donc pas d'indemnite calculee sur du vide.

   Decision du Directeur General : poser le 01/08/2026 pour tous, charge aux
   agents habilites de corriger, le champ etant modifiable.

   Le risque introduit est direct. En donnant une date a tout le monde, on fait
   cesser le refus : l'offboarding se remettrait a produire un solde de tout
   compte — indemnite de licenciement, indemnite de preavis — calcule sur une
   date fictive. Un chiffre juridiquement faux presente comme un resultat,
   c'est-a-dire exactement le defaut que le refus evitait, revenu par la porte
   de service.

   La valeur est donc posee comme PROVISOIRE et tracee comme telle, et
   l'offboarding refuse tant qu'elle n'a pas ete corrigee. */

/* ── 1. La trace est ecrite avant la mise a jour ──
   L'insertion selectionne les lignes encore nulles. Inversee, elle ne
   trouverait plus rien : l'information « etait nulle » serait perdue. */

const iEvenements = migration.indexOf('INSERT INTO onboarding_events');
const iMiseAJour  = migration.indexOf('UPDATE employes');
assert(iEvenements !== -1 && iMiseAJour !== -1, 'Structure de la migration introuvable');
assert(
  iEvenements < iMiseAJour,
  'La trace doit etre ecrite avant la mise a jour : apres, plus aucune ligne n est nulle et la trace serait vide'
);
assert(
  /FROM employes\s+WHERE date_embauche IS NULL;/.test(migration),
  'La trace ne doit porter que sur les dossiers reellement depourvus de date'
);
assert(
  /UPDATE employes[\s\S]*?WHERE date_embauche IS NULL;/.test(migration),
  'La mise a jour ne doit pas ecraser une date deja renseignee'
);

/* ── 2. La nature provisoire est inscrite, pas sous-entendue ── */

assert(
  /'date_embauche_provisoire'/.test(migration),
  'L evenement doit nommer explicitement la nature provisoire de la valeur'
);
assert(
  /'nature', 'provisoire'/.test(migration) && /'a_corriger', TRUE/.test(migration),
  'La trace doit porter la nature et le fait que la valeur reste a corriger — c est ce qu un controle viendra lire'
);
assert(
  /'2026-08-01'/.test(migration),
  'La date posee doit rester celle qui a ete decidee'
);

/* ── 3. Une date provisoire ne peut pas fonder un solde de tout compte ── */

assert(
  /async function dateEmbaucheEstProvisoire\(employeId\)/.test(service),
  'Le service de sortie doit savoir reconnaitre une date provisoire'
);
assert(
  /event_type = 'date_embauche_provisoire'/.test(service),
  'Le controle doit lire la trace posee par la migration, et non deviner'
);
assert(
  /await dateEmbaucheEstProvisoire\(agent\.id\)/.test(service),
  'Le controle doit etre appele lors de l initiation d une sortie'
);

/* Le refus se place apres celui de la date absente et avant tout calcul
   d'indemnite — la meme discipline que le controle existant. */
const iAbsente    = service.indexOf('if (ancienneteAnnees === null)');
const iProvisoire = service.indexOf('if (await dateEmbaucheEstProvisoire(agent.id))');
const iIndemnites = service.indexOf('} = calcIndemnites(typeSortie, ancienneteAnnees');
assert(iAbsente !== -1 && iProvisoire !== -1 && iIndemnites !== -1, 'Structure du calcul introuvable');
assert(
  iAbsente < iProvisoire && iProvisoire < iIndemnites,
  'Le refus sur date provisoire doit venir apres celui sur date absente et avant tout calcul d indemnite'
);

/* Il utilise le mecanisme de refus deja en place, sans en introduire un autre. */
const refus = service.slice(iProvisoire, iProvisoire + 600);
assert(/throw validationError\(/.test(refus), 'Le refus doit utiliser validationError, comme les autres controles');

/* Le message doit nommer ce qui manque et ou le corriger, sinon l utilisateur
   reste devant un refus sans issue. */
assert(
  /provisoire/.test(refus) && /fiche agent/.test(refus),
  'Le message doit dire que la date est provisoire et ou la corriger'
);

/* ── 4. Le refus doit pouvoir etre leve ──
   Sinon la correction n aurait aucun effet et le blocage serait definitif. */
assert(
  /'date_embauche_corrigee'/.test(service),
  'Une correction ulterieure doit pouvoir lever le refus'
);
assert(
  /return !marque\.corrigee \|\| marque\.corrigee < marque\.posee;/.test(service),
  'Une correction anterieure a la pose ne doit pas lever le refus : seule une correction posterieure compte'
);

console.log(JSON.stringify({
  traceWrittenBeforeUpdate: true,
  traceOnlyForFilesActuallyMissingIt: true,
  existingDatesNotOverwritten: true,
  provisionalNatureRecordedExplicitly: true,
  offboardingRefusesOnProvisionalDate: true,
  refusalPlacedBeforeAnyIndemnityCalculation: true,
  refusalUsesTheExistingMechanism: true,
  refusalCanBeLiftedByACorrection: true,
}));
