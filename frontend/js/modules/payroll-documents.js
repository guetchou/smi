(function () {
  'use strict';

  const EMAIL_BUTTON_HTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg> Envoyer par email';
  const PDF_BUTTON_HTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 002 2z"/></svg> PDF';
  const GROUP_BUTTON_HTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 002 2v10a2 2 0 002 2z"/></svg> Envoyer bulletins';

  function create(options = {}) {
    const doc = options.document || window.document;
    const request = options.request;
    const fetchImpl = options.fetchImpl || window.fetch.bind(window);
    const getToken = options.getToken || (() => '');
    const confirmAction = options.confirmAction || (async () => false);
    const promptAction = options.promptAction || (async () => null);
    const notify = options.notify || (() => {});
    const alertAction = options.alertAction || (() => {});
    const reload = options.reload || (() => {});
    const monthNames = options.monthNames || [];
    const apiBase = options.apiBase || '/api';

    function byId(id) {
      return doc.getElementById(id);
    }

    function requireRequest() {
      if (typeof request !== 'function') {
        throw new Error('TalaPayrollDocuments: request adapter requis');
      }
    }

    function currentPeriod() {
      return {
        mois: Number.parseInt(byId('sal-mois')?.value, 10),
        annee: Number.parseInt(byId('sal-annee')?.value, 10),
      };
    }

    function displayGroupSummary(result, monthName, year) {
      const line = (color, label, value) =>
        `<div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid #f1f5f9">` +
        `<span style="flex:1;color:#475569;font-size:13px">${label}</span>` +
        `<strong style="color:${color};font-size:14px">${value}</strong></div>`;
      let detail = '';
      if (result.detail?.echecs?.length) {
        detail += '<div style="margin-top:12px;font-size:12px;color:#ef4444;font-weight:600">Échecs :</div>';
        detail += result.detail.echecs.map(item =>
          `<div style="font-size:11px;color:#64748b;padding:2px 0">${item.nom} &lt;${item.email}&gt; — ${item.erreur}</div>`
        ).join('');
      }
      if (result.detail?.sans_email?.length) {
        detail += '<div style="margin-top:10px;font-size:12px;color:#64748b;font-weight:600">Sans email :</div>';
        detail += result.detail.sans_email.map(item =>
          `<div style="font-size:11px;color:#64748b;padding:2px 0">${item.nom}</div>`
        ).join('');
      }
      if (result.detail?.ignores?.length) {
        detail += '<div style="margin-top:10px;font-size:12px;color:#64748b;font-weight:600">Ignorés :</div>';
        detail += result.detail.ignores.map(item =>
          `<div style="font-size:11px;color:#64748b;padding:2px 0">${item.nom} — ${item.raison}</div>`
        ).join('');
      }
      if (result.limite_pdf) {
        detail += `<div style="margin-top:10px;font-size:11px;color:#b45309;padding:8px;background:#fffbeb;border-radius:6px">${result.limite_pdf}</div>`;
      }
      const html = `<div style="min-width:320px">
        ${line('#059669', 'Envoyés avec PDF', result.envoyes)}
        ${line('#dc2626', 'Échecs', result.echecs)}
        ${line('#64748b', 'Ignorés', result.ignores)}
        ${line('#b45309', 'Sans email', result.sans_email)}
        ${result.sans_pdf ? line('#c2410c', 'PDF manquant', result.sans_pdf) : ''}
        <div style="display:flex;padding:8px 0;margin-top:4px">
          <span style="flex:1;color:#1e293b;font-weight:700;font-size:13px">Total bulletins payés</span>
          <strong style="font-size:15px">${result.total_bulletins}</strong>
        </div>
        ${detail}
        ${result.peut_renvoyer_echecs ? `<div style="margin-top:14px;padding:10px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;font-size:12px;color:#b91c1c">
          Des échecs ont été enregistrés.
          <button onclick="closeCurrentAlert?.();envoyerBulletinsGroupe({seulement_echecs:true})"
            style="display:block;margin-top:6px;background:#b91c1c;color:#fff;border:none;padding:5px 12px;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600">
            Renvoyer les échecs uniquement
          </button>
        </div>` : ''}
      </div>`;
      alertAction(html, `Résumé envoi — ${monthName} ${year}`);
    }

    async function sendGroup(sendOptions = {}) {
      requireRequest();
      const { mois, annee } = currentPeriod();
      const monthName = monthNames[mois] || mois;
      const report = await request(`/salaires/rapport?mois=${mois}&annee=${annee}`);
      if (!report) return false;
      const paid = (report.employes || []).filter(row => row.bulletin?.statut === 'paye');
      const withEmail = paid.filter(row => row.email?.includes('@'));
      const withoutEmail = paid.filter(row => !row.email?.includes('@'));
      if (!paid.length) {
        notify(`Aucun bulletin payé pour ${monthName} ${annee}`, 'info');
        return false;
      }
      const details = [
        `Bulletins payés : <strong>${paid.length}</strong>`,
        `Avec email valide : <strong>${withEmail.length}</strong>`,
        withoutEmail.length ? `Sans email : <strong>${withoutEmail.length}</strong> (ignorés)` : '',
      ].filter(Boolean).join('<br>');
      const mode = sendOptions.seulement_echecs
        ? 'Renvoi des échecs uniquement'
        : sendOptions.forcer_renvoi
          ? 'Renvoi forcé'
          : 'Envoi des non encore envoyés';
      if (!await confirmAction(
        `${details}<br><br>Mode : <em>${mode}</em><br><br>Un PDF sera joint à chaque bulletin.`,
        `Envoyer les bulletins — ${monthName} ${annee}`,
        'Envoyer',
        'btn-primary'
      )) return false;

      const button = byId('btn-envoi-groupe');
      if (button) {
        button.disabled = true;
        button.textContent = 'Envoi en cours…';
      }
      try {
        const result = await request('/salaires/envoyer-groupe', {
          method: 'POST',
          body: JSON.stringify({
            mois,
            annee,
            seulement_echecs: !!sendOptions.seulement_echecs,
            forcer_renvoi: !!sendOptions.forcer_renvoi,
          })
        });
        if (!result) return false;
        displayGroupSummary(result, monthName, annee);
        reload();
        return true;
      } finally {
        if (button) {
          button.disabled = false;
          button.innerHTML = GROUP_BUTTON_HTML;
        }
      }
    }

    async function viewMonthLogs() {
      requireRequest();
      const { mois, annee } = currentPeriod();
      const monthName = monthNames[mois] || mois;
      const data = await request(`/salaires/envois?mois=${mois}&annee=${annee}&limit=200`);
      if (!data) return false;
      if (!data.rows?.length) {
        alertAction(`<p style="text-align:center;color:#64748b;padding:20px">Aucun envoi enregistré pour ${monthName} ${annee}</p>`, `Logs d'envoi — ${monthName} ${annee}`);
        return true;
      }
      const channelLabels = { email: 'Email', pdf_download: 'PDF téléchargé', impression: 'Impression' };
      const statusLabels = { envoye: 'Envoyé', echec: 'Échec', en_attente: 'En attente' };
      const statusStyles = {
        envoye: 'background:#ecfdf5;color:#047857',
        echec: 'background:#fef2f2;color:#b91c1c',
        en_attente: 'background:#fffbeb;color:#b45309',
      };
      const successCount = data.rows.filter(row => row.statut === 'envoye').length;
      const failureCount = data.rows.filter(row => row.statut === 'echec').length;
      const html = `<div style="min-width:480px">
        <div style="display:flex;gap:12px;margin-bottom:12px;font-size:12px">
          <strong style="color:#047857">${successCount} envoyés</strong>
          ${failureCount ? `<strong style="color:#b91c1c">${failureCount} échecs</strong>` : ''}
          <span style="color:#64748b;margin-left:auto">${data.total} log(s)</span>
        </div>
        <div style="max-height:360px;overflow-y:auto"><table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead><tr style="background:#f8fafc;position:sticky;top:0">
            <th style="padding:6px;text-align:left">Date</th><th style="padding:6px;text-align:left">Agent</th>
            <th style="padding:6px;text-align:left">Destinataire</th><th style="padding:6px;text-align:left">Canal</th>
            <th style="padding:6px;text-align:left">Statut</th>
          </tr></thead>
          <tbody>${data.rows.map(row => `<tr style="border-bottom:1px solid #f1f5f9">
            <td style="padding:5px 6px;white-space:nowrap">${(row.created_at || '').replace('T', ' ').slice(0, 16)}</td>
            <td style="padding:5px 6px">${row.employe_nom || '—'}</td>
            <td style="padding:5px 6px">${row.destinataire || '—'}</td>
            <td style="padding:5px 6px">${channelLabels[row.canal] || row.canal}${row.avec_pdf ? ' +PDF' : ''}${row.groupe ? ' (lot)' : ''}</td>
            <td style="padding:5px 6px"><span style="padding:2px 7px;border-radius:10px;${statusStyles[row.statut] || ''}">${statusLabels[row.statut] || row.statut}</span>
              ${row.erreur ? `<div style="font-size:10px;color:#b91c1c">${row.erreur.slice(0, 60)}</div>` : ''}</td>
          </tr>`).join('')}</tbody>
        </table></div>
        ${failureCount ? `<div style="margin-top:10px;text-align:right"><button onclick="closeCurrentAlert?.();envoyerBulletinsGroupe({seulement_echecs:true})" style="background:#b91c1c;color:#fff;border:none;padding:6px 14px;border-radius:6px;cursor:pointer">Renvoyer les échecs</button></div>` : ''}
      </div>`;
      alertAction(html, `Logs d'envoi — ${monthName} ${annee}`);
      return true;
    }

    async function sendEmail(bulletinId, currentEmail, employeeName) {
      requireRequest();
      let destination = currentEmail;
      if (!destination?.includes('@')) {
        destination = await promptAction(
          `${employeeName} n'a pas d'email dans son dossier.\nSaisissez l'adresse email de destination :`,
          'prenom.nom@exemple.com',
          'Envoyer le bulletin par email',
          'Envoyer'
        );
        if (!destination?.includes('@')) {
          notify('Adresse email invalide ou non saisie', 'error');
          return false;
        }
      } else if (!await confirmAction(
        `Envoyer le bulletin de paie de ${employeeName} à <strong>${destination}</strong> ?`,
        'Envoyer le bulletin',
        'Envoyer',
        'btn-primary'
      )) {
        return false;
      }
      const button = byId('btn-email-bulletin');
      if (button) {
        button.disabled = true;
        button.textContent = 'Envoi…';
      }
      try {
        const result = await request(`/salaires/bulletin/${bulletinId}/email`, {
          method: 'POST',
          body: JSON.stringify({ email_override: destination })
        });
        if (!result?.ok) return false;
        notify(`Bulletin envoyé à ${result.envoye_a}`, 'success');
        return true;
      } finally {
        if (button) {
          button.disabled = false;
          button.innerHTML = EMAIL_BUTTON_HTML;
        }
      }
    }

    async function downloadPdf(bulletinId) {
      const button = byId('btn-pdf-bulletin');
      if (button) {
        button.disabled = true;
        button.textContent = 'Génération…';
      }
      try {
        const response = await fetchImpl(`${apiBase}/salaires/bulletin/${bulletinId}/pdf`, {
          headers: { Authorization: `Bearer ${getToken()}` }
        });
        if (!response.ok) {
          const error = await response.json().catch(() => ({ error: 'Erreur serveur' }));
          notify(error.error || 'Erreur PDF', 'error');
          return false;
        }
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const link = doc.createElement('a');
        const disposition = response.headers.get('Content-Disposition') || '';
        const filename = disposition.match(/filename="([^"]+)"/);
        link.href = url;
        link.download = filename ? filename[1] : `bulletin_${bulletinId}.pdf`;
        link.click();
        URL.revokeObjectURL(url);
        notify('PDF téléchargé', 'success');
        return true;
      } catch (error) {
        notify(`Erreur téléchargement PDF : ${error.message}`, 'error');
        return false;
      } finally {
        if (button) {
          button.disabled = false;
          button.innerHTML = PDF_BUTTON_HTML;
        }
      }
    }

    async function viewBulletinLogs(bulletinId) {
      requireRequest();
      const logs = await request(`/salaires/bulletin/${bulletinId}/envois`);
      if (!logs) return false;
      const channelLabels = { email: 'Email', pdf_download: 'PDF téléchargé', impression: 'Impression' };
      const html = logs.length === 0
        ? '<p class="text-slate-500 text-sm text-center py-4">Aucun envoi enregistré</p>'
        : `<table style="width:100%;border-collapse:collapse;font-size:12px"><tbody>${logs.map(log => `
          <tr style="border-bottom:1px solid #f1f5f9">
            <td style="padding:5px 10px">${(log.created_at || '').replace('T', ' ').slice(0, 16)}</td>
            <td style="padding:5px 10px">${channelLabels[log.canal] || log.canal}${log.avec_pdf ? ' +PDF' : ''}</td>
            <td style="padding:5px 10px">${log.destinataire || '—'}</td>
            <td style="padding:5px 10px">${log.statut}${log.erreur ? `<div style="font-size:10px;color:#b91c1c">${log.erreur.slice(0, 80)}</div>` : ''}</td>
            <td style="padding:5px 10px">${log.envoye_par_nom || '—'}</td>
          </tr>`).join('')}</tbody></table>`;
      alertAction(html, `Logs d'envoi — bulletin #${bulletinId} (${logs.length} envoi(s))`);
      return true;
    }

    async function exportCsv() {
      const { mois, annee } = currentPeriod();
      const response = await fetchImpl(`${apiBase}/salaires/export-csv?mois=${mois}&annee=${annee}`, {
        headers: { Authorization: `Bearer ${getToken()}` }
      });
      if (!response.ok) {
        notify('Erreur export CSV', 'error');
        return false;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = doc.createElement('a');
      link.href = url;
      link.download = `salaires-${monthNames[mois] || mois}-${annee}.csv`;
      link.click();
      URL.revokeObjectURL(url);
      return true;
    }

    return {
      sendGroup,
      displayGroupSummary,
      viewMonthLogs,
      sendEmail,
      downloadPdf,
      viewBulletinLogs,
      exportCsv,
    };
  }

  window.TalaPayrollDocuments = { create };
})();
