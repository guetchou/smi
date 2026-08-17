/**
 * Service PDF partagé — TOP CENTER
 * Génération de PDFs via wkhtmltopdf.
 * Utilisé par : salaires.js, offboarding.js, agents.js (attestations)
 */
const { spawn } = require('child_process');
const os   = require('os');
const path = require('path');
const fs   = require('fs');
const { renderProfessionalPayrollHtml } = require('./payroll_pdf_layout');

/**
 * Convertit du HTML en PDF (Buffer) via wkhtmltopdf.
 * @param {string} htmlContent   HTML complet (<!DOCTYPE html>…)
 * @param {object} [opts]        Options wkhtmltopdf (marginTop, marginBottom, …)
 * @returns {Promise<Buffer>}
 */
function generatePdf(htmlContent, opts = {}) {
  return new Promise((resolve, reject) => {
    const prefix  = opts.prefix || 'doc';
    const renderedHtml = prefix === 'bul'
      ? renderProfessionalPayrollHtml(htmlContent)
      : htmlContent;
    const tmpHtml = path.join(os.tmpdir(), `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}.html`);
    const tmpPdf  = tmpHtml.replace('.html', '.pdf');

    try {
      fs.writeFileSync(tmpHtml, renderedHtml, 'utf8');
    } catch (err) {
      return reject(new Error('Impossible d\'écrire le fichier HTML temporaire : ' + err.message));
    }

    const args = [
      '--quiet',
      '--page-size',     opts.pageSize     || 'A4',
      '--margin-top',    opts.marginTop    || '12mm',
      '--margin-bottom', opts.marginBottom || '12mm',
      '--margin-left',   opts.marginLeft   || '14mm',
      '--margin-right',  opts.marginRight  || '14mm',
      '--encoding', 'UTF-8',
      '--disable-smart-shrinking',
      tmpHtml, tmpPdf,
    ];

    const proc = spawn('wkhtmltopdf', args);

    proc.on('close', code => {
      try { fs.unlinkSync(tmpHtml); } catch (_) {}
      if (code !== 0) {
        try { fs.unlinkSync(tmpPdf); } catch (_) {}
        return reject(new Error(`wkhtmltopdf a échoué (code ${code})`));
      }
      if (!fs.existsSync(tmpPdf))
        return reject(new Error('PDF non généré par wkhtmltopdf'));
      const buf = fs.readFileSync(tmpPdf);
      try { fs.unlinkSync(tmpPdf); } catch (_) {}
      resolve(buf);
    });

    proc.on('error', err => {
      try { fs.unlinkSync(tmpHtml); } catch (_) {}
      reject(new Error('wkhtmltopdf introuvable sur ce système : ' + err.message));
    });
  });
}

module.exports = { generatePdf };
