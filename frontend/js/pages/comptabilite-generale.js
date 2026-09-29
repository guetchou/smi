/*
 * Comptabilité générale — écrans C1 à C3 (maquettes validées le 29/09/2026).
 *
 * ADR 0002 : la comptabilité est tenue en arrière-plan et montrée ici ;
 * aucun libellé ne nomme le logiciel qui la tient. Les données viennent de
 * /api/comptabilite (backend/routes/comptabilite.js).
 *
 * Bascule : à l'ouverture d'une page comptable, ouvrir() demande /etat. Si la
 * connexion n'est pas configurée (ou en cas d'échec), il rend faux et la page
 * actuelle s'affiche comme avant. Sinon il remplace son contenu par l'écran.
 */
(function () {
  'use strict';

  const BASE = '/api/comptabilite';
  const MOIS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];
  const JOURNAUX = [
    ['', 'Tous'],
    ['VT', 'VT · Ventes'],
    ['AC', 'AC · Achats'],
    ['BQ', 'BQ · Banque'],
    ['OD', 'OD · Opérations diverses'],
  ];
  // Libellés de classes validés le 29/09/2026 ; les autres classes restent « Classe N ».
  const CLASSES = { 4: 'Classe 4 — Tiers', 5: 'Classe 5 — Trésorerie', 6: 'Classe 6 — Charges', 7: 'Classe 7 — Produits' };

  const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const nombre = n => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 }).format(Number(n) || 0);
  const montant = n => (Number(n) ? nombre(n) : '');
  const dateFr = d => (d ? `${String(d).slice(8, 10)}/${String(d).slice(5, 7)}/${String(d).slice(0, 4)}` : '');
  const heure = iso => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }); };
  const aujourdhui = () => { const d = new Date(); return `${d.getFullYear()}-${MOIS[d.getMonth()]}-${String(d.getDate()).padStart(2, '0')}`; };

  let etat = { journal: { du: '', au: '', journal: '', compte: '' }, onglet: 'journal' };

  // api() de la page préfixe déjà /api ; BASE sert de repère aux gardes.
  const CHEMIN = BASE.replace(/^\/api/, '');
  const appel = (chemin, options = {}) => (typeof api === 'function'
    ? api(CHEMIN + chemin, { noCache: true, ...options })
    : Promise.resolve(null));

  /* Origine d'une pièce, en libellés qui existent déjà dans l'application. */
  function source(lignes) {
    const j = lignes[0].journal;
    if (j === 'VT') return 'Factures clients';
    if (j === 'AC') return 'Factures fournisseurs';
    if (j === 'OD') return 'Salaires';
    if (lignes.some(l => String(l.compte).startsWith('585'))) return 'Virements internes';
    const tresorerie = lignes.filter(l => /^5[27]/.test(String(l.compte)));
    const entree = tresorerie.reduce((s, l) => s + Number(l.debit || 0) - Number(l.credit || 0), 0);
    return entree >= 0 ? 'Encaissements' : 'Décaissements';
  }

  /* Les lignes d'une même pièce ne font qu'une ligne dans « Dernières écritures ». */
  function pieces(lignes) {
    const parPiece = new Map();
    for (const l of lignes) {
      const cle = `${l.journal}|${l.piece}`;
      if (!parPiece.has(cle)) parPiece.set(cle, []);
      parPiece.get(cle).push(l);
    }
    return [...parPiece.values()].map(ls => ({
      date: ls[0].date, journal: ls[0].journal, reference: ls[0].reference,
      source: source(ls), montant: ls.reduce((s, l) => s + Number(l.debit || 0), 0),
    }));
  }

  function onglets(actif) {
    const items = [['cockpit', 'Cockpit comptable'], ['journal', 'Journal comptable OHADA'], ['balance', 'Balance']];
    return `<div class="cg-onglets" role="tablist">${items.map(([k, l]) =>
      `<button type="button" role="tab" class="cg-onglet" aria-selected="${k === actif}" data-cg-onglet="${k}">${esc(l)}</button>`).join('')}</div>`;
  }

  function bandeau(passage) {
    const enErreur = !passage || passage.statut !== 'ok' || passage.en_retard;
    const etiquette = enErreur ? 'En retard' : 'À jour';
    const detail = passage && passage.horodatage
      ? `Dernier passage ${esc(heure(passage.horodatage))} · ${nombre(passage.ecritures_ajoutees)} écritures ajoutées · ventes, achats, banque`
      : '';
    return `<div class="cg-bandeau ${enErreur ? 'cg-alerte' : 'cg-ok'}">
      <span class="cg-pastille" aria-hidden="true"></span>
      <div class="cg-bandeau-texte"><strong>Passage au grand livre · ${etiquette}</strong><span>${detail}</span></div>
      <span class="cg-discret">Toutes les 5 min</span>
    </div>`;
  }

  function rendreCockpit(passage, c) {
    const ex = (c.exercices || [])[0];
    const attente = c.attente || { montant: 0, lignes: 0, compte: '471' };
    const eq = c.equilibre || {};
    const lignesRecentes = pieces((c.dernieres || []).slice().reverse()).reverse().slice(0, 6);
    return `${onglets('cockpit')}${bandeau(passage)}
    <div class="cg-cartes">
      <div class="cg-carte ${eq.ok ? '' : 'cg-carte-alerte'}"><span class="cg-etiq">Équilibre débit/crédit</span><span class="cg-valeur ${eq.ok ? 'cg-vert' : 'cg-rouge'}">${nombre(eq.debit)}</span><span class="cg-etiq">${eq.ok ? 'Débit = Crédit' : `${nombre(eq.debit)} / ${nombre(eq.credit)}`}</span></div>
      <div class="cg-carte"><span class="cg-etiq">Période comptable</span><span class="cg-valeur">${esc(ex ? ex.libelle : '—')}</span><span class="cg-etiq">${ex ? `${esc(dateFr(ex.debut).slice(0, 5))} → ${esc(dateFr(ex.fin).slice(0, 5))} · ouverte` : ''}</span></div>
      <div class="cg-carte ${attente.montant ? 'cg-carte-alerte' : ''}"><span class="cg-etiq">Compte d'attente à régulariser</span><span class="cg-valeur ${attente.montant ? 'cg-rouge' : ''}">${nombre(attente.montant)}</span><span class="cg-etiq">${esc(attente.compte)} · ${nombre(attente.lignes)} ${attente.lignes > 1 ? 'lignes' : 'ligne'}</span></div>
    </div>
    <section class="cg-bloc"><h2 class="cg-titre">Dernières écritures</h2>
      <div class="cg-defile"><table class="cg-table"><thead><tr><th>Date</th><th>Journal</th><th>Pièce</th><th>Source</th><th class="cg-d">Montant</th><th>Statut</th></tr></thead>
      <tbody>${lignesRecentes.map(p => `<tr><td>${esc(dateFr(p.date))}</td><td class="cg-code">${esc(p.journal)}</td><td class="cg-code">${esc(p.reference)}</td><td class="cg-gris">${esc(p.source)}</td><td class="cg-d cg-fort">${nombre(p.montant)}</td><td class="cg-vert cg-fort">Validées</td></tr>`).join('')}</tbody></table></div>
    </section>`;
  }

  function rendreJournal(filtres, gl) {
    const lignes = gl.lignes || [];
    return `${onglets('journal')}
    <form class="cg-filtres" data-cg-filtres>
      <label>Du<input type="date" name="du" value="${esc(filtres.du)}"></label>
      <label>Au<input type="date" name="au" value="${esc(filtres.au)}"></label>
      <label>Journal<select name="journal">${JOURNAUX.map(([v, l]) => `<option value="${v}"${v === filtres.journal ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
      <label>Compte<input name="compte" value="${esc(filtres.compte)}" placeholder="411, 57…" inputmode="numeric"></label>
      <button type="submit" class="btn btn-primary text-sm">Filtrer</button>
      <span class="cg-discret cg-pousse">${nombre(lignes.length)} lignes</span>
    </form>
    <div class="cg-bloc"><div class="cg-defile"><table class="cg-table"><thead><tr><th>Date</th><th>Journal</th><th>Pièce</th><th>Compte</th><th>Libellé</th><th class="cg-d">Débit</th><th class="cg-d">Crédit</th></tr></thead>
    <tbody>${lignes.map(l => `<tr><td class="cg-gris">${esc(dateFr(l.date))}</td><td class="cg-code">${esc(l.journal)}</td><td class="cg-code">${esc(l.reference)}</td><td class="cg-code cg-fort ${String(l.compte).startsWith('471') ? 'cg-rouge' : ''}">${esc(l.compte)}</td><td>${esc(l.libelle)}</td><td class="cg-d">${montant(l.debit)}</td><td class="cg-d">${montant(l.credit)}</td></tr>`).join('')}</tbody>
    <tfoot><tr><td colspan="5">Total</td><td class="cg-d">${nombre(gl.total_debit)}</td><td class="cg-d">${nombre(gl.total_credit)}</td></tr></tfoot></table></div></div>`;
  }

  function rendreBalance(b) {
    const parClasse = new Map();
    for (const c of b.comptes || []) {
      if (!parClasse.has(c.classe)) parClasse.set(c.classe, []);
      parClasse.get(c.classe).push(c);
    }
    const corps = [...parClasse.entries()].sort(([a], [z]) => String(a).localeCompare(String(z))).map(([classe, comptes]) =>
      `<tr class="cg-classe"><td colspan="5">${esc(CLASSES[classe] || `Classe ${classe}`)}</td></tr>` +
      comptes.map(c => {
        const attente = String(c.compte).startsWith('471') && c.solde;
        return `<tr${attente ? ' class="cg-ligne-alerte"' : ''}><td class="cg-code cg-fort">${esc(c.compte)}</td><td>${esc(c.libelle)}</td><td class="cg-d">${montant(c.debit)}</td><td class="cg-d">${montant(c.credit)}</td><td class="cg-d cg-fort ${attente ? 'cg-rouge' : c.solde ? '' : 'cg-gris'}">${c.solde ? `${nombre(c.solde)} ${esc(c.sens)}` : '0'}</td></tr>`;
      }).join('')).join('');
    const ecart = Math.abs(Number(b.total_debit) - Number(b.total_credit));
    return `${onglets('balance')}
    <div class="cg-entete"><h1 class="cg-titre-page">Balance · ${esc(dateFr(b.du))} → ${esc(dateFr(b.au))}</h1><button type="button" class="btn btn-secondary text-sm" data-cg-export>Export CSV</button></div>
    <div class="cg-bloc"><div class="cg-defile"><table class="cg-table"><thead><tr><th>Compte</th><th>Libellé</th><th class="cg-d">Débit</th><th class="cg-d">Crédit</th><th class="cg-d">Solde</th></tr></thead>
    <tbody>${corps}</tbody>
    <tfoot><tr><td colspan="2">Total</td><td class="cg-d">${nombre(b.total_debit)}</td><td class="cg-d">${nombre(b.total_credit)}</td><td class="cg-d ${ecart < 0.005 ? 'cg-vert' : 'cg-rouge'}">${nombre(ecart)}</td></tr></tfoot></table></div></div>`;
  }

  function csvBalance(b) {
    const cellule = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lignes = [['Compte', 'Libellé', 'Débit', 'Crédit', 'Solde'], ...(b.comptes || []).map(c => [c.compte, c.libelle, c.debit, c.credit, c.solde ? `${c.solde} ${c.sens}` : 0])];
    return lignes.map(l => l.map(cellule).join(';')).join('\n');
  }

  const STYLES = `
    .cg-racine{display:flex;flex-direction:column;gap:14px;font-variant-numeric:tabular-nums}
    .cg-onglets{display:flex;gap:4px;background:var(--c-border);padding:3px;border-radius:10px;align-self:flex-start;flex-wrap:wrap}
    .cg-onglet{padding:7px 14px;border:0;border-radius:8px;background:transparent;font-size:13px;color:var(--c-text-m);cursor:pointer}
    .cg-onglet[aria-selected="true"]{background:var(--c-surface);color:var(--c-text);font-weight:600;box-shadow:0 1px 2px rgba(15,23,42,.08)}
    .cg-onglet:focus-visible{outline:2px solid var(--c-primary);outline-offset:1px}
    .cg-bandeau{display:flex;align-items:center;gap:14px;padding:12px 16px;background:var(--c-surface);border:1px solid #BBF7D0;border-radius:10px}
    .cg-bandeau.cg-alerte{border-color:#FECACA;background:#FEF2F2}
    .cg-pastille{width:10px;height:10px;border-radius:999px;background:#16A34A;flex-shrink:0}
    .cg-alerte .cg-pastille{background:var(--c-danger)}
    .cg-bandeau-texte{flex:1;display:flex;flex-direction:column;gap:2px;font-size:12.5px;color:var(--c-text-m)}
    .cg-bandeau-texte strong{font-size:14px;color:var(--c-text)}
    .cg-discret{font-size:12px;color:var(--c-text-m)}
    .cg-cartes{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
    .cg-carte{background:var(--c-surface);border:1px solid var(--c-border);border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:4px}
    .cg-carte-alerte{border-color:#FECACA}
    .cg-etiq{font-size:12px;color:var(--c-text-m)}
    .cg-valeur{font-size:20px;font-weight:700}
    .cg-bloc{background:var(--c-surface);border:1px solid var(--c-border);border-radius:10px;overflow:hidden}
    .cg-titre{margin:0;padding:12px 16px;border-bottom:1px solid var(--c-border);font-size:14px;font-weight:700}
    .cg-defile{overflow-x:auto}
    .cg-table{width:100%;border-collapse:collapse;font-size:12.5px}
    .cg-table th{padding:8px 12px;background:#F8FAFC;font-size:11px;font-weight:600;color:var(--c-text-m);text-transform:uppercase;letter-spacing:.04em;text-align:left;white-space:nowrap}
    .cg-table td{padding:7px 12px;border-top:1px solid #F1F5F9;vertical-align:middle}
    .cg-table tfoot td{border-top:1px solid var(--c-border-h);background:#F8FAFC;font-weight:700;font-size:13px}
    .cg-table .cg-d{text-align:right;white-space:nowrap}
    .cg-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;white-space:nowrap}
    .cg-fort{font-weight:600}.cg-gris{color:var(--c-text-m)}.cg-vert{color:#047857}.cg-rouge{color:var(--c-danger)}
    .cg-classe td{background:#F8FAFC;font-size:11.5px;font-weight:700;color:var(--c-text-m)}
    .cg-ligne-alerte td{background:#FEF2F2}
    .cg-filtres{display:flex;flex-wrap:wrap;align-items:flex-end;gap:10px;background:var(--c-surface);border:1px solid var(--c-border);border-radius:10px;padding:12px 16px}
    .cg-filtres label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--c-text-m)}
    .cg-filtres input,.cg-filtres select{height:34px;border:1px solid var(--c-border-h);border-radius:8px;padding:0 10px;font-size:13px;background:var(--c-surface);color:var(--c-text)}
    .cg-pousse{margin-left:auto}
    .cg-entete{display:flex;align-items:center;gap:12px}
    .cg-titre-page{margin:0;font-size:20px;font-weight:700;flex:1}
    @media (max-width:900px){.cg-cartes{grid-template-columns:1fr}}
  `;
  function installerStyles() {
    if (document.getElementById('cg-styles')) return;
    const s = document.createElement('style');
    s.id = 'cg-styles';
    s.textContent = STYLES;
    document.head.appendChild(s);
  }

  /* Place la racine en tête de la page et masque le contenu actuel. */
  function racine(page) {
    const conteneur = document.getElementById('page-' + page);
    if (!conteneur) return null;
    let r = conteneur.querySelector(':scope > .cg-racine');
    if (!r) {
      r = document.createElement('div');
      r.className = 'cg-racine';
      conteneur.prepend(r);
    }
    for (const enfant of conteneur.children) if (enfant !== r) enfant.classList.add('hidden');
    return r;
  }

  function brancher(r) {
    r.querySelectorAll('[data-cg-onglet]').forEach(b => b.addEventListener('click', () => {
      const cible = b.dataset.cgOnglet;
      if (cible === 'cockpit') return showPage('comptabilite-dashboard');
      etat.onglet = cible;
      if (typeof _activePage !== 'undefined' && _activePage === 'journal-comptable') return ouvrir('journal-comptable');
      return showPage('journal-comptable');
    }));
    const f = r.querySelector('[data-cg-filtres]');
    if (f) f.addEventListener('submit', e => {
      e.preventDefault();
      const d = new FormData(f);
      etat.journal = { du: d.get('du'), au: d.get('au'), journal: d.get('journal'), compte: String(d.get('compte') || '').trim() };
      ouvrir('journal-comptable');
    });
    const x = r.querySelector('[data-cg-export]');
    if (x) x.addEventListener('click', () => {
      const lien = document.createElement('a');
      lien.href = URL.createObjectURL(new Blob(['﻿' + csvBalance(etat.derniereBalance || {})], { type: 'text/csv;charset=utf-8' }));
      lien.download = `balance-${etat.journal.du}-${etat.journal.au}.csv`;
      lien.click();
      setTimeout(() => URL.revokeObjectURL(lien.href), 1000);
    });
  }

  /* Rend vrai si l'écran a été affiché ; faux pour laisser la page actuelle. */
  async function ouvrir(page) {
    // Silencieux : un profil sans accès (403) ou un service absent (503) garde
    // simplement la page actuelle, sans message d'erreur.
    const e = await appel('/etat', { silentStatuses: [401, 403, 404, 502, 503, 504] }).catch(() => null);
    if (!e || !e.configure) return false;
    installerStyles();
    const r = racine(page);
    if (!r) return false;
    const annee = new Date().getFullYear();
    if (!etat.journal.du) etat.journal = { du: `${annee}-01-01`, au: aujourdhui(), journal: '', compte: '' };
    const q = `?du=${encodeURIComponent(etat.journal.du)}&au=${encodeURIComponent(etat.journal.au)}`;
    if (page === 'comptabilite-dashboard') {
      const c = await appel('/controles' + q);
      if (!c) return true;
      r.innerHTML = rendreCockpit(e.passage, c);
    } else if (etat.onglet === 'balance') {
      const b = await appel('/balance' + q);
      if (!b) return true;
      etat.derniereBalance = b;
      r.innerHTML = rendreBalance(b);
    } else {
      const f = etat.journal;
      const gl = await appel(`/grand-livre${q}&journal=${encodeURIComponent(f.journal || '')}&compte=${encodeURIComponent(f.compte || '')}`);
      if (!gl) return true;
      r.innerHTML = rendreJournal(f, gl);
    }
    brancher(r);
    return true;
  }

  window.TalaComptabiliteGenerale = {
    ouvrir,
    _rendre: { cockpit: rendreCockpit, journal: rendreJournal, balance: rendreBalance, pieces, source, csvBalance },
  };
})();
