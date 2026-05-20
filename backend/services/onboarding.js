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
    label: 'Vérifier l\'identité (pièce d\'identité, contrat signé)',
    required: true,
    assigned_role: 'rh',
  },
  complete_hr_file: {
    label: 'Compléter le dossier RH (données manquantes)',
    required: true,
    assigned_role: 'rh',
  },
  notify_hr_admin: {
    label: 'Notifier RH et Admin de l\'arrivée',
    required: true,
    assigned_role: 'admin',
  },
  create_user_account: {
    label: 'Créer le compte utilisateur système',
    required: true,
    assigned_role: 'admin',
  },
  create_contract: {
    label: 'Créer le contrat de travail (brouillon)',
    required: false,
    assigned_role: 'rh',
  },
  validate_contract: {
    label: 'Valider le contrat de travail',
    required: false,
    assigned_role: 'dg',
  },
  verify_salary: {
    label: 'Vérifier la cohérence du salaire de base',
    required: false,
    assigned_role: 'finance',
  },
  create_first_payslip_draft: {
    label: 'Créer le bulletin de salaire du premier mois (brouillon)',
    required: false,
    assigned_role: 'finance',
  },
  verify_first_month_prorata: {
    label: 'Vérifier le prorata du premier mois (embauche en cours de mois)',
    required: false,
    assigned_role: 'finance',
  },
  assign_department: {
    label: 'Affecter au département',
    required: false,
    assigned_role: 'rh',
  },
  assign_poste: {
    label: 'Affecter au poste',
    required: false,
    assigned_role: 'rh',
  },
  assign_supervisor: {
    label: 'Définir le supérieur hiérarchique',
    required: false,
    assigned_role: 'rh',
  },
  configure_attendance_profile: {
    label: 'Configurer le profil de présence / pointeuse',
    required: false,
    assigned_role: 'admin',
  },
};

// ─── Calcul des tâches à générer ─────────────────────────────────────────────

function buildTaskList(employe) {
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

  return tasks;
}

// ─── Initialiser l'onboarding d'un employé ───────────────────────────────────

async function initOnboarding(employe_id, employe, created_by, ip) {
  const employe_data = employe || await db.queryOne('SELECT * FROM employes WHERE id = ?', [employe_id]);
  if (!employe_data) throw new Error(`Employé #${employe_id} introuvable`);

  const taskKeys = buildTaskList(employe_data);
  const now      = new Date().toISOString();
  const due      = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString().slice(0, 10); // J+7

  await db.transaction(async (tx) => {
    // Supprimer ancienne checklist si re-init
    await tx.execute('DELETE FROM onboarding_tasks WHERE employe_id = ?', [employe_id]);

    for (const key of taskKeys) {
      const def = TASK_DEFS[key];
      await tx.execute(`
        INSERT INTO onboarding_tasks
          (employe_id, task_key, label, status, required, assigned_role, due_date, created_at, updated_at)
        VALUES (?, ?, ?, 'todo', ?, ?, ?, ?, ?)
      `, [employe_id, key, def.label, def.required ? 1 : 0, def.assigned_role || null, due, now, now]);
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

  const total    = tasks.length;
  const done     = tasks.filter(t => t.status === 'done' || t.status === 'skipped').length;
  const required = tasks.filter(t => t.required);
  const req_done = required.filter(t => t.status === 'done').length;

  return { employe, tasks, events, progress: { total, done, required: required.length, req_done } };
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
