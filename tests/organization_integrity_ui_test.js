const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const loader = fs.readFileSync(path.join(root, 'frontend/js/modules/org-departments.js'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'frontend/js/modules/org-integrity-ui.js'), 'utf8');

new Function(loader);
new Function(ui);

assert(loader.includes('/js/modules/org-integrity-ui.js'));
assert(ui.includes("api('/anomalies')"));
assert(ui.includes("api('/reparer-integrite'"));
assert(ui.includes('JSON.stringify({ dry_run: true })'));
assert(ui.includes("JSON.stringify({ dry_run: false, confirmation: 'REPARER' })"));
assert(ui.includes("value.trim().toUpperCase() !== 'REPARER'"));
assert(ui.includes('Correction sûre'));
assert(ui.includes('Décision RH'));
assert(ui.includes('CONCURRENT_CHANGE_DETECTED') === false);
assert(ui.includes('result.applied_changes'));
assert(ui.includes('result.skipped_changes'));
assert(ui.includes('result.run_id'));
assert(ui.includes("document.getElementById('org-integrity-execute').addEventListener('click', executeRepair)"));

console.log('OK - organization integrity UI requires simulation and explicit confirmation');
