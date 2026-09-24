'use strict';
/*
 * Garde — creer un decaissement doit laisser une trace.
 *
 * Mesure du 18/09/2026 en production : les operations 13 (514 075 XAF,
 * 13:28:53) et 14 (416 000 XAF, 13:32:35), toutes deux creees par user_id=2,
 * n'ont laisse aucune ligne dans audit_logs. Le dernier evenement d'audit de
 * la journee est de 13:23:56, soit cinq minutes avant la premiere des deux.
 *
 * Le workflow trace la soumission, la validation, le paiement et l'annulation
 * (dec_soumis, dec_valide, dec_paye, dec_annule) mais pas la naissance de
 * l'engagement : 930 075 XAF engages, et rien qui le dise. Le moteur canonique
 * ecrit pourtant bien finance_operation_created a la creation
 * (backend/services/finance-operation-canonical.js). Le trou est dans le
 * chemin historique — POST / de backend/routes/operations.js — qui reprend la
 * main des que la position n'est pas ledger_status='ready'.
 *
 * Ce qui est garde : la creation ecrit une ligne d'audit rattachee a
 * l'operation, sous le meme nom d'action que le moteur canonique, et cette
 * ligne ne porte que le montant, le libelle, le type et la position.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const racine = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(racine, 'backend/routes/operations.js'), 'utf8');

const CLES_AUTORISEES = [
  'type_op', 'montant', 'libelle', 'position_id', 'position_source_id', 'ledger_mode',
];

/* ── Banc : on charge le routeur reel avec des dependances muettes ────────── */
function chargerRoutes({ base }) {
  const routes = [];
  const fauxRouteur = {};
  const enregistrer = methode => (chemin, ...handlers) => {
    routes.push({ methode, chemin, handlers });
    return fauxRouteur;
  };
  ['get', 'post', 'put', 'delete'].forEach(m => { fauxRouteur[m] = enregistrer(m); });
  fauxRouteur.use = () => fauxRouteur;

  const vrai = nom => require(path.join(racine, 'backend/services', nom));
  const muet = () => {};
  const modules = {
    express: { Router: () => fauxRouteur },
    '../db': base,
    '../services/email': { sendMail: async () => {} },
    './auth': { hasRole: () => true },
    '../services/ecrans-de-direction': { rolesAdmisSurLEcran: () => true },
    '../services/notif': {
      creerNotification: muet, declencherAlerte: muet,
      resoudreAlerte: muet, evaluerAlerteSoldes: muet,
    },
    '../services/permissions': { can: async () => true },
    /* Ce banc ne joue ni virement ni controle de solde : la valeur rendue ici
       n'entre dans aucune de ses assertions. Le solde est mesure ailleurs, par
       scripts/test_rapprochement_virement_isolated.js. */
    '../services/solde-position': { soldePosition: async () => 0 },
    /* Ce banc mesure la trace d'audit, pas les clotures : « aucun verrou »
       laisse le chemin ouvert. La regle de cloture est mesuree par
       scripts/test_cloture_verrou_isolated.js, sur MySQL reel. */
    /* Ce banc ne mesure pas le perimetre des caisses : on le declare ouvert,
       comme il l'etait pour ce compte avant l'extraction de la regle. La regle
       est mesuree par scripts/test_perimetre_caisse_isolated.js, sur MySQL reel. */
    /* Ce banc ne valide aucun décaissement : les approbations y sont inertes.
       La règle des deux approbations est mesurée par
       scripts/test_double_approbation_isolated.js, sur MySQL réel. */
    '../services/approbations': {
      capaciteDe: async () => 'finance',
      approbationsDe: async () => [],
      enregistrerApprobation: async () => ({ ok: true }),
      evaluer: () => ({ suffisantes: true, acteurs: 1, porteDG: false }),
      niveauPourMontant: async () => 'finance',
      aDejaApprouve: () => false,
    },
    '../services/perimetre-caisse': {
      estGlobal: () => true,
      estSoumisAAffectation: () => false,
    },
    '../services/cloture-garde': {
      verrouDeCloture: async () => null,
      verrouPourOperation: async () => null,
    },
    '../services/decaissement-file': {
      criteresFileActionnable: () => ({ where: '1=1', params: [] }),
      criteresFileComplete: () => ({ where: '1=1', params: [] }),
    },
    '../services/parapheur': { creerEntreeParapheur: muet },
    '../services/accounting': { attemptAutomaticAccountingForOperation: async () => ({}) },
    '../services/finance-operations': { buildOperationView: op => op },
    '../services/reference-externe': vrai('reference-externe.js'),
    xlsx: {},
    multer: Object.assign(() => ({ single: () => muet }), { memoryStorage: () => ({}) }),
  };
  const faireRequire = nom => {
    if (nom in modules) return modules[nom];
    throw new Error(`require inattendu dans operations.js : ${nom}`);
  };
  const module_ = { exports: {} };
  new Function('require', 'module', 'exports', '__dirname', source)(
    faireRequire, module_, module_.exports, path.join(racine, 'backend/routes'));
  return routes;
}

function baseSimulee() {
  const ecritures = [];
  let derniereOperation = null;
  const base = {
    ecritures,
    async query(sql) {
      if (/information_schema|PRAGMA/i.test(sql)) return [];
      return [];
    },
    async queryOne(sql) {
      if (/FROM periodes_cloturees/i.test(sql)) return null;
      if (/FROM alertes_actives/i.test(sql)) return null;
      if (/FROM sync_errors/i.test(sql)) return { id: 99 };
      if (/FROM accounting_entries/i.test(sql)) return null;
      if (/FROM positions/i.test(sql)) return { id: 1, code: 'CAI', libelle: 'Caisse principale', type: 'caisse', actif: 1 };
      if (/FROM operations o/i.test(sql)) return derniereOperation;
      return null;
    },
    async execute(sql, params = []) {
      ecritures.push({ sql, params });
      if (/^\s*INSERT INTO operations/i.test(sql)) {
        const colonnes = sql.match(/INSERT INTO operations \(([^)]*)\)/)[1].split(',');
        derniereOperation = { id: 13, solde_position: 0 };
        colonnes.forEach((colonne, i) => { derniereOperation[colonne.trim()] = params[i]; });
        return { insertId: 13, affectedRows: 1 };
      }
      return { insertId: 1, affectedRows: 1 };
    },
    async transaction(fn) { return fn(base); },
  };
  return base;
}

function fausseReponse() {
  return {
    code: 200,
    status(code) { this.code = code; return this; },
    json(charge) { this.charge = charge; return this; },
  };
}

function lignesDAudit(base) {
  return base.ecritures
    .filter(e => /INSERT INTO audit_logs/i.test(e.sql))
    .map(e => ({ table: e.params[0], recordId: e.params[1], action: e.params[2], details: e.params[3], userId: e.params[4] }));
}

/* ── Le decaissement 13 rejoue sur le banc ────────────────────────────────── */
(async () => {
  const base = baseSimulee();
  const routes = chargerRoutes({ base });
  const creation = routes.find(r => r.methode === 'post' && r.chemin === '/');
  assert.ok(creation, 'POST / doit exister sur le routeur des operations');

  const req = {
    user: { id: 2, nom: 'Caissier', email: 'caisse@example.test' },
    body: {
      date: '2026-09-18',
      libelle: 'Approvisionnement chantier',
      tiers: 'Fournisseur',
      montant: 514075,
      type_op: 'decaissement',
      position_id: 1,
      categorie_id: 3,
      mode_reglement: 'especes',
      piece_justificative: '/uploads/facture-secrete.pdf',
    },
  };
  const res = fausseReponse();
  await creation.handlers[creation.handlers.length - 1](req, res, () => {});

  assert.strictEqual(res.code, 201, 'Le decaissement doit bien etre enregistre par ce chemin');

  const audits = lignesDAudit(base);
  assert.ok(audits.length > 0,
    'Un decaissement engage de l argent : sa creation doit laisser une trace, '
    + 'sinon le journal ne sait dire que ce qui est arrive apres coup');

  const trace = audits.find(a => Number(a.recordId) === 13);
  assert.ok(trace, 'La trace doit designer l operation creee, pas une autre');
  assert.strictEqual(trace.table, 'operations');
  assert.strictEqual(Number(trace.userId), 2, 'La trace doit nommer qui a engage la depense');
  assert.strictEqual(trace.action, 'finance_operation_created',
    'Le moteur canonique nomme deja cet evenement : deux vocabulaires pour le '
    + 'meme fait rendent le journal illisible selon le moteur qui a servi');

  const details = JSON.parse(trace.details);
  assert.strictEqual(Number(details.montant), 514075, 'La trace doit dire le montant engage');
  assert.strictEqual(details.libelle, 'Approvisionnement chantier', 'La trace doit dire a quoi');
  assert.strictEqual(details.type_op, 'decaissement', 'La trace doit dire le sens du mouvement');
  assert.strictEqual(Number(details.position_id), 1, 'La trace doit dire quelle caisse est engagee');

  const surplus = Object.keys(details).filter(c => !CLES_AUTORISEES.includes(c));
  assert.deepStrictEqual(surplus, [],
    'Le journal d audit n est pas une copie de la saisie : il ne recopie ni la '
    + `piece jointe ni le reste du formulaire (surplus : ${surplus.join(', ')})`);

  /* ── Le meme trou existait pour l encaissement ──────────────────────────── */
  const base2 = baseSimulee();
  const routes2 = chargerRoutes({ base: base2 });
  const creation2 = routes2.find(r => r.methode === 'post' && r.chemin === '/');
  const res2 = fausseReponse();
  await creation2.handlers[creation2.handlers.length - 1]({
    user: { id: 2, nom: 'Caissier' },
    body: {
      date: '2026-09-18', libelle: 'Recette guichet', tiers: 'Client',
      montant: 416000, type_op: 'encaissement', position_id: 1,
      categorie_id: 4, mode_reglement: 'especes',
    },
  }, res2, () => {});
  assert.strictEqual(res2.code, 201);
  assert.ok(lignesDAudit(base2).some(a => a.action === 'finance_operation_created'),
    'Un encaissement entre en caisse immediatement : sa creation doit se tracer '
    + 'au moins autant qu un decaissement encore en brouillon');

  assert.ok(!/INSERT INTO audit_logs/.test(
    (source.match(/router\.post\('\/',[\s\S]*?\n\}\);/) || [''])[0]),
    'La trace doit passer par la fonction d audit existante, pas par un INSERT '
    + 'recopie une fois de plus dans le fichier');

  console.log('OK - la creation d une operation laisse une trace d audit');
})().catch(err => { console.error(err.message); process.exit(1); });
