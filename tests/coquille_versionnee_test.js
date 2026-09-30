'use strict';
/*
 * Garde — une coquille livree ne se sert jamais d'anciens styles.
 *
 * Vu le 30/09/2026 : apres un deploiement, l'onglet voit l'empreinte changer
 * et se recharge aussitot (dashboard.html est en no-store) ; tailwind.css et
 * les scripts, eux, restaient 5 minutes en cache. Nouvelle page, anciens
 * styles : classes manquantes, mise en page defaite sur toutes les pages.
 * Chaque fichier local de la coquille porte donc l'empreinte du deploiement.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { versionner } = require('../backend/services/coquille');

const html = '<link rel="stylesheet" href="/tailwind.css">\n'
  + '<link rel="manifest" href="/manifest.json">\n'
  + '<script src="/js/core/navigation.js"></script>\n'
  + '<script src="https://cdn.example.org/lib.js"></script>\n'
  + '<script src="/js/pages/x.js?deja=1"></script>';
const sortie = versionner(html, '1550100-17593');

assert.ok(sortie.includes('href="/tailwind.css?v=1550100-17593"'), 'la feuille de style porte l empreinte');
assert.ok(sortie.includes('src="/js/core/navigation.js?v=1550100-17593"'), 'les scripts locaux portent l empreinte');
assert.ok(sortie.includes('src="/js/pages/x.js?deja=1&v=1550100-17593"'), 'une adresse avec parametre garde le sien');
assert.ok(sortie.includes('src="https://cdn.example.org/lib.js"'), 'les fichiers externes ne sont pas touches');
assert.ok(sortie.includes('href="/manifest.json"'), 'le manifeste garde son adresse');
assert.strictEqual(versionner(html, null), html, 'sans empreinte, la page est servie telle quelle');

const serveur = fs.readFileSync(path.join(__dirname, '..', 'backend', 'server.js'), 'utf8');
assert.ok(/app\.get\(\['\/app', '\/app\/\*'\][\s\S]{0,200}coquilleVersionnee\(\)/.test(serveur),
  'Les routes /app servent la coquille versionnee, pas le fichier brut');
assert.ok(/'\/dashboard\.html'[\s\S]{0,400}coquilleVersionnee\(\)/.test(serveur),
  '/dashboard.html sert la coquille versionnee');
console.log('coquille_versionnee_test: OK');
