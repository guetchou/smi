'use strict';

const db = require('../db');
const {
  creerEntreeParapheurDansTransaction,
  notifierParapheurTarget,
} = require('./parapheur_async');

const TYPES_SORTIE = [
  'demission',
  'licenciement',
  'licenciement_cause_reelle',
  'retraite',
  'fin_contrat',
  'deces',
  'rupture_conventionnelle',
];

function money(value) {
  return Math.round(Number(value || 0));
}

function text(value, fallback = '') {
  return value === undefined || value === null ? fallback : String(value).trim();
}

function dateOrNull(value) {
  return value ? String(value).slice(0, 10) : null;
}

/* Rend null quand la date manque : l'ancienneté est alors inconnue, pas nulle.
   L'appelant doit trancher, plutôt que d'hériter d'un zéro trompeur. */
async function dateEmbaucheEstProvisoire(employeId) {
  const marque = await db.queryOne(`
    SELECT
      MAX(CASE WHEN event_type = 'date_embauche_provisoire' THEN created_at END) AS posee,
      MAX(CASE WHEN event_type = 'date_embauche_corrigee'   THEN created_at END) AS corrigee
    FROM onboarding_events
    WHERE employe_id = ?
  `, [employeId]);
  if (!marque || !marque.posee) return false;
  return !marque.corrigee || marque.corrigee < marque.posee;
}

function calcAncienneteAnnees(dateEmbauche) {
  if (!dateEmbauche) return null;
  const debut = new Date(dateEmbauche);
  const now = new Date();
  return Math.max(
    0,
    Math.floor(((now - debut) / (1000 * 60 * 60 * 24 * 365.25)) * 10) / 10,
  );
}

function calcIndemnites(typeSortie, ancienneteAnnees, salaireBase) {
  const salaire = money(salaireBase);
  let indemniteLicenciement = 0;
  let indemnitePreavis = 0;

  if (
    ['licenciement', 'licenciement_cause_reelle', 'rupture_conventionnelle'].includes(typeSortie)
    && ancienneteAnnees >= 1
  ) {
    const tranches = Math.floor(ancienneteAnnees / 5);
    indemniteLicenciement = tranches * salaire;
    if (tranches === 0) indemniteLicenciement = Math.round(salaire * 0.5);
  }

  if (typeSortie !== 'demission') {
    if (ancienneteAnnees < 2) indemnitePreavis = salaire;
    else if (ancienneteAnnees < 5) indemnitePreavis = salaire * 2;
    else indemnitePreavis = salaire * 3;
  }

  if (typeSortie === 'demission' && ancienneteAnnees >= 1) {
    indemnitePreavis = ancienneteAnnees < 2
      ? salaire
      : ancienneteAnnees < 5
        ? salaire * 2
        : salaire * 3;
  }

  return {
    indemnite_licenciement: indemniteLicenciement,
    indemnite_preavis: indemnitePreavis,
  };
}

function validationError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function notFoundError(message) {
  const error = new Error(message);
  error.status = 404;
  return error;
}

async function audit(tx, id, action, details, userId) {
  await tx.execute(
    'INSERT INTO audit_logs (table_name, record_id, action, details, user_id) VALUES (?,?,?,?,?)',
    ['employes_sortie', id, action, JSON.stringify(details || {}), userId || null],
  );
}

async function initiateOffboarding({
  agent,
  payload,
  actorId,
  dbc = db,
  failAfterDossier = false,
}) {
  if (!agent?.id) throw validationError('Agent obligatoire');
  if (!actorId) throw validationError('Auteur obligatoire');

  const typeSortie = text(payload?.type_sortie);
  const dateAnnonce = dateOrNull(payload?.date_annonce);
  const dateDepartEffectif = dateOrNull(payload?.date_depart_effectif);
  const dateFinPreavis = dateOrNull(payload?.date_fin_preavis);
  const notes = text(payload?.notes) || null;
  const autresIndemnites = money(payload?.autres_indemnites);

  if (!typeSortie || !TYPES_SORTIE.includes(typeSortie)) {
    throw validationError(`type_sortie invalide. Valeurs : ${TYPES_SORTIE.join(', ')}`);
  }
  if (!dateDepartEffectif) {
    throw validationError('date_depart_effectif requis');
  }
  if (dateAnnonce && dateDepartEffectif < dateAnnonce) {
    throw validationError('date_depart_effectif antérieure à date_annonce');
  }

  const ancienneteAnnees = calcAncienneteAnnees(agent.date_embauche);
  if (ancienneteAnnees === null) {
    throw validationError(
      "Date d'embauche absente du dossier de l'agent : l'ancienneté, l'indemnité de licenciement et l'indemnité de préavis ne peuvent pas être calculées. Renseignez-la dans la fiche agent avant d'initier la sortie."
    );
  }
  if (await dateEmbaucheEstProvisoire(agent.id)) {
    throw validationError(
      "Date d'embauche provisoire au dossier de l'agent : l'ancienneté, l'indemnité de licenciement et l'indemnité de préavis seraient calculées sur une date qui n'a pas été établie. Renseignez la date réelle dans la fiche agent avant d'initier la sortie."
    );
  }
  const {
    indemnite_licenciement: indemniteLicenciement,
    indemnite_preavis: indemnitePreavis,
  } = calcIndemnites(typeSortie, ancienneteAnnees, agent.salaire_base);
  const congesRestants = Math.max(0, Number(agent.conges_solde_annuel || 0));
  const salaireJournalier = Number(agent.salaire_base || 0) / 26;
  const congesMontant = Math.round(congesRestants * salaireJournalier);
  const soldeToutCompte = money(
    indemniteLicenciement + indemnitePreavis + congesMontant + autresIndemnites,
  );
  const checklistMateriel = payload?.checklist_materiel || JSON.stringify([
    'Badge / carte d’accès',
    'Ordinateur portable',
    'Téléphone professionnel',
    'Clés / accès locaux',
    'Documents confidentiels',
    'Matériel de terrain',
  ]);
  const checklistAcces = payload?.checklist_acces || JSON.stringify([
    'Accès système informatique',
    'Email professionnel',
    'Accès intranet',
    'Accès logiciels métier',
    'Accès réseaux sociaux entreprise',
  ]);
  const titreParapheur = `Offboarding — ${agent.nom} ${agent.prenom || ''} (${typeSortie}) — STC : ${new Intl.NumberFormat('fr-FR').format(soldeToutCompte)} XAF`;

  const result = await dbc.transaction(async (tx) => {
    const inserted = await tx.execute(`
      INSERT INTO employes_sortie
        (employe_id, type_sortie, date_annonce, date_fin_preavis, date_depart_effectif,
         anciennete_annees, indemnite_licenciement, indemnite_preavis,
         conges_payes_restants, conges_payes_montant, autres_indemnites,
         solde_tout_compte_total, statut, checklist_materiel, checklist_acces,
         notes, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'initie', ?, ?, ?, ?, NOW(), NOW())
    `, [
      agent.id,
      typeSortie,
      dateAnnonce,
      dateFinPreavis,
      dateDepartEffectif,
      ancienneteAnnees,
      indemniteLicenciement,
      indemnitePreavis,
      congesRestants,
      congesMontant,
      autresIndemnites,
      soldeToutCompte,
      checklistMateriel,
      checklistAcces,
      notes,
      actorId,
    ]);

    const dossierId = inserted.insertId;
    if (!dossierId) throw new Error('Création du dossier de sortie sans identifiant');
    if (failAfterDossier) throw new Error('OFFBOARDING_TEST_FAILURE_AFTER_DOSSIER');

    const parapheurId = await creerEntreeParapheurDansTransaction(tx, {
      type: 'offboarding',
      titre: titreParapheur,
      initiateur_id: actorId,
      montant: soldeToutCompte,
      ref_source_table: 'employes_sortie',
      ref_source_id: dossierId,
      priorite: 'urgent',
      required: true,
    });

    await audit(tx, dossierId, 'initier', {
      type_sortie: typeSortie,
      solde_tout_compte: soldeToutCompte,
      parapheur_id: parapheurId,
      required_parapheur: true,
    }, actorId);

    return {
      id: dossierId,
      parapheurId,
      titreParapheur,
    };
  });

  await notifierParapheurTarget(result.titreParapheur, dbc);
  return result;
}

async function validateOffboarding({
  employeeId,
  actorId,
  dbc = db,
  failAfterDossierUpdate = false,
}) {
  const normalizedEmployeeId = Number(employeeId);
  if (!normalizedEmployeeId) throw validationError('Agent obligatoire');
  if (!actorId) throw validationError('Validateur obligatoire');

  return dbc.transaction(async (tx) => {
    const agent = await tx.queryOne(
      'SELECT id, statut_dossier FROM employes WHERE id = ?',
      [normalizedEmployeeId],
    );
    if (!agent) throw notFoundError('Agent introuvable');

    const dossier = await tx.queryOne(
      "SELECT * FROM employes_sortie WHERE employe_id = ? AND statut = 'initie' ORDER BY id DESC LIMIT 1",
      [normalizedEmployeeId],
    );
    if (!dossier) throw notFoundError('Aucun dossier de sortie en statut initié');

    await tx.execute(`
      UPDATE employes_sortie
      SET statut='valide', validated_by=?, validated_at=NOW(), updated_at=NOW()
      WHERE id=? AND statut='initie'
    `, [actorId, dossier.id]);

    if (failAfterDossierUpdate) {
      throw new Error('OFFBOARDING_TEST_FAILURE_AFTER_VALIDATION_DOSSIER');
    }

    await tx.execute(`
      UPDATE employes
      SET actif=0, statut_dossier='sorti', motif_sortie=?, date_sortie=?, updated_at=NOW()
      WHERE id=?
    `, [dossier.type_sortie, dossier.date_depart_effectif, normalizedEmployeeId]);

    await audit(tx, dossier.id, 'valider', { type_sortie: dossier.type_sortie }, actorId);
    await tx.execute(
      'INSERT INTO audit_logs (table_name, record_id, action, details, user_id) VALUES (?,?,?,?,?)',
      [
        'employes',
        normalizedEmployeeId,
        'statut_sorti',
        JSON.stringify({ motif: dossier.type_sortie }),
        actorId,
      ],
    );

    return {
      dossierId: dossier.id,
      employeeId: normalizedEmployeeId,
      typeSortie: dossier.type_sortie,
      statut: 'valide',
      employeStatut: 'sorti',
    };
  });
}

module.exports = {
  TYPES_SORTIE,
  calcIndemnites,
  initiateOffboarding,
  validateOffboarding,
};
