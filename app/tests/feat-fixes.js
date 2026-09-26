/* ==========================================================================
   Feature tests — fixes pack: expiry batches (FEFO skips expired, sale lines keep
   batchAlloc so returns / voids / purchase returns restore the right batches,
   clearance ↔ consumption agree), cheque-linked receipts / payments cannot be
   deleted directly, license branch limit, analytics NET revenue reconciles with
   the sales report, GL inventory = valuation EXACTLY after awkward costs
   (runs inside ERP.tests.run — data snapshotted/restored around it)
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  ERP.testSuites = ERP.testSuites || [];
  ERP.testSuites.push((t, h) => {
    const { u, near } = h; const P = ERP.db.collection('products'); const A = ERP.accounting; const ctx = {};
    const wh = () => ERP.inventory.defaultWh();
    const day = n => u.toISODate(u.addDays(new Date(), n));
    const ensureShift = () => ERP.shifts.current() || ERP.shifts.open({ openingCash: 0 });
    const tbOk = () => { const tb = A.trialBalance(); if (!near(tb.totalDebit, tb.totalCredit)) throw new Error(`TB ${tb.totalDebit} ≠ ${tb.totalCredit}`); };
    const gap = () => A.balance('inventory') - ERP.inventory.valuation().totalValue;
    const exact = (label = '') => { if (Math.abs(gap() - ctx.gap0) > 0.001) throw new Error(`${label} GL مخزون − التقييم: ${u.round(gap() - ctx.gap0, 4)}`); };
    const withSettings = async (patch, fn) => { const keep = {}; Object.keys(patch).forEach(k => { keep[k] = ERP.settings.get(k); }); ERP.settings.set(patch); try { return await fn(); } finally { ERP.settings.set(keep); } };
    const bq = (p, no) => u.round(u.sum((P.get(p.id).batches || []).filter(b => b.batchNo === no), 'qty'), 3);
    /** expiry-tracked product with opening batches [{no, expiry, qty}] (GL posted at the move values) */
    const mkBatched = (code, batches, { cost = 5, price = 10 } = {}) => {
      const p = P.insert({ code, name: 'صنف ' + code, categoryId: 'cat_other', unitId: 'un_pc', cost, price, stock: 0, stockByWh: {}, batches: [], minStock: 0, taxRate: 0, trackExpiry: true, active: true });
      batches.forEach(b => { const mv = ERP.inventory.move({ productId: p.id, warehouseId: wh(), qty: b.qty, type: 'opening', unitCost: cost, refType: 'opening', note: 't', batch: { batchNo: b.no, expiry: b.expiry } }); A.postOpeningStock(mv.value); });
      return P.get(p.id);
    };
    const sell = (p, qty, extra = {}) => ERP.sales.create({ cart: [{ productId: p.id, name: p.name, qty, price: p.price }], payments: [{ method: 'cash', amount: u.round(qty * p.price) }], warehouseId: wh(), ...extra });

    /* ---------------- 1) expiry batches ---------------- */
    t('الصلاحية: FEFO يتخطى الدفعات المنتهية ويسجّل الدفعات المستهلكة على سطر الفاتورة', () => {
      ctx.gap0 = gap(); ensureShift();
      const p = ctx.bp = mkBatched('FX-B1', [{ no: 'EXP', expiry: day(-3), qty: 4 }, { no: 'SOON', expiry: day(5), qty: 3 }, { no: 'LATE', expiry: day(60), qty: 10 }]);
      const s = ctx.s1 = sell(p, 5);
      if (bq(p, 'EXP') !== 4 || bq(p, 'SOON') !== 0 || bq(p, 'LATE') !== 8) throw new Error(`batches EXP ${bq(p, 'EXP')} SOON ${bq(p, 'SOON')} LATE ${bq(p, 'LATE')}`);
      const al = s.items[0].batchAlloc || [];
      if (al.length !== 2 || al[0].batchNo !== 'SOON' || al[0].qty !== 3 || al[1].batchNo !== 'LATE' || al[1].qty !== 2) throw new Error('batchAlloc ' + JSON.stringify(al));
      // write-off of the expired batch names it explicitly (FEFO would otherwise take the fresh batch)
      const w = ERP.clearance.writeOffExpired({ productIds: [p.id] });
      if (w.count !== 1 || bq(p, 'EXP') !== 0 || bq(p, 'LATE') !== 8) throw new Error(`write-off count ${w.count} EXP ${bq(p, 'EXP')} LATE ${bq(p, 'LATE')}`);
      exact(); tbOk();
      return 'بيع 5 من (منتهي 4 · قريب 3 · بعيد 10) → قريب 3 + بعيد 2، المنتهي لم يُمس · شطب المنتهي يأخذ دفعته هو';
    });

    t('الصلاحية: مرتجع كامل يعيد الكميات لنفس الدفعات', () => {
      const p = ctx.bp;
      ERP.sales.createReturn({ saleId: ctx.s1.id, lines: [{ productId: p.id, qty: 5 }], refundMethod: 'cash' });
      if (bq(p, 'SOON') !== 3 || bq(p, 'LATE') !== 10) throw new Error(`after return SOON ${bq(p, 'SOON')} LATE ${bq(p, 'LATE')}`);
      if (P.get(p.id).stock !== 13) throw new Error('stock ' + P.get(p.id).stock);
      exact(); tbOk();
      return 'قريب 3 · بعيد 10 (كما قبل البيع)';
    });

    t('الصلاحية: مرتجع جزئي (توزيع نسبي) ثم الباقي يعيد الدفعات بالضبط', () => {
      const p = ctx.bp; const s = sell(p, 6); // SOON 3 + LATE 3
      ERP.sales.createReturn({ saleId: s.id, lines: [{ productId: p.id, qty: 2 }], refundMethod: 'cash' });
      if (bq(p, 'SOON') !== 1 || bq(p, 'LATE') !== 8) throw new Error(`partial SOON ${bq(p, 'SOON')} LATE ${bq(p, 'LATE')}`);
      const r2 = ERP.sales.createReturn({ saleId: s.id, lines: [{ productId: p.id, qty: 4 }], refundMethod: 'cash' });
      if (bq(p, 'SOON') !== 3 || bq(p, 'LATE') !== 10) throw new Error(`rest SOON ${bq(p, 'SOON')} LATE ${bq(p, 'LATE')}`);
      if (!(r2.items[0].batchAlloc || []).length) throw new Error('return line without batchAlloc');
      exact(); tbOk();
      return 'بيع 6 (3+3) → مرتجع 2 = 1+1 → مرتجع 4 = 2+2';
    });

    t('الصلاحية: إلغاء الفاتورة يعيد الدفعات', () => {
      const p = ctx.bp; const s = sell(p, 4);
      if (bq(p, 'SOON') !== 0 || bq(p, 'LATE') !== 9) throw new Error('sale');
      ERP.sales.void(s.id, 'اختبار');
      if (bq(p, 'SOON') !== 3 || bq(p, 'LATE') !== 10) throw new Error(`void SOON ${bq(p, 'SOON')} LATE ${bq(p, 'LATE')}`);
      exact(); tbOk();
      return 'بيع 4 (3+1) → إلغاء → 3 · 10';
    });

    t('الصلاحية: فاتورة قديمة بلا batchAlloc تُرتجع كالسابق', () => {
      const p = ctx.bp; const s = sell(p, 2);
      const S = ERP.db.collection('sales'); S.update(s.id, { items: S.get(s.id).items.map(({ batchAlloc, ...it }) => it) }); // pre-fix document
      const before = u.round(u.sum(P.get(p.id).batches, 'qty'), 3), st0 = P.get(p.id).stock;
      const r = ERP.sales.createReturn({ saleId: s.id, lines: [{ productId: p.id, qty: 2 }], refundMethod: 'cash' });
      if (!r || P.get(p.id).stock !== st0 + 2) throw new Error('stock');
      if (u.round(u.sum(P.get(p.id).batches, 'qty'), 3) !== before) throw new Error('batches changed for an old sale');
      exact(); tbOk();
      return 'المخزون +2 · الدفعات بلا تغيير (سلوك سابق)';
    });

    t('الصلاحية: مرتجع الشراء يأخذ من دفعة أمر الشراء', () => {
      const sup = ctx.sup = ERP.purchasing.createSupplier({ name: 'مورد اختبار الإصلاحات' });
      const p = ctx.bp; const soon0 = bq(p, 'SOON'), late0 = bq(p, 'LATE');
      const po = ERP.purchasing.create({ supplierId: sup.id, items: [{ productId: p.id, name: p.name, qty: 6, cost: 5, expiry: day(90), batchNo: 'PO-B' }] });
      ERP.purchasing.receive(po.id);
      if (bq(p, 'PO-B') !== 6) throw new Error('received batch ' + bq(p, 'PO-B'));
      ERP.purchasing.returnToSupplier({ supplierId: sup.id, poId: po.id, items: [{ productId: p.id, qty: 4, cost: 5 }] });
      if (bq(p, 'PO-B') !== 2 || bq(p, 'SOON') !== soon0 || bq(p, 'LATE') !== late0) throw new Error(`PO-B ${bq(p, 'PO-B')} SOON ${bq(p, 'SOON')} LATE ${bq(p, 'LATE')}`);
      exact(); tbOk();
      return 'استلام 6 في PO-B → مرتجع 4 من PO-B (وليس الأقرب انتهاءً)';
    });

    t('التصفية: كمية الخصم = الكمية المستهلكة فعلاً من الدفعات القريبة (المنتهية مستبعدة من الاثنين)', () => withSettings({ clearanceEnabled: true, clearanceMode: 'batch', clearanceAllowBelowCost: false, clearanceMinMarginPct: 0, clearanceMaxPct: 60, posDefaultWarehouse: wh() }, () => {
      const p = mkBatched('FX-CL', [{ no: 'X', expiry: day(-1), qty: 5 }, { no: 'N', expiry: day(5), qty: 3 }, { no: 'F', expiry: day(120), qty: 10 }], { cost: 5, price: 10 });
      const cl = ERP.clearance.forCart(p, [{ item: { qty: 5 }, f: 1, gross: 50 }], { wh: wh() });
      if (!cl || cl.units !== 3) throw new Error('clearance units ' + (cl && cl.units));
      const s = sell(p, 5);
      const near5 = u.sum((s.items[0].batchAlloc || []).filter(a => a.batchNo === 'N'), 'qty');
      if (near5 !== cl.units) throw new Error(`consumed near ${near5} ≠ discounted ${cl.units}`);
      if (bq(p, 'X') !== 5) throw new Error('expired batch consumed');
      if (!near(s.items[0].discount, cl.discount)) throw new Error(`line discount ${s.items[0].discount} ≠ clearance ${cl.discount}`);
      exact(); tbOk();
      return `خصم على ${cl.units} وحدة (${u.fmtMoney(cl.discount)}) = المستهلك من الدفعة القريبة · المنتهية 5 كما هي`;
    }));

    /* ---------------- 2) cheques ---------------- */
    t('الشيكات: حذف سند مرتبط بشيك مفتوح/محصّل مرفوض — الإلغاء من شاشة الشيكات يعمل', () => {
      const c = ERP.crm.create({ name: 'عميل شيك الإصلاحات' });
      const ch = ERP.cheques.receive({ customerId: c.id, amount: 150, number: 'FX-9001', bank: 'بنك اختبار', dueDate: day(10) });
      let e1 = null; try { ERP.crm.deleteReceipt(ch.receiptId); } catch (e) { e1 = e; }
      if (!e1 || !/مرتبط بشيك رقم FX-9001/.test(e1.message)) throw new Error('open cheque receipt deleted: ' + (e1 && e1.message));
      if (!ERP.db.collection('payments').get(ch.receiptId)) throw new Error('receipt gone');
      ERP.cheques.collect(ch.id);
      let e2 = null; try { ERP.crm.deleteReceipt(ch.receiptId); } catch (e) { e2 = e; }
      if (!e2) throw new Error('collected cheque receipt deleted');
      // outgoing: supplier payment behind an issued cheque
      const out = ERP.cheques.issue({ supplierId: ctx.sup.id, amount: 20, number: 'FX-OUT-1', dueDate: day(7) });
      let e3 = null; try { ERP.purchasing.deletePayment(out.paymentId); } catch (e) { e3 = e; }
      if (!e3 || !/مرتبط بشيك رقم FX-OUT-1/.test(e3.message)) throw new Error('issued cheque payment deleted');
      ERP.cheques.cancel(out.id, { reason: 'اختبار' });
      if (ERP.db.collection('payments').get(out.paymentId) || ERP.cheques.get(out.id).status !== 'cancelled') throw new Error('cheque cancel did not remove its payment');
      tbOk();
      return 'وارد مفتوح ✗ · محصّل ✗ · صادر ✗ · إلغاء الشيك الصادر يحذف السند ✓';
    });

    /* ---------------- 3) license branch limit ---------------- */
    t('الترخيص: حد الفروع يمنع الفرع N+1 (ترخيص غير تطويري محاكى)', () => {
      const L = ERP.license, B = ERP.branches; const me = B.current().code;
      const known = new Set(B.all().map(b => b.code)); known.add(me);
      if (!/الفروع المسموحة/.test(L.panelHtml())) throw new Error('settings panel missing «الفروع المسموحة»');
      const keep = L._force;
      try {
        L._force = { active: true, branches: known.size + 1 };
        if (L.branchLimit() !== known.size + 1) throw new Error('limit ' + L.branchLimit());
        B.register({ code: 'FX-BR-A', name: 'فرع أ' });
        let e1 = null; try { B.register({ code: 'FX-BR-B', name: 'فرع ب' }); } catch (e) { e1 = e; }
        if (!e1 || e1.code !== 'LICENSE_BRANCHES' || !/الأقصى للفروع/.test(e1.message)) throw new Error('N+1 branch accepted: ' + (e1 && e1.message));
        B.register({ code: 'fx-br-a', name: 'فرع أ معدل' }); // existing branch → update is fine
        // receiving a transfer from an unknown branch is refused BEFORE any stock moves
        const p = ctx.bp, st0 = P.get(p.id).stock;
        let e2 = null; try { B.receiveTransfer({ __type: 'DreamMarketBranchTransfer', id: 'fx-tr-1', no: 'BT-X', toBranch: me, fromBranch: 'FX-BR-C', lines: [{ code: p.code, barcode: '', name: p.name, qty: 2, cost: 5, price: 10 }] }); } catch (e) { e2 = e; }
        if (!e2 || e2.code !== 'LICENSE_BRANCHES' || P.get(p.id).stock !== st0) throw new Error('transfer from N+1 branch received');
        L._force = { active: true }; // trial / license without an explicit test count → limits().branches
        if (L.branchLimit() !== L.limits().branches) throw new Error('forced default limit');
        L._force = null; // self-tests (like dev mode) are never limited
        if (L.branchLimit() !== Infinity) throw new Error('testing must be unlimited');
        B.register({ code: 'FX-BR-B', name: 'فرع ب' });
      } finally { L._force = keep; }
      return `مسموح ${known.size + 1}: الفرع الجديد ✓ · التالي ✗ · تحويل من فرع زائد ✗ · وضع الاختبار بلا حد`;
    });

    /* ---------------- 4) analytics net revenue ---------------- */
    t('التحليلات: صافي الإيراد = صافي تقرير المبيعات (خصم فاتورة + نقاط + مرتجع + ض.ق.م شاملة + توصيل)', () => withSettings({ taxEnabled: true, taxInclusive: true, taxRate: 14, loyaltyEnabled: true, loyaltyRedeemValue: 0.1, loyaltyMinRedeem: 10 }, () => {
      ensureShift();
      const D = '2035-03-15', at = D + 'T12:00:00';
      const mk = (code, cost, price) => { const p = P.insert({ code, name: 'صنف ' + code, categoryId: 'cat_food', unitId: 'un_pc', cost, price, stock: 0, stockByWh: {}, batches: [], minStock: 0, taxRate: 14, active: true }); const mv = ERP.inventory.move({ productId: p.id, warehouseId: wh(), qty: 40, type: 'opening', unitCost: cost, refType: 'opening', note: 't' }); A.postOpeningStock(mv.value); return P.get(p.id); };
      const a = mk('FX-AN1', 6.37, 11.4), b = mk('FX-AN2', 3.11, 7.35);
      const c = ERP.crm.create({ name: 'عميل تحليلات' }); ERP.db.collection('customers').update(c.id, { loyaltyPoints: 500 });
      const s = ERP.sales.create({ cart: [{ productId: a.id, name: a.name, qty: 3, price: 11.4 }, { productId: b.id, name: b.name, qty: 2, price: 7.35 }], customerId: c.id, loyaltyPoints: 50, discount: 5, discountType: 'fixed', deliveryFee: 3, payments: [{ method: 'cash', amount: 100 }], date: at });
      if (!(s.loyaltyDiscount > 0) || !(s.invoiceDiscount > 0) || !(s.tax > 0)) throw new Error(`setup: loyalty ${s.loyaltyDiscount} inv ${s.invoiceDiscount} tax ${s.tax}`);
      const r = ERP.sales.createReturn({ saleId: s.id, lines: [{ productId: a.id, qty: 1 }], refundMethod: 'cash' });
      ERP.db.collection('sales').update(r.id, { date: at }); // same period as the sale
      const rep = ERP.reports.salesSummary(D, D), rec = ERP.analytics.reconcile(D, D);
      const expect = u.round((s.total - s.tax - s.deliveryFee) - (r.total - r.tax));
      if (!near(rep.netSales, expect)) throw new Error(`report netSales ${rep.netSales} ≠ ${expect}`);
      if (Math.abs(rec.diff) > 0.011) throw new Error(`analytics ${rec.revenue} ≠ report ${rec.reportNet}`);
      if (Math.abs(rec.cogsDiff) > 0.011) throw new Error(`cogs ${rec.cogs} ≠ report ${rec.reportCogs}`);
      const rows = ERP.analytics.productTotals(D, D); const lineGross = u.round(u.sum(rows, 'lineTotal'));
      if (near(rec.revenue, lineGross, 0.5)) throw new Error('revenue still equals gross line totals');
      const pf = ERP.analytics.profitability({ from: D, to: D, by: 'category' }); const food = pf.find(x => x.id === 'cat_food');
      if (!food || !near(food.revenue, rec.revenue) || !near(food.profit, u.round(rec.revenue - rec.cogs))) throw new Error('profitability ≠ reconcile');
      const abc = ERP.analytics.abc({ from: D, to: D }); if (!near(abc.total, rec.revenue)) throw new Error('ABC total');
      exact(); tbOk();
      return `صافي ${u.fmtMoney(rec.revenue)} = تقرير ${u.fmtMoney(rec.reportNet)} (إجمالي السطور ${u.fmtMoney(lineGross)}) · ربح ${u.fmtMoney(rec.revenue - rec.cogs)}`;
    }));

    /* ---------------- 5) exact GL inventory = valuation ---------------- */
    t('التقريب: سلسلة مشتريات بتكاليف غريبة + بيع/مرتجع/إلغاء/هالك/جرد/تحويل → حساب المخزون = التقييم بالضبط', async () => {
      ensureShift(); const g0 = gap(); const chk = label => { if (Math.abs(gap() - g0) > 0.001) throw new Error(`${label}: فرق ${u.round(gap() - g0, 4)}`); };
      const sup = ctx.sup; const w = wh();
      const p = P.get(P.insert({ code: 'FX-RND', name: 'صنف تقريب', categoryId: 'cat_other', unitId: 'un_pc', cost: 0, price: 9.99, stock: 0, stockByWh: {}, batches: [], minStock: 0, taxRate: 0, active: true }).id);
      const buy = (qty, cost, discount = 0) => { const po = ERP.purchasing.create({ supplierId: sup.id, items: [{ productId: p.id, name: p.name, qty, cost }], discount }); ERP.purchasing.receive(po.id); return po; };
      const sale = qty => ERP.sales.create({ cart: [{ productId: p.id, name: p.name, qty, price: 9.99 }], payments: [{ method: 'cash', amount: u.round(qty * 9.99) }], warehouseId: w });
      buy(3, 3.333); chk('شراء 3 @ 3.333');
      buy(7, 1.07); chk('شراء 7 @ 1.07');
      const s1 = sale(5); chk('بيع 5');
      buy(11, 2.2229); chk('شراء 11 @ 2.2229');
      const s2 = sale(9); chk('بيع 9');
      ERP.sales.createReturn({ saleId: s2.id, lines: [{ productId: p.id, qty: 2 }], refundMethod: 'cash' }); chk('مرتجع 2');
      buy(13, 0.7777, 1.37); chk('شراء بخصم');
      ERP.sales.void(s1.id, 'اختبار'); chk('إلغاء');
      ERP.inventory.waste({ productId: p.id, warehouseId: w, qty: 1.5, reason: 'اختبار' }); chk('هالك 1.5');
      ERP.purchasing.returnToSupplier({ supplierId: sup.id, items: [{ productId: p.id, qty: 3, cost: 2.5 }] }); chk('مرتجع مورد');
      ERP.inventory.adjust({ productId: p.id, warehouseId: w, newQty: ERP.inventory.whQty(P.get(p.id), w) + 2.333, reason: 'اختبار', unitCost: 1.4141 }); chk('تسوية +');
      ERP.inventory.applyStocktake({ warehouseId: w, lines: [{ productId: p.id, counted: u.round(ERP.inventory.whQty(P.get(p.id), w) - 0.777, 3) }] }); chk('جرد');
      const other = ERP.inventory.warehouses().find(x => x.id !== w) || ERP.db.collection('warehouses').insert({ name: 'مخزن اختبار التقريب', code: 'RND' });
      ERP.inventory.transfer({ fromWh: w, toWh: other.id, lines: [{ productId: p.id, qty: 3.3 }] }); chk('تحويل');
      await withSettings({ posAllowNegativeStock: true }, () => { const st = P.get(p.id).stock; sale(Math.ceil(st) + 4); chk('بيع بالسالب'); buy(17, 1.2345); chk('شراء على رصيد سالب'); });
      for (let i = 0; i < 12; i++) { buy(1 + (i % 5), u.round(0.37 + i * 0.4131, 4)); sale(1 + ((i * 7) % 3)); }
      chk('12 دورة شراء/بيع');
      exact(); tbOk();
      return `تكلفة متوسطة ${u.fmtNum(P.get(p.id).cost, 4)} · رصيد ${u.fmtQty(P.get(p.id).stock)} · الفرق 0`;
    });
  });
})();

/* inactive products that still hold stock stay in the valuation (their value is still in GL inventory) */
ERP.testSuites.push((t, h) => {
  t('صنف غير نشط وعليه رصيد: يظل في تقييم المخزون (المخزون = التقييم)', () => {
    const P = ERP.db.collection('products'), A = ERP.accounting;
    const p = P.insert({ code: 'FX-INACT', name: 'صنف موقوف', categoryId: 'cat_other', unitId: 'un_pc', cost: 0, price: 9, stock: 0, stockByWh: {}, batches: [], active: true, taxRate: 0 });
    ERP.inventory.move({ productId: p.id, warehouseId: ERP.inventory.defaultWh(), qty: 7, type: 'opening', unitCost: 3, refType: 'opening', note: 'test' }); A.postOpeningStock(21);
    const g0 = h.u.round(A.balance('inventory') - ERP.inventory.valuation().totalValue);
    P.update(p.id, { active: false });
    const g1 = h.u.round(A.balance('inventory') - ERP.inventory.valuation().totalValue);
    if (Math.abs(g1 - g0) > 0.001) throw new Error(`gap moved ${g0} → ${g1} after deactivating`);
    if (!ERP.inventory.valuation().rows.some(r => r.product.id === p.id)) throw new Error('inactive product with stock missing from valuation');
    return 'الصنف الموقوف (7 × 3 = 21) ما زال في التقييم';
  });
});
