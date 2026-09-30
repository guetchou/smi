'use strict';
/*
 * Coquille versionnee — chaque fichier local de dashboard.html porte
 * l'empreinte du deploiement (?v=...). Un onglet recharge juste apres une
 * livraison ne peut plus combiner la nouvelle page avec d'anciens styles ou
 * scripts restes en cache (vu le 30/09/2026).
 */
function versionner(html, empreinte) {
  if (!empreinte) return html;
  const v = encodeURIComponent(empreinte);
  return html.replace(/(<(?:script|link)\b[^>]*\s(?:src|href)=")(\/[^"]+\.(?:js|css))(\?[^"]*)?(")/g,
    (_m, debut, chemin, requete, fin) => `${debut}${chemin}${requete ? requete + '&' : '?'}v=${v}${fin}`);
}

module.exports = { versionner };
