'use strict';

const assert = require('assert');
const { renderProfessionalPayrollHtml } = require('../backend/services/payroll_pdf_layout');

const legacy = `<!DOCTYPE html><html lang="fr"><body>
<div><h1>TOP CENTER</h1><div>Brazzaville, République du Congo</div></div>
<div>Période : Août 2026</div>
<div class="info-grid">
  <div><span class="info-label">Employé : </span><strong>NGOMA Jean Claude</strong></div>
  <div><span class="info-label">Poste : </span>Responsable Administratif</div>
  <div><span class="info-label">Matricule : </span>TC2024-0457</div>
  <div><span class="info-label">N° CNSS : </span>112233445566</div>
  <div><span class="info-label">Contrat : </span>Permanent</div>
  <div><span class="info-label">Mode paiement : </span>Virement — BGFI</div>
</div>
<table><tbody>
<tr><td>Salaire de base</td><td>500 000 XAF</td><td>—</td></tr>
<tr><td>Prime de transport</td><td>50 000 XAF</td><td>—</td></tr>
<tr><td>CNSS salarié (4.725%)</td><td>—</td><td>26 000 XAF</td></tr>
<tr><td>CAMU salarié (2,25%)</td><td>—</td><td>14 625 XAF</td></tr>
<tr><td>IRPP (barème progressif)</td><td>—</td><td>62 400 XAF</td></tr>
<tr><td>Salaire brut</td><td>650 000 XAF</td><td>—</td></tr>
<tr><td>Total retenues</td><td>—</td><td>103 025 XAF</td></tr>
<tr><td>NET À PAYER</td><td>546 975 XAF</td><td>—</td></tr>
<tr><td>CNSS patronal</td><td></td><td>130 000 XAF</td></tr>
</tbody></table>
</body></html>`;

const html = renderProfessionalPayrollHtml(legacy);

assert.match(html, /BULLETIN DE SALAIRE/);
assert.match(html, /Période de paie : Août 2026/);
assert.match(html, /SALARIÉ \/ EMPLOI/);
assert.match(html, /<th>Rubrique<\/th><th class="num">Base<\/th><th class="num">Taux<\/th><th class="num">Gains<\/th><th class="num">Retenues<\/th>/);
assert.match(html, /SALAIRE BRUT/);
assert.match(html, /TOTAL RETENUES/);
assert.match(html, /NET À PAYER/);
assert.match(html, /CONGÉS/);
assert.match(html, /PAIEMENT/);
assert.match(html, /TC2024-0457/);
assert.match(html, /Responsable Administratif/);
assert.match(html, /4\.725%/);
assert.doesNotMatch(html, /NIF\s*:/i);
assert.doesNotMatch(html, /Charges patronales/i);
assert.doesNotMatch(html, /Coût total employeur/i);
assert.doesNotMatch(html, /Rémunération/i);
assert.doesNotMatch(html, /Retenues salariales/i);
assert.doesNotMatch(html, /Merci|engagement|performance/i);

console.log('payroll_pdf_layout_test: OK');
