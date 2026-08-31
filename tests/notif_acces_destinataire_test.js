const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const route = fs.readFileSync(path.join(root, 'backend/routes/notifs.js'), 'utf8');

/* ── Qui reçoit un rappel doit pouvoir le consulter ──
   L'onglet Rappels repondait « Accès refusé » au Directeur General :
   GET /api/notifs/rappels -> 403, constate a l'ecran le 31/08/2026.

   Or le DG est le premier destinataire declare des quatre rappels fiscaux —
   roles_dest ["dg","admin","finance"] pour RAP_DGI_MENSUEL, RAP_IS_ACOMPTE et
   RAP_DECLARATION_STAT, ["dg","admin","finance","rh"] pour RAP_CNSS_TRIMESTRE —
   et la cible de leurs escalades, escalade_roles ["dg","admin"] pour les quatre.
   34 rappels lui etaient personnellement adresses en base.

   Il recevait donc les rappels sans pouvoir ni les lister ni les acquitter. */

const gardes = [...route.matchAll(/if \(!hasRole\(req\.user,([^)]*)\)\)/g)].map(m => m[1]);
assert(gardes.length >= 3, `Trois gardes de role attendues dans ce module, ${gardes.length} trouvee(s)`);

for (const garde of gardes) {
  assert(
    /'dg'/.test(garde),
    `Une garde du module notifications exclut le DG : hasRole(req.user,${garde}). ` +
    'Le DG figure parmi les destinataires et les cibles d escalade des rappels fiscaux.'
  );
}

/* Les routes concernees, nommement, pour que le lien avec le symptome reste
   lisible si la structure du fichier change. */
for (const [nom, motif] of [
  ['liste des rappels', /router\.get\('\/rappels', async \(req, res\) => \{\s*\n\s*try \{\s*\n(?:[^\n]*\n)*?[^\n]*hasRole\(req\.user, 'admin', 'dg'/],
  ['acquittement', /router\.patch\('\/rappels\/:id\/acquitter'[\s\S]{0,400}?hasRole\(req\.user, 'admin', 'dg'/],
]) {
  assert(motif.test(route), `Le DG doit etre autorise sur : ${nom}`);
}

/* Aucun role legitime ne doit avoir ete retire au passage. */
for (const role of ["'admin'", "'rh'", "'finance'", "'caissier'"]) {
  assert(
    route.includes(role),
    `Le role ${role} a disparu des gardes : l elargissement ne doit rien retirer`
  );
}

console.log(JSON.stringify({
  everyGuardIncludesDg: true,
  listAndAcknowledgeOpenToRecipient: true,
  noExistingRoleRemoved: true,
  guardsChecked: gardes.length,
}));
