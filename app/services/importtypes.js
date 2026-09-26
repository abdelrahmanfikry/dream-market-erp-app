/* ==========================================================================
   Import types for ERP.importCenter (مركز الاستيراد)
   products · customers · suppliers · employees · chartOfAccounts · fixedAssets ·
   priceUpdate · purchaseFromFile · expenses · journalEntries · stockAdjust ·
   stockTransfer · opening (wraps ERP.openingImport)
   Every write goes through the owning service (units.setPrice → shelf labels,
   inventory.move/adjust/transfer → stock + GL, accounting.post, crm/purchasing/hr/assets).
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  const u = ERP.utils; const IC = ERP.importCenter; const T = ERP.importTypes;
  const norm = IC.norm; const r2 = n => u.round(n, 2);
  const C = n => ERP.db.collection(n); const P = () => C('products');
  const blank = v => v === null || v === undefined || String(v).trim() === '';
  const digits = s => String(s || '').replace(/\D/g, '');
  const col = (key, label, aliases = [], more = {}) => ({ key, label, aliases, ...more });
  const dayISO = d => (d ? new Date(d + 'T12:00:00').toISOString() : u.now());
  const q = n => u.fmtQty(n), m = n => u.fmtNum(n);
  const changed = (a, b) => JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);

  /* ---------------- shared lookups ---------------- */
  function productIndex() {
    const any = new Map(), code = new Map(), barcode = new Map(), name = new Map(), nameN = new Map();
    const put = (k, v) => { if (!blank(k) && !any.has(String(k))) any.set(String(k), v); };
    P().all().forEach(p => {
      if (p.code) code.set(String(p.code), p); if (p.barcode) barcode.set(String(p.barcode), p);
      put(p.code, { p }); put(p.barcode, { p }); (p.barcodes || []).forEach(b => put(b.code, { p })); ERP.units.list(p).forEach(x => put(x.barcode, { p, unit: x }));
      const n = norm(p.name); if (!name.has(n)) name.set(n, p); nameN.set(n, (nameN.get(n) || 0) + 1);
    });
    return { any, code, barcode, name, nameN, find: k => (blank(k) ? null : any.get(String(k).trim()) || null) };
  }
  const warehouses = () => ERP.inventory.warehouses();
  function whOf(v) { if (blank(v)) return C('warehouses').get(ERP.inventory.defaultWh()) || { id: ERP.inventory.defaultWh(), name: 'المخزن الرئيسي' }; const n = norm(v); return warehouses().find(w => norm(w.name) === n || norm(w.code || '') === n || w.id === v) || null; }
  const whNames = () => warehouses().map(w => w.name).join('، ');
  const whChoices = () => warehouses().map(w => ({ value: w.id, label: w.name }));
  /** product unit by name (base unit name → null) → { unitId, factor, name } | { error } */
  function unitOf(p, name, hitUnit) {
    if (blank(name)) return hitUnit ? { unitId: hitUnit.id, factor: u.num(hitUnit.factor, 1), name: ERP.units.name(p, hitUnit.id) } : { unitId: null, factor: 1, name: '' };
    const n = norm(name);
    if (n === norm(ERP.units.baseName(p))) return { unitId: null, factor: 1, name: '' };
    const x = ERP.units.list(p).find(y => norm(y.name) === n || norm(ERP.units.name(p, y.id)) === n);
    if (!x) return { error: `الوحدة «${name}» غير معرفة للصنف «${p.name}» — المتاح: ${[ERP.units.baseName(p), ...ERP.units.list(p).map(y => y.name)].join('، ')}` };
    return { unitId: x.id, factor: u.num(x.factor, 1), name: ERP.units.name(p, x.id) };
  }
  const PAY_ALIAS = { cash: ['نقدي', 'نقدا', 'نقدى', 'كاش', 'خزينه', 'الخزينه', 'cash'], credit: ['اجل', 'آجل', 'على الحساب', 'علي الحساب', 'credit', 'اجل على مورد'], opening: ['افتتاحي', 'رصيد افتتاحي', 'موجود مسبقا', 'opening'] };
  /** payment method by id/name/alias → id | null (allowCredit: 'credit' = on a supplier's account; allowOpening for assets) */
  function methodOf(v, { allowCredit = true, allowOpening = false } = {}) {
    const n = norm(v);
    if (PAY_ALIAS.cash.map(norm).includes(n)) return 'cash';
    if (allowCredit && PAY_ALIAS.credit.map(norm).includes(n)) return 'credit';
    if (allowOpening && PAY_ALIAS.opening.map(norm).includes(n)) return 'opening';
    const mt = ERP.sales.methods().find(x => !x.isCredit && (x.id === v || norm(x.name) === n)); if (mt) return mt.id;
    if (['بنك', 'البنك', 'تحويل بنكي', 'bank'].map(norm).includes(n)) { const b = ERP.sales.methods().find(x => x.accountSys === 'bank'); if (b) return b.id; }
    return null;
  }
  const methodNames = (opening = false) => [...ERP.sales.methods().filter(x => !x.isCredit).map(x => x.name), 'آجل (على مورد)', ...(opening ? ['رصيد افتتاحي'] : [])].join('، ');
  function supplierOf(v) { if (blank(v)) return null; const n = norm(v), d = digits(v); return C('suppliers').all().find(s => norm(s.name) === n || s.code === v || (d.length >= 7 && digits(s.phone) === d)) || null; }
  const lbl = (def, k) => `«${(def.columns.find(c => c.key === k) || {}).label || k}»`;
  const noNeg = (def, row, keys, errors) => keys.forEach(k => { if (row[k] !== null && row[k] < 0) errors.push(`${lbl(def, k)} لا يقبل قيمة سالبة`); });
  /** find the existing record of a party-like collection by the chosen match key */
  function matchParty(list, key, row) {
    const v = row[key]; if (blank(v)) return { ex: null };
    if (key === 'phone') { const d = digits(v); return { ex: d ? list.find(x => digits(x.phone) === d) || null : null }; }
    if (key === 'name') { const hits = list.filter(x => norm(x.name) === norm(v)); return hits.length > 1 ? { error: `يوجد أكثر من سجل باسم «${v}» — استخدم المطابقة بالهاتف أو الكود` } : { ex: hits[0] || null }; }
    return { ex: list.find(x => String(x[key] || '') === String(v)) || null };
  }
  /** create/update/skip decision for upsert-style types */
  function decide(ctx, ex, what, matchLabel, v) {
    if (ex && ctx.mode === 'create') return { action: 'skip', warnings: [`${what} موجود بالفعل («${ex.name}») — تم تخطيه`] };
    if (!ex && ctx.mode === 'update') return { errors: [blank(v) ? `${matchLabel} فارغ — لا يمكن إيجاد ${what}` : `لا يوجد ${what} ${matchLabel} ${v}`] };
    return null;
  }
  const mLabel = (def, ctx) => ((def.matchBy.find(x => x.key === ctx.matchBy) || {}).label ? `«${def.matchBy.find(x => x.key === ctx.matchBy).label}»` : '');
  const openingDate = { key: 'date', label: 'تاريخ الرصيد الافتتاحي', type: 'date', default: () => u.todayISO() };
  const refSheet = (name, rows) => ({ name, rows: rows.length ? rows : [{ 'ملاحظة': 'لا توجد بيانات' }] });

  /* =================================================================== products */
  const unitCols = i => [col(`u${i}Name`, `وحدة ${i}`, [`الوحدة ${i}`, `اسم وحدة ${i}`, `unit${i}`], { help: 'وحدة بيع إضافية (مثال: كرتونة)' }), col(`u${i}Factor`, `معامل وحدة ${i}`, [`عدد القطع في وحدة ${i}`, `factor${i}`], { type: 'number', help: 'عدد الوحدات الأساسية بداخلها — أكبر من 1' }), col(`u${i}Price`, `سعر وحدة ${i}`, [`price${i}`], { type: 'number', help: 'فارغ/0 = السعر الأساسي × المعامل' }), col(`u${i}Barcode`, `باركود وحدة ${i}`, [`barcode${i}`], { latin: true })];
  T.register({
    id: 'products', label: 'المنتجات', icon: 'boxes-stacked', group: 'بيانات أساسية', perm: 'products.manage', sheetName: 'المنتجات',
    desc: 'إضافة وتحديث الأصناف بالأسعار والوحدات والباركودات. الكمية الافتتاحية للأصناف الجديدة فقط (تُرحّل للمخزون والحسابات). تغيير سعر صنف موجود يضيف ملصق رف جديد.',
    modes: ['upsert', 'create', 'update'], matchBy: [{ key: 'code', label: 'الكود' }, { key: 'barcode', label: 'الباركود' }, { key: 'name', label: 'الاسم' }],
    unique: ['code', 'barcode', { key: (r, ctx) => (ctx.matchBy === 'name' && !blank(r.name) ? norm(r.name) : null), label: '«الاسم»' }],
    columns: [
      col('code', 'الكود', ['كود', 'كود الصنف', 'كود المنتج', 'code', 'sku'], { latin: true, help: 'فارغ للجديد = كود تلقائي', example: 'PRD-10001' }),
      col('barcode', 'الباركود', ['باركود', 'الباركود الرئيسي', 'barcode', 'ean'], { latin: true, example: '6221000000017' }),
      col('name', 'الاسم', ['اسم المنتج', 'اسم الصنف', 'الصنف', 'المنتج', 'name'], { requiredNote: 'للجديد', example: 'زيت عباد الشمس 1 لتر' }),
      col('category', 'الفئة', ['القسم', 'التصنيف', 'category'], { help: 'تُنشأ تلقائياً لو غير موجودة', example: 'زيوت' }),
      col('unit', 'الوحدة', ['الوحدة الأساسية', 'وحدة القياس', 'unit'], { help: 'من الوحدات المعرفة (قطعة، كيلو…)', example: 'قطعة', values: () => C('units').all().map(x => x.name).join('، ') }),
      col('cost', 'التكلفة', ['سعر التكلفة', 'سعر الشراء', 'cost'], { type: 'number', help: 'للصنف الموجود: تتغير فقط لو رصيده صفر (غير ذلك تُحسب من المشتريات)', example: 62 }),
      col('price', 'السعر', ['سعر البيع', 'سعر القطعة', 'price'], { type: 'number', example: 72 }),
      col('wholesalePrice', 'سعر الجملة', ['جملة', 'wholesale'], { type: 'number', example: 68 }),
      col('minPrice', 'أقل سعر', ['أقل سعر بيع', 'أقل سعر بيع مسموح', 'minPrice'], { type: 'number' }),
      col('minStock', 'الحد الأدنى', ['حد الطلب', 'الحد الأدنى للمخزون', 'minStock'], { type: 'number', example: 10 }),
      col('taxRate', 'الضريبة %', ['نسبة الضريبة', 'الضريبة', 'taxRate'], { type: 'number', example: 0 }),
      col('active', 'نشط', ['فعال', 'active'], { type: 'bool', example: 'نعم' }),
      col('trackExpiry', 'تتبع الصلاحية', ['صلاحية', 'trackExpiry'], { type: 'bool', example: 'لا' }),
      col('barcodes', 'باركودات إضافية', ['باركود بديل', 'باركودات بديلة', 'barcodes'], { type: 'list', latin: true, help: 'افصل بينها بفاصلة', example: '6221000000024, 6221000000031' }),
      ...unitCols(1), ...unitCols(2),
      col('openingQty', 'الكمية الافتتاحية', ['الكمية', 'المخزون', 'الرصيد', 'رصيد افتتاحي', 'qty', 'stock'], { type: 'number', help: 'للأصناف الجديدة فقط', example: 24 }),
      col('warehouse', 'المخزن', ['warehouse'], { help: 'فارغ = المخزن الافتراضي', values: whNames }),
      col('openingCost', 'تكلفة الرصيد', ['تكلفة الكمية الافتتاحية', 'openingCost'], { type: 'number', help: 'فارغ = عمود التكلفة' }),
    ],
    examples: () => [{ code: 'PRD-10001', barcode: '6221000000017', name: 'زيت عباد الشمس 1 لتر', category: 'زيوت', unit: 'قطعة', cost: 62, price: 72, wholesalePrice: 68, minStock: 10, taxRate: 0, active: 'نعم', trackExpiry: 'لا', barcodes: '6221000000024', u1Name: 'كرتونة', u1Factor: 12, u1Price: 840, u1Barcode: '16221000000014', openingQty: 24, warehouse: '' }, { code: '', barcode: '6221000000048', name: 'سكر 1 كجم', category: 'بقالة', unit: 'قطعة', cost: 26, price: 30, minStock: 20, active: 'نعم', openingQty: 50 }],
    refSheets: () => [refSheet('الفئات (مرجع)', C('categories').all().map(c => ({ 'الفئة': c.name }))), refSheet('الوحدات (مرجع)', C('units').all().map(x => ({ 'الوحدة': x.name }))), refSheet('المخازن (مرجع)', warehouses().map(w => ({ 'المخزن': w.name, 'الكود': w.code || '' })))],
    prepare() { return { idx: productIndex(), cats: new Map(C('categories').all().map(c => [norm(c.name), c])), units: new Map(C('units').all().flatMap(x => [[norm(x.name), x], [norm(x.short || x.name), x]])), newCats: new Map() }; },
    validate(row, ctx) {
      const c = ctx.cache, def = this, errors = [], warnings = []; const key = ctx.matchBy, kv = row[key];
      let ex = null;
      if (!blank(kv)) { if (key === 'name') { if ((c.idx.nameN.get(norm(kv)) || 0) > 1) return { errors: [`يوجد أكثر من منتج باسم «${kv}» — طابق بالكود أو الباركود`] }; ex = c.idx.name.get(norm(kv)) || null; } else ex = c.idx[key].get(String(kv)) || null; }
      const dec = decide(ctx, ex, 'المنتج', mLabel(def, ctx), kv); if (dec) return dec;
      const isNew = !ex; const name = row.name !== null ? String(row.name) : ex ? ex.name : '';
      if (isNew && blank(row.name)) errors.push('«الاسم» مطلوب للمنتج الجديد');
      noNeg(def, row, ['cost', 'price', 'wholesalePrice', 'minPrice', 'minStock', 'taxRate', 'openingQty', 'openingCost'], errors);
      if (row.taxRate !== null && row.taxRate > 100) errors.push('نسبة الضريبة غير صالحة');
      let categoryId = null; if (!blank(row.category)) { const k = norm(row.category), cat = c.cats.get(k); if (cat) categoryId = cat.id; else { categoryId = 'new:' + k; if (!c.newCats.has(k)) { c.newCats.set(k, String(row.category).trim()); warnings.push(`فئة جديدة ستُنشأ: «${row.category}»`); } } }
      let unitId = null; if (!blank(row.unit)) { const un = c.units.get(norm(row.unit)); if (un) unitId = un.id; else errors.push(`الوحدة «${row.unit}» غير موجودة — المتاح: ${C('units').all().map(x => x.name).join('، ')}`); }
      // codes & barcodes: unique across all products/units in the database and across this file
      const code = row.code !== null ? String(row.code) : ex ? ex.code : null, barcode = row.barcode !== null ? String(row.barcode) : ex ? ex.barcode || '' : '';
      const aliases = [...((ex && ex.barcodes) || [])]; (row.barcodes || []).forEach(b => { if (!aliases.some(a => a.code === b)) aliases.push({ code: b, qty: 1, price: null }); });
      const fresh = [];
      if (row.code !== null && (!ex || ex.code !== code)) fresh.push(['الكود', code]);
      if (row.barcode !== null && (!ex || (ex.barcode || '') !== barcode)) fresh.push(['الباركود', barcode]);
      (row.barcodes || []).forEach(b => { if (!ex || !(ex.barcodes || []).some(a => a.code === b)) fresh.push(['الباركود الإضافي', b]); });
      // units: existing ones (same name) are updated, new ones appended; validated like the product form
      const specs = [1, 2].map(i => ({ i, name: row[`u${i}Name`], factor: row[`u${i}Factor`], price: row[`u${i}Price`], barcode: row[`u${i}Barcode`] })).filter(s => !blank(s.name) || s.factor !== null || s.price !== null || !blank(s.barcode));
      let units = null, list = null; const unitPrices = [], newUnitLabels = [], pend = [];
      if (specs.length) {
        list = ex ? ERP.units.list(ex).map(x => ({ ...x })) : [];
        specs.forEach(s => {
          if (blank(s.name)) return errors.push(`اسم «وحدة ${s.i}» مطلوب (مثال: كرتونة)`);
          const cur = list.find(x => norm(x.name) === norm(s.name));
          if (cur) { if (s.factor !== null) cur.factor = s.factor; if (!blank(s.barcode) && cur.barcode !== String(s.barcode)) { cur.barcode = String(s.barcode); fresh.push([`باركود ${s.name}`, cur.barcode]); } if (s.price !== null) pend.push({ name: s.name, price: s.price, isNew: false }); }
          else { if (s.factor === null) return errors.push(`«معامل وحدة ${s.i}» مطلوب للوحدة «${s.name}»`); const ref = c.units.get(norm(s.name)); list.push({ unitId: ref ? ref.id : null, name: String(s.name).trim(), factor: s.factor, price: s.price ?? 0, barcode: blank(s.barcode) ? '' : String(s.barcode) }); if (!blank(s.barcode)) fresh.push([`باركود ${s.name}`, String(s.barcode)]); if (ex && u.num(s.price) > 0) pend.push({ name: s.name, price: s.price, isNew: true }); }
        });
      }
      const mine = new Set(); const seen = ctx.state.codes || (ctx.state.codes = new Map());
      fresh.forEach(([what, v]) => {
        if (blank(v)) return; v = String(v);
        if (mine.has(v)) return errors.push(`${what} ${v} مكرر داخل نفس السطر`); mine.add(v);
        const o = ERP.units.barcodeOwner(v, { exceptProductId: ex ? ex.id : null }); if (o) return errors.push(`${what} ${v} مستخدم في المنتج «${o.product.name}»${o.unit ? ` (وحدة ${o.unit.name})` : ''}`);
        if (seen.has(v)) errors.push(`${what} ${v} مكرر في الملف (السطر ${seen.get(v)})`);
      });
      if (list && !errors.length) {
        try { units = ERP.units.validate({ id: ex ? ex.id : null, barcode, code, barcodes: aliases }, list); } catch (err) { errors.push(err.message); }
        if (units && ex) pend.forEach(x => { const un = units.find(y => norm(y.name) === norm(x.name)); if (!un) return; if (x.isNew) newUnitLabels.push({ unitId: un.id, price: un.price }); else if (Math.abs(ERP.units.price({ ...ex, units }, un.id) - x.price) >= 0.005) unitPrices.push({ unitId: un.id, price: x.price, old: ERP.units.price(ex, un.id) }); });
      }
      // stock: opening quantity for new products only
      let opening = null;
      if (u.num(row.openingQty) > 0) {
        if (!isNew) warnings.push('الكمية تُتجاهل للمنتجات الموجودة — استخدم «تسوية المخزون» من مركز الاستيراد');
        else { const wh = whOf(row.warehouse); if (!wh) errors.push(`المخزن «${row.warehouse}» غير موجود — المتاح: ${whNames()}`); else { const cost = row.openingCost ?? row.cost ?? 0; if (!cost) warnings.push('كمية افتتاحية بدون تكلفة — ستُقيَّم بصفر'); opening = { qty: u.round(row.openingQty, 3), cost: u.round(cost, 4), wh: wh.id, value: r2(row.openingQty * cost) }; } }
      }
      if (errors.length) return { errors, warnings, label: name };
      fresh.forEach(([, v]) => { if (!blank(v)) seen.set(String(v), row._row); });
      const price = row.price ?? (ex ? u.num(ex.price) : 0), cost = row.cost ?? (ex ? u.num(ex.cost) : 0);
      if (price > 0 && price < cost) warnings.push(`سعر البيع ${m(price)} أقل من التكلفة ${m(cost)}`);
      if (isNew && row.price === null) warnings.push('بدون سعر بيع');
      if (row.minPrice !== null && row.minPrice > price) warnings.push('«أقل سعر» أكبر من سعر البيع');
      if (isNew) {
        const doc = { code: row.code !== null ? code : null, barcode, name, categoryId: categoryId || 'cat_other', unitId: unitId || 'un_pc', cost: u.round(row.openingCost ?? row.cost ?? 0, 4), price: r2(row.price ?? 0), wholesalePrice: r2(row.wholesalePrice ?? 0), minPrice: r2(row.minPrice ?? 0), minStock: row.minStock ?? 5, taxRate: row.taxRate ?? 0, active: row.active ?? true, trackExpiry: !!row.trackExpiry, barcodes: aliases, units: units || [], priceTiers: {} };
        return { action: 'create', label: `${name}${code ? ` (${code})` : ''}${opening ? ` · رصيد ${q(opening.qty)}` : ''}`, data: { doc, opening }, warnings };
      }
      const patch = {}; const setIf = (k, v) => { if (v !== null && v !== undefined && changed(ex[k], v)) patch[k] = v; };
      setIf('name', row.name !== null ? name : null); setIf('code', row.code !== null ? code : null); setIf('barcode', row.barcode !== null ? barcode : null); setIf('categoryId', categoryId); setIf('unitId', unitId);
      setIf('wholesalePrice', row.wholesalePrice); setIf('minPrice', row.minPrice); setIf('minStock', row.minStock); setIf('taxRate', row.taxRate); setIf('active', row.active); setIf('trackExpiry', row.trackExpiry);
      if (row.cost !== null && Math.abs(row.cost - u.num(ex.cost)) >= 0.0001) { if (Math.abs(u.num(ex.stock)) > 0.0001) warnings.push(`التكلفة لم تتغير لأن للصنف رصيد ${q(ex.stock)} (المتوسط المرجح من المشتريات) — استخدم تسوية المخزون`); else patch.cost = u.round(row.cost, 4); }
      if ((row.barcodes || []).length && changed(ex.barcodes || [], aliases)) patch.barcodes = aliases;
      if (units && changed(ERP.units.list(ex), units)) patch.units = units;
      const newPrice = row.price !== null && Math.abs(row.price - u.num(ex.price)) >= 0.005 ? r2(row.price) : null;
      const what = [...(newPrice !== null ? [`السعر ${m(ex.price)} ← ${m(newPrice)}`] : []), ...unitPrices.map(x => `سعر ${(units.find(y => y.id === x.unitId) || {}).name}: ${m(x.old)} ← ${m(x.price)}`), ...Object.keys(patch).filter(k => !['units', 'barcodes'].includes(k)).map(k => (def.columns.find(cc => cc.key === k) || { label: { categoryId: 'الفئة', unitId: 'الوحدة' }[k] || k }).label), ...(patch.units ? ['الوحدات'] : []), ...(patch.barcodes ? ['الباركودات'] : [])];
      if (!what.length) return { action: 'skip', label: ex.name, warnings: [...warnings, 'لا توجد تغييرات'] };
      return { action: 'update', label: `${ex.name} (${ex.code}): ${what.join('، ')}`, data: { id: ex.id, patch, price: newPrice, unitPrices, newUnitLabels }, warnings };
    },
    totals(valid) { const cr = valid.filter(i => i.action === 'create'), up = valid.filter(i => i.action === 'update'); const op = cr.map(i => i.data.opening).filter(Boolean); return [{ label: 'منتجات جديدة', value: cr.length }, { label: 'تحديث', value: up.length }, { label: 'تغييرات أسعار', value: up.reduce((a, i) => a + (i.data.price !== null ? 1 : 0) + i.data.unitPrices.length, 0) }, { label: 'كمية افتتاحية', value: u.sum(op, 'qty'), qty: true }, { label: 'قيمة المخزون الافتتاحي', value: r2(u.sum(op, 'value')), money: true }]; },
    apply(items, ctx) {
      const cats = C('categories'); const catIds = {}; const reason = `استيراد ${ctx.batch.no}`;
      const catOf = k => { if (!k || !String(k).startsWith('new:')) return k; const n = k.slice(4); if (!catIds[n]) { const ex = cats.all().find(x => norm(x.name) === n); catIds[n] = ex ? ex.id : cats.insert({ name: ctx.cache.newCats.get(n) || n, icon: 'tag', color: '#64748b' }, { silent: true }).id; } return catIds[n]; };
      let value = 0, created = 0, updated = 0;
      items.forEach(it => {
        const d = it.data;
        if (it.action === 'create') {
          const np = P().insert({ ...d.doc, categoryId: catOf(d.doc.categoryId), code: d.doc.code || ERP.db.nextSeq('PRD', 'PRD', 5), stock: 0, stockByWh: {}, batches: [] }, { silent: true }); created++;
          if (d.opening) { const mv = ERP.inventory.move({ productId: np.id, warehouseId: d.opening.wh, qty: d.opening.qty, type: 'opening', unitCost: d.opening.cost, refType: 'import', refId: ctx.batch.id, note: `رصيد افتتاحي — ${reason}`, silent: true }); value += mv ? u.num(mv.value) : 0; }
        } else {
          const patch = { ...d.patch }; if (patch.categoryId) patch.categoryId = catOf(patch.categoryId);
          if (Object.keys(patch).length) P().update(d.id, patch, { silent: true });
          if (d.price !== null) ERP.units.setPrice(d.id, null, d.price, { reason, silent: true, audit: false }); // audit summary + shelf label
          d.unitPrices.forEach(x => ERP.units.setPrice(d.id, x.unitId, x.price, { reason, silent: true, audit: false }));
          d.newUnitLabels.forEach(x => ERP.labels.add({ productId: d.id, unitId: x.unitId, oldPrice: null, newPrice: ERP.units.price(P().get(d.id), x.unitId), reason }));
          updated++;
        }
      });
      value = r2(value); // opening quantities reach GL inventory (GL = valuation)
      if (value) ERP.accounting.post({ date: u.now(), memo: `رصيد مخزون افتتاحي — ${reason}`, refType: 'opening', refId: `import:${ctx.batch.id}`, lines: [{ sys: 'inventory', debit: value }, { sys: 'opening', credit: value }] });
      return { summary: `${created} منتج جديد، ${updated} تحديث${value ? `، مخزون افتتاحي ${m(value)}` : ''}` };
    },
  });

  /* =================================================================== customers / suppliers */
  const partyCols = extra => [
    col('code', 'الكود', ['كود', 'code'], { latin: true, help: 'للمطابقة؛ للجديد فارغ = تلقائي' }),
    col('name', 'الاسم', ['اسم العميل', 'اسم المورد', 'العميل', 'المورد', 'name'], { requiredNote: 'للجديد', example: extra.nameEx }),
    col('phone', 'الهاتف', ['الموبايل', 'رقم الهاتف', 'تليفون', 'موبايل', 'phone', 'mobile'], { phone: true, example: extra.phoneEx, help: 'يُقبل 01xxxxxxxxx أو +20… — Excel يحذف الصفر الأول ويتم إرجاعه تلقائياً' }),
    col('address', 'العنوان', ['address']), col('email', 'البريد الإلكتروني', ['الايميل', 'البريد', 'email']),
    ...extra.cols,
    col('notes', 'ملاحظات', ['notes']),
    col('openingBalance', 'الرصيد الافتتاحي', ['الرصيد', 'رصيد افتتاحي', 'المديونية', 'balance'], { type: 'number', help: extra.balHelp, example: extra.balEx }),
  ];
  function partyType({ id, label, icon, perm, colName, what, cols, desc, create, sys, nameEx, phoneEx, balHelp, balEx, fields, examples }) {
    T.register({
      id, label, icon, group: 'بيانات أساسية', perm, desc, sheetName: label, modes: ['upsert', 'create', 'update'],
      matchBy: [{ key: 'phone', label: 'الهاتف' }, { key: 'code', label: 'الكود' }, { key: 'name', label: 'الاسم' }],
      unique: [{ key: r => (digits(r.phone) || null), label: '«الهاتف»' }, 'code', { key: (r, ctx) => (ctx.matchBy === 'name' && !blank(r.name) ? norm(r.name) : null), label: '«الاسم»' }],
      columns: partyCols({ nameEx, phoneEx, balHelp, balEx, cols }), options: [openingDate], examples,
      prepare() { return { list: C(colName).all() }; },
      validate(row, ctx) {
        const def = this, list = ctx.cache.list, errors = [], warnings = [];
        const mt = matchParty(list, ctx.matchBy, row); if (mt.error) return { errors: [mt.error] };
        const ex = mt.ex; const dec = decide(ctx, ex, what, mLabel(def, ctx), row[ctx.matchBy]); if (dec) return { ...dec, label: row.name || (ex && ex.name) };
        if (!ex && blank(row.name)) errors.push('«الاسم» مطلوب');
        const d = digits(row.phone); if (d) { const o = list.find(x => x !== ex && digits(x.phone) === d); if (o) errors.push(`الهاتف ${row.phone} مسجل لـ«${o.name}»`); if (d.length < 7) warnings.push('رقم الهاتف قصير'); }
        if (!blank(row.code) && list.some(x => x !== ex && x.code === row.code)) errors.push(`الكود ${row.code} مستخدم`);
        if (!blank(row.email) && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(row.email)) warnings.push('البريد الإلكتروني غير صالح');
        const f = fields(row, ex, errors, warnings);
        if (errors.length) return { errors, warnings, label: row.name || (ex && ex.name) };
        const bal = r2(row.openingBalance ?? 0);
        if (!ex) return { action: 'create', label: `${row.name}${row.phone ? ` · ${row.phone}` : ''}${bal ? ` · رصيد ${m(bal)}` : ''}`, data: { doc: { name: String(row.name).trim(), phone: row.phone || '', address: row.address || '', email: row.email || '', notes: row.notes || '', ...f }, code: row.code, balance: bal } };
        if (bal) warnings.push('الرصيد الافتتاحي يُطبَّق على الجدد فقط — للموجودين استخدم «الأرصدة الافتتاحية»');
        const patch = {}; const all = { name: row.name, phone: row.phone, address: row.address, email: row.email, notes: row.notes, code: row.code, ...f }; Object.entries(all).forEach(([k, v]) => { if (v !== null && v !== undefined && changed(ex[k], v)) patch[k] = v; });
        if (!Object.keys(patch).length) return { action: 'skip', label: ex.name, warnings: [...warnings, 'لا توجد تغييرات'] };
        return { action: 'update', label: `${ex.name}: ${Object.keys(patch).map(k => (def.columns.find(cc => cc.key === k) || {}).label || k).join('، ')}`, data: { id: ex.id, patch }, warnings };
      },
      totals(valid) { const cr = valid.filter(i => i.action === 'create'); return [{ label: 'جدد', value: cr.length }, { label: 'تحديث', value: valid.length - cr.length }, { label: 'الأرصدة الافتتاحية', value: r2(u.sum(cr, i => i.data.balance)), money: true }]; },
      apply(items, ctx) {
        const X = C(colName); const date = dayISO(ctx.options.date); let bal = 0;
        items.forEach(it => {
          const d = it.data;
          if (it.action === 'update') { X.update(d.id, d.patch, { silent: true }); return; }
          const doc = create(d.doc); if (!blank(d.code) && !X.first({ code: d.code })) X.update(doc.id, { code: d.code }, { silent: true });
          if (d.balance) { // opening balance against «الأرصدة الافتتاحية» — sub-ledger moves with the GL
            X.update(doc.id, { balance: d.balance, openingBalance: d.balance }, { silent: true }); bal += d.balance;
            const dr = sys === 'ar' ? d.balance > 0 : d.balance < 0, a = Math.abs(d.balance);
            ERP.accounting.post({ date, memo: `رصيد افتتاحي ${what} ${doc.name} — ${ctx.batch.no}`, refType: 'opening', refId: `import:${ctx.batch.id}:${id[0]}:${doc.id}`, lines: dr ? [{ sys, debit: a, desc: doc.name }, { sys: 'opening', credit: a }] : [{ sys: 'opening', debit: a }, { sys, credit: a, desc: doc.name }] });
          }
        });
        return { summary: `${items.filter(i => i.action === 'create').length} جديد، ${items.filter(i => i.action === 'update').length} تحديث${bal ? `، أرصدة ${m(bal)}` : ''}` };
      },
    });
  }
  partyType({
    id: 'customers', label: 'العملاء', icon: 'users', perm: 'customers.manage', colName: 'customers', what: 'العميل', sys: 'ar', nameEx: 'محمد أحمد', phoneEx: '01001234567', balEx: 350,
    balHelp: 'للعملاء الجدد: موجب = مديونية على العميل، سالب = رصيد دائن له',
    desc: 'إضافة وتحديث العملاء بمجموعة السعر وحد الائتمان. الرصيد الافتتاحي للجدد يُرحّل على حساب العملاء مقابل «الأرصدة الافتتاحية».',
    cols: [col('group', 'المجموعة', ['مجموعة السعر', 'فئة العميل', 'group'], { values: () => u.uniq(['عادي', ...(ERP.settings.get('priceGroups') || []), ...ERP.crm.GROUPS]).join('، '), example: 'عادي' }), col('creditLimit', 'حد الائتمان', ['الحد الائتماني', 'creditLimit'], { type: 'number', example: 1000 }), col('taxNumber', 'الرقم الضريبي', ['رقم التسجيل الضريبي', 'taxNumber'], { latin: true })],
    fields(row, ex, errors) {
      const f = {}; if (row.group !== null) { const g = u.uniq(['عادي', ...(ERP.settings.get('priceGroups') || []), ...ERP.crm.GROUPS]).find(x => norm(x) === norm(row.group)); if (!g) errors.push(`المجموعة «${row.group}» غير معروفة — المتاح: ${u.uniq(['عادي', ...(ERP.settings.get('priceGroups') || []), ...ERP.crm.GROUPS]).join('، ')}`); else f.group = g; }
      if (row.creditLimit !== null) { if (row.creditLimit < 0) errors.push('حد الائتمان لا يقبل قيمة سالبة'); else f.creditLimit = row.creditLimit; }
      if (row.taxNumber !== null) f.taxNumber = row.taxNumber; return f;
    },
    create: doc => ERP.crm.create(doc),
    examples: () => [{ name: 'محمد أحمد', phone: '01001234567', address: 'شارع التحرير', group: 'عادي', creditLimit: 1000, openingBalance: 350 }, { name: 'سوبر ماركت النور', phone: '01112223334', group: 'جملة', creditLimit: 5000, openingBalance: 0 }],
  });
  partyType({
    id: 'suppliers', label: 'الموردين', icon: 'truck-field', perm: 'suppliers.manage', colName: 'suppliers', what: 'المورد', sys: 'ap', nameEx: 'شركة الأمل للتوريدات', phoneEx: '01223334445', balEx: 1200,
    balHelp: 'للموردين الجدد: موجب = مستحق للمورد علينا، سالب = رصيد مدين لنا',
    desc: 'إضافة وتحديث الموردين. الرصيد الافتتاحي للجدد يُرحّل على حساب الموردين مقابل «الأرصدة الافتتاحية».',
    cols: [col('taxNumber', 'الرقم الضريبي', ['رقم التسجيل الضريبي', 'البطاقة الضريبية', 'taxNumber'], { latin: true, example: '123-456-789' }), col('contact', 'مسؤول التواصل', ['المسؤول', 'contact']), col('paymentTerms', 'مدة السداد (يوم)', ['أيام السداد', 'paymentTerms'], { type: 'int' })],
    fields(row, ex, errors) { const f = {}; if (row.taxNumber !== null) f.taxNumber = row.taxNumber; if (row.contact !== null) f.contact = row.contact; if (row.paymentTerms !== null) { if (row.paymentTerms < 0) errors.push('مدة السداد غير صالحة'); else f.paymentTerms = row.paymentTerms; } return f; },
    create: doc => ERP.purchasing.createSupplier(doc),
    examples: () => [{ name: 'شركة الأمل للتوريدات', phone: '01223334445', taxNumber: '123-456-789', paymentTerms: 30, openingBalance: 1200 }],
  });

  /* =================================================================== employees */
  const toTime = v => { if (blank(v)) return null; let s = String(v).trim(); if (/^0?\.\d+$/.test(s) || /^\d?\.\d+e-?\d+$/i.test(s)) { const mins = Math.round(Number(s) * 24 * 60); s = `${Math.floor(mins / 60)}:${mins % 60}`; } const mm = s.match(/^(\d{1,2})[:.](\d{1,2})$/); if (!mm || +mm[1] > 23 || +mm[2] > 59) return undefined; return `${mm[1].padStart(2, '0')}:${mm[2].padStart(2, '0')}`; };
  T.register({
    id: 'employees', label: 'الموظفين', icon: 'id-card', group: 'بيانات أساسية', perm: 'hr.manage', sheetName: 'الموظفين',
    desc: 'إضافة وتحديث بيانات الموظفين (الوظيفة، الراتب، تاريخ التعيين، الرقم القومي، مواعيد الدوام).',
    modes: ['upsert', 'create', 'update'], matchBy: [{ key: 'code', label: 'الكود' }, { key: 'nationalId', label: 'الرقم القومي' }, { key: 'phone', label: 'الهاتف' }, { key: 'name', label: 'الاسم' }],
    unique: ['code', 'nationalId', { key: r => digits(r.phone) || null, label: '«الهاتف»' }],
    columns: [
      col('code', 'الكود', ['كود الموظف', 'code'], { latin: true }), col('name', 'الاسم', ['اسم الموظف', 'name'], { requiredNote: 'للجديد', example: 'أحمد محمود' }),
      col('phone', 'الهاتف', ['الموبايل', 'phone'], { phone: true, example: '01011112222' }), col('nationalId', 'الرقم القومي', ['رقم البطاقة', 'nationalId'], { latin: true, help: '14 رقم', example: '29001011234567' }),
      col('job', 'الوظيفة', ['المسمى الوظيفي', 'job'], { values: () => ERP.hr.JOBS.join('، '), example: 'كاشير' }), col('salary', 'الراتب', ['الراتب الشهري', 'المرتب', 'salary'], { type: 'number', example: 6000 }),
      col('salaryType', 'نوع الراتب', ['salaryType'], { values: 'شهري، يومي', example: 'شهري' }), col('hireDate', 'تاريخ التعيين', ['تاريخ التعيين', 'hireDate'], { type: 'date', example: '01/03/2025' }),
      col('shiftStart', 'بداية الدوام', ['بداية الوردية', 'shiftStart'], { help: 'مثال 09:00', example: '09:00' }), col('shiftEnd', 'نهاية الدوام', ['نهاية الوردية', 'shiftEnd'], { example: '17:00' }),
      col('dailyHours', 'ساعات العمل اليومية', ['ساعات العمل', 'dailyHours'], { type: 'number', example: 8 }), col('address', 'العنوان', ['address']), col('notes', 'ملاحظات', ['notes']),
      col('active', 'على رأس العمل', ['نشط', 'active'], { type: 'bool' }),
    ],
    prepare() { return { list: C('employees').all() }; },
    validate(row, ctx) {
      const def = this, list = ctx.cache.list, errors = [], warnings = [];
      const mt = ctx.matchBy === 'nationalId' ? { ex: blank(row.nationalId) ? null : list.find(x => x.nationalId === row.nationalId) || null } : matchParty(list, ctx.matchBy, row); if (mt.error) return { errors: [mt.error] };
      const ex = mt.ex; const dec = decide(ctx, ex, 'الموظف', mLabel(def, ctx), row[ctx.matchBy]); if (dec) return { ...dec, label: row.name };
      if (!ex && blank(row.name)) errors.push('«الاسم» مطلوب');
      if (!blank(row.nationalId) && !/^\d{14}$/.test(row.nationalId)) warnings.push('الرقم القومي المصري 14 رقماً');
      if (!blank(row.nationalId)) { const o = list.find(x => x !== ex && x.nationalId === row.nationalId); if (o) errors.push(`الرقم القومي مسجل للموظف «${o.name}»`); }
      noNeg(def, row, ['salary', 'dailyHours'], errors); if (row.dailyHours !== null && (row.dailyHours < 1 || row.dailyHours > 16)) errors.push('ساعات العمل اليومية بين 1 و 16');
      const f = { name: row.name, phone: row.phone, nationalId: row.nationalId, job: row.job, salary: row.salary, hireDate: row.hireDate, address: row.address, notes: row.notes, dailyHours: row.dailyHours, active: row.active };
      if (row.salaryType !== null) { const s = norm(row.salaryType); f.salaryType = ['شهري', 'monthly'].includes(s) ? 'monthly' : ['يومي', 'daily'].includes(s) ? 'daily' : undefined; if (!f.salaryType) errors.push('«نوع الراتب»: شهري أو يومي'); }
      ['shiftStart', 'shiftEnd'].forEach(k => { const t = toTime(row[k]); if (t === undefined) errors.push(`${lbl(def, k)}: اكتب الوقت مثل 09:00`); else if (t) f[k] = t; });
      if (!blank(row.code) && list.some(x => x !== ex && x.code === row.code)) errors.push(`الكود ${row.code} مستخدم`);
      if (row.job !== null && !ERP.hr.JOBS.includes(row.job)) warnings.push(`وظيفة غير مدرجة في القائمة: «${row.job}»`);
      if (errors.length) return { errors, warnings, label: row.name };
      if (!ex) return { action: 'create', label: `${row.name}${row.job ? ` · ${row.job}` : ''}`, data: { doc: Object.fromEntries(Object.entries(f).filter(([, v]) => v !== null && v !== undefined)), code: row.code }, warnings };
      const patch = {}; Object.entries({ ...f, code: row.code }).forEach(([k, v]) => { if (v !== null && v !== undefined && changed(ex[k], v)) patch[k] = v; });
      if (!Object.keys(patch).length) return { action: 'skip', label: ex.name, warnings: [...warnings, 'لا توجد تغييرات'] };
      return { action: 'update', label: `${ex.name}: ${Object.keys(patch).map(k => (def.columns.find(cc => cc.key === k) || {}).label || k).join('، ')}`, data: { id: ex.id, patch }, warnings };
    },
    apply(items) {
      const E = C('employees');
      items.forEach(it => { const d = it.data; if (it.action === 'update') return E.update(d.id, d.patch, { silent: true }); const emp = ERP.hr.create(d.doc); const patch = {}; if (d.doc.active === false) patch.active = false; if (d.doc.salaryType) patch.salaryType = d.doc.salaryType; if (!blank(d.code) && !E.first({ code: d.code })) patch.code = d.code; if (Object.keys(patch).length) E.update(emp.id, patch, { silent: true }); });
      return { summary: `${items.filter(i => i.action === 'create').length} جديد، ${items.filter(i => i.action === 'update').length} تحديث` };
    },
  });

  /* =================================================================== chart of accounts */
  const ACC_T = { asset: ['اصول', 'اصل', 'asset', 'assets'], liability: ['التزامات', 'التزام', 'خصوم', 'liability', 'liabilities'], equity: ['حقوق ملكيه', 'حقوق الملكيه', 'equity'], revenue: ['ايرادات', 'ايراد', 'revenue', 'income'], expense: ['مصروفات', 'مصروف', 'expense', 'expenses'] };
  const ACC_AR = { asset: 'أصول', liability: 'التزامات', equity: 'حقوق ملكية', revenue: 'إيرادات', expense: 'مصروفات' };
  const accType = v => Object.keys(ACC_T).find(k => ACC_T[k].includes(norm(v))) || null;
  T.register({
    id: 'chartOfAccounts', label: 'شجرة الحسابات', icon: 'sitemap', group: 'حسابات ومصروفات', perm: 'accounting.manage', sheetName: 'الحسابات',
    desc: 'إضافة حسابات جديدة لشجرة الحسابات. الحساب الأب لازم يكون موجوداً أو في نفس الملف (الترتيب لا يهم). الحسابات الموجودة بنفس الكود تُتخطى.',
    modes: ['create'], matchBy: [{ key: 'code', label: 'كود الحساب' }],
    columns: [col('code', 'كود الحساب', ['الكود', 'رقم الحساب', 'code'], { required: true, latin: true, example: '5295' }), col('name', 'اسم الحساب', ['الاسم', 'الحساب', 'name'], { required: true, example: 'مصروفات نظافة' }), col('type', 'النوع', ['نوع الحساب', 'type'], { values: 'أصول، التزامات، حقوق ملكية، إيرادات، مصروفات', help: 'فارغ = نفس نوع الحساب الأب', example: 'مصروفات' }), col('parent', 'كود الحساب الأب', ['الحساب الأب', 'الأب', 'parent'], { latin: true, example: '5200' })],
    refSheets: () => [refSheet('شجرة الحسابات (مرجع)', ERP.accounting.tree().map(a => ({ 'الكود': a.code, 'الحساب': '  '.repeat(a.level - 1) + a.name, 'النوع': ACC_AR[a.type] })))],
    prepare() { return { byCode: new Map(ERP.accounting.accounts().map(a => [String(a.code), a])) }; },
    scan(rows, ctx) { ctx.state.file = new Map(rows.filter(r => !blank(r.code)).map(r => [String(r.code), r._row])); },
    validate(row, ctx) {
      const c = ctx.cache, code = String(row.code), ex = c.byCode.get(code), label = `${code} — ${row.name}`;
      if (ex) return { action: 'skip', label, warnings: [`الحساب ${code} موجود بالفعل («${ex.name}») — تم تخطيه`] };
      const type = blank(row.type) ? null : accType(row.type); if (!blank(row.type) && !type) return { errors: [`النوع «${row.type}» غير معروف — ${Object.values(ACC_AR).join('، ')}`], label };
      const pc = blank(row.parent) ? null : String(row.parent);
      if (pc === code) return { errors: ['الحساب لا يكون أباً لنفسه'], label };
      const par = pc ? c.byCode.get(pc) : null;
      if (pc && !par && !ctx.state.file.has(pc)) return { errors: [`الحساب الأب ${pc} غير موجود في الشجرة ولا في الملف`], label };
      if (par && type && par.type !== type) return { errors: [`نوع الحساب (${ACC_AR[type]}) يختلف عن نوع الحساب الأب «${par.name}» (${ACC_AR[par.type]})`], label };
      if (!pc && !type) return { errors: ['«النوع» مطلوب للحساب الرئيسي (بدون أب)'], label };
      return { action: 'create', label: `${label}${pc ? ` ← تحت ${pc}` : ''}`, data: { code, name: String(row.name).trim(), type: type || (par ? par.type : null), parentCode: pc, parentId: par ? par.id : null } };
    },
    finalize(items) { // parents inside the file: inherit type, fail with an errored parent, detect cycles
      const byCode = new Map(items.filter(i => i.data).map(i => [i.data.code, i])); const res = new Map();
      const walk = (it, path) => {
        if (res.has(it)) return res.get(it); const d = it.data; if (!d || it.errors.length) { res.set(it, null); return null; }
        if (d.parentId || !d.parentCode) { res.set(it, d.type); return d.type; }
        if (path.has(it)) { it.errors.push('تسلسل دائري بين الحسابات'); res.set(it, null); return null; }
        path.add(it); const par = byCode.get(d.parentCode); const pt = par ? walk(par, path) : null;
        if (!pt) { if (!it.errors.length) it.errors.push(`الحساب الأب ${d.parentCode} به خطأ في الملف${par ? ` (السطر ${par.row})` : ''}`); res.set(it, null); return null; }
        if (d.type && d.type !== pt) { it.errors.push(`نوع الحساب (${ACC_AR[d.type]}) يختلف عن نوع الحساب الأب ${d.parentCode} (${ACC_AR[pt]})`); res.set(it, null); return null; }
        d.type = pt; res.set(it, pt); return pt;
      };
      items.forEach(it => walk(it, new Set()));
    },
    apply(items) {
      const left = items.map(i => i.data); const made = new Map(); let guard = left.length + 1;
      while (left.length && guard--) for (let i = left.length - 1; i >= 0; i--) { const d = left[i]; const pid = d.parentId || (d.parentCode ? made.get(d.parentCode) : null); if (d.parentCode && !pid) continue; made.set(d.code, ERP.accounting.createAccount({ code: d.code, name: d.name, type: d.type, parentId: pid }).id); left.splice(i, 1); } // parents first
      if (left.length) throw new Error('تعذر ترتيب الحسابات حسب الأب');
      return { summary: `${made.size} حساب` };
    },
  });

  /* =================================================================== fixed assets */
  T.register({
    id: 'fixedAssets', label: 'الأصول الثابتة', icon: 'building', group: 'حسابات ومصروفات', perm: 'accounting.manage', sheetName: 'الأصول',
    desc: 'تسجيل الأصول الثابتة (ثلاجات، أرفف، أجهزة…) بقيد الشراء: نقدي/بنك، آجل على مورد، أو رصيد افتتاحي لأصل موجود مسبقاً. الإهلاك الشهري بالقسط الثابت يبدأ من «بداية الإهلاك».',
    modes: ['create'], unique: [{ key: r => (blank(r.serial) ? null : norm(r.serial)), label: '«الرقم التسلسلي»' }],
    columns: [
      col('name', 'اسم الأصل', ['الاسم', 'الأصل', 'name'], { required: true, example: 'ثلاجة عرض 3 باب' }), col('category', 'الفئة', ['التصنيف', 'category'], { values: () => ERP.assets.CATS.join('، '), example: 'ثلاجات وتبريد' }),
      col('purchaseDate', 'تاريخ الشراء', ['التاريخ', 'purchaseDate'], { type: 'date', example: '15/01/2024' }), col('cost', 'التكلفة', ['قيمة الشراء', 'cost'], { type: 'number', required: true, example: 45000 }),
      col('salvage', 'قيمة الخردة', ['القيمة التخريدية', 'salvage'], { type: 'number', example: 2000 }), col('lifeMonths', 'العمر بالشهور', ['العمر الإنتاجي بالشهور', 'lifeMonths'], { type: 'int', example: 60 }),
      col('lifeYears', 'العمر بالسنوات', ['العمر الإنتاجي', 'العمر الإنتاجي بالسنوات', 'lifeYears'], { type: 'number', help: 'بديل عن العمر بالشهور' }),
      col('payMethod', 'طريقة السداد', ['طريقة الشراء', 'الدفع', 'payMethod'], { values: () => methodNames(true), help: 'فارغ = رصيد افتتاحي (أصل موجود مسبقاً)', example: 'رصيد افتتاحي' }),
      col('supplier', 'المورد', ['supplier'], { help: 'إلزامي مع «آجل»' }), col('startMonth', 'بداية الإهلاك', ['شهر بداية الإهلاك', 'startMonth'], { type: 'date', help: 'فارغ = شهر الشراء (يُهلك كل الشهور من وقتها). لأصل قديم ضع الشهر الحالي' }),
      col('serial', 'الرقم التسلسلي', ['السيريال', 'serial'], { latin: true }), col('location', 'المكان', ['الموقع', 'location']), col('notes', 'ملاحظات', ['notes']),
    ],
    validate(row) {
      const errors = [], warnings = []; const def = this;
      noNeg(def, row, ['salvage', 'lifeYears'], errors); if (row.cost !== null && row.cost <= 0) errors.push('التكلفة يجب أن تكون أكبر من صفر');
      if (row.salvage !== null && row.cost !== null && row.salvage >= row.cost) errors.push('قيمة الخردة يجب أن تكون أقل من التكلفة');
      let life = row.lifeMonths ?? (row.lifeYears !== null ? Math.round(row.lifeYears * 12) : null); if (life === null) { life = 60; warnings.push('بدون عمر إنتاجي — 60 شهراً'); } if (life < 1) errors.push('العمر الإنتاجي غير صالح');
      const pay = blank(row.payMethod) ? 'opening' : methodOf(row.payMethod, { allowOpening: true }); if (!pay) errors.push(`طريقة السداد «${row.payMethod}» غير معروفة — ${methodNames(true)}`);
      const sup = supplierOf(row.supplier); if (!blank(row.supplier) && !sup) errors.push(`المورد «${row.supplier}» غير موجود`); if (pay === 'credit' && !sup) errors.push('الشراء الآجل يحتاج مورداً (رصيد المورد = حساب الموردين)');
      if (row.purchaseDate && row.purchaseDate > u.todayISO()) warnings.push('تاريخ شراء في المستقبل');
      const start = row.startMonth ? row.startMonth.slice(0, 7) : null; if (!start && row.purchaseDate && u.monthKey(row.purchaseDate) < u.monthKey(new Date())) warnings.push('الإهلاك سيُحسب لكل الشهور من تاريخ الشراء عند تشغيله');
      if (errors.length) return { errors, warnings };
      return { action: 'create', label: `${row.name} · ${m(row.cost)} · ${life} شهر`, data: { name: row.name, category: row.category || 'أخرى', purchaseDate: row.purchaseDate || u.todayISO(), cost: row.cost, salvage: row.salvage || 0, lifeMonths: life, payMethod: pay, supplierId: sup ? sup.id : null, startMonth: start || undefined, serial: row.serial || '', location: row.location || '', notes: row.notes || '' }, warnings };
    },
    totals(valid) { return [{ label: 'أصول', value: valid.length }, { label: 'إجمالي التكلفة', value: r2(u.sum(valid, i => i.data.cost)), money: true }]; },
    apply(items) { items.forEach(it => ERP.assets.create(it.data)); return { summary: `${items.length} أصل` }; },
  });

  /* =================================================================== price update */
  const roundChoices = () => [{ value: '0', label: 'بدون تقريب' }, { value: '0.25', label: 'لأقرب ربع جنيه' }, { value: '0.5', label: 'لأقرب نصف جنيه' }, { value: '1', label: 'لأقرب جنيه' }];
  T.register({
    id: 'priceUpdate', label: 'تحديث الأسعار', icon: 'tags', group: 'مخزون وأسعار', perm: 'products.manage', sheetName: 'الأسعار',
    desc: 'تغيير أسعار البيع بالسعر الجديد أو نسبة أو مبلغ، لصنف أو لوحدة (كرتونة…). بتاريخ بدء مستقبلي يُجدول التغيير، وبتاريخ انتهاء يصبح عرضاً مؤقتاً. كل تغيير يضيف ملصق رف.',
    modes: ['update'], matchBy: [{ key: 'code', label: 'الكود أو الباركود' }], unique: [],
    options: [{ key: 'round', label: 'التقريب', type: 'select', choices: roundChoices, default: () => '0' }],
    columns: [
      col('code', 'الكود أو الباركود', ['الكود', 'الباركود', 'code', 'barcode'], { required: true, latin: true, example: 'PRD-00001' }), col('refName', 'اسم الصنف', ['الاسم'], { help: 'للمراجعة فقط' }),
      col('unit', 'الوحدة', ['unit'], { help: 'فارغ = الوحدة الأساسية (أو وحدة الباركود)', example: '' }),
      col('newPrice', 'السعر الجديد', ['السعر', 'newPrice', 'price'], { type: 'number', example: 36 }), col('percent', 'نسبة التغيير %', ['النسبة', 'نسبة الزيادة', 'percent'], { type: 'number', help: '10 = زيادة 10%، -5 = تخفيض 5%' }),
      col('amount', 'مبلغ التغيير', ['قيمة الزيادة', 'amount'], { type: 'number', help: '2 = زيادة جنيهين، -1 = تخفيض جنيه' }),
      col('startDate', 'تاريخ البدء', ['يبدأ من', 'startDate'], { type: 'date', help: 'فارغ/اليوم = فوراً، مستقبلي = مجدول' }), col('endDate', 'تاريخ الانتهاء', ['ينتهي في', 'endDate'], { type: 'date', help: 'اختياري: عرض مؤقت يرجع بعده السعر القديم' }), col('note', 'ملاحظة', ['السبب', 'note']),
    ],
    examples: () => [{ code: 'PRD-00001', refName: 'أرز مصري 1 كجم', newPrice: 36 }, { code: '6221031490022', refName: 'سكر 1 كجم', percent: 10 }, { code: 'PRD-00003', refName: 'زيت', amount: -2, startDate: u.toISODate(u.addDays(new Date(), 7)), endDate: u.toISODate(u.addDays(new Date(), 14)), note: 'عرض الأسبوع' }],
    prepare() { return { idx: productIndex() }; },
    validate(row, ctx) {
      const hit = ctx.cache.idx.find(row.code); if (!hit) return { errors: [`لا يوجد صنف بالكود/الباركود ${row.code}`] };
      const p = hit.p; const un = unitOf(p, row.unit, hit.unit); if (un.error) return { errors: [un.error], label: p.name };
      const label0 = `${p.name}${un.name ? ` (${un.name})` : ''}`;
      const k = `${p.id}|${un.unitId || ''}`; const seen = ctx.state.seen || (ctx.state.seen = new Map()); if (seen.has(k)) return { errors: [`الصنف مكرر في الملف (السطر ${seen.get(k)})`], label: label0 };
      const given = ['newPrice', 'percent', 'amount'].filter(x => row[x] !== null); if (given.length !== 1) return { errors: ['اكتب قيمة واحدة فقط: السعر الجديد أو نسبة التغيير أو مبلغ التغيير'], label: label0 };
      if (row.newPrice !== null && row.newPrice < 0) return { errors: ['سعر سالب'], label: label0 };
      if (row.percent !== null && row.percent <= -100) return { errors: ['نسبة التخفيض لا تصل 100%'], label: label0 };
      const old = ERP.units.price(p, un.unitId); const mode = given[0] === 'newPrice' ? 'price' : given[0] === 'percent' ? 'pct' : 'fixed';
      const np = ERP.priceChanges.newPriceFor(old, { mode, value: row[given[0]], round: u.num(ctx.options.round) });
      const today = u.todayISO(); const future = row.startDate && row.startDate > today;
      if (row.endDate && row.endDate <= (row.startDate || today)) return { errors: ['تاريخ الانتهاء يجب أن يكون بعد تاريخ البدء'], label: label0 };
      if (Math.abs(np - old) < 0.005) return { action: 'skip', label: label0, warnings: ['السعر لم يتغير'] };
      seen.set(k, row._row);
      const warnings = []; const cost = ERP.units.cost(p, un.unitId); if (np < cost) warnings.push(`السعر الجديد ${m(np)} أقل من التكلفة ${m(cost)}`); if (np === 0) warnings.push('السعر الجديد صفر');
      if (ERP.priceChanges.forProduct(p.id).some(x => x.status === 'scheduled' && (x.unitId || null) === un.unitId)) warnings.push('يوجد تغيير سعر مجدول سابق لنفس الصنف');
      return { action: 'update', label: `${label0}: ${m(old)} ← ${m(np)}${future ? ` (من ${u.fmtDate(row.startDate)})` : ''}${row.endDate ? ` حتى ${u.fmtDate(row.endDate)}` : ''}`, data: { productId: p.id, unitId: un.unitId, old, price: np, startAt: future ? new Date(row.startDate + 'T00:00:00').toISOString() : null, endAt: row.endDate ? new Date(row.endDate + 'T23:59:59').toISOString() : null, note: row.note || '' }, warnings };
    },
    totals(valid) { const sch = valid.filter(i => i.data.startAt).length; const pct = valid.filter(i => i.data.old > 0).map(i => ((i.data.price - i.data.old) / i.data.old) * 100); return [{ label: 'تغيير فوري', value: valid.length - sch }, { label: 'مجدول', value: sch }, { label: 'متوسط التغيير %', value: pct.length ? u.round(u.sum(pct) / pct.length, 1) : 0 }]; },
    apply(items, ctx) {
      const reason = `استيراد ${ctx.batch.no}`; let now = 0, sch = 0;
      items.forEach(it => {
        const d = it.data;
        if (d.startAt || d.endAt) { const x = ERP.priceChanges.schedule({ productId: d.productId, unitId: d.unitId, newPrice: d.price, startAt: d.startAt || u.now(), endAt: d.endAt, note: d.note || reason, silent: true }); if (d.startAt) sch++; else { ERP.priceChanges._apply(x); now++; } } // due offer: applied at once (only this batch's changes)
        else { ERP.units.setPrice(d.productId, d.unitId, d.price, { reason: d.note || reason, silent: true, audit: false }); now++; }
      });
      return { summary: `${now} سعر فوري، ${sch} مجدول` };
    },
  });

  /* =================================================================== purchase order from a file */
  T.register({
    id: 'purchaseFromFile', label: 'أمر شراء من ملف', icon: 'file-invoice', group: 'مشتريات', perm: 'purchases.manage', sheetName: 'الأصناف',
    desc: 'ينشئ أمر شراء واحد (حالة «مطلوب» — لم يُستلم) من فاتورة المورد. راجعه واستلمه من شاشة المشتريات كالمعتاد — المخزون والحسابات تتحرك عند الاستلام.',
    modes: ['create'], unique: [],
    options: [
      { key: 'supplierId', label: 'المورد', type: 'select', required: true, choices: () => ERP.purchasing.suppliers().filter(s => s.active !== false).map(s => ({ value: s.id, label: s.name })) },
      { key: 'warehouseId', label: 'مخزن الاستلام', type: 'select', choices: whChoices, default: () => ERP.inventory.defaultWh() },
      { key: 'date', label: 'تاريخ الأمر', type: 'date', default: () => u.todayISO() }, { key: 'refNo', label: 'رقم فاتورة المورد', type: 'text' }, { key: 'notes', label: 'ملاحظات', type: 'text' },
    ],
    checkOptions(ctx) { const o = ctx.options, e = []; if (!o.supplierId || !ERP.purchasing.supplier(o.supplierId)) e.push('اختر المورد'); if (!C('warehouses').get(o.warehouseId)) e.push('اختر مخزن الاستلام'); return e; },
    columns: [col('code', 'الكود أو الباركود', ['الكود', 'الباركود', 'code', 'barcode'], { required: true, latin: true, example: 'PRD-00001' }), col('refName', 'اسم الصنف', ['الاسم', 'الصنف'], { help: 'للمراجعة فقط' }), col('qty', 'الكمية', ['العدد', 'qty'], { type: 'number', required: true, example: 10 }), col('unit', 'الوحدة', ['unit'], { help: 'فارغ = الوحدة الأساسية (أو وحدة الباركود)', example: 'كرتونة' }), col('cost', 'سعر الشراء', ['التكلفة', 'السعر', 'cost'], { type: 'number', help: 'للوحدة المختارة. فارغ = التكلفة الحالية', example: 280 }), col('newPrice', 'سعر البيع الجديد', ['سعر البيع', 'newPrice'], { type: 'number', help: 'اختياري — يُطبق عند الاستلام' })],
    prepare() { return { idx: productIndex() }; },
    validate(row, ctx) {
      const hit = ctx.cache.idx.find(row.code); if (!hit) return { errors: [`لا يوجد صنف بالكود/الباركود ${row.code}`] };
      const p = hit.p, un = unitOf(p, row.unit, hit.unit); if (un.error) return { errors: [un.error], label: p.name };
      const label0 = `${p.name}${un.name ? ` (${un.name})` : ''}`; const k = `${p.id}|${un.unitId || ''}`; const seen = ctx.state.seen || (ctx.state.seen = new Map());
      if (seen.has(k)) return { errors: [`الصنف مكرر في الملف (السطر ${seen.get(k)}) — اجمع الكميات في سطر واحد`], label: label0 };
      const errors = [], warnings = []; if (!(row.qty > 0)) errors.push('الكمية يجب أن تكون أكبر من صفر'); noNeg(this, row, ['cost', 'newPrice'], errors);
      const cost = row.cost ?? u.round(ERP.units.cost(p, un.unitId), 4); if (row.cost === null) warnings.push(`بدون سعر شراء — استُخدمت التكلفة الحالية ${m(cost)}`); if (!cost) warnings.push('سعر شراء صفر');
      if (row.newPrice !== null && row.newPrice < cost) warnings.push(`سعر البيع الجديد أقل من سعر الشراء ${m(cost)}`);
      if (errors.length) return { errors, warnings, label: label0 };
      seen.set(k, row._row);
      return { action: 'create', label: `${label0}: ${q(row.qty)} × ${m(cost)} = ${m(row.qty * cost)}`, data: { productId: p.id, name: p.name, qty: row.qty, cost, unitId: un.unitId, factor: un.factor, unitName: un.name, newPrice: row.newPrice || null }, warnings };
    },
    totals(valid) { return [{ label: 'أسطر', value: valid.length }, { label: 'إجمالي الكميات', value: u.sum(valid, i => i.data.qty), qty: true }, { label: 'إجمالي الأمر', value: r2(u.sum(valid, i => i.data.qty * i.data.cost)), money: true }]; },
    apply(items, ctx) {
      const o = ctx.options;
      const po = ERP.purchasing.create({ supplierId: o.supplierId, warehouseId: o.warehouseId, date: o.date ? dayISO(o.date) : null, refNo: o.refNo || '', notes: o.notes || `من ملف Excel — ${ctx.batch.no}`, status: 'ordered', items: items.map(it => { const d = it.data; return { productId: d.productId, name: d.name, qty: d.qty, cost: d.cost, newPrice: d.newPrice, ...(d.unitId ? { unitId: d.unitId, factor: d.factor, unitName: d.unitName } : {}) }; }) });
      return { summary: `أمر شراء ${po.no} — ${m(po.total)}`, extra: { poId: po.id, poNo: po.no } };
    },
  });

  /* =================================================================== expenses */
  T.register({
    id: 'expenses', label: 'المصروفات', icon: 'wallet', group: 'حسابات ومصروفات', perm: 'expenses.manage', sheetName: 'المصروفات',
    desc: 'تسجيل مصروفات سابقة (إيجار، كهرباء، نقل…) بقيدها في الحسابات. الدفع الآجل يُسجل على مورد. لا تؤثر على نقدية الوردية الحالية.',
    modes: ['create'], unique: [],
    options: [{ key: 'createCats', label: 'إنشاء الفئات غير الموجودة تلقائياً', type: 'bool', default: () => true }],
    columns: [
      col('date', 'التاريخ', ['date'], { type: 'date', help: 'فارغ = اليوم', example: '01/09/2026' }), col('category', 'الفئة', ['فئة المصروف', 'نوع المصروف', 'category'], { values: () => C('expenseCategories').all().map(x => x.name).join('، '), example: 'إيجار' }),
      col('amount', 'المبلغ', ['القيمة', 'amount'], { type: 'number', required: true, example: 8000 }), col('method', 'طريقة الدفع', ['الدفع', 'method'], { values: () => methodNames(), help: 'فارغ = نقدي', example: 'نقدي' }),
      col('title', 'البيان', ['الوصف', 'البند', 'title', 'description'], { example: 'إيجار شهر 9' }), col('supplier', 'المورد / الجهة', ['المورد', 'الجهة', 'supplier'], { help: 'إلزامي مع «آجل»' }),
      col('refNo', 'رقم المرجع', ['رقم الفاتورة', 'refNo'], { latin: true }), col('notes', 'ملاحظات', ['notes']),
    ],
    refSheets: () => [refSheet('فئات المصروفات (مرجع)', C('expenseCategories').all().map(x => ({ 'الفئة': x.name, 'كود الحساب': x.accountCode || '' })))],
    prepare() { return { cats: new Map(C('expenseCategories').all().map(x => [norm(x.name), x])), newCats: new Map() }; },
    validate(row, ctx) {
      const c = ctx.cache, errors = [], warnings = [];
      if (!(row.amount > 0)) errors.push('المبلغ يجب أن يكون أكبر من صفر');
      let categoryId = null, catName = ''; if (!blank(row.category)) { const k = norm(row.category), cat = c.cats.get(k); if (cat) { categoryId = cat.id; catName = cat.name; } else if (ctx.options.createCats) { categoryId = 'new:' + k; catName = String(row.category).trim(); if (!c.newCats.has(k)) { c.newCats.set(k, catName); warnings.push(`فئة جديدة ستُنشأ: «${catName}»`); } } else errors.push(`الفئة «${row.category}» غير موجودة — المتاح: ${[...c.cats.values()].map(x => x.name).join('، ')}`); } else warnings.push('بدون فئة — حساب مصروفات متنوعة');
      const method = blank(row.method) ? 'cash' : methodOf(row.method); if (!method) errors.push(`طريقة الدفع «${row.method}» غير معروفة — ${methodNames()}`);
      const sup = supplierOf(row.supplier); if (!blank(row.supplier) && !sup) errors.push(`المورد «${row.supplier}» غير موجود`); if (method === 'credit' && !sup) errors.push('المصروف الآجل يحتاج مورداً (رصيد المورد = حساب الموردين)');
      if (row.date && row.date > u.todayISO()) warnings.push('تاريخ في المستقبل');
      if (errors.length) return { errors, warnings };
      const title = row.title || catName || 'مصروف';
      return { action: 'create', label: `${u.fmtDate(row.date || u.todayISO())} · ${title} · ${m(row.amount)} (${method === 'credit' ? 'آجل' : ERP.sales.methodName(method)})`, data: { title, categoryId, categoryName: catName, amount: r2(row.amount), method, date: row.date, supplierId: sup ? sup.id : null, refNo: row.refNo || '', notes: row.notes || '' }, warnings };
    },
    totals(valid) { return [{ label: 'مصروفات', value: valid.length }, { label: 'الإجمالي', value: r2(u.sum(valid, i => i.data.amount)), money: true }]; },
    apply(items, ctx) {
      const EC = C('expenseCategories'), X = C('expenses'); const made = {}; const misc = ERP.accounting.accounts().find(a => a.code === '5290');
      const catOf = k => { if (!k || !k.startsWith('new:')) return k; const n = k.slice(4); if (!made[n]) { const ex = EC.all().find(x => norm(x.name) === n); made[n] = ex ? ex.id : EC.insert({ name: ctx.cache.newCats.get(n) || n, accountCode: misc ? misc.code : '', icon: 'tag' }, { silent: true }).id; } return made[n]; };
      const me = ERP.auth.current();
      items.forEach(it => {
        const d = it.data; const ins = X.insert({ ...d, categoryId: catOf(d.categoryId) || null, date: dayISO(d.date), recurring: false, no: ERP.db.nextSeq('expense', ERP.settings.prefix('expense')), userId: me ? me.id : null, shiftId: null, importBatch: ctx.batch.no }, { silent: true });
        ERP.accounting.postExpense(ins);
        if (ins.method === 'credit' && ins.supplierId) ERP.purchasing.adjustSupplierBalance(ins.supplierId, ins.amount);
      });
      return { summary: `${items.length} مصروف — ${m(u.sum(items, i => i.data.amount))}` };
    },
  });

  /* =================================================================== journal entries */
  const LOCK = { ar: 'حساب العملاء يتحرك من الفواتير والتحصيل — للأرصدة استخدم «العملاء» أو «الأرصدة الافتتاحية»', ap: 'حساب الموردين يتحرك من المشتريات والسداد — استخدم «الموردين» أو «الأرصدة الافتتاحية»', inventory: 'حساب المخزون = تقييم الأصناف — استخدم «المنتجات» (كمية افتتاحية) أو «تسوية المخزون»' };
  T.register({
    id: 'journalEntries', label: 'قيود اليومية', icon: 'book', group: 'حسابات ومصروفات', perm: 'accounting.manage', sheetName: 'القيود',
    desc: 'قيود يومية يدوية متعددة: الأسطر ذات نفس «رقم القيد» تكوّن قيداً واحداً يجب أن يتوازن. حسابات العملاء والموردين والمخزون مرفوضة هنا حتى تبقى أرصدتها مطابقة.',
    modes: ['create'], unique: [], groupKey: r => (blank(r.entryNo) ? null : norm(r.entryNo)),
    rowLabel: r => `قيد ${r.entryNo ?? '?'} · ${r.account ?? ''}`,
    columns: [col('entryNo', 'رقم القيد', ['القيد', 'مسلسل القيد', 'entry'], { required: true, latin: true, help: 'يجمع الأسطر في قيد واحد', example: '1' }), col('date', 'التاريخ', ['date'], { type: 'date', help: 'فارغ = اليوم', example: '01/09/2026' }), col('account', 'كود الحساب', ['الكود', 'رقم الحساب', 'account'], { required: true, latin: true, example: '5210' }), col('accountName', 'اسم الحساب', ['الحساب'], { help: 'للمراجعة فقط' }), col('debit', 'مدين', ['debit'], { type: 'number', example: 3000 }), col('credit', 'دائن', ['credit'], { type: 'number' }), col('desc', 'البيان', ['الوصف', 'description'], { example: 'إيجار مخزن' }), col('memo', 'بيان القيد', ['memo'], { help: 'فارغ = «قيد مستورد»' })],
    examples: () => { const cash = ERP.accounting.bySys('cash'); return [{ entryNo: '1', date: u.toISODate(new Date()), account: '5210', accountName: 'إيجار', debit: 3000, desc: 'إيجار مخزن', memo: 'إيجار شهر' }, { entryNo: '1', date: u.toISODate(new Date()), account: cash.code, accountName: cash.name, credit: 3000, desc: 'صرف نقدي' }]; },
    refSheets: () => [refSheet('شجرة الحسابات (مرجع)', ERP.accounting.tree().map(a => ({ 'الكود': a.code, 'الحساب': '  '.repeat(a.level - 1) + a.name, 'ملاحظة': LOCK[a.sys] ? 'غير مسموح هنا' : a.hasChildren ? 'حساب رئيسي — غير مسموح' : '' })))],
    prepare() { const accs = ERP.accounting.accounts(); return { byCode: new Map(accs.map(a => [String(a.code), a])), byName: new Map(accs.map(a => [norm(a.name), a])), parents: new Set(accs.map(a => a.parentId).filter(Boolean)) }; },
    validate(row, ctx) {
      const c = ctx.cache; const a = c.byCode.get(String(row.account)) || c.byName.get(norm(row.account));
      const label = `قيد ${row.entryNo} · ${a ? `${a.code} ${a.name}` : row.account}`;
      if (!a) return { errors: [`الحساب ${row.account} غير موجود في الشجرة`], label };
      if (LOCK[a.sys]) return { errors: [`«${a.name}» غير مسموح: ${LOCK[a.sys]}`], label };
      if (c.parents.has(a.id)) return { errors: [`«${a.name}» حساب رئيسي — اختر حساباً فرعياً`], label };
      const dr = row.debit || 0, cr = row.credit || 0;
      if (dr < 0 || cr < 0) return { errors: ['لا تُقبل قيم سالبة — ضع المبلغ في العمود الآخر'], label };
      if (dr && cr) return { errors: ['السطر فيه مدين ودائن معاً'], label }; if (!dr && !cr) return { errors: ['السطر بدون مبلغ'], label };
      return { action: 'create', label: `${label} · ${dr ? `مدين ${m(dr)}` : `دائن ${m(cr)}`}`, data: { entryNo: String(row.entryNo), date: row.date, accountId: a.id, debit: r2(dr), credit: r2(cr), desc: row.desc || '', memo: row.memo || '' } };
    },
    finalize(items) { // a group is one entry: all its lines pass or none does
      const groups = new Map(); items.forEach(it => { if (it.group) (groups.get(it.group) || groups.set(it.group, []).get(it.group)).push(it); });
      groups.forEach(list => {
        const no = (list.find(i => i.data) || { data: { entryNo: '?' } }).data.entryNo; const bad = list.find(i => i.errors.length);
        const fail = msg => list.forEach(i => { if (!i.errors.length) i.errors.push(msg); });
        if (bad) return fail(`القيد ${no} فيه سطر خاطئ (السطر ${bad.row}) — لا يُرحّل جزء من قيد`);
        if (list.length < 2) return fail(`القيد ${no} يحتاج سطرين على الأقل`);
        const d = r2(u.sum(list, i => i.data.debit)), c = r2(u.sum(list, i => i.data.credit));
        if (Math.abs(d - c) > 0.011) return fail(`القيد ${no} غير متوازن: مدين ${m(d)} / دائن ${m(c)}`);
        if (u.uniq(list.map(i => i.data.date || '')).length > 1) list[0].warnings.push(`تواريخ مختلفة داخل القيد ${no} — سيُستخدم تاريخ أول سطر`);
      });
    },
    totals(valid) { return [{ label: 'قيود', value: u.uniq(valid.map(i => i.group)).length }, { label: 'أسطر', value: valid.length }, { label: 'إجمالي المدين', value: r2(u.sum(valid, i => i.data.debit)), money: true }]; },
    apply(items, ctx) {
      const groups = new Map(); items.forEach(it => (groups.get(it.group) || groups.set(it.group, []).get(it.group)).push(it.data));
      groups.forEach(list => { const f = list[0]; ERP.accounting.post({ date: dayISO(f.date), memo: list.find(l => l.memo)?.memo || `قيد مستورد ${f.entryNo} — ${ctx.batch.no}`, refType: 'manual', refId: `import:${ctx.batch.id}`, lines: list.map(l => ({ accountId: l.accountId, debit: l.debit, credit: l.credit, desc: l.desc })) }); });
      return { summary: `${groups.size} قيد` };
    },
  });

  /* =================================================================== stock adjustment */
  T.register({
    id: 'stockAdjust', label: 'تسوية المخزون', icon: 'scale-unbalanced', group: 'مخزون وأسعار', perm: 'inventory.adjust', sheetName: 'التسوية',
    desc: 'تعديل أرصدة الأصناف: إما «الكمية الفعلية» (يُضبط الرصيد عليها) أو «الفرق» (+ زيادة / − عجز). الفرق يُرحّل للحسابات (فروق جرد) فيبقى حساب المخزون = التقييم. الكميات بالوحدة الأساسية.',
    modes: ['create'], unique: [],
    columns: [col('code', 'الكود أو الباركود', ['الكود', 'الباركود', 'code', 'barcode'], { required: true, latin: true, example: 'PRD-00001' }), col('refName', 'اسم الصنف', ['الاسم', 'الصنف'], { help: 'للمراجعة فقط' }), col('warehouse', 'المخزن', ['warehouse'], { help: 'فارغ = الافتراضي', values: whNames }), col('counted', 'الكمية الفعلية', ['الكمية المعدودة', 'الجرد', 'الرصيد الفعلي', 'counted'], { type: 'number', example: 48 }), col('diff', 'الفرق', ['فرق الكمية', 'الزيادة/العجز', 'difference'], { type: 'number', help: 'بديل عن الكمية الفعلية: 5 أو -3' }), col('cost', 'التكلفة', ['تكلفة الوحدة', 'cost'], { type: 'number', help: 'للزيادة فقط — فارغ = التكلفة الحالية' }), col('reason', 'السبب', ['ملاحظة', 'reason'], { example: 'جرد آخر الشهر' })],
    prepare() { return { idx: productIndex(), neg: ERP.inventory.canGoNegative() }; },
    validate(row, ctx) {
      const hit = ctx.cache.idx.find(row.code); if (!hit) return { errors: [`لا يوجد صنف بالكود/الباركود ${row.code}`] };
      const p = hit.p, wh = whOf(row.warehouse); if (!wh) return { errors: [`المخزن «${row.warehouse}» غير موجود — المتاح: ${whNames()}`], label: p.name };
      const k = `${p.id}|${wh.id}`, seen = ctx.state.seen || (ctx.state.seen = new Map()); if (seen.has(k)) return { errors: [`الصنف مكرر لنفس المخزن (السطر ${seen.get(k)})`], label: p.name };
      if ((row.counted === null) === (row.diff === null)) return { errors: ['اكتب «الكمية الفعلية» أو «الفرق» (واحد فقط)'], label: p.name };
      if (row.cost !== null && row.cost < 0) return { errors: ['تكلفة سالبة'], label: p.name };
      const cur = ERP.inventory.whQty(p, wh.id), target = u.round(row.counted ?? cur + row.diff, 3), d = u.round(target - cur, 3);
      const label = `${p.name} — ${wh.name}: ${q(cur)} ← ${q(target)} (${d > 0 ? '+' : ''}${q(d)})`;
      if (!d) return { action: 'skip', label, warnings: ['لا فرق'] };
      const warnings = []; if (hit.unit) warnings.push('الكمية بالوحدة الأساسية وليست بوحدة الباركود');
      if (target < 0) { if (!ctx.cache.neg) return { errors: [`الرصيد سيصبح ${q(target)} (سالب) — غير مسموح حسب إعداد المخزون`], label }; warnings.push('الرصيد سيصبح سالباً'); }
      if (d < 0 && row.cost !== null) warnings.push('التكلفة تُستخدم للزيادة فقط — العجز بالتكلفة الحالية');
      seen.set(k, row._row);
      const unitCost = d > 0 ? u.round(row.cost ?? u.num(p.cost), 4) : null;
      return { action: 'create', label, data: { productId: p.id, warehouseId: wh.id, target, diff: d, unitCost, value: r2(d * (d > 0 ? unitCost : u.num(p.cost))), reason: row.reason || '' }, warnings };
    },
    totals(valid) { const up = valid.filter(i => i.data.diff > 0), dn = valid.filter(i => i.data.diff < 0); return [{ label: 'زيادة', value: r2(u.sum(up, i => i.data.value)), money: true }, { label: 'عجز', value: r2(-u.sum(dn, i => i.data.value)), money: true }, { label: 'صافي أثر المخزون', value: r2(u.sum(valid, i => i.data.value)), money: true }]; },
    apply(items, ctx) { let v = 0; items.forEach(it => { const d = it.data; const mv = ERP.inventory.adjust({ productId: d.productId, warehouseId: d.warehouseId, newQty: d.target, reason: d.reason || `تسوية مستوردة ${ctx.batch.no}`, unitCost: d.unitCost }); v += mv ? u.num(mv.value) : 0; }); return { summary: `${items.length} صنف — صافي ${m(v)}` }; },
  });

  /* =================================================================== stock transfer */
  T.register({
    id: 'stockTransfer', label: 'تحويل مخزني', icon: 'right-left', group: 'مخزون وأسعار', perm: 'inventory.transfer', sheetName: 'التحويل',
    desc: 'ينشئ تحويلاً واحداً بين مخزنين لكل أصناف الملف (كله أو لا شيء). الكميات بالوحدة الأساسية — باركود الكرتونة يُضرب في معاملها.',
    modes: ['create'], unique: [],
    options: [{ key: 'fromWh', label: 'من مخزن', type: 'select', choices: whChoices, default: () => ERP.inventory.defaultWh() }, { key: 'toWh', label: 'إلى مخزن', type: 'select', choices: whChoices, default: () => (warehouses().find(w => w.id !== ERP.inventory.defaultWh()) || {}).id || '' }, { key: 'note', label: 'ملاحظات', type: 'text' }],
    checkOptions(ctx) { const o = ctx.options, e = []; if (!C('warehouses').get(o.fromWh) || !C('warehouses').get(o.toWh)) e.push('اختر المخزن المصدر والوجهة'); else if (o.fromWh === o.toWh) e.push('المخزن المصدر والوجهة متطابقان'); return e; },
    columns: [col('code', 'الكود أو الباركود', ['الكود', 'الباركود', 'code', 'barcode'], { required: true, latin: true, example: 'PRD-00001' }), col('refName', 'اسم الصنف', ['الاسم', 'الصنف'], { help: 'للمراجعة فقط' }), col('qty', 'الكمية', ['العدد', 'qty'], { type: 'number', required: true, example: 12 })],
    prepare() { return { idx: productIndex(), neg: ERP.inventory.canGoNegative() }; },
    validate(row, ctx) {
      const hit = ctx.cache.idx.find(row.code); if (!hit) return { errors: [`لا يوجد صنف بالكود/الباركود ${row.code}`] };
      const p = hit.p, seen = ctx.state.seen || (ctx.state.seen = new Map()); if (seen.has(p.id)) return { errors: [`الصنف مكرر في الملف (السطر ${seen.get(p.id)})`], label: p.name };
      if (!(row.qty > 0)) return { errors: ['الكمية يجب أن تكون أكبر من صفر'], label: p.name };
      const f = hit.unit ? u.num(hit.unit.factor, 1) : 1, qty = u.round(row.qty * f, 3); const avail = ERP.inventory.whQty(p, ctx.options.fromWh);
      if (!ctx.cache.neg && qty > avail + 0.0001) return { errors: [`الكمية ${q(qty)} أكبر من المتاح في المخزن المصدر (${q(avail)})`], label: p.name };
      seen.set(p.id, row._row);
      return { action: 'create', label: `${p.name}: ${q(qty)}${f > 1 ? ` (${q(row.qty)} × ${q(f)})` : ''}`, data: { productId: p.id, name: p.name, qty }, warnings: qty > avail ? ['الرصيد في المصدر سيصبح سالباً'] : [] };
    },
    totals(valid) { return [{ label: 'أصناف', value: valid.length }, { label: 'إجمالي الكميات', value: u.sum(valid, i => i.data.qty), qty: true }]; },
    apply(items, ctx) { const o = ctx.options; const t = ERP.inventory.transfer({ fromWh: o.fromWh, toWh: o.toWh, lines: items.map(i => i.data), note: o.note || `من ملف Excel — ${ctx.batch.no}` }); return { summary: `تحويل ${t.no}`, extra: { transferId: t.id, transferNo: t.no } }; },
  });

  /* =================================================================== opening balances (wraps ERP.openingImport) */
  T.register({
    id: 'opening', label: 'الأرصدة الافتتاحية', icon: 'scale-balanced', group: 'حسابات ومصروفات', perm: 'accounting.manage', multiSheet: true, modes: ['create'],
    desc: 'ملف واحد بأربع صفحات: القيود الافتتاحية (خزينة، بنك، رأس مال…)، العملاء، الموردين، المخزون. أي فرق يروح لحساب «الأرصدة الافتتاحية». يُرفض الملف كله لو فيه خطأ.',
    options: [{ key: 'date', label: 'تاريخ الافتتاح', type: 'date', default: () => u.todayISO() }],
    columns: [],
    template({ download = true } = {}) { if (download) ERP.openingImport.template(); return null; },
    parseWorkbook(wb) {
      const pv = ERP.openingImport.parseWorkbook(wb), S = ERP.openingImport.SHEETS; const items = [];
      pv.gl.forEach(l => items.push({ sheet: S.gl, action: 'create', label: `${l.code} ${l.name}: ${l.debit ? `مدين ${m(l.debit)}` : `دائن ${m(l.credit)}`}` }));
      pv.customers.forEach(x => items.push({ sheet: S.cust, action: x.existingId ? 'update' : 'create', label: `عميل ${x.name}: ${m(x.balance)}` }));
      pv.suppliers.forEach(x => items.push({ sheet: S.supp, action: x.existingId ? 'update' : 'create', label: `مورد ${x.name}: ${m(x.balance)}` }));
      pv.stock.forEach(x => items.push({ sheet: S.stock, action: 'update', label: `${x.name}: ${q(x.qty)} × ${m(x.cost)} = ${m(x.value)}` }));
      const t = pv.totals;
      return { items, fileErrors: pv.errors, fileWarnings: pv.warnings, payload: pv, totals: [{ label: 'قيود عامة مدين', value: t.glDr, money: true }, { label: 'قيود عامة دائن', value: t.glCr, money: true }, { label: 'العملاء', value: t.ar, money: true }, { label: 'الموردين', value: t.ap, money: true }, { label: 'المخزون', value: t.inv, money: true }, { label: `صافي الأرصدة الافتتاحية (${t.openingNet >= 0 ? 'دائن' : 'مدين'})`, value: Math.abs(t.openingNet), money: true }] };
    },
    apply(items, ctx) { const r = ERP.openingImport.apply(ctx.payload, { date: ctx.options.date }); return { summary: `${r.gl} سطر قيود، ${r.customers} عميل، ${r.suppliers} مورد، ${r.stock} صنف`, extra: { ref: r.batch } }; },
  });
})();
