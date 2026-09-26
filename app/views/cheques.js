/* ==========================================================================
   View: Cheques — incoming/outgoing register, due reminders, supplier payables aging
   ========================================================================== */
window.ERP = window.ERP || {}; ERP.views = ERP.views || {};
(function () {
  const u = ERP.utils; const e = u.escapeHtml; const C = () => ERP.cheques;
  let el, tIn, tOut, tab = 'in';
  const ACT = { deposit: ['building-columns', 'إيداع للتحصيل', 'btn-soft-warning'], collect: ['circle-check', 'تحصيل', 'btn-soft-success'], clear: ['circle-check', 'صرف', 'btn-soft-success'], bounce: ['rotate-left', 'ارتداد', 'btn-soft-danger'], cancel: ['ban', 'إلغاء', 'btn-ghost'] };
  const canDir = dir => ERP.auth.can(dir === 'in' ? 'customers.receipt' : 'purchases.pay');
  const dueCell = c => { const open = C().OPEN[c.dir].includes(c.status); const d = C().dayDiff(u.todayISO(), c.dueDate); return `<span class="num">${u.fmtDate(c.dueDate)}</span>${open ? (d < 0 ? ` <span class="badge badge-danger">متأخر ${-d} يوم</span>` : d <= u.num(ERP.settings.get('chequeAlertDays'), 3) ? ` <span class="badge badge-warning">${d === 0 ? 'اليوم' : `بعد ${d} يوم`}</span>` : '') : ''}`; };

  function kpis() {
    const t = C().totals(); const d = C().due(); const ag = ERP.auth.can('purchases.view') || ERP.auth.can('suppliers.manage') ? C().aging().totals : null;
    return [['money-check', 'info', 'شيكات في الخزينة', u.fmtMoney(t.inSafe)], ['building-columns', 'warning', 'تحت التحصيل في البنك', u.fmtMoney(t.inCollecting)], ['money-check-dollar', 'danger', 'شيكات صادرة لم تُصرف', u.fmtMoney(t.outOpen)], ['bell', d.some(x => x.overdue) ? 'danger' : 'primary', 'استحقاقات قريبة / متأخرة', `${d.filter(x => !x.overdue).length} / ${d.filter(x => x.overdue).length}`], ...(ag ? [['clock', ag.overdue > 0 ? 'danger' : 'success', 'متأخرات الموردين', u.fmtMoney(ag.overdue)]] : [])]
      .map(k => `<div class="card kpi"><div class="kpi-icon ${k[1]}"><i class="fas fa-${k[0]}"></i></div><div class="kpi-body"><div class="kpi-label">${k[2]}</div><div class="kpi-value" style="font-size:1.2rem">${k[3]}</div></div></div>`).join('');
  }
  function actBtns(c) { return canDir(c.dir) ? C().actions(c).map(a => `<button class="btn btn-sm ${ACT[a][2]}" data-act="${a}" data-id="${c.id}" data-tip="${ACT[a][1]}"><i class="fas fa-${ACT[a][0]}"></i> ${ACT[a][1]}</button>`).join(' ') : ''; }
  function columns(dir) {
    return [
      { key: 'number', label: 'رقم الشيك', render: (c, t) => `<strong class="num">${u.highlight(c.number, t)}</strong><div class="text-xs muted num">${e(c.no)}</div>`, text: c => c.number + ' ' + c.no },
      { key: 'bank', label: 'البنك', render: (c, t) => u.highlight(c.bank || '—', t) },
      { key: 'partyName', label: dir === 'in' ? 'العميل' : 'المورد', render: (c, t) => u.highlight(c.partyName, t) },
      { key: 'amount', label: 'المبلغ', num: true, render: c => `<strong>${u.fmtNum(c.amount)}</strong>`, footer: r => u.fmtMoney(u.sum(r.filter(c => c.status !== 'cancelled'), 'amount')) },
      { key: 'issueDate', label: 'تاريخ التحرير', render: c => `<span class="num text-sm">${u.fmtDate(c.issueDate)}</span>` },
      { key: 'dueDate', label: 'الاستحقاق', render: dueCell, text: c => c.dueDate },
      { key: 'status', label: 'الحالة', render: c => C().statusBadge(c), text: c => C().statusLabel(c) },
      { key: 'notes', label: 'ملاحظات', render: c => `<span class="text-xs muted">${e(c.notes || '')}</span>` },
      { id: 'a', label: '', sortable: false, export: false, class: 'actions', render: c => `<div class="flex gap-1 flex-wrap">${actBtns(c)}<button class="btn btn-icon btn-sm btn-ghost" data-act="view" data-id="${c.id}"><i class="fas fa-eye"></i></button></div>` },
    ];
  }
  function refresh() {
    if (!el) return;
    el.querySelector('#chq-kpis').innerHTML = kpis();
    const all = C().all(); const st = el.querySelector('#chq-status').value;
    const f = c => !st || (st === 'open' ? C().OPEN[c.dir].includes(c.status) : c.status === st);
    if (tIn) tIn.setRows(all.filter(c => c.dir === 'in' && f(c)));
    if (tOut) tOut.setRows(all.filter(c => c.dir === 'out' && f(c)));
    renderDue(); renderAging();
    ERP.router.updateBadges && ERP.router.updateBadges();
  }
  function renderDue() {
    const box = el.querySelector('#chq-due'); const days = u.num(el.querySelector('#chq-days').value, 7);
    const d = C().due({ days }); const bills = ERP.auth.can('purchases.view') || ERP.auth.can('suppliers.manage') ? C().dueBills({ days }) : [];
    box.innerHTML = `<div class="grid grid-2 gap-4"><div class="card"><div class="card-header"><h3><i class="fas fa-money-check"></i> شيكات مستحقة خلال ${days} يوم أو متأخرة</h3></div><div class="card-body p-2">${d.length ? d.map(x => `<div class="list-row"><div class="grow"><div class="title">${x.cheque.dir === 'in' ? u.badge('وارد', 'info') : u.badge('صادر', 'purple')} <span class="num">${e(x.cheque.number)}</span> — ${e(x.cheque.partyName)}</div><div class="sub">${e(x.cheque.bank || '')} · ${C().statusLabel(x.cheque)} · يستحق <span class="num">${u.fmtDate(x.cheque.dueDate)}</span> ${x.overdue ? `<span class="text-danger fw-700">متأخر ${-x.daysLeft} يوم</span>` : x.daysLeft === 0 ? '<span class="text-warning fw-700">اليوم</span>' : `بعد ${x.daysLeft} يوم`}</div></div><div class="val num">${u.fmtNum(x.cheque.amount)}</div>${actBtns(x.cheque)}</div>`).join('') : '<div class="empty-state"><i class="fas fa-check"></i><p>لا شيكات مستحقة</p></div>'}</div></div>
      <div class="card"><div class="card-header"><h3><i class="fas fa-file-invoice"></i> فواتير موردين مستحقة خلال ${days} يوم أو متأخرة</h3></div><div class="card-body p-2">${bills.length ? bills.map(x => `<div class="list-row"><div class="grow"><div class="title"><span class="num">${e(x.bill.po.no)}</span> — ${e(x.supplier.name)}</div><div class="sub">مدة السداد ${x.bill.terms} يوم · يستحق <span class="num">${u.fmtDate(x.bill.dueDate)}</span> ${x.overdue ? `<span class="text-danger fw-700">متأخر ${-x.daysLeft} يوم</span>` : x.daysLeft === 0 ? '<span class="text-warning fw-700">اليوم</span>' : `بعد ${x.daysLeft} يوم`}</div></div><div class="val num">${u.fmtNum(x.bill.open)}</div>${ERP.auth.can('purchases.pay') ? `<button class="btn btn-sm btn-soft-success" data-pay-sup="${x.supplier.id}">سداد</button>` : ''}</div>`).join('') : `<div class="empty-state"><i class="fas fa-check"></i><p>لا فواتير مستحقة</p><p class="text-xs muted">تُحسب من «مدة السداد» في بيانات المورد</p></div>`}</div></div></div>`;
  }
  function agingData() { return C().aging(); }
  function renderAging() {
    const box = el.querySelector('#chq-aging');
    if (!(ERP.auth.can('purchases.view') || ERP.auth.can('suppliers.manage'))) { box.innerHTML = '<div class="alert alert-warning">ليس لديك صلاحية عرض المشتريات</div>'; return; }
    const a = agingData(); const B = C().BUCKETS;
    box.innerHTML = `<div class="flex gap-2 mb-3 flex-wrap"><button class="btn btn-outline" id="chq-ag-print"><i class="fas fa-print"></i> طباعة</button><button class="btn btn-outline" id="chq-ag-xlsx"><i class="fas fa-file-excel"></i> تصدير</button><div class="text-xs muted" style="align-self:center">الرصيد يُوزَّع على أحدث فواتير المورد أولاً؛ العمر من تاريخ الاستلام، و«متأخر» حسب تاريخ الاستحقاق (الاستلام + مدة السداد).</div></div>
      <div class="table-wrap"><table class="table table-compact"><thead><tr><th>المورد</th><th class="num">مدة السداد</th><th class="num">الرصيد</th>${Object.values(B).map(l => `<th class="num">${l}</th>`).join('')}<th class="num">متأخر عن الاستحقاق</th></tr></thead>
      <tbody>${a.rows.map(r => `<tr class="cursor-pointer" data-sup="${r.supplier.id}"><td><div class="fw-600">${e(r.supplier.name)}</div><div class="text-xs muted">${r.bills.length} فاتورة مفتوحة${r.unallocated ? ` · رصيد سابق ${u.fmtNum(r.unallocated)}` : ''}</div></td><td class="num">${u.num(r.supplier.paymentTerms) ? r.supplier.paymentTerms + ' يوم' : '—'}</td><td class="num fw-700">${u.fmtNum(r.balance)}</td>${Object.keys(B).map(k => `<td class="num">${r[k] ? u.fmtNum(r[k]) : '—'}</td>`).join('')}<td class="num ${r.overdue ? 'text-danger fw-700' : ''}">${r.overdue ? u.fmtNum(r.overdue) : '—'}</td></tr>`).join('') || `<tr><td colspan="8" class="text-center muted">لا مستحقات للموردين</td></tr>`}</tbody>
      <tfoot><tr class="fw-700"><td>الإجمالي</td><td></td><td class="num">${u.fmtNum(a.totals.balance)}</td>${Object.keys(B).map(k => `<td class="num">${u.fmtNum(a.totals[k])}</td>`).join('')}<td class="num text-danger">${u.fmtNum(a.totals.overdue)}</td></tr></tfoot></table></div>`;
    const rows = () => a.rows.map(r => [r.supplier.name, u.num(r.supplier.paymentTerms), u.fmtNum(r.balance), ...Object.keys(B).map(k => u.fmtNum(r[k])), u.fmtNum(r.overdue)]);
    const cols = [{ label: 'المورد' }, { label: 'مدة السداد', num: true }, { label: 'الرصيد', num: true }, ...Object.values(B).map(l => ({ label: l, num: true })), { label: 'متأخر', num: true }];
    box.querySelector('#chq-ag-print').onclick = () => ERP.print.table({ title: 'أعمار ديون الموردين', subtitle: `حتى ${u.fmtDate(a.today)}`, columns: cols, rows: rows(), summary: [{ label: 'الإجمالي', value: u.fmtMoney(a.totals.balance) }, { label: 'متأخر', value: u.fmtMoney(a.totals.overdue) }], landscape: true });
    box.querySelector('#chq-ag-xlsx').onclick = () => exportRows('أعمار-ديون-الموردين', cols.map(c => c.label), a.rows.map(r => [r.supplier.name, u.num(r.supplier.paymentTerms), r.balance, ...Object.keys(B).map(k => r[k]), r.overdue]));
  }
  function exportRows(name, head, rows) {
    if (typeof XLSX !== 'undefined') { const ws = XLSX.utils.aoa_to_sheet([head, ...rows]); ws['!views'] = [{ RTL: true }]; const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Sheet1'); XLSX.writeFile(wb, `${name}-${u.todayISO()}.xlsx`); }
    else u.downloadText(u.toCSV(rows, head.map((label, i) => ({ label, value: r => r[i] }))), `${name}-${u.todayISO()}.csv`, 'text/csv');
  }
  function supplierBills(id) {
    const r = C().aging({ supplierIds: [id] }).rows[0]; const s = ERP.purchasing.supplier(id);
    ERP.ui.view(`فواتير ${e(s.name)} المفتوحة`, r ? `<div class="table-wrap"><table class="table table-compact"><thead><tr><th>الأمر</th><th>تاريخ الاستلام</th><th>الاستحقاق</th><th class="num">العمر</th><th class="num">قيمة الفاتورة</th><th class="num">المتبقي منها</th></tr></thead><tbody>${r.bills.map(b => `<tr><td class="num">${e(b.po.no)}</td><td class="num">${u.fmtDate(b.billDate)}</td><td class="num">${u.fmtDate(b.dueDate)} ${b.lateDays > 0 ? `<span class="badge badge-danger">متأخر ${b.lateDays} يوم</span>` : ''}</td><td class="num">${b.age} يوم</td><td class="num">${u.fmtNum(b.amount)}</td><td class="num fw-700">${u.fmtNum(b.open)}</td></tr>`).join('')}${r.unallocated ? `<tr><td colspan="5">رصيد سابق / افتتاحي غير مرتبط بفواتير</td><td class="num fw-700">${u.fmtNum(r.unallocated)}</td></tr>` : ''}</tbody></table></div>` : '<p class="muted">لا رصيد مستحق</p>', { icon: 'file-invoice' });
  }

  async function receiveForm(pre = {}) {
    if (!ERP.auth.require('customers.receipt')) return;
    const cust = u.sortBy(ERP.crm.active(), 'name');
    const r = await ERP.ui.form({ title: 'استلام شيك من عميل', icon: 'money-check', values: { issueDate: u.todayISO(), ...pre }, fields: [
      { name: 'info', type: 'html', cols: 2, html: '<div class="alert alert-info text-sm"><i class="fas fa-circle-info"></i> يُسجَّل كتحصيل من العميل (يقل رصيده ويُسدَّد من فواتيره الآجلة) ويُقيَّد في «شيكات تحت التحصيل» حتى يُحصَّل من البنك.</div>' },
      { name: 'customerId', label: 'العميل', type: 'select', required: true, cols: 2, options: `<option value="">— اختر —</option>${cust.map(c => `<option value="${c.id}">${e(c.name)}${u.num(c.balance) ? ` — رصيد ${u.fmtNum(c.balance)}` : ''}</option>`).join('')}` },
      { name: 'number', label: 'رقم الشيك', required: true }, { name: 'bank', label: 'البنك' },
      { name: 'amount', label: 'المبلغ', type: 'number', step: 'any', min: 0.01, required: true }, { name: 'dueDate', label: 'تاريخ الاستحقاق', type: 'date', required: true },
      { name: 'issueDate', label: 'تاريخ التحرير', type: 'date' }, { name: 'notes', label: 'ملاحظات' },
    ], submitText: 'تسجيل الشيك', onSubmit: d => C().receive(d) });
    if (r) { ERP.ui.success(`تم تسجيل الشيك ${r.number} — ${u.fmtMoney(r.amount)}`); refresh(); }
  }
  async function issueForm(pre = {}) {
    if (!ERP.auth.require('purchases.pay')) return;
    const sups = u.sortBy(ERP.purchasing.suppliers().filter(s => s.active !== false), 'name');
    const r = await ERP.ui.form({ title: 'إصدار شيك لمورد', icon: 'money-check-dollar', values: { issueDate: u.todayISO(), ...pre }, fields: [
      { name: 'info', type: 'html', cols: 2, html: '<div class="alert alert-info text-sm"><i class="fas fa-circle-info"></i> يُسجَّل كسداد للمورد (يقل المستحق له) ويُقيَّد في «أوراق الدفع» حتى يُصرف من البنك.</div>' },
      { name: 'supplierId', label: 'المورد', type: 'select', required: true, cols: 2, options: `<option value="">— اختر —</option>${sups.map(s => `<option value="${s.id}">${e(s.name)}${u.num(s.balance) ? ` — مستحق ${u.fmtNum(s.balance)}` : ''}</option>`).join('')}` },
      { name: 'number', label: 'رقم الشيك', required: true }, { name: 'bank', label: 'البنك (حسابنا)' },
      { name: 'amount', label: 'المبلغ', type: 'number', step: 'any', min: 0.01, required: true }, { name: 'dueDate', label: 'تاريخ الاستحقاق', type: 'date', required: true },
      { name: 'issueDate', label: 'تاريخ التحرير', type: 'date' }, { name: 'notes', label: 'ملاحظات' },
    ], submitText: 'إصدار الشيك', onSubmit: d => C().issue(d) });
    if (r) { ERP.ui.success(`تم إصدار الشيك ${r.number} — ${u.fmtMoney(r.amount)}`); refresh(); }
  }
  async function doAction(act, id) {
    const c = C().get(id); if (!c) return;
    if (!canDir(c.dir)) return ERP.ui.error('ليس لديك صلاحية');
    try {
      if (act === 'view') return details(id);
      if (act === 'deposit') { const b = await ERP.ui.prompt('البنك المودَع فيه (اختياري)', { title: `إيداع الشيك ${e(c.number)} للتحصيل`, value: c.bank || '' }); if (b === null) return; C().deposit(id, { bank: b }); }
      if (act === 'collect') { const r = await ERP.ui.form({ title: `تحصيل الشيك ${e(c.number)} — ${u.fmtMoney(c.amount)}`, icon: 'circle-check', values: { date: u.todayISO(), accountSys: 'bank' }, fields: [{ name: 'date', label: 'تاريخ التحصيل', type: 'date', required: true }, { name: 'accountSys', label: 'إلى حساب', type: 'select', options: '<option value="bank">البنك</option><option value="cash">الخزينة (صرف نقدي)</option>' }], submitText: 'تحصيل' }); if (!r) return; C().collect(id, r); }
      if (act === 'clear') { const r = await ERP.ui.form({ title: `صرف الشيك الصادر ${e(c.number)} — ${u.fmtMoney(c.amount)}`, icon: 'circle-check', values: { date: u.todayISO() }, fields: [{ name: 'date', label: 'تاريخ الصرف من البنك', type: 'date', required: true }], submitText: 'تأكيد الصرف' }); if (!r) return; C().clear(id, r); }
      if (act === 'bounce') { const reason = await ERP.ui.prompt('سبب الارتداد', { title: `ارتداد الشيك ${e(c.number)}` }); if (reason === null) return; if (!await ERP.ui.confirm(c.dir === 'in' ? `سيعود مبلغ <strong>${u.fmtMoney(c.amount)}</strong> على حساب العميل <strong>${e(c.partyName)}</strong> وتُعاد فواتيره مفتوحة. متابعة؟` : `سيعود مبلغ <strong>${u.fmtMoney(c.amount)}</strong> مستحقاً للمورد <strong>${e(c.partyName)}</strong>. متابعة؟`, { danger: true, okText: 'تسجيل الارتداد' })) return; C().bounce(id, { reason }); }
      if (act === 'cancel') { if (!await ERP.ui.confirm(`إلغاء الشيك <strong>${e(c.number)}</strong> وحذف ${c.dir === 'in' ? 'إيصال التحصيل' : 'سند السداد'} المرتبط به نهائياً؟ (للتسجيل الخاطئ أو الشيك المُعاد قبل الإيداع)`, { danger: true, okText: 'إلغاء الشيك' })) return; C().cancel(id, {}); }
      ERP.ui.success('تم'); refresh();
    } catch (err) { ERP.ui.error(err.message); }
  }
  function details(id) {
    const c = C().get(id);
    const jr = ERP.accounting.entries({ refType: 'cheque' }).filter(j => j.refId === id);
    const h = ERP.ui.view(`شيك <span class="num">${e(c.number)}</span> ${C().statusBadge(c)}`, `<div class="detail-grid mb-3">${[['النوع', c.dir === 'in' ? 'وارد من عميل' : 'صادر لمورد'], [c.dir === 'in' ? 'العميل' : 'المورد', e(c.partyName)], ['البنك', e(c.bank || '—')], ['المبلغ', u.fmtMoney(c.amount)], ['تاريخ التحرير', u.fmtDate(c.issueDate)], ['الاستحقاق', u.fmtDate(c.dueDate)], [c.dir === 'in' ? 'إيصال التحصيل' : 'سند السداد', e(c.receiptNo || c.paymentNo || '—')], ['ملاحظات', e(c.notes || '—')]].map(x => `<div class="detail-item"><div class="dl">${x[0]}</div><div class="dv">${x[1]}</div></div>`).join('')}</div>
      <h4 class="mb-2">سجل الحالة</h4><div class="timeline mb-3">${(c.history || []).map(x => `<div class="timeline-item"><div class="text-sm"><strong>${e(C().statusLabel({ ...c, status: x.status }))}</strong> <span class="muted num">${u.fmtDateTime(x.at)}</span> ${x.user ? `· ${e(x.user)}` : ''}</div><div class="text-xs muted">${e(x.note || '')}</div></div>`).join('')}</div>
      ${jr.length ? `<h4 class="mb-2">القيود</h4><div class="table-wrap"><table class="table table-compact"><thead><tr><th>القيد</th><th>التاريخ</th><th>البيان</th><th class="num">المبلغ</th></tr></thead><tbody>${jr.map(j => `<tr><td class="num">${e(j.no)}</td><td class="num">${u.fmtDate(j.date)}</td><td>${e(j.memo)}</td><td class="num">${u.fmtNum(j.total)}</td></tr>`).join('')}</tbody></table></div>` : ''}`,
      { icon: 'money-check', footer: `<button class="btn" data-act="view-close">إغلاق</button><div class="flex-1"></div>${actBtns(c)}` });
    h.el.addEventListener('click', ev => { const b = ev.target.closest('[data-act][data-id]'); if (!b) return; h.close(); doAction(b.dataset.act, b.dataset.id); });
  }
  function setTab(t) { tab = t; el.querySelectorAll('#chq-tabs .tab').forEach(x => x.classList.toggle('active', x.dataset.t === t)); el.querySelectorAll('.chq-pane').forEach(x => x.classList.toggle('hidden', x.dataset.p !== t)); }

  ERP.views.cheques = { receiveForm, issueForm, refresh, supplierBills, details };
  ERP.router.register({
    id: 'cheques', title: 'الشيكات والاستحقاقات', icon: 'money-check', section: 'المالية', order: 2.5, perm: ['customers.receipt', 'purchases.pay', 'purchases.view', 'accounting.view'],
    badge() { try { const d = C().due(); return d.length ? { text: d.length, kind: d.some(x => x.overdue) ? 'danger' : 'warning' } : null; } catch { return null; } },
    render(root) {
      el = root; C().ensure();
      root.innerHTML = `<div class="page-header"><div><h2><i class="fas fa-money-check"></i> الشيكات والاستحقاقات</h2><div class="desc">شيكات العملاء والموردين، التحصيل والارتداد، ومواعيد سداد الموردين</div></div>
        <div class="page-actions">${ERP.auth.can('customers.receipt') ? '<button class="btn btn-primary" id="chq-rcv"><i class="fas fa-plus"></i> استلام شيك من عميل</button>' : ''}${ERP.auth.can('purchases.pay') ? '<button class="btn btn-outline" id="chq-iss"><i class="fas fa-plus"></i> إصدار شيك لمورد</button>' : ''}</div></div>
        <div class="kpi-grid mb-4" id="chq-kpis"></div>
        <div class="flex gap-2 items-center flex-wrap mb-3"><div class="tabs" id="chq-tabs" style="margin:0"><button class="tab active" data-t="in">الشيكات الواردة</button><button class="tab" data-t="out">الشيكات الصادرة</button><button class="tab" data-t="due">الاستحقاقات</button><button class="tab" data-t="aging">أعمار ديون الموردين</button></div><div class="flex-1"></div>
          <select id="chq-status" style="max-width:170px"><option value="open">المفتوحة فقط</option><option value="">كل الحالات</option>${[...new Set([...Object.keys(C().IN), ...Object.keys(C().OUT)])].map(k => `<option value="${k}">${(C().IN[k] || C().OUT[k])[0]}</option>`).join('')}</select>
          <label class="text-sm">خلال <input type="number" id="chq-days" value="${Math.max(7, u.num(ERP.settings.get('chequeAlertDays'), 3))}" min="0" style="width:70px"> يوم</label></div>
        <div class="chq-pane" data-p="in"><div id="chq-t-in"></div></div><div class="chq-pane hidden" data-p="out"><div id="chq-t-out"></div></div>
        <div class="chq-pane hidden" data-p="due" id="chq-due"></div><div class="chq-pane hidden" data-p="aging" id="chq-aging"></div>`;
      tIn = ERP.ui.table({ el: '#chq-t-in', rows: [], exportName: 'الشيكات-الواردة', defaultSort: { key: 'dueDate', dir: 'asc' }, columns: columns('in'), rowClass: c => ['cancelled', 'bounced'].includes(c.status) ? 'muted' : '' });
      tOut = ERP.ui.table({ el: '#chq-t-out', rows: [], exportName: 'الشيكات-الصادرة', defaultSort: { key: 'dueDate', dir: 'asc' }, columns: columns('out'), rowClass: c => ['cancelled', 'bounced'].includes(c.status) ? 'muted' : '' });
      root.querySelector('#chq-tabs').onclick = ev => { const b = ev.target.closest('.tab'); if (b) setTab(b.dataset.t); };
      root.querySelector('#chq-status').onchange = refresh;
      root.querySelector('#chq-days').onchange = () => renderDue();
      const rb = root.querySelector('#chq-rcv'); if (rb) rb.onclick = () => receiveForm();
      const ib = root.querySelector('#chq-iss'); if (ib) ib.onclick = () => issueForm();
      root.addEventListener('click', ev => {
        const a = ev.target.closest('[data-act][data-id]'); if (a) { ev.stopPropagation(); return doAction(a.dataset.act, a.dataset.id); }
        const p = ev.target.closest('[data-pay-sup]'); if (p) { ev.stopPropagation(); return ERP.views.suppliers && ERP.views.suppliers.payDialog(p.dataset.paySup); }
        const s = ev.target.closest('tr[data-sup]'); if (s) return supplierBills(s.dataset.sup);
      });
    },
    onShow(root, params) { if (params.tab) setTab(params.tab); refresh(); if (params.id) details(params.id); },
  });
  ERP.bus.on('db:change', u.debounce(ev => { if (el && ERP.router.current() === 'cheques' && ['cheques', 'payments', 'purchases', 'suppliers'].includes(ev?.collection)) refresh(); }, 250));
})();
