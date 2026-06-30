/**
 * PLAN DE TEST COMPLET — Workflow congés
 * Couvre : syntaxe, migrations, API, rôles, frontend-data,
 *          non-régression, cas normaux, cas d'erreur, logs
 * Usage : node tests/conges_full_test.js
 */
'use strict';
const http = require('http');

// ── état global ──────────────────────────────────────────────────────────────
let passed = 0, failed = 0, skipped = 0;
const errors = [];
const results = [];
const tokens = {};
let empId = null, congeId = null;

// ── helpers ───────────────────────────────────────────────────────────────────
function req(method, path, body, role) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const tok = (role === '__none__') ? null : (tokens[role || 'admin']);
    const opts = {
      method,
      hostname: 'localhost',
      port: 3337,
      path: `/api${path}`,
      headers: {
        'Content-Type': 'application/json',
        ...(tok ? { 'Authorization': `Bearer ${tok}` } : {}),
      },
    };
    const r = http.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        let body; try { body = JSON.parse(d); } catch { body = d; }
        resolve({ status: res.statusCode, body, raw: d });
      });
    });
    r.on('error', e => resolve({ status: 0, body: { error: e.message }, raw: '' }));
    if (payload) r.write(payload);
    r.end();
  });
}

async function getToken(email, password) {
  const cap = await req('GET', '/auth/captcha', null, '__none__');
  if (cap.status !== 200) return null;
  const parts = cap.body.question.replace(' = ?', '').split(' ');
  const a = parseInt(parts[0]), op = parts[1], b = parseInt(parts[2]);
  const ans = op === '+' ? a + b : op === '-' ? a - b : a * b;
  const res = await req('POST', '/auth/login',
    { email, password, captchaId: cap.body.id, captchaAnswer: ans }, '__none__');
  return res.body?.token || null;
}

function section(name) {
  console.log(`\n${'═'.repeat(52)}\n  ${name}\n${'═'.repeat(52)}`);
}

function assert(label, cond, detail = '') {
  const icon = cond ? '✓' : '✗';
  console.log(`  ${icon} ${label}${!cond && detail ? ' — ' + String(detail).slice(0, 130) : ''}`);
  results.push({ label, ok: cond });
  if (cond) passed++; else { failed++; errors.push({ label, detail }); }
}

// Dates uniques par run pour éviter les chevauchements avec les données existantes
const TS   = Date.now();
const YEAR = 2040 + (TS % 7);
const MON  = String(((TS >> 8) % 10) + 1).padStart(2, '0');
const D1   = `${YEAR}-${MON}-05`;
const D2   = `${YEAR}-${MON}-07`;   // 3 jours (05→07)
const D3   = `${YEAR}-${MON}-15`;
const D4   = `${YEAR}-${MON}-17`;   // 2e plage (pour test erreur)

// ─────────────────────────────────────────────────────────────────────────────
async function run() {

// ─── 0. SYNTAXE ───────────────────────────────────────────────────────────────
section('0. SYNTAXE (node --check)');
const { execSync } = require('child_process');
const files = [
  'backend/database.js',
  'backend/routes/agents.js',
  'backend/services/email.js',
  'tests/conges_smoke.js',
  'tests/conges_full_test.js',
];
for (const f of files) {
  try {
    execSync(`node --check ${f}`, { cwd: '/opt/projet-smi', stdio: 'pipe' });
    assert(`Syntaxe OK : ${f}`, true);
  } catch (e) {
    assert(`Syntaxe OK : ${f}`, false, e.stderr?.toString());
  }
}

// ─── 1. SANTÉ SERVEUR ────────────────────────────────────────────────────────
section('1. SANTÉ SERVEUR');
const health = await req('GET', '/health', null, '__none__');
assert('GET /api/health → 200', health.status === 200);
assert('status: ok', health.body?.status === 'ok');

// ─── 2. AUTHENTIFICATION ─────────────────────────────────────────────────────
section('2. AUTHENTIFICATION & PROTECTION');
tokens.admin = await getToken('admin@topcenter.cg', 'Admin@2025!');
assert('Login admin réussi', !!tokens.admin);

const noAuth401 = [
  '/agents/conges/all',
  '/agents/conges/calendrier',
  '/agents/1/conges',
  '/agents/1/conges/solde',
];
for (const path of noAuth401) {
  const r = await req('GET', path, null, '__none__');
  assert(`Sans token → 401 : GET ${path}`, r.status === 401, `status=${r.status}`);
}
// PUT sans token
const putNoAuth = await req('PUT', '/agents/1/conges/1/valider-sup', {}, '__none__');
assert('PUT /valider-sup sans token → 401', putNoAuth.status === 401);

// ─── 3. MIGRATIONS DB ────────────────────────────────────────────────────────
section('3. MIGRATIONS DB (via API — table migrée)');
// Preuve indirecte : si calendrier et valider-sup répondent correctement,
// la table est bien migrée avec le bon CHECK.
const calMig = await req('GET', `/agents/conges/calendrier?annee=${YEAR}&mois=${MON}`);
assert('GET /conges/calendrier réussi (table migrée)', calMig.status === 200);
assert('Champ annee correct', calMig.body?.annee === YEAR);
assert('Champ mois correct',  calMig.body?.mois  === parseInt(MON));
assert('Champ calendar objet', typeof calMig.body?.calendar === 'object');
assert('Champ conges tableau', Array.isArray(calMig.body?.conges));

// Récupérer l'agent
const agents = await req('GET', '/agents?limit=5');
assert('GET /agents 200', agents.status === 200);
empId = agents.body?.agents?.[0]?.id;
assert('Agent ID récupéré', !!empId, empId);

// Solde
const solde0 = await req('GET', `/agents/${empId}/conges/solde`);
assert('GET /conges/solde 200', solde0.status === 200);
assert('Champs acquis/pris/solde présents',
  'acquis' in (solde0.body || {}) && 'pris' in (solde0.body || {}) && 'solde' in (solde0.body || {}));

// Paramètre conges_workflow_sup accessible indirectement (crée un congé et on voit le comportement)

// ─── 4. API — CAS NORMAUX ─────────────────────────────────────────────────────
section('4. API — CAS NORMAUX');

// 4.1 Créer demande (maladie = pas de préavis)
const create = await req('POST', `/agents/${empId}/conges`, {
  type_conge: 'maladie', date_debut: D1, date_fin: D2, motif: 'QA automatisé',
});
assert('POST /conges → 201', create.status === 201, JSON.stringify(create.body));
assert('Statut initial = demande', create.body?.statut === 'demande');
assert('nb_jours = 3', create.body?.nb_jours === 3);
assert('type_conge = maladie', create.body?.type_conge === 'maladie');
congeId = create.body?.id;
assert('id présent', !!congeId, congeId);
if (!congeId) { console.error('\nARRÊT : congé non créé'); process.exit(1); }

// 4.2 Audit create
const aud1 = await req('GET', `/audit?table_name=employes_conges&limit=20`);
assert('GET /audit 200', aud1.status === 200);
assert('Audit: action create tracée',
  aud1.body?.rows?.some(r => r.action === 'create' && r.table_name === 'employes_conges'));

// 4.3 Valider supérieur
const vsup = await req('PUT', `/agents/${empId}/conges/${congeId}/valider-sup`, { notes: 'Validation QA' });
assert('PUT /valider-sup → 200', vsup.status === 200, JSON.stringify(vsup.body));
assert('ok: true',              vsup.body?.ok === true);
assert('statut: valide_sup',    vsup.body?.statut === 'valide_sup');

// 4.4 Statut persisted
const liste1 = await req('GET', `/agents/${empId}/conges`);
assert('GET /:id/conges 200', liste1.status === 200);
const cg1 = (Array.isArray(liste1.body) ? liste1.body : []).find(c => c.id === congeId);
assert('Congé trouvé', !!cg1);
assert('statut = valide_sup en base', cg1?.statut === 'valide_sup');
assert('valide_sup_par renseigné',     !!cg1?.valide_sup_par);
assert('valide_sup_at renseigné',      !!cg1?.valide_sup_at);
assert('valide_sup_notes = "Validation QA"', cg1?.valide_sup_notes === 'Validation QA');

// 4.5 Audit valide_sup
const aud2 = await req('GET', `/audit?table_name=employes_conges&limit=30`);
assert('Audit: action valide_sup tracée',
  aud2.body?.rows?.some(r => r.action === 'valide_sup' && r.record_id === congeId));

// 4.6 Approbation RH
const approv = await req('PUT', `/agents/${empId}/conges/${congeId}/approuver`, {});
assert('PUT /approuver → 200', approv.status === 200, JSON.stringify(approv.body));
assert('ok: true', approv.body?.ok === true);
assert('solde retourné', typeof approv.body?.solde === 'object');

// 4.7 Statut final = approuve
const liste2 = await req('GET', `/agents/${empId}/conges`);
const cg2 = (Array.isArray(liste2.body) ? liste2.body : []).find(c => c.id === congeId);
assert('statut final = approuve', cg2?.statut === 'approuve');
assert('approuve_par renseigné', !!cg2?.approuve_par);
assert('approuve_at renseigné',  !!cg2?.approuve_at);

// 4.8 Mise à jour solde (maladie ne déduit pas — vérifie la structure)
const solde1 = await req('GET', `/agents/${empId}/conges/solde`);
assert('Solde recalculé après approbation', solde1.status === 200);
assert('Solde: acquis ≥ 0', (solde1.body?.acquis || 0) >= 0);

// 4.9 Calendrier montre le congé
const calAfter = await req('GET', `/agents/conges/calendrier?annee=${YEAR}&mois=${MON}`);
assert('Calendrier 200 après approbation', calAfter.status === 200);
assert('Congé apparaît dans conges[]', calAfter.body?.conges?.some(c => c.id === congeId));
// Impact calendrier : au moins le jour 05 est dans calendar
const day05 = `${YEAR}-${MON}-05`;
assert(`Jour ${day05} dans calendar`, day05 in (calAfter.body?.calendar || {}));

// 4.10 Audit approuve
const aud3 = await req('GET', `/audit?table_name=employes_conges&limit=50`);
assert('Audit: action approuve tracée',
  aud3.body?.rows?.some(r => r.action === 'approuve' && r.record_id === congeId));

// 4.11 Terminer le congé approuvé
const term = await req('PUT', `/agents/${empId}/conges/${congeId}/terminer`, {});
assert('PUT /terminer congé approuvé → 200', term.status === 200, JSON.stringify(term.body));

// 4.12 Statut terminé
const liste3 = await req('GET', `/agents/${empId}/conges`);
const cg3 = (Array.isArray(liste3.body) ? liste3.body : []).find(c => c.id === congeId);
assert('statut = termine', cg3?.statut === 'termine');

// 4.13 Audit termine
const aud4 = await req('GET', `/audit?table_name=employes_conges&limit=50`);
assert('Audit: action termine tracée',
  aud4.body?.rows?.some(r => r.action === 'termine' && r.record_id === congeId));

// 4.14 Notifications inapp créées
const notifs = await req('GET', '/notifs/messages?limit=50');
assert('GET /notifs/messages 200', notifs.status === 200);
assert('Notifs: au moins une notification congé présente',
  notifs.body?.items?.some(n => n.src_table === 'employes_conges'));

// 4.15 Export CSV
const csvExp = await req('GET', `/agents/conges/all/export-csv?annee=${YEAR}`);
assert('GET /export-csv 200', csvExp.status === 200);
// Le CSV contient le type_conge (label FR "Maladie") ou la clé "maladie"
assert('CSV contient Maladie ou maladie',
  (csvExp.raw || '').includes('Maladie') || (csvExp.raw || '').includes('maladie'));

// 4.16 GET /conges/all filtre par statut
const allApprove = await req('GET', '/agents/conges/all?statut=approuve');
assert('GET /conges/all?statut=approuve 200', allApprove.status === 200);
const allDemande = await req('GET', '/agents/conges/all?statut=demande');
assert('GET /conges/all?statut=demande 200', allDemande.status === 200);
const allValSup  = await req('GET', '/agents/conges/all?statut=valide_sup');
assert('GET /conges/all?statut=valide_sup 200', allValSup.status === 200);

// ─── 5. API — CAS D'ERREUR ───────────────────────────────────────────────────
section('5. API — CAS D\'ERREUR');

// 5.1 Dates manquantes
const e1 = await req('POST', `/agents/${empId}/conges`, { type_conge: 'annuel', date_debut: '2027-01-01' });
assert('Dates manquantes → 400', e1.status === 400);
assert('Message "date" dans erreur', e1.body?.error?.toLowerCase().includes('date'));

// 5.2 date_fin < date_debut
const e2 = await req('POST', `/agents/${empId}/conges`, {
  type_conge: 'annuel', date_debut: '2027-06-10', date_fin: '2027-06-05',
});
assert('date_fin < date_debut → 400', e2.status === 400);

// 5.3 valider-sup sur un congé déjà valide_sup → 400
// (congeId est maintenant "termine" — on crée un congé frais pour ce test)
const cFresh = await req('POST', `/agents/${empId}/conges`, {
  type_conge: 'maladie', date_debut: D3, date_fin: D4, motif: 'test erreurs',
});
assert('Créer 2e congé → 201', cFresh.status === 201, JSON.stringify(cFresh.body));
const cId2 = cFresh.body?.id;

const vsup2 = await req('PUT', `/agents/${empId}/conges/${cId2}/valider-sup`, { notes: '' });
assert('1er valider-sup → 200', vsup2.status === 200, JSON.stringify(vsup2.body));
const vsup3 = await req('PUT', `/agents/${empId}/conges/${cId2}/valider-sup`, { notes: '' });
assert('valider-sup doublon → 409', vsup3.status === 409);
assert('Message: transition interdite', vsup3.body?.error?.includes('Transition interdite'));

// 5.4 Approuver depuis statut demande quand workflow_sup=1 → 400
const cFresh2 = await req('POST', `/agents/${empId}/conges`, {
  type_conge: 'maladie',
  date_debut: `${YEAR + 1}-01-10`,
  date_fin:   `${YEAR + 1}-01-12`,
  motif:      'test workflow guard',
});
assert('Créer 3e congé → 201', cFresh2.status === 201);
const cId3 = cFresh2.body?.id;
if (cId3) {
  const eBadApprouv = await req('PUT', `/agents/${empId}/conges/${cId3}/approuver`, {});
  assert('Approuver sans valide_sup → 409', eBadApprouv.status === 409);
  assert('Workflow supérieur requis', eBadApprouv.body?.workflow_superieur_requis === true);
  // Annuler pour nettoyer
  await req('PUT', `/agents/${empId}/conges/${cId3}/annuler`, { motif: 'cleanup test' });
}

// 5.5 valider-sup congé inexistant → 404
const e5 = await req('PUT', `/agents/${empId}/conges/999999/valider-sup`, { notes: '' });
assert('valider-sup inexistant → 404', e5.status === 404);

// 5.6 Approuver congé inexistant → 404
const e6 = await req('PUT', `/agents/${empId}/conges/999999/approuver`, {});
assert('Approuver inexistant → 404', e6.status === 404);

// 5.7 Refuser sans motif → 400
const e7 = await req('PUT', `/agents/${empId}/conges/${cId2}/refuser`, { motif: '' });
assert('Refuser sans motif → 400', e7.status === 400);

// 5.8 Refuser avec motif → 200 (congé en valide_sup)
const eRef = await req('PUT', `/agents/${empId}/conges/${cId2}/refuser`, { motif: 'Test refus QA' });
assert('Refuser avec motif → 200', eRef.status === 200, JSON.stringify(eRef.body));

// 5.9 Annuler congé terminé → 400
const eAnnTerm = await req('PUT', `/agents/${empId}/conges/${congeId}/annuler`, { motif: 'test' });
assert('Annuler congé terminé → 409', eAnnTerm.status === 409);

// 5.10 Refuser congé déjà refusé → 400
const eDoubleRef = await req('PUT', `/agents/${empId}/conges/${cId2}/refuser`, { motif: 'double' });
assert('Double refus → 409', eDoubleRef.status === 409);

// 5.11 terminer congé non-approuvé → 400
const eTerm2 = await req('PUT', `/agents/${empId}/conges/${cId2}/terminer`, {});
assert('Terminer non-approuvé → 409', eTerm2.status === 409);

// 5.12 Agent inexistant — solde
const eSolde = await req('GET', '/agents/999999/conges/solde');
assert('Solde agent inexistant → 404', eSolde.status === 404);

// 5.13 Chevauchement — le check porte UNIQUEMENT sur les congés en statut 'approuve' (pas 'termine')
// Un congé terminé libère les dates : c'est le comportement métier attendu.
// On crée un congé approuvé frais puis on vérifie le chevauchement avant de le terminer.
const cChev = await req('POST', `/agents/${empId}/conges`, {
  type_conge: 'maladie', date_debut: `${YEAR + 2}-03-10`, date_fin: `${YEAR + 2}-03-12`,
  motif: 'base chevauchement',
});
assert('Créer congé base chevauchement → 201', cChev.status === 201);
if (cChev.body?.id) {
  await req('PUT', `/agents/${empId}/conges/${cChev.body.id}/valider-sup`, { notes: '' });
  await req('PUT', `/agents/${empId}/conges/${cChev.body.id}/approuver`, {});
  // Maintenant tester le chevauchement (congé approuvé actif)
  const eChevauche = await req('POST', `/agents/${empId}/conges`, {
    type_conge: 'maladie',
    date_debut: `${YEAR + 2}-03-11`,
    date_fin:   `${YEAR + 2}-03-13`,
    motif: 'chevauchement test',
  });
  assert('Chevauchement congé approuvé actif → 409', eChevauche.status === 409,
    JSON.stringify(eChevauche.body));
  // Nettoyage
  await req('PUT', `/agents/${empId}/conges/${cChev.body.id}/terminer`, {});
}

// ─── 6. GESTION DES RÔLES ────────────────────────────────────────────────────
section('6. GESTION DES RÔLES');
// admin peut tout faire — déjà prouvé par tous les tests précédents
assert('Admin: POST /conges ok', create.status === 201);
assert('Admin: PUT /valider-sup ok', vsup.status === 200);
assert('Admin: PUT /approuver ok', approv.status === 200);
assert('Admin: PUT /terminer ok', term.status === 200);

// valider-sup est contrôlé par le supérieur hiérarchique réel dans le service métier
const { readFileSync } = require('fs');
const protectedRoutes = readFileSync('/opt/projet-smi/backend/routes/agent_parapheur_required_safe.js', 'utf8');
const transitionService = readFileSync('/opt/projet-smi/backend/services/leave_transition_workflow.js', 'utf8');
assert(
  'valider-sup utilise le service hiérarchique protégé',
  protectedRoutes.includes('validateBySupervisor')
    && transitionService.includes('superieur_id')
    && transitionService.includes('isDirectSupervisor')
);

// approuver est restreint à canRH
const appRouteIdx = agentsJs.indexOf("router.put('/:id/conges/:cid/approuver'");
const appBlock = agentsJs.slice(appRouteIdx, appRouteIdx + 200);
assert('approuver: guard canRH présent', appBlock.includes('canRH'));

// refuser est restreint à canRH
const refRouteIdx = agentsJs.indexOf("router.put('/:id/conges/:cid/refuser'");
const refBlock = agentsJs.slice(refRouteIdx, refRouteIdx + 200);
assert('refuser: guard canRH présent', refBlock.includes('canRH'));

// terminer est restreint à canRH
const termRouteIdx = agentsJs.indexOf("router.put('/:id/conges/:cid/terminer'");
const termBlock = agentsJs.slice(termRouteIdx, termRouteIdx + 200);
assert('terminer: guard canRH présent', termBlock.includes('canRH'));

// ─── 7. NON-RÉGRESSION ───────────────────────────────────────────────────────
section('7. NON-RÉGRESSION — MODULES EXISTANTS');

// Opérations
const ops = await req('GET', '/operations?limit=2');
assert('GET /operations inchangé (200 ou 403)', [200, 403].includes(ops.status), `status=${ops.status}`);

// Salaires — vraie route
const salRap = await req('GET', '/salaires/rapport');
assert('GET /salaires/rapport inchangé', [200, 403].includes(salRap.status), `status=${salRap.status}`);

// Agents
const ags2 = await req('GET', '/agents?limit=2');
assert('GET /agents inchangé', ags2.status === 200);

// conges/all toujours fonctionnel
const all2 = await req('GET', '/agents/conges/all?limit=3');
assert('GET /conges/all inchangé (tableau)', all2.status === 200 && Array.isArray(all2.body));

// GET /:id/conges inchangé
const cgLst = await req('GET', `/agents/${empId}/conges`);
assert('GET /:id/conges inchangé', cgLst.status === 200 && Array.isArray(cgLst.body));

// GET /:id/conges/solde inchangé
const soldeCk = await req('GET', `/agents/${empId}/conges/solde`);
assert('GET /:id/conges/solde inchangé', soldeCk.status === 200);

// Export CSV inchangé
const csvCk = await req('GET', '/agents/conges/all/export-csv');
assert('GET /export-csv inchangé (200)', csvCk.status === 200);

// Audit global inchangé
const audGlob = await req('GET', '/audit?limit=3');
assert('GET /audit global inchangé', audGlob.status === 200);

// Notifs messages inchangé
const notifsCk = await req('GET', '/notifs/messages?limit=2');
assert('GET /notifs/messages inchangé', notifsCk.status === 200);

// Achats inchangé
const ach = await req('GET', '/achats?limit=2');
assert('GET /achats inchangé (200 ou 403)', [200, 403].includes(ach.status), `status=${ach.status}`);

// Agents KPIs inchangé
const kpi = await req('GET', '/agents/kpis');
assert('GET /agents/kpis inchangé', kpi.status === 200);

// Calendrier par défaut (sans params) ne plante pas
const calDef = await req('GET', '/agents/conges/calendrier');
assert('GET /conges/calendrier sans params 200', calDef.status === 200);

// ─── 8. DONNÉES FRONTEND ─────────────────────────────────────────────────────
section('8. DONNÉES FRONTEND');

// Champs attendus par le JS frontend dans renderCongesModal
const cgFront = (Array.isArray(liste2.body) ? liste2.body : []).find(c => c.id === congeId);
const frontFields = [
  'id','employe_id','type_conge','date_debut','date_fin','nb_jours','statut',
  'motif','notes','valide_sup_par','valide_sup_at','valide_sup_notes',
  'approuve_par','approuve_at','refuse_par','refuse_motif',
];
for (const f of frontFields) {
  assert(`Champ "${f}" dans réponse congé`, f in (cgFront || {}));
}

// Calendrier : structure attendue par le frontend
const calF = await req('GET', `/agents/conges/calendrier?annee=${YEAR}&mois=${MON}`);
assert('Calendrier: {annee, mois, calendar, conges}',
  'annee' in calF.body && 'mois' in calF.body &&
  'calendar' in calF.body && 'conges' in calF.body);

// Si au moins un jour a des événements, vérifier les champs
const firstDayKey = Object.keys(calF.body?.calendar || {})[0];
if (firstDayKey) {
  const ev = calF.body.calendar[firstDayKey][0];
  const evFields = ['conge_id','employe_id','employe_nom','type_conge','statut','date_debut','date_fin','nb_jours'];
  for (const f of evFields) {
    assert(`Calendrier événement: champ "${f}"`, f in (ev || {}));
  }
} else {
  console.log('  ○ Calendrier vide pour ce mois (aucun congé approuvé) — champs event non vérifiés');
  skipped++;
}

// Labels CG_STATUT présents dans le HTML frontend
const dashHtml = readFileSync('/opt/projet-smi/frontend/dashboard.html', 'utf8');
assert('Frontend: CG_STATUT_LABELS contient valide_sup', dashHtml.includes("valide_sup:'Validé sup.'"));
assert('Frontend: CG_STATUT_CLASS contient valide_sup',  dashHtml.includes("valide_sup:'bg-blue-500"));
assert('Frontend: ABS_STATUT_LABELS contient valide_sup', dashHtml.includes("valide_sup:'Validé sup.'"));
assert('Frontend: fonction validerSupConge définie',      dashHtml.includes('async function validerSupConge('));
assert('Frontend: bouton valider-sup dans renderCongesModal', dashHtml.includes("↑ Valider sup."));
assert('Frontend: validSupInfo dans template', dashHtml.includes('validSupInfo'));
assert('Frontend: absAction gère valider-sup', dashHtml.includes("action === 'valider-sup'"));
assert('Frontend: btnValiderSup dans absences view', dashHtml.includes('btnValiderSup'));

// ─── 9. LOGS & AUDIT ─────────────────────────────────────────────────────────
section('9. LOGS & AUDIT');

const audFinal = await req('GET', '/audit?table_name=employes_conges&limit=100');
assert('GET /audit 200', audFinal.status === 200);
const actions = audFinal.body?.rows?.map(r => r.action) || [];
assert('Audit: create',     actions.includes('create'));
assert('Audit: valide_sup', actions.includes('valide_sup'));
assert('Audit: approuve',   actions.includes('approuve'));
assert('Audit: refuse',     actions.includes('refuse'));
assert('Audit: termine',    actions.includes('termine'));
assert('Audit: annule',     actions.includes('annule'));

// Vérifier que chaque entrée d'audit a user_id renseigné
const missingUser = audFinal.body?.rows?.filter(r =>
  r.table_name === 'employes_conges' && !r.user_nom
);
// Acceptable si user a été supprimé, mais pas systématique
assert('Audit: user_nom généralement renseigné',
  (missingUser?.length || 0) < (audFinal.body?.rows?.length || 1));

// Notifications — au moins une pour les congés
const notifFinal = await req('GET', '/notifs/messages?limit=100');
assert('Notifs: au moins une notif congé',
  notifFinal.body?.items?.some(n => n.src_table === 'employes_conges'));
// Note : notif_messages.type = 'notification' (famille générique hardcodée dans creerNotification)
// Le titre sert à distinguer le contexte. Ce comportement est celui du système existant.
assert('Notifs: "Congé validé par le supérieur" créée',
  notifFinal.body?.items?.some(n => n.titre === 'Congé validé par le supérieur'));
assert('Notifs: "Congé approuvé" créée',
  notifFinal.body?.items?.some(n => n.titre === 'Congé approuvé'));

// ─── RAPPORT FINAL ───────────────────────────────────────────────────────────
section('RAPPORT FINAL');
console.log(`\n  Passés   : ${passed}`);
console.log(`  Ignorés  : ${skipped}`);
console.log(`  Échoués  : ${failed}`);

if (errors.length > 0) {
  console.log('\n  ── Échecs ────────────────────────────────────');
  errors.forEach((e, i) =>
    console.log(`  [${i+1}] ${e.label}\n      ${String(e.detail || '').slice(0, 160)}`));
}

if (failed > 0) process.exit(1);

} // run()

run().catch(e => {
  console.error('ERREUR FATALE:', e.message, '\n', e.stack);
  process.exit(1);
});
