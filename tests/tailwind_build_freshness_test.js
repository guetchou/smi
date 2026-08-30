const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');

/* ── 1. Le CLI v4 ne doit pas détourner le binaire d'un projet en v3 ──
   @tailwindcss/cli v4 fournit lui aussi un binaire « tailwindcss ». Installé
   à côté de tailwindcss v3, il le remplaçait dans node_modules/.bin et
   ignorait tailwind.config.js : le build produisait un fichier faux, en
   silence, et personne ne régénérait plus la feuille de style. */
const pkg = JSON.parse(read('package.json'));
assert(
  !pkg.devDependencies['@tailwindcss/cli'],
  'Le CLI Tailwind v4 ne doit pas coexister avec tailwindcss v3 : il détourne le binaire'
);
assert(
  /^\^?3\./.test(pkg.devDependencies.tailwindcss || ''),
  'Le projet est configuré en Tailwind v3 (tailwind.config.js, directives @tailwind)'
);
assert(/@tailwind base;/.test(read('frontend/tailwind.input.css')), 'La feuille source doit rester en syntaxe v3');
assert(/content:\s*\[/.test(read('tailwind.config.js')), 'La configuration v3 doit déclarer les sources scannées');

/* ── 2. La feuille compilée doit être à jour ──
   nginx sert /tailwind.css depuis le worktree, pas depuis le conteneur : un
   fichier versionné périmé est directement ce que reçoit le navigateur. */
const compiled = read('frontend/tailwind.css');
const tmp = path.join(os.tmpdir(), 'tailwind-freshness-' + process.pid + '.css');

let rebuilt;
try {
  execFileSync(
    process.execPath,
    [path.join(root, 'node_modules/tailwindcss/lib/cli.js'), '-i', 'frontend/tailwind.input.css', '-o', tmp, '--minify'],
    { cwd: root, stdio: 'pipe' }
  );
  rebuilt = fs.readFileSync(tmp, 'utf8');
} finally {
  try { fs.unlinkSync(tmp); } catch (_) { /* fichier temporaire */ }
}

assert.strictEqual(
  compiled.length,
  rebuilt.length,
  `frontend/tailwind.css est périmé (${compiled.length} octets contre ${rebuilt.length} attendus). `
  + 'Régénérer avec : npm run build:css'
);
assert.strictEqual(compiled, rebuilt, 'frontend/tailwind.css diffère de sa régénération : lancer npm run build:css');

/* ── 3. Le Dockerfile doit construire après la copie des sources ──
   Construire avant laisse Tailwind sans markup à scanner, et le COPY suivant
   écrase le résultat par le fichier versionné. */
const dockerfile = read('Dockerfile');
const posCopy = dockerfile.indexOf('COPY . .');
const posBuild = dockerfile.indexOf('tailwindcss -i frontend/tailwind.input.css');
assert(posCopy !== -1 && posBuild !== -1, 'Le Dockerfile doit copier les sources et construire la feuille de style');
assert(
  posBuild > posCopy,
  'La feuille de style doit être construite après COPY . ., sinon elle est générée à vide puis écrasée'
);

/* ── 4. Les variantes responsives réellement utilisées doivent exister ── */
const html = read('frontend/dashboard.html');
const utilisees = new Set();
for (const attr of html.matchAll(/class="([^"]*)"/g)) {
  for (const cls of attr[1].split(/\s+/)) {
    if (/^(sm|md|lg|xl|2xl):(grid-cols|flex|block|hidden|col-span|px|py|text)-?[a-z0-9-]*$/.test(cls)) utilisees.add(cls);
  }
}
assert(utilisees.size > 5, `Extraction des variantes trop pauvre : ${utilisees.size}`);
const manquantes = [...utilisees].filter(cls => !compiled.includes('.' + cls.replace(':', '\\:')));
assert.deepStrictEqual(manquantes, [], `Variantes utilisées mais absentes du CSS compilé : ${manquantes.join(', ')}`);

console.log(JSON.stringify({
  noV4CliHijack: true,
  compiledCssUpToDate: true,
  dockerBuildsAfterSources: true,
  responsiveVariantsPresent: true,
  variantsChecked: utilisees.size,
}));
