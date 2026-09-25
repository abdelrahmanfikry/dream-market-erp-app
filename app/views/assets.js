/* ==========================================================================
   View: Fixed assets & depreciation
   ========================================================================== */
window.ERP = window.ERP || {}; ERP.views = ERP.views || {};
(function () {
  const u = ERP.utils; const e = u.escapeHtml;
  let el, table;
  function refresh() {
    if (!table) return; table.setRows(ERP.assets.all()); const s = ERP.assets.summary();
    $('#as-kpis', el).innerHTML = [['building', 'primary', 'الأصول النشطة', s.count], ['coins', 'info', 'إجمالي التكلفة', u.fmtMoney(s.cost)], ['arrow-trend-down', 'warning', 'مجمع الإهلاك', u.fmtMoney(s.accumulated)], ['scale-balanced', 'success', 'القيمة الدفترية', u.fmtMoney(s.bookValue)], ['calendar', s.pending ? 'danger' : 'purple', 'إهلاك شهري', `${u.fmtMoney(s.monthly)}${s.pending ? ` <span class="badge badge-danger">${s.pending} معلق</span>` : ''}`]].map(k => `<div class="card kpi"><div class="kpi-icon ${k[1]}"><i class="fas fa-${k[0]}"></i></div><div class="kpi-body"><div class="kpi-label">${k[2]}</div><div class="kpi-value" style="font-size:1.2rem">${k[3]}</div></div></div>`).join('');
  }
  async function openForm() {
    if (!ERP.auth.require('accounting.manage')) return;
    const methods = ERP.sales.methods().filter(m => !m.isCredit);
    const r = await ERP.ui.form({ title: 'أصل ثابت جديد', icon: 'building', size: 'lg', values: { purchaseDate: u.todayISO(), lifeMonths: 60, salvage: 0, payMethod: 'cash' }, fields: [
      { name: 'name', label: 'اسم الأصل', required: true, cols: 2 }, { name: 'category', label: 'الفئة', type: 'select', options: ERP.assets.CATS.map(c => `<option>${c}</option>`).join('') }, { name: 'serial', label: 'الرقم التسلسلي' },
      { name: 'cost', label: 'التكلفة', type: 'number', step: 'any', min: 1, required: true }, { name: 'salvage', label: 'القيمة التخريدية', type: 'number', step: 'any', min: 0 }, { name: 'lifeMonths', label: 'العمر الإنتاجي (شهر)', type: 'number', min: 1, required: true, help: '60 شهر = 5 سنوات' }, { name: 'purchaseDate', label: 'تاريخ الشراء', type: 'date' },
      { name: 'payMethod', label: 'طريقة الشراء', type: 'select', options: methods.map(m => `<option value="${m.id}">${e(m.name)}</option>`).join('') + '<option value="credit">آجل على مورد</option><option value="opening">رصيد افتتاحي (أصل موجود مسبقاً)</option>' }, { name: 'supplierId', label: 'المورد', type: 'select', options: u.options(ERP.purchasing.suppliers(), { empty: '— بدون —' }) },
      { name: 'location', label: 'الموقع' }, { name: 'notes', label: 'ملاحظات', type: 'textarea', cols: 2 },
    ], onSubmit: d => ERP.assets.create(d) });
    if (r) ERP.ui.success('تم إضافة الأصل');
  }
  function details(id) {
    const a = ERP.assets.get(id); const dep = ERP.assets.monthlyDep(a);
    const h = ERP.ui.view(`${e(a.name)} <span class="badge badge-neutral num">${e(a.code)}</span> ${u.badge({ active: 'نشط', fully_depreciated: 'مُهلَك بالكامل', disposed: 'مستبعد' }[a.status] || a.status, a.status === 'active' ? 'success' : a.status === 'disposed' ? 'neutral' : 'warning')}`, `
      <div class="detail-grid mb-3"><div class="detail-item"><div class="dl">الفئة</div><div class="dv">${e(a.category)}</div></div><div class="detail-item"><div class="dl">تاريخ الشراء</div><div class="dv num">${u.fmtDate(a.purchaseDate)}</div></div><div class="detail-item"><div class="dl">التكلفة</div><div class="dv">${u.fmtMoney(a.cost)}</div></div><div class="detail-item"><div class="dl">القيمة التخريدية</div><div class="dv">${u.fmtMoney(a.salvage)}</div></div><div class="detail-item"><div class="dl">العمر</div><div class="dv">${a.lifeMonths} شهر</div></div><div class="detail-item"><div class="dl">الإهلاك الشهري</div><div class="dv">${u.fmtMoney(dep)}</div></div><div class="detail-item"><div class="dl">مجمع الإهلاك</div><div class="dv text-warning">${u.fmtMoney(a.accumulated)}</div></div><div class="detail-item"><div class="dl">القيمة الدفترية</div><div class="dv text-success">${u.fmtMoney(a.bookValue)}</div></div>${a.serial ? `<div class="detail-item"><div class="dl">الرقم التسلسلي</div><div class="dv num">${e(a.serial)}</div></div>` : ''}${a.location ? `<div class="detail-item"><div class="dl">الموقع</div><div class="dv">${e(a.location)}</div></div>` : ''}</div>
      <div class="progress mb-3"><div class="progress-bar warning" style="width:${u.pct(a.accumulated, a.cost - a.salvage)}%"></div></div>
      ${a.status === 'disposed' ? `<div class="alert alert-info"><i class="fas fa-circle-info"></i> استُبعد في ${u.fmtDate(a.disposedAt)} بسعر ${u.fmtMoney(a.salePrice)} (${a.gainLoss >= 0 ? 'ربح' : 'خسارة'} ${u.fmtMoney(Math.abs(a.gainLoss))})</div>` : ''}
      <h4 class="mb-2 mt-3">سجل الإهلاك</h4><div class="table-wrap" style="max-height:300px;overflow:auto"><table class="table table-compact"><thead><tr><th>الشهر</th><th class="num">المبلغ</th></tr></thead><tbody>${(a.history || []).slice().reverse().map(h => `<tr><td>${u.fmtMonth(h.month + '-01')}</td><td class="num">${u.fmtNum(h.amount)}</td></tr>`).join('') || '<tr><td colspan="2" class="text-center muted">لم يُسجَّل إهلاك بعد</td></tr>'}</tbody></table></div>`,
      { footer: `<button class="btn" data-a="c">إغلاق</button>${a.status !== 'disposed' && ERP.auth.can('accounting.manage') ? `<button class="btn btn-soft-danger" data-a="d"><i class="fas fa-right-from-bracket"></i> استبعاد / بيع</button>` : ''}` });
    h.$('[data-a=c]').onclick = () => h.close();
    const d = h.$('[data-a=d]'); if (d) d.onclick = async () => { h.close(); const r = await ERP.ui.form({ title: `استبعاد ${e(a.name)}`, icon: 'right-from-bracket', fields: [{ name: 'i', type: 'html', cols: 2, html: `<div class="alert alert-info">القيمة الدفترية الحالية ${u.fmtMoney(a.bookValue)} — أي فرق عن سعر البيع يُسجَّل ربحاً أو خسارة.</div>` }, { name: 'salePrice', label: 'سعر البيع (0 = تكهين)', type: 'number', step: 'any', min: 0, value: 0 }, { name: 'method', label: 'طريقة التحصيل', type: 'select', options: ERP.sales.methods().filter(m => !m.isCredit).map(m => `<option value="${m.id}">${e(m.name)}</option>`).join('') }, { name: 'notes', label: 'ملاحظات', cols: 2 }], submitText: 'استبعاد', onSubmit: dd => ERP.assets.dispose(id, dd) }); if (r) ERP.ui.success('تم الاستبعاد'); };
  }
  ERP.views.assets = { openForm, details, refresh };
  ERP.router.register({
    id: 'assets', title: 'الأصول الثابتة', icon: 'building', section: 'المالية', order: 5, perm: 'accounting.view',
    badge() { const n = ERP.assets.pending().length; return n ? { text: n, kind: 'danger' } : null; },
    render(root) {
      el = root; const canM = ERP.auth.can('accounting.manage');
      root.innerHTML = `<div class="page-header"><div><h2><i class="fas fa-building"></i> الأصول الثابتة</h2><div class="desc">سجل الأصول والإهلاك الشهري بطريقة القسط الثابت مع الترحيل المحاسبي التلقائي</div></div><div class="page-actions">${canM ? '<button class="btn btn-outline" id="as-run"><i class="fas fa-play"></i> تشغيل إهلاك الشهر</button><button class="btn btn-primary" id="as-add"><i class="fas fa-plus"></i> أصل جديد</button>' : ''}</div></div><div class="kpi-grid mb-4" id="as-kpis"></div><div id="as-table"></div>`;
      table = ERP.ui.table({ el: '#as-table', rows: [], exportName: 'الأصول الثابتة', columns: [
        { key: 'code', label: 'الكود', render: a => `<span class="num">${e(a.code)}</span>` }, { key: 'name', label: 'الأصل', render: (a, t) => `<div class="fw-600">${u.highlight(a.name, t)}</div><div class="text-xs muted">${e(a.category)}${a.location ? ' · ' + e(a.location) : ''}</div>` },
        { key: 'purchaseDate', label: 'الشراء', render: a => `<span class="num">${u.fmtDate(a.purchaseDate)}</span>` }, { key: 'cost', label: 'التكلفة', num: true, render: a => u.fmtNum(a.cost), footer: r => u.fmtMoney(u.sum(r.filter(a => a.status !== 'disposed'), 'cost')) },
        { id: 'dep', label: 'شهري', num: true, render: a => u.fmtNum(ERP.assets.monthlyDep(a)), sortValue: a => ERP.assets.monthlyDep(a), text: a => u.fmtNum(ERP.assets.monthlyDep(a)) }, { key: 'accumulated', label: 'المجمع', num: true, render: a => `<span class="text-warning">${u.fmtNum(a.accumulated)}</span>` },
        { key: 'bookValue', label: 'الدفترية', num: true, render: a => `<strong>${u.fmtNum(a.bookValue)}</strong><div class="progress mt-1" style="width:80px"><div class="progress-bar warning" style="width:${u.pct(a.accumulated, a.cost - a.salvage)}%"></div></div>`, footer: r => u.fmtMoney(u.sum(r.filter(a => a.status !== 'disposed'), 'bookValue')) },
        { key: 'status', label: 'الحالة', render: a => u.badge({ active: 'نشط', fully_depreciated: 'مُهلَك', disposed: 'مستبعد' }[a.status] || a.status, a.status === 'active' ? 'success' : a.status === 'disposed' ? 'neutral' : 'warning') },
      ], rowClass: a => a.status === 'disposed' ? 'muted' : '', onRowClick: a => details(a.id) });
      if (canM) { $('#as-add', root).onclick = openForm; $('#as-run', root).onclick = async () => { const p = ERP.assets.pending(); if (!p.length) return ERP.ui.info('لا يوجد إهلاك معلق لهذا الشهر'); if (!await ERP.ui.confirm(`تسجيل إهلاك ${p.length} أصل حتى ${u.fmtMonth(u.todayISO())}؟ سيُرحَّل قيد لكل شهر متأخر.`)) return; const r = ERP.assets.runDepreciation(); ERP.ui.success(`تم ترحيل ${r.entries} قيد بقيمة ${u.fmtMoney(r.total)}`); refresh(); }; }
    },
    onShow() { refresh(); },
  });
  ERP.bus.on('db:change', u.debounce(ev => { if (table && ERP.router.current() === 'assets' && ev?.collection === 'assets') refresh(); }, 250));
})();
