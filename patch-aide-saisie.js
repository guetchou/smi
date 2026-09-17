'use strict';
/* « Tiers mettre autocompletion », « rendre intelligent Libelle comptable, il
   faut orienter, indiquer, guider pour eviter que les utilisateurs remplissent
   n'importe quoi » — 17/09/2026.

   Les deux aides existaient deja. Mesure sur le banc, fenetre d'encaissement
   ouverte depuis l'accueil : _tiersCache = 0 propositions.

   Cause commune, et c'est un defaut de structure : les deux se nourrissaient
   de « window._opsCache », c'est-a-dire des operations qu'un AUTRE ecran avait
   chargees. Ouverte depuis l'accueil, la fenetre ne proposait rien ; ouverte
   apres un passage par Mouvements, elle proposait. L'aide dependait du chemin
   parcouru, pas de ce que la societe a deja ecrit.

   Elles lisent desormais une source qui leur est propre, servie une fois par
   session : les tiers deja employes, et les libelles deja ecrits — rattaches a
   leur rubrique, pour que la proposition suive la rubrique choisie. */
const fs = require('fs');
const path = require('path');
const racine = process.argv[2];

const editer = (fichier, nom, ancien, nouveau, clefs = []) => {
  const p = path.join(racine, fichier);
  const avant = fs.readFileSync(p, 'utf8');
  const n = avant.split(ancien).length - 1;
  if (n !== 1) throw new Error(`${fichier} / « ${nom} » : ${n} occurrence(s), une seule attendue`);
  const apres = avant.replace(ancien, nouveau);
  for (const clef of clefs) {
    if (!apres.includes(clef)) throw new Error(`${fichier} : « ${clef} » manque — refus`);
  }
  fs.writeFileSync(p, apres, 'utf8');
  console.log(`  OK ${fichier} — ${nom} (${avant.length} -> ${apres.length})`);
};

/* ══ 1. La source, cote serveur ══════════════════════════════════════ */
editer('backend/routes/operations.js', 'route d aide a la saisie',
"router.get('/positions', async (req, res) => {",
[
"/* Ce que la societe a deja ecrit, pour aider a ecrire la suite.",
"",
"   Les listes d'aide du formulaire se nourrissaient de « window._opsCache »,",
"   rempli par l'ecran Mouvements : ouverte depuis l'accueil, la fenetre de",
"   saisie ne proposait donc rien. Cette route sert la meme matiere, sans",
"   dependre du chemin parcouru par l'agent.",
"",
"   Les libelles gardent leur rubrique : c'est ce qui permet de proposer",
"   d'abord ce qui a deja ete ecrit SOUS la rubrique choisie, plutot qu'un",
"   melange de tout. */",
"router.get('/aide-saisie', async (req, res, next) => {",
"  try {",
"    const tiers = await db.query(",
"      \"SELECT DISTINCT tiers FROM operations WHERE tiers IS NOT NULL AND tiers <> '' ORDER BY tiers LIMIT 200\");",
"    const libelles = await db.query(",
"      \"SELECT type_op, categorie_id, libelle, MAX(id) AS dernier FROM operations \" +",
"      \"WHERE libelle IS NOT NULL AND libelle <> '' \" +",
"      \"GROUP BY type_op, categorie_id, libelle ORDER BY dernier DESC LIMIT 300\");",
"    res.json({",
"      tiers: tiers.map(t => t.tiers),",
"      libelles: libelles.map(l => ({ type_op: l.type_op, categorie_id: l.categorie_id, libelle: l.libelle })),",
"    });",
"  } catch (error) { next(error); }",
"});",
"",
"router.get('/positions', async (req, res) => {",
].join('\n'),
["router.get('/:id/historique'", "router.get('/kpis/summary'"]);

/* ══ 2. Le cache cote navigateur ═════════════════════════════════════ */
editer('frontend/dashboard.html', 'cache des tiers',
[
"function buildTiersCache() {",
"  const fromOps = (window._opsCache || []).map(o => o.tiers).filter(Boolean);",
"  const fromFourn = fournisseurs.map(f => f.nom).filter(Boolean);",
"  _tiersCache = [...new Set([...fromOps, ...fromFourn])].sort();",
"}",
].join('\n'),
[
"/* ── L'aide a la saisie, servie une fois par session ─────────────────────",
"   Les deux listes du formulaire — tiers et libelles — se nourrissaient de",
"   « window._opsCache », rempli par l'ecran Mouvements. Ouverte depuis",
"   l'accueil, la fenetre de saisie ne proposait rien : l'aide dependait du",
"   chemin parcouru. Elle lit desormais sa propre source. */",
"let _aideSaisie = null;",
"let _aideSaisieEnCours = null;",
"",
"async function chargerAideALaSaisie() {",
"  if (_aideSaisie) return _aideSaisie;",
"  if (_aideSaisieEnCours) return _aideSaisieEnCours;",
"  _aideSaisieEnCours = (async () => {",
"    /* Un echec ne doit rien casser : sans source, la frappe libre reste",
"       entiere, exactement comme avant. */",
"    const d = await api('/operations/aide-saisie').catch(() => null);",
"    _aideSaisie = d && Array.isArray(d.tiers) ? d : { tiers: [], libelles: [] };",
"    _tiersCache = [];",
"    _aideSaisieEnCours = null;",
"    return _aideSaisie;",
"  })();",
"  return _aideSaisieEnCours;",
"}",
"",
"function buildTiersCache() {",
"  /* Quatre sources, des la premiere ouverture : les tiers deja employes, les",
"     fournisseurs, les employes, et les operations que l'ecran a sous la main.",
"     Un client paie, un employe recoit une avance : les deux sont des tiers. */",
"  const deLaBase = (_aideSaisie && _aideSaisie.tiers) || [];",
"  const desOps = (window._opsCache || []).map(o => o.tiers).filter(Boolean);",
"  const desFournisseurs = (fournisseurs || []).map(f => f.nom).filter(Boolean);",
"  const desEmployes = (employes || [])",
"    .map(e => [e.prenom, e.nom].filter(Boolean).join(' ').trim())",
"    .filter(Boolean);",
"  _tiersCache = [...new Set([...deLaBase, ...desOps, ...desFournisseurs, ...desEmployes])].sort();",
"}",
].join('\n'),
['function tiersSearch(', 'let _tiersCache']);

/* ══ 3. Les propositions posees par le DOM ═══════════════════════════ */
editer('frontend/dashboard.html', 'propositions de tiers en texte',
[
"  drop.innerHTML = matches.map(t =>",
"    `<div class=\"autocomplete-item\" onmousedown=\"event.preventDefault();document.getElementById('${inputId}').value='${t.replace(/'/g, \"\\\\'\")}';document.getElementById('${dropId}').classList.add('hidden')\">${t}</div>`",
"  ).join('');",
"  drop.classList.remove('hidden');",
].join('\n'),
[
"  /* Ces noms sont saisis par des agents et relus depuis la base : ils sont",
"     poses en texte, jamais en HTML. Un tiers nomme « Ets <b>X</b> » doit",
"     s'afficher tel quel, pas s'executer — et une apostrophe ne doit pas",
"     casser le gestionnaire. */",
"  drop.replaceChildren();",
"  for (const t of matches) {",
"    const item = document.createElement('div');",
"    item.className = 'autocomplete-item';",
"    item.textContent = t;",
"    item.addEventListener('mousedown', evenement => {",
"      evenement.preventDefault();",
"      inp.value = t;",
"      drop.classList.add('hidden');",
"      inp.dispatchEvent(new Event('input', { bubbles: true }));",
"    });",
"    drop.appendChild(item);",
"  }",
"  drop.classList.remove('hidden');",
].join('\n'),
['function tiersSearch(']);

/* ══ 4. Les libelles suivent la rubrique choisie ═════════════════════ */
editer('frontend/dashboard.html', 'source des libelles',
[
"function motifsDejaEmployes(typeOp) {",
"  const ops = Array.isArray(window._opsCache) ? window._opsCache : [];",
"  const vus = ops",
"    .filter(o => o && o.type_op === typeOp)",
"    .map(o => String(o.libelle || o.detail || '').trim())",
"    .filter(Boolean);",
"  return [...new Set(vus)].sort().slice(0, 40);",
"}",
].join('\n'),
[
"function motifsDejaEmployes(typeOp, rubriqueId) {",
"  /* Ce qui a deja ete ecrit SOUS la rubrique choisie vient en tete : c'est la",
"     ce qui oriente vraiment. Le reste du meme type d'operation suit, pour que",
"     la liste ne soit pas vide tant qu'aucune rubrique n'est choisie. */",
"  const deLaBase = ((_aideSaisie && _aideSaisie.libelles) || [])",
"    .filter(l => l && l.type_op === typeOp);",
"  const desOps = (Array.isArray(window._opsCache) ? window._opsCache : [])",
"    .filter(o => o && o.type_op === typeOp)",
"    .map(o => ({ categorie_id: o.categorie_id, libelle: String(o.libelle || o.detail || '').trim() }));",
"  const tout = [...deLaBase, ...desOps].filter(l => l.libelle);",
"  const rub = rubriqueId ? String(rubriqueId) : '';",
"  const sousLaRubrique = rub ? tout.filter(l => String(l.categorie_id || '') === rub) : [];",
"  const ordonnes = [...sousLaRubrique.map(l => l.libelle), ...tout.map(l => l.libelle)];",
"  return [...new Set(ordonnes)].slice(0, 40);",
"}",
].join('\n'),
["brancherAutocompletion('vir-libelle'", 'function brancherAutocompletion(']);

/* ══ 5. Les deux autres libelles sont assistes a leur tour ═══════════ */
editer('frontend/dashboard.html', 'branchement de l encaissement',
"async function openEncaissementModal(op = null) {\n  await ensureMeta(!op);",
[
"async function openEncaissementModal(op = null) {",
"  /* Sans attendre : l'aide arrive quand elle arrive, la frappe n'est jamais",
"     retenue par elle. */",
"  chargerAideALaSaisie();",
"  brancherAutocompletion('enc-libelle',",
"    () => motifsDejaEmployes('encaissement', document.getElementById('enc-rubrique')?.value));",
"  await ensureMeta(!op);",
].join('\n'),
["document.getElementById('enc-libelle')"]);

editer('frontend/dashboard.html', 'branchement du decaissement',
"async function openDecaissementModal(op = null) {\n  await ensureMeta(!op);",
[
"async function openDecaissementModal(op = null) {",
"  chargerAideALaSaisie();",
"  brancherAutocompletion('dec-libelle',",
"    () => motifsDejaEmployes('decaissement', document.getElementById('dec-rubrique')?.value));",
"  await ensureMeta(!op);",
].join('\n'),
["document.getElementById('dec-libelle')"]);

editer('frontend/dashboard.html', 'aide chargee aussi pour le virement',
"  brancherAutocompletion('vir-libelle', () => motifsDejaEmployes('virement'));",
[
"  chargerAideALaSaisie();",
"  brancherAutocompletion('vir-libelle', () => motifsDejaEmployes('virement'));",
].join('\n'),
['function brancherAutocompletion(']);
