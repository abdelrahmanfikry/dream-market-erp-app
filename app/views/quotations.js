/* ==========================================================================
   View: Quotes (عروض الأسعار) — create, edit, confirm, print, convert to invoice
   ========================================================================== */
window.ERP = window.ERP || {}; ERP.views = ERP.views || {};
(function () {
  const u = ERP.utils; const e = u.escapeHtml;
  let el, table;
  const LIST = () => ERP.sales.qlist();

  function expired(q) { return q.status === 'open' && q.validUntil && q.validUntil < u.todayISO(); }
  function stat(q) {
    if (q.status === 'converted') return { cls: 'success', label: 'محوّل لفاتورة' };
    if (q.status === 'void') return { cls: 'neutral', label: 'ملغي' };
    if (expired(q)) return { cls: 'danger', label: 'منتهي الصلاحية' };
    return q.status === 'confirmed' ? { cls: 'primary', label: 'مؤكد من العميل' } : { cls: 'info', label: 'مفتوح' };
  }
  function daysLeft(q) {
    if (q.status === 'converted' || !q.validUntil) return '';
    if (expired(q)) return 'منتهي';
    const diff = Math.ceil((new Date(q.validUntil).getTime() - Date.now()) / 86400000);
    return `${diff} يوم`;
  }

  function refresh() {
    if (!el) return;
    const all = LIST();
    const open = all.filter(q => q.status === 'open' && !expired(q));
    const conf = all.filter(q => q.status === 'confirmed');
    const exp = all.filter(q => expired(q));
    const conv = all.filter(q => q.status === 'converted');
    $('#qt-kpis', el).innerHTML = [['file-invoice', 'primary', 'عروض مفتوحة', open.length], ['handshake', 'info', 'مؤكدة', conf.length], ['clock', 'danger', 'منتهية', exp.length], ['check-double', 'success', 'محوّلة', conv.length]].map(k => `<div class="card kpi"><div class="kpi-icon ${k[1]}"><i class="fas fa-${k[0]}"></i></div><div class="kpi-body"><div class="kpi-label">${k[2]}</div><div class="kpi-value" style="font-size:1.2rem">${k[3]}</div></div></div>`).join('');
    table.setRows(all);
  }

  async function form(id = null) {
    if (!ERP.auth.require('sales.view')) return;
    const q = id ? ERP.sales.qget(id) : null; const P = ERP.db.collection('products'); const canPrice = ERP.auth.can('pos.price_edit');
    let items = q ? q.items.map(it => ({ productId: it.productId, name: it.name, qty: it.qty, price: it.price, discount: 0 })) : [];
    let customer = q && q.customerId ? ERP.crm.get(q.customerId) : null;
    const h = ERP.ui.modal({ title: q ? `تعديل عرض السعر ${e(q.no)}` : 'عرض سعر جديد', icon: 'file-invoice', size: 'xl', body: `
      <div class="form-row"><div class="form-group" style="grid-column:span 2"><label>العميل</label><input id="qt-cust" placeholder="ابحث بالاسم أو الهاتف (اختياري)" value="${e(q ? (customer ? customer.name : q.customerName) : '')}" autocomplete="off"></div>
      <div class="form-group"><label>صلاحية العرض (يوم)</label><input type="number" step="1" min="1" id="qt-days" value="${q ? Math.max(1, Math.ceil((new Date(q.validUntil).getTime() - Date.now()) / 86400000)) : ERP.settings.get('quoteValidityDays')}"></div>
      <div class="form-group"><label>نوع الخصم</label><select id="qt-dtype"><option value="fixed">مبلغ ثابت</option><option value="percent">نسبة %</option></select></div>
      <div class="form-group"><label>الخصم</label><input type="number" step="any" min="0" id="qt-disc" value="${q ? q.discountInput : 0}"></div>
      <div class="form-group" style="grid-column:span 3"><label>ملاحظات (تظهر على العرض المطبوع)</label><input id="qt-notes" value="${e(q ? q.notes : '')}"></div></div>
      <div class="form-group"><label>إضافة صنف</label><input id="qt-p" placeholder="ابحث أو امسح الباركود…" autocomplete="off"></div>
      <div class="doc-lines" id="qt-lines"></div>
      <div class="doc-summary"><div class="doc-summary-box" id="qt-sum"></div></div>`, footer: `<button class="btn" data-a="c">إلغاء</button><button class="btn btn-primary" data-a="ok"><i class="fas fa-check"></i> ${q ? 'حفظ العرض' : 'إنشاء العرض'}</button>` });
    ERP.ui.picker(h.$('#qt-cust'), { source: () => ERP.crm.active(), sub: c => `${c.phone || ''} · ${c.address || ''}`, onPick: c => { customer = c; items.forEach(l => { const p = P.get(l.productId); if (p && !l.full) l.price = ERP.sales.priceFor(p, c); }); render(); } });
    h.$('#qt-cust').addEventListener('input', () => { if (customer && h.$('#qt-cust').value !== customer.name) customer = null; });
    const calc = () => { const c = ERP.sales.compute(items, { discount: u.num(h.$('#qt-disc').value), discountType: h.$('#qt-dtype').value, applyPromos: false }); h.$('#qt-sum').innerHTML = `<div class="tot-row"><span>الأصناف (${c.itemCount} × ${u.fmtQty(c.qtyCount)})</span><span class="val">${u.fmtNum(c.subtotal)}</span></div>${c.discount ? `<div class="tot-row"><span>الخصم</span><span class="val text-danger">-${u.fmtNum(c.discount)}</span></div>` : ''}${c.tax ? `<div class="tot-row"><span>الضريبة</span><span class="val">${u.fmtNum(c.tax)}</span></div>` : ''}<div class="tot-row grand"><span>الإجمالي</span><span class="val">${u.fmtMoney(c.total)}</span></div>`; };
    const render = () => { h.$('#qt-lines').innerHTML = `<div class="doc-line head" style="grid-template-columns:2fr 100px 110px 110px 40px"><span>الصنف</span><span>الكمية</span><span>السعر</span><span>الإجمالي</span><span></span></div>` + (items.map((l, i) => `<div class="doc-line" style="grid-template-columns:2fr 100px 110px 110px 40px"><span>${e(l.name)}</span><input type="number" step="any" min="0" value="${l.qty}" data-i="${i}" data-k="qty" class="num"><input type="number" step="any" min="0" value="${l.price}" data-i="${i}" data-k="price" class="num" ${canPrice ? '' : 'readonly tabindex="-1" title="تعديل السعر يحتاج صلاحية pos.price_edit"'}><span class="num fw-700">${u.fmtNum(l.qty * l.price)}</span><button class="btn btn-icon btn-sm btn-ghost text-danger" data-d="${i}"><i class="fas fa-xmark"></i></button></div>`).join('') || '<div class="p-3 text-center muted text-sm">لا أصناف</div>'); calc(); };
    render();
    ERP.ui.picker(h.$('#qt-p'), { source: () => P.all().filter(p => p.active !== false), sub: p => `${p.code} · ${u.fmtMoney(p.price)} · مخزون ${u.fmtQty(p.stock)}`, clearOnPick: true, onPick: p => { const ex = items.find(l => l.productId === p.id); if (ex) ex.qty++; else items.push({ productId: p.id, name: p.name, qty: 1, price: ERP.sales.priceFor(p, customer), discount: 0 }); render(); } });
    h.$('#qt-p').addEventListener('keydown', ev => { if (ev.key === 'Enter') { const r = ERP.inventory.resolveScan(ev.target.value.trim()); if (r) { const ex = items.find(l => l.productId === r.product.id); if (ex) ex.qty += r.qty; else items.push({ productId: r.product.id, name: r.product.name, qty: r.qty, price: r.price || ERP.sales.priceFor(r.product, customer), discount: 0 }); ev.target.value = ''; render(); } } });
    h.$('#qt-lines').addEventListener('input', ev => { const i = +ev.target.dataset.i, k = ev.target.dataset.k; if (k === 'price' && !canPrice) { ev.target.value = items[i].price; return; } if (k) { items[i][k] = u.num(ev.target.value); ev.target.closest('.doc-line').querySelector('span.num').textContent = u.fmtNum(items[i].qty * items[i].price); calc(); } });
    h.$('#qt-lines').addEventListener('click', ev => { const d = ev.target.closest('[data-d]'); if (d) { items.splice(+d.dataset.d, 1); render(); } });
    h.$('#qt-disc').oninput = calc; h.$('#qt-dtype').onchange = calc;
    h.$('[data-a=c]').onclick = () => h.close();
    h.$('[data-a=ok]').onclick = () => {
      items = items.filter(l => u.num(l.qty) > 0); if (!items.length) return ERP.ui.warn('أضف أصنافاً أولاً');
      const discount = u.num(h.$('#qt-disc').value), dtype = h.$('#qt-dtype').value;
      const c = ERP.sales.compute(items, { discount, discountType: dtype, applyPromos: false });
      const vd = u.num(h.$('#qt-days').value, 7);
      const data = { customerId: customer ? customer.id : null, customerName: h.$('#qt-cust').value.trim(), items: c.items, subtotal: c.subtotal, discount: c.discount, discountInput: discount, discountType: dtype, tax: c.tax, total: c.total, notes: h.$('#qt-notes').value.trim(), validUntil: u.toISODate(u.addDays(new Date(), vd)) };
      try { if (q) { ERP.sales.updateQuotation(q.id, { ...data, status: q.status === 'void' ? 'open' : q.status }); h.close(); ERP.ui.success('تم حفظ العرض'); } else { ERP.sales.createQuotation({ cart: items, customerId: customer ? customer.id : null, customerName: h.$('#qt-cust').value.trim(), discount, discountType: dtype, notes: h.$('#qt-notes').value.trim(), validDays: vd }); h.close(); ERP.ui.success('تم إنشاء العرض'); } refresh(); } catch (err) { ERP.ui.error(err.message); }
    };
  }

  function details(id) {
    const q = ERP.sales.qget(id); if (!q) return ERP.ui.error('عرض السعر غير موجود');
    const st = stat(q); const cv = stat(q).cls === 'success';
    const canDel = ERP.auth.can('sales.manage'), canConv = ERP.auth.can('pos.use'); // delete = manage invoices; convert = issues a sale
    const h = ERP.ui.modal({ title: `عرض سعر <span class="num">${e(q.no)}</span>`, icon: 'file-invoice', size: 'xl', body: `
      <div class="detail-grid mb-3"><div class="detail-item"><div class="dl">العميل</div><div class="dv">${q.customerId ? `<a href="#/customers?id=${q.customerId}">${e(q.customerName)}</a>` : e(q.customerName || '—')}</div></div><div class="detail-item"><div class="dl">التاريخ</div><div class="dv num">${u.fmtDateTime(q.date)}</div></div><div class="detail-item"><div class="dl">ساري حتى</div><div class="dv num">${q.validUntil ? u.fmtDate(q.validUntil) : '—'}</div></div><div class="detail-item"><div class="dl">الحالة</div><div class="dv">${u.badge(st.label, st.cls)}</div></div>${q.saleNo ? `<div class="detail-item"><div class="dl">الفاتورة</div><div class="dv"><a class="num" href="#/sales?detail=${q.saleId}">${e(q.saleNo)}</a></div></div>` : ''}${q.notes ? `<div class="detail-item" style="grid-column:1/-1"><div class="dl">ملاحظات</div><div class="dv">${e(q.notes)}</div></div>` : ''}</div>
      <div class="table-wrap"><table class="table table-compact"><thead><tr><th>الصنف</th><th class="num">الكمية</th><th class="num">السعر</th><th class="num">الخصم</th><th class="num">الإجمالي</th></tr></thead><tbody>${q.items.map(it => `<tr><td>${e(it.name)}</td><td class="num">${u.fmtQty(it.qty)}</td><td class="num">${u.fmtNum(it.price)}</td><td class="num">${it.discount ? '-' + u.fmtNum(it.discount) : ''}</td><td class="num">${u.fmtNum(it.total)}</td></tr>`).join('')}</tbody></table></div>
      <div class="doc-summary"><div class="doc-summary-box"><div class="tot-row"><span>الإجمالي قبل الخصم</span><span class="val">${u.fmtNum(q.subtotal)}</span></div>${q.discount ? `<div class="tot-row"><span>الخصم</span><span class="val text-danger">-${u.fmtNum(q.discount)}</span></div>` : ''}${q.tax ? `<div class="tot-row"><span>الضريبة</span><span class="val">${u.fmtNum(q.tax)}</span></div>` : ''}<div class="tot-row grand"><span>الإجمالي</span><span class="val">${u.fmtMoney(q.total)}</span></div></div></div>`,
      footer: `<button class="btn" data-a="c">إغلاق</button><div class="flex-1"></div>${q.status !== 'void' && !cv ? `<button class="btn btn-outline" data-a="print"><i class="fas fa-print"></i> طباعة</button>${q.status !== 'converted' ? `<button class="btn btn-outline" data-a="confirm"><i class="fas fa-handshake"></i> ${q.status === 'confirmed' ? 'إعادة للفتح' : 'تأكيد العميل'}</button>` : ''}<button class="btn btn-outline" data-a="edit"><i class="fas fa-pen"></i> تعديل</button>${canDel ? '<button class="btn btn-danger" data-a="del"><i class="fas fa-trash"></i></button>' : ''}${canConv ? '<button class="btn btn-success" data-a="conv"><i class="fas fa-check-double"></i> تحويل لفاتورة</button>' : ''}` : ''}` });
    h.$('[data-a=c]').onclick = () => h.close();
    if (h.$('[data-a=print]')) h.$('[data-a=print]').onclick = () => ERP.print.quotation(q, { previewOnly: true });
    if (h.$('[data-a=edit]')) h.$('[data-a=edit]').onclick = () => { h.close(); form(q.id); };
    if (h.$('[data-a=confirm]')) h.$('[data-a=confirm]').onclick = () => { ERP.sales.updateQuotation(q.id, { status: q.status === 'confirmed' ? 'open' : 'confirmed' }); ERP.audit.log('quotation.confirm', q.no, q.id); h.close(); refresh(); };
    if (h.$('[data-a=del]')) h.$('[data-a=del]').onclick = async () => { if (!ERP.auth.require('sales.manage')) return; if (await ERP.ui.confirm(`حذف عرض السعر ${e(q.no)}؟`, { danger: true })) { ERP.sales.removeQuotation(q.id); h.close(); refresh(); } };
    if (h.$('[data-a=conv]')) h.$('[data-a=conv]').onclick = async () => { if (!ERP.auth.require('pos.use')) return; if (!await ERP.ui.confirm(`تحويل عرض السعر ${e(q.no)} إلى فاتورة بيع (المبلغ ${u.fmtMoney(q.total)})؟`, { okText: 'تحويل' })) return; try { const r = ERP.sales.convertQuotation(q.id); h.close(); ERP.ui.success(`تم التحويل — فاتورة ${r.no}`); refresh(); ERP.views.sales && ERP.views.sales.refresh && setTimeout(ERP.views.sales.refresh, 200); if (ERP.settings.get('receiptAutoPrint')) ERP.print.sale(r); } catch (err) { ERP.ui.error(err.message); } };
  }

  ERP.views.quotations = { form, details, refresh };
  ERP.router.register({
    id: 'quotations', title: 'عروض الأسعار', icon: 'file-invoice', section: 'العمليات', order: 4.5, perm: 'sales.view',
    badge() { const n = LIST().filter(q => q.status === 'open' && !expired(q)).length; return n ? { text: n } : null; },
    render(root) {
      el = root;
      root.innerHTML = `<div class="page-header"><div><h2><i class="fas fa-file-invoice"></i> عروض الأسعار</h2><div class="desc">عروض أسعار للعملاء → تأكيد → تحويل مباشر لفاتورة بيع</div></div><div class="page-actions"><button class="btn btn-primary" id="qt-add"><i class="fas fa-plus"></i> عرض جديد</button></div></div><div class="kpi-grid mb-4" id="qt-kpis"></div><div id="qt-table"></div>`;
      table = ERP.ui.table({ el: $('#qt-table', root), rows: [], exportName: 'عروض الأسعار', exportPerm: 'sales.export', defaultSort: { key: 'date', dir: 'desc' }, columns: [
        { key: 'no', label: 'الرقم', render: q => `<strong class="num">${e(q.no)}</strong>` },
        { key: 'date', label: 'التاريخ', render: q => `<span class="num text-sm">${u.fmtDateTime(q.date)}</span>`, text: q => u.fmtDateTime(q.date) },
        { key: 'customerName', label: 'العميل', render: (q, t) => `<div class="fw-600">${u.highlight(q.customerName || (ERP.settings.get('posDefaultCustomer')), t)}</div>` },
        { id: 'n', label: 'الأصناف', num: true, render: q => q.items.length, sortable: false },
        { key: 'total', label: 'الإجمالي', num: true, render: q => `<strong>${u.fmtNum(q.total)}</strong>`, footer: r => u.fmtMoney(u.sum(r.filter(x => x.status !== 'converted' && x.status !== 'void'), 'total')) },
        { id: 'valid', label: 'الصلاحية', render: q => { if (q.status === 'converted') return '—'; if (expired(q)) return `<span class="text-danger fw-600">منتهي</span>`; if (!q.validUntil) return '—'; const d = Math.ceil((new Date(q.validUntil).getTime() - Date.now()) / 86400000); return `<span class="num">${d <= 7 ? '<span class="text-warning">' : ''}${d} يوم${d <= 7 ? '</span>' : ''}</span>`; }, sortable: false },
        { key: 'status', label: 'الحالة', render: q => u.badge(stat(q).label, stat(q).cls), text: q => stat(q).label },
        { id: 'a', label: '', sortable: false, export: false, class: 'actions', render: q => `<button class="btn btn-icon btn-sm btn-soft-primary" data-pr="${q.id}" title="معاينة وطباعة"><i class="fas fa-print"></i></button>${q.status !== 'converted' && q.status !== 'void' ? `${ERP.auth.can('pos.use') ? `<button class="btn btn-icon btn-sm btn-soft-success" data-cv="${q.id}" title="تحويل لفاتورة"><i class="fas fa-check-double"></i></button>` : ''}<button class="btn btn-icon btn-sm btn-ghost" data-ed="${q.id}" title="تعديل"><i class="fas fa-pen"></i></button>` : ''}` },
      ], onRowClick: q => details(q.id) });
      $('#qt-add', root).onclick = () => form();
      root.addEventListener('click', ev => { const pr = ev.target.closest('[data-pr]'); if (pr) { ev.stopPropagation(); const q = ERP.sales.qget(pr.dataset.pr); return ERP.print.quotation(q, { previewOnly: true }); } const cv = ev.target.closest('[data-cv]'); if (cv) { ev.stopPropagation(); return details(cv.dataset.cv); } const ed = ev.target.closest('[data-ed]'); if (ed) { ev.stopPropagation(); form(ed.dataset.ed); } });
      refresh();
    },
    onShow(root, params) { refresh(); if (params.new) form(); },
  });
  ERP.bus.on('db:change', u.debounce(ev => { if (el && ERP.router.current() === 'quotations' && ev?.collection === 'quotations') refresh(); }, 250));
})();