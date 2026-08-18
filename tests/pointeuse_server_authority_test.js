const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '../backend/routes/pointeuse.js'), 'utf8');

assert(
  !/req\.body\.date !== undefined \|\| req\.body\.heure_entree !== undefined/.test(source) &&
  !/code: 'SERVER_TIME_REQUIRED'/.test(source.match(/router\.post\('\/'[\s\S]*?router\.patch\('\/:id\/sortie'/)?.[0] || '') &&
  /const now = new Date\(\);[\s\S]*const d\s+= localDateISO\(now\);[\s\S]*const entree = localTimeHHMM\(now\);/.test(source),
  'Le pointage personnel doit ignorer les horodatages client et utiliser exclusivement la date et l’heure serveur'
);

assert(
  /if \(pointMode !== 'manuel'\)[\s\S]*MODE_REQUIRES_RH_AUTHORIZATION/.test(source),
  'Télétravail et terrain ne doivent pas contourner le contrôle de présence sans autorisation RH'
);

assert(
  /function pointageClientIp\(req\)[\s\S]*return req\.ip \|\| req\.socket\?\.remoteAddress/.test(source) &&
  !/const ip = req\.headers\['x-forwarded-for'\]/.test(source),
  'La pointeuse doit utiliser req.ip configuré par Express plutôt que parser X-Forwarded-For elle-même'
);

assert(
  /retard_tolerance_minutes: safeInt\(p\.pointeuse_retard_tolerance_minutes, 15, 0, 180\)/.test(source) &&
  /statutFromData\(heure_entree, heure_sortie, heure_theorique, mode, toleranceMinutes = 15\)/.test(source) &&
  /entree > theor \+ toleranceMinutes/.test(source),
  'La tolérance de retard doit être paramétrable et validée côté serveur'
);

const sortieRoute = source.match(/router\.patch\('\/:id\/sortie'[\s\S]*?router\.patch\('\/:id'/)?.[0] || '';
assert(
  !/req\.body\.heure_sortie !== undefined[\s\S]*SERVER_TIME_REQUIRED/.test(sortieRoute) &&
  /const sortie = localTimeHHMM\(\);/.test(sortieRoute),
  'La sortie auto-service doit ignorer heure_sortie client et utiliser l’heure serveur'
);

assert(
  /function internalError\(res, error, context\)[\s\S]*Erreur interne de la pointeuse/.test(source) &&
  !/res\.status\(500\)\.json\(\{ error: e\.message \}\)/.test(source),
  'Les erreurs internes de la pointeuse ne doivent pas exposer les messages techniques au client'
);

console.log(JSON.stringify({
  pointeuseServerAuthority: true,
  legacyClientCompatibility: true,
  serverEntryTime: true,
  serverExitTime: true,
  remoteModeGuard: true,
  canonicalClientIp: true,
  configurableLateTolerance: true,
  sanitizedErrors: true,
}));
