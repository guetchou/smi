// One-off script: associate <label> elements with their following form control
// via a `for` attribute, for accessibility (WCAG 1.3.1 / 4.1.2 / 3.3.2).
// Only touches labels directly (whitespace-only) followed by an
// <input|select|textarea id="..."> that don't already have a `for`.
const fs = require('fs');
const path = process.argv[2];
const dryRun = process.argv.includes('--dry');

let html = fs.readFileSync(path, 'utf8');

let total = 0, applied = 0, skippedHasFor = 0;
const samples = [];

const re = /<label((?:\s+[^>]*)?)>((?:(?!<\/label>)[\s\S])*?)<\/label>(\s*)<(input|select|textarea)\b([^>]*?)\bid="([^"]+)"/g;

html = html.replace(re, (match, labelAttrs, labelText, ws, tag, attrsBefore, id) => {
  total++;
  if (/\bfor=/.test(labelAttrs)) { skippedHasFor++; return match; }
  applied++;
  const replacement = `<label${labelAttrs} for="${id}">${labelText}</label>${ws}<${tag}${attrsBefore}id="${id}"`;
  if (samples.length < 10) samples.push({ before: match.slice(0, 160), after: replacement.slice(0, 160) });
  return replacement;
});

console.log(JSON.stringify({ total, applied, skippedHasFor }, null, 2));
console.log('--- samples ---');
for (const s of samples) {
  console.log('BEFORE:', s.before);
  console.log('AFTER :', s.after);
  console.log('');
}

if (!dryRun) {
  fs.writeFileSync(path, html);
  console.log('Written.');
}
