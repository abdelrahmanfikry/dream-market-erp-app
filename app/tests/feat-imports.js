/* ==========================================================================
   Feature tests — مركز الاستيراد (ERP.importCenter + every import type):
   parsing, validation, all-or-nothing / valid-rows-only, GL invariants,
   mid-way rollback, undo (allowed / refused)
   (runs inside ERP.tests.run — data snapshotted/restored around it)
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  ERP.testSuites = ERP.testSuites || [];
  ERP.testSuites.push((t, h) => {
    const { u, near } = h; const IC = ERP.importCenter; const A = ERP.accounting; const P = ERP.db.collection('products'); const ctx = {};
    const book = (rows, name = 'البيانات') => { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, Array.isArray(rows[0]) ? XLSX.utils.aoa_to_sheet(rows) : XLSX.utils.json_to_sheet(rows), name); return wb; };
    const errs = pv => [...pv.fileErrors, ...pv.items.filter(i => i.errors.length).map(i => `${i.row}: ${i.errors.join(', ')}`)].join(' | ');
    const imp = (type, wb, opts = {}) => { const pv = IC.preview(type, wb, opts); if (!pv.ok && !opts.validOnly) throw new Error(errs(pv) || 'لا أسطر'); return { pv, b: IC.apply(pv, { validOnly: !!opts.validOnly, fileName: 'test.xlsx' }) }; };
    const inv = () => ({ g: A.balance('inventory'), v: ERP.inventory.valuation().totalValue });
    const invOk = (s0, label = '') => { const s1 = inv(); const dG = s1.g - s0.g, dV = s1.v - s0.v; if (!near(dG, dV, 0.05)) throw new Error(`${label} GL Δ ${u.round(dG)} ≠ تقييم Δ ${u.round(dV)}`); return u.round(dG); };
    const tbOk = () => { const tb = A.trialBalance(); if (!near(tb.totalDebit, tb.totalCredit)) throw new Error(`TB ${tb.totalDebit} ≠ ${tb.totalCredit}`); };
    const throws = fn => { try { fn(); return false; } catch (e) { return true; } };
    const mkP = (code, extra = {}) => P.insert({ code, name: 'صنف ' + code, categoryId: 'cat_other', unitId: 'un_pc', cost: 10, price: 20, stock: 0, stockByWh: {}, batches: [], minStock: 0, taxRate: 0, active: true, ...extra });
    const give = (p, qty, cost = 10, wh = ERP.inventory.defaultWh()) => { ERP.inventory.move({ productId: p.id, warehouseId: wh, qty, type: 'opening', unitCost: cost, refType: 'opening', note: 'test' }); A.postOpeningStock(u.round(qty * cost)); return P.get(p.id); };

    t('الاستيراد: أسماء بديلة للأعمدة + أرقام عربية وفواصل + تواريخ + أسطر فارغة + أعمدة غير معروفة', () => {
      const pr = IC.parse('products', book([['اسم الصنف', 'سعر البيع', 'الكمية', 'نشط', 'عمود غريب'], ['صنف أ', '١٬٢٥٠٫٥', '٣', 'نعم', 'x'], [], ['صنف ب', '1,000', '', 'لا', '']]));
      if (pr.rows.length !== 2 || pr.rows[0]._row !== 2 || pr.rows[1]._row !== 4) throw new Error(`rows ${pr.rows.map(r => r._row)}`);
      const [a, b] = pr.rows;
      if (a.name !== 'صنف أ' || a.price !== 1250.5 || a.openingQty !== 3 || a.active !== true || b.price !== 1000 || b.active !== false || b.openingQty !== null) throw new Error(JSON.stringify([a.price, a.openingQty, b.price, b.active]));
      if (!pr.fileWarnings.some(w => w.includes('عمود غريب'))) throw new Error('unknown column warning');
      const D = { type: 'date', label: 'ت' };
      const ds = [IC.coerce(D, '٢٥/١٢/٢٠٢٥').value, IC.coerce(D, 45000).value, IC.coerce(D, '2026-03-01').value, IC.coerce(D, '5-1-26').value, IC.coerce(D, '31/02/2026').error ? 'bad' : 'ok'];
      if (ds.join('|') !== '2025-12-25|2023-03-15|2026-03-01|2026-01-05|bad') throw new Error(ds.join('|'));
      if (IC.coerce({ type: 'number', label: 'n' }, '۱۲۳').value !== 123 || IC.coerce({ type: 'number', label: 'n' }, 'abc').error === undefined) throw new Error('number');
      if (IC.coerce({ phone: true, label: 'h' }, 1001234567).value !== '01001234567' || IC.coerce({ phone: true, label: 'h' }, '+20 100 123 4567').value !== '01001234567') throw new Error('phone');
      if (IC.coerce({ type: 'list', latin: true, label: 'l' }, '١١١، 222 ,333').value.join('|') !== '111|222|333') throw new Error('list');
      return 'أسماء بديلة · ١٬٢٥٠٫٥ → 1250.5 · تواريخ يوم/شهر/سنة ورقم Excel · سطر فارغ متجاهل';
    });

    t('الاستيراد: كل الأنواع تنتج نموذج Excel (بيانات + تعليمات)', () => {
      const out = ERP.importTypes.all().filter(d => !d.multiSheet).map(d => { const wb = IC.template(d.id, { download: false }); if (!wb.SheetNames.includes('تعليمات') || wb.SheetNames.length < 2) throw new Error(`${d.id}: ${wb.SheetNames}`); const pr = IC.parse(d.id, wb); if (pr.fileErrors.length || pr.fileWarnings.length || !pr.rows.length) throw new Error(`${d.id}: ${pr.fileErrors.concat(pr.fileWarnings).join(' | ')}`); return d.id; });
      return `${out.length} نموذج — الأعمدة تُقرأ بلا تحذيرات`;
    });

    t('استيراد المنتجات: إضافة (وحدات + باركودات + كمية افتتاحية) وتحديث سعر (ملصق رف) — الحسابات = التقييم', () => {
      ctx.ex = mkP('IMPT-EX1', { price: 20, barcode: '6990000000011' });
      ctx.s0 = inv(); ctx.p0 = P.count();
      const { pv, b } = imp('products', book([
        { 'الكود': 'IMPT-EX1', 'السعر': 25, 'وحدة 1': 'كرتونة', 'معامل وحدة 1': 12, 'سعر وحدة 1': 280, 'باركود وحدة 1': '6990000000028', 'الكمية الافتتاحية': 99 },
        { 'الكود': 'IMPT-N1', 'الاسم': 'صنف مستورد جديد', 'الباركود': '6990000000035', 'الفئة': 'فئة استيراد اختبار', 'التكلفة': 8, 'السعر': 12, 'باركودات إضافية': '6990000000042, 6990000000059', 'وحدة 1': 'علبة', 'معامل وحدة 1': 6, 'الكمية الافتتاحية': 10 },
      ], 'المنتجات'), { mode: 'upsert', matchBy: 'code' });
      if (pv.counts.create !== 1 || pv.counts.update !== 1) throw new Error(JSON.stringify(pv.counts));
      if (!pv.items[0].warnings.some(w => w.includes('تسوية المخزون'))) throw new Error('qty on existing product not warned');
      const e1 = P.get(ctx.ex.id); const un = ERP.units.list(e1);
      if (e1.price !== 25 || e1.stock !== 0 || un.length !== 1 || un[0].factor !== 12 || un[0].price !== 280) throw new Error('existing product update');
      const n1 = P.first({ code: 'IMPT-N1' });
      if (!n1 || n1.stock !== 10 || n1.cost !== 8 || n1.barcodes.length !== 2 || ERP.units.list(n1)[0].factor !== 6 || (ERP.db.collection('categories').get(n1.categoryId) || {}).name !== 'فئة استيراد اختبار') throw new Error('new product');
      const lab = ERP.db.collection('labelQueue').all().find(l => l.productId === ctx.ex.id && !l.unitId && !l.printed);
      if (!lab || lab.newPrice !== 25 || lab.oldPrice !== 20) throw new Error('price change did not queue a shelf label');
      if (!ERP.inventory.findByBarcode('6990000000028') || ERP.inventory.findByBarcode('6990000000059').id !== n1.id) throw new Error('barcodes');
      const d = invOk(ctx.s0, 'products'); if (!near(d, 80)) throw new Error(`GL Δ ${d}`);
      tbOk(); ctx.prodBatch = b;
      if (!/^IMP-\d{6}$/.test(b.no) || !b.journal.length || !b.moves.length || !b.updated.some(x => x.col === 'products' && x.before.price === 20)) throw new Error('batch log');
      return `${b.no}: 1 جديد + 1 تحديث · مخزون +80 = التقييم · ملصق 20 → 25`;
    });

    t('التراجع عن استيراد المنتجات: يرجع السعر ويحذف الجديد ويعكس المخزون', () => {
      const b = ctx.prodBatch; const chk = IC.undoCheck(b.id); if (!chk.ok) throw new Error(chk.reasons.join(' | '));
      IC.undo(b.id);
      const e1 = P.get(ctx.ex.id); if (e1.price !== 20 || ERP.units.list(e1).length) throw new Error('existing product not restored');
      if (P.first({ code: 'IMPT-N1' }) || P.count() !== ctx.p0) throw new Error('created product not removed');
      if (ERP.db.collection('categories').all().some(c => c.name === 'فئة استيراد اختبار')) throw new Error('created category not removed');
      if (ERP.db.collection('labelQueue').all().some(l => l.productId === ctx.ex.id && !l.printed && l.newPrice === 25)) throw new Error('label not removed');
      const s1 = inv(); if (!near(s1.g, ctx.s0.g) || !near(s1.v, ctx.s0.v)) throw new Error(`GL ${s1.g - ctx.s0.g} / val ${s1.v - ctx.s0.v}`);
      tbOk();
      if (IC.batch(b.id).status !== 'undone' || IC.undoCheck(b.id).ok) throw new Error('batch status');
      return 'السعر 25 → 20 · حُذف الصنف الجديد وفئته · المخزون والحسابات كما كانت';
    });

    t('استيراد المنتجات: باركود مكرر في الملف أو مستخدم مسبقاً مرفوض — والأسطر السليمة فقط', () => {
      mkP('IMPT-EX2', { barcode: '6990000000066' });
      const pv = IC.preview('products', book([
        { 'الكود': 'IMPT-D1', 'الاسم': 'مكرر 1', 'الباركود': '6990000000073', 'السعر': 5 },
        { 'الكود': 'IMPT-D2', 'الاسم': 'مكرر 2', 'الباركود': '6990000000073', 'السعر': 5, 'باركودات إضافية': '' },
        { 'الكود': 'IMPT-D3', 'الاسم': 'مكرر 3', 'الباركود': '6990000000066', 'السعر': 5 },
        { 'الكود': 'IMPT-D4', 'الاسم': 'مكرر 4', 'الباركود': '', 'السعر': 5, 'باركودات إضافية': '6990000000073' },
      ]), {});
      if (pv.ok || pv.counts.error !== 3 || pv.items[0].status !== 'create' || pv.items.slice(1).some(i => i.status !== 'error')) throw new Error(errs(pv));
      if (!pv.items[2].errors.join().includes('IMPT-EX2')) throw new Error('db owner not named');
      const n0 = P.count(); if (!throws(() => IC.apply(pv)) || P.count() !== n0) throw new Error('all-or-nothing violated');
      const ew = IC.errorWorkbook(pv); const rows = XLSX.utils.sheet_to_json(ew.Sheets[ew.SheetNames[0]]);
      if (rows.length !== 3 || !rows.every(r => r[IC.ERR_COL] && r['الكود'])) throw new Error('error workbook');
      const again = IC.parse('products', ew); if (again.fileWarnings.length || again.rows.length !== 3) throw new Error('re-upload of error file');
      const b = IC.apply(pv, { validOnly: true });
      if (P.count() !== n0 + 1 || !P.first({ code: 'IMPT-D1' }) || b.counts.error !== 3 || b.counts.imported !== 1) throw new Error('valid rows only');
      return '3 أسطر مرفوضة · ملف الأخطاء بعمود «الخطأ» · استُورد السليم فقط';
    });

    t('استيراد المنتجات: خطأ أثناء الكتابة → تراجع كامل عمّا كُتب', () => {
      const n0 = P.count(), m0 = ERP.db.collection('stockMoves').count(), j0 = ERP.db.collection('journal').count(), b0 = ERP.db.collection('importBatches').count(), s0 = inv();
      const pv = IC.preview('products', book([{ 'الاسم': 'تراجع 1', 'التكلفة': 5, 'الكمية الافتتاحية': 4 }, { 'الاسم': 'تراجع 2', 'التكلفة': 5, 'الكمية الافتتاحية': 4 }]), { mode: 'create' });
      const real = ERP.inventory.move; let calls = 0;
      ERP.inventory.move = function (...a) { if (++calls === 2) throw new Error('boom'); return real.apply(this, a); };
      let threw = false; try { IC.apply(pv); } catch (e) { threw = e.message === 'boom'; } finally { ERP.inventory.move = real; }
      if (!threw) throw new Error('did not throw');
      if (P.count() !== n0 || ERP.db.collection('stockMoves').count() !== m0 || ERP.db.collection('journal').count() !== j0 || ERP.db.collection('importBatches').count() !== b0) throw new Error('partial writes left behind');
      const s1 = inv(); if (!near(s1.g, s0.g) || !near(s1.v, s0.v)) throw new Error('stock changed');
      return 'لا شيء بقي من الاستيراد الفاشل';
    });

    t('استيراد العملاء: رصيد افتتاحي للجديد (العملاء = الرصيد) + تحديث بالهاتف · والتراجع مرفوض بعد فاتورة بيع', () => {
      const old = ERP.crm.create({ name: 'عميل موجود للاستيراد', phone: '01099887766' });
      const ar0 = A.balance('ar');
      const { b } = imp('customers', book([{ 'الاسم': 'عميل مستورد', 'الموبايل': 1099887700, 'الرصيد الافتتاحي': 500, 'حد الائتمان': 2000, 'المجموعة': 'جملة' }, { 'الاسم': 'عميل موجود للاستيراد', 'الموبايل': '01099887766', 'العنوان': 'عنوان جديد' }], 'العملاء'), { matchBy: 'phone' });
      const nc = ERP.db.collection('customers').all().find(c => c.phone === '01099887700');
      if (!nc || nc.balance !== 500 || nc.openingBalance !== 500 || nc.group !== 'جملة' || nc.creditLimit !== 2000) throw new Error('new customer');
      if (!near(A.balance('ar') - ar0, 500)) throw new Error(`AR Δ ${A.balance('ar') - ar0}`);
      if (ERP.db.collection('customers').get(old.id).address !== 'عنوان جديد') throw new Error('update by phone');
      tbOk();
      if (!IC.undoCheck(b.id).ok) throw new Error('undo should be allowed before activity');
      if (!ERP.shifts.current()) ERP.shifts.open({ openingCash: 0 });
      const p = give(mkP('IMPT-S1'), 5);
      ERP.sales.create({ cart: [{ productId: p.id, name: p.name, qty: 1, price: 20 }], customerId: nc.id, payments: [{ method: 'cash', amount: 20 }] });
      const chk = IC.undoCheck(b.id); if (chk.ok || !chk.reasons.some(r => r.includes('فواتير بيع'))) throw new Error('undo not refused: ' + chk.reasons.join(' | '));
      if (!throws(() => IC.undo(b.id)) || !ERP.db.collection('customers').get(nc.id)) throw new Error('undo ran');
      return `عميل جديد برصيد 500 = الحساب · التراجع مرفوض: ${chk.reasons[0]}`;
    });

    t('استيراد الموردين: رصيد افتتاحي → حساب الموردين', () => {
      const ap0 = A.balance('ap');
      imp('suppliers', book([{ 'الاسم': 'مورد مستورد', 'الهاتف': '01233445566', 'الرقم الضريبي': '100-200-300', 'الرصيد الافتتاحي': 1200 }, { 'الاسم': 'مورد مستورد 2', 'الرصيد الافتتاحي': -100 }], 'الموردين'), { matchBy: 'phone' });
      const s = ERP.db.collection('suppliers').all().find(x => x.name === 'مورد مستورد'), s2 = ERP.db.collection('suppliers').all().find(x => x.name === 'مورد مستورد 2');
      if (!s || s.balance !== 1200 || s.taxNumber !== '100-200-300' || !s2 || s2.balance !== -100) throw new Error('supplier');
      if (!near(A.balance('ap') - ap0, 1100)) throw new Error(`AP Δ ${A.balance('ap') - ap0}`);
      tbOk(); return 'AP +1200 −100 = أرصدة الموردين';
    });

    t('استيراد الموظفين: إضافة ثم تحديث بالرقم القومي', () => {
      imp('employees', book([{ 'الاسم': 'موظف مستورد', 'الرقم القومي': '29001011234567', 'الوظيفة': 'كاشير', 'الراتب': 6000, 'تاريخ التعيين': '01/03/2025', 'بداية الدوام': 0.375, 'نوع الراتب': 'شهري' }]), { matchBy: 'nationalId' });
      const E = ERP.db.collection('employees'); const n = E.count(); const emp = E.first({ nationalId: '29001011234567' });
      if (!emp || emp.hireDate !== '2025-03-01' || emp.shiftStart !== '09:00' || emp.salary !== 6000 || emp.job !== 'كاشير') throw new Error(JSON.stringify(emp));
      const { pv } = imp('employees', book([{ 'الرقم القومي': '29001011234567', 'الراتب': 6500 }]), { matchBy: 'nationalId', mode: 'update' });
      if (pv.counts.update !== 1 || E.count() !== n || E.get(emp.id).salary !== 6500) throw new Error('update');
      return 'تاريخ 01/03/2025 · وقت Excel 0.375 → 09:00 · الراتب 6000 → 6500';
    });

    t('استيراد شجرة الحسابات: الأب بعد الابن في الملف + أب غير موجود مرفوض', () => {
      const pv = IC.preview('chartOfAccounts', book([{ 'كود الحساب': '5978', 'اسم الحساب': 'فرعي اختبار', 'كود الحساب الأب': '5977' }, { 'كود الحساب': '5977', 'اسم الحساب': 'رئيسي اختبار', 'النوع': 'مصروفات', 'كود الحساب الأب': '5000' }, { 'كود الحساب': '5979', 'اسم الحساب': 'يتيم', 'كود الحساب الأب': '9999' }, { 'كود الحساب': '5976', 'اسم الحساب': 'نوع خطأ', 'النوع': 'أصول', 'كود الحساب الأب': '5000' }]), {});
      if (pv.counts.create !== 2 || pv.counts.error !== 2) throw new Error(errs(pv));
      IC.apply(pv, { validOnly: true });
      const acc = c => ERP.accounting.accounts().find(a => a.code === c); const par = acc('5977'), ch = acc('5978');
      if (!par || !ch || ch.parentId !== par.id || ch.type !== 'expense' || par.parentId !== acc('5000').id || acc('5979')) throw new Error('tree');
      return 'الترتيب حسب الأب · النوع موروث · أب مفقود ونوع مخالف مرفوضان';
    });

    t('تحديث الأسعار: نسبة + تقريب ونصف، مبلغ بالباركود، تاريخ مستقبلي → مجدول', () => {
      const p1 = mkP('IMPT-PU1', { price: 23 }), p2 = mkP('IMPT-PU2', { price: 10, barcode: '6990000000080' }), p3 = mkP('IMPT-PU3', { price: 50, cost: 48 });
      const fut = u.addDays(new Date(), 10); const futS = `${String(fut.getDate()).padStart(2, '0')}/${String(fut.getMonth() + 1).padStart(2, '0')}/${fut.getFullYear()}`;
      const { pv } = imp('priceUpdate', book([{ 'الكود': 'IMPT-PU1', 'نسبة التغيير %': 10 }, { 'الكود': '6990000000080', 'مبلغ التغيير': 2 }, { 'الكود': 'IMPT-PU3', 'السعر الجديد': 45, 'تاريخ البدء': futS }]), { options: { round: '0.5' } });
      if (P.get(p1.id).price !== 25.5 || P.get(p2.id).price !== 12 || P.get(p3.id).price !== 50) throw new Error(`prices ${P.get(p1.id).price} ${P.get(p2.id).price} ${P.get(p3.id).price}`);
      if (!pv.items[2].warnings.some(w => w.includes('أقل من التكلفة'))) throw new Error('below-cost warning');
      const sc = ERP.priceChanges.forProduct(p3.id)[0]; if (!sc || sc.status !== 'scheduled' || sc.newPrice !== 45 || u.toISODate(sc.startAt) !== u.toISODate(fut)) throw new Error('scheduled change');
      if (!ERP.db.collection('labelQueue').all().some(l => l.productId === p1.id && l.newPrice === 25.5 && !l.printed)) throw new Error('label');
      return '23 +10% ≈ 25.5 · 10 +2 = 12 · 45 مجدول بعد 10 أيام';
    });

    t('أمر شراء من ملف: أمر «مطلوب» بالإجماليات والوحدة، بدون حركة مخزون', () => {
      const sup = ERP.purchasing.createSupplier({ name: 'مورد أمر مستورد' });
      const p = mkP('IMPT-PO1', { cost: 10, units: [{ id: 'pu_imptpo', unitId: null, name: 'كرتونة', factor: 12, price: 0, barcode: '6990000000097' }] });
      const bad = IC.preview('purchaseFromFile', book([{ 'الكود': 'NOPE-CODE', 'الكمية': 1 }]), {});
      if (!bad.fileErrors.some(x => x.includes('المورد')) || !bad.items[0].errors.join().includes('NOPE-CODE')) throw new Error('validation');
      const ap0 = A.balance('ap'), st0 = P.get(p.id).stock;
      const { b } = imp('purchaseFromFile', book([{ 'الكود': 'IMPT-PO1', 'الكمية': 5, 'سعر الشراء': 9 }, { 'الكود': '6990000000097', 'الكمية': 2, 'سعر الشراء': 100 }]), { options: { supplierId: sup.id, warehouseId: ERP.inventory.defaultWh(), refNo: 'INV-77' } });
      const po = ERP.purchasing.order(b.extra.poId);
      if (!po || po.status !== 'ordered' || !near(po.total, 245) || po.refNo !== 'INV-77' || po.items[1].factor !== 12 || po.items[1].unitId !== 'pu_imptpo') throw new Error(JSON.stringify(po && { s: po.status, t: po.total, it: po.items }));
      if (P.get(p.id).stock !== st0 || !near(A.balance('ap'), ap0)) throw new Error('stock/AP moved before receipt');
      return `${po.no}: 5 قطعة × 9 + 2 كرتونة × 100 = 245 (لم يُستلم)`;
    });

    t('استيراد المصروفات: قيد لكل مصروف + فئة جديدة تلقائياً', () => {
      const cat = ERP.db.collection('expenseCategories').all().find(c => c.accountCode); const acc = ERP.accounting.accounts().find(a => a.code === cat.accountCode);
      const cash0 = A.balance('cash'), e0 = A.balance(acc.id), n0 = ERP.db.collection('expenses').count();
      imp('expenses', book([{ 'التاريخ': '01/09/2026', 'الفئة': cat.name, 'المبلغ': 1000, 'البيان': 'مصروف مستورد' }, { 'الفئة': 'فئة مصروف جديدة اختبار', 'المبلغ': '٢٥٠', 'طريقة الدفع': 'نقدي' }]));
      if (ERP.db.collection('expenses').count() !== n0 + 2 || !ERP.db.collection('expenseCategories').all().some(c => c.name === 'فئة مصروف جديدة اختبار')) throw new Error('docs');
      if (!near(cash0 - A.balance('cash'), 1250) || !near(A.balance(acc.id) - e0, 1000)) throw new Error(`cash Δ ${cash0 - A.balance('cash')}`);
      const aq = IC.preview('expenses', book([{ 'المبلغ': 50, 'طريقة الدفع': 'آجل' }]), {}); if (aq.ok || !aq.items[0].errors.join().includes('مورد')) throw new Error('credit without supplier accepted');
      tbOk(); return 'الخزينة −1250 · الإيجار +1000 · آجل بدون مورد مرفوض';
    });

    t('استيراد قيود اليومية: تجميع برقم القيد، غير المتوازن وحسابات العملاء مرفوضة', () => {
      const cash = A.bySys('cash'), bank = A.bySys('bank'), ar = A.bySys('ar'); const bank0 = A.balance('bank'), j0 = A.entries({ refType: 'manual' }).length;
      const pv = IC.preview('journalEntries', book([
        { 'رقم القيد': 'A', 'كود الحساب': bank.code, 'مدين': 700, 'البيان': 'إيداع' }, { 'رقم القيد': 'A', 'كود الحساب': cash.code, 'دائن': 700 },
        { 'رقم القيد': 'B', 'كود الحساب': bank.code, 'مدين': 100 }, { 'رقم القيد': 'B', 'كود الحساب': cash.code, 'دائن': 90 },
        { 'رقم القيد': 'C', 'كود الحساب': ar.code, 'مدين': 50 }, { 'رقم القيد': 'C', 'كود الحساب': cash.code, 'دائن': 50 },
        { 'رقم القيد': 'D', 'كود الحساب': '5000', 'مدين': 10 }, { 'رقم القيد': 'D', 'كود الحساب': cash.code, 'دائن': 10 },
      ]), {});
      if (pv.counts.create !== 2 || pv.counts.error !== 6) throw new Error(errs(pv));
      if (!pv.items[2].errors.join().includes('غير متوازن') || !pv.items[4].errors.join().includes('العملاء') || !pv.items[5].errors.join().includes('سطر خاطئ') || !pv.items[6].errors.join().includes('رئيسي')) throw new Error(errs(pv));
      IC.apply(pv, { validOnly: true });
      if (!near(A.balance('bank') - bank0, 700) || A.entries({ refType: 'manual' }).length !== j0 + 1) throw new Error('posting');
      tbOk(); return 'قيد A مُرحّل · B غير متوازن · C حساب عملاء · D حساب رئيسي';
    });

    t('تسوية المخزون: الكمية الفعلية والفرق — الحسابات = التقييم وسياسة الرصيد السالب', () => {
      const wh = ERP.inventory.defaultWh(); const p1 = give(mkP('IMPT-SA1'), 20, 10), p2 = give(mkP('IMPT-SA2'), 5, 10); const s0 = inv();
      imp('stockAdjust', book([{ 'الكود': 'IMPT-SA1', 'الكمية الفعلية': 25, 'التكلفة': 12 }, { 'الكود': 'IMPT-SA2', 'الفرق': -2, 'السبب': 'كسر' }]));
      if (ERP.inventory.whQty(P.get(p1.id), wh) !== 25 || ERP.inventory.whQty(P.get(p2.id), wh) !== 3) throw new Error('qty');
      const d = invOk(s0, 'adjust'); if (!near(d, 5 * 12 - 2 * 10)) throw new Error(`Δ ${d}`);
      const real = ERP.inventory.canGoNegative; ERP.inventory.canGoNegative = () => false;
      try { const pv = IC.preview('stockAdjust', book([{ 'الكود': 'IMPT-SA2', 'الفرق': -10 }]), {}); if (pv.ok || !pv.items[0].errors.join().includes('سالب')) throw new Error('negative accepted'); } finally { ERP.inventory.canGoNegative = real; }
      tbOk(); return `+5 بتكلفة 12 و −2 · Δ الحسابات = Δ التقييم = ${u.fmtNum(d)}`;
    });

    t('تحويل مخزني من ملف + التراجع عنه (حركات عكسية)', () => {
      const from = ERP.inventory.defaultWh(); const W = ERP.db.collection('warehouses');
      const to = (ERP.inventory.warehouses().find(w => w.id !== from) || W.insert({ name: 'مخزن اختبار الاستيراد', code: 'IMPT' })).id;
      const p = give(mkP('IMPT-TR1'), 10, 10); const s0 = inv(); const a = ERP.inventory.whQty(p, from), c = ERP.inventory.whQty(p, to);
      const { b } = imp('stockTransfer', book([{ 'الكود': 'IMPT-TR1', 'الكمية': 4 }]), { options: { fromWh: from, toWh: to } });
      let q = P.get(p.id); if (ERP.inventory.whQty(q, from) !== a - 4 || ERP.inventory.whQty(q, to) !== c + 4 || !b.extra.transferNo) throw new Error('transfer');
      IC.undo(b.id); q = P.get(p.id);
      if (ERP.inventory.whQty(q, from) !== a || ERP.inventory.whQty(q, to) !== c || q.stock !== 10) throw new Error('undo qty');
      if (ERP.db.collection('stockMoves').all().filter(m => m.refId === b.id && m.type === 'import_undo').length !== 2) throw new Error('reversing moves');
      invOk(s0, 'transfer'); tbOk(); return `${b.extra.transferNo}: 4 → ثم تراجع بحركتين عكسيتين`;
    });

    t('الأرصدة الافتتاحية عبر مركز الاستيراد + التراجع', () => {
      const S = ERP.openingImport.SHEETS; const p = mkP('IMPT-OP1', { cost: 0 }); const ar0 = A.balance('ar'), s0 = inv(), c0 = ERP.db.collection('customers').count();
      const wb = XLSX.utils.book_new(); [[S.cust, [{ 'الاسم': 'عميل افتتاحي مستورد', 'الرصيد': 300 }]], [S.stock, [{ 'الكود أو الباركود': 'IMPT-OP1', 'الكمية': 6, 'التكلفة': 5 }]]].forEach(([n, r]) => XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(r), n));
      const pv = IC.preview('opening', wb, { options: { date: '2026-01-01' } }); if (!pv.ok) throw new Error(errs(pv));
      const b = IC.apply(pv);
      if (!near(A.balance('ar') - ar0, 300) || P.get(p.id).stock !== 6 || !near(invOk(s0, 'opening'), 30) || b.journal.length < 2) throw new Error('apply');
      tbOk(); IC.undo(b.id);
      if (!near(A.balance('ar'), ar0) || P.get(p.id).stock !== 0 || ERP.db.collection('customers').count() !== c0) throw new Error('undo');
      const s1 = inv(); if (!near(s1.g, s0.g) || !near(s1.v, s0.v)) throw new Error('undo stock GL');
      tbOk(); return `${b.no}: عميل 300 + مخزون 30 ثم تراجع كامل`;
    });

    t('الاستيراد يتحقق من الصلاحية داخل الخدمة', () => {
      const pv = IC.preview('employees', book([{ 'الاسم': 'بدون صلاحية' }]), {}); const can = ERP.auth.can; const n = ERP.db.collection('employees').count();
      let threw = false; try { ERP.auth.can = () => false; threw = throws(() => IC.apply(pv)); } finally { ERP.auth.can = can; }
      if (!threw || ERP.db.collection('employees').count() !== n) throw new Error('perm not enforced');
      return 'رُفض بدون «إدارة الموظفين والرواتب»';
    });
  });
})();
