'use strict';

const {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  Packer,
  PageNumber,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} = require('docx');
const { generatePdf } = require('./pdf');
const { parseJson } = require('./employment_contract_workflow');

function money(value, currency = 'XAF') {
  if (value === null || value === undefined) return 'A verifier';
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 'A verifier';
  return `${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 }).format(amount)} ${currency}`;
}

function text(value, fallback = 'A verifier') {
  return value === null || value === undefined || String(value).trim() === '' ? fallback : String(value);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function clausesFromSnapshot(contract) {
  const snapshot = parseJson(contract.clauses_snapshot, {});
  if (Array.isArray(snapshot.articles)) return snapshot.articles;
  if (Array.isArray(snapshot.sections)) return snapshot.sections;
  return Object.entries(snapshot).map(([title, body]) => ({ title, body }));
}

function remunerationRows(contract) {
  const remuneration = parseJson(contract.remuneration_snapshot, {});
  return (remuneration.components || []).filter(item => item.displayOnContract !== false).map(item => ({
    label: item.label,
    amount: money(item.amount, remuneration.currency),
  }));
}

function docxTable(rows) {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map((row, index) => new TableRow({
      children: [row.label, row.amount].map(value => new TableCell({
        shading: index === 0 ? { fill: 'E7EEF7' } : undefined,
        borders: {
          top: { style: BorderStyle.SINGLE, size: 1, color: 'B7C4D4' },
          bottom: { style: BorderStyle.SINGLE, size: 1, color: 'B7C4D4' },
          left: { style: BorderStyle.SINGLE, size: 1, color: 'B7C4D4' },
          right: { style: BorderStyle.SINGLE, size: 1, color: 'B7C4D4' },
        },
        children: [new Paragraph({ children: [new TextRun({ text: value, bold: index === 0 })] })],
      })),
    })),
  });
}

async function buildDocx(contract) {
  const values = parseJson(contract.values_snapshot, {});
  const company = values.entreprise || {};
  const agent = values.agent || {};
  const terms = values.contrat || {};
  const remuneration = parseJson(contract.remuneration_snapshot, {});
  const clauses = clausesFromSnapshot(contract);
  const rows = [
    { label: 'Rubrique', amount: 'Montant mensuel' },
    ...remunerationRows(contract),
    { label: 'Total brut', amount: money(remuneration.grossTotal, remuneration.currency) },
  ];
  const children = [
    new Paragraph({ heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER, children: [new TextRun('CONTRAT DE TRAVAIL')] }),
    new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: contract.reference, bold: true })] }),
    new Paragraph({ children: [new TextRun({ text: 'ENTRE LES SOUSSIGNES', bold: true })] }),
    new Paragraph(`${text(company.raison_sociale)}, ${text(company.forme_juridique)}, RCCM ${text(company.rccm)}, NIF ${text(company.nif)}, sise ${text(company.adresse)}, representee par ${text(company.representant)}.`),
    new Paragraph({ children: [new TextRun({ text: 'ET', bold: true })] }),
    new Paragraph(`${text(agent.civilite)} ${text(agent.prenom)} ${text(agent.nom)}, matricule ${text(agent.matricule)}, ne(e) le ${text(agent.date_naissance)} a ${text(agent.lieu_naissance)}, demeurant ${text(agent.adresse)}.`),
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Conditions essentielles')] }),
    docxTable([
      { label: 'Type de contrat', amount: text(terms.type) },
      { label: 'Fonction', amount: text(terms.fonction) },
      { label: 'Service', amount: text(terms.service) },
      { label: 'Lieu de travail', amount: text(terms.lieu_travail) },
      { label: 'Date de debut', amount: text(terms.date_debut) },
      { label: 'Date de fin', amount: text(terms.date_fin, 'Sans terme defini') },
      { label: "Periode d'essai", amount: text(terms.periode_essai, 'Non renseignee') },
    ]),
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Remuneration')] }),
    docxTable(rows),
  ];
  for (const [index, clause] of clauses.entries()) {
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun(text(clause.title || clause.titre, `Article ${index + 1}`))],
    }));
    children.push(new Paragraph(text(clause.body || clause.contenu)));
  }
  children.push(
    new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Signatures')] }),
    docxTable([
      { label: `Pour ${text(company.raison_sociale)}`, amount: `${text(agent.civilite)} ${text(agent.prenom)} ${text(agent.nom)}` },
      { label: 'Nom, date et signature', amount: 'Lu et approuve, date et signature' },
    ])
  );

  const document = new Document({
    creator: 'TOP CENTER SMI',
    title: `Contrat ${contract.reference}`,
    description: 'Document genere depuis un snapshot contractuel versionne',
    sections: [{
      headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: text(company.raison_sociale), bold: true })] })] }) },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun('Document contractuel - page '), new TextRun({ children: [PageNumber.CURRENT] })] })] }) },
      children,
    }],
  });
  return Packer.toBuffer(document);
}

function buildHtml(contract) {
  const values = parseJson(contract.values_snapshot, {});
  const company = values.entreprise || {};
  const agent = values.agent || {};
  const terms = values.contrat || {};
  const remuneration = parseJson(contract.remuneration_snapshot, {});
  const clauses = clausesFromSnapshot(contract);
  const rows = remunerationRows(contract).map(row => `<tr><td>${escapeHtml(row.label)}</td><td>${escapeHtml(row.amount)}</td></tr>`).join('');
  const clauseHtml = clauses.map((clause, index) => `<section><h2>${escapeHtml(text(clause.title || clause.titre, `Article ${index + 1}`))}</h2><p>${escapeHtml(text(clause.body || clause.contenu))}</p></section>`).join('');
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><style>
    @page{size:A4;margin:16mm 17mm}body{font-family:Arial,sans-serif;color:#172033;font-size:11pt;line-height:1.45}h1{text-align:center;font-size:18pt;margin:0 0 4mm}h2{font-size:12pt;color:#173b66;margin:6mm 0 2mm}p{text-align:justify}table{width:100%;border-collapse:collapse;margin:3mm 0 5mm}th,td{border:1px solid #b7c4d4;padding:2.5mm;text-align:left}th{background:#e7eef7}.ref{text-align:center;font-weight:bold;margin-bottom:8mm}.signatures{margin-top:12mm}.muted{color:#536174;font-size:9pt}</style></head><body>
    <h1>CONTRAT DE TRAVAIL</h1><p class="ref">${escapeHtml(contract.reference)}</p>
    <h2>Entre les soussignes</h2><p>${escapeHtml(text(company.raison_sociale))}, ${escapeHtml(text(company.forme_juridique))}, RCCM ${escapeHtml(text(company.rccm))}, NIF ${escapeHtml(text(company.nif))}, sise ${escapeHtml(text(company.adresse))}, representee par ${escapeHtml(text(company.representant))}.</p>
    <h2>Et</h2><p>${escapeHtml(text(agent.civilite))} ${escapeHtml(text(agent.prenom))} ${escapeHtml(text(agent.nom))}, matricule ${escapeHtml(text(agent.matricule))}, ne(e) le ${escapeHtml(text(agent.date_naissance))} a ${escapeHtml(text(agent.lieu_naissance))}, demeurant ${escapeHtml(text(agent.adresse))}.</p>
    <h2>Conditions essentielles</h2><table><tr><th>Champ</th><th>Valeur</th></tr><tr><td>Type</td><td>${escapeHtml(text(terms.type))}</td></tr><tr><td>Fonction</td><td>${escapeHtml(text(terms.fonction))}</td></tr><tr><td>Lieu</td><td>${escapeHtml(text(terms.lieu_travail))}</td></tr><tr><td>Debut</td><td>${escapeHtml(text(terms.date_debut))}</td></tr><tr><td>Fin</td><td>${escapeHtml(text(terms.date_fin, 'Sans terme defini'))}</td></tr></table>
    <h2>Remuneration</h2><table><tr><th>Rubrique</th><th>Montant mensuel</th></tr>${rows}<tr><th>Total brut</th><th>${escapeHtml(money(remuneration.grossTotal, remuneration.currency))}</th></tr></table>
    ${clauseHtml}<table class="signatures"><tr><th>Pour ${escapeHtml(text(company.raison_sociale))}</th><th>${escapeHtml(text(agent.civilite))} ${escapeHtml(text(agent.prenom))} ${escapeHtml(text(agent.nom))}</th></tr><tr><td>Nom, date et signature</td><td>Lu et approuve, date et signature</td></tr></table>
    <p class="muted">Document genere depuis le snapshot contractuel ${escapeHtml(contract.reference)}.</p></body></html>`;
}

async function buildPdf(contract) {
  return generatePdf(buildHtml(contract), { prefix: 'contrat_travail', marginTop: '14mm', marginBottom: '14mm' });
}

module.exports = { buildDocx, buildHtml, buildPdf, escapeHtml, money };
