/* ==========================================================================
   ERP.tests — in-app end-to-end self-tests
   Runs the real business flows against the live engines, then restores the
   exact pre-test snapshot so user data is untouched.
   Usage: await ERP.tests.run()  → { total, passed, failed, ms, results[] }
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  const u = ERP.utils;
  const near = (a, b, eps = 0.011) => Math.abs(u.num(a) - u.num(b)) <= eps;

  function suite(t) {
    const P = ERP.db.collection('products');
    const ctx = {};

    t('التخزين: الوضع والقراءة/الكتابة', async () => {
      const mode = ERP.db.mode();
      await ERP.db.kvSet('__test', { x: 1 });
      const v = await ERP.db.kvGet('__test');
      if (!v || v.x !== 1) throw new Error('kv roundtrip failed');
      return `mode=${mode}`;
    });

    t('الإعدادات: قراءة وحفظ', () => {
      const before = ERP.settings.get('storeName');
      ERP.settings.set({ __probe: 'ok' });
      if (ERP.settings.get('__probe') !== 'ok') throw new Error('settings.set failed');
      return before;
    });

    t('الوردية: فتح', () => {
      ctx.shift = ERP.shifts.current() || ERP.shifts.open({ openingCash: 500 });
      return ctx.shift.no;
    });

    t('المنتجات: إنشاء صنفين برصيد افتتاحي + ترحيل قيمة المخزون', () => {
      ctx.glInvBefore = ERP.accounting.balance('inventory'); ctx.valBefore = ERP.inventory.valuation().totalValue;
      const wh = ERP.inventory.defaultWh();
      ctx.p1 = P.insert({ code: 'TST-001', name: 'صنف اختبار A', categoryId: 'cat_other', unitId: 'un_pc', cost: 10, price: 15, stock: 0, stockByWh: {}, batches: [], minStock: 2, taxRate: 0, active: true, barcode: '6999999000019' });
      ctx.p2 = P.insert({ code: 'TST-002', name: 'صنف اختبار B (وزن)', categoryId: 'cat_other', unitId: 'un_kg', cost: 40, price: 60, stock: 0, stockByWh: {}, batches: [], minStock: 1, taxRate: 0, active: true, scalePlu: '00777' });
      ERP.inventory.move({ productId: ctx.p1.id, warehouseId: wh, qty: 100, type: 'opening', unitCost: 10, refType: 'opening', note: 'test' });
      ERP.inventory.move({ productId: ctx.p2.id, warehouseId: wh, qty: 20, type: 'opening', unitCost: 40, refType: 'opening', note: 'test' });
      ERP.accounting.postOpeningStock(100 * 10 + 20 * 40);
      const a = P.get(ctx.p1.id), b = P.get(ctx.p2.id);
      if (a.stock !== 100 || b.stock !== 20) throw new Error(`stock ${a.stock}/${b.stock}`);
      return `A=100, B=20 · قيمة 1800`;
    });

    t('الباركود: قراءة باركود عادي وباركود ميزان', () => {
      const r1 = ERP.inventory.resolveScan('6999999000019');
      if (!r1 || r1.product.id !== ctx.p1.id || r1.qty !== 1) throw new Error('plain barcode');
      ERP.settings.set({ scaleBarcodeEnabled: true, scaleBarcodePrefix: '2', scaleBarcodePluLength: 5, scaleBarcodeMode: 'weight' });
      const r2 = ERP.inventory.resolveScan('2' + '00777' + '001250' + '7'); // prefix + PLU + 1250g + check
      if (!r2 || r2.product.id !== ctx.p2.id || !near(r2.qty, 1.25, 0.0001)) throw new Error(`scale parse → ${r2 ? r2.qty : 'null'}`);
      return `وزن 1.250 كجم من الباركود 2-00777-001250`;
    });

    t('العملاء: إنشاء عميل بحد ائتمان', () => {
      ctx.cust = ERP.crm.create({ name: 'عميل اختبار', phone: '01099999999', creditLimit: 500 });
      return ctx.cust.code;
    });

    t('البيع النقدي مع باقي: الإجمالي، المخزون، القيد', () => {
      const s1 = P.get(ctx.p1.id).stock;
      ctx.sale = ERP.sales.create({ cart: [{ productId: ctx.p1.id, name: 'A', qty: 3, price: 15 }, { productId: ctx.p2.id, name: 'B', qty: 1.5, price: 60 }], payments: [{ method: 'cash', amount: 200 }] });
      if (!near(ctx.sale.total, 135)) throw new Error(`total ${ctx.sale.total}`);
      if (!near(ctx.sale.change, 65)) throw new Error(`change ${ctx.sale.change}`);
      if (P.get(ctx.p1.id).stock !== s1 - 3) throw new Error('stock not reduced');
      const j = ERP.accounting.entries({ refType: 'sale' }).find(x => x.refId === ctx.sale.id);
      if (!j) throw new Error('no journal');
      const d = u.sum(j.lines, 'debit'), c = u.sum(j.lines, 'credit'); if (!near(d, c)) throw new Error(`unbalanced ${d}/${c}`);
      const cashDr = u.sum(j.lines.filter(l => l.accountId === ERP.accounting.bySys('cash').id), 'debit');
      if (!near(cashDr, 135)) throw new Error(`cash debit ${cashDr} (should exclude change)`);
      return `${ctx.sale.no}: 135 مدفوع 200 باقي 65 · COGS ${ctx.sale.cogs}`;
    });

    t('العروض: خصم نسبة يُطبَّق تلقائياً', () => {
      const pr = ERP.promotions.save({ name: 'اختبار 10%', type: 'percent', value: 10, scope: 'products', productIds: [ctx.p1.id], active: true });
      const c = ERP.sales.compute([{ productId: ctx.p1.id, name: 'A', qty: 2, price: 15 }]);
      ERP.promotions.remove(pr.id);
      if (!near(c.total, 27)) throw new Error(`total ${c.total}`);
      return `30 → 27 بعد خصم 10%`;
    });

    t('البيع الآجل: رصيد العميل = حساب المدينين', () => {
      const arBefore = ERP.accounting.balance('ar');
      ctx.credit = ERP.sales.create({ cart: [{ productId: ctx.p1.id, name: 'A', qty: 10, price: 15 }], customerId: ctx.cust.id, payments: [{ method: 'credit', amount: 0 }] });
      const c = ERP.crm.get(ctx.cust.id);
      if (!near(c.balance, 150) || !near(ERP.accounting.balance('ar') - arBefore, 150)) throw new Error(`balance ${c.balance} / AR Δ ${ERP.accounting.balance('ar') - arBefore}`);
      if (ctx.credit.status !== 'unpaid') throw new Error(ctx.credit.status);
      return `${ctx.credit.no}: 150 آجل · نقاط ${c.loyaltyPoints}`;
    });

    t('حد الائتمان: رفض تجاوز الحد', () => {
      let threw = false;
      try { ERP.sales.create({ cart: [{ productId: ctx.p1.id, name: 'A', qty: 30, price: 15 }], customerId: ctx.cust.id, payments: [{ method: 'credit', amount: 0 }] }); } catch (e) { threw = /الائتمان/.test(e.message); }
      if (!threw) throw new Error('credit limit not enforced');
      return 'رُفض بيع 450 فوق حد 500 (الرصيد 150)';
    });

    t('التحصيل: توزيع على الفاتورة وتحديث الحالة', () => {
      ERP.crm.receivePayment({ customerId: ctx.cust.id, amount: 50, method: 'cash' });
      const s = ERP.sales.get(ctx.credit.id), c = ERP.crm.get(ctx.cust.id);
      if (s.status !== 'partial' || !near(s.due, 100) || !near(c.balance, 100)) throw new Error(`status ${s.status} due ${s.due} bal ${c.balance}`);
      return `متبقي 100 · الحالة جزئي`;
    });

    t('المرتجع: إعادة المخزون وقيد عكسي', () => {
      const before = P.get(ctx.p1.id).stock;
      const r = ERP.sales.createReturn({ saleId: ctx.sale.id, lines: [{ productId: ctx.p1.id, qty: 1 }], refundMethod: 'cash', reason: 'test' });
      if (P.get(ctx.p1.id).stock !== before + 1) throw new Error('stock not restored');
      if (!near(r.total, 15)) throw new Error(`return total ${r.total}`);
      const j = ERP.accounting.entries({ refType: 'sale_return' }).find(x => x.refId === r.id); if (!j) throw new Error('no journal');
      return `${r.no}: 15 · المخزون ${before} → ${before + 1}`;
    });

    t('إلغاء فاتورة: عكس المخزون وحذف القيد', () => {
      const v = ERP.sales.create({ cart: [{ productId: ctx.p1.id, name: 'A', qty: 2, price: 15 }], payments: [{ method: 'cash', amount: 30 }] });
      const before = P.get(ctx.p1.id).stock;
      ERP.sales.void(v.id, 'test');
      if (P.get(ctx.p1.id).stock !== before + 2) throw new Error('stock not reversed');
      if (ERP.accounting.entries({ refType: 'sale' }).some(x => x.refId === v.id)) throw new Error('journal still posted');
      if (ERP.sales.get(v.id).status !== 'void') throw new Error('status');
      return `${v.no} ملغاة`;
    });

    t('المشتريات: أمر شراء واستلام → مخزون، تكلفة متوسطة، حساب الموردين', () => {
      ctx.sup = ERP.purchasing.createSupplier({ name: 'مورد اختبار', phone: '0100' });
      const apBefore = ERP.accounting.balance('ap');
      const p1 = P.get(ctx.p1.id); const stockBefore = p1.stock; // cost 10
      const po = ERP.purchasing.create({ supplierId: ctx.sup.id, items: [{ productId: ctx.p1.id, name: 'A', qty: 100, cost: 12 }] });
      ERP.purchasing.receive(po.id);
      const after = P.get(ctx.p1.id);
      const expectedCost = u.round((stockBefore * 10 + 100 * 12) / (stockBefore + 100), 4);
      if (after.stock !== stockBefore + 100) throw new Error('stock');
      if (!near(after.cost, expectedCost, 0.001)) throw new Error(`avg cost ${after.cost} ≠ ${expectedCost}`);
      if (!near(ERP.purchasing.supplier(ctx.sup.id).balance, 1200) || !near(ERP.accounting.balance('ap') - apBefore, 1200)) throw new Error('AP mismatch');
      ctx.po = po;
      return `${po.no}: +100 · تكلفة 10 → ${after.cost} · دائن 1200`;
    });

    t('سداد المورد: خفض الرصيد وتوزيع على الأمر', () => {
      ERP.purchasing.paySupplier({ supplierId: ctx.sup.id, amount: 700, method: 'cash' });
      const s = ERP.purchasing.supplier(ctx.sup.id), po = ERP.purchasing.order(ctx.po.id);
      if (!near(s.balance, 500) || !near(po.due, 500)) throw new Error(`bal ${s.balance} due ${po.due}`);
      return 'متبقي 500';
    });

    t('مرتجع للمورد: خروج مخزون وخفض الدائن', () => {
      const before = P.get(ctx.p1.id).stock; const bal = ERP.purchasing.supplier(ctx.sup.id).balance;
      ERP.purchasing.returnToSupplier({ supplierId: ctx.sup.id, items: [{ productId: ctx.p1.id, name: 'A', qty: 5, cost: 12 }], poId: ctx.po.id });
      if (P.get(ctx.p1.id).stock !== before - 5) throw new Error('stock');
      if (!near(ERP.purchasing.supplier(ctx.sup.id).balance, bal - 60)) throw new Error('balance');
      return '5 قطع بقيمة 60';
    });

    t('المصروفات: ترحيل لحساب المصروف والخزينة', () => {
      const cashBefore = ERP.accounting.balance('cash');
      const cat = ERP.db.collection('expenseCategories').all()[0];
      const ex = ERP.db.collection('expenses').insert({ no: 'EXP-T', title: 'اختبار', categoryId: cat.id, categoryName: cat.name, amount: 80, method: 'cash', date: u.now() });
      ERP.accounting.postExpense(ex);
      if (!near(cashBefore - ERP.accounting.balance('cash'), 80)) throw new Error('cash not reduced');
      return '80 من الخزينة';
    });

    t('المخزون: تسوية + جرد بفروق', () => {
      const wh = ERP.inventory.defaultWh();
      const cur = ERP.inventory.whQty(P.get(ctx.p1.id), wh);
      ERP.inventory.adjust({ productId: ctx.p1.id, warehouseId: wh, newQty: cur - 2, reason: 'هالك اختبار' });
      if (P.get(ctx.p1.id).stock !== cur - 2) throw new Error('adjust');
      const st = ERP.inventory.applyStocktake({ warehouseId: wh, lines: [{ productId: ctx.p1.id, counted: cur - 2 + 3 }, { productId: ctx.p2.id, counted: ERP.inventory.whQty(P.get(ctx.p2.id), wh) }], note: 'test' });
      if (P.get(ctx.p1.id).stock !== cur + 1) throw new Error('stocktake');
      return `${st.no}: فرق +3 بعد تسوية -2`;
    });

    t('المخزون: تحويل بين مخزنين', () => {
      const whs = ERP.inventory.warehouses(); if (whs.length < 2) return 'تخطي — مخزن واحد فقط';
      const from = ERP.inventory.defaultWh(), to = whs.find(w => w.id !== from).id;
      const a = ERP.inventory.whQty(P.get(ctx.p2.id), from), b = ERP.inventory.whQty(P.get(ctx.p2.id), to), tot = P.get(ctx.p2.id).stock;
      ERP.inventory.transfer({ fromWh: from, toWh: to, lines: [{ productId: ctx.p2.id, qty: 4 }] });
      const p = P.get(ctx.p2.id);
      if (!near(ERP.inventory.whQty(p, from), a - 4, 0.0001) || !near(ERP.inventory.whQty(p, to), b + 4, 0.0001) || !near(p.stock, tot, 0.0001)) throw new Error('transfer qty');
      return `4 كجم ${whs.find(w => w.id === from).name} → ${whs.find(w => w.id === to).name}`;
    });

    t('الموظفون: موظف + سلفة + احتساب راتب', () => {
      const emp = ERP.hr.create({ name: 'موظف اختبار', salary: 3000, job: 'كاشير' });
      ERP.hr.giveAdvance({ employeeId: emp.id, amount: 200, method: 'cash' });
      const c = ERP.hr.computeSalary(emp.id, u.monthKey(new Date()), { bonus: 100, absentDays: 1 });
      if (!near(c.gross, 3100) || !near(c.advancesDeducted, 200) || !near(c.net, 3100 - 100 - 200)) throw new Error(`net ${c.net}`);
      return `إجمالي 3100 − غياب 100 − سلفة 200 = ${c.net}`;
    });

    t('قوائم الأسعار: سعر حسب مجموعة العميل', () => {
      P.update(ctx.p1.id, { priceTiers: { 'جملة': 12, 'VIP': 13.5 }, wholesalePrice: 11 }, { silent: true });
      const p = P.get(ctx.p1.id);
      const a = ERP.sales.priceFor(p, { group: 'جملة' }), b = ERP.sales.priceFor(p, { group: 'VIP' }), c = ERP.sales.priceFor(p, { group: 'عادي' }), d = ERP.sales.priceFor(p, null);
      if (a !== 12 || b !== 13.5 || c !== 15 || d !== 15) throw new Error(`${a}/${b}/${c}/${d}`);
      P.update(ctx.p1.id, { priceTiers: { 'مميز': 0 }, wholesalePrice: 11 }, { silent: true });
      if (ERP.sales.priceFor(P.get(ctx.p1.id), { group: 'جملة' }) !== 11) throw new Error('wholesale fallback');
      return 'جملة 12 · VIP 13.5 · عادي 15 · رجوع للجملة 11';
    });

    t('موافقات المشرف: التحقق من الرمز والصلاحية', async () => {
      const admin = ERP.db.collection('users').get('u_admin') || ERP.auth.users()[0];
      if (await ERP.auth.verifyPin(admin.id, 'wrong-pin-xyz')) throw new Error('wrong pin accepted');
      const role = ERP.auth.roles().find(r => r.id === 'admin');
      if (!(role.permissions.includes('*') || role.permissions.includes('pos.supervisor'))) throw new Error('admin lacks supervisor perm');
      if (!ERP.auth.PERMISSIONS['نقطة البيع']['pos.supervisor']) throw new Error('perm not registered');
      return 'رمز خاطئ مرفوض · المدير يملك صلاحية الاعتماد';
    });

    t('الأصول الثابتة: شراء + إهلاك شهرين + قيمة دفترية', () => {
      const d = new Date(); d.setMonth(d.getMonth() - 2); const start = u.monthKey(d);
      const a = ERP.assets.create({ name: 'ثلاجة اختبار', category: 'ثلاجات وتبريد', cost: 1200, salvage: 0, lifeMonths: 12, purchaseDate: u.toISODate(d), payMethod: 'opening', startMonth: start });
      const depBefore = ERP.accounting.balance('depreciation');
      const r = ERP.assets.runDepreciation(u.monthKey(new Date()));
      const after = ERP.assets.get(a.id);
      const mine = (after.history || []).length;
      if (mine !== 2 || !near(after.bookValue, 1000) || !near(after.accumulated, 200)) throw new Error(`entries ${mine} book ${after.bookValue} acc ${after.accumulated}`);
      if (ERP.accounting.balance('depreciation') - depBefore < 199.99) throw new Error('GL depreciation');
      return `قسط 100/شهر × 2 = 200 · دفترية 1000`;
    });

    t('توقع الطلب: اقتراح إعادة الشراء من سرعة المبيعات', () => {
      const wh = ERP.inventory.defaultWh();
      const p = P.insert({ code: 'TST-003', name: 'صنف سريع الحركة', categoryId: 'cat_other', unitId: 'un_pc', cost: 5, price: 8, stock: 0, stockByWh: {}, batches: [], minStock: 3, reorderQty: 0, taxRate: 0, active: true });
      ERP.inventory.move({ productId: p.id, warehouseId: wh, qty: 32, type: 'opening', unitCost: 5, refType: 'opening', note: 't' }); ERP.accounting.postOpeningStock(32 * 5);
      ERP.sales.create({ cart: [{ productId: p.id, name: p.name, qty: 30, price: 8 }], payments: [{ method: 'cash', amount: 240 }] });
      ERP.settings.set({ reorderLeadDays: 7, reorderSafetyDays: 3 });
      const sg = ERP.inventory.reorderSuggestions().find(x => x.product.id === p.id);
      if (!sg) throw new Error('not suggested');
      if (!near(sg.perDay, 1, 0.001) || sg.suggested < 8) throw new Error(`perDay ${sg.perDay} suggested ${sg.suggested}`);
      return `مبيعات 1/يوم × 10 أيام − رصيد 2 → مقترح ${sg.suggested}`;
    });

    t('الفروع: تحويل صادر → ملف → استلام في الفرع الآخر', () => {
      const me = ERP.branches.current().code;
      ERP.branches.register({ code: 'TST-BR', name: 'فرع اختبار' });
      const before = P.get(ctx.p1.id).stock; const gl0 = ERP.accounting.balance('branch_current');
      const t = ERP.branches.sendTransfer({ toBranch: 'TST-BR', lines: [{ productId: ctx.p1.id, qty: 5 }], note: 'test' });
      if (P.get(ctx.p1.id).stock !== before - 5) throw new Error('stock not reduced');
      if (!near(ERP.accounting.balance('branch_current') - gl0, t.value)) throw new Error('GL out');
      const payload = ERP.branches.payload(t.id); payload.toBranch = me; // simulate the other branch importing the file
      const inb = ERP.branches.receiveTransfer(payload);
      if (P.get(ctx.p1.id).stock !== before) throw new Error('stock not restored on receive');
      if (!near(ERP.accounting.balance('branch_current') - gl0, 0)) throw new Error('GL not netted');
      let dup = false; try { ERP.branches.receiveTransfer(payload); } catch (e) { dup = /من قبل/.test(e.message); }
      if (!dup) throw new Error('duplicate receive not blocked');
      if (!ERP.db.collection('sales').get(ctx.sale.id).branch) throw new Error('branch stamp missing on sale');
      return `${t.no} → ${inb.no} · 5 قطع · تكرار الاستلام مرفوض · ختم الفرع ${me}`;
    });

    t('الفروع: مؤشرات اللوحة المركزية من نسخة', () => {
      const k = ERP.branches.kpis(ERP.db.export().collections, { branchCode: 'X', branchName: 'X' });
      if (!(k.all.count >= 2) || typeof k.stockValue !== 'number' || !Array.isArray(k.top)) throw new Error('kpis shape');
      return `${k.all.count} فاتورة · مخزون ${u.fmtNum(k.stockValue)} · مديونيات ${u.fmtNum(k.debtors)}`;
    });

    t('الطلبات: إنشاء → تجهيز → توصيل → فاتورة برسوم توصيل', () => {
      const before = P.get(ctx.p1.id).stock;
      const o = ERP.orders.create({ customerId: ctx.cust.id, items: [{ productId: ctx.p1.id, name: 'A', qty: 2, price: 15 }], deliveryFee: 10, address: 'شارع الاختبار' });
      if (!near(o.grand, 40)) throw new Error(`grand ${o.grand}`);
      ERP.orders.setStatus(o.id, 'preparing'); ERP.orders.setStatus(o.id, 'out');
      const otherIncome = ERP.accounting.balance('other_income');
      const r = ERP.orders.deliver(o.id, { payments: [{ method: 'cash', amount: 40 }] });
      if (r.order.status !== 'delivered' || !r.sale || !near(r.sale.total, 40) || !near(r.sale.deliveryFee, 10)) throw new Error('deliver');
      if (P.get(ctx.p1.id).stock !== before - 2) throw new Error('stock');
      if (!near(ERP.accounting.balance('other_income') - otherIncome, 10)) throw new Error('fee not posted');
      let blocked = false; try { ERP.orders.deliver(o.id); } catch (e) { blocked = true; } if (!blocked) throw new Error('double deliver');
      return `${o.no} → ${r.sale.no} · 30 + توصيل 10 = 40`;
    });

    t('بطاقات الهدايا: إصدار → دفع بها في الكاشير → التزام محاسبي', () => {
      ERP.giftcards.ensureMethod();
      const liab0 = ERP.accounting.balance('gift'); const cash0 = ERP.accounting.balance('cash');
      const card = ERP.giftcards.issue({ amount: 100, method: 'cash' });
      if (!near(ERP.accounting.balance('gift') - liab0, 100) || !near(ERP.accounting.balance('cash') - cash0, 100)) throw new Error('issue GL');
      let bad = false; try { ERP.giftcards.check(card.code, 150); } catch (e) { bad = true; } if (!bad) throw new Error('over-balance accepted');
      const s = ERP.sales.create({ cart: [{ productId: ctx.p1.id, name: 'A', qty: 3, price: 15 }], payments: [{ method: 'gift', amount: 30, cardCode: card.code }, { method: 'cash', amount: 15 }] });
      const after = ERP.giftcards.byCode(card.code);
      if (!near(after.balance, 70) || s.status !== 'paid' || s.change !== 0) throw new Error(`balance ${after.balance} status ${s.status} change ${s.change}`);
      if (!near(ERP.accounting.balance('gift') - liab0, 70)) throw new Error('redeem GL');
      ERP.sales.void(s.id, 'test');
      if (!near(ERP.giftcards.byCode(card.code).balance, 100)) throw new Error('void refund');
      return `${card.code}: 100 → 70 بعد دفع 30 → 100 بعد الإلغاء`;
    });

    t('عروض الأسعار: إنشاء → تحويل لفاتورة → منع التحويل المزدوج', () => {
      const q = ERP.sales.createQuotation({ cart: [{ productId: ctx.p1.id, name: 'A', qty: 2, price: 15 }], customerId: ctx.cust.id, validDays: 7 });
      if (!near(q.total, 30) || q.status !== 'open' || !q.validUntil) throw new Error(`quote total ${q.total} status ${q.status}`);
      const before = P.get(ctx.p1.id).stock;
      const s = ERP.sales.convertQuotation(q.id);
      if (!s || !near(s.total, q.total)) throw new Error('converted sale totals');
      if (P.get(ctx.p1.id).stock !== before - 2) throw new Error('stock not reduced on conversion');
      if (ERP.sales.qget(q.id).status !== 'converted') throw new Error('status not converted');
      let dup = false; try { ERP.sales.convertQuotation(q.id); } catch (e) { dup = /من قبل/.test(e.message); }
      if (!dup) throw new Error('double conversion allowed');
      return `${q.no} → فاتورة ${s.no} · ${u.fmtMoney(q.total)} · تحويل مزدوج مرفوض`;
    });

    /* ---------- business-logic regression tests (VAT, returns, voids, receipts, costing, payroll, atomicity) ---------- */
    const withSettings = (patch, fn) => { const keep = {}; Object.keys(patch).forEach(k => { keep[k] = ERP.settings.get(k); }); ERP.settings.set(patch); try { return fn(); } finally { ERP.settings.set(keep); } };
    const tbOk = () => { const tb = ERP.accounting.trialBalance(); if (!near(tb.totalDebit, tb.totalCredit)) throw new Error(`TB ${tb.totalDebit} ≠ ${tb.totalCredit}`); };
    const invSnap = () => ({ g: ERP.accounting.balance('inventory'), v: ERP.inventory.valuation().totalValue });
    const invOk = (s0, label = '') => { const s1 = invSnap(); const dG = s1.g - s0.g, dV = s1.v - s0.v; if (!near(dG, dV, 0.05)) throw new Error(`${label} GL Δ ${u.round(dG)} ≠ تقييم Δ ${u.round(dV)}`); return u.round(dG); };
    const posted = (refType, id) => ERP.accounting.entries({ refType }).some(x => x.refId === id);
    const counts = () => ({ sales: ERP.db.collection('sales').all().length, journal: ERP.db.collection('journal').all().length, moves: ERP.db.collection('stockMoves').all().length });

    t('ض.ق.م غير شاملة: بيع + مرتجع → قيد متوازن، حساب الضريبة، المخزون = التقييم', () => withSettings({ taxEnabled: true, taxInclusive: false, taxRate: 14 }, () => {
      const wh = ERP.inventory.defaultWh();
      ctx.p3 = P.insert({ code: 'TST-VAT', name: 'صنف ضريبي', categoryId: 'cat_other', unitId: 'un_pc', cost: 50, price: 100, stock: 0, stockByWh: {}, batches: [], taxRate: 14, active: true });
      ERP.inventory.move({ productId: ctx.p3.id, warehouseId: wh, qty: 50, type: 'opening', unitCost: 50, refType: 'opening', note: 't' }); ERP.accounting.postOpeningStock(2500);
      const s0 = invSnap(), vat0 = ERP.accounting.balance('vat_out');
      const s = ERP.sales.create({ cart: [{ productId: ctx.p3.id, name: 'VAT', qty: 2, price: 100 }], payments: [{ method: 'cash', amount: 228 }] });
      if (!near(s.tax, 28) || !near(s.total, 228) || !posted('sale', s.id)) throw new Error(`sale tax ${s.tax} total ${s.total}`);
      const r = ERP.sales.createReturn({ saleId: s.id, lines: [{ productId: ctx.p3.id, qty: 1 }], refundMethod: 'cash' });
      if (!near(r.tax, 14) || !near(r.total, 114) || !posted('sale_return', r.id)) throw new Error(`return tax ${r.tax} total ${r.total} posted ${posted('sale_return', r.id)}`);
      if (!near(ERP.accounting.balance('vat_out') - vat0, 14)) throw new Error(`vat Δ ${ERP.accounting.balance('vat_out') - vat0}`);
      tbOk(); invOk(s0);
      return `بيع 200 + 28 ضريبة → مرتجع 114 (14 ضريبة) · صافي الضريبة 14`;
    }));

    t('ض.ق.م شاملة + خصم فاتورة: مرتجع يُرحَّل (بلا ابتلاع أخطاء) والضريبة من سطور المرتجع', () => withSettings({ taxEnabled: true, taxInclusive: true, taxRate: 14 }, () => {
      const s0 = invSnap(), vat0 = ERP.accounting.balance('vat_out');
      const s = ERP.sales.create({ cart: [{ productId: ctx.p3.id, name: 'VAT', qty: 2, price: 114 }], discount: 22.8, payments: [{ method: 'cash', amount: 205.2 }] });
      if (!near(s.tax, 25.2) || !near(s.total, 205.2) || !posted('sale', s.id)) throw new Error(`sale tax ${s.tax} total ${s.total}`);
      const r = ERP.sales.createReturn({ saleId: s.id, lines: [{ productId: ctx.p3.id, qty: 1 }], refundMethod: 'cash' });
      if (!near(r.tax, 12.6) || !near(r.total, 102.6)) throw new Error(`return tax ${r.tax} total ${r.total}`);
      if (!posted('sale_return', r.id)) throw new Error('return journal missing');
      if (!near(ERP.accounting.balance('vat_out') - vat0, 12.6)) throw new Error(`vat Δ ${ERP.accounting.balance('vat_out') - vat0}`);
      tbOk(); invOk(s0);
      ctx.vatRet = r;
      return `228 شامل − خصم 22.8 → ضريبة 25.2 · مرتجع 102.6 (12.6 ضريبة)`;
    }));

    t('إلغاء مستند مرتجع: ممنوع + canVoid = false', () => {
      let blocked = false; try { ERP.sales.void(ctx.vatRet.id, 'test'); } catch (e) { blocked = /مرتجع/.test(e.message); }
      if (!blocked) throw new Error('return void not blocked');
      if (ERP.sales.get(ctx.vatRet.id).status === 'void' || ERP.sales.canVoid(ERP.sales.get(ctx.vatRet.id))) throw new Error('canVoid/status');
      return 'رُفض إلغاء المرتجع';
    });

    t('إلغاء فاتورة آجلة عليها تحصيل: ممنوع → حذف السند يعيد المستحق → الإلغاء يعيد الرصيد', () => {
      const ar0 = ERP.accounting.balance('ar'), bal0 = ERP.crm.get(ctx.cust.id).balance, sh0 = ERP.db.collection('shifts').get(ctx.shift.id).receiptsCash;
      const s = ERP.sales.create({ cart: [{ productId: ctx.p1.id, name: 'A', qty: 2, price: 15 }], customerId: ctx.cust.id, payments: [{ method: 'credit', amount: 0 }] });
      const pay = ERP.crm.receivePayment({ customerId: ctx.cust.id, amount: 10, method: 'cash', saleId: s.id });
      if (!near(ERP.db.collection('shifts').get(ctx.shift.id).receiptsCash - sh0, 10)) throw new Error('receipt not in shift');
      let blocked = false; try { ERP.sales.void(s.id, 'test'); } catch (e) { blocked = /التحصيل/.test(e.message); }
      if (!blocked || ERP.sales.canVoid(ERP.sales.get(s.id))) throw new Error('void with receipt not blocked');
      ERP.crm.deleteReceipt(pay.id);
      const s2 = ERP.sales.get(s.id);
      if (!near(s2.due, 30) || s2.status !== 'unpaid' || s2.payments.some(p => p.receiptId)) throw new Error(`after delete: due ${s2.due} status ${s2.status}`);
      if (!near(ERP.db.collection('shifts').get(ctx.shift.id).receiptsCash, sh0)) throw new Error('shift receipt not reversed');
      if (!near(ERP.crm.get(ctx.cust.id).balance - bal0, 30) || !near(ERP.accounting.balance('ar') - ar0, 30)) throw new Error('balance/AR after delete');
      ERP.sales.void(s.id, 'test');
      if (!near(ERP.crm.get(ctx.cust.id).balance, bal0) || !near(ERP.accounting.balance('ar'), ar0)) throw new Error(`after void bal ${ERP.crm.get(ctx.cust.id).balance} AR Δ ${ERP.accounting.balance('ar') - ar0}`);
      tbOk();
      return 'مستحق 30 → تحصيل 10 → حذف السند (30) → إلغاء · الرصيد = المدينين';
    });

    t('الوردية: النقدية المتوقعة بعد إلغاء فاتورة وبعد تحصيل', () => {
      const sh = () => ERP.db.collection('shifts').get(ctx.shift.id); const e0 = ERP.shifts.expected(sh());
      const s = ERP.sales.create({ cart: [{ productId: ctx.p1.id, name: 'A', qty: 2, price: 15 }], payments: [{ method: 'cash', amount: 50 }] });
      if (!near(ERP.shifts.expected(sh()) - e0, 30)) throw new Error(`after sale Δ ${ERP.shifts.expected(sh()) - e0}`);
      ERP.sales.void(s.id, 'test');
      if (!near(ERP.shifts.expected(sh()), e0)) throw new Error(`after void Δ ${ERP.shifts.expected(sh()) - e0}`);
      const rep = ERP.shifts.report(ctx.shift.id);
      if (Object.values(rep.byMethod).some(v => isNaN(v))) throw new Error('report byMethod');
      const due0 = ERP.sales.get(ctx.credit.id).due;
      const pay = ERP.crm.receivePayment({ customerId: ctx.cust.id, amount: 20, method: 'cash' });
      if (!near(ERP.shifts.expected(sh()) - e0, 20)) throw new Error('after receipt');
      ERP.crm.deleteReceipt(pay.id);
      if (!near(ERP.shifts.expected(sh()), e0) || !near(ERP.sales.get(ctx.credit.id).due, due0)) throw new Error('after receipt delete');
      return `بيع 30 (دفع 50 باقي 20) → إلغاء → تحصيل 20 → حذف · المتوقع ${u.fmtNum(e0)}`;
    });

    t('أمر شراء بخصم: التكلفة بعد الخصم، المخزون = التقييم، الدائنون = صافي الأمر', () => {
      const s0 = invSnap(), ap0 = ERP.accounting.balance('ap'), sb0 = ERP.purchasing.supplier(ctx.sup.id).balance;
      const po = ERP.purchasing.create({ supplierId: ctx.sup.id, items: [{ productId: ctx.p3.id, name: 'VAT', qty: 10, cost: 60 }], discount: 60 });
      ERP.purchasing.receive(po.id);
      const d = invOk(s0, 'PO discount');
      if (!near(d, 540)) throw new Error(`inventory Δ ${d} ≠ 540`);
      if (!near(ERP.accounting.balance('ap') - ap0, 540) || !near(ERP.purchasing.supplier(ctx.sup.id).balance - sb0, 540) || !near(ERP.purchasing.order(po.id).due, 540)) throw new Error('AP ≠ 540');
      tbOk();
      return `10 × 60 − خصم 60 → تكلفة الوحدة 54 · مخزون +540`;
    });

    t('استلام بدون تحديث التكلفة: الحركة بتكلفة الأمر الحقيقية (المخزون = التقييم)', () => {
      const s0 = invSnap();
      const po = ERP.purchasing.create({ supplierId: ctx.sup.id, items: [{ productId: ctx.p3.id, name: 'VAT', qty: 10, cost: 70 }] });
      ERP.purchasing.receive(po.id, null, { updateCost: false });
      const d = invOk(s0, 'updateCost=false');
      if (!near(d, 700)) throw new Error(`Δ ${d}`);
      tbOk();
      return '10 × 70 = 700 في الحساب والتقييم';
    });

    t('رصيد سالب ثم شراء: تسوية الفرق → المخزون = التقييم', () => withSettings({ posAllowNegativeStock: true }, () => {
      const wh = ERP.inventory.defaultWh(); const s0 = invSnap();
      const p = P.insert({ code: 'TST-NEG', name: 'صنف رصيد سالب', categoryId: 'cat_other', unitId: 'un_pc', cost: 10, price: 20, stock: 0, stockByWh: {}, batches: [], taxRate: 0, active: true });
      ERP.inventory.move({ productId: p.id, warehouseId: wh, qty: 5, type: 'opening', unitCost: 10, refType: 'opening', note: 't' }); ERP.accounting.postOpeningStock(50);
      ERP.sales.create({ cart: [{ productId: p.id, name: p.name, qty: 8, price: 20 }], payments: [{ method: 'cash', amount: 160 }] });
      if (P.get(p.id).stock !== -3) throw new Error(`stock ${P.get(p.id).stock}`);
      const po = ERP.purchasing.create({ supplierId: ctx.sup.id, items: [{ productId: p.id, name: p.name, qty: 10, cost: 12 }], warehouseId: wh });
      ERP.purchasing.receive(po.id);
      const a = P.get(p.id);
      if (a.stock !== 7 || !near(a.cost, 12, 0.0001)) throw new Error(`stock ${a.stock} cost ${a.cost}`);
      invOk(s0, 'negative stock'); tbOk();
      return '5 → بيع 8 (−3) → شراء 10 × 12 · فرق 6 إلى خسائر المخزون';
    }));

    t('العروض: سقف الخصم (maxDiscount) على إجمالي الفاتورة', () => {
      const cart = [{ productId: ctx.p1.id, name: 'A', qty: 2, price: 15 }];
      const base = ERP.sales.compute(cart).total;
      const pr = ERP.promotions.save({ name: 'اختبار سقف', type: 'min_total_percent', value: 50, minTotal: 0, maxDiscount: 5, active: true });
      let c; try { c = ERP.sales.compute(cart); } finally { ERP.promotions.remove(pr.id); }
      if (!near(base - c.total, 5)) throw new Error(`discount ${base - c.total} (should be capped at 5)`);
      return `50% من 30 = 15 → السقف 5`;
    });

    t('عرض سعر مع عرض ترويجي نشط: الفاتورة = إجمالي العرض', () => {
      const pr = ERP.promotions.save({ name: 'اختبار 10% تحويل', type: 'percent', value: 10, scope: 'products', productIds: [ctx.p1.id], active: true });
      try {
        const q = ERP.sales.createQuotation({ cart: [{ productId: ctx.p1.id, name: 'A', qty: 2, price: 15 }], customerId: ctx.cust.id });
        const s = ERP.sales.convertQuotation(q.id);
        if (!near(s.total, q.total) || !near(s.change, 0)) throw new Error(`quote ${q.total} ≠ sale ${s.total}`);
        return `${u.fmtMoney(q.total)} = ${u.fmtMoney(s.total)}`;
      } finally { ERP.promotions.remove(pr.id); }
    });

    t('نقاط الولاء: استبدال (مع قص الطلب للمتاح) ثم إلغاء يعيد النقاط والعدادات', () => withSettings({ loyaltyEnabled: true, loyaltyMinRedeem: 10, loyaltyRedeemValue: 0.1, loyaltyEarnRate: 1 }, () => {
      ERP.db.collection('customers').update(ctx.cust.id, { loyaltyPoints: 100 }, { silent: true });
      const c0 = ERP.crm.get(ctx.cust.id);
      const s = ERP.sales.create({ cart: [{ productId: ctx.p1.id, name: 'A', qty: 4, price: 15 }], customerId: ctx.cust.id, loyaltyPoints: 1000, payments: [{ method: 'cash', amount: 50 }] });
      if (s.loyaltyPointsUsed !== 100 || !near(s.loyaltyDiscount, 10) || !near(s.total, 50)) throw new Error(`used ${s.loyaltyPointsUsed} disc ${s.loyaltyDiscount} total ${s.total}`);
      const c1 = ERP.crm.get(ctx.cust.id);
      if (c1.loyaltyPoints !== u.num(s.loyaltyEarned)) throw new Error(`points ${c1.loyaltyPoints}`);
      ERP.sales.void(s.id, 'test');
      const c2 = ERP.crm.get(ctx.cust.id);
      if (c2.loyaltyPoints !== 100 || u.num(c2.purchaseCount) !== u.num(c0.purchaseCount) || !near(c2.totalPurchases, c0.totalPurchases)) throw new Error(`after void points ${c2.loyaltyPoints} count ${c2.purchaseCount}/${c0.purchaseCount}`);
      let threw = false; ERP.db.collection('customers').update(ctx.cust.id, { loyaltyPoints: 5 }, { silent: true });
      const n0 = counts();
      try { ERP.sales.create({ cart: [{ productId: ctx.p1.id, name: 'A', qty: 1, price: 15 }], customerId: ctx.cust.id, loyaltyPoints: 5, payments: [{ method: 'cash', amount: 15 }] }); } catch (e) { threw = /الحد الأدنى/.test(e.message); }
      const n1 = counts();
      if (!threw || n1.sales !== n0.sales || n1.journal !== n0.journal || n1.moves !== n0.moves) throw new Error('below-min redeem not rejected atomically');
      ERP.db.collection('customers').update(ctx.cust.id, { loyaltyPoints: c0.loyaltyPoints }, { silent: true });
      tbOk();
      return 'طُلب 1000 → استُخدم 100 (خصم 10) → إلغاء → 100 نقطة · أقل من الحد مرفوض';
    }));

    t('الرواتب: الصافي لا يصبح سالباً والغياب يخفض مصروف الرواتب', () => {
      const emp = ERP.hr.create({ name: 'موظف خصومات', salary: 3000 });
      const c = ERP.hr.computeSalary(emp.id, u.monthKey(new Date()), { deductions: 5000, absentDays: 3 });
      if (c.net < 0 || !near(c.net, 0) || !near(c.absentDeduction, 300) || !near(c.otherDeductions, 2700)) throw new Error(`net ${c.net} absent ${c.absentDeduction} other ${c.otherDeductions}`);
      const sal0 = ERP.accounting.balance('salaries'), oi0 = ERP.accounting.balance('other_income');
      ERP.hr.paySalary(c, { method: 'cash' });
      if (!near(ERP.accounting.balance('salaries') - sal0, 2700) || !near(ERP.accounting.balance('other_income') - oi0, 2700)) throw new Error(`salaries Δ ${ERP.accounting.balance('salaries') - sal0}`);
      tbOk();
      return '3000 − غياب 300 − خصم 2700 (مقصوص من 5000) = 0';
    });

    t('إنشاء فاتورة: رفض الكمية/السعر السالب + ذرّية عند فشل بطاقة الهدايا', () => {
      const n0 = counts(), st0 = P.get(ctx.p1.id).stock;
      let a = false; try { ERP.sales.create({ cart: [{ productId: ctx.p1.id, name: 'A', qty: -2, price: 15 }], payments: [{ method: 'cash', amount: 0 }] }); } catch (e) { a = /كمية/.test(e.message); }
      let b = false; try { ERP.sales.create({ cart: [{ productId: ctx.p1.id, name: 'A', qty: 1, price: -15 }], payments: [{ method: 'cash', amount: 0 }] }); } catch (e) { b = /سعر/.test(e.message); }
      if (!a || !b) throw new Error(`negative qty ${a} / price ${b}`);
      if (counts().sales !== n0.sales || counts().moves !== n0.moves) throw new Error('negative line wrote data');
      ERP.giftcards.ensureMethod();
      const card = ERP.giftcards.issue({ amount: 20, method: 'cash' });
      const n1 = counts();
      let g = false; try { ERP.sales.create({ cart: [{ productId: ctx.p1.id, name: 'A', qty: 2, price: 15 }], payments: [{ method: 'gift', amount: 15, cardCode: card.code }, { method: 'gift', amount: 15, cardCode: card.code }] }); } catch (e) { g = /رصيد البطاقة/.test(e.message); }
      const n2 = counts();
      if (!g) throw new Error('two gift payments over the card balance accepted');
      if (n2.sales !== n1.sales || n2.journal !== n1.journal || n2.moves !== n1.moves || P.get(ctx.p1.id).stock !== st0 || !near(ERP.giftcards.byCode(card.code).balance, 20)) throw new Error('side effects after a rejected sale');
      return 'كمية/سعر سالب مرفوض · بطاقة 20 بدفعتين 15+15 مرفوضة بلا أي أثر';
    });

    t('البيع بالسالب: ممنوع نهائياً / بصلاحية فقط / مسموح للكل', () => {
      const p = P.get(ctx.p1.id), over = Math.floor(ERP.inventory.whQty(p, ERP.inventory.defaultWh())) + 5;
      let made = null; const sell = () => { try { made = ERP.sales.create({ cart: [{ productId: p.id, name: p.name, qty: over, price: ERP.sales.priceFor(p, null) }], payments: [{ method: 'cash', amount: over * ERP.sales.priceFor(p, null) }] }); return true; } catch (e) { if (!/رصيد غير كاف/.test(e.message)) throw e; return false; } };
      const snap = () => ({ stock: P.get(p.id).stock, n: counts().sales });
      const can0 = ERP.auth.can;
      return withSettings({ posAllowNegativeStock: false, negativeStockMode: 'block' }, () => {
        const s0 = snap();
        if (sell()) throw new Error('block mode: admin sold into negative');
        if (snap().stock !== s0.stock || snap().n !== s0.n) throw new Error('rejected sale wrote data');
        ERP.settings.set({ negativeStockMode: 'permission' });
        ERP.auth.can = perm => perm === 'pos.negative_stock' ? false : can0.call(ERP.auth, perm);
        let noPerm; try { noPerm = sell(); } finally { ERP.auth.can = can0; }
        if (noPerm) throw new Error('permission mode: user without permission sold into negative');
        if (!sell()) throw new Error('permission mode: user with permission blocked');
        ERP.sales.void(made.id, 'test'); // put the stock back so later tests start from a positive balance
        if (snap().stock !== s0.stock) throw new Error('void did not restore stock');
        ERP.settings.set({ negativeStockMode: 'allow', posAllowNegativeStock: true });
        if (ERP.inventory.negativeMode() !== 'allow' || !ERP.inventory.canGoNegative()) throw new Error('allow mode not applied');
        return `كمية ${over} فوق الرصيد: ممنوع للمدير نفسه في «ممنوع» · مرفوض بدون الصلاحية ومقبول بها في «بصلاحية»`;
      });
    });
    t('التحكم في السعر: مستخدم بدون صلاحية تعديل السعر لا يبيع تحت السعر المعتمد إلا بموافقة', () => {
      const can0 = ERP.auth.can; ERP.auth.can = perm => perm === 'pos.price_edit' ? false : can0.call(ERP.auth, perm);
      try {
        const p = P.get(ctx.p1.id), list = ERP.sales.priceFor(p, null), low = u.round(list - 1);
        const n0 = counts();
        let rej = false; try { ERP.sales.create({ cart: [{ productId: p.id, name: p.name, qty: 1, price: low }], payments: [{ method: 'cash', amount: low }] }); } catch (e) { rej = /صلاحية تعديل السعر|الحد الأدنى/.test(e.message); }
        if (!rej) throw new Error('below-list price accepted without permission');
        if (counts().sales !== n0.sales || counts().moves !== n0.moves) throw new Error('rejected sale wrote data');
        const ok1 = ERP.sales.create({ cart: [{ productId: p.id, name: p.name, qty: 1, price: list }], payments: [{ method: 'cash', amount: list }] });
        const me = ERP.auth.current();
        const ok2 = ERP.sales.create({ cart: [{ productId: p.id, name: p.name, qty: 1, price: low }], payments: [{ method: 'cash', amount: low }], approvedBy: { id: me.id, name: me.name } });
        if (!ok1 || !ok2 || !near(ok2.total, low)) throw new Error('list price / approved sale failed');
        return `سعر ${u.fmtNum(low)} تحت ${u.fmtNum(list)} مرفوض بلا أثر · بالسعر المعتمد أو بموافقة مشرف مقبول`;
      } finally { ERP.auth.can = can0; }
    });
    t('المخزون: تحويل غير صالح لا يُطبَّق جزئياً', () => withSettings({ posAllowNegativeStock: false }, () => {
      const whs = ERP.inventory.warehouses(); if (whs.length < 2) return 'تخطي — مخزن واحد فقط';
      const from = ERP.inventory.defaultWh(), to = whs.find(w => w.id !== from).id;
      const a = ERP.inventory.whQty(P.get(ctx.p1.id), from), n0 = counts(), tr0 = ERP.db.collection('transfers').all().length;
      let threw = false; try { ERP.inventory.transfer({ fromWh: from, toWh: to, lines: [{ productId: ctx.p1.id, qty: 1 }, { productId: ctx.p2.id, qty: 999999 }] }); } catch (e) { threw = true; }
      if (!threw || ERP.inventory.whQty(P.get(ctx.p1.id), from) !== a || counts().moves !== n0.moves || ERP.db.collection('transfers').all().length !== tr0) throw new Error('half-applied transfer');
      return 'رُفض التحويل كاملاً';
    }));

    t('سلامة المحاسبة: ميزان المراجعة متوازن', () => {
      const tb = ERP.accounting.trialBalance();
      if (!near(tb.totalDebit, tb.totalCredit)) throw new Error(`${tb.totalDebit} ≠ ${tb.totalCredit}`);
      return `مدين = دائن = ${u.fmtNum(tb.totalDebit)}`;
    });

    t('سلامة المحاسبة: المركز المالي متوازن', () => {
      const bs = ERP.accounting.balanceSheet();
      if (!bs.balanced) throw new Error(`A ${bs.totalAssets} ≠ L ${bs.totalLiabilities} + E ${bs.totalEquity}`);
      return `الأصول ${u.fmtNum(bs.totalAssets)}`;
    });

    t('سلامة المخزون: تغيّر حساب المخزون = تغيّر تقييم المخزون', () => {
      const dGL = ERP.accounting.balance('inventory') - ctx.glInvBefore;
      const dVal = ERP.inventory.valuation().totalValue - ctx.valBefore;
      if (!near(dGL, dVal, 0.05)) throw new Error(`GL Δ ${u.fmtNum(dGL)} ≠ تقييم Δ ${u.fmtNum(dVal)}`);
      return `Δ = ${u.fmtNum(dGL)}`;
    });

    t('الوردية: إغلاق بدون فرق', () => {
      const sh = ERP.shifts.current(); const exp = ERP.shifts.expected(sh);
      const c = ERP.shifts.close(sh.id, { closingCash: exp });
      if (c.status !== 'closed' || !near(c.difference, 0)) throw new Error(`diff ${c.difference}`);
      return `متوقع ${u.fmtNum(exp)} · فرق 0`;
    });

    t('التقارير: ملخص المبيعات وأعمار الديون', () => {
      const s = ERP.reports.salesSummary(null, null); const a = ERP.reports.debtorsAging();
      if (!(s.count >= 2) || !(a.total >= 100)) throw new Error(`count ${s.count} aging ${a.total}`);
      return `${s.count} فاتورة · ديون ${u.fmtNum(a.total)}`;
    });

    t('النسخ الاحتياطي: تصدير صالح', () => {
      const snap = ERP.db.export(); const txt = JSON.stringify(snap);
      if (!snap.collections.products || !snap.__meta) throw new Error('export shape');
      return `${Math.round(txt.length / 1024)} KB · ${Object.keys(snap.collections).length} جدول`;
    });

    t('السحابة: تقسيم وتجميع الأجزاء (chunking)', () => {
      const rows = []; for (let i = 0; i < 300; i++) rows.push({ id: 'r' + i, txt: 'نص تجريبي لمدخل كبير '.repeat(12) });
      const text = JSON.stringify(rows);
      const parts = ERP.cloud.chunks(text, 20000);
      if (!parts.length || parts.length < 5) throw new Error(`few chunks ${parts.length}`);
      if (parts.join('') !== text) throw new Error('chunks roundtrip mismatch');
      return `${parts.length} قطعة · ${Math.round(text.length / 1024)} KB بلا فقدان`;
    });
  }

  ERP.tests = {
    async run() {
      const started = performance.now();
      const snapshot = JSON.parse(JSON.stringify(ERP.db.export()));
      const results = [];
      const queue = [];
      const add = (name, fn) => queue.push({ name, fn });
      suite(add);
      // feature test files: ERP.testSuites.push((t, h) => { t('name', () => ...) }) — h = { u, near }
      (ERP.testSuites || []).forEach(s => s(add, { u, near }));
      // invariant probe after every test: GL inventory − stock valuation (should stay 0) → r.invGap, so a leaking test is easy to spot
      const gap = () => { try { return u.round(ERP.accounting.balance('inventory') - ERP.inventory.valuation().totalValue); } catch { return null; } };
      for (const { name, fn } of queue) {
        try { const detail = await fn(); results.push({ name, ok: true, detail: detail || '', invGap: gap() }); }
        catch (e) { console.error('[test]', name, e); results.push({ name, ok: false, detail: e.message, invGap: gap() }); }
      }
      // suite-wide guard: after every test ran, GL inventory must still equal the valuation (cent-level rounding tolerated)
      { const g = gap(), start = results.length ? results[0].invGap : 0, bad = results.filter((r, i) => i && Math.abs((r.invGap || 0) - (results[i - 1].invGap || 0)) > 0.05).map(r => r.name);
        results.push({ name: 'سلامة المخزون عبر كل الاختبارات: حساب المخزون = التقييم', ok: g !== null && Math.abs(g - (start || 0)) <= 0.05 && !bad.length, detail: bad.length ? `فرق ظهر بعد: ${bad.join(' · ')}` : `الفرق ${g}` }); }
      // restore user data exactly as it was
      try { await ERP.db.import(snapshot, { mode: 'replace' }); ERP.settings.load(); ERP.bus.emit('db:change', { collection: 'products', op: 'bulk' }); }
      catch (e) { console.error('restore after tests failed', e); results.push({ name: 'استعادة البيانات بعد الاختبار', ok: false, detail: e.message }); }
      const passed = results.filter(r => r.ok).length;
      return { total: results.length, passed, failed: results.length - passed, ms: Math.round(performance.now() - started), results };
    },
  };
})();
