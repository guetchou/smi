'use strict';
/*
 * Garde — écrans de comptabilité générale C1 à C3 (maquettes validées le
 * 29/09/2026, ADR 0002).
 *
 * Exécute les fonctions de rendu du module tel qu'il est servi, sur les
 * écritures réelles du bac à sable du 29/09, et vérifie ce qu'un comptable
 * lirait : aucun nom de logiciel, des noms échappés, les pièces regroupées,
 * leur origine, l'alerte de retard, la balance par classe et son compte
 * d'attente. Vérifie aussi que la page actuelle reste en place tant que la
 * connexion n'est pas configurée.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const racine = path.join(__dirname, '..', 'frontend');
const source = fs.readFileSync(path.join(racine, 'js', 'pages', 'comptabilite-generale.js'), 'utf8');
const html = fs.readFileSync(path.join(racine, 'dashboard.html'), 'utf8');

const bac = { window: {}, document: {}, Intl, Date, URL, Blob: function () {}, Map, Number, String };
vm.createContext(bac);
vm.runInContext(source, bac);
const R = bac.window.TalaComptabiliteGenerale._rendre;
const texte = h => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/[\u202f\u00a0]/g, ' ').replace(/\s+/g, ' ');

const L = (date, journal, piece, reference, compte, libelle, debit, credit) => ({ date, journal, piece, reference, compte, libelle_compte: libelle, libelle, debit, credit });
const LIGNES = [
  L('2026-01-13', 'VT', 1, 'IN2601-0001', '411', 'Client comptant', 1200000, 0),
  L('2026-01-13', 'VT', 1, 'IN2601-0001', '706', 'Services vendus', 0, 1200000),
  L('2026-01-13', 'BQ', 2, 'Paiement client', '5711', 'Caisse principale', 1200000, 0),
  L('2026-01-13', 'BQ', 2, 'Paiement client', '411', 'Client comptant', 0, 1200000),
  L('2026-02-05', 'BQ', 3, 'Retrait banque', '585', 'Virements de fonds', 600000, 0),
  L('2026-02-05', 'BQ', 3, 'Retrait banque', '5211', 'Banque BCH', 0, 600000),
  L('2026-02-10', 'BQ', 4, 'Paiement fournisseur', '401', 'Fournisseur', 50000, 0),
  L('2026-02-10', 'BQ', 4, 'Paiement fournisseur', '5711', 'Caisse principale', 0, 50000),
  L('2026-03-31', 'OD', 5, 'SMI-PAIE-2026-03', '6611', 'Salaires <b>bruts</b> mars', 180000, 0),
  L('2026-03-31', 'OD', 5, 'SMI-PAIE-2026-03', '422', 'Net a payer mars', 0, 180000),
];
const PASSAGE = { horodatage: '2026-09-29T14:05:01+00:00', statut: 'ok', ecritures_ajoutees: 4, en_retard: false };
const CONTROLES = {
  equilibre: { debit: 3230000, credit: 3230000, ok: true },
  exercices: [{ libelle: '2026', debut: '2026-01-01', fin: '2026-12-31' }],
  attente: { compte: '471', montant: 1200000, lignes: 1 },
  dernieres: LIGNES.slice().reverse(),
};

let vertes = 0;
let echecs = 0;
function verifier(nom, fn) {
  try { fn(); console.log('  ok   ' + nom); vertes++; }
  catch (e) { console.log('  ECHEC ' + nom + '\n        ' + e.message); echecs++; }
}

verifier('aucun écran ne nomme le logiciel comptable', () => {
  const tout = R.cockpit(PASSAGE, CONTROLES) + R.journal({ du: '2026-01-01', au: '2026-03-31', journal: '', compte: '' }, { lignes: LIGNES, total_debit: 3230000, total_credit: 3230000 })
    + R.balance({ du: '2026-01-01', au: '2026-03-31', comptes: [], total_debit: 0, total_credit: 0 });
  assert.ok(!/dolibarr/i.test(tout + source.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '')), 'le mot Dolibarr apparaît dans un écran ou hors commentaire');
});

verifier('les libellés sont échappés', () => {
  const h = R.journal({ du: '', au: '', journal: '', compte: '' }, { lignes: LIGNES, total_debit: 0, total_credit: 0 });
  assert.ok(h.includes('Salaires &lt;b&gt;bruts&lt;/b&gt; mars') && !h.includes('<b>bruts</b>'));
});

verifier('le cockpit dit « À jour » et le dernier passage', () => {
  const t = texte(R.cockpit(PASSAGE, CONTROLES));
  assert.ok(t.includes('Passage au grand livre · À jour'), t.slice(0, 200));
  assert.ok(/Dernier passage \d\d:\d\d · 4 écritures ajoutées · ventes, achats, banque/.test(t));
  assert.ok(t.includes('Toutes les 5 min') && t.includes('Débit = Crédit') && t.includes('ouverte'));
});

verifier('un passage en retard ou en erreur passe le bandeau en alerte', () => {
  for (const p of [{ ...PASSAGE, en_retard: true }, { ...PASSAGE, statut: 'erreur' }, null]) {
    const h = R.cockpit(p, CONTROLES);
    assert.ok(h.includes('cg-alerte') && texte(h).includes('Passage au grand livre · En retard'));
  }
});

verifier('le compte d attente non soldé est signalé, soldé il ne l est pas', () => {
  const avec = R.cockpit(PASSAGE, CONTROLES);
  assert.ok(texte(avec).includes("Compte d'attente à régulariser 1 200 000 471 · 1 ligne"), texte(avec));
  const sans = R.cockpit(PASSAGE, { ...CONTROLES, attente: { compte: '471', montant: 0, lignes: 0 } });
  assert.ok(!/cg-carte cg-carte-alerte"><span class="cg-etiq">Compte d'attente/.test(sans));
});

verifier('les dernières écritures regroupent une pièce en une ligne, avec son origine', () => {
  // Tableau né dans le bac à sable vm : autre prototype, on compare sa forme JSON.
  const pieces = JSON.parse(JSON.stringify(R.pieces(LIGNES)));
  assert.strictEqual(pieces.length, 5);
  assert.deepStrictEqual(pieces.map(p => p.source), ['Factures clients', 'Encaissements', 'Virements internes', 'Décaissements', 'Salaires']);
  assert.strictEqual(pieces[0].montant, 1200000);
});

verifier('le journal : filtres, journaux, total, compte d attente en rouge', () => {
  const h = R.journal({ du: '2026-01-01', au: '2026-03-31', journal: 'BQ', compte: '57' }, { lignes: [...LIGNES, L('2026-01-13', 'BQ', 9, 'Ligne sans piece', '471', 'Compte d attente', 0, 1200000)], total_debit: 3230000, total_credit: 4430000 });
  const t = texte(h);
  for (const l of ['Du', 'Au', 'Journal', 'Compte', 'Filtrer', 'Tous', 'VT · Ventes', 'AC · Achats', 'BQ · Banque', 'OD · Opérations diverses', '11 lignes', 'Total']) assert.ok(t.includes(l), 'absent : ' + l);
  assert.ok(/<option value="BQ" selected>/.test(h), 'le journal choisi reste sélectionné');
  assert.ok(/cg-rouge">471</.test(h));
});

verifier('la balance : classes validées, solde et sens, ligne 471 en alerte, écart nul en vert', () => {
  const comptes = [
    { compte: '411', libelle: 'Clients', classe: '4', debit: 1275000, credit: 1275000, solde: 0, sens: '' },
    { compte: '471', libelle: 'Comptes d attente', classe: '4', debit: 0, credit: 1200000, solde: 1200000, sens: 'C' },
    { compte: '5711', libelle: 'Caisse', classe: '5', debit: 3075000, credit: 200000, solde: 2875000, sens: 'D' },
    { compte: '101', libelle: 'Capital', classe: '1', debit: 0, credit: 10, solde: 10, sens: 'C' },
  ];
  const h = R.balance({ du: '2026-01-01', au: '2026-03-31', comptes, total_debit: 100, total_credit: 100 });
  const t = texte(h);
  assert.ok(t.includes('Balance · 01/01/2026 → 31/03/2026') && t.includes('Export CSV'));
  assert.ok(t.includes('Classe 4 — Tiers') && t.includes('Classe 5 — Trésorerie') && t.includes('Classe 1'));
  assert.ok(t.indexOf('Classe 1') < t.indexOf('Classe 4'), 'les classes suivent l ordre du plan');
  assert.ok(t.includes('2 875 000 D') && t.includes('1 200 000 C'));
  assert.ok(/cg-ligne-alerte"><td class="cg-code cg-fort">471/.test(h));
  assert.ok(/cg-d cg-vert">0</.test(h));
});

const LISTE_PAIE = { a_traiter: 1, pieces: [
  { periode_id: 7, annee: 2026, mois: 3, libelle_mois: 'mars', statut_periode: 'cloturee', reference: 'SMI-PAIE-2026-03', lignes: 6, total: 205000, equilibre: true, ecrite: false },
  { periode_id: 6, annee: 2026, mois: 2, libelle_mois: 'février', statut_periode: 'payee', reference: 'SMI-PAIE-2026-02', lignes: 5, total: 150000, equilibre: true, ecrite: true },
] };
const PIECE = { periode_id: 7, annee: 2026, mois: 3, libelle_mois: 'mars', reference: 'SMI-PAIE-2026-03', date: '2026-03-31', journal: 'OD', equilibre: true, ecrite: false,
  total_debit: 205000, total_credit: 205000, lignes: [
    { compte: '6611', libelle: 'Salaires bruts mars', debit: 180000, credit: 0 },
    { compte: '6641', libelle: 'CNSS part patronale mars', debit: 25000, credit: 0 },
    { compte: '422', libelle: 'Net à payer mars', debit: 0, credit: 150000 },
    { compte: '431', libelle: 'CNSS <script>', debit: 0, credit: 55000 },
  ] };

verifier('le cockpit compte les écritures à traiter et y mène', () => {
  const h = R.cockpit(PASSAGE, CONTROLES, LISTE_PAIE);
  const t = texte(h);
  assert.ok(t.includes('Écritures à traiter 1 Pièce de paie · mars 2026'), t);
  assert.ok(/data-cg-onglet="a-traiter"/.test(h));
  assert.ok(texte(R.cockpit(PASSAGE, CONTROLES, null)).includes('Écritures à traiter —'), 'sans liste, un tiret, pas un zéro trompeur');
});

verifier('C4 : liste, pièce, équilibre, et le bouton Valider et écrire', () => {
  const h = R.aTraiter(LISTE_PAIE, PIECE);
  const t = texte(h);
  for (const l of ['Écritures à traiter', 'Pièce de paie · mars 2026', 'Période clôturée · 6 lignes · 205 000', 'Validées', 'Journal OD · Opérations diverses · 31/03/2026 · SMI-PAIE-2026-03', 'Brouillons', 'Total', 'Équilibre débit/crédit ✓', 'Annuler', 'Valider et écrire']) {
    assert.ok(t.includes(l), 'absent : ' + l);
  }
  assert.ok(h.includes('CNSS &lt;script&gt;') && !h.includes('<script>'), 'libellé échappé');
  assert.ok(/data-cg-ecrire="7">Valider et écrire/.test(h), 'bouton actif pour une pièce équilibrée non écrite');
});

verifier('C4 : une pièce déséquilibrée ou déjà écrite ne peut pas être écrite', () => {
  const des = R.aTraiter(LISTE_PAIE, { ...PIECE, equilibre: false, total_credit: 200000 });
  assert.ok(/data-cg-ecrire="7" disabled>/.test(des) && texte(des).includes('Équilibre débit/crédit ✗'));
  const faite = R.aTraiter(LISTE_PAIE, { ...PIECE, ecrite: true });
  assert.ok(/data-cg-ecrire="7" disabled>/.test(faite) && /cg-puce-ok">Validées</.test(faite));
  const payee = texte(R.aTraiter({ a_traiter: 1, pieces: [{ ...LISTE_PAIE.pieces[0], statut_periode: 'payee' }] }, null));
  assert.ok(!payee.includes('Période clôturée'), 'une période payée non clôturée ne se dit pas clôturée');
});

verifier('l export CSV de la balance protège les guillemets', () => {
  const csv = R.csvBalance({ comptes: [{ compte: '411', libelle: 'Clients "export"', debit: 1, credit: 0, solde: 1, sens: 'D' }] });
  assert.strictEqual(csv.split('\n')[1], '"411";"Clients ""export""";"1";"0";"1 D"');
});

verifier('la page actuelle reste en place tant que la connexion n est pas configurée', () => {
  assert.ok(html.includes('<script src="/js/pages/comptabilite-generale.js"></script>'), 'module non chargé');
  assert.ok(/ouvrirComptabiliteGenerale\('comptabilite-dashboard', loadAccountingDashboard\)/.test(html));
  assert.ok(/ouvrirComptabiliteGenerale\('journal-comptable', \(\) => \{\s*initJournalComptableDates\(\);\s*loadAccountingWorkspace\(\);/.test(html));
  assert.ok(/if \(!ok\) pageActuelle\(\)/.test(html) && /\.catch\(\(\) => pageActuelle\(\)\)/.test(html));
  assert.ok(/appel\('\/etat', \{ silentStatuses: \[[^\]]*403[^\]]*503/.test(source), 'un refus ou une absence doit rester silencieux');
});

console.log(`${vertes}/${vertes + echecs} gardes vertes — ecrans de comptabilite generale`);
if (echecs) process.exitCode = 1;
