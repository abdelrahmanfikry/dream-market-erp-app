/* ==========================================================================
   ERP.ui.modal / confirm / prompt / form
   ========================================================================== */
window.ERP = window.ERP || {}; ERP.ui = ERP.ui || {};
(function () {
  const u = ERP.utils;
  const stack = [];

  function open({ title = '', icon = '', body = '', footer = '', size = '', onOpen, onClose, closable = true, className = '' }) {
    const back = u.el(`
      <div class="modal-backdrop" role="dialog" aria-modal="true">
        <div class="modal ${size ? 'modal-' + size : ''} ${className}">
          <div class="modal-header">
            <h3>${icon ? `<i class="fas fa-${icon}"></i>` : ''}<span class="modal-title">${title}</span></h3>
            ${closable ? '<button class="modal-close" aria-label="إغلاق"><i class="fas fa-xmark"></i></button>' : ''}
          </div>
          <div class="modal-body"></div>
          ${footer !== null ? '<div class="modal-footer"></div>' : ''}
        </div>
      </div>`);
    const modalEl = back.querySelector('.modal');
    const bodyEl = back.querySelector('.modal-body');
    const footEl = back.querySelector('.modal-footer');
    if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.appendChild(body);
    if (footEl) { if (typeof footer === 'string') footEl.innerHTML = footer; else if (footer) footEl.appendChild(footer); if (!footer) footEl.remove(); }

    const handle = {
      el: back, modal: modalEl, body: bodyEl, footer: footEl, closed: false,
      close(result) {
        if (handle.closed || !back.isConnected) return; // marked closed at once: the element lingers 140ms for the fade-out
        handle.closed = true; back.style.pointerEvents = 'none';
        back.style.animation = 'fadeOut .15s forwards';
        setTimeout(() => back.remove(), 140);
        const i = stack.indexOf(handle); if (i >= 0) stack.splice(i, 1);
        if (!stack.length) document.body.classList.remove('modal-open');
        onClose && onClose(result);
      },
      setTitle(t) { back.querySelector('.modal-title').innerHTML = t; },
      setBody(html) { bodyEl.innerHTML = html; },
      $(sel) { return back.querySelector(sel); },
      $$(sel) { return Array.from(back.querySelectorAll(sel)); },
    };
    if (closable) {
      back.querySelector('.modal-close').onclick = () => handle.close();
      back.addEventListener('mousedown', e => { if (e.target === back) handle.close(); });
    }
    document.body.appendChild(back);
    document.body.classList.add('modal-open');
    stack.push(handle);
    // focus first input
    setTimeout(() => { const f = bodyEl.querySelector('input:not([type=hidden]),select,textarea,button'); f && f.focus(); }, 30);
    onOpen && onOpen(handle);
    return handle;
  }

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && stack.length) { const top = stack[stack.length - 1]; if (top.el.querySelector('.modal-close')) top.close(); }
  });

  ERP.ui.modal = open;
  ERP.ui.closeAllModals = () => stack.slice().forEach(h => h.close());

  ERP.ui.confirm = function (message, { title = 'تأكيد', okText = 'تأكيد', cancelText = 'إلغاء', danger = false, icon = 'circle-question' } = {}) {
    return new Promise(resolve => {
      const h = open({
        title, icon, size: 'sm',
        body: `<p style="font-size:var(--fs-md)">${message}</p>`,
        footer: `<button class="btn" data-act="cancel">${cancelText}</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok">${okText}</button>`,
        onClose: r => resolve(!!r),
      });
      h.$('[data-act=ok]').onclick = () => h.close(true);
      h.$('[data-act=cancel]').onclick = () => h.close(false);
      h.$('[data-act=ok]').focus();
    });
  };

  /** message is HTML (like confirm) — callers must escape user data with ERP.utils.escapeHtml */
  ERP.ui.prompt = function (message, { title = 'إدخال', value = '', type = 'text', placeholder = '', okText = 'موافق' } = {}) {
    return new Promise(resolve => {
      const h = open({
        title, size: 'sm', icon: 'pen',
        body: `<label>${message}</label><input type="${type}" class="mt-2" value="${u.escapeHtml(value)}" placeholder="${u.escapeHtml(placeholder)}">`,
        footer: `<button class="btn" data-act="cancel">إلغاء</button><button class="btn btn-primary" data-act="ok">${okText}</button>`,
        onClose: r => resolve(r === undefined ? null : r),
      });
      const inp = h.$('input');
      const ok = () => h.close(type === 'number' ? u.num(inp.value) : inp.value);
      h.$('[data-act=ok]').onclick = ok;
      h.$('[data-act=cancel]').onclick = () => h.close(null);
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') ok(); });
      inp.select();
    });
  };

  /** Generic form modal. fields: [{name,label,type,options,required,value,placeholder,cols,help,step,min}] */
  ERP.ui.form = function ({ title, icon = 'pen-to-square', fields, values = {}, submitText = 'حفظ', size = '', onSubmit, extraFooter = '', onOpen }) {
    return new Promise(resolve => {
      const html = `<form class="form-row" novalidate>${fields.map(f => {
        const v = values[f.name] ?? f.value ?? '';
        const req = f.required ? 'required' : '';
        const span = f.cols === 2 ? 'style="grid-column:1/-1"' : '';
        let input;
        if (f.type === 'select') input = `<select name="${f.name}" ${req}>${f.options}</select>`;
        else if (f.type === 'textarea') input = `<textarea name="${f.name}" placeholder="${u.escapeHtml(f.placeholder || '')}" ${req}>${u.escapeHtml(v)}</textarea>`;
        else if (f.type === 'checkbox') input = `<label class="checkbox mt-2"><input type="checkbox" name="${f.name}" ${v ? 'checked' : ''}> ${f.checkLabel || ''}</label>`;
        else if (f.type === 'html') input = f.html;
        else input = `<input type="${f.type || 'text'}" name="${f.name}" value="${u.escapeHtml(v)}" placeholder="${u.escapeHtml(f.placeholder || '')}" ${f.step ? `step="${f.step}"` : ''} ${f.min !== undefined ? `min="${f.min}"` : ''} ${f.max !== undefined ? `max="${f.max}"` : ''} ${req} ${f.readonly ? 'readonly' : ''} ${f.list ? `list="${f.list}"` : ''} autocomplete="off">`;
        return `<div class="form-group" ${span}>${f.type !== 'checkbox' && f.label ? `<label class="${f.required ? 'required' : ''}">${f.label}</label>` : ''}${input}${f.help ? `<small class="help-text">${f.help}</small>` : ''}</div>`;
      }).join('')}</form>`;
      const h = open({
        title, icon, size, body: html,
        footer: `${extraFooter}<button class="btn" data-act="cancel">إلغاء</button><button class="btn btn-primary" data-act="ok"><i class="fas fa-check"></i> ${submitText}</button>`,
        onClose: r => resolve(r || null),
        onOpen,
      });
      const form = h.$('form');
      fields.forEach(f => { if (f.type === 'select' && values[f.name] !== undefined) { const s = form.querySelector(`[name="${f.name}"]`); if (s) s.value = values[f.name]; } });
      const okBtn = h.$('[data-act=ok]');
      let submitting = false; // in-flight lock: Enter/double-click while an async onSubmit runs must not submit twice
      const submit = async () => {
        if (submitting || h.closed) return;
        // validation
        let ok = true;
        u.$$('[required]', form).forEach(inp => {
          const empty = inp.type === 'checkbox' ? false : !String(inp.value).trim();
          inp.style.borderColor = empty ? 'var(--danger)' : '';
          if (empty) ok = false;
        });
        if (!ok) { ERP.ui.toast('يرجى إكمال الحقول المطلوبة', 'warning'); return; }
        const data = u.formData(form);
        if (onSubmit) {
          submitting = true; okBtn.disabled = true;
          try {
            const r = await onSubmit(data, h);
            if (r === false) return;
            h.close(r === undefined ? data : r);
          } catch (e) { ERP.ui.toast(e.message || String(e), 'error'); }
          finally { submitting = false; if (!h.closed) okBtn.disabled = false; }
        } else h.close(data);
      };
      okBtn.onclick = submit;
      h.$('[data-act=cancel]').onclick = () => h.close(null);
      form.addEventListener('submit', e => { e.preventDefault(); submit(); });
      form.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); submit(); } });
    });
  };

  /** Show a big read-only document/detail in a modal */
  ERP.ui.view = function (title, html, { icon = 'eye', size = 'lg', footer = '' } = {}) {
    const h = open({ title, icon, size, body: html, footer: footer || '<button class="btn" data-act="view-close">إغلاق</button>' });
    const cb = h.$('[data-act=view-close]'); if (cb) cb.onclick = () => h.close();
    return h;
  };

  ERP.ui.loading = function (text = 'جاري المعالجة...') {
    const h = open({ title: '', body: `<div class="text-center p-4"><div class="spinner" style="margin:0 auto 1rem"></div><p>${text}</p></div>`, footer: null, closable: false, size: 'sm' });
    h.el.querySelector('.modal-header').remove();
    return h;
  };
})();
