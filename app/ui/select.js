/* ==========================================================================
   ERP.ui.picker — searchable dropdown for products / customers / suppliers
   usage: ERP.ui.picker(inputEl, { source: () => rows, label: r => ..., sub: r => ..., onPick(r), allowNew })
   ========================================================================== */
window.ERP = window.ERP || {}; ERP.ui = ERP.ui || {};
(function () {
  const u = ERP.utils;
  // one delegated listener for all pickers; pickers whose input left the DOM are dropped (no per-picker document listeners)
  const pickers = new Set();
  document.addEventListener('mousedown', e => { pickers.forEach(p => { if (!p.wrap.isConnected) { if (p.seen) pickers.delete(p); return; } p.seen = true; if (!p.wrap.contains(e.target)) p.hide(); }); });
  ERP.ui.picker = function (input, { source, label = r => r.name, sub = null, keys = ['name', 'code', 'phone', 'barcode'], onPick, onNew = null, newLabel = 'إضافة جديد', minChars = 0, maxItems = 12, clearOnPick = false }) {
    const wrap = input.parentElement; wrap.classList.add('relative');
    const menu = u.el('<div class="dropdown-menu w-full" style="display:none;max-height:320px;overflow-y:auto;right:0;left:0"></div>');
    wrap.appendChild(menu);
    let items = [], active = 0, open = false;

    function show() { menu.style.display = 'block'; open = true; }
    function hide() { menu.style.display = 'none'; open = false; }
    function render() {
      const t = input.value.trim();
      if (t.length < minChars) { hide(); return; }
      const rows = source() || [];
      items = (t ? rows.filter(r => keys.some(k => r[k] && u.match(r[k], t))) : rows).slice(0, maxItems);
      let html = items.map((r, i) => `<button type="button" class="dropdown-item ${i === active ? 'active' : ''}" data-i="${i}" style="${i === active ? 'background:var(--bg-hover)' : ''}"><div class="flex-1 text-right"><div>${u.highlight(label(r), t)}</div>${sub ? `<div class="text-xs muted">${u.escapeHtml(sub(r))}</div>` : ''}</div></button>`).join('');
      if (onNew && t) html += `<button type="button" class="dropdown-item text-primary" data-new="1"><i class="fas fa-plus"></i> ${newLabel}: "${u.escapeHtml(t)}"</button>`;
      if (!html) html = '<div class="p-3 text-sm muted text-center">لا نتائج</div>';
      menu.innerHTML = html; show();
    }
    function pick(i) { const r = items[i]; if (!r) return; hide(); input.value = clearOnPick ? '' : label(r); onPick && onPick(r); }
    input.addEventListener('input', () => { active = 0; render(); });
    input.addEventListener('focus', () => { if (minChars === 0 || input.value.trim().length >= minChars) { render(); } });
    input.addEventListener('keydown', e => {
      if (!open) { if (e.key === 'ArrowDown') { render(); } return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1 + (onNew ? 1 : 0), active + 1); render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); render(); }
      else if (e.key === 'Enter') { if (items.length || onNew) { e.preventDefault(); if (active < items.length) pick(active); else if (onNew) { hide(); onNew(input.value.trim()); } } }
      else if (e.key === 'Escape') hide();
    });
    menu.addEventListener('mousedown', e => { e.preventDefault(); const b = e.target.closest('.dropdown-item'); if (!b) return; if (b.dataset.new) { hide(); onNew(input.value.trim()); } else pick(+b.dataset.i); });
    const api = { hide, refresh: render, wrap, seen: wrap.isConnected };
    pickers.add(api);
    return api;
  };
})();
