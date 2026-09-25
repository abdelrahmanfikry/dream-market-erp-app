/* ==========================================================================
   View: Dashboard
   ========================================================================== */
window.ERP = window.ERP || {}; ERP.views = ERP.views || {};
(function () {
  const u = ERP.utils; const e = u.escapeHtml;
  let period = 'today';
  let el;

  function kpi(icon, kind, label, value, delta, sub) {
    const d = delta === undefined || delta === null ? '' : `<div class="kpi-delta ${delta >= 0 ? 'up' : 'down'}"><i class="fas fa-arrow-${delta >= 0 ? 'up' : 'down'}"></i> ${Math.abs(delta).toFixed(0)}% <span class="muted fw-500">عن الفترة السابقة</span></div>`;
    return `<div class="card kpi card-hover"><div class="kpi-icon ${kind}"><i class="fas fa-${icon}"></i></div><div class="kpi-body"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div>${d}${sub ? `<div class="text-xs muted mt-1">${sub}</div>` : ''}</div></div>`;
  }

  function refresh() {
    if (!el) return;
    const fin = ERP.auth.can('dashboard.finance');
    const cmp = ERP.reports.compare(period);
    const s = cmp.cur;
    const cash = ERP.accounting.cashPosition();
    const low = ERP.inventory.lowStock(), out = ERP.inventory.outOfStock();
    const debtors = ERP.crm.debtors();
    const inv = ERP.inventory.valuation();
    const P = ERP.reports.period(period);

    $('#dash-kpis', el).innerHTML = [
      kpi('cash-register', 'primary', `مبيعات ${P.label}`, u.fmtMoney(s.net), cmp.deltaNet, `${s.count} فاتورة · متوسط ${u.fmtMoney(s.avg)}`),
      fin ? kpi('chart-line', 'success', 'مجمل الربح', u.fmtMoney(s.grossProfit), cmp.deltaProfit, `هامش ${s.margin.toFixed(1)}%`) : '',
      kpi('receipt', 'info', 'عدد الفواتير', u.fmtInt(s.count), cmp.deltaCount, `${u.fmtQty(s.items)} قطعة مباعة`),
      fin ? kpi('vault', 'purple', 'النقدية بالخزينة', u.fmtMoney(cash.cash), null, `بنك ${u.fmtMoney(cash.bank)} · محافظ ${u.fmtMoney(cash.wallet)}`) : '',
      kpi('hand-holding-dollar', 'warning', 'مديونيات العملاء', u.fmtMoney(u.sum(debtors, 'balance')), null, `${debtors.length} عميل مدين`),
      fin ? kpi('truck', 'danger', 'مستحقات الموردين', u.fmtMoney(cash.ap), null, `${ERP.purchasing.suppliers().filter(x => x.balance > 0).length} مورد`) : '',
      kpi('boxes-stacked', 'info', 'قيمة المخزون', fin ? u.fmtMoney(inv.totalValue) : u.fmtQty(inv.totalQty) + ' قطعة', null, `${ERP.db.collection('products').count()} منتج · بيع متوقع ${fin ? u.fmtMoneyShort(inv.totalRetail) : ''}`),
      kpi('triangle-exclamation', out.length ? 'danger' : 'warning', 'تنبيهات المخزون', `${low.length}`, null, `${out.length} نفذ · ${low.length - out.length} منخفض · ${ERP.inventory.expiring().length} قرب الانتهاء`),
    ].join('');

    // charts
    const days = period === 'today' || period === 'yesterday' ? ERP.reports.salesByDay(u.toISODate(u.addDays(new Date(), -13)), u.todayISO()) : ERP.reports.salesByDay(P.from || u.toISODate(u.addDays(new Date(), -29)), P.to || u.todayISO());
    ERP.charts.line('#dash-chart-sales', { labels: days.map(d => u.fmtDate(d.date).slice(0, 5)), series: [{ label: 'المبيعات', data: days.map(d => u.round(d.total)) }, ...(fin ? [{ label: 'الربح', data: days.map(d => u.round(d.profit)), color: '#16a34a' }] : [])] });
    const cats = ERP.reports.salesByCategory(P.from, P.to);
    ERP.charts.doughnut('#dash-chart-cats', { labels: cats.map(c => c.name), data: cats.map(c => u.round(c.total)), colors: cats.map(c => c.color) });
    const mix = ERP.reports.paymentMix(P.from, P.to);
    $('#dash-paymix', el).innerHTML = mix.length ? mix.map(m => { const pct = u.pct(m.total, u.sum(mix, 'total')); return `<div class="mb-3"><div class="flex justify-between text-sm mb-1"><span>${e(m.name)}</span><strong class="num">${u.fmtMoney(m.total)}</strong></div><div class="progress"><div class="progress-bar ${m.method === 'cash' ? 'success' : m.method === 'credit' ? 'warning' : ''}" style="width:${pct}%"></div></div></div>`; }).join('') : '<div class="empty-state"><i class="fas fa-wallet"></i><p>لا مبيعات في هذه الفترة</p></div>';

    // lists
    const top = ERP.reports.topProducts(P.from, P.to, 6);
    $('#dash-top-products', el).innerHTML = top.length ? top.map((p, i) => `<div class="list-row"><div class="rank ${['gold', 'silver', 'bronze'][i] || ''}">${i + 1}</div><div class="grow"><div class="title truncate">${e(p.name)}</div><div class="sub">${u.fmtQty(p.qty)} قطعة${fin ? ` · ربح ${u.fmtMoney(p.profit)}` : ''}</div></div><div class="val">${u.fmtMoney(p.total)}</div></div>`).join('') : '<div class="empty-state"><i class="fas fa-box-open"></i><p>لا بيانات</p></div>';
    const topC = ERP.reports.topCustomers(P.from, P.to, 5);
    $('#dash-top-customers', el).innerHTML = topC.length ? topC.map((c, i) => `<div class="list-row cursor-pointer" onclick="ERP.router.go('customers',{id:'${c.customerId}'})"><div class="avatar sm">${e(u.initials(c.name))}</div><div class="grow"><div class="title truncate">${e(c.name)}</div><div class="sub">${c.count} فاتورة</div></div><div class="val">${u.fmtMoney(c.total)}</div></div>`).join('') : '<div class="empty-state"><i class="fas fa-users"></i><p>لا عملاء مسجلون في مبيعات الفترة</p></div>';
    $('#dash-low-stock', el).innerHTML = low.length ? u.sortBy(low, 'stock').slice(0, 7).map(p => `<div class="list-row"><div class="grow"><div class="title truncate">${e(p.name)}</div><div class="sub">${e(p.code)} · الحد الأدنى ${u.fmtQty(p.minStock ?? ERP.settings.get('lowStockThreshold'))}</div></div>${u.stockBadge(p)}<div class="val ${p.stock <= 0 ? 'text-danger' : 'text-warning'}">${u.fmtQty(p.stock)}</div></div>`).join('') : '<div class="empty-state"><i class="fas fa-circle-check text-success"></i><p>المخزون بحالة جيدة</p></div>';
    const acts = ERP.reports.recentActivity(10);
    $('#dash-activity', el).innerHTML = acts.length ? `<div class="timeline">${acts.map(a => `<div class="timeline-item ${a.kind}"><div class="flex items-center gap-2"><i class="fas fa-${a.icon} muted"></i><strong class="text-sm">${e(a.title)}</strong><span class="text-xs subtle" style="margin-inline-start:auto">${u.relTime(a.at)}</span></div><div class="text-xs muted">${e(a.sub)}</div></div>`).join('')}</div>` : '<div class="empty-state"><i class="fas fa-clock-rotate-left"></i><p>لا نشاط بعد</p></div>';
    const debtorsList = u.sortBy(debtors, 'balance', 'desc').slice(0, 5);
    $('#dash-debtors', el).innerHTML = debtorsList.length ? debtorsList.map(c => `<div class="list-row cursor-pointer" onclick="ERP.router.go('customers',{id:'${c.id}'})"><div class="avatar sm" style="background:var(--warning-bg);color:var(--warning-fg)">${e(u.initials(c.name))}</div><div class="grow"><div class="title truncate">${e(c.name)}</div><div class="sub num">${e(c.phone || '')}</div></div><div class="val text-danger">${u.fmtMoney(c.balance)}</div></div>`).join('') : '<div class="empty-state"><i class="fas fa-circle-check text-success"></i><p>لا مديونيات</p></div>';
    // shift banner
    const sh = ERP.shifts.current();
    const banner = $('#dash-shift', el);
    if (ERP.auth.can('pos.use')) banner.innerHTML = sh ? `<div class="alert alert-success"><i class="fas fa-cash-register"></i><div class="flex-1">وردية مفتوحة <strong>${e(sh.no)}</strong> منذ ${u.fmtTime(sh.openedAt)} — مبيعات ${u.fmtMoney(sh.salesTotal)} (${sh.salesCount} فاتورة)</div><button class="btn btn-sm btn-outline" onclick="ERP.router.go('shifts')">إدارة الوردية</button></div>` : `<div class="alert alert-warning"><i class="fas fa-circle-exclamation"></i><div class="flex-1">لا توجد وردية مفتوحة. افتح وردية لبدء البيع.</div><button class="btn btn-sm btn-primary" onclick="ERP.views.shifts.openDialog()">فتح وردية</button></div>`;
  }

  ERP.views.dashboard = { refresh };
  ERP.router.register({
    id: 'dashboard', title: 'لوحة التحكم', icon: 'gauge-high', section: 'الرئيسية', order: 1, perm: 'dashboard.view',
    render(root) {
      el = root;
      root.innerHTML = `
        <div class="page-header">
          <div><h2><i class="fas fa-gauge-high"></i> مرحباً، ${e(ERP.auth.current().name)} 👋</h2><div class="desc">${u.dayName(new Date())} ${u.fmtDate(new Date(), { long: true })} — نظرة عامة على أداء المتجر</div></div>
          <div class="page-actions"><div class="pills" id="dash-period">${['today', 'week', 'month', 'year'].map(k => `<button class="pill ${k === period ? 'active' : ''}" data-p="${k}">${ERP.reports.period(k).label}</button>`).join('')}</div>
            <button class="btn btn-outline" id="dash-refresh"><i class="fas fa-rotate"></i></button></div>
        </div>
        <div id="dash-shift" class="mb-4"></div>
        <div class="kpi-grid" id="dash-kpis"></div>
        <div class="card mt-4"><div class="card-header"><h3><i class="fas fa-bolt"></i> إجراءات سريعة</h3></div><div class="card-body"><div class="quick-actions">
          ${[['pos', 'cash-register', 'بيع جديد', 'pos.use'], ['products', 'plus', 'إضافة منتج', 'products.manage', 'ERP.views.products.openForm()'], ['purchases', 'truck', 'أمر شراء', 'purchases.manage', 'ERP.views.purchases.openForm()'], ['customers', 'user-plus', 'عميل جديد', 'customers.manage', 'ERP.views.customers.openForm()'], ['expenses', 'wallet', 'تسجيل مصروف', 'expenses.manage', 'ERP.views.expenses.openForm()'], ['inventory', 'clipboard-check', 'جرد', 'inventory.adjust', "ERP.router.go('inventory',{tab:'stocktake'})"], ['reports', 'chart-pie', 'التقارير', 'reports.view'], ['backup', 'cloud-arrow-down', 'نسخة احتياطية', 'backup.manage']].filter(a => ERP.auth.can(a[3])).map(a => `<button class="quick-action" onclick="${a[4] || `ERP.router.go('${a[0]}')`}"><i class="fas fa-${a[1]}"></i><span>${a[2]}</span></button>`).join('')}
        </div></div></div>
        <div class="dash-grid">
          <div class="card"><div class="card-header"><h3><i class="fas fa-chart-area"></i> اتجاه المبيعات</h3></div><div class="card-body"><div class="chart-box"><canvas id="dash-chart-sales"></canvas></div></div></div>
          <div class="card"><div class="card-header"><h3><i class="fas fa-chart-pie"></i> المبيعات حسب الفئة</h3></div><div class="card-body"><div class="chart-box"><canvas id="dash-chart-cats"></canvas></div></div></div>
        </div>
        <div class="dash-grid thirds">
          <div class="card"><div class="card-header"><h3><i class="fas fa-fire"></i> الأكثر مبيعاً</h3><a href="#/reports" class="text-sm">الكل</a></div><div class="card-body" id="dash-top-products"></div></div>
          <div class="card"><div class="card-header"><h3><i class="fas fa-triangle-exclamation"></i> تنبيهات المخزون</h3><a href="#/inventory?filter=low" class="text-sm">الكل</a></div><div class="card-body" id="dash-low-stock"></div></div>
          <div class="card"><div class="card-header"><h3><i class="fas fa-wallet"></i> طرق الدفع</h3></div><div class="card-body" id="dash-paymix"></div></div>
        </div>
        <div class="dash-grid thirds">
          <div class="card"><div class="card-header"><h3><i class="fas fa-crown"></i> أفضل العملاء</h3></div><div class="card-body" id="dash-top-customers"></div></div>
          <div class="card"><div class="card-header"><h3><i class="fas fa-hand-holding-dollar"></i> أكبر المديونيات</h3><a href="#/customers?filter=debtors" class="text-sm">الكل</a></div><div class="card-body" id="dash-debtors"></div></div>
          <div class="card"><div class="card-header"><h3><i class="fas fa-clock-rotate-left"></i> آخر النشاطات</h3></div><div class="card-body" id="dash-activity" style="max-height:380px;overflow-y:auto"></div></div>
        </div>`;
      $('#dash-period', root).addEventListener('click', ev => { const b = ev.target.closest('.pill'); if (!b) return; period = b.dataset.p; $$('.pill', ev.currentTarget).forEach(x => x.classList.toggle('active', x === b)); refresh(); });
      $('#dash-refresh', root).onclick = () => { refresh(); ERP.ui.toast('تم التحديث', 'success', { duration: 1200 }); };
    },
    onShow() { refresh(); },
  });
  ERP.bus.on('db:change', u.debounce(() => { if (ERP.router.current() === 'dashboard') refresh(); }, 400));
  ERP.bus.on('shift:change', () => { if (ERP.router.current() === 'dashboard') refresh(); });
})();
