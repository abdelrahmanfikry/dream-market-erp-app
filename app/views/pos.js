/* ==========================================================================
   View: Point of Sale
   ========================================================================== */
window.ERP = window.ERP || {}; ERP.views = ERP.views || {};
(function () {
  const u = ERP.utils; const e = u.escapeHtml;
  let el, cart = [], customer = null, cat = 'all', discount = 0, discountType = 'fixed', loyaltyPoints = 0, lastSale = null;
  let scanBuf = '', scanTimer = null;
  let discountApprover = null;
  const MAX_QTY = 100000; // anything above this in a qty box is a mis-scan, not a real quantity
  /* customer-facing display (display.html) — BroadcastChannel with localStorage fallback */
  const display = { ch: null, post(state) { const s = ERP.settings.all(); const payload = { store: s.storeName, slogan: s.storeSlogan, currency: s.currency, footer: s.receiptThanks, thanks: s.receiptThanks, welcome: 'أهلاً وسهلاً بكم في ' + s.storeName, ...state }; try { display.ch = display.ch || new BroadcastChannel('dm-pos-display'); display.ch.postMessage(payload); } catch { /* */ } try { localStorage.setItem('dm_erp:__display', JSON.stringify(payload)); } catch { /* */ } } };
  function reprice() { cart.forEach(l => { if (!l.manualPrice) { const p = ERP.db.collection('products').get(l.productId); if (p) l.price = ERP.units.priceFor(p, l.unitId, customer); } }); }
  async function needApproval(reason) { const ap = await ERP.auth.approve({ reason }); if (!ap.ok) { ERP.ui.warn('لم يتم الاعتماد'); return null; } return ap.approver; }

  function products() { const P = ERP.db.collection('products').all().filter(p => p.active !== false); return cat === 'all' ? P : cat === 'fav' ? P.filter(p => p.favorite) : P.filter(p => p.categoryId === cat); }
  function totals() { return ERP.sales.compute(cart, { discount, discountType, loyaltyDiscount: loyaltyPoints ? ERP.crm.pointsValue(loyaltyPoints) : 0 }); }

  function renderCats() {
    const cats = ERP.db.collection('categories').all();
    $('#pos-cats', el).innerHTML = `<button class="pos-cat ${cat === 'all' ? 'active' : ''}" data-cat="all"><i class="fas fa-border-all"></i> الكل</button><button class="pos-cat ${cat === 'fav' ? 'active' : ''}" data-cat="fav"><i class="fas fa-star"></i> المفضلة</button>` + cats.map(c => `<button class="pos-cat ${cat === c.id ? 'active' : ''}" data-cat="${c.id}"><i class="fas fa-${e(c.icon || 'tag')}" style="color:${e(c.color)}"></i> ${e(c.name)}</button>`).join('');
  }
  function renderProducts() {
    const term = $('#pos-search', el).value.trim();
    let list = products();
    if (term) list = list.filter(p => u.match(p.name, term) || u.match(p.code, term) || (p.barcode && p.barcode.includes(term)));
    list = u.sortBy(list, 'name').slice(0, 120);
    const wh = ERP.settings.get('posDefaultWarehouse') || ERP.inventory.defaultWh(); const neg = ERP.inventory.canGoNegative();
    $('#pos-products', el).innerHTML = list.length ? list.map(p => { const tag = ERP.promotions.tagFor(p.id); return `<div class="pos-product" data-id="${p.id}">${tag ? `<span class="offer-tag">${e(tag)}</span>` : ''}<div class="pos-product-img">${p.image ? `<img src="${e(p.image)}" loading="lazy">` : `<i class="fas fa-${(ERP.db.collection('categories').get(p.categoryId) || {}).icon || 'box'}"></i>`}</div><div class="pos-product-name">${u.highlight(p.name, term)}</div><div class="flex justify-between items-end"><div class="pos-product-price">${u.fmtNum(p.price)}</div><div class="pos-product-stock"></div></div></div>`; }).join('') : '<div class="empty-state" style="grid-column:1/-1"><i class="fas fa-box-open"></i><h4>لا منتجات</h4></div>';
    refreshStock(wh, neg);
  }
  /* product cards show what is still available after the cart (display only — stock is deducted when the invoice is saved) */
  const inCart = id => u.round(cart.filter(l => l.productId === id).reduce((a, l) => a + u.num(l.qty) * (u.num(l.factor, 1) || 1), 0), 3); // base units (carton lines count qty × factor)
  function refreshStock(wh = ERP.settings.get('posDefaultWarehouse') || ERP.inventory.defaultWh(), neg = ERP.inventory.canGoNegative()) {
    el.querySelectorAll('#pos-products .pos-product[data-id]').forEach(card => {
      const p = ERP.db.collection('products').get(card.dataset.id); if (!p) return;
      const q = ERP.inventory.whQty(p, wh), c = inCart(p.id), avail = u.round(q - c, 3), min = u.num(p.minStock, 5);
      card.classList.toggle('out', avail <= 0 && !neg);
      const b = card.querySelector('.pos-product-stock');
      b.classList.toggle('stock-low', avail <= min);
      b.textContent = u.fmtQty(avail);
      b.title = c ? `الرصيد ${u.fmtQty(q)} − في السلة ${u.fmtQty(c)}` : `الرصيد ${u.fmtQty(q)}`;
    });
  }
  function renderCart() {
    const t = totals();
    const body = $('#pos-cart', el);
    body.innerHTML = cart.length ? t.items.map((it, i) => `<div class="cart-line" data-id="${it.productId}" data-i="${i}"><div><div class="cart-line-name">${e(it.name)}</div><div class="cart-line-meta">${unitSelect(cart[i])}${u.fmtNum(it.price)} × ${u.fmtQty(it.qty)}${it.unitId ? ` <span class="muted" title="بالوحدة الأساسية">(=${u.fmtQty(it.baseQty)})</span>` : ''}${it.discount ? ` <span class="text-danger">-${u.fmtNum(it.discount)}</span>` : ''}${it.promoLabel ? ` <span class="badge badge-danger">${e(it.promoLabel)}</span>` : ''}</div></div><div class="cart-line-total">${u.fmtNum(it.total)}</div><div class="cart-line-actions"><div class="qty-control"><button data-act="dec"><i class="fas fa-minus"></i></button><input type="number" step="any" value="${it.qty}" data-act="qty"><button data-act="inc"><i class="fas fa-plus"></i></button></div><div class="flex gap-1"><button class="btn btn-icon btn-sm btn-ghost" data-act="price" data-tip="تعديل السعر${ERP.auth.can('pos.price_edit') ? '' : ' (يحتاج مشرف)'}"><i class="fas fa-tag"></i></button><button class="btn btn-icon btn-sm btn-ghost" data-act="disc" data-tip="خصم${ERP.auth.can('pos.discount') ? '' : ' (يحتاج مشرف)'}"><i class="fas fa-percent"></i></button><button class="btn btn-icon btn-sm btn-ghost text-danger" data-act="del"><i class="fas fa-trash"></i></button></div></div></div>`).join('') : '<div class="empty-state"><i class="fas fa-cart-shopping"></i><h4>السلة فارغة</h4><p class="text-sm">امسح باركود أو اختر منتجاً</p></div>';
    const s = ERP.settings.all();
    $('#pos-totals', el).innerHTML = `
      <div class="tot-row"><span>الإجمالي (${t.itemCount} صنف / ${u.fmtQty(t.qtyCount)})</span><span class="val">${u.fmtNum(t.subtotal)}</span></div>
      ${t.promoDiscount ? `<div class="tot-row text-danger"><span><i class="fas fa-gift"></i> عروض</span><span class="val text-danger">-${u.fmtNum(t.promoDiscount)}</span></div>` : ''}
      <div class="tot-row"><span>خصم الفاتورة <button class="btn btn-sm btn-ghost" id="pos-disc-btn"><i class="fas fa-pen"></i> ${discountType === 'percent' ? discount + '%' : ''}</button></span><span class="val ${t.invoiceDiscount ? 'text-danger' : ''}">${t.invoiceDiscount ? '-' : ''}${u.fmtNum(t.invoiceDiscount)}</span></div>
      ${s.taxEnabled ? `<div class="tot-row"><span>ض.ق.م ${s.taxRate}%${s.taxInclusive ? ' (مضمنة)' : ''}</span><span class="val">${u.fmtNum(t.tax)}</span></div>` : ''}
      ${t.loyaltyDiscount ? `<div class="tot-row text-success"><span><i class="fas fa-star"></i> نقاط ولاء (${loyaltyPoints})</span><span class="val text-success">-${u.fmtNum(t.loyaltyDiscount)}</span></div>` : ''}
      <div class="tot-row grand"><span>الصافي</span><span class="val">${u.fmtMoney(t.total)}</span></div>`;
    $('#pos-disc-btn', el).onclick = editDiscount;
    $('#pos-pay-btn', el).disabled = !cart.length;
    $('#pos-credit-btn', el).disabled = !cart.length || !customer || !ERP.auth.can('pos.credit');
    $('#pos-cart-count', el).textContent = cart.length;
    refreshStock();
    display.post({ mode: 'cart', items: t.items.map(i => ({ name: i.name, qty: u.fmtQty(i.qty), price: i.price, total: i.total })), subtotal: t.subtotal, discount: t.discount + t.loyaltyDiscount, tax: t.tax, total: t.total, customer: customer ? customer.name : '' });
  }
  /* small unit switcher on a cart line — only for products that have extra units */
  function unitSelect(l) { const p = l && ERP.db.collection('products').get(l.productId); const list = ERP.units.list(p); if (!list.length) return ''; return `<select class="cart-unit" data-act="unit" title="وحدة البيع" style="min-height:24px;height:24px;padding:0 .3rem;font-size:.75rem;width:auto;max-width:120px;margin-inline-end:.35rem"><option value="">${e(ERP.units.baseName(p))}</option>${list.map(x => `<option value="${e(x.id)}" ${x.id === l.unitId ? 'selected' : ''}>${e(x.name)} ×${u.fmtQty(x.factor)}</option>`).join('')}</select>`; }
  function renderCustomer() {
    const box = $('#pos-customer-box', el);
    if (customer) { const c = ERP.crm.get(customer.id) || customer; customer = c; box.innerHTML = `<div class="selected-customer"><div class="avatar sm">${e(u.initials(c.name))}</div><div class="flex-1 truncate"><div class="fw-600">${e(c.name)}</div><div class="text-xs muted num">${e(c.phone || '')} · رصيد ${u.fmtMoney(c.balance)} · ${u.fmtInt(c.loyaltyPoints)} نقطة</div></div>${c.balance > 0 ? u.badge('مدين', 'warning') : ''}<button class="btn btn-icon btn-sm btn-ghost" id="pos-cust-clear"><i class="fas fa-xmark"></i></button></div>${ERP.settings.get('loyaltyEnabled') && c.loyaltyPoints >= ERP.settings.get('loyaltyMinRedeem') ? `<button class="btn btn-sm btn-soft-success" id="pos-loyalty"><i class="fas fa-star"></i> استبدال</button>` : ''}`; $('#pos-cust-clear', box).onclick = () => { customer = null; loyaltyPoints = 0; reprice(); renderCustomer(); renderCart(); }; const lb = $('#pos-loyalty', box); if (lb) lb.onclick = redeemLoyalty; }
    else { box.innerHTML = `<div class="input-icon flex-1"><i class="fas fa-user"></i><input type="text" id="pos-cust-input" placeholder="عميل نقدي — ابحث بالاسم أو الهاتف"></div><button class="btn btn-icon btn-outline" id="pos-cust-new" data-tip="عميل جديد"><i class="fas fa-user-plus"></i></button>`;
      ERP.ui.picker($('#pos-cust-input', box), { source: () => ERP.crm.active(), sub: c => `${c.phone || ''} · رصيد ${u.fmtMoney(c.balance)}`, onPick: c => { customer = c; loyaltyPoints = 0; reprice(); renderCustomer(); renderCart(); if (c.group && c.group !== 'عادي') ERP.ui.info(`تم تطبيق أسعار مجموعة "${c.group}"`, { duration: 1800 }); }, onNew: name => quickCustomer(name), newLabel: 'إضافة عميل' });
      $('#pos-cust-new', box).onclick = () => quickCustomer(''); }
  }
  async function quickCustomer(name) {
    const r = await ERP.ui.form({ title: 'عميل جديد', icon: 'user-plus', fields: [{ name: 'name', label: 'الاسم', required: true, value: name }, { name: 'phone', label: 'الهاتف', type: 'tel' }, { name: 'creditLimit', label: 'حد الائتمان', type: 'number', min: 0, value: 0 }], onSubmit: d => ERP.crm.create(d) });
    if (r) { customer = r; loyaltyPoints = 0; reprice(); renderCustomer(); renderCart(); ERP.ui.success('تم إضافة العميل'); }
  }
  async function redeemLoyalty() {
    const s = ERP.settings.all(); const max = customer.loyaltyPoints;
    const pts = await ERP.ui.prompt(`النقاط المتاحة ${max} (= ${u.fmtMoney(ERP.crm.pointsValue(max))}). كم نقطة تريد استبدالها؟`, { title: 'استبدال نقاط الولاء', type: 'number', value: max });
    if (pts === null) return; if (pts < s.loyaltyMinRedeem) return ERP.ui.warn(`الحد الأدنى ${s.loyaltyMinRedeem} نقطة`);
    loyaltyPoints = Math.min(u.num(pts), max); renderCart();
  }

  /* stock guard shared by scan/+ and typed qty: warns and returns false when qty exceeds the warehouse stock (unless negative stock is allowed) */
  /* baseQty = the product's total need in BASE units (all its cart lines, qty × factor) */
  function stockOk(p, baseQty) {
    const wh = ERP.settings.get('posDefaultWarehouse') || ERP.inventory.defaultWh();
    if (ERP.inventory.canGoNegative() || ERP.inventory.whQty(p, wh) >= baseQty - 0.0001) return true;
    const c = inCart(p.id);
    ERP.ui.beep('err'); ERP.ui.warn(`الكمية المتاحة من "${p.name}" هي ${u.fmtQty(u.round(ERP.inventory.whQty(p, wh) - c, 3))} ${ERP.units.baseName(p)}${c ? ' (بعد ما في السلة)' : ''}`); return false;
  }
  /** unit = a product unit (carton…) or null for the base unit; qty is in that unit. Same product in two units = two lines */
  function add(p, qty = 1, price = null, unit = null) {
    if (!p) return ERP.ui.beep('err');
    const uid = unit ? unit.id : null, f = unit ? u.num(unit.factor, 1) : 1;
    const line = cart.find(l => l.productId === p.id && (l.unitId || null) === uid);
    if (!stockOk(p, inCart(p.id) + qty * f)) return;
    if (line) line.qty = u.round(line.qty + qty, 3); else cart.push({ productId: p.id, name: p.name, qty, price: price ?? ERP.units.priceFor(p, uid, customer), manualPrice: price != null, discount: 0, taxRate: p.taxRate, unitId: uid, unitName: unit ? ERP.units.name(p, uid) : '', factor: f });
    ERP.ui.beep('ok'); renderCart();
    const i = cart.findIndex(l => l.productId === p.id && (l.unitId || null) === uid); const ln = $(`.cart-line[data-i="${i}"]`, el); ln && ln.scrollIntoView({ block: 'nearest' });
  }
  function scan(code) {
    const r = ERP.inventory.resolveScan(code);
    if (!r) { ERP.ui.beep('err'); return ERP.ui.warn(`لا يوجد منتج بالباركود ${code}`, { action: ERP.auth.can('products.manage') ? { label: 'إضافة منتج', onClick: () => ERP.views.products.openForm(null, { barcode: code }) } : null }); }
    if (r.unit) return add(r.product, 1, null, r.unit); // unit barcode → 1 carton at the unit's price
    add(r.product, r.qty, r.price);
  }
  async function editDiscount() {
    const h = ERP.ui.modal({ title: 'خصم الفاتورة', icon: 'percent', size: 'sm', body: `<div class="pills mb-3 w-full" style="display:flex"><button class="pill flex-1 ${discountType === 'fixed' ? 'active' : ''}" data-t="fixed">مبلغ</button><button class="pill flex-1 ${discountType === 'percent' ? 'active' : ''}" data-t="percent">نسبة %</button></div><input type="number" step="any" min="0" id="dv" value="${discount}" style="font-size:1.4rem;text-align:center">`, footer: `<button class="btn" data-a="clear">إزالة</button><button class="btn btn-primary" data-a="ok">تطبيق</button>` });
    let t = discountType;
    h.$('.pills').onclick = ev => { const b = ev.target.closest('.pill'); if (!b) return; t = b.dataset.t; h.$$('.pill').forEach(x => x.classList.toggle('active', x === b)); };
    h.$('[data-a=ok]').onclick = async () => { const v = u.num(h.$('#dv').value); const sub = totals().subtotal || 1; const pct = t === 'percent' ? v : (v / sub) * 100; const limit = u.num(ERP.settings.get('approvalDiscountLimitPct'), 10); if (v > 0 && (!ERP.auth.can('pos.discount') || pct > limit)) { const ap = await needApproval(`خصم ${pct.toFixed(1)}% على الفاتورة (الحد ${limit}%)`); if (!ap) return; discountApprover = ap; } discount = v; discountType = t; h.close(); renderCart(); };
    h.$('[data-a=clear]').onclick = () => { discount = 0; h.close(); renderCart(); };
  }
  async function lineAction(idx, act, inputEl) {
    const line = cart[+idx]; if (!line) return;
    const p = ERP.db.collection('products').get(line.productId); if (!p) return;
    const f = u.num(line.factor, 1) || 1;
    if (act === 'inc') add(p, 1, null, ERP.units.get(p, line.unitId));
    else if (act === 'unit') {
      const nu = inputEl.value || null; if (nu === (line.unitId || null)) return;
      const un = nu ? ERP.units.get(p, nu) : null; const f1 = un ? u.num(un.factor, 1) : 1;
      if (f1 > f && !stockOk(p, inCart(p.id) + line.qty * (f1 - f))) { inputEl.value = line.unitId || ''; return; }
      const twin = cart.find(l => l !== line && l.productId === p.id && (l.unitId || null) === nu);
      if (twin) { twin.qty = u.round(twin.qty + line.qty, 3); cart = cart.filter(l => l !== line); }
      else Object.assign(line, { unitId: nu, unitName: un ? ERP.units.name(p, nu) : '', factor: f1, price: ERP.units.priceFor(p, nu, customer), manualPrice: false });
      renderCart();
    }
    else if (act === 'dec') { line.qty = u.round(line.qty - 1, 3); if (line.qty <= 0) cart = cart.filter(l => l !== line); renderCart(); }
    else if (act === 'del') { cart = cart.filter(l => l !== line); renderCart(); }
    else if (act === 'qty') {
      const raw = u.normalizeDigits(String(inputEl.value).trim()); const q = u.num(raw);
      // a barcode scanned while the qty box had focus lands here as a huge number — route it to the scanner instead of setting the qty
      if (/^\d{8,}$/.test(raw) || q > MAX_QTY) {
        inputEl.value = line.qty;
        const code = [raw, raw.startsWith(String(line.qty)) ? raw.slice(String(line.qty).length) : ''].find(c => c && ERP.inventory.resolveScan(c));
        if (code) scan(code); else { ERP.ui.beep('err'); ERP.ui.warn(/^\d{8,}$/.test(raw) ? `يبدو أن باركود أُدخل في خانة الكمية (${raw}) — لم يتم تغيير الكمية` : `كمية غير منطقية (${u.fmtQty(q)}) — الحد ${u.fmtInt(MAX_QTY)}`); }
        $('#pos-search', el).focus(); return;
      }
      if (q > line.qty && !stockOk(p, inCart(p.id) + (q - line.qty) * f)) { inputEl.value = line.qty; return; }
      if (q <= 0) cart = cart.filter(l => l !== line); else line.qty = u.round(q, 3); renderCart();
    }
    else if (act === 'price') { const v = await ERP.ui.prompt(`سعر "${e(ERP.units.label(line.name, line.unitName))}" (الأصلي ${u.fmtNum(ERP.units.priceFor(p, line.unitId, customer))}${p.minPrice ? ` · الحد الأدنى ${u.fmtNum(p.minPrice * f)}` : ''})`, { title: 'تعديل السعر', type: 'number', value: line.price }); if (v !== null && v > 0) { const below = p.minPrice && v < p.minPrice * f; if (!ERP.auth.can('pos.price_edit') || (below && ERP.settings.get('approvalRequirePriceBelowMin'))) { const ap = await needApproval(`تعديل سعر "${line.name}" من ${u.fmtNum(line.price)} إلى ${u.fmtNum(v)}${below ? ' (أقل من الحد الأدنى)' : ''}`); if (!ap) return; line.approvedBy = { id: ap.id, name: ap.name }; } line.price = v; line.manualPrice = true; renderCart(); } }
    else if (act === 'disc') { const v = await ERP.ui.prompt(`خصم على "${e(line.name)}" (مبلغ إجمالي للسطر)`, { title: 'خصم الصنف', type: 'number', value: line.discount }); if (v !== null) { const pct = (u.num(v) / Math.max(0.01, line.price * line.qty)) * 100; const limit = u.num(ERP.settings.get('approvalDiscountLimitPct'), 10); if (v > 0 && (!ERP.auth.can('pos.discount') || pct > limit)) { const ap = await needApproval(`خصم ${pct.toFixed(1)}% على "${line.name}"`); if (!ap) return; line.approvedBy = { id: ap.id, name: ap.name }; } line.discount = u.clamp(v, 0, line.price * line.qty); renderCart(); } }
  }

  function clearCart(silent) { cart = []; discount = 0; discountType = 'fixed'; loyaltyPoints = 0; customer = null; discountApprover = null; renderCart(); renderCustomer(); if (!silent) $('#pos-search', el).focus(); }

  async function checkout(creditOnly = false) {
    if (!cart.length) return;
    if (ERP.settings.get('posRequireShift') && !ERP.shifts.current()) { const ok = await ERP.ui.confirm('لا توجد وردية مفتوحة. هل تريد فتح وردية الآن؟', { title: 'وردية مطلوبة', okText: 'فتح وردية' }); if (ok) ERP.views.shifts.openDialog(); return; }
    const t = totals();
    if (creditOnly) {
      if (!customer) return ERP.ui.warn('اختر عميلاً للبيع الآجل');
      const chk = ERP.crm.creditCheck(customer.id, t.total); if (!chk.ok) return ERP.ui.error(chk.reason);
      const ok = await ERP.ui.confirm(`تسجيل ${u.fmtMoney(t.total)} على حساب <strong>${e(customer.name)}</strong>؟<br><small class="muted">الرصيد بعد العملية: ${u.fmtMoney(customer.balance + t.total)}</small>`, { title: 'بيع آجل', okText: 'تأكيد' });
      if (!ok) return;
      return finalize([{ method: 'credit', amount: t.total }]);
    }
    const methods = ERP.sales.methods().filter(m => !m.isCredit);
    const quick = ERP.settings.get('posQuickCashAmounts') || [];
    let pays = [{ method: ERP.settings.get('defaultPaymentMethod') || 'cash', amount: t.total }];
    const h = ERP.ui.modal({ title: `الدفع — ${u.fmtMoney(t.total)}`, icon: 'cash-register', size: '', body: `
      <div class="amount-display" id="pay-total">${u.fmtNum(t.total)}</div>
      <div class="mt-3" id="pay-lines"></div>
      <button class="btn btn-sm btn-ghost mt-2" id="pay-add"><i class="fas fa-plus"></i> إضافة طريقة دفع أخرى</button>
      <div class="quick-amounts mt-3" id="pay-quick">${quick.map(q => `<button class="btn btn-outline" data-q="${q}">${q}</button>`).join('')}<button class="btn btn-outline" data-q="exact">المبلغ بالضبط</button></div>
      <div class="change-box mt-3" id="pay-change"></div>`, footer: `<button class="btn" data-a="cancel">إلغاء</button><button class="btn btn-success btn-lg" data-a="ok"><i class="fas fa-check"></i> تأكيد الدفع <kbd>Enter</kbd></button>` });
    const renderPays = () => {
      h.$('#pay-lines').innerHTML = pays.map((p, i) => `<div class="flex gap-2 mb-2 items-center"><select data-i="${i}" class="pay-m" style="max-width:170px">${methods.map(m => `<option value="${m.id}" ${m.id === p.method ? 'selected' : ''}>${e(m.name)}</option>`).join('')}</select><input type="number" step="any" class="pay-a num" data-i="${i}" value="${p.amount}" style="font-size:1.2rem;font-weight:700">${pays.length > 1 ? `<button class="btn btn-icon btn-ghost text-danger pay-x" data-i="${i}"><i class="fas fa-xmark"></i></button>` : ''}</div>`).join('');
      const paid = u.sum(pays, 'amount'); const diff = u.round(paid - t.total);
      const cb = h.$('#pay-change');
      if (diff >= 0) { cb.className = 'change-box mt-3 ok'; cb.innerHTML = `<span>الباقي للعميل</span><span class="val">${u.fmtNum(diff)}</span>`; }
      else { cb.className = 'change-box mt-3 short'; cb.innerHTML = `<span>${customer ? 'المتبقي يُسجل آجلاً على العميل' : 'المبلغ ناقص — اختر عميلاً للآجل'}</span><span class="val">${u.fmtNum(-diff)}</span>`; }
      h.$('[data-a=ok]').disabled = diff < 0 && !customer;
    };
    renderPays();
    h.$('#pay-lines').addEventListener('input', ev => { const i = +ev.target.dataset.i; if (ev.target.classList.contains('pay-a')) pays[i].amount = u.num(ev.target.value); if (ev.target.classList.contains('pay-m')) { pays[i].method = ev.target.value; pays[i].cardCode = null; if (ev.target.value === 'gift') { ERP.ui.prompt('رقم بطاقة الهدايا (امسح الباركود أو اكتبه)', { title: 'بطاقة هدايا' }).then(code => { if (!code) { pays[i].method = 'cash'; renderPays(); return; } try { const r = ERP.giftcards.check(code, 0); pays[i].cardCode = r.card.code; pays[i].amount = u.round(Math.min(pays[i].amount, r.available)); ERP.ui.success(`رصيد البطاقة ${u.fmtMoney(r.available)}`); } catch (err) { ERP.ui.error(err.message); pays[i].method = 'cash'; } renderPays(); }); } } const paid = u.sum(pays, 'amount'); const diff = u.round(paid - t.total); const cb = h.$('#pay-change'); if (diff >= 0) { cb.className = 'change-box mt-3 ok'; cb.innerHTML = `<span>الباقي للعميل</span><span class="val">${u.fmtNum(diff)}</span>`; } else { cb.className = 'change-box mt-3 short'; cb.innerHTML = `<span>${customer ? 'المتبقي يُسجل آجلاً على العميل' : 'المبلغ ناقص — اختر عميلاً للآجل'}</span><span class="val">${u.fmtNum(-diff)}</span>`; } h.$('[data-a=ok]').disabled = diff < 0 && !customer; });
    h.$('#pay-lines').addEventListener('click', ev => { const x = ev.target.closest('.pay-x'); if (x) { pays.splice(+x.dataset.i, 1); renderPays(); } });
    h.$('#pay-add').onclick = () => { const paid = u.sum(pays, 'amount'); pays.push({ method: methods.find(m => !pays.some(p => p.method === m.id))?.id || 'cash', amount: Math.max(0, u.round(t.total - paid)) }); renderPays(); };
    h.$('#pay-quick').onclick = ev => { const b = ev.target.closest('[data-q]'); if (!b) return; const q = b.dataset.q; if (q === 'exact') pays[0].amount = t.total; else pays[0].amount = u.round(u.num(pays[0].amount === t.total ? 0 : pays[0].amount) + u.num(q)); renderPays(); };
    h.$('[data-a=cancel]').onclick = () => h.close();
    const ok = () => { if (h.$('[data-a=ok]').disabled) return; h.close(); finalize(pays); };
    h.$('[data-a=ok]').onclick = ok;
    h.el.addEventListener('keydown', ev => { if (ev.key === 'Enter' && ev.target.tagName !== 'SELECT') { ev.preventDefault(); ok(); } });
    setTimeout(() => { const a = h.$('.pay-a'); a && a.select(); }, 50);
  }
  function finalize(payments) {
    try {
      const sale = ERP.sales.create({ cart, customerId: customer ? customer.id : null, payments, discount, discountType, loyaltyPoints, approvedBy: discountApprover });
      lastSale = sale;
      display.post({ mode: 'paid', items: sale.items.map(i => ({ name: i.name, qty: u.fmtQty(i.qty), price: i.price, total: i.total })), subtotal: sale.subtotal, discount: sale.discount + (sale.loyaltyDiscount || 0), tax: sale.tax, total: sale.total, change: sale.change, points: sale.loyaltyEarned, customer: sale.customerName });
      setTimeout(() => { if (!cart.length) display.post({ mode: 'cart', items: [], subtotal: 0, total: 0 }); }, 15000);
      const st = ERP.settings.all(); if (window.desktop && st.drawerOnCashSale && st.drawerTarget && payments.some(p => p.method === 'cash')) window.desktop.openDrawer(st.drawerTarget).then(r => { if (r && !r.ok) console.warn('drawer', r.err); });
      ERP.ui.success(`تم إصدار الفاتورة ${sale.no}${sale.change ? ` — الباقي ${u.fmtMoney(sale.change)}` : ''}`, { title: 'تم البيع' });
      if (ERP.settings.get('receiptAutoPrint')) ERP.print.sale(sale); else showAfterSale(sale);
      clearCart(true); renderProducts(); $('#pos-search', el).focus();
    } catch (err) { ERP.ui.error(err.message); }
  }
  function showAfterSale(sale) {
    const h = ERP.ui.modal({ title: `تمت العملية — ${sale.no}`, icon: 'circle-check', size: 'sm', body: `<div class="text-center"><div class="kpi-value text-success" style="font-size:2.2rem">${u.fmtMoney(sale.total)}</div>${sale.change ? `<div class="mt-2 text-lg">الباقي للعميل: <strong class="num">${u.fmtMoney(sale.change)}</strong></div>` : ''}${sale.due ? `<div class="mt-2 text-warning">آجل: ${u.fmtMoney(sale.due)}</div>` : ''}${sale.loyaltyEarned ? `<div class="mt-2 text-sm muted">+${sale.loyaltyEarned} نقطة ولاء</div>` : ''}</div>`, footer: `<button class="btn" data-a="close">بيع جديد <kbd>Esc</kbd></button><button class="btn btn-outline" data-a="a4"><i class="fas fa-file-invoice"></i> A4</button><button class="btn btn-primary" data-a="print"><i class="fas fa-print"></i> طباعة <kbd>P</kbd></button>` });
    h.$('[data-a=close]').onclick = () => h.close(); h.$('[data-a=print]').onclick = () => { ERP.print.receipt(sale); h.close(); }; h.$('[data-a=a4]').onclick = () => { ERP.print.invoice(sale); h.close(); };
    const kh = ev => { if (ev.key.toLowerCase() === 'p') { ERP.print.receipt(sale); h.close(); } }; h.el.addEventListener('keydown', kh); setTimeout(() => h.$('[data-a=print]').focus(), 40);
  }
  async function holdCart() { if (!cart.length) return; const note = await ERP.ui.prompt('ملاحظة للفاتورة المعلقة (اختياري)', { title: 'تعليق الفاتورة' }); if (note === null) return; ERP.sales.hold(cart, { customerId: customer?.id, customerName: customer?.name, note, discount, discountType }); clearCart(); ERP.ui.info('تم تعليق الفاتورة'); updateHeldBadge(); }
  function updateHeldBadge() { const n = ERP.sales.held().length; const b = $('#pos-held-count', el); b.textContent = n; b.classList.toggle('hidden', !n); }
  function showHeld() {
    const list = ERP.sales.held();
    const h = ERP.ui.modal({ title: 'الفواتير المعلقة', icon: 'pause', body: list.length ? list.map(x => `<div class="list-row"><div class="grow"><div class="title">${e(x.customerName || 'عميل نقدي')} — ${x.cart.length} صنف</div><div class="sub">${u.relTime(x.at)} · ${e(x.note || '')}</div></div><div class="val">${u.fmtMoney(u.sum(x.cart, i => i.qty * i.price))}</div><button class="btn btn-sm btn-primary" data-r="${x.id}">استرجاع</button><button class="btn btn-sm btn-ghost text-danger" data-d="${x.id}"><i class="fas fa-trash"></i></button></div>`).join('') : '<div class="empty-state"><i class="fas fa-pause"></i><p>لا فواتير معلقة</p></div>' });
    h.body.onclick = ev => { const r = ev.target.closest('[data-r]'), d = ev.target.closest('[data-d]'); if (r) { const x = list.find(y => y.id === r.dataset.r); if (cart.length) ERP.sales.hold(cart, { customerId: customer?.id, customerName: customer?.name, discount, discountType }); cart = x.cart; customer = x.customerId ? ERP.crm.get(x.customerId) : null; discount = x.discount || 0; discountType = x.discountType || 'fixed'; loyaltyPoints = 0; discountApprover = null; /* redemption/approval belonged to the replaced cart */ ERP.sales.releaseHeld(x.id); renderCart(); renderCustomer(); h.close(); updateHeldBadge(); } if (d) { ERP.sales.releaseHeld(d.dataset.d); h.close(); showHeld(); updateHeldBadge(); } };
  }
  function returnDialog() { ERP.views.sales.returnDialog(); }

  ERP.views.pos = { add, scan, clearCart };
  ERP.router.register({
    id: 'pos', title: 'نقطة البيع', icon: 'cash-register', section: 'العمليات', order: 1, perm: 'pos.use',
    render(root) {
      el = root;
      root.innerHTML = `<div class="pos">
        <div class="pos-left">
          <div class="pos-search-row"><div class="input-icon"><i class="fas fa-barcode"></i><input type="text" id="pos-search" placeholder="امسح الباركود أو ابحث بالاسم / الكود…  (F2)" autocomplete="off"></div>
            <button class="btn btn-outline" id="pos-held-btn" data-tip="الفواتير المعلقة"><i class="fas fa-pause"></i><span class="count-badge hidden" id="pos-held-count">0</span></button>
            <button class="btn btn-outline" id="pos-return-btn" data-tip="مرتجع"><i class="fas fa-rotate-left"></i></button>
            <button class="btn btn-outline" id="pos-last-btn" data-tip="طباعة آخر فاتورة"><i class="fas fa-print"></i></button>
            <button class="btn btn-outline" id="pos-display-btn" data-tip="شاشة العميل"><i class="fas fa-tv"></i></button></div>
          <div class="pos-cats" id="pos-cats"></div>
          <div class="pos-products" id="pos-products"></div>
        </div>
        <div class="pos-right card">
          <div class="pos-cart-header"><h3><i class="fas fa-cart-shopping text-primary"></i> الفاتورة <span class="badge badge-primary" id="pos-cart-count">0</span></h3><button class="btn btn-sm btn-ghost text-danger" id="pos-clear"><i class="fas fa-trash"></i> إفراغ</button></div>
          <div class="pos-customer" id="pos-customer-box"></div>
          <div class="pos-cart-items" id="pos-cart"></div>
          <div class="pos-totals" id="pos-totals"></div>
          <div class="pos-pay-btns"><button class="btn btn-success span-2" id="pos-pay-btn"><i class="fas fa-money-bill-wave"></i> الدفع <kbd style="background:rgba(255,255,255,.2);color:#fff;border-color:transparent">F9</kbd></button><button class="btn btn-warning" id="pos-credit-btn"><i class="fas fa-hand-holding-dollar"></i> بيع آجل</button><button class="btn btn-outline" id="pos-hold-btn"><i class="fas fa-pause"></i> تعليق</button><button class="btn btn-outline span-2" id="pos-order-btn" style="height:40px;font-size:var(--fs-sm)"><i class="fas fa-motorcycle"></i> حفظ كطلب توصيل</button></div>
        </div></div>`;
      renderCats(); renderProducts(); renderCart(); renderCustomer(); updateHeldBadge();
      const search = $('#pos-search', root);
      search.addEventListener('input', u.debounce(renderProducts, 120));
      search.addEventListener('keydown', ev => { if (ev.key === 'Enter') { const v = search.value.trim(); if (!v) return; const r = ERP.inventory.resolveScan(v); if (r) { scan(v); } else { const list = products().filter(p => u.match(p.name, v)); if (list.length === 1) add(list[0]); else if (!list.length) ERP.ui.warn('لا يوجد منتج مطابق'); } search.value = ''; renderProducts(); } });
      $('#pos-cats', root).onclick = ev => { const b = ev.target.closest('.pos-cat'); if (!b) return; cat = b.dataset.cat; renderCats(); renderProducts(); };
      $('#pos-products', root).onclick = ev => { const c = ev.target.closest('.pos-product'); if (c) add(ERP.db.collection('products').get(c.dataset.id)); };
      $('#pos-cart', root).addEventListener('click', ev => { const b = ev.target.closest('[data-act]'); if (!b || b.tagName === 'INPUT') return; if (b.tagName === 'SELECT') return; lineAction(b.closest('.cart-line').dataset.i, b.dataset.act); });
      $('#pos-cart', root).addEventListener('keydown', ev => { if (ev.key === 'Enter' && ev.target.dataset.act === 'qty') { ev.preventDefault(); ev.target.blur(); } }); // Enter commits the qty (fires change)
      $('#pos-cart', root).addEventListener('change', ev => { const a = ev.target.dataset.act; if (a === 'qty' || a === 'unit') lineAction(ev.target.closest('.cart-line').dataset.i, a, ev.target); });
      $('#pos-clear', root).onclick = async () => { if (cart.length && await ERP.ui.confirm('إفراغ السلة؟', { danger: true })) clearCart(); };
      $('#pos-pay-btn', root).onclick = () => checkout(false);
      $('#pos-credit-btn', root).onclick = () => checkout(true);
      $('#pos-hold-btn', root).onclick = holdCart;
      $('#pos-order-btn', root).onclick = async () => { if (!cart.length) return ERP.ui.warn('السلة فارغة'); const snap = cart; const order = await ERP.views.orders.form(null, { items: cart.map(l => { const f = u.num(l.factor, 1) || 1; return f === 1 ? { productId: l.productId, name: l.name, qty: l.qty, price: l.price, discount: l.discount || 0 } : { productId: l.productId, name: l.name, qty: u.round(l.qty * f, 3), price: u.round(l.price / f, 4), discount: l.discount || 0 }; }) /* delivery orders are kept in base units */, customer }); if (order && cart === snap) clearCart(true); }; // clear only once the order really exists
      $('#pos-held-btn', root).onclick = showHeld;
      $('#pos-return-btn', root).onclick = returnDialog;
      $('#pos-last-btn', root).onclick = () => lastSale ? ERP.print.sale(lastSale) : ERP.ui.info('لا توجد فاتورة سابقة في هذه الجلسة');
      $('#pos-display-btn', root).onclick = () => { window.open('display.html', 'dm-display', 'width=1100,height=720'); setTimeout(() => renderCart(), 800); };
      // global barcode scanner (fast keystrokes ending with Enter) when focus is not in an input
      document.addEventListener('keydown', ev => {
        if (ERP.router.current() !== 'pos' || document.querySelector('.modal-backdrop')) return;
        if (ev.key === 'F2') { ev.preventDefault(); search.focus(); search.select(); return; }
        if (ev.key === 'F9') { ev.preventDefault(); checkout(false); return; }
        if (ev.key === 'F8') { ev.preventDefault(); checkout(true); return; }
        if (ev.key === 'F4') { ev.preventDefault(); holdCart(); return; }
        const inField = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) || document.activeElement.isContentEditable;
        if (ev.key === 'Delete' && ev.shiftKey) { if (inField) return; ev.preventDefault(); if (cart.length) ERP.ui.confirm('إفراغ السلة؟', { danger: true }).then(ok => { if (ok) clearCart(); }); return; }
        if (inField) return;
        if (ev.key.length === 1) { scanBuf += ev.key; clearTimeout(scanTimer); scanTimer = setTimeout(() => { scanBuf = ''; }, 120); }
        else if (ev.key === 'Enter' && scanBuf.length >= 3) { ev.preventDefault(); const code = scanBuf; scanBuf = ''; scan(code); } // preventDefault: the scanner's Enter must not click a focused toolbar button
      });
    },
    onShow(root, params) { renderCats(); renderProducts(); updateHeldBadge(); if (params.customer) { customer = ERP.crm.get(params.customer); loyaltyPoints = 0; reprice(); renderCustomer(); renderCart(); } setTimeout(() => $('#pos-search', root).focus(), 50); },
  });
  ERP.bus.on('db:change', u.debounce(ev => { if (ERP.router.current() === 'pos' && el && ['products', 'categories', 'promotions', 'customers'].includes(ev?.collection)) { renderProducts(); if (ev.collection === 'categories') renderCats(); } }, 300));
})();
