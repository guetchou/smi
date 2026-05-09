/**
 * Smoke tests — Workflow congés (demande → valide_sup → approuve)
 * Usage: node tests/conges_smoke.js
 */
const http = require('http');

const BASE = 'http://localhost:3337/api';
let token = '';
let empId = null;
let congeId = null;
let passed = 0;
let failed = 0;

function req(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      method,
      hostname: 'localhost',
      port: 3337,
      path: `/api${path}`,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        ...headers,
      },
    };
    const r = http.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

function assert(label, cond, detail = '') {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ': ' + detail : ''}`);
    failed++;
  }
}

async function run() {
  console.log('=== Smoke tests — Workflow congés ===\n');

  // 0. Health
  console.log('[ 0 ] Health check');
  const h = await req('GET', '/health');
  assert('server online', h.status === 200 && h.body.status === 'ok');

  // 1. Captcha + Login
  console.log('\n[ 1 ] Authentification');
  const cap = await req('GET', '/auth/captcha');
  assert('captcha OK', cap.status === 200 && cap.body.id);
  const q = cap.body.question; // "A op B = ?"
  const parts = q.replace(' = ?', '').split(' ');
  const a = parseInt(parts[0]), op = parts[1], b = parseInt(parts[2]);
  const ans = op === '+' ? a + b : op === '-' ? a - b : a * b;

  const login = await req('POST', '/auth/login', {
    email: 'admin@topcenter.cg',
    password: 'Admin@2025!',
    captchaId: cap.body.id,
    captchaAnswer: ans,
  });
  assert('login 200', login.status === 200, JSON.stringify(login.body));
  assert('token présent', !!login.body.token);
  token = login.body.token;

  // 2. Liste agents
  console.log('\n[ 2 ] Liste agents');
  const agents = await req('GET', '/agents?limit=5');
  assert('GET /agents 200', agents.status === 200);
  assert('agents présents', agents.body.agents?.length > 0);
  empId = agents.body.agents[0].id;
  console.log(`    → Agent ID utilisé : ${empId}`);

  // 3. Solde congés
  console.log('\n[ 3 ] Solde congés');
  const solde = await req('GET', `/agents/${empId}/conges/solde`);
  assert('GET /conges/solde 200', solde.status === 200);
  assert('solde structure OK', 'solde' in solde.body || 'acquis' in solde.body, JSON.stringify(solde.body));

  // 4. Calendrier
  console.log('\n[ 4 ] Calendrier congés');
  const cal = await req('GET', '/agents/conges/calendrier?annee=2026&mois=6');
  assert('GET /conges/calendrier 200', cal.status === 200, JSON.stringify(cal.body).slice(0,100));
  assert('structure calendrier', cal.body.annee === 2026 && cal.body.mois === 6);

  // 5. Créer demande congé (maladie — pas de préavis)
  console.log('\n[ 5 ] Créer demande congé (maladie)');
  // Dates dans le futur lointain + offset unique par run (ms) pour éviter les chevauchements
  const runId = Date.now() % 1000;
  const year  = 2030 + Math.floor(runId / 100);
  const month = String((runId % 10) + 1).padStart(2, '0');
  const dateDebut = `${year}-${month}-05`;
  const dateFin   = `${year}-${month}-07`;
  const create = await req('POST', `/agents/${empId}/conges`, {
    type_conge: 'maladie',
    date_debut: dateDebut,
    date_fin:   dateFin,
    motif:      'Smoke test workflow',
  });
  assert('POST /conges 201', create.status === 201, JSON.stringify(create.body));
  assert('statut = demande', create.body.statut === 'demande');
  congeId = create.body.id;
  console.log(`    → Congé ID : ${congeId}`);

  if (!congeId) { console.error('\nArrêt : pas de congé créé'); return; }

  // 6. Valider supérieur
  console.log('\n[ 6 ] Validation supérieur hiérarchique');
  const vsup = await req('PUT', `/agents/${empId}/conges/${congeId}/valider-sup`, { notes: 'OK sup test' });
  assert('PUT /valider-sup 200', vsup.status === 200, JSON.stringify(vsup.body));
  assert('statut = valide_sup', vsup.body.statut === 'valide_sup');

  // 7. Vérifier statut dans liste
  console.log('\n[ 7 ] Vérification statut dans liste congés');
  const liste = await req('GET', `/agents/${empId}/conges`);
  assert('GET /:id/conges 200', liste.status === 200);
  const cg = Array.isArray(liste.body) ? liste.body.find(c => c.id === congeId) : null;
  assert('congé trouvé', !!cg);
  assert('statut valide_sup confirmé', cg?.statut === 'valide_sup', JSON.stringify(cg));

  // 8. Approbation RH
  console.log('\n[ 8 ] Approbation RH');
  const approuv = await req('PUT', `/agents/${empId}/conges/${congeId}/approuver`, {});
  assert('PUT /approuver 200', approuv.status === 200, JSON.stringify(approuv.body));
  assert('solde retourné', approuv.body.solde !== undefined);

  // 9. Vérification statut final + audit
  console.log('\n[ 9 ] Vérification statut final');
  const liste2 = await req('GET', `/agents/${empId}/conges`);
  const cg2 = Array.isArray(liste2.body) ? liste2.body.find(c => c.id === congeId) : null;
  assert('statut = approuve', cg2?.statut === 'approuve', JSON.stringify(cg2));

  // 10. Export CSV
  console.log('\n[ 10 ] Export CSV absences');
  const csv = await req('GET', '/agents/conges/all/export-csv?annee=2026');
  assert('CSV 200', csv.status === 200);

  console.log(`\n${'─'.repeat(40)}`);
  console.log(`Résultat : ${passed} passés, ${failed} échoués`);
  if (failed > 0) process.exit(1);
}

run().catch(e => { console.error('ERREUR FATALE:', e.message); process.exit(1); });
