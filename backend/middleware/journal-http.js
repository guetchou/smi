'use strict';
/*
 * Journal des requetes HTTP.
 *
 * Pourquoi il existe. Le 18/09/2026, deux decaissements sont restes bloques
 * en brouillon et l'enquete s'est faite a l'aveugle : « docker logs --since
 * 72h » ne rendait que 59 lignes, toutes issues des migrations. Aucune
 * requete, aucun statut, aucune erreur. Le conteneur ayant ete recree a
 * 13:59:32, la fenetre 13:28–13:32 ou les deux saisies avaient eu lieu etait
 * en outre detruite. Il a fallu reconstituer l'incident a partir du seul etat
 * final en base.
 *
 * Ce qu'il ne refait pas. « validationDiagnostic » (backend/server.js) tient
 * deja le journal des REFUS : il ecrit « [VALIDATION-DIAG] » et une ligne
 * « refus_saisie » dans audit_logs. Mais il n'habille que res.json, ignore les
 * GET, ignore les 401, ignore les succes, et ne voit pas une requete arretee
 * avant tout gestionnaire. Celui-ci observe la fin de CHAQUE reponse, quelle
 * que soit la methode qui la rend.
 *
 * Ou il ecrit. Dans backend/data, qui est le SEUL volume monte du conteneur
 * (docker inspect : caisse-topcenter_caisse_data -> /app/backend/data). La
 * sortie standard, elle, meurt avec le conteneur — c'est exactement ce qui
 * s'est passe. On ecrit donc aux deux endroits : sur la sortie pour le suivi
 * en direct, sur le volume pour l'enquete d'apres.
 *
 * Ce qu'il n'ecrit jamais. Ni corps de requete, ni en-tete, ni chaine de
 * requete. Un mot de passe part dans le corps de /api/auth/login, un jeton
 * dans l'en-tete Authorization, et une donnee personnelle peut se trouver
 * dans une chaine de requete. Le journal des refus prend deja ces precautions
 * (safeBodyShape ne rend que des formes) ; celui-ci ne les defait pas par la
 * porte de derriere.
 */
const fs = require('fs');
const path = require('path');

/* Au-dela, le fichier courant devient « .1 » et un nouveau commence. Deux
   fichiers au plus : un journal qui grossit sans fin sature le volume, et
   c'est alors l'application qui tombe — un remede pire que le mal. */
const TAILLE_MAX = Number(process.env.SMI_JOURNAL_HTTP_TAILLE || 5 * 1024 * 1024);

const DOSSIER = path.join(__dirname, '..', 'data');
const FICHIER = path.join(DOSSIER, 'journal-http.log');
const PRECEDENT = FICHIER + '.1';

let octetsEcrits = 0;
let ecritureImpossible = false;

function preparer() {
  try {
    fs.mkdirSync(DOSSIER, { recursive: true });
    octetsEcrits = fs.existsSync(FICHIER) ? fs.statSync(FICHIER).size : 0;
  } catch (error) {
    /* Le disque peut etre plein ou le volume absent : on le dit une fois, et
       on continue sans fichier. Observer ne doit jamais empecher de servir. */
    console.error('[journal-http] fichier indisponible :', error.message);
    ecritureImpossible = true;
  }
}

function tourner() {
  try {
    if (fs.existsSync(PRECEDENT)) fs.unlinkSync(PRECEDENT);
    fs.renameSync(FICHIER, PRECEDENT);
  } catch (error) {
    console.error('[journal-http] rotation impossible :', error.message);
  }
  octetsEcrits = 0;
}

function ecrire(ligne) {
  if (ecritureImpossible) return;
  try {
    if (octetsEcrits >= TAILLE_MAX) tourner();
    octetsEcrits += Buffer.byteLength(ligne);
    fs.appendFile(FICHIER, ligne, erreur => {
      if (!erreur || ecritureImpossible) return;
      ecritureImpossible = true;
      console.error('[journal-http] ecriture impossible, journal suspendu :', erreur.message);
    });
  } catch (error) {
    ecritureImpossible = true;
    console.error('[journal-http] ecriture impossible, journal suspendu :', error.message);
  }
}

/* Une requete est retenue si elle vise l'API — c'est ce qu'on vient lire —
   ou si elle a echoue. Les fichiers statiques servis avec succes sont ecartes :
   journaliser chaque image noierait les appels d'API. */
function retenir(chemin, statut) {
  return chemin.startsWith('/api') || statut >= 400;
}

function journalHttp() {
  preparer();
  return function observer(req, res, next) {
    const debut = process.hrtime.bigint();
    res.on('finish', () => {
      try {
        /* La chaine de requete est coupee ici, comme le fait journaliserRefus
           dans server.js : une donnee personnelle peut s'y trouver. */
        const chemin = String(req.originalUrl || '').split('?')[0].slice(0, 300);
        if (!retenir(chemin, res.statusCode)) return;
        const duree_ms = Number((process.hrtime.bigint() - debut) / 1000000n);
        const ligne = JSON.stringify({
          t: new Date().toISOString(),
          method: req.method,
          url: chemin,
          status: res.statusCode,
          duree_ms,
          user_id: req.user?.id || null,
          ip: req.ip || null,
        }) + '\n';
        console.log('[HTTP]', ligne.trimEnd());
        ecrire(ligne);
      } catch (error) {
        /* Le principe est celui de server.js, au-dessus de journaliserRefus :
           « L'ecriture ne doit jamais faire echouer la requete qu'elle
           observe. » Ici la reponse est deja partie ; on se tait proprement. */
        console.error('[journal-http] observation impossible :', error.message);
      }
    });
    next();
  };
}

module.exports = { journalHttp, FICHIER, TAILLE_MAX };
