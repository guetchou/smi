'use strict';

const db = require('../database');

const MONTHS = ['', 'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function decodeHtml(value) {
  return String(value ?? '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;|&#39;/gi, "'")
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractInfo(html, label) {
  const safe = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<span[^>]*>\\s*${safe}\\s*:?\\s*<\\/span>\\s*(?:<strong>)?([^<]+)`, 'i');
  const match = html.match(re);
  return match ? decodeHtml(match[1]) : '';
}

function extractPeriod(html) {
  const match = html.match(/Période\s*:\s*([^<]+)/i);
  return match ? decodeHtml(match[1]) : '';
}

function parsePeriod(period) {
  const normalized = String(period || '').trim().toLowerCase();
  const month = MONTHS.findIndex((m, i) => i > 0 && m.toLowerCase() === normalized.split(/\s+/)[0]);
  const yearMatch = normalized.match(/(20\d{2})/);
  return { month: month > 0 ? month : null, year: yearMatch ? Number(yearMatch[1]) : null };
}

function cellsFromRow(rowHtml) {
  return [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => decodeHtml(m[1]));
}

function extractPayrollRows(html) {
  const rows = [];
  for (const match of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = cellsFromRow(match[1]);
    if (cells.length < 3) continue;
    const label = cells[0];
    if (!label || /^(Salaire brut|Total retenues|NET À PAYER|CNSS patronal|CAMU patronal|Coût total employeur)$/i.test(label)) continue;
    const gain = cells[1] && cells[1] !== '—' ? cells[1] : '';
    const retenue = cells[2] && cells[2] !== '—' ? cells[2] : '';
    if (!gain && !retenue) continue;
    rows.push({ label, gain, retenue });
  }
  return rows;
}

function extractSummary(html, label) {
  const rowRe = new RegExp(`<tr[^>]*>[\\s\\S]*?<td[^>]*>\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*<\\/td>([\\s\\S]*?)<\\/tr>`, 'i');
  const row = html.match(rowRe);
  if (!row) return '';
  const cells = cellsFromRow(row[0]);
  return cells.slice(1).find(c => c && c !== '—') || '';
}

function parameterMap() {
  try {
    const keys = [
      'societe', 'adresse', 'adresse_entreprise', 'rccm', 'niu',
      'cnss_numero_adherent', 'cnss_employeur',
    ];
    const placeholders = keys.map(() => '?').join(',');
    const rows = db.prepare(`SELECT cle, valeur FROM parametres WHERE cle IN (${placeholders})`).all(...keys);
    return Object.fromEntries(rows.map(r => [r.cle, r.valeur]));
  } catch (_) {
    return {};
  }
}

function employeeData(matricule, period) {
  if (!matricule || matricule === '—') return {};
  try {
    const employee = db.prepare(`
      SELECT id, nom, prenom, poste, matricule, cnss, departement, date_embauche,
             type_contrat, mode_paiement, banque, numero_compte,
             conges_acquis_annuel, conges_pris_annuel, conges_solde_annuel
      FROM employes WHERE matricule = ? LIMIT 1
    `).get(matricule);
    if (!employee) return {};

    let paymentDate = null;
    if (period.month && period.year) {
      const bulletin = db.prepare(`
        SELECT operation_id FROM bulletins_salaire
        WHERE employe_id = ? AND mois = ? AND annee = ? LIMIT 1
      `).get(employee.id, period.month, period.year);
      if (bulletin?.operation_id) {
        const op = db.prepare('SELECT date FROM operations WHERE id = ?').get(bulletin.operation_id);
        paymentDate = op?.date || null;
      }
    }
    return { ...employee, payment_date: paymentDate };
  } catch (_) {
    return {};
  }
}

function formatDate(value) {
  if (!value) return '';
  const raw = String(value).slice(0, 10);
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return raw;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

function rowMeta(row, gross) {
  const rate = row.label.match(/\(([^)]*%[^)]*)\)/)?.[1] || '';
  const cleanLabel = row.label.replace(/\s*\([^)]*%[^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  let base = '';
  let taux = rate;

  if (/^Salaire de base$/i.test(cleanLabel)) base = row.gain;
  if (/^(CNSS salarié|CAMU salarié)$/i.test(cleanLabel)) base = gross;

  return {
    label: cleanLabel,
    base: base || '—',
    taux: taux || '—',
    gain: row.gain || '—',
    retenue: row.retenue || '—',
  };
}

function infoLine(label, value) {
  if (value === undefined || value === null || String(value).trim() === '' || String(value).trim() === '—') return '';
  return `<div class="info-line"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function renderProfessionalPayrollHtml(legacyHtml) {
  if (!legacyHtml || !/Bulletin de Paie/i.test(legacyHtml)) return legacyHtml;

  const periodLabel = extractPeriod(legacyHtml);
  const period = parsePeriod(periodLabel);
  const matricule = extractInfo(legacyHtml, 'Matricule');
  const parsedEmployeeName = extractInfo(legacyHtml, 'Employé');
  const parsedPoste = extractInfo(legacyHtml, 'Poste');
  const parsedCnss = extractInfo(legacyHtml, 'N° CNSS');
  const parsedContrat = extractInfo(legacyHtml, 'Contrat');
  const parsedPayment = extractInfo(legacyHtml, 'Mode paiement');

  const params = parameterMap();
  const emp = employeeData(matricule, period);
  const companyName = params.societe || (legacyHtml.match(/<h1>([^<]+)<\/h1>/i)?.[1] ? decodeHtml(legacyHtml.match(/<h1>([^<]+)<\/h1>/i)[1]) : 'TOP CENTER');
  const address = params.adresse_entreprise || params.adresse || 'Brazzaville, République du Congo';
  const employeeName = [emp.nom, emp.prenom].filter(Boolean).join(' ') || parsedEmployeeName;
  const poste = emp.poste || parsedPoste;
  const cnss = emp.cnss || parsedCnss;
  const contract = emp.type_contrat || parsedContrat;
  const paymentMode = emp.mode_paiement === 'virement_bancaire' ? 'Virement bancaire' : (emp.mode_paiement || parsedPayment);

  const gross = extractSummary(legacyHtml, 'Salaire brut');
  const totalDeductions = extractSummary(legacyHtml, 'Total retenues');
  const netPay = extractSummary(legacyHtml, 'NET À PAYER');
  const rows = extractPayrollRows(legacyHtml).map(row => rowMeta(row, gross));

  const leaveAcquired = emp.conges_acquis_annuel;
  const leaveTaken = emp.conges_pris_annuel;
  const leaveBalance = emp.conges_solde_annuel;

  const rowsHtml = rows.map(row => `
    <tr>
      <td>${escapeHtml(row.label)}</td>
      <td class="num">${escapeHtml(row.base)}</td>
      <td class="num">${escapeHtml(row.taux)}</td>
      <td class="num">${escapeHtml(row.gain)}</td>
      <td class="num">${escapeHtml(row.retenue)}</td>
    </tr>`).join('');

  const brandMark = `<svg viewBox="0 0 76 76" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
    <g fill="none" stroke="#f26a21" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="38" cy="8" r="4"/><circle cx="64" cy="23" r="4"/><circle cx="64" cy="53" r="4"/>
      <circle cx="38" cy="68" r="4"/><circle cx="12" cy="53" r="4"/><circle cx="12" cy="23" r="4"/>
      <path d="M38 14 58 25M64 29v18M58 51 38 62M18 51l20 11M12 29v18M18 25l20-11"/>
      <path d="m24 29 14 17 14-17"/>
    </g>
  </svg>`;

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<style>
  *{box-sizing:border-box}
  body{font-family:Arial,Helvetica,sans-serif;color:#17233d;margin:0;padding:0;font-size:11.2px;background:#fff}
  .page{width:100%;padding:4mm 2mm 0}
  .header{display:table;width:100%;padding:0 0 7mm;border-bottom:2px solid #123e78}
  .brand,.title{display:table-cell;vertical-align:middle}
  .brand{width:48%}
  .brand svg{width:46px;height:46px;vertical-align:middle;margin-right:7px}
  .brand-name{display:inline-block;vertical-align:middle;font-size:26px;font-weight:800;letter-spacing:-1px}
  .brand-top{color:#f26a21}.brand-center{color:#174fa8}
  .title{text-align:right}
  .title h1{font-size:24px;color:#123e78;margin:0 0 5px;letter-spacing:.2px}
  .title p{font-size:12px;color:#42577b;margin:0}
  .identity{display:table;width:100%;padding:7mm 0 6mm;border-bottom:1px solid #cbd5e1}
  .identity-col{display:table-cell;width:50%;vertical-align:top;padding-right:8mm}
  .identity-col+ .identity-col{padding-left:8mm;padding-right:0;border-left:1px solid #d9e0ea}
  .section{font-size:11.5px;font-weight:800;color:#123e78;letter-spacing:.3px;margin:0 0 4mm}
  .info-line{display:table;width:100%;margin:0 0 2.3mm}
  .info-line span,.info-line strong{display:table-cell;vertical-align:top}
  .info-line span{width:42%;font-weight:400;color:#354765}
  .info-line strong{font-weight:500;color:#17233d}
  table.pay{width:100%;border-collapse:collapse;margin-top:6mm;border:1px solid #d5dce7}
  .pay th{padding:3.4mm 3mm;background:#f8fafc;color:#123e78;text-transform:uppercase;font-size:10.5px;border-bottom:1px solid #b9c5d6;text-align:left}
  .pay th.num,.pay td.num{text-align:right}
  .pay td{padding:2.8mm 3mm;border-bottom:1px solid #edf0f4;color:#192741}
  .pay td+td,.pay th+th{border-left:1px solid #e2e7ef}
  .summary{margin-top:3mm}
  .summary-row{display:table;width:100%;padding:2.8mm 1mm;border-bottom:1px solid #aebbd0;font-weight:800;color:#123e78}
  .summary-row span{display:table-cell}.summary-row strong{display:table-cell;text-align:right}
  .net{display:table;width:100%;margin-top:2mm;padding:4mm 1mm;border-top:2px solid #f26a21;border-bottom:2px solid #f26a21;color:#f05b14;font-weight:800}
  .net span,.net strong{display:table-cell;vertical-align:middle}.net span{font-size:19px}.net strong{text-align:right;font-size:25px}
  .bottom{display:table;width:100%;margin-top:7mm}
  .bottom-col{display:table-cell;width:50%;vertical-align:top;padding-right:8mm}
  .bottom-col+ .bottom-col{padding-left:8mm;padding-right:0;border-left:1px solid #d9e0ea}
  .signature{display:table;width:100%;margin-top:12mm}
  .signature div{display:table-cell;width:50%;text-align:center;color:#123e78;font-size:10px;padding:0 12mm}
  .signature-line{border-top:1px solid #123e78;padding-top:2mm}
  @media print{*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style>
</head>
<body><div class="page">
  <div class="header">
    <div class="brand">${brandMark}<span class="brand-name"><span class="brand-top">TOP</span> <span class="brand-center">CENTER</span></span></div>
    <div class="title"><h1>BULLETIN DE SALAIRE</h1><p>Période de paie : ${escapeHtml(periodLabel)}</p></div>
  </div>

  <div class="identity">
    <div class="identity-col">
      <div class="section">ENTREPRISE</div>
      ${infoLine('Entreprise :', companyName)}
      ${infoLine('Adresse :', address)}
      ${infoLine('NIU :', params.niu)}
      ${infoLine('RCCM :', params.rccm)}
      ${infoLine('CNSS Employeur :', params.cnss_numero_adherent || params.cnss_employeur)}
    </div>
    <div class="identity-col">
      <div class="section">SALARIÉ / EMPLOI</div>
      ${infoLine('Nom et prénom :', employeeName)}
      ${infoLine('Matricule :', matricule)}
      ${infoLine('Poste :', poste)}
      ${infoLine('Département :', emp.departement)}
      ${infoLine("Date d'embauche :", formatDate(emp.date_embauche))}
      ${infoLine('N° CNSS :', cnss)}
      ${infoLine('Type de contrat :', contract)}
    </div>
  </div>

  <table class="pay">
    <thead><tr><th>Rubrique</th><th class="num">Base</th><th class="num">Taux</th><th class="num">Gains</th><th class="num">Retenues</th></tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>

  <div class="summary">
    <div class="summary-row"><span>SALAIRE BRUT</span><strong>${escapeHtml(gross)}</strong></div>
    <div class="summary-row"><span>TOTAL RETENUES</span><strong>${escapeHtml(totalDeductions)}</strong></div>
  </div>
  <div class="net"><span>NET À PAYER</span><strong>${escapeHtml(netPay)}</strong></div>

  <div class="bottom">
    <div class="bottom-col">
      <div class="section">CONGÉS</div>
      ${infoLine('Congés acquis :', leaveAcquired !== undefined && leaveAcquired !== null ? `${leaveAcquired} jours` : '')}
      ${infoLine('Congés pris :', leaveTaken !== undefined && leaveTaken !== null ? `${leaveTaken} jours` : '')}
      ${infoLine('Solde disponible :', leaveBalance !== undefined && leaveBalance !== null ? `${leaveBalance} jours` : '')}
    </div>
    <div class="bottom-col">
      <div class="section">PAIEMENT</div>
      ${infoLine('Mode de paiement :', paymentMode)}
      ${infoLine('Banque :', emp.banque)}
      ${infoLine('Compte :', emp.numero_compte)}
      ${infoLine('Date de paiement :', formatDate(emp.payment_date))}
    </div>
  </div>

  <div class="signature">
    <div><div class="signature-line">Signature employeur</div></div>
    <div><div class="signature-line">Signature salarié</div></div>
  </div>
</div></body></html>`;
}

module.exports = {
  renderProfessionalPayrollHtml,
  extractPayrollRows,
  extractInfo,
  parsePeriod,
};
