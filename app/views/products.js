/* ==========================================================================
   View: Products (catalog, pricing, barcodes, categories, units)
   ========================================================================== */
window.ERP = window.ERP || {}; ERP.views = ERP.views || {};
(function () {
  const u = ERP.utils; const e = u.escapeHtml;
  let el, table;
  let applyF = () => table && table.setRows(rows()); // replaced in render() by the category/stock filter
  const P = () => ERP.db.collection('products');

  function rows() { return P().all(); }
  function catName(id) { return (ERP.db.collection('categories').get(id) || {}).name || '—'; }
  function supName(id) { return (ERP.db.collection('suppliers').get(id) || {}).name || '—'; }
  function unitName(id) { return (ERP.db.collection('units').get(id) || {}).short || ''; }

  async function openForm(id = null, preset = {}) {
    if (!ERP.auth.require('products.manage')) return;
    const p = id ? P().get(id) : null;
    const cats = ERP.db.collection('categories').all(), units = ERP.db.collection('units').all(), sups = ERP.db.collection('suppliers').all(), whs = ERP.inventory.warehouses();
    const showCost = ERP.auth.can('products.cost');
    const h = ERP.ui.modal({ title: p ? `تعديل منتج — ${e(p.name)}` : 'إضافة منتج جديد', icon: 'box', size: 'lg', body: `
      <form id="pf" class="form-row" novalidate>
        <div class="form-group" style="grid-column:1/-1"><label class="required">اسم المنتج</label><input name="name" required value="${e(p?.name || preset.name || '')}" autofocus></div>
        <div class="form-group"><label>الكود الداخلي</label><input name="code" value="${e(p?.code || '')}" placeholder="تلقائي"></div>
        <div class="form-group"><label>الباركود الرئيسي <button type="button" class="btn btn-sm btn-ghost" id="gen-bc"><i class="fas fa-wand-magic-sparkles"></i> توليد</button></label><input name="barcode" value="${e(p?.barcode || preset.barcode || '')}" class="num"></div>
        <div class="form-group"><label class="required">الفئة</label><select name="categoryId">${u.options(cats, { selected: p?.categoryId || cats[0]?.id })}</select></div>
        <div class="form-group"><label>وحدة البيع</label><select name="unitId">${u.options(units, { selected: p?.unitId || 'un_pc' })}</select></div>
        <div class="form-group"><label>كود الميزان (PLU) <span class="text-xs muted">للمنتجات بالوزن</span></label><input name="scalePlu" value="${e(p?.scalePlu || '')}" class="num" placeholder="مثال: 00012"></div>
        <div class="form-group"><label>المورد الرئيسي</label><select name="supplierId">${u.options(sups, { selected: p?.supplierId, empty: '— بدون —' })}</select></div>
        <div class="form-group"><label>الضريبة %</label><input type="number" step="any" name="taxRate" value="${p?.taxRate ?? (ERP.settings.get('taxEnabled') ? ERP.settings.get('taxRate') : 0)}"></div>
        ${showCost ? `<div class="form-group"><label class="required">سعر التكلفة</label><input type="number" step="any" min="0" name="cost" value="${p?.cost ?? ''}" required></div>` : ''}
        <div class="form-group"><label class="required">سعر البيع</label><input type="number" step="any" min="0" name="price" value="${p?.price ?? ''}" required><small class="help-text" id="margin-hint"></small></div>
        <div class="form-group"><label>سعر الجملة</label><input type="number" step="any" min="0" name="wholesalePrice" value="${p?.wholesalePrice || ''}"></div>
        <div class="form-group"><label>أقل سعر بيع مسموح</label><input type="number" step="any" min="0" name="minPrice" value="${p?.minPrice || ''}"></div>
        <div class="form-group" style="grid-column:1/-1"><label>أسعار حسب مجموعة العميل <span class="text-xs muted">(اتركه فارغاً لاستخدام سعر البيع — تُطبَّق تلقائياً في نقطة البيع عند اختيار العميل)</span></label><div class="form-row">${(ERP.settings.get('priceGroups') || []).map(g => `<div class="input-group"><span class="addon">${e(g)}</span><input type="number" step="any" min="0" data-tier="${e(g)}" value="${(p?.priceTiers || {})[g] ?? ''}" placeholder="${p?.price ?? ''}"></div>`).join('')}</div></div>
        <div class="form-group"><label>الحد الأدنى للمخزون</label><input type="number" step="any" min="0" name="minStock" value="${p?.minStock ?? ERP.settings.get('lowStockThreshold')}"></div>
        <div class="form-group"><label>كمية إعادة الطلب</label><input type="number" step="any" min="0" name="reorderQty" value="${p?.reorderQty || ''}"></div>
        ${!p ? `<div class="form-group"><label>الكمية الافتتاحية</label><input type="number" step="any" min="0" name="openingStock" value="${preset.stock || 0}"></div><div class="form-group"><label>المخزن</label><select name="warehouseId">${u.options(whs, { selected: ERP.inventory.defaultWh() })}</select></div>` : ''}
        <div class="form-group" style="grid-column:1/-1"><label>الوصف / ملاحظات</label><input name="description" value="${e(p?.description || '')}"></div>
        <div class="form-group" style="grid-column:1/-1"><div class="flex gap-4 flex-wrap"><label class="checkbox"><input type="checkbox" name="trackExpiry" ${p?.trackExpiry ? 'checked' : ''}> تتبع تاريخ الصلاحية</label><label class="checkbox"><input type="checkbox" name="favorite" ${p?.favorite ? 'checked' : ''}> مفضل في نقطة البيع</label><label class="checkbox"><input type="checkbox" name="active" ${p ? (p.active !== false ? 'checked' : '') : 'checked'}> نشط</label></div></div>
        <div class="form-group" style="grid-column:1/-1"><label>وحدات البيع الإضافية <span class="text-xs muted">(كرتونة / علبة … — المعامل = عدد الوحدات الأساسية بداخلها؛ اترك السعر فارغاً = سعر الوحدة الأساسية × المعامل. المخزون والتكلفة دائماً بالوحدة الأساسية)</span></label><div id="p-units"></div><button type="button" class="btn btn-sm btn-ghost" id="add-unit"><i class="fas fa-plus"></i> إضافة وحدة</button></div>
        <div class="form-group" style="grid-column:1/-1"><label>باركودات بديلة لنفس الوحدة الأساسية</label><div id="alt-bcs"></div><button type="button" class="btn btn-sm btn-ghost" id="add-alt"><i class="fas fa-plus"></i> إضافة باركود بديل</button></div>
        <div class="form-group" style="grid-column:1/-1"><label>صورة المنتج</label><div class="flex gap-3 items-center"><div class="pos-product-img" style="width:80px;height:80px" id="img-prev">${p?.image ? `<img src="${e(p.image)}">` : '<i class="fas fa-image"></i>'}</div><input type="file" accept="image/*" id="img-file" style="max-width:280px"><button type="button" class="btn btn-sm btn-ghost text-danger" id="img-clear">إزالة</button></div></div>
      </form>`, footer: `<button class="btn" data-a="cancel">إلغاء</button>${p ? '<button class="btn btn-outline" data-a="label"><i class="fas fa-barcode"></i> طباعة ملصق</button>' : ''}<button class="btn btn-primary" data-a="ok"><i class="fas fa-check"></i> حفظ</button>` });
    let image = p?.image || '';
    // legacy pack barcodes (qty > 1) show up as units here and are saved as units
    const legacy = p ? ERP.units.fromLegacy(p) : null;
    let alts = [...((legacy ? legacy.barcodes : p?.barcodes) || [])].map(b => ({ ...b, qty: 1 }));
    let punits = [...((legacy ? legacy.units : ERP.units.list(p)) || [])].map(x => ({ ...x }));
    const form = h.$('#pf');
    const renderAlts = () => { h.$('#alt-bcs').innerHTML = alts.map((b, i) => `<div class="flex gap-2 mb-2"><input placeholder="الباركود" value="${e(b.code)}" data-i="${i}" data-k="code" class="num"><button type="button" class="btn btn-icon btn-ghost text-danger" data-del="${i}"><i class="fas fa-xmark"></i></button></div>`).join(''); };
    renderAlts();
    h.$('#alt-bcs').addEventListener('input', ev => { const i = +ev.target.dataset.i, k = ev.target.dataset.k; if (k) alts[i][k] = ev.target.value.trim(); });
    h.$('#alt-bcs').addEventListener('click', ev => { const d = ev.target.closest('[data-del]'); if (d) { alts.splice(+d.dataset.del, 1); renderAlts(); } });
    h.$('#add-alt').onclick = () => { alts.push({ code: '', qty: 1, price: null }); renderAlts(); };
    const G = 'grid-template-columns:130px 1fr 80px 100px 1.2fr 36px';
    const renderUnits = () => { const bp = u.num(form.price.value); h.$('#p-units').innerHTML = punits.length ? `<div class="doc-line head" style="${G}"><span>النوع</span><span>اسم الوحدة</span><span>المعامل</span><span>سعر البيع</span><span>باركود الوحدة</span><span></span></div>` + punits.map((x, i) => `<div class="doc-line" style="${G}"><select data-ui="${i}" data-uk="unitId"><option value="">— مخصص —</option>${units.filter(r => r.id !== form.unitId.value).map(r => `<option value="${e(r.id)}" ${r.id === x.unitId ? 'selected' : ''}>${e(r.name)}</option>`).join('')}</select><input placeholder="كرتونة 24" value="${e(x.name || '')}" data-ui="${i}" data-uk="name"><input type="number" step="any" min="1" placeholder="24" value="${x.factor ?? ''}" data-ui="${i}" data-uk="factor" class="num"><input type="number" step="any" min="0" placeholder="${bp && u.num(x.factor) ? u.fmtNum(bp * u.num(x.factor)) : 'تلقائي'}" value="${u.num(x.price) > 0 ? x.price : ''}" data-ui="${i}" data-uk="price" class="num"><input placeholder="اختياري" value="${e(x.barcode || '')}" data-ui="${i}" data-uk="barcode" class="num"><button type="button" class="btn btn-icon btn-ghost text-danger" data-udel="${i}"><i class="fas fa-xmark"></i></button></div>`).join('') : '<div class="text-xs muted">لا وحدات إضافية — يُباع بالوحدة الأساسية فقط</div>'; };
    renderUnits();
    h.$('#p-units').addEventListener('input', ev => { const i = +ev.target.dataset.ui, k = ev.target.dataset.uk; if (!k || !punits[i]) return; if (k === 'unitId') { punits[i].unitId = ev.target.value || null; const r = ERP.db.collection('units').get(ev.target.value); if (r && !punits[i].name) { punits[i].name = r.name; renderUnits(); } return; } punits[i][k] = k === 'factor' || k === 'price' ? (ev.target.value === '' ? null : u.num(ev.target.value)) : ev.target.value.trim(); });
    h.$('#p-units').addEventListener('click', ev => { const d = ev.target.closest('[data-udel]'); if (d) { punits.splice(+d.dataset.udel, 1); renderUnits(); } });
    h.$('#add-unit').onclick = () => { const box = ERP.db.collection('units').get('un_box'); punits.push({ unitId: box && !punits.length ? box.id : null, name: box && !punits.length ? box.name : '', factor: null, price: null, barcode: '' }); renderUnits(); };
    form.price.addEventListener('change', renderUnits);
    h.$('#gen-bc').onclick = () => { form.barcode.value = '2' + String(Date.now()).slice(-11); form.barcode.value += ean13Check(form.barcode.value); };
    const hint = () => { const c = u.num(form.cost?.value), pr = u.num(form.price.value); h.$('#margin-hint').textContent = c && pr ? `هامش الربح: ${u.fmtMoney(pr - c)} (${(((pr - c) / pr) * 100).toFixed(1)}%)${pr < c ? ' ⚠️ السعر أقل من التكلفة' : ''}` : ''; };
    form.addEventListener('input', hint); hint();
    h.$('#img-file').onchange = async ev => { const f = ev.target.files[0]; if (!f) return; image = await u.resizeImage(await u.readFile(f, 'dataURL'), 360); h.$('#img-prev').innerHTML = `<img src="${image}">`; };
    h.$('#img-clear').onclick = () => { image = ''; h.$('#img-prev').innerHTML = '<i class="fas fa-image"></i>'; };
    h.$('[data-a=cancel]').onclick = () => h.close();
    if (p) h.$('[data-a=label]').onclick = () => printLabels([p]);
    const save = () => {
      const d = u.formData(form);
      if (!d.name) return ERP.ui.warn('اسم المنتج مطلوب');
      if (d.price === null || d.price < 0) return ERP.ui.warn('سعر البيع مطلوب');
      if (!showCost) d.cost = p ? p.cost : 0;
      d.code = d.code || ERP.db.nextSeq('PRD', 'PRD', 5);
      const dup = P().all().find(x => x.id !== id && (x.code === d.code || (d.barcode && x.barcode === d.barcode)));
      if (dup) return ERP.ui.error(`الكود أو الباركود مستخدم في المنتج "${dup.name}"`);
      d.barcodes = alts.filter(a => a.code).map(a => ({ code: a.code, qty: 1, price: null })); d.image = image;
      const clash = [d.barcode, ...d.barcodes.map(b => b.code)].filter(Boolean).map(c => [c, ERP.units.barcodeOwner(c, { exceptProductId: id })]).find(x => x[1]);
      if (clash) return ERP.ui.error(`الباركود ${clash[0]} مستخدم في المنتج "${clash[1].product.name}"${clash[1].unit ? ` (وحدة ${clash[1].unit.name})` : ''}`);
      if (d.barcodes.some((b, i) => b.code === d.barcode || d.barcodes.findIndex(x => x.code === b.code) !== i)) return ERP.ui.error('باركود بديل مكرر');
      try { d.units = ERP.units.validate({ id, barcode: d.barcode, code: d.code, barcodes: d.barcodes }, punits); } catch (err) { return ERP.ui.error(err.message); }
      d.priceTiers = {}; h.$$('[data-tier]').forEach(i => { if (u.num(i.value) > 0) d.priceTiers[i.dataset.tier] = u.num(i.value); });
      d.cost = u.num(d.cost); d.price = u.num(d.price); d.wholesalePrice = u.num(d.wholesalePrice); d.minPrice = u.num(d.minPrice); d.minStock = u.num(d.minStock); d.reorderQty = u.num(d.reorderQty); d.taxRate = u.num(d.taxRate);
      if (p) {
        if (p.price !== d.price) ERP.audit.log('product.price', `${p.name}: ${p.price} → ${d.price}`, id);
        delete d.openingStock; delete d.warehouseId;
        const before = P().get(id);
        P().update(id, d); ERP.audit.log('product.update', d.name, id);
        // shelf-label queue: base + every unit whose selling price changed
        const after = P().get(id);
        ERP.labels.add({ productId: id, unitId: null, oldPrice: u.num(before.price), newPrice: u.num(after.price), reason: 'تعديل المنتج' });
        ERP.units.list(after).forEach(x => { if (ERP.units.get(before, x.id)) ERP.labels.add({ productId: id, unitId: x.id, oldPrice: ERP.units.price(before, x.id), newPrice: ERP.units.price(after, x.id), reason: 'تعديل المنتج' }); });
      } else {
        const opening = u.num(d.openingStock), wh = d.warehouseId; delete d.openingStock; delete d.warehouseId;
        const np = P().insert({ ...d, stock: 0, stockByWh: {}, batches: [] });
        if (opening > 0) { ERP.inventory.move({ productId: np.id, warehouseId: wh, qty: opening, type: 'opening', unitCost: d.cost, refType: 'opening', note: 'رصيد افتتاحي' }); ERP.accounting.postOpeningStock(u.round(opening * d.cost)); }
        ERP.audit.log('product.create', d.name, np.id);
      }
      h.close(true); ERP.ui.success('تم الحفظ');
    };
    h.$('[data-a=ok]').onclick = save;
    form.addEventListener('keydown', ev => { if (ev.key === 'Enter' && ev.target.tagName !== 'TEXTAREA') { ev.preventDefault(); save(); } });
  }
  function ean13Check(s12) { let sum = 0; for (let i = 0; i < 12; i++) sum += (+s12[i]) * (i % 2 ? 3 : 1); return String((10 - (sum % 10)) % 10); }

  async function remove(id) {
    const p = P().get(id); if (!ERP.auth.require('products.manage')) return;
    const used = ERP.db.collection('sales').all().some(s => s.items.some(i => i.productId === id));
    if (!await ERP.ui.confirm(`حذف المنتج <strong>${e(p.name)}</strong>؟${used ? '<br><small class="text-warning">المنتج له مبيعات سابقة — سيتم تعطيله بدلاً من الحذف للحفاظ على التقارير.</small>' : ''}`, { danger: true, okText: used ? 'تعطيل' : 'حذف' })) return;
    if (used) P().update(id, { active: false }); else P().remove(id);
    ERP.audit.log('product.delete', p.name, id); ERP.ui.success(used ? 'تم التعطيل' : 'تم الحذف');
  }
  function printLabels(list) {
    ERP.ui.form({ title: 'طباعة ملصقات باركود', icon: 'barcode', fields: [{ name: 'qty', label: 'عدد الملصقات لكل منتج', type: 'number', value: 1, min: 1 }], submitText: 'طباعة' }).then(r => { if (r) ERP.print.labels(list.map(p => ({ product: p, qty: u.num(r.qty, 1) }))); });
  }
  function details(id) {
    const p = P().get(id); if (!p) return;
    const moves = ERP.inventory.moves({ productId: id }).slice(0, 30);
    const hist = ERP.sales.productHistory(id, 200);
    const sold = u.sum(hist.filter(s => s.type === 'sale'), s => u.sum(s.items.filter(i => i.productId === id), 'qty'));
    const revenue = u.sum(hist.filter(s => s.type === 'sale'), s => u.sum(s.items.filter(i => i.productId === id), 'total'));
    const whs = ERP.inventory.warehouses();
    ERP.ui.view(`${e(p.name)} <span class="badge badge-neutral num">${e(p.code)}</span>`, `
      <div class="flex gap-4 items-start flex-wrap">
        <div class="pos-product-img" style="width:120px;height:120px;flex-shrink:0">${p.image ? `<img src="${e(p.image)}">` : '<i class="fas fa-box"></i>'}</div>
        <div class="detail-grid flex-1">
          <div class="detail-item"><div class="dl">الفئة</div><div class="dv">${e(catName(p.categoryId))}</div></div><div class="detail-item"><div class="dl">المورد</div><div class="dv">${e(supName(p.supplierId))}</div></div>
          <div class="detail-item"><div class="dl">الباركود</div><div class="dv num">${e(p.barcode || '—')}</div></div><div class="detail-item"><div class="dl">سعر البيع</div><div class="dv">${u.fmtMoney(p.price)}</div></div>
          ${ERP.auth.can('products.cost') ? `<div class="detail-item"><div class="dl">التكلفة (متوسط)</div><div class="dv">${u.fmtMoney(p.cost)}</div></div><div class="detail-item"><div class="dl">هامش الربح</div><div class="dv ${p.price < p.cost ? 'text-danger' : 'text-success'}">${p.price ? (((p.price - p.cost) / p.price) * 100).toFixed(1) : 0}%</div></div>` : ''}
          <div class="detail-item"><div class="dl">المخزون الكلي</div><div class="dv">${u.fmtQty(p.stock)} ${e(unitName(p.unitId))} ${u.stockBadge(p)}</div></div><div class="detail-item"><div class="dl">مبيعات (آخر 200 فاتورة)</div><div class="dv">${u.fmtQty(sold)} قطعة — ${u.fmtMoney(revenue)}</div></div>
        </div></div>
      <div class="tabs mt-4"><button class="tab active" data-t="wh">المخازن</button><button class="tab" data-t="mv">الحركات</button>${p.trackExpiry ? '<button class="tab" data-t="bt">الدفعات والصلاحية</button>' : ''}<button class="tab" data-t="bc">الباركود</button></div>
      <div class="tab-pane active" data-p="wh"><table class="table table-compact"><thead><tr><th>المخزن</th><th class="num">الكمية</th>${ERP.auth.can('products.cost') ? '<th class="num">القيمة</th>' : ''}</tr></thead><tbody>${whs.map(w => `<tr><td>${e(w.name)}</td><td class="num">${u.fmtQty(ERP.inventory.whQty(p, w.id))}</td>${ERP.auth.can('products.cost') ? `<td class="num">${u.fmtMoney(ERP.inventory.whQty(p, w.id) * p.cost)}</td>` : ''}</tr>`).join('')}</tbody></table></div>
      <div class="tab-pane" data-p="mv"><div class="table-wrap" style="max-height:340px;overflow:auto"><table class="table table-compact"><thead><tr><th>التاريخ</th><th>النوع</th><th class="num">الكمية</th><th class="num">الرصيد</th><th>مرجع</th></tr></thead><tbody>${moves.map(m => `<tr><td class="num">${u.fmtDateTime(m.date)}</td><td>${e(ERP.views.inventory.moveType(m.type))}</td><td class="num ${m.qty < 0 ? 'text-danger' : 'text-success'}">${m.qty > 0 ? '+' : ''}${u.fmtQty(m.qty)}</td><td class="num">${u.fmtQty(m.balanceAfter)}</td><td class="text-xs">${e(m.note || '')}</td></tr>`).join('') || '<tr><td colspan="5" class="text-center muted">لا حركات</td></tr>'}</tbody></table></div></div>
      ${p.trackExpiry ? `<div class="tab-pane" data-p="bt"><table class="table table-compact"><thead><tr><th>الدفعة</th><th>الصلاحية</th><th class="num">الكمية</th><th>الحالة</th></tr></thead><tbody>${(p.batches || []).map(b => { const d = u.daysBetween(new Date(), b.expiry); return `<tr class="${d < 0 ? 'row-danger' : d <= 30 ? 'row-warning' : ''}"><td>${e(b.batchNo || '—')}</td><td class="num">${u.fmtDate(b.expiry)}</td><td class="num">${u.fmtQty(b.qty)}</td><td>${d < 0 ? u.badge('منتهي', 'danger') : d <= 30 ? u.badge(`${d} يوم`, 'warning') : u.badge('سليم', 'success')}</td></tr>`; }).join('') || '<tr><td colspan="4" class="text-center muted">لا دفعات</td></tr>'}</tbody></table></div>` : ''}
      <div class="tab-pane" data-p="bc"><div class="text-center p-4"><div class="label-preview">${ERP.print.barcodeSvg(p.barcode || p.code, { height: 60, width: 2 })}<strong>${e(p.name)}</strong><span>${u.fmtMoney(p.price)}</span></div>${(p.barcodes || []).length ? `<div class="mt-3 text-sm muted">باركودات بديلة: ${p.barcodes.map(b => `<span class="badge badge-neutral num">${e(b.code)}${u.num(b.qty, 1) > 1 ? ' ×' + b.qty : ''}</span>`).join(' ')}</div>` : ''}${ERP.units.list(p).length ? `<table class="table table-compact mt-3"><thead><tr><th>الوحدة</th><th class="num">المعامل</th><th class="num">سعر البيع</th><th>الباركود</th><th class="num">المتاح</th></tr></thead><tbody><tr><td>${e(ERP.units.baseName(p))} <span class="badge badge-neutral">أساسية</span></td><td class="num">1</td><td class="num">${u.fmtNum(p.price)}</td><td class="num">${e(p.barcode || '—')}</td><td class="num">${u.fmtQty(p.stock)}</td></tr>${ERP.units.list(p).map(x => `<tr><td>${e(x.name)}</td><td class="num">${u.fmtQty(x.factor)}</td><td class="num">${u.fmtNum(ERP.units.price(p, x.id))}${u.num(x.price) > 0 ? '' : ' <span class="text-xs muted">تلقائي</span>'}</td><td class="num">${e(x.barcode || '—')}</td><td class="num">${u.fmtQty(Math.floor(u.num(p.stock) / u.num(x.factor, 1)))}</td></tr>`).join('')}</tbody></table>` : ''}${ERP.priceChanges.forProduct(id).filter(x => x.status === 'scheduled' || (x.status === 'applied' && x.endAt)).length ? `<div class="alert alert-info mt-3 text-sm"><i class="fas fa-clock"></i> تغييرات أسعار قادمة: ${ERP.priceChanges.forProduct(id).filter(x => x.status === 'scheduled' || (x.status === 'applied' && x.endAt)).map(x => `${e(x.unitName || '')} ${u.fmtNum(x.newPrice)} ${x.status === 'scheduled' ? 'من ' + u.fmtDateTime(x.startAt) : 'حتى ' + u.fmtDateTime(x.endAt)}`).join(' · ')}</div>` : ''}</div></div>`,
      { size: 'lg', footer: `<button class="btn" onclick="this.closest('.modal-backdrop').remove();document.body.classList.remove('modal-open')">إغلاق</button>${ERP.auth.can('products.manage') ? `<button class="btn btn-outline" onclick="ERP.views.products.printLabels(['${id}'])"><i class="fas fa-barcode"></i> ملصق</button><button class="btn btn-primary" onclick="this.closest('.modal-backdrop').remove();document.body.classList.remove('modal-open');ERP.views.products.openForm('${id}')"><i class="fas fa-pen"></i> تعديل</button>` : ''}` });
    const mb = document.querySelector('.modal-backdrop:last-child');
    mb.querySelector('.tabs').onclick = ev => { const t = ev.target.closest('.tab'); if (!t) return; mb.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t)); mb.querySelectorAll('.tab-pane').forEach(x => x.classList.toggle('active', x.dataset.p === t.dataset.t)); };
  }
  async function manageCategories() {
    if (!ERP.auth.require('products.manage')) return;
    const C = ERP.db.collection('categories');
    const render = () => C.all().map(c => `<div class="list-row"><i class="fas fa-${e(c.icon || 'tag')}" style="color:${e(c.color)};width:24px;text-align:center"></i><div class="grow"><div class="title">${e(c.name)}</div><div class="sub">${P().where({ categoryId: c.id }).length} منتج</div></div><button class="btn btn-sm btn-ghost" data-e="${c.id}"><i class="fas fa-pen"></i></button><button class="btn btn-sm btn-ghost text-danger" data-d="${c.id}"><i class="fas fa-trash"></i></button></div>`).join('');
    const h = ERP.ui.modal({ title: 'الفئات', icon: 'tags', body: `<div id="cat-list">${render()}</div>`, footer: `<button class="btn" data-a="close">إغلاق</button><button class="btn btn-primary" data-a="add"><i class="fas fa-plus"></i> فئة جديدة</button>` });
    const edit = async id => { const c = id ? C.get(id) : null; const r = await ERP.ui.form({ title: c ? 'تعديل فئة' : 'فئة جديدة', fields: [{ name: 'name', label: 'الاسم', required: true }, { name: 'icon', label: 'أيقونة (Font Awesome)', placeholder: 'tag' }, { name: 'color', label: 'اللون', type: 'color' }], values: c || { icon: 'tag', color: '#3178ff' } }); if (!r) return; if (c) C.update(id, r); else C.insert({ ...r, icon: r.icon || 'tag' }); h.$('#cat-list').innerHTML = render(); };
    h.$('[data-a=close]').onclick = () => h.close(); h.$('[data-a=add]').onclick = () => edit(null);
    h.$('#cat-list').onclick = async ev => { const ed = ev.target.closest('[data-e]'), dl = ev.target.closest('[data-d]'); if (ed) edit(ed.dataset.e); if (dl) { const n = P().where({ categoryId: dl.dataset.d }).length; if (n) return ERP.ui.warn(`الفئة تحتوي ${n} منتج`); if (await ERP.ui.confirm('حذف الفئة؟', { danger: true })) { C.remove(dl.dataset.d); h.$('#cat-list').innerHTML = render(); } } };
  }
  async function bulkPrice() {
    if (!ERP.auth.require('products.manage')) return;
    const ids = table.getSelected(); const list = ids.length ? P().byIds(ids) : table.getFiltered();
    const r = await ERP.ui.form({ title: `تعديل أسعار جماعي (${list.length} منتج)`, icon: 'tags', fields: [{ name: 'mode', label: 'طريقة التعديل', type: 'select', options: '<option value="pct">زيادة/نقص بنسبة % على سعر البيع</option><option value="fixed">زيادة/نقص بمبلغ ثابت</option><option value="margin">إعادة تسعير بهامش % فوق التكلفة</option>' }, { name: 'value', label: 'القيمة (سالب للنقص)', type: 'number', step: 'any', required: true }, { name: 'round', label: 'تقريب لأقرب', type: 'select', options: '<option value="0">بدون</option><option value="0.25">0.25</option><option value="0.5">0.5</option><option value="1">1</option>' }, { name: 'units', type: 'checkbox', checkLabel: 'تطبيق على أسعار الوحدات (كرتونة/علبة…) المحددة يدوياً أيضاً', value: true, cols: 2 }] });
    if (!r) return;
    let n = 0;
    const calcP = (old, cost) => { let np = old; if (r.mode === 'pct') np = old * (1 + r.value / 100); else if (r.mode === 'fixed') np = old + r.value; else np = cost * (1 + r.value / 100); const rd = u.num(r.round); if (rd) np = Math.round(np / rd) * rd; return u.round(Math.max(0, np)); };
    list.forEach(p => { const np = calcP(p.price, p.cost); if (np !== p.price) { ERP.units.setPrice(p.id, null, np, { reason: 'تعديل جماعي', silent: true, audit: false }); n++; } if (r.units) ERP.units.list(P().get(p.id)).filter(x => u.num(x.price) > 0).forEach(x => { const q = calcP(u.num(x.price), u.num(p.cost) * u.num(x.factor, 1)); if (q !== u.num(x.price)) ERP.units.setPrice(p.id, x.id, q, { reason: 'تعديل جماعي', silent: true, audit: false }); }); });
    ERP.bus.emit('db:change', { collection: 'products', op: 'bulk' }); ERP.audit.log('product.price', `تعديل جماعي: ${n} منتج (${r.mode} ${r.value})`); ERP.ui.success(`تم تعديل ${n} منتج`);
  }
  /* ---------- scheduled price changes ---------- */
  const localDT = d => { const x = new Date(d); return new Date(x.getTime() - x.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
  const dtFields = () => [{ name: 'startAt', label: 'يبدأ في', type: 'datetime-local', value: localDT(new Date()), required: true }, { name: 'endAt', label: 'ينتهي في (اختياري — يرجع السعر القديم تلقائياً)', type: 'datetime-local', help: 'مثال: عرض مؤقت لمدة أسبوع' }, { name: 'note', label: 'ملاحظة', cols: 2, placeholder: 'عرض نهاية الأسبوع…' }];
  async function schedulePrice(id) {
    if (!ERP.auth.require('products.manage')) return;
    const p = P().get(id); if (!p) return;
    const opts = [`<option value="">${e(ERP.units.baseName(p))} — الحالي ${u.fmtNum(p.price)}</option>`, ...ERP.units.list(p).map(x => `<option value="${e(x.id)}">${e(x.name)} ×${u.fmtQty(x.factor)} — الحالي ${u.fmtNum(ERP.units.price(p, x.id))}</option>`)].join('');
    const r = await ERP.ui.form({ title: `جدولة تغيير سعر — ${e(p.name)}`, icon: 'clock', fields: [{ name: 'unitId', label: 'الوحدة', type: 'select', options: opts }, { name: 'newPrice', label: 'السعر الجديد', type: 'number', step: 'any', min: 0, required: true }, ...dtFields()], submitText: 'جدولة',
      onSubmit: d => { const x = ERP.priceChanges.schedule({ productId: id, unitId: d.unitId || null, newPrice: d.newPrice, startAt: d.startAt, endAt: d.endAt || null, note: d.note }); ERP.priceChanges.run(); return ERP.priceChanges.get(x.id); } });
    if (r) ERP.ui.success(r.status === 'applied' ? 'تم تطبيق السعر الجديد فوراً وإضافته لقائمة الملصقات' : `تمت الجدولة — يُطبَّق ${u.fmtDateTime(r.startAt)}`);
  }
  async function bulkSchedule() {
    if (!ERP.auth.require('products.manage')) return;
    const ids = table.getSelected(); if (!ids.length) return ERP.ui.warn('حدد منتجات أولاً');
    const r = await ERP.ui.form({ title: `جدولة تغيير أسعار (${ids.length} منتج)`, icon: 'clock', fields: [{ name: 'mode', label: 'طريقة التغيير', type: 'select', options: '<option value="pct">نسبة % (سالب للتخفيض)</option><option value="fixed">مبلغ ثابت (سالب للتخفيض)</option><option value="price">سعر جديد موحد</option>' }, { name: 'value', label: 'القيمة', type: 'number', step: 'any', required: true }, { name: 'round', label: 'تقريب لأقرب', type: 'select', options: '<option value="0">بدون</option><option value="0.25">0.25</option><option value="0.5">0.5</option><option value="1">1</option><option value="5">5</option>' }, { name: 'includeUnits', type: 'checkbox', checkLabel: 'تطبيق النسبة/المبلغ على الوحدات (كرتونة/علبة…) أيضاً', value: true }, ...dtFields()], submitText: 'جدولة',
      onSubmit: d => { const list = ERP.priceChanges.bulk({ productIds: ids, mode: d.mode, value: d.value, round: u.num(d.round), includeUnits: d.includeUnits, startAt: d.startAt, endAt: d.endAt || null, note: d.note }); ERP.priceChanges.run(); return list; } });
    if (r) ERP.ui.success(`تمت جدولة ${r.length} تغيير سعر`);
  }
  function scheduleList() {
    let tab = 'upcoming';
    const h = ERP.ui.modal({ title: 'تغييرات الأسعار المجدولة', icon: 'clock', size: 'xl', body: '<div class="pills mb-3" id="pc-tabs"><button class="pill active" data-t="upcoming">القادمة والعروض الجارية</button><button class="pill" data-t="applied">المطبقة</button><button class="pill" data-t="all">الكل</button></div><div id="pc-list"></div>', footer: '<button class="btn" data-a="close">إغلاق</button><button class="btn btn-outline" data-a="run"><i class="fas fa-rotate"></i> تطبيق المستحق الآن</button>' });
    const cls = { scheduled: 'info', applied: 'success', reverted: 'neutral', cancelled: 'danger' };
    const draw = () => {
      const list = tab === 'upcoming' ? ERP.priceChanges.upcoming() : tab === 'applied' ? ERP.priceChanges.all().filter(x => x.status === 'applied' || x.status === 'reverted') : ERP.priceChanges.all();
      h.$('#pc-list').innerHTML = list.length ? `<div class="table-wrap" style="max-height:60vh;overflow:auto"><table class="table table-compact"><thead><tr><th>المنتج</th><th>الوحدة</th><th class="num">القديم</th><th class="num">الجديد</th><th>يبدأ</th><th>ينتهي</th><th>الحالة</th><th>ملاحظة</th><th></th></tr></thead><tbody>${list.map(x => `<tr><td>${e(x.productName)}</td><td>${e(x.unitName || '—')}</td><td class="num">${u.fmtNum(x.oldPrice)}</td><td class="num fw-700 ${x.newPrice < x.oldPrice ? 'text-success' : 'text-danger'}">${u.fmtNum(x.newPrice)}</td><td class="num text-sm">${u.fmtDateTime(x.startAt)}</td><td class="num text-sm">${x.endAt ? u.fmtDateTime(x.endAt) : '—'}</td><td>${u.badge(ERP.priceChanges.STATUS[x.status] || x.status, cls[x.status] || 'neutral')}${x.revertSkipped ? ' <span class="text-xs muted" title="تغير السعر يدوياً أثناء العرض">(لم يُرجع)</span>' : ''}</td><td class="text-xs">${e(x.note || '')}</td><td>${x.status === 'scheduled' || (x.status === 'applied' && x.endAt) ? `<button class="btn btn-sm btn-ghost text-danger" data-c="${e(x.id)}">${x.status === 'scheduled' ? 'إلغاء' : 'إنهاء العرض'}</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty-state"><i class="fas fa-clock"></i><p>لا توجد تغييرات</p></div>';
    };
    draw();
    h.$('#pc-tabs').onclick = ev => { const b = ev.target.closest('.pill'); if (!b) return; tab = b.dataset.t; h.$$('#pc-tabs .pill').forEach(x => x.classList.toggle('active', x === b)); draw(); };
    h.$('#pc-list').onclick = async ev => { const c = ev.target.closest('[data-c]'); if (!c) return; if (!await ERP.ui.confirm('تأكيد إلغاء/إنهاء تغيير السعر؟', { danger: true })) return; try { ERP.priceChanges.cancel(c.dataset.c); ERP.ui.success('تم'); } catch (err) { ERP.ui.error(err.message); } draw(); };
    h.$('[data-a=close]').onclick = () => h.close();
    h.$('[data-a=run]').onclick = () => { const r = ERP.priceChanges.run(); ERP.ui.info(`طُبق ${r.applied} · أُرجع ${r.reverted}`); draw(); };
  }
  /* ---------- shelf-label queue ---------- */
  function updateLabelBadge() { const b = el && el.querySelector('#p-labels-n'); if (b) { const n = ERP.labels.count(); b.textContent = n; b.classList.toggle('hidden', !n); } }
  function labelQueue() {
    const h = ERP.ui.modal({ title: 'ملصقات الأسعار — تغيّرت أسعارها', icon: 'tags', size: 'xl', body: '<div id="lq-body"></div>', footer: '<button class="btn" data-a="close">إغلاق</button><div class="flex-1"></div><button class="btn btn-ghost" data-a="clean">مسح المطبوع سابقاً</button><button class="btn btn-soft-danger" data-a="rm"><i class="fas fa-trash"></i> حذف المحدد</button><button class="btn btn-primary" data-a="print"><i class="fas fa-print"></i> طباعة المحدد</button>' });
    const draw = () => {
      const list = ERP.labels.pending();
      h.$('#lq-body').innerHTML = list.length ? `<div class="flex gap-3 items-center mb-3 flex-wrap"><label class="text-sm">عدد النسخ لكل ملصق <input type="number" id="lq-copies" value="1" min="1" style="width:80px"></label><label class="checkbox"><input type="checkbox" id="lq-old" ${ERP.settings.get('labelShowOldPrice') ? 'checked' : ''}> إظهار السعر القديم مشطوباً (عند التخفيض)</label></div><div class="table-wrap" style="max-height:55vh;overflow:auto"><table class="table table-compact"><thead><tr><th style="width:36px"><input type="checkbox" id="lq-all" checked></th><th>المنتج</th><th>الوحدة</th><th class="num">السعر السابق</th><th class="num">السعر الجديد</th><th>السبب</th><th>التاريخ</th></tr></thead><tbody>${list.map(x => { const p = P().get(x.productId); return `<tr><td><input type="checkbox" class="lq-chk" value="${e(x.id)}" checked></td><td>${e(p ? p.name : '—')}</td><td>${e(p ? ERP.units.name(p, x.unitId) : '')}</td><td class="num">${x.oldPrice === null ? '—' : u.fmtNum(x.oldPrice)}</td><td class="num fw-700">${u.fmtNum(x.newPrice)}</td><td class="text-xs">${e(x.reason || '')}</td><td class="num text-xs">${u.fmtDateTime(x.at)}</td></tr>`; }).join('')}</tbody></table></div>` : '<div class="empty-state"><i class="fas fa-tags"></i><h4>لا ملصقات بانتظار الطباعة</h4><p class="text-sm">أي تغيير في سعر بيع منتج أو وحدة يظهر هنا تلقائياً</p></div>';
      const all = h.$('#lq-all'); if (all) all.onchange = () => h.$$('.lq-chk').forEach(c => { c.checked = all.checked; });
    };
    draw();
    const sel = () => h.$$('.lq-chk').filter(c => c.checked).map(c => c.value);
    h.$('[data-a=close]').onclick = () => h.close();
    h.$('[data-a=print]').onclick = () => { const ids = sel(); if (!ids.length) return ERP.ui.warn('حدد ملصقات'); ERP.print.labels(ERP.labels.items(ids, { copies: u.num(h.$('#lq-copies').value, 1), showOld: h.$('#lq-old').checked })); ERP.labels.markPrinted(ids); ERP.ui.success(`تم إرسال ${ids.length} ملصق للطباعة`); draw(); };
    h.$('[data-a=rm]').onclick = async () => { const ids = sel(); if (!ids.length) return; if (await ERP.ui.confirm(`حذف ${ids.length} من قائمة الملصقات؟`, { danger: true })) { ERP.labels.remove(ids); draw(); } };
    h.$('[data-a=clean]').onclick = () => { ERP.labels.clearPrinted(); ERP.ui.info('تم مسح سجل المطبوع'); };
  }
  /* Excel import/template → مركز الاستيراد (preview, validation, undo) */
  function importExcel() { if (!ERP.auth.require('products.manage')) return; ERP.views.imports.open('products'); }
  function template() { try { ERP.importCenter.template('products'); } catch (err) { ERP.ui.error(err.message); } }

  ERP.views.products = { openForm, remove, details, schedulePrice, scheduleList, labelQueue, printLabels: ids => printLabels(Array.isArray(ids) && typeof ids[0] === 'string' ? P().byIds(ids) : ids), manageCategories, refresh: () => applyF() };
  ERP.router.register({
    id: 'products', title: 'المنتجات', icon: 'boxes-stacked', section: 'العمليات', order: 2, perm: 'products.view',
    render(root) {
      el = root;
      const canM = ERP.auth.can('products.manage'), canC = ERP.auth.can('products.cost');
      root.innerHTML = `<div class="page-header"><div><h2><i class="fas fa-boxes-stacked"></i> المنتجات</h2><div class="desc">إدارة الكتالوج، الأسعار، الباركود والفئات</div></div>
        <div class="page-actions">${canM ? `<button class="btn btn-outline" id="p-labels" data-tip="ملصقات الرف للأسعار التي تغيرت"><i class="fas fa-tags"></i> ملصقات الأسعار <span class="badge badge-danger num hidden" id="p-labels-n">0</span></button><button class="btn btn-outline" id="p-sched" data-tip="تغييرات الأسعار المجدولة والعروض المؤقتة"><i class="fas fa-clock"></i> الأسعار المجدولة</button><button class="btn btn-outline" id="p-cats"><i class="fas fa-tags"></i> الفئات</button><div class="dropdown" id="p-more"><button class="btn btn-outline"><i class="fas fa-ellipsis"></i></button><div class="dropdown-menu"><button class="dropdown-item" data-a="import"><i class="fas fa-file-import"></i> استيراد من Excel</button><button class="dropdown-item" data-a="template"><i class="fas fa-file-arrow-down"></i> تنزيل نموذج Excel</button><button class="dropdown-item" data-a="bulk"><i class="fas fa-tags"></i> تعديل أسعار جماعي</button><button class="dropdown-item" data-a="bsched"><i class="fas fa-clock"></i> جدولة تغيير أسعار للمحدد</button><button class="dropdown-item" data-a="labels"><i class="fas fa-barcode"></i> طباعة ملصقات للمحدد</button></div></div><button class="btn btn-primary" id="p-add"><i class="fas fa-plus"></i> إضافة منتج</button>` : ''}</div></div>
        <div id="p-table"></div>`;
      table = ERP.ui.table({ el: '#p-table', rows: rows(), selectable: canM, exportName: 'المنتجات', defaultSort: { key: 'name', dir: 'asc' },
        toolbarExtra: `<select id="p-cat-f" style="min-width:150px"><option value="">كل الفئات</option>${u.options(ERP.db.collection('categories').all())}</select><select id="p-stock-f" style="min-width:140px"><option value="">كل المخزون</option><option value="low">منخفض</option><option value="out">نفذ</option><option value="inactive">غير نشط</option></select>`,
        columns: [
          { key: 'image', label: '', width: '56px', sortable: false, export: false, render: p => `<div class="avatar" style="border-radius:8px">${p.image ? `<img src="${e(p.image)}">` : `<i class="fas fa-${(ERP.db.collection('categories').get(p.categoryId) || {}).icon || 'box'}"></i>`}</div>` },
          { key: 'name', label: 'المنتج', render: (p, t) => `<div class="fw-600">${u.highlight(p.name, t)} ${p.active === false ? u.badge('معطل', 'neutral') : ''} ${p.favorite ? '<i class="fas fa-star text-warning text-xs"></i>' : ''}</div><div class="text-xs muted num">${u.highlight(p.code, t)}${p.barcode ? ' · ' + u.highlight(p.barcode, t) : ''}</div>`, text: p => `${p.name} ${p.code} ${p.barcode || ''}` },
          { key: 'categoryId', label: 'الفئة', render: p => e(catName(p.categoryId)), text: p => catName(p.categoryId), sortValue: p => catName(p.categoryId) },
          ...(canC ? [{ key: 'cost', label: 'التكلفة', num: true, render: p => u.fmtNum(p.cost) }] : []),
          { key: 'price', label: 'السعر', num: true, render: p => `<strong>${u.fmtNum(p.price)}</strong>${ERP.units.list(p).length ? `<div class="text-xs muted">${ERP.units.list(p).map(x => `${e(x.name)} ${u.fmtNum(ERP.units.price(p, x.id))}`).join(' · ')}</div>` : ''}` },
          ...(canC ? [{ id: 'margin', label: 'الهامش', num: true, render: p => { const m = p.price ? ((p.price - p.cost) / p.price) * 100 : 0; return `<span class="${m < 0 ? 'text-danger' : m < 10 ? 'text-warning' : 'text-success'}">${m.toFixed(0)}%</span>`; }, sortValue: p => p.price ? (p.price - p.cost) / p.price : 0, text: p => (p.price ? ((p.price - p.cost) / p.price) * 100 : 0).toFixed(1) + '%' }] : []),
          { key: 'stock', label: 'المخزون', num: true, render: p => `<span class="fw-700">${u.fmtQty(p.stock)}</span> <span class="text-xs muted">${e(unitName(p.unitId))}</span>`, text: p => u.fmtQty(p.stock), footer: r => `<span class="text-xs muted">إجمالي</span> ${u.fmtQty(u.sum(r, 'stock'))}` },
          { id: 'status', label: 'الحالة', sortable: false, render: p => u.stockBadge(p), text: p => p.stock <= 0 ? 'نفذ' : p.stock <= (p.minStock ?? 5) ? 'منخفض' : 'متوفر' },
          { id: 'act', label: '', sortable: false, export: false, class: 'actions', render: p => `<button class="btn btn-icon btn-sm btn-ghost" data-a="view" data-id="${p.id}" data-tip="تفاصيل"><i class="fas fa-eye"></i></button>${canM ? `<button class="btn btn-icon btn-sm btn-ghost" data-a="edit" data-id="${p.id}" data-tip="تعديل"><i class="fas fa-pen"></i></button><button class="btn btn-icon btn-sm btn-ghost" data-a="sched" data-id="${p.id}" data-tip="جدولة تغيير سعر"><i class="fas fa-clock"></i></button><button class="btn btn-icon btn-sm btn-ghost text-danger" data-a="del" data-id="${p.id}" data-tip="حذف"><i class="fas fa-trash"></i></button>` : ''}` },
        ], rowClass: p => p.active === false ? 'muted' : '', onRowClick: p => details(p.id) });
      applyF = () => { if (!table) return; const c = $('#p-cat-f', root).value, s = $('#p-stock-f', root).value; table.setRows(rows().filter(p => (!c || p.categoryId === c) && (s === 'inactive' ? p.active === false : (p.active !== false && (!s || (s === 'low' ? p.stock <= u.num(p.minStock, 5) && p.stock > 0 : s === 'out' ? p.stock <= 0 : true)))))); };
      $('#p-cat-f', root).onchange = applyF; $('#p-stock-f', root).onchange = applyF;
      root.addEventListener('click', ev => { const b = ev.target.closest('[data-a][data-id]'); if (!b) return; ev.stopPropagation(); const { a, id } = b.dataset; if (a === 'view') details(id); if (a === 'edit') openForm(id); if (a === 'del') remove(id); if (a === 'sched') schedulePrice(id); });
      if (canM) { $('#p-add', root).onclick = () => openForm(); $('#p-cats', root).onclick = manageCategories; $('#p-labels', root).onclick = labelQueue; $('#p-sched', root).onclick = scheduleList; updateLabelBadge(); const dd = $('#p-more', root); dd.querySelector('button').onclick = ev => { ev.stopPropagation(); dd.classList.toggle('open'); }; dd.querySelector('.dropdown-menu').onclick = ev => { const b = ev.target.closest('[data-a]'); if (!b) return; dd.classList.remove('open'); const a = b.dataset.a; if (a === 'import') importExcel(); if (a === 'template') template(); if (a === 'bulk') bulkPrice(); if (a === 'bsched') bulkSchedule(); if (a === 'labels') { const ids = table.getSelected(); if (!ids.length) return ERP.ui.warn('حدد منتجات أولاً'); printLabels(P().byIds(ids)); } }; document.addEventListener('click', () => dd.classList.remove('open')); }
    },
    onShow(root, params) { applyF(); updateLabelBadge(); if (params.q) table.setSearch(params.q); if (params.new) openForm(null, { barcode: params.barcode }); },
  });
  ERP.bus.on('db:change', u.debounce(ev => { if (table && ERP.router.current() === 'products' && ['products', 'categories', 'suppliers'].includes(ev?.collection)) applyF(); }, 200));
  ERP.bus.on('labels:change', u.debounce(() => updateLabelBadge(), 150));
})();
