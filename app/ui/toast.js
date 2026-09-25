/* ==========================================================================
   ERP.ui.toast — non-blocking notifications
   ========================================================================== */
window.ERP = window.ERP || {}; ERP.ui = ERP.ui || {};
(function () {
  const u = ERP.utils;
  let container = null;
  const ICONS = { success: 'circle-check', error: 'circle-xmark', warning: 'triangle-exclamation', info: 'circle-info' };
  function ensure() {
    if (!container) { container = u.el('<div class="toast-container" aria-live="polite"></div>'); document.body.appendChild(container); }
    return container;
  }
  ERP.ui.toast = function (message, type = 'info', { title = '', duration = 3500, action = null } = {}) {
    const c = ensure();
    const t = u.el(`
      <div class="toast ${type}" role="status">
        <i class="fas fa-${ICONS[type] || ICONS.info} toast-icon"></i>
        <div class="toast-body">
          ${title ? `<div class="toast-title">${u.escapeHtml(title)}</div>` : ''}
          <div>${u.escapeHtml(message)}</div>
          ${action ? `<button class="btn btn-sm btn-soft-primary mt-2 toast-action">${u.escapeHtml(action.label)}</button>` : ''}
        </div>
        <button class="toast-close" aria-label="إغلاق"><i class="fas fa-xmark"></i></button>
      </div>`);
    const close = () => { t.classList.add('hiding'); setTimeout(() => t.remove(), 220); };
    t.querySelector('.toast-close').onclick = close;
    if (action) t.querySelector('.toast-action').onclick = () => { action.onClick(); close(); };
    c.appendChild(t);
    if (c.children.length > 5) c.firstElementChild.remove();
    if (duration > 0) setTimeout(close, duration);
    return { close };
  };
  ERP.ui.success = (m, o) => ERP.ui.toast(m, 'success', o);
  ERP.ui.error = (m, o) => ERP.ui.toast(m, 'error', o);
  ERP.ui.warn = (m, o) => ERP.ui.toast(m, 'warning', o);
  ERP.ui.info = (m, o) => ERP.ui.toast(m, 'info', o);
  ERP.ui.beep = function (kind = 'ok') {
    if (!ERP.settings.get('posSoundEnabled')) return;
    try {
      const ctx = ERP.ui._actx || (ERP.ui._actx = new (window.AudioContext || window.webkitAudioContext)());
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = kind === 'ok' ? 880 : kind === 'err' ? 220 : 660; o.type = 'sine';
      g.gain.setValueAtTime(.08, ctx.currentTime); g.gain.exponentialRampToValueAtTime(.0001, ctx.currentTime + .15);
      o.start(); o.stop(ctx.currentTime + .15);
    } catch { /* ignore */ }
  };
})();
