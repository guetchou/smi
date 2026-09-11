'use strict';
/*
 * L'etat d'une fiche a sa creation, et ce qui le fait changer.
 *
 * Une fiche creee pour une arrivee a venir ne decrit pas quelqu'un qui
 * travaille. Elle prepare une arrivee. Tant que la personne n'est pas la,
 * elle doit rester hors de l'effectif, hors de la masse salariale, hors de
 * la generation des bulletins.
 *
 * Mesure du 10/09/2026 : la fiche MAT-0018 a ete creee le 14/07 pour une
 * arrivee le 01/08. Dix-huit jours durant, elle comptait dans les onze
 * actifs et dans les 1 935 000 XAF de masse brute, alors que la personne
 * n'etait pas encore la.
 *
 * Le porteur de cette regle est le couple (statut_dossier, actif). Une fiche
 * en preparation porte actif = 0 : les indicateurs d'effectif exigent deja
 * actif = 1 et l'excluent donc sans qu'aucun comptage ait a la connaitre.
 * C'est ce qui evite d'avoir a modifier -- et donc d'oublier -- une requete.
 */

const PREPARATION = 'preintegration';
const ACTIF = 'actif';
const JAMAIS_ARRIVE = 'jamais_arrive';

/** Une date lisible, ou NaN. Les fiches portent parfois des chaines vides. */
function instant(valeur) {
  if (!valeur) return NaN;
  const t = new Date(valeur).getTime();
  return Number.isFinite(t) ? t : NaN;
}

/**
 * L'etat d'une fiche au moment ou on la cree.
 *
 * Un statut demande explicitement est respecte : la personne qui saisit sait
 * parfois mieux -- une reprise d'historique, un dossier deja sorti. Seul le
 * defaut est deduit de la date d'arrivee.
 *
 * @returns {{statut_dossier:string, actif:number, deduit:boolean}}
 */
function etatALaCreation({ dateEmbauche, statutDemande, maintenant } = {}) {
  const demande = String(statutDemande || '').trim();
  if (demande && demande !== ACTIF) {
    return { statut_dossier: demande, actif: demande === ACTIF ? 1 : 0, deduit: false };
  }

  const arrivee = instant(dateEmbauche);
  const t = Number.isFinite(maintenant) ? maintenant : Date.now();

  /* Le jour meme compte comme une arrivee : quelqu'un qui commence
     aujourd'hui travaille aujourd'hui. Seule une date strictement a venir
     ouvre une preparation. */
  if (Number.isFinite(arrivee) && arrivee > finDeJournee(t)) {
    return { statut_dossier: PREPARATION, actif: 0, deduit: true };
  }
  return { statut_dossier: ACTIF, actif: 1, deduit: true };
}

/* Comparer des dates sans heure a un instant : sans cela, une arrivee datee
   d'aujourd'hui serait vue comme passee des midi et comme future le matin. */
function finDeJournee(t) {
  const d = new Date(t);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

/* Les passages permis. Une fiche preparee devient active a l'arrivee, ou
   jamais arrivee si personne ne s'est presente. Elle ne passe pas
   directement a « sorti » : on ne sort pas quelqu'un qui n'est pas entre. */
const TRANSITIONS = {
  [PREPARATION]: [ACTIF, JAMAIS_ARRIVE, 'archive'],
  [ACTIF]: ['suspendu', 'sorti'],
  suspendu: [ACTIF, 'sorti'],
  sorti: ['archive', PREPARATION],   // une reembauche rouvre la fiche existante
  archive: [PREPARATION],
  [JAMAIS_ARRIVE]: ['archive', PREPARATION],
};

function transitionPermise(de, vers) {
  return (TRANSITIONS[de] || []).includes(vers);
}

module.exports = {
  etatALaCreation, transitionPermise, TRANSITIONS,
  PREPARATION, ACTIF, JAMAIS_ARRIVE,
};
