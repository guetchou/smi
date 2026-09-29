'use strict';
/*
 * Pièce de paie d'une période — écran C4 (maquette validée le 29/09/2026).
 *
 * Une période de paie devient UNE pièce du journal OD, écrite dans la
 * comptabilité générale par POST /smi/pieces (ADR 0002). Les montants sont les
 * sommes des bulletins non annulés de la période.
 *
 * Comptes (plan SYSCOHADA du Congo) :
 *   6611 D  salaires bruts                     (maquette validée)
 *   6641 D  charges patronales CNSS + CAMU     (maquette validée)
 *   422  C  net à payer, avance déduite        (maquette validée)
 *   431  C  CNSS, parts salariale et patronale (maquette validée)
 *   447  C  IRPP retenu                        (maquette validée)
 *   433  C  CAMU, parts salariale et patronale (PROPOSÉ, à valider)
 *   421  C  avances sur salaire retenues       (PROPOSÉ, à valider)
 * Les comptes proposés sont réglables sans toucher au code.
 */
const COMPTES = {
  brut: process.env.PAIE_COMPTE_BRUT || '6611',
  chargesPatronales: process.env.PAIE_COMPTE_CHARGES || '6641',
  net: process.env.PAIE_COMPTE_NET || '422',
  cnss: process.env.PAIE_COMPTE_CNSS || '431',
  irpp: process.env.PAIE_COMPTE_IRPP || '447',
  camu: process.env.PAIE_COMPTE_CAMU || '433',
  avances: process.env.PAIE_COMPTE_AVANCES || '421',
};

// Une période n'est écrite qu'une fois la paie validée par la direction.
const STATUTS_ECRIVABLES = ['validee_dg', 'paiement_en_cours', 'payee_partielle', 'payee', 'cloturee'];

const arrondi = n => Math.round((Number(n) || 0) * 100) / 100;
const reference = p => `SMI-PAIE-${p.annee}-${String(p.mois).padStart(2, '0')}`;
const finDeMois = p => {
  const d = new Date(Date.UTC(Number(p.annee), Number(p.mois), 0));
  return d.toISOString().slice(0, 10);
};
const libelleMois = p => new Date(Date.UTC(Number(p.annee), Number(p.mois) - 1, 15))
  .toLocaleDateString('fr-FR', { month: 'long', timeZone: 'UTC' });

function sommes(bulletins) {
  const s = { brut: 0, cnssEmp: 0, camuEmp: 0, irpp: 0, net: 0, avance: 0, cnssPat: 0, camuPat: 0 };
  for (const b of bulletins) {
    s.brut += Number(b.brut || 0);
    s.cnssEmp += Number(b.cnss_employe || 0);
    s.camuEmp += Number(b.camu_employe || 0);
    s.irpp += Number(b.irpp || 0);
    s.net += Number(b.net_a_payer || 0);
    s.avance += Number(b.retenue_avance || 0);
    s.cnssPat += Number(b.cnss_patronal || 0);
    s.camuPat += Number(b.camu_patronal || 0);
  }
  for (const k of Object.keys(s)) s[k] = arrondi(s[k]);
  return s;
}

/* Les lignes de la pièce ; une ligne à zéro n'est pas écrite. */
function construire(periode, bulletins) {
  const s = sommes(bulletins);
  const m = libelleMois(periode);
  const lignes = [
    { compte: COMPTES.brut, libelle: `Salaires bruts ${m}`, debit: s.brut, credit: 0 },
    { compte: COMPTES.chargesPatronales, libelle: `CNSS part patronale ${m}`, debit: s.cnssPat, credit: 0 },
    { compte: COMPTES.chargesPatronales, libelle: `CAMU part patronale ${m}`, debit: s.camuPat, credit: 0 },
    { compte: COMPTES.net, libelle: `Net à payer ${m}`, debit: 0, credit: arrondi(s.net - s.avance) },
    { compte: COMPTES.avances, libelle: `Avances retenues ${m}`, debit: 0, credit: s.avance },
    { compte: COMPTES.cnss, libelle: `CNSS part salariale ${m}`, debit: 0, credit: s.cnssEmp },
    { compte: COMPTES.cnss, libelle: `CNSS part patronale ${m}`, debit: 0, credit: s.cnssPat },
    { compte: COMPTES.camu, libelle: `CAMU part salariale ${m}`, debit: 0, credit: s.camuEmp },
    { compte: COMPTES.camu, libelle: `CAMU part patronale ${m}`, debit: 0, credit: s.camuPat },
    { compte: COMPTES.irpp, libelle: `IRPP retenu ${m}`, debit: 0, credit: s.irpp },
  ].filter(l => l.debit > 0 || l.credit > 0);
  const debit = arrondi(lignes.reduce((t, l) => t + l.debit, 0));
  const credit = arrondi(lignes.reduce((t, l) => t + l.credit, 0));
  return {
    periode_id: Number(periode.id),
    annee: Number(periode.annee),
    mois: Number(periode.mois),
    libelle_mois: m,
    reference: reference(periode),
    date: finDeMois(periode),
    journal: 'OD',
    bulletins: bulletins.length,
    lignes,
    total_debit: debit,
    total_credit: credit,
    equilibre: Math.abs(debit - credit) < 0.005 && lignes.length >= 2,
  };
}

module.exports = { COMPTES, STATUTS_ECRIVABLES, construire, reference };
