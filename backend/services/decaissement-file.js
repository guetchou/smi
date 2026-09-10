'use strict';
/*
 * Qui voit quoi dans la file des décaissements.
 *
 * Trois droits distincts se croisent ici et ils s'ADDITIONNENT :
 *   — créer/soumettre : ses propres brouillons, et rien que les siens ;
 *   — approuver       : les décaissements soumis, de tout le monde ;
 *   — payer           : les décaissements validés, de tout le monde.
 *
 * Le 10/09/2026, ils s'excluaient : les brouillons n'étaient listés que si le
 * compte ne pouvait NI approuver NI payer. Tout compte disposant d'un pouvoir
 * perdait la vue sur ses propres brouillons — il saisissait un décaissement,
 * l'écriture partait bien en base, puis la ligne disparaissait de son écran
 * sans un mot et ne pouvait plus jamais être soumise.
 *
 * Mesure du jour sur la production : les trois comptes actifs (Administrateur,
 * LOUVOUEZO, NGUIE) portent cash.out.pay et cash.out.validate par profil.
 * Les trois étaient donc exclus — 3 sur 3. GET .../pending?scope=actionable
 * rendait [] quand GET .../pending rendait bien le brouillon.
 *
 * Le droit n'a jamais manqué : PUT /operations/3/soumettre a répondu 200 sur
 * ce même brouillon. Seule la liste était fautive, et sans elle le bouton
 * « Soumettre » n'est jamais dessiné.
 */

const BROUILLON = 'brouillon';
const SOUMIS = 'soumis';
const VALIDE = 'valide';

/* Le statut est lu tel qu'il est. Un dec_statut absent n'est PAS un
   brouillon : c'est une operation qui n'est jamais entree dans le parcours de
   validation — un import, typiquement. Le 31/08/2026, le raccourci inverse
   annoncait 667 decaissements « en attente » pour 37 149 361 XAF alors que le
   parcours en comptait zero. Voir tests/bilan_decaissements_attente_test.js. */

/**
 * Les critères de la file « actionable » : ce sur quoi ce compte peut agir.
 *
 * Rend null quand aucun droit ne s'applique — l'appelant répond alors une
 * liste vide sans interroger la base.
 */
function criteresFileActionnable({ peutEcrire, peutApprouver, peutPayer, utilisateurId }) {
  const morceaux = [];
  const params = [];

  if (peutEcrire) {
    // Ses propres brouillons uniquement : nul ne soumet à la place d'un autre.
    morceaux.push('(o.dec_statut IN (?) AND o.created_by = ?)');
    params.push(BROUILLON, utilisateurId);
  }
  if (peutApprouver) {
    morceaux.push('(o.dec_statut IN (?))');
    params.push(SOUMIS);
  }
  if (peutPayer) {
    morceaux.push('(o.dec_statut IN (?))');
    params.push(VALIDE);
  }

  if (!morceaux.length) return null;
  return { sql: `(${morceaux.join(' OR ')})`, params };
}

/** La file complète, quand aucun périmètre n'est demandé. */
function criteresFileComplete() {
  return { sql: '(o.dec_statut IN (?, ?, ?))', params: [BROUILLON, SOUMIS, VALIDE] };
}

module.exports = { criteresFileActionnable, criteresFileComplete, BROUILLON, SOUMIS, VALIDE };
