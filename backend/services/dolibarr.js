'use strict';
/*
 * Client de l'API de Dolibarr — ADR 0002.
 *
 * Dolibarr fait foi pour la comptabilité mais n'est jamais montré : Tala SMI
 * lit et écrit le grand livre par le module « smi » (integrations/dolibarr).
 * Rien de ce qui sort d'ici ne nomme Dolibarr à l'écran : les routes rendent
 * des messages qui existent déjà dans l'application.
 *
 * Configuration (.env, transmise par docker-compose.yml) :
 *   DOLIBARR_URL      adresse de base, sans /api
 *   DOLIBARR_API_KEY  clé d'API d'un utilisateur Dolibarr dédié
 *   DOLIBARR_ENTITE   societe (entite) de Top Center dans l'instance partagee
 *                     (decision du 29/09/2026) ; envoyee a chaque appel
 * Sans les deux, configure() vaut faux et les écrans actuels restent en place.
 */
const DELAI_MS = Number(process.env.DOLIBARR_DELAI_MS || 8000);

class DolibarrError extends Error {
  constructor(code, message, statusHttp, details) {
    super(message);
    this.code = code;
    this.statusHttp = statusHttp;
    this.details = details;
  }
}

function config() {
  const url = String(process.env.DOLIBARR_URL || '').trim().replace(/\/+$/, '');
  const cle = String(process.env.DOLIBARR_API_KEY || '').trim();
  const entite = /^[0-9]+$/.test(String(process.env.DOLIBARR_ENTITE || '').trim()) ? String(process.env.DOLIBARR_ENTITE).trim() : '';
  return { url, cle, entite, configure: Boolean(url && cle) };
}

const configure = () => config().configure;

async function appeler(chemin, { method = 'GET', query = {}, body } = {}) {
  const c = config();
  if (!c.configure) throw new DolibarrError('NON_CONFIGURE', 'Connexion comptable non configuree', 503);
  const url = new URL(`${c.url}/api/index.php/${String(chemin).replace(/^\/+/, '')}`);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const controle = new AbortController();
  const minuterie = setTimeout(() => controle.abort(), DELAI_MS);
  try {
    const reponse = await fetch(url, {
      method,
      headers: {
        DOLAPIKEY: c.cle,
        // Sans lui, l'API travaille dans l'entite de l'utilisateur ; avec lui,
        // une cle rattachee a une autre societe ne peut pas s'y tromper.
        ...(c.entite ? { DOLAPIENTITY: c.entite } : {}),
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controle.signal,
    });
    const texte = await reponse.text();
    let donnees = null;
    try { donnees = texte ? JSON.parse(texte) : null; } catch (_) { donnees = null; }
    if (!reponse.ok) {
      const message = donnees?.error?.message || `HTTP ${reponse.status}`;
      // 422 : la demande est refusée pour une raison métier (pièce déséquilibrée…).
      // Le reste (clé refusée, erreur interne) : le service est indisponible pour Tala SMI.
      throw new DolibarrError(reponse.status === 422 ? 'REFUS' : `HTTP_${reponse.status}`, message, reponse.status === 422 ? 422 : 502, donnees?.error);
    }
    return donnees;
  } catch (e) {
    if (e instanceof DolibarrError) throw e;
    if (e.name === 'AbortError') throw new DolibarrError('DELAI', `Aucune reponse en ${DELAI_MS} ms`, 504);
    throw new DolibarrError('INJOIGNABLE', e.message, 502);
  } finally {
    clearTimeout(minuterie);
  }
}

module.exports = {
  DolibarrError,
  configure,
  etatGrandLivre: () => appeler('smi/etat'),
  exercices: () => appeler('smi/exercices'),
  grandLivre: ({ du, au, journal, compte } = {}) => appeler('smi/grandlivre', {
    query: { date_debut: du, date_fin: au, journal, compte },
  }),
  ecrirePiece: piece => appeler('smi/pieces', { method: 'POST', body: piece }),
};
