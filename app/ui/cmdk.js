/* ==========================================================================
   ERP.ui.cmdk — command palette (Ctrl+K): pages, actions, products, customers
   ========================================================================== */
window.ERP = window.ERP || {}; ERP.ui = ERP.ui || {};
(function () {
  const u = ERP.utils;
  let root, input, list, items = [], active = 0;
  const actions = [];

  function ensure() {
    if (root) return;
    root = u.el(`<div class="cmdk"><div class="cmdk-box"><div class="cmdk-input"><i class="fas fa-magnifying-glass muted"></i><input type="text" placeholder="ابحث عن صفحة، منتج، عميل، أو إجراء..." autocomplete="off"><kbd>Esc</kbd></div><div class="cmdk-list"></div></div></div>`);
    document.body.appendChild(root);
    input = root.querySelector('input'); list = root.querySelector('.cmdk-list');
    root.addEventListener('mousedown', e => { if (e.target === root) close(); });
    input.addEventListener('input', () => { active = 0; render(); });
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); paint(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); paint(); }
      else if (e.key === 'Enter') { e.preventDefault(); run(items[active]); }
      else if (e.key === 'Escape') close();
    });
    list.addEventListener('click', e => { const it = e.target.closest('.cmdk-item'); if (it) run(items[+it.dataset.i]); });
  }
  function open() { ensure(); root.classList.add('open'); input.value = ''; active = 0; render(); setTimeout(() => input.focus(), 20); }
  function close() { root && root.classList.remove('open'); }
  function run(it) { if (!it) return; close(); setTimeout(() => it.run(), 30); }

  function build(term) {
    const out = [];
    const t = term.trim();
    // pages
    ERP.router.all().filter(v => ERP.router.allowed(v) && !v.hidden).forEach(v => { if (!t || u.match(v.title, t)) out.push({ group: 'الصفحات', icon: v.icon, title: v.title, sub: v.section, run: () => ERP.router.go(v.id) }); });
    // actions
    actions.forEach(a => { if (!a.perm || ERP.auth.can(a.perm)) if (!t || u.match(a.title + ' ' + (a.keywords || ''), t)) out.push({ group: 'إجراءات', ...a }); });
    if (t.length >= 2) {
      ERP.db.collection('products').all().filter(p => u.match(p.name, t) || u.match(p.code, t) || (p.barcode && p.barcode.includes(t))).slice(0, 6).forEach(p => out.push({ group: 'المنتجات', icon: 'box', title: p.name, sub: `${p.code} · ${u.fmtMoney(p.price)} · مخزون ${u.fmtQty(p.stock)}`, run: () => ERP.router.go('products', { q: p.name }) }));
      if (ERP.auth.can('customers.view')) ERP.db.collection('customers').all().filter(c => u.match(c.name, t) || (c.phone && c.phone.includes(t))).slice(0, 5).forEach(c => out.push({ group: 'العملاء', icon: 'user', title: c.name, sub: `${c.phone || ''} · رصيد ${u.fmtMoney(c.balance)}`, run: () => ERP.router.go('customers', { id: c.id }) }));
      if (ERP.auth.can('sales.view')) ERP.db.collection('sales').all().filter(s => s.no && s.no.toLowerCase().includes(t.toLowerCase())).slice(0, 5).forEach(s => out.push({ group: 'الفواتير', icon: 'receipt', title: s.no, sub: `${s.customerName} · ${u.fmtMoney(s.total)} · ${u.fmtDate(s.date)}`, run: () => ERP.sales && ERP.sales.viewInvoice ? ERP.sales.viewInvoice(s.id) : ERP.router.go('sales', { id: s.id }) }));
    }
    return out.slice(0, 40);
  }
  function render() { items = build(input.value); paint(); }
  function paint() {
    if (!items.length) { list.innerHTML = '<div class="empty-state"><i class="fas fa-magnifying-glass"></i><p>لا نتائج</p></div>'; return; }
    let lastGroup = null;
    list.innerHTML = items.map((it, i) => { const g = it.group !== lastGroup ? `<div class="cmdk-group">${it.group}</div>` : ''; lastGroup = it.group; return `${g}<div class="cmdk-item ${i === active ? 'active' : ''}" data-i="${i}"><i class="fas fa-${it.icon}"></i><div class="flex-1"><div>${u.highlight(it.title, input.value)}</div>${it.sub ? `<div class="cmdk-sub">${u.escapeHtml(it.sub)}</div>` : ''}</div>${it.shortcut ? `<kbd>${it.shortcut}</kbd>` : ''}</div>`; }).join('');
    const a = list.querySelector('.cmdk-item.active'); a && a.scrollIntoView({ block: 'nearest' });
  }

  ERP.ui.cmdk = { open, close, addAction(a) { actions.push(a); } };
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if (ERP.auth.isLoggedIn()) open(); }
  });
})();
