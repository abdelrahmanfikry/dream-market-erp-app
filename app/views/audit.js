/* ==========================================================================
   View: Audit log
   ========================================================================== */
window.ERP = window.ERP || {}; ERP.views = ERP.views || {};
(function () {
  const u = ERP.utils; const e = u.escapeHtml;
  let el, table;
  const KIND = a => a.startsWith('auth') ? 'purple' : a.includes('delete') || a.includes('void') || a.includes('reset') ? 'danger' : a.includes('create') || a.startsWith('sale') ? 'success' : a.startsWith('stock') || a.startsWith('purchase') ? 'info' : 'neutral';
  function refresh() { if (table) table.setRows(ERP.audit.recent(3000)); }
  ERP.router.register({
    id: 'audit', title: 'سجل النشاطات', icon: 'clipboard-list', section: 'النظام', order: 4, perm: 'audit.view',
    render(root) {
      el = root;
      root.innerHTML = `<div class="page-header"><div><h2><i class="fas fa-clipboard-list"></i> سجل النشاطات</h2><div class="desc">من فعل ماذا ومتى — سجل غير قابل للتعديل لكل العمليات الحساسة</div></div></div><div id="au-table"></div>`;
      const users = ERP.auth.users(); const actions = u.uniq(ERP.audit.recent(3000).map(a => a.action));
      table = ERP.ui.table({ el: '#au-table', rows: [], exportName: 'سجل النشاطات', defaultSort: { key: 'at', dir: 'desc' }, pageSize: 50, toolbarExtra: `<select id="au-user" style="min-width:150px"><option value="">كل المستخدمين</option>${u.options(users)}</select><select id="au-act" style="min-width:170px"><option value="">كل الإجراءات</option>${actions.map(a => `<option value="${a}">${e(ERP.audit.label(a))}</option>`).join('')}</select>`, columns: [
        { key: 'at', label: 'الوقت', render: a => `<span class="num text-sm">${u.fmtDateTime(a.at)}</span><div class="text-xs muted">${u.relTime(a.at)}</div>`, text: a => u.fmtDateTime(a.at) },
        { key: 'userName', label: 'المستخدم', render: a => `<div class="flex items-center gap-2"><div class="avatar sm">${e(u.initials(a.userName))}</div>${e(a.userName)}</div>` },
        { key: 'action', label: 'الإجراء', render: a => u.badge(ERP.audit.label(a.action), KIND(a.action)), text: a => ERP.audit.label(a.action) },
        { key: 'details', label: 'التفاصيل', render: (a, t) => `<span class="text-sm">${u.highlight(a.details, t)}</span>` },
      ] });
      const filt = () => { const uid = $('#au-user', root).value, act = $('#au-act', root).value; table.setRows(ERP.audit.recent(3000).filter(a => (!uid || a.userId === uid) && (!act || a.action === act))); };
      $('#au-user', root).onchange = filt; $('#au-act', root).onchange = filt;
    },
    onShow() { refresh(); },
  });
  ERP.bus.on('audit:new', u.debounce(() => { if (ERP.router.current() === 'audit') refresh(); }, 500));
})();
