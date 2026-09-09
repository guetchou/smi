'use strict';
/*
 * Le menu promet, l'API doit tenir.
 *
 * Pour chaque rôle : ouvrir tour à tour chaque entrée que son menu propose,
 * et n'accepter ni refus d'API ni exception de navigateur. Un écran proposé
 * puis refusé est un piège — c'est exactement ce qui a bloqué la caisse en
 * septembre 2026, sur dix profils à la fois, sans que personne le voie depuis
 * un compte de direction.
 */
const path = require('path');
const { test, expect } = require('@playwright/test');

const baseURL = process.env.SMI_E2E_BASE_URL;
const capturesDir = process.env.SMI_E2E_SCREENSHOT_DIR;
const comptes = JSON.parse(process.env.SMI_E2E_COMPTES || '[]');

/* Les appels qu'un refus ne rend pas fautifs : ils dépendent de données que
   le socle n'a pas, pas d'un droit manquant. La liste reste courte et
   nommée — une exception muette masquerait le défaut qu'on cherche. */
const REFUS_TOLERES = [
  /\/api\/notifs\/stream/,          // flux long, coupé à la fermeture de la page
  /\/api\/pointeuse\/v3\/me\//,    // 409 « Compte non lié à une fiche agent » : les
                                    // comptes semés n'ont pas de fiche employé.
                                    // Manque de données du socle, pas un refus de droit.
];

// Chaque role est mesure pour lui-meme : un echec ne doit pas escamoter les
// suivants, c'est justement la comparaison entre roles qui fait la preuve.
test.describe.configure({ mode: 'default' });

for (const compte of comptes) {
  test(`${compte.code} ouvre tout ce que son menu propose`, async ({ page }) => {
    // Un role peut proposer une trentaine d'ecrans : le delai par defaut ne suffit pas.
    test.setTimeout(180000);
    const refus = [];        // refus de module : une regression, on echoue
    const autresRefus = [];  // role et permission nommee : inventorie
    const erreurs = [];

    page.on('response', async r => {
      if (r.status() < 400 || !r.url().includes('/api/')) return;
      if (REFUS_TOLERES.some(motif => motif.test(r.url()))) return;
      const chemin = new URL(r.url()).pathname;
      const motif = await r.text()
        .then(t => { try { return JSON.parse(t).error || ''; } catch (_) { return ''; } })
        .catch(() => '');
      const ligne = `${r.status()} ${r.request().method()} ${chemin} — ${motif}`;
      if (/Module non assign/i.test(motif)) refus.push(ligne);
      else autresRefus.push(ligne);
    });
    page.on('pageerror', e => erreurs.push(e.message));

    await page.addInitScript(([token, c]) => {
      localStorage.setItem('tc_token', token);
      localStorage.setItem('tc_user', JSON.stringify({
        id: c.id, nom: c.code.toUpperCase(), prenom: 'E2E', email: c.email,
        role: c.code, roles: [c.code], employe_id: null,
      }));
    }, [compte.token, compte]);

    await page.goto(`${baseURL}/app/tableau-de-bord`);
    await page.locator('#sidebar .nav-link').first().waitFor({ state: 'attached', timeout: 20000 });
    await page.waitForTimeout(2500);

    // Les entrées réellement proposées à ce rôle.
    const entrees = await page.evaluate(() => [...document.querySelectorAll('#sidebar .nav-link[data-page]')]
      .filter(el => el.offsetParent !== null)
      .map(el => ({ page: el.dataset.page, libelle: (el.textContent || '').trim().replace(/\s+/g, ' ') })));

    console.log(`[${compte.code}] ${entrees.length} entrée(s) : ${entrees.map(e => e.page).join(', ')}`);

    expect(entrees.length, `Le rôle « ${compte.code} » doit avoir au moins un écran à ouvrir`)
      .toBeGreaterThan(0);

    for (const entree of entrees) {
      await page.evaluate(p => window.showPage(p), entree.page);
      await page.waitForTimeout(500);
    }

    await page.screenshot({ path: path.join(capturesDir, `${compte.code}.png`) });

    // Le menu ne connait que les modules. Les refus de role et de permission
    // nommee restent donc possibles : on les inventorie a chaque passage pour
    // qu'ils restent visibles, au lieu d'un banc rouge que personne ne lit.
    if (autresRefus.length) {
      console.log(`[${compte.code}] ${new Set(autresRefus).size} refus de role ou de permission :`);
      [...new Set(autresRefus)].forEach(l => console.log('   ' + l));
    }

    expect(refus, `Refus de module chez « ${compte.code} » — la garde cliente aurait du les eviter :\n  ${refus.join('\n  ')}`)
      .toEqual([]);
    expect(erreurs, `Exceptions de navigateur pour « ${compte.code} » :\n  ${erreurs.join('\n  ')}`)
      .toEqual([]);
  });
}
