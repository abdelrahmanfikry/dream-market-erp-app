/* ==========================================================================
   View: Expenses
   ========================================================================== */
window.ERP = window.ERP || {}; ERP.views = ERP.views || {};
(function () {
  const u = ERP.utils; const e = u.escapeHtml;
  let el, table, period = 'month';
  const X = () => ERP.db.collection('expenses');
  function rows() { const P = ERP.reports.period(period); return u.sortBy(X().all().filter(x => u.inRange(x.date, P.from, P.to)), 'date', 'desc'); }
  function refresh() { if (!table) return; const r = rows(); table.setRows(r); const by = ERP.reports.expensesSummary(ERP.reports.period(period).from, ERP.reports.period(period).to); $('#x-kpis', el).innerHTML = [['wallet', 'danger', `مصروفات ${ERP.reports.period(period).label}`, u.fmtMoney(by.total)], ['list', 'info', 'عدد العمليات', by.count], ['crown', 'warning', 'أكبر بند', by.byCategory[0] ? `${e(by.byCategory[0].name)} (${u.fmtMoneyShort(by.byCategory[0].total)})` : '—'], ['calendar', 'purple', 'متوسط يومي', u.fmtMoney(by.total / Math.max(1, u.daysBetween(ERP.reports.period(period).from, u.todayISO()) + 1))]].map(k => `<div class="card kpi"><div class="kpi-icon ${k[1]}"><i class="fas fa-${k[0]}"></i></div><div class="kpi-body"><div class="kpi-label">${k[2]}</div><div class="kpi-value" style="font-size:1.2rem">${k[3]}</div></div></div>`).join(''); if (ERP.charts.ready()) ERP.charts.doughnut('#x-chart', { labels: by.byCategory.map(c => c.name), data: by.byCategory.map(c => u.round(c.total)) }); }
  async function openForm(id = null) {
    if (!ERP.auth.require('expenses.manage')) return;
    const x = id ? X().get(id) : null; const cats = ERP.db.collection('expenseCategories').all(); const methods = ERP.sales.methods(); const sups = ERP.purchasing.suppliers();
    const r = await ERP.ui.form({ title: x ? 'تعديل مصروف' : 'تسجيل مصروف', icon: 'wallet', values: x ? { ...x, date: u.toISODate(x.date) } : { date: u.todayISO(), method: 'cash' }, fields: [
      { name: 'title', label: 'البند / الوصف', required: true, cols: 2, placeholder: 'مثال: فاتورة كهرباء شهر 9' }, { name: 'categoryId', label: 'الفئة', type: 'select', options: u.options(cats) }, { name: 'amount', label: 'المبلغ', type: 'number', step: 'any', min: 0.01, required: true },
      { name: 'method', label: 'طريقة الدفع', type: 'select', options: methods.map(m => `<option value="${m.id}">${e(m.isCredit ? 'آجل (يُسجل على مورد)' : m.name)}</option>`).join('') }, { name: 'date', label: 'التاريخ', type: 'date' },
      { name: 'supplierId', label: 'المورد / الجهة (اختياري)', type: 'select', options: u.options(sups, { empty: '— بدون —' }) }, { name: 'refNo', label: 'رقم الفاتورة / المرجع' }, { name: 'recurring', type: 'checkbox', checkLabel: 'مصروف شهري متكرر (للتذكير)' }, { name: 'notes', label: 'ملاحظات', type: 'textarea', cols: 2 },
    ], onSubmit: d => {
      const cat = ERP.db.collection('expenseCategories').get(d.categoryId);
      const doc = { ...d, categoryName: cat ? cat.name : '', date: new Date(d.date + 'T' + new Date().toTimeString().slice(0, 8)).toISOString(), amount: u.num(d.amount) };
      if (x) { ERP.accounting.unpost('expense', id); const upd = X().update(id, doc); ERP.accounting.postExpense(upd); ERP.audit.log('expense.create', `تعديل ${upd.title} ${u.fmtMoney(upd.amount)}`, id); return upd; }
      const ins = X().insert({ ...doc, no: ERP.db.nextSeq('expense', ERP.settings.prefix('expense')), userId: ERP.auth.current()?.id, shiftId: ERP.shifts.current()?.id || null });
      ERP.accounting.postExpense(ins);
      if (ins.method === 'credit' && ins.supplierId) ERP.purchasing.adjustSupplierBalance(ins.supplierId, ins.amount);
      if (ins.method === 'cash') { const sh = ERP.shifts.current(); if (sh) ERP.db.collection('shifts').update(sh.id, { cashOut: u.round(sh.cashOut + ins.amount) }, { silent: true }); }
      ERP.audit.log('expense.create', `${ins.title} — ${u.fmtMoney(ins.amount)}`, ins.id); return ins;
    } });
    if (r) ERP.ui.success('تم الحفظ');
  }
  async function remove(id) { if (!ERP.auth.require('expenses.manage')) return; const x = X().get(id); if (!await ERP.ui.confirm(`حذف المصروف <strong>${e(x.title)}</strong> (${u.fmtMoney(x.amount)})؟`, { danger: true })) return; ERP.accounting.unpost('expense', id); if (x.method === 'credit' && x.supplierId) ERP.purchasing.adjustSupplierBalance(x.supplierId, -x.amount); X().remove(id); ERP.audit.log('expense.delete', `${x.title} ${u.fmtMoney(x.amount)}`); ERP.ui.success('تم الحذف'); }
  async function manageCats() { const C = ERP.db.collection('expenseCategories'); const accs = ERP.accounting.accounts().filter(a => a.type === 'expense' && a.parentId); const render = () => C.all().map(c => `<div class="list-row"><i class="fas fa-${e(c.icon || 'tag')}" style="width:24px;text-align:center;color:var(--primary)"></i><div class="grow"><div class="title">${e(c.name)}</div><div class="sub">حساب ${e((accs.find(a => a.code === c.accountCode) || {}).name || 'متنوعة')} · ${X().where({ categoryId: c.id }).length} عملية</div></div><button class="btn btn-sm btn-ghost" data-e="${c.id}"><i class="fas fa-pen"></i></button><button class="btn btn-sm btn-ghost text-danger" data-d="${c.id}"><i class="fas fa-trash"></i></button></div>`).join(''); const h = ERP.ui.modal({ title: 'فئات المصروفات', icon: 'tags', body: `<div id="xc">${render()}</div>`, footer: `<button class="btn" data-a="c">إغلاق</button><button class="btn btn-primary" data-a="add"><i class="fas fa-plus"></i> فئة</button>` }); const edit = async id => { const c = id ? C.get(id) : null; const r = await ERP.ui.form({ title: c ? 'تعديل فئة' : 'فئة جديدة', fields: [{ name: 'name', label: 'الاسم', required: true }, { name: 'accountCode', label: 'الحساب المحاسبي', type: 'select', options: u.options(accs, { value: 'code', label: a => `${a.code} — ${a.name}`, selected: c?.accountCode || '5290' }) }, { name: 'icon', label: 'أيقونة' }], values: c || { icon: 'tag' } }); if (!r) return; if (c) C.update(id, r); else C.insert(r); h.$('#xc').innerHTML = render(); }; h.$('[data-a=c]').onclick = () => h.close(); h.$('[data-a=add]').onclick = () => edit(null); h.$('#xc').onclick = async ev => { const ed = ev.target.closest('[data-e]'), dl = ev.target.closest('[data-d]'); if (ed) edit(ed.dataset.e); if (dl) { if (X().where({ categoryId: dl.dataset.d }).length) return ERP.ui.warn('الفئة مستخدمة'); if (await ERP.ui.confirm('حذف؟', { danger: true })) { C.remove(dl.dataset.d); h.$('#xc').innerHTML = render(); } } }; }
  ERP.views.expenses = { openForm, remove };
  ERP.router.register({
    id: 'expenses', title: 'المصروفات', icon: 'wallet', section: 'المالية', order: 1, perm: 'expenses.view',
    render(root) {
      el = root; const canM = ERP.auth.can('expenses.manage');
      root.innerHTML = `<div class="page-header"><div><h2><i class="fas fa-wallet"></i> المصروفات</h2><div class="desc">تسجيل ومتابعة المصروفات التشغيلية مرتبطة بالحسابات</div></div><div class="page-actions"><div class="pills" id="x-period">${['today', 'week', 'month', 'lastMonth', 'year', 'all'].map(k => `<button class="pill ${k === period ? 'active' : ''}" data-p="${k}">${ERP.reports.period(k).label}</button>`).join('')}</div>${canM ? '<button class="btn btn-outline" id="x-cats"><i class="fas fa-tags"></i> الفئات</button><button class="btn btn-primary" id="x-add"><i class="fas fa-plus"></i> مصروف جديد</button>' : ''}</div></div>
        <div class="kpi-grid mb-4" id="x-kpis"></div><div class="dash-grid" style="grid-template-columns:1fr 340px;margin-top:0"><div id="x-table"></div><div class="card"><div class="card-header"><h3><i class="fas fa-chart-pie"></i> حسب الفئة</h3></div><div class="card-body"><div class="chart-box sm"><canvas id="x-chart"></canvas></div></div></div></div>`;
      table = ERP.ui.table({ el: '#x-table', rows: [], exportName: 'المصروفات', defaultSort: { key: 'date', dir: 'desc' }, columns: [
        { key: 'date', label: 'التاريخ', render: x => `<span class="num text-sm">${u.fmtDate(x.date)}</span>`, text: x => u.fmtDate(x.date) }, { key: 'no', label: 'الرقم', render: x => `<span class="num text-xs muted">${e(x.no || '')}</span>` },
        { key: 'title', label: 'البند', render: (x, t) => `<div class="fw-600">${u.highlight(x.title, t)}</div>${x.notes ? `<div class="text-xs muted">${e(x.notes)}</div>` : ''}` }, { key: 'categoryName', label: 'الفئة', render: x => u.badge(x.categoryName || '—', 'neutral') },
        { key: 'amount', label: 'المبلغ', num: true, render: x => `<strong class="text-danger">${u.fmtNum(x.amount)}</strong>`, footer: r => `<span class="text-danger">${u.fmtMoney(u.sum(r, 'amount'))}</span>` }, { key: 'method', label: 'الدفع', render: x => e(ERP.sales.methodName(x.method)), text: x => ERP.sales.methodName(x.method) },
        { key: 'supplierId', label: 'الجهة', render: x => e((ERP.purchasing.supplier(x.supplierId) || {}).name || '—'), text: x => (ERP.purchasing.supplier(x.supplierId) || {}).name || '' },
        ...(canM ? [{ id: 'a', label: '', sortable: false, export: false, class: 'actions', render: x => `<button class="btn btn-icon btn-sm btn-ghost" data-e="${x.id}"><i class="fas fa-pen"></i></button><button class="btn btn-icon btn-sm btn-ghost text-danger" data-d="${x.id}"><i class="fas fa-trash"></i></button>` }] : []),
      ] });
      $('#x-period', root).onclick = ev => { const b = ev.target.closest('.pill'); if (!b) return; period = b.dataset.p; $$('.pill', ev.currentTarget).forEach(x => x.classList.toggle('active', x === b)); refresh(); };
      root.addEventListener('click', ev => { const ed = ev.target.closest('[data-e]'), dl = ev.target.closest('[data-d]'); if (ed) openForm(ed.dataset.e); if (dl) remove(dl.dataset.d); });
      if (canM) { $('#x-add', root).onclick = () => openForm(); $('#x-cats', root).onclick = manageCats; }
    },
    onShow() { refresh(); },
  });
  ERP.bus.on('db:change', u.debounce(ev => { if (table && ERP.router.current() === 'expenses' && ev?.collection === 'expenses') refresh(); }, 250));
})();
