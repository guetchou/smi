(function (root) {
  'use strict';
  const PREFIX = 'smi-form-v1:';
  const MAX_AGE = 24 * 60 * 60 * 1000;
  function numberValue(value) {
    const raw = String(value || '').trim().replace(/[\s\u202f\u00a0]/g, '').replace(',', '.');
    return raw ? Number(raw) : NaN;
  }
  function dateValid(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const d = new Date(Date.UTC(year, month - 1, day));
    return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
  }
  function message(field) {
    const value = String(field.value || '').trim();
    if (field.disabled || field.readOnly || field.type === 'hidden') return '';
    if (field.required && (field.type === 'checkbox' ? !field.checked : !value)) return 'Renseignez ce champ.';
    if (!value) return '';
    if (field.type === 'email' && field.validity && field.validity.typeMismatch) return 'Indiquez une adresse e-mail valide.';
    if (field.type === 'date' || /-(date|dob)$/.test(field.id || '')) {
      if (!dateValid(value)) return 'Choisissez une date valide.';
    }
    if (field.type === 'number' || /-montant$/.test(field.id || '')) {
      const n = numberValue(value);
      if (!Number.isFinite(n)) return 'Indiquez un nombre valide.';
      if (field.min !== '' && field.min != null && n < Number(field.min)) return 'Le montant doit être au moins de ' + field.min + '.';
      if (field.max !== '' && field.max != null && n > Number(field.max)) return 'La valeur doit être au plus de ' + field.max + '.';
    }
    if (field.validity && field.validity.patternMismatch) return 'Vérifiez le format de votre saisie.';
    return '';
  }
  function draftKey(user, modal, record) {
    return PREFIX + encodeURIComponent(String(user)) + ':' + modal + ':' + (record || 'nouveau');
  }
  function readDraft(storage, key, now) {
    try {
      const draft = JSON.parse(storage.getItem(key));
      if (!draft || !draft.values || typeof draft.values !== "object" || Array.isArray(draft.values) || !Number.isFinite(draft.time) || now - draft.time > MAX_AGE || draft.time > now) {
        storage.removeItem(key);
        return null;
      }
      return draft;
    } catch (_) { return null; }
  }
  const pure = { numberValue, dateValid, message, draftKey, readDraft };
  if (typeof module === 'object' && module.exports) module.exports = pure;
  if (!root.document) return;
  const doc = root.document, guides = new Map();
  const configs = [
    { modal: 'modal-encaissement', record: 'enc-id', form: 'form-encaissement', names: ['Date', 'Origine et montant', "Type d'entrée", 'Compte destinataire', 'Paiement'], refresh: 'updateSimpleOperationImpact', prefix: 'enc' },
    { modal: 'modal-decaissement', record: 'dec-id', form: 'form-decaissement', names: ['Justificatif', 'Bénéficiaire', 'Dépense', 'Compte source', 'Paiement'], refresh: 'updateSimpleOperationImpact', prefix: 'dec' },
    { modal: 'modal-virement', record: 'vir-id', form: 'form-virement', names: ['Date', 'Comptes', 'Montant', 'Description'], refresh: 'updateVirementImpact' }
  ];
  function userId() {
    try { return JSON.parse(root.localStorage.getItem('tc_user'))?.id || ''; }
    catch (_) { return ''; }
  }
  function storage() { try { return root.sessionStorage; } catch (_) { return null; } }
  function node(tag, cls, text) {
    const el = doc.createElement(tag); el.className = cls || '';
    if (text != null) el.textContent = text;
    return el;
  }
  function fieldList(g) {
    return [...g.form.querySelectorAll('input[id],select[id],textarea[id]')].filter(el =>
      !['file', 'password', 'submit', 'button', 'radio'].includes(el.type) && !el.readOnly &&
      (!el.id.endsWith('-search') || el.id === 'dec-employe-search' || el.id === 'dec-fournisseur-search') &&
      el.id !== g.config.record);
  }
  function snapshot(g) {
    const values = {};
    fieldList(g).forEach(el => { values[el.id] = el.type === 'checkbox' ? el.checked : el.value; });
    return values;
  }
  function saveDraft(g) {
    if (!g.key || !g.owner || g.owner !== userId() || !g.dirty) return;
    const s = storage(); if (!s) return;
    try {
      s.setItem(g.key, JSON.stringify({ time: Date.now(), values: snapshot(g), base: g.base, step: g.index }));
      g.notice.textContent = 'Saisie conservée.';
    } catch (_) { g.notice.textContent = 'La saisie n’a pas pu être conservée.'; }
  }
  function active(g) { return !g.modal.classList.contains('hidden'); }
  function applicable(el) {
    return !el.disabled && !el.readOnly && el.type !== 'hidden' && !el.closest('.hidden');
  }
  function showError(g, el, text) {
    const anchor = g.radios.get(el) || el;
    let output = g.errors.get(el);
    if (!output) {
      output = node('p', 'smi-field-error');
      output.id = el.id + '-smi-error';
      output.setAttribute('aria-live', 'polite');
      anchor.insertAdjacentElement('afterend', output);
      g.errors.set(el, output);
      const desc = (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
      if (!desc.includes(output.id)) desc.push(output.id);
      el.setAttribute('aria-describedby', desc.join(' '));
      anchor.setAttribute('aria-describedby', desc.join(' '));
    }
    output.textContent = text;
    output.hidden = !text;
    el.setAttribute('aria-invalid', String(Boolean(text)));
    if (anchor !== el) anchor.setAttribute('aria-invalid', String(Boolean(text)));
  }
  function validate(g, section) {
    let first = null;
    for (const el of section.querySelectorAll('input[id],select[id],textarea[id]')) {
      if (!applicable(el) || el.type === 'radio') continue;
      let error = message(el);
      if (el.id === 'vir-destination' && el.value && el.value === doc.getElementById('vir-source').value) {
        error = 'Choisissez un compte différent du compte source.';
      }
      showError(g, el, error);
      if (error && !first) first = el;
    }
    if (first) {
      const radio = g.radios.get(first)?.querySelector('input:not(:disabled)');
      (radio || first).focus();
      return false;
    }
    return true;
  }
  function setStep(g, index, focus) {
    g.index = Math.max(0, Math.min(index, g.sections.length - 1));
    g.sections.forEach((section, i) => section.classList.toggle('smi-step-hidden', i !== g.index));
    const last = g.index === g.sections.length - 1;
    g.summary.dataset.step = String(g.index + 1);
    g.summary.textContent = 'Étape ' + (g.index + 1) + ' sur ' + g.sections.length + ' — ' + g.names[g.index];
    g.progress.setAttribute('aria-valuenow', String(g.index + 1));
    g.progress.style.setProperty('--smi-progress', ((g.index + 1) / g.sections.length * 100) + '%');
    g.previous.hidden = g.index === 0;
    g.next.hidden = last;
    g.next.textContent = 'Continuer';
    if (g.submit) g.submit.classList.toggle('smi-step-hidden', !last);
    g.review.forEach(el => el.classList.toggle('smi-step-hidden', !last));
    g.feedback.forEach(el => el.classList.toggle('smi-step-hidden', !last));
    g.body.scrollTop = 0;
    if (focus) { g.summary.focus({ preventScroll: true }); }
    if (g.dirty) saveDraft(g);
  }
  function radioChoices(g, select) {
    const available = [...select.options].filter(o => o.value !== '');
    if (!available.length || available.length >= 7) {
      const old = g.radios.get(select);
      if (old) { old.remove(); g.radios.delete(select); }
      select.hidden = false;
      return;
    }
    let box = g.radios.get(select);
    if (!box) {
      box = node('div', 'smi-choice-list'); box.setAttribute('role', 'radiogroup');
      const label = doc.querySelector('label[for="' + select.id + '"]');
      if (label) { label.id ||= select.id + '-smi-label'; box.setAttribute('aria-labelledby', label.id); }
      select.insertAdjacentElement('afterend', box);
      select.hidden = true; g.radios.set(select, box);
    }
    const options = available;
    box.replaceChildren();
    for (const option of options) {
      const label = node('label', 'smi-choice');
      const radio = node('input'); radio.type = 'radio';
      radio.name = select.id + '-smi-choice'; radio.value = option.value;
      radio.checked = select.value === option.value;
      radio.disabled = select.disabled || option.disabled;
      label.append(radio, doc.createTextNode(option.value ? option.textContent.replace(/^[A-Z0-9_]+\s*—\s*/, '') : 'Aucun'));
      radio.addEventListener('change', () => {
        select.value = radio.value;
        select.dispatchEvent(new root.Event('change', { bubbles: true }));
      });
      box.append(label);
    }
    if (!select.required) {
      const clear = node('button', 'smi-choice-clear', 'Effacer le choix');
      clear.type = 'button'; clear.dataset.smiClear = 'true';
      clear.hidden = !select.value; clear.disabled = select.disabled;
      clear.addEventListener('click', () => { select.value = ''; select.dispatchEvent(new root.Event('change', { bubbles: true })); });
      box.append(clear);
    }
  }
  function choices(g) {
    g.form.querySelectorAll('select[id]').forEach(select => radioChoices(g, select));
  }
  function syncChoices(g) {
    for (const [select, box] of g.radios) {
      const clear = box.querySelector('[data-smi-clear]');
      if (clear) { clear.hidden = !select.value; clear.disabled = select.disabled; }
      box.querySelectorAll('input').forEach(radio => {
        radio.checked = radio.value === select.value;
        radio.disabled = select.disabled || [...select.options].find(o => o.value === radio.value)?.disabled || false;
      });
    }
  }
  function open(modalId) {
    const g = guides.get(modalId); if (!g) return;
    g.owner = userId();
    g.key = g.owner ? draftKey(g.owner, modalId, doc.getElementById(g.config.record)?.value) : '';
    g.base = JSON.stringify(snapshot(g)); g.dirty = false; g.touched = new Set();
    g.errors.forEach((output, el) => showError(g, el, ''));
    choices(g); g.notice.textContent = '';
    if (g.submit && !g.submit.hasAttribute('aria-busy')) g.submit.textContent = doc.getElementById(g.config.record)?.value ? 'Enregistrer' : ({enc:'Encaisser',dec:'Créer la demande'}[g.config.prefix] || 'Transférer');
    const s = storage(), draft = g.key && s ? readDraft(s, g.key, Date.now()) : null;
    if (draft && draft.base === g.base) {
      g.restoring = true;
      for (const [id, value] of Object.entries(draft.values)) {
        const el = doc.getElementById(id);
        if (el?.tagName === 'SELECT' && g.form.contains(el) && !el.disabled && [...el.options].some(o => o.value === value)) {
          el.value = value;
          el.dispatchEvent(new root.Event('change', { bubbles: true }));
        }
      }
      for (const [id, value] of Object.entries(draft.values)) {
        const el = doc.getElementById(id);
        if (!el || !g.form.contains(el) || el.disabled || el.readOnly) continue;
        if (el.tagName === 'SELECT' && ![...el.options].some(o => o.value === value)) continue;
        if (el.type === 'checkbox') el.checked = Boolean(value); else { el.value = value; if (el._flatpickr) el._flatpickr.setDate(value, false, 'Y-m-d'); }
      }
      g.restoring = false;
      g.dirty = true; g.notice.textContent = 'Saisie retrouvée.';
      setStep(g, Number.isInteger(draft.step) ? draft.step : 0, false);
    } else {
      if (draft) g.notice.textContent = 'Les données ont changé. La fiche à jour est affichée.';
      setStep(g, 0, false);
    }
    syncChoices(g);
    if (typeof root[g.config.refresh] === 'function') root[g.config.refresh](g.config.prefix);
  }
  function saved() {
    for (const g of guides.values()) {
      if (!active(g)) continue;
      if (g.key) { try { storage()?.removeItem(g.key); } catch (_) {} }
      g.dirty = false; g.notice.textContent = '';
    }
  }
  function compactBalance(aside, footer) {
    footer.prepend(aside);
    aside.querySelectorAll('.op-nuit-solde').forEach((row,i)=>{
      const label=row.querySelector('.op-nuit-c');
      if(label)label.textContent=i%2===0?'Solde actuel':(aside.id==='dec-nuit'?'Solde après paiement':'Nouveau solde');
    });
    syncBalanceTitles();
  }
  function updateTransferBalance() {
    const card=doc.getElementById('vir-nuit-carte'); if(!card || typeof root.selectedPosition!=='function')return;
    if(!card.querySelector('.smi-balance-heading')){
      const heading=node('span','smi-balance-heading','Compte source');card.prepend(heading);
      card.append(node('span','smi-balance-heading','Compte destinataire'));
      for(const [id,label]of [['smi-transfer-current','Solde actuel'],['smi-transfer-next','Nouveau solde']]){
        const row=node('span','op-nuit-solde'),value=node('span','op-nuit-v');value.id=id;
        row.append(node('span','op-nuit-c',label),value);card.append(row);
      }
    }
    const position=root.selectedPosition('vir-destination'),amount=numberValue(doc.getElementById('vir-montant').value);
    for(const [id,value]of [['smi-transfer-current',position?.solde],['smi-transfer-next',position?position.solde+(Number.isFinite(amount)?amount:0):null]]){
      doc.getElementById(id).textContent=value==null?'—':root.fmt(value);
    }
  }
  function syncBalanceTitles() {
    updateTransferBalance();
    doc.querySelectorAll('.smi-guided-modal .op-nuit-carte').forEach(card=>{
      const name=card.querySelector('.op-nuit-nom')?.textContent.trim()||'Compte';
      const values=[...card.querySelectorAll('.op-nuit-solde')].map(row=>row.textContent.trim().replace(/\s+/g,' ')).join('. ');
      card.title=name+'. '+values;card.setAttribute('aria-label',card.title);
    });
  }

  function init(config) {
    const modal = doc.getElementById(config.modal), form = doc.getElementById(config.form);
    if (!modal || !form) return;
    const body = form.firstElementChild;
    let sections = [...body.children].filter(el =>
      el.classList.contains('operation-modal-section') || (config.prefix == null && el.tagName === 'DIV' && el.querySelector('input,select,textarea')));
    if (sections.length < 2) return;
    if (config.prefix === 'enc' && sections.length === 3) {
      const origin = sections[2], grids = [...origin.children].filter(x => x.classList.contains('operation-modal-grid'));
      if (grids.length === 2 && grids[0].children.length === 2) {
        const account = node('div', 'operation-modal-section');
        account.append(node('div', 'operation-modal-section-title'), grids[0].lastElementChild);
        const payment = node('div', 'operation-modal-section');
        payment.append(node('div', 'operation-modal-section-title'), grids[1]);
        origin.insertAdjacentElement('afterend', account);
        account.insertAdjacentElement('afterend', payment);
        sections.push(account, payment);
      }
    }


    if (config.prefix === 'dec' && sections.length === 3) {
      const origin=sections[2], grids=[...origin.children].filter(x=>x.classList.contains('operation-modal-grid'));
      if(grids.length===2 && grids[1].children.length===2){
        const account=node('div','operation-modal-section');
        account.append(node('div','operation-modal-section-title'),grids[1].firstElementChild);
        const payment=node('div','operation-modal-section'), paymentGrid=node('div','operation-modal-grid');
        payment.append(node('div','operation-modal-section-title'),paymentGrid);
        paymentGrid.append(grids[1].lastElementChild);
        const ref=doc.getElementById('dec-ref')?.closest('.operation-field-full');
        if(ref)payment.append(ref);
        const receipt=doc.getElementById('dec-decharge')?.closest('label');
        if(receipt)payment.append(receipt);
        grids[1].remove();
        origin.insertAdjacentElement('afterend',account);account.insertAdjacentElement('afterend',payment);
        sections.push(account,payment);
      }
    }

    if (!config.prefix && sections.length === 3) { const amount=node('div','operation-modal-section'); amount.append(doc.getElementById('vir-montant').parentElement); sections[1].insertAdjacentElement('afterend',amount); sections.splice(2,0,amount); }
    sections.forEach(section => { section.classList.add('operation-modal-section'); const title=section.firstElementChild; if (!config.prefix && title && !title.matches('input,select,textarea') && !title.querySelector('input,select,textarea')) title.classList.add('operation-modal-section-title'); });
    modal.classList.add('smi-guided-modal'); body.classList.add('smi-guided-body'); sections.forEach((section, i) => { const title = section.querySelector('.operation-modal-section-title'); if (title && config.names[i]) title.textContent = config.names[i]; });
    const header = node('div', 'smi-form-progress'), summary = node('p', 'smi-form-step');
    summary.tabIndex = -1; summary.setAttribute('aria-live', 'polite');
    const progress = node('div', 'smi-progress-track');
    progress.setAttribute('role', 'progressbar'); progress.setAttribute('aria-label', 'Progression du formulaire');
    progress.setAttribute('aria-valuemin', '1'); progress.setAttribute('aria-valuemax', String(sections.length));
    const notice = node('p', 'smi-draft-notice'); notice.setAttribute('role', 'status');
    header.append(summary, progress, notice); form.prepend(header);
    const footer = form.lastElementChild; footer.classList.add('operation-modal-footer');
    const previous = node('button', 'btn btn-secondary btn-sm', 'Retour');
    const next = node('button', 'btn btn-primary btn-sm', 'Continuer');
    previous.type = next.type = 'button';
    const submit = form.querySelector('button[type="submit"]');
    footer.insertBefore(previous, submit); footer.insertBefore(next, submit);
    const review = [...body.children].filter(el => /-impact-box$/.test(el.id));
    const feedback = [...footer.querySelectorAll('[id$="-motif-blocage"]')];
    if(!config.prefix){const warning=doc.getElementById('vir-impact-warning'); if(warning){footer.prepend(warning);warning.setAttribute('aria-live','polite');warning.classList.add('smi-field-error');feedback.push(warning);}}
    const aside = modal.querySelector('.op-nuit');
    if (aside) { compactBalance(aside, footer); review.push(aside); }
    const g = { config, modal, form, body, footer, sections, submit, previous, next, summary, progress, notice, review, feedback, index: 0,
      names: sections.map((_, i) => config.names[i] || 'Vérification'), errors: new Map(), radios: new Map(), dirty: false };
    guides.set(config.modal, g);
    if(aside)aside.querySelectorAll('button').forEach(card=>card.addEventListener('click',event=>{event.preventDefault();event.stopImmediatePropagation();setStep(g,config.prefix?3:1,true);},true));
    form.noValidate = true;
    for (const label of form.querySelectorAll('label[for]')) {
      const el = doc.getElementById(label.htmlFor);
      if (!el || el.readOnly || el.type === 'search') continue;
      if (el.required) {
        if (!label.textContent.includes('*')) label.append(doc.createTextNode(' *'));
      } else if (!label.textContent.includes('(optionnel)')) label.append(doc.createTextNode(' (optionnel)'));
    }
    [['enc-position-search','enc-position'],['dec-position-search','dec-position'],['vir-source-search','vir-source'],['vir-destination-search','vir-destination']].forEach(([search, select]) => {
      const label = form.querySelector('label[for="' + search + '"]');
      if (label) label.htmlFor = select;
    });
    for (const el of form.querySelectorAll('input,textarea')) {
      if (el.type === 'number' || /-montant$/.test(el.id)) el.inputMode = 'decimal';
      if (el.type === 'tel') { el.inputMode = 'tel'; el.autocomplete = 'tel'; }
      if (el.type === 'email') el.autocomplete = 'email';
      if (el.tagName === 'TEXTAREA') el.style.resize = 'vertical';
    }
    previous.addEventListener('click', () => setStep(g, g.index - 1, true));
    next.addEventListener('click', () => { if (validate(g, sections[g.index])) setStep(g, g.index + 1, true); });
    for (const eventName of ['input', 'change']) form.addEventListener(eventName, event => {
      const el = event.target;
      if (g.restoring || !el.matches('input,select,textarea') || !active(g) || g.owner !== userId()) return;
      g.dirty = JSON.stringify(snapshot(g)) !== g.base;
      if (el.id) g.touched.add(el.id);
      if (el.id && el.type !== 'radio' && applicable(el)) {
        showError(g, el, message(el));
        if (el.id === 'vir-source' || el.id === 'vir-destination') {
          const destination = doc.getElementById('vir-destination');
          showError(g, destination, destination.value && destination.value === doc.getElementById('vir-source').value ?
            'Choisissez un compte différent du compte source.' : (destination.value || g.touched.has(destination.id) ? message(destination) : ''));
        }
      }
      syncChoices(g); if (!g.dirty && g.key) { try { storage()?.removeItem(g.key); } catch (_) {} g.notice.textContent = ""; } else saveDraft(g);
    });
    form.addEventListener('focusout', event => {
      const el = event.target;
      if (el.id && el.matches('input,select,textarea') && applicable(el)) showError(g, el, message(el));
    });
    form.addEventListener('submit', event => {
      if (g.index !== sections.length - 1) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (validate(g, sections[g.index])) setStep(g, g.index + 1, true);
        return;
      }
      for (let i = 0; i < sections.length; i++) {
        setStep(g, i, false);
        if (!validate(g, sections[i])) { event.preventDefault(); event.stopImmediatePropagation(); return; }
      }
      setStep(g, sections.length - 1, false);
    }, true);
    form.addEventListener('keydown', event => {
      if (event.key === 'Enter' && event.target.matches('input:not([type=radio]):not([type=checkbox])') && !event.isComposing && g.index < sections.length - 1) {
        event.preventDefault(); next.click();
      }
    });
    setStep(g, 0, false);
  }
  configs.forEach(init);
  for(const name of ['updateSimpleOperationImpact','updateVirementImpact']) {
    const original=root[name];
    if(typeof original==='function')root[name]=function(...args){const result=original.apply(this,args);syncBalanceTitles();return result;};
  }

  let allowingClose = false;
  async function confirmClose(g, continuation) {
    if (!g.dirty || allowingClose || g.confirming) return false;
    g.confirming = true;
    saveDraft(g);
    let accepted;
    try { accepted = typeof root.showConfirm === 'function' ?
      await root.showConfirm('Fermer le formulaire ? La saisie sera conservée.', 'Quitter la saisie', 'Fermer', 'btn-secondary', 'Continuer la saisie') :
      root.confirm('Fermer le formulaire ? La saisie sera conservée.');
    } finally { g.confirming = false; }
    if (accepted) { allowingClose = true; try { continuation(); } finally { allowingClose = false; } }
    return true;
  }
  doc.addEventListener('click', event => {
    if (allowingClose) return;
    const g = [...guides.values()].find(item => active(item) && item.dirty);
    if (!g || g.confirming) return;
    const button = event.target.closest('button');
    if (event.target === g.modal || (button && g.modal.contains(button) && /closeOperationModals/.test(button.getAttribute('onclick') || ''))) {
      event.preventDefault(); event.stopImmediatePropagation();
      confirmClose(g, () => { if (button) button.click(); else root.closeOperationModals(); });
    }
  }, true);
  doc.addEventListener('keydown', event => {
    const g = [...guides.values()].find(active);
    if (!g) return;
    if (event.key === 'Escape' && g.dirty && !g.confirming) {
      event.preventDefault(); event.stopImmediatePropagation(); confirmClose(g, () => root.closeOperationModals());
    }
    if (event.key === 'Tab') {
      const nodes = [...g.modal.querySelectorAll('button,input,select,textarea,summary,[tabindex="0"]')].filter(el => !el.disabled && el.getClientRects().length);
      if (!nodes.length) return;
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }, true);
  root.addEventListener('beforeunload', event => {
    const dirty = [...guides.values()].filter(g => active(g) && g.dirty && g.owner === userId());
    if (!dirty.length) return;
    dirty.forEach(saveDraft); event.preventDefault(); event.returnValue = '';
  });
  root.SmiForms = { open, saved };
})(typeof window === 'undefined' ? globalThis : window);
