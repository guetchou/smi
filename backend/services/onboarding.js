'use strict';
/**
 * OnboardingService — Workflow d'intégration employé
 *
 * Règles métier :
 * - À la création d'un employé, génère une checklist de tâches selon conditions
 * - Aucune tâche ne crée de données finales automatiquement (tout en brouillon)
 * - Journalise chaque action dans onboarding_events
 * - Met à jour onboarding_status selon l'avancement des tâches obligatoires
 */

const db = require('../db');

// ─── Définition des tâches ────────────────────────────────────────────────────

const TASK_DEFS = {
  verify_identity: {
    parcours: 'onboarding',
    delai_jours: 3,
    label: 'Vérifier l\'identité (pièce d\'identité, contrat signé)',
    required: true,
    assigned_role: 'rh',
  },
  complete_hr_file: {
    parcours: 'onboarding',
    delai_jours: 7,
    label: 'Compléter le dossier RH (données manquantes)',
    required: true,
    assigned_role: 'rh',
  },
  notify_hr_admin: {
    parcours: 'onboarding',
    delai_jours: 1,
    label: 'Notifier RH et Admin de l\'arrivée',
    required: true,
    assigned_role: 'admin',
  },
  create_user_account: {
    parcours: 'onboarding',
    delai_jours: 2,
    label: 'Créer le compte utilisateur système',
    required: true,
    assigned_role: 'admin',
  },
  create_contract: {
    parcours: 'onboarding',
    delai_jours: 7,
    label: 'Créer le contrat de travail (brouillon)',
    required: false,
    assigned_role: 'rh',
  },
  validate_contract: {
    parcours: 'onboarding',
    delai_jours: 10,
    label: 'Valider le contrat de travail',
    required: false,
    assigned_role: 'dg',
  },
  verify_salary: {
    parcours: 'onboarding',
    delai_jours: 7,
    label: 'Vérifier la cohérence du salaire de base',
    required: false,
    assigned_role: 'finance',
  },
  create_first_payslip_draft: {
    parcours: 'onboarding',
    delai_jours: 20,
    label: 'Créer le bulletin de salaire du premier mois (brouillon)',
    required: false,
    assigned_role: 'finance',
  },
  verify_first_month_prorata: {
    parcours: 'onboarding',
    delai_jours: 20,
    label: 'Vérifier le prorata du premier mois (embauche en cours de mois)',
    required: false,
    assigned_role: 'finance',
  },
  assign_department: {
    parcours: 'onboarding',
    delai_jours: 7,
    label: 'Affecter au département',
    required: false,
    assigned_role: 'rh',
  },
  assign_poste: {
    parcours: 'onboarding',
    delai_jours: 7,
    label: 'Affecter au poste',
    required: false,
    assigned_role: 'rh',
  },
  assign_supervisor: {
    parcours: 'onboarding',
    delai_jours: 7,
    label: 'Définir le supérieur hiérarchique',
    required: false,
    assigned_role: 'rh',
  },
  configure_attendance_profile: {
    parcours: 'onboarding',
    delai_jours: 3,
    label: 'Configurer le profil de présence / pointeuse',
    required: false,
    assigned_role: 'admin',
  },

  // ---- Preparation : ce qui se fait avant le premier jour ----------------
  // Les delais negatifs se comptent avant l'arrivee.
  collect_hire_documents: {
    parcours: 'preintegration',
    delai_jours: -7,
    label: 'Réunir les pièces : identité, diplômes, numéro CNSS s’il existe',
    required: true,
    assigned_role: 'rh',
  },
  medical_check: {
    // La visite medicale precede le contrat ecrit pour tout CDD de plus de
    // trois mois ou toute installation hors du lieu de recrutement.
    parcours: 'preintegration',
    delai_jours: -6,
    label: 'Visite médicale d’embauche',
    required: true,
    assigned_role: 'rh',
  },
  decide_assignment: {
    parcours: 'preintegration',
    delai_jours: -5,
    label: 'Décider du poste, du département et du supérieur',
    required: false,
    assigned_role: 'rh',
  },
  draft_written_contract: {
    parcours: 'preintegration',
    delai_jours: -4,
    label: 'Établir le contrat de travail écrit',
    required: true,
    assigned_role: 'rh',
  },
  set_trial_period: {
    parcours: 'preintegration',
    delai_jours: -4,
    label: 'Fixer la période d’essai',
    required: false,
    assigned_role: 'rh',
  },
  contract_visa: {
    // Visa du bureau de placement pour un CDD de plus de trois mois ou une
    // installation hors du lieu de recrutement ; visa de la direction
    // generale du travail des qu'il y a entree ou sortie du territoire.
    parcours: 'preintegration',
    delai_jours: -3,
    label: 'Faire viser le contrat de travail',
    required: true,
    assigned_role: 'rh',
  },
  prepare_user_account: {
    parcours: 'preintegration',
    delai_jours: -2,
    label: 'Préparer le compte utilisateur, sans activer les accès',
    required: true,
    assigned_role: 'admin',
  },
  reserve_workstation: {
    parcours: 'preintegration',
    delai_jours: -1,
    label: 'Réserver le poste de travail et le matériel',
    required: false,
    assigned_role: 'admin',
  },
  announce_arrival: {
    parcours: 'preintegration',
    delai_jours: -1,
    label: 'Annoncer l’arrivée à l’équipe',
    required: false,
    assigned_role: 'rh',
  },
  // ---- Obligation legale, comptee apres l'embauche -----------------------
  cnss_registration: {
    // ’uarante-huit heures apres l'embauche : lecture du document officiel
    // du Ministere de la Fonction publique.
    parcours: 'onboarding',
    delai_jours: 2,
    label: 'Immatriculer le salarié à la CNSS',
    required: true,
    assigned_role: 'rh',
  },
};

// ─── Calcul des tâches à générer ─────────────────────────────────────────────

function buildTaskList(employe, parcours = 'onboarding') {
  const tasks = [];

  // Toujours
  tasks.push('verify_identity');
  tasks.push('complete_hr_file');
  tasks.push('notify_hr_admin');

  // Accès système demandé
  if (employe.besoin_acces_systeme) {
    tasks.push('create_user_account');
  }

  // Contrat de travail (si dates renseignées ou CDI/CDD)
  if (employe.date_embauche || employe.type_contrat) {
    tasks.push('create_contract');
    tasks.push('validate_contract');
  }

  // Paie (si salaire > 0)
  if (employe.salaire_base > 0) {
    tasks.push('verify_salary');
    tasks.push('create_first_payslip_draft');
    // Prorata si embauche en milieu de mois
    if (employe.date_embauche) {
      const day = new Date(employe.date_embauche).getDate();
      if (day > 1) tasks.push('verify_first_month_prorata');
    }
  }

  // Organigramme incomplet
  if (!employe.departement || !employe.departement_id) tasks.push('assign_department');
  if (!employe.poste || !employe.poste_id)             tasks.push('assign_poste');
  if (!employe.superieur_hierarchique && !employe.superieur_id) tasks.push('assign_supervisor');

  /* La preparation ne depend pas de l'etat de la fiche : elle prepare
     l'arrivee, et la fiche est justement encore vide a ce moment. */
  if (parcours === 'preintegration') {
    return Object.keys(TASK_DEFS).filter(k => TASK_DEFS[k].parcours === 'preintegration');
  }

  tasks.push('cnss_registration');

  // Ne garder que ce qui appartient au parcours demande.
  return tasks.filter(k => (TASK_DEFS[k] || {}).parcours === parcours);
}

// ─── Initialiser l'onboarding d'un employé ───────────────────────────────────

async function initOnboarding(employe_id, employe, created_by, ip, parcours = 'onboarding') {
  const employe_data = employe || await db.queryOne('SELECT * FROM employes WHERE id = ?', [employe_id]);
  if (!employe_data) throw new Error(`Employé #${employe_id} introuvable`);

  const taskKeys = buildTaskList(employe_data, parcours);
  const now      = new Date().toISOString();
  /* L'echeance part de l'arrivee tant qu'elle est devant nous. Preparer une
     fiche a l'avance est la bonne pratique -- contrat, acces, poste se
     preparent avant le premier jour -- et J+7 depuis la creation faisait
     naitre ces taches deja echues. Mesure le 10/09/2026 sur MAT-0018 : fiche
     creee le 14/07, echeance 21/07, arrivee le 01/08. Huit taches etaient en
     retard onze jours avant que la personne n'arrive.
     Une embauche deja passee retombe sur aujourd'hui : on ne pose pas une
     echeance anterieure a la creation de la liste. */
  const arrivee = employe_data.date_embauche ? new Date(employe_data.date_embauche).getTime() : NaN;
  /* L'arrivee est l'ancre, meme passee : c'est elle qui fait courir les
     delais legaux. Sans date lisible, on retombe sur aujourd'hui plutot que
     de produire une echeance invalide. */
  const depart  = Number.isFinite(arrivee) ? arrivee : Date.now();
  const echeance = (delai) => new Date(
    depart + (Number.isFinite(delai) ? delai : 7) * 24 * 3600 * 1000
  ).toISOString().slice(0, 10);

  await db.transaction(async (tx) => {
    // Supprimer ancienne checklist si re-init
    await tx.execute('DELETE FROM onboarding_tasks WHERE employe_id = ?', [employe_id]);

    for (const key of taskKeys) {
      const def = TASK_DEFS[key];
      await tx.execute(`
        INSERT INTO onboarding_tasks
          (employe_id, task_key, label, status, required, assigned_role, due_date, created_at, updated_at)
        VALUES (?, ?, ?, 'todo', ?, ?, ?, ?, ?)
      `, [employe_id, key, def.label, def.required ? 1 : 0, def.assigned_role || null, echeance(def.delai_jours), now, now]);
    }

    // Statut → en_cours
    await tx.execute(`UPDATE employes SET onboarding_status = 'en_cours', updated_at = ? WHERE id = ?`,
      [now, employe_id]);

    await tx.execute(`
      INSERT INTO onboarding_events (employe_id, event_type, new_value, created_by, created_at, ip_address)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [employe_id, 'onboarding_init', JSON.stringify({ tasks: taskKeys }), created_by || null, now, ip || null]);
  });

  return getOnboarding(employe_id);
}

// ─── Lire l'état de l'onboarding ─────────────────────────────────────────────

async function getOnboarding(employe_id) {
  const employe = await db.queryOne(`
    SELECT id, nom, prenom, matricule, onboarding_status, besoin_acces_systeme,
           salaire_base, date_embauche, departement, poste, superieur_hierarchique
    FROM employes WHERE id = ?
  `, [employe_id]);
  if (!employe) return null;

  const tasks  = await db.query('SELECT * FROM onboarding_tasks WHERE employe_id = ? ORDER BY id', [employe_id]);
  const events = await db.query('SELECT * FROM onboarding_events WHERE employe_id = ? ORDER BY created_at DESC LIMIT 50', [employe_id]);
  const userAccount = await db.queryOne(
    'SELECT id, nom, email, role, actif, must_change_password, provisioned_at FROM users WHERE employe_id = ? AND actif = 1 ORDER BY id LIMIT 1',
    [employe_id]
  );

  const total    = tasks.length;
  const done     = tasks.filter(t => t.status === 'done' || t.status === 'skipped').length;
  const required = tasks.filter(t => t.required);
  const req_done = required.filter(t => t.status === 'done').length;

  return { employe, tasks, events, user_account: userAccount || null, progress: { total, done, required: required.length, req_done } };
}

// ─── Compléter une tâche ──────────────────────────────────────────────────────

async function completeTask(employe_id, task_key, user_id, notes, ip) {
  const task = await db.queryOne(
    'SELECT * FROM onboarding_tasks WHERE employe_id = ? AND task_key = ?',
    [employe_id, task_key]
  );

  if (!task) throw new Error(`Tâche '${task_key}' introuvable pour l'employé #${employe_id}`);
  if (task.status === 'done') throw new Error(`Tâche '${task_key}' déjà complétée`);

  const now = new Date().toISOString();

  await db.transaction(async (tx) => {
    await tx.execute(`
      UPDATE onboarding_tasks
      SET status = 'done', completed_at = ?, completed_by = ?, notes = ?, updated_at = ?
      WHERE id = ?
    `, [now, user_id, notes || null, now, task.id]);

    await tx.execute(`
      INSERT INTO onboarding_events (employe_id, event_type, old_value, new_value, created_by, created_at, ip_address)
      VALUES (?, 'task_completed', ?, ?, ?, ?, ?)
    `, [employe_id, task.status, JSON.stringify({ task_key, notes }), user_id, now, ip || null]);

    // Recalculer statut global
    await recalcStatus(employe_id, now, tx);
  });

  return getOnboarding(employe_id);
}

// ─── Ignorer une tâche (skip) ─────────────────────────────────────────────────

async function skipTask(employe_id, task_key, user_id, motif, ip) {
  const task = await db.queryOne(
    'SELECT * FROM onboarding_tasks WHERE employe_id = ? AND task_key = ?',
    [employe_id, task_key]
  );

  if (!task) throw new Error(`Tâche '${task_key}' introuvable`);
  if (task.required) throw new Error(`La tâche '${task_key}' est obligatoire et ne peut pas être ignorée`);
  if (task.status === 'done') throw new Error(`Tâche '${task_key}' déjà complétée`);

  const now = new Date().toISOString();

  await db.transaction(async (tx) => {
    await tx.execute(`
      UPDATE onboarding_tasks
      SET status = 'skipped', completed_at = ?, completed_by = ?, notes = ?, updated_at = ?
      WHERE id = ?
    `, [now, user_id, motif || null, now, task.id]);

    await tx.execute(`
      INSERT INTO onboarding_events (employe_id, event_type, old_value, new_value, created_by, created_at, ip_address)
      VALUES (?, 'task_skipped', ?, ?, ?, ?, ?)
    `, [employe_id, task.status, JSON.stringify({ task_key, motif }), user_id, now, ip || null]);

    await recalcStatus(employe_id, now, tx);
  });

  return getOnboarding(employe_id);
}

// ─── Recalculer le statut global onboarding ──────────────────────────────────

async function recalcStatus(employe_id, now, tx) {
  const dbCtx   = tx || db;
  const tasks    = await dbCtx.query('SELECT * FROM onboarding_tasks WHERE employe_id = ?', [employe_id]);
  const required = tasks.filter(t => t.required);
  const allDone  = required.every(t => t.status === 'done');
  const anyTodo  = tasks.some(t => t.status === 'todo' || t.status === 'doing');

  let newStatus;
  if (allDone && !anyTodo) {
    newStatus = 'pret';
  } else if (tasks.some(t => t.status === 'done')) {
    newStatus = 'en_cours';
  } else {
    newStatus = 'incomplet';
  }

  await dbCtx.execute('UPDATE employes SET onboarding_status = ?, updated_at = ? WHERE id = ?',
    [newStatus, now || new Date().toISOString(), employe_id]);
}

// ─── Activer un employé (toutes tâches req. done) ────────────────────────────

async function activerEmploye(employe_id, user_id, ip) {
  const ob = await getOnboarding(employe_id);
  if (!ob) throw new Error(`Employé #${employe_id} introuvable`);

  const blockers = ob.tasks.filter(t => t.required && t.status !== 'done');
  if (blockers.length > 0) {
    throw new Error(
      `Impossible d'activer : ${blockers.length} tâche(s) obligatoire(s) non complétée(s) : ` +
      blockers.map(t => t.label).join(', ')
    );
  }

  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.execute(`UPDATE employes SET onboarding_status = 'actif', statut_dossier = 'actif', actif = 1, updated_at = ? WHERE id = ?`,
      [now, employe_id]);
    await tx.execute(`INSERT INTO onboarding_events (employe_id, event_type, new_value, created_by, created_at, ip_address) VALUES (?, 'activated', '{}', ?, ?, ?)`,
      [employe_id, user_id, now, ip || null]);
  });

  return getOnboarding(employe_id);
}

// ─── Notifier RH/Admin à la création ─────────────────────────────────────────

async function notifierCreation(employe, created_by) {
  try {
    const { creerNotification } = require('./notif');
    const admins = await db.query(
      "SELECT id FROM users WHERE actif=1 AND (role IN ('admin','rh') OR roles LIKE '%\"rh\"%')"
    );

    admins.forEach(u => {
      creerNotification({
        type:     'onboarding_nouveau_employe',
        famille:  'rh',
        priorite: 'info',
        titre:    `Nouvel employé : ${employe.nom} ${employe.prenom}`,
        message:  `Matricule ${employe.matricule} — checklist onboarding à traiter.`,
        user_id:  u.id,
        src_table: 'employes',
        src_id:   employe.id,
      });
    });
  } catch (_) { /* notifications non bloquantes */ }
}

module.exports = { initOnboarding, getOnboarding, completeTask, skipTask, activerEmploye, notifierCreation, TASK_DEFS };
