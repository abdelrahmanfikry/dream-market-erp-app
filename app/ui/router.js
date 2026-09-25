/* ==========================================================================
   ERP.router — view registry, hash routing, sidebar & topbar rendering
   view: { id, title, icon, section, perm, order, badge(), render(el, params), onShow(el, params), onHide() }
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  const u = ERP.utils;
  const views = {};
  const rendered = new Set();
  let current = null;
  let currentParams = {};
  const SECTIONS = ['الرئيسية', 'العمليات', 'الأطراف', 'المالية', 'الإدارة', 'النظام'];

  function parseHash() {
    const h = location.hash.replace(/^#\/?/, '');
    const [path, qs] = h.split('?');
    const params = {};
    (qs || '').split('&').filter(Boolean).forEach(kv => { const [k, v] = kv.split('='); params[decodeURIComponent(k)] = decodeURIComponent(v || ''); });
    return { id: path || 'dashboard', params };
  }

  const router = {
    SECTIONS,
    register(view) { views[view.id] = view; return view; },
    get(id) { return views[id]; },
    all() { return u.sortBy(Object.values(views), v => (SECTIONS.indexOf(v.section) * 100) + (v.order || 50)); },
    current() { return current; },
    params() { return currentParams; },
    allowed(v) { return !v.perm || ERP.auth.can(v.perm); },
    go(id, params = {}) {
      const qs = Object.keys(params).length ? '?' + Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&') : '';
      const next = `#/${id}${qs}`;
      if (location.hash === next) router.show(id, params); else location.hash = next;
    },
    show(id, params = {}) {
      let v = views[id];
      if (!v) { id = 'dashboard'; v = views[id]; }
      if (!router.allowed(v)) { ERP.ui.toast('ليس لديك صلاحية للوصول إلى هذه الصفحة', 'error'); if (id !== 'dashboard') return router.go('dashboard'); }
      if (current && current !== id) { const prev = views[current]; prev.onHide && prev.onHide(); document.getElementById('view-' + current)?.classList.remove('active'); }
      current = id; currentParams = params;
      let el = document.getElementById('view-' + id);
      if (!el) { el = u.el(`<section class="view" id="view-${id}"></section>`); document.getElementById('content').appendChild(el); }
      if (!rendered.has(id)) { try { v.render(el, params); } catch (e) { console.error(e); el.innerHTML = `<div class="alert alert-danger">خطأ في تحميل الصفحة: ${u.escapeHtml(e.message)}</div>`; } rendered.add(id); }
      el.classList.add('active');
      try { v.onShow && v.onShow(el, params); } catch (e) { console.error(e); }
      // topbar
      document.getElementById('page-title').textContent = v.title;
      document.getElementById('page-icon').className = `fas fa-${v.icon}`;
      document.title = `${v.title} — ${ERP.settings.get('storeName')}`;
      u.$$('.nav-item[data-view]').forEach(n => n.classList.toggle('active', n.dataset.view === id));
      document.querySelector('.app').classList.remove('sidebar-open');
      document.getElementById('content').scrollTop = 0; window.scrollTo(0, 0);
      ERP.bus.emit('view:show', { id, params });
    },
    /** force a view to re-render next time it's shown (or now if it's current) */
    invalidate(id) { rendered.delete(id); const el = document.getElementById('view-' + id); if (el) el.innerHTML = ''; if (current === id) router.show(id, currentParams); },
    refreshCurrent() { if (current) { const v = views[current]; v.onShow && v.onShow(document.getElementById('view-' + current), currentParams); } },

    renderSidebar() {
      const nav = document.getElementById('sidebar-nav');
      const bySection = u.groupBy(router.all().filter(v => router.allowed(v) && !v.hidden), 'section');
      nav.innerHTML = SECTIONS.filter(s => bySection[s]).map(s => `
        <div class="nav-section">${s}</div>
        ${bySection[s].map(v => `<button class="nav-item ${current === v.id ? 'active' : ''}" data-view="${v.id}" data-tip="${v.title}"><i class="fas fa-${v.icon}"></i><span>${v.title}</span><span class="nav-badge hidden" data-badge="${v.id}"></span></button>`).join('')}`).join('');
      router.updateBadges();
    },
    updateBadges() {
      Object.values(views).forEach(v => {
        const b = document.querySelector(`[data-badge="${v.id}"]`); if (!b) return;
        const val = v.badge ? v.badge() : null;
        if (val) { b.textContent = val.text ?? val; b.className = `nav-badge ${val.kind || ''}`; } else b.classList.add('hidden');
      });
    },
    start() {
      window.addEventListener('hashchange', () => { const { id, params } = parseHash(); router.show(id, params); });
      document.getElementById('sidebar-nav').addEventListener('click', e => { const n = e.target.closest('.nav-item[data-view]'); if (n) router.go(n.dataset.view); });
      const { id, params } = parseHash();
      router.show(id, params);
    },
  };
  ERP.router = router;
})();
