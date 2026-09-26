/* ==========================================================================
   Feature tests — store pack: WhatsApp invoice text, cheques (incoming/outgoing
   lifecycles with GL/AR/AP checks), due reminders, supplier aging, analytics
   (runs inside ERP.tests.run — data snapshotted/restored around it)
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  ERP.testSuites = ERP.testSuites || [];
  ERP.testSuites.push((t, h) => {
    const { u, near } = h; const P = ERP.db.collection('products'); const ctx = {};
    const mkProduct = (code, { stock = 50, cost = 10, price = 25, cat = 'cat_other' } = {}) => { const p = P.insert({ code, name: 'صنف ' + code, categoryId: cat, unitId: 'un_pc', cost, price, stock: 0, stockByWh: {}, batches: [], minStock: 0, taxRate: 0, active: true }); const mv = ERP.inventory.move({ productId: p.id, warehouseId: ERP.inventory.defaultWh(), qty: stock, type: 'opening', unitCost: cost, refType: 'opening', note: 'test' }); if (mv) ERP.accounting.postOpeningStock(u.round(mv.value)); return P.get(p.id); };
    const ensureShift = () => ERP.shifts.current() || ERP.shifts.open({ openingCash: 0 });
    const tbOk = () => { const tb = ERP.accounting.trialBalance(); if (!near(tb.totalDebit, tb.totalCredit)) throw new Error(`TB ${tb.totalDebit} ≠ ${tb.totalCredit}`); };
    const bal = sys => ERP.accounting.balance(sys);
    const custSum = () => u.round(u.sum(ERP.crm.all(), 'balance')), supSum = () => u.round(u.sum(ERP.purchasing.suppliers(), 'balance'));
    const snapAR = () => ({ ar: bal('ar'), cs: custSum() }), snapAP = () => ({ ap: bal('ap'), ss: supSum() });
    const arOk = s0 => { const dA = bal('ar') - s0.ar, dC = custSum() - s0.cs; if (!near(dA, dC)) throw new Error(`AR Δ ${dA} ≠ customers Δ ${dC}`); };
    const apOk = s0 => { const dA = bal('ap') - s0.ap, dS = supSum() - s0.ss; if (!near(dA, dS)) throw new Error(`AP Δ ${dA} ≠ suppliers Δ ${dS}`); };
    // GL inventory − valuation must not drift during this suite (earlier suites may leave a constant gap)
    const gap = () => bal('inventory') - ERP.inventory.valuation().totalValue;
    const invOk = () => { if (ctx.gap0 === undefined) return; if (!near(gap(), ctx.gap0, 0.05)) throw new Error(`GL inventory − valuation drifted: ${u.fmtNum(ctx.gap0)} → ${u.fmtNum(gap())}`); };

    /* ---------------- A) WhatsApp invoice text ---------------- */
    t('إرسال الفاتورة: نص الرسالة (قص الأصناف، الباقي، الرصيد والنقاط)', () => {
      ctx.gap0 = gap();
      const IS = ERP.invoiceShare; if (!IS) throw new Error('ERP.invoiceShare missing');
      const s = { ...ERP.settings.all(), storeName: 'متجر الاختبار', branchName: '', loyaltyEnabled: true, invShareLines: true, invShareMaxLines: 25, invShareHeader: '', invShareFooter: 'شكراً {customer} — {no}' };
      const items = u.range(30).map(i => ({ name: `صنف ${i + 1}`, qty: 2, price: 5, total: 10 }));
      const sale = { no: 'INV-T1', type: 'sale', date: u.now(), items, subtotal: 300, discount: 20, tax: 0, total: 280, payments: [{ method: 'cash', amount: 300 }], change: 20, due: 0, loyaltyEarned: 28, customerId: 'c1', customerName: 'أحمد' };
      const cust = { id: 'c1', name: 'أحمد', balance: 120, loyaltyPoints: 40 };
      const txt = IS.buildText(sale, { s, customer: cust, etaUrl: '' });
      const bullets = txt.split('\n').filter(l => l.startsWith('• ')).length;
      if (bullets !== 25 || !txt.includes('و 5 أصناف أخرى')) throw new Error(`bullets ${bullets}`);
      for (const need of ['*متجر الاختبار*', 'INV-T1', `الخصم: -${u.fmtMoney(20)}`, `*الإجمالي: ${u.fmtMoney(280)}*`, `المدفوع: ${u.fmtMoney(300)}`, `الباقي لكم: ${u.fmtMoney(20)}`, `رصيد حسابكم المستحق: ${u.fmtMoney(120)}`, 'نقاط الولاء: 40 (+28', 'شكراً أحمد — INV-T1']) if (!txt.includes(need)) throw new Error('missing: ' + need);
      if (txt.includes('المتبقي (آجل)')) throw new Error('due shown on a paid sale');
      // credit sale: due + no lines + ETA link + credit balance wording
      const cr = { ...sale, no: 'INV-T2', payments: [{ method: 'credit', amount: 0, isCredit: true }], change: 0, due: 280, items: items.slice(0, 3) };
      const t2 = IS.buildText(cr, { s: { ...s, invShareLines: false }, customer: { ...cust, balance: -15, loyaltyPoints: 0 }, etaUrl: 'https://invoicing.eta.gov.eg/receipts/search/X' });
      if (t2.includes('• ') || !t2.includes('عدد الأصناف: 3') || !t2.includes(`المتبقي (آجل): ${u.fmtMoney(280)}`) || t2.includes('المدفوع:')) throw new Error('credit sale text');
      if (!t2.includes(`رصيد دائن لكم: ${u.fmtMoney(15)}`) || !t2.includes('eta.gov.eg')) throw new Error('balance / ETA link');
      // walk-in: no customer lines at all
      const t3 = IS.buildText({ ...sale, customerId: null }, { s, customer: null, etaUrl: '' });
      if (t3.includes('رصيد') || t3.includes('نقاط')) throw new Error('walk-in shows balance/points');
      return `${txt.split('\n').length} سطر · 25 صنف + «و 5 أصناف أخرى»`;
    });

    /* ---------------- B) cheques ---------------- */
    t('الشيكات: حسابات النظام وطرق الدفع المخفية موجودة', () => {
      ERP.cheques.ensure();
      const a = ERP.accounting.bySys('cheques_in'), b = ERP.accounting.bySys('notes_payable');
      if (a.type !== 'asset' || b.type !== 'liability') throw new Error('account types');
      const pm = ERP.db.collection('paymentMethods'); if (!pm.get('cheque') || !pm.get('cheque_out') || ERP.sales.methods().some(m => m.id === 'cheque')) throw new Error('methods');
      return `${a.code} ${a.name} · ${b.code} ${b.name}`;
    });

    t('شيك وارد: استلام ← تحصيل (العملاء ↓، شيكات تحت التحصيل ثم البنك)', () => {
      const s0 = snapAR(), q0 = bal('cheques_in'), bank0 = bal('bank');
      ctx.cust = ERP.crm.create({ name: 'عميل شيكات', phone: '01000000777', openingBalance: 1000 });
      const ch = ERP.cheques.receive({ customerId: ctx.cust.id, amount: 600, number: 'T-1001', bank: 'بنك مصر', dueDate: u.toISODate(u.addDays(new Date(), 10)) });
      if (ch.status !== 'safe' || !near(ERP.crm.get(ctx.cust.id).balance, 400) || !near(bal('cheques_in') - q0, 600)) throw new Error(`after receive: bal ${ERP.crm.get(ctx.cust.id).balance} chq Δ ${bal('cheques_in') - q0}`);
      let dupThrew = false; try { ERP.cheques.receive({ customerId: ctx.cust.id, amount: 1, number: 'T-1001', bank: 'بنك مصر', dueDate: u.todayISO() }); } catch { dupThrew = true; }
      if (!dupThrew) throw new Error('duplicate cheque accepted');
      tbOk(); arOk(s0);
      ERP.cheques.deposit(ch.id, { bank: 'بنك مصر' });
      const c2 = ERP.cheques.collect(ch.id, {});
      if (c2.status !== 'collected' || !near(bal('cheques_in'), q0) || !near(bal('bank') - bank0, 600)) throw new Error(`after collect: chq ${bal('cheques_in')} bank Δ ${bal('bank') - bank0}`);
      let threw = false; try { ERP.cheques.collect(ch.id); } catch { threw = true; } if (!threw) throw new Error('collected twice');
      tbOk(); arOk(s0);
      return `رصيد العميل ${u.fmtNum(ERP.crm.get(ctx.cust.id).balance)} · البنك +600 · ${c2.history.length} حالات`;
    });

    t('شيك وارد: استلام ← ارتداد (تعود الفاتورة مفتوحة ورصيد العميل)', () => {
      ensureShift(); ctx.p = mkProduct('STR-001');
      const s0 = snapAR(), q0 = bal('cheques_in');
      const c = ERP.crm.create({ name: 'عميل شيك مرتد', phone: '01000000778' });
      const sale = ERP.sales.create({ cart: [{ productId: ctx.p.id, name: ctx.p.name, qty: 20, price: 25 }], customerId: c.id, payments: [{ method: 'credit', amount: 0 }] });
      if (!near(ERP.crm.get(c.id).balance, 500)) throw new Error('credit sale balance');
      const ch = ERP.cheques.receive({ customerId: c.id, amount: 500, number: 'T-2001', bank: 'CIB', dueDate: u.todayISO() });
      const paidSale = ERP.sales.get(sale.id); if (paidSale.status !== 'paid' || !near(ERP.crm.get(c.id).balance, 0)) throw new Error(`receipt allocation ${paidSale.status}`);
      ERP.cheques.deposit(ch.id);
      const b = ERP.cheques.bounce(ch.id, { reason: 'رصيد غير كافٍ' });
      const s2 = ERP.sales.get(sale.id);
      if (b.status !== 'bounced' || !near(ERP.crm.get(c.id).balance, 500) || !near(s2.due, 500) || s2.status !== 'unpaid') throw new Error(`after bounce: bal ${ERP.crm.get(c.id).balance} due ${s2.due} ${s2.status}`);
      if (!near(bal('cheques_in'), q0) || ERP.db.collection('payments').get(ch.receiptId)) throw new Error('cheques_in / receipt not reversed');
      const jr = ERP.accounting.entries({ refType: 'cheque' }).filter(j => j.refId === ch.id); if (jr.length !== 2) throw new Error(`journal story ${jr.length}`);
      let threw = false; try { ERP.cheques.collect(ch.id); } catch { threw = true; } if (!threw) throw new Error('collected a bounced cheque');
      tbOk(); arOk(s0); invOk();
      return `الفاتورة ${s2.no} عادت «غير مدفوعة» · رصيد العميل ${u.fmtNum(ERP.crm.get(c.id).balance)} · ${jr.length} قيود على الشيك`;
    });

    t('شيك وارد: تحصيل ثم ارتداد من البنك يعكس التحصيل أيضاً', () => {
      const s0 = snapAR(), q0 = bal('cheques_in'), bank0 = bal('bank');
      const c = ERP.crm.create({ name: 'عميل تحصيل ثم ارتداد', openingBalance: 300 });
      const ch = ERP.cheques.receive({ customerId: c.id, amount: 300, number: 'T-2002', dueDate: u.todayISO() });
      ERP.cheques.collect(ch.id); ERP.cheques.bounce(ch.id, { reason: 'ارتد بعد التحصيل' });
      if (!near(ERP.crm.get(c.id).balance, 300) || !near(bal('bank'), bank0) || !near(bal('cheques_in'), q0)) throw new Error(`bal ${ERP.crm.get(c.id).balance} bank Δ ${bal('bank') - bank0}`);
      tbOk(); arOk(s0);
      return 'البنك والعميل رجعا كما كانا';
    });

    t('شيك صادر: إصدار ← صرف (الموردين ↓، أوراق الدفع ثم البنك)', () => {
      const s0 = snapAP(), n0 = bal('notes_payable'), bank0 = bal('bank');
      ctx.sup = ERP.purchasing.createSupplier({ name: 'مورد شيكات', openingBalance: 2000, paymentTerms: 30 });
      const ch = ERP.cheques.issue({ supplierId: ctx.sup.id, amount: 1500, number: 'O-3001', bank: 'البنك الأهلي', dueDate: u.toISODate(u.addDays(new Date(), 2)) });
      if (ch.status !== 'issued' || !near(ERP.purchasing.supplier(ctx.sup.id).balance, 500) || !near(bal('notes_payable') - n0, 1500)) throw new Error(`issue: bal ${ERP.purchasing.supplier(ctx.sup.id).balance} NP Δ ${bal('notes_payable') - n0}`);
      tbOk(); apOk(s0);
      ERP.cheques.clear(ch.id);
      if (!near(bal('notes_payable'), n0) || !near(bank0 - bal('bank'), 1500)) throw new Error('clear');
      tbOk(); apOk(s0);
      return `المستحق للمورد ${u.fmtNum(ERP.purchasing.supplier(ctx.sup.id).balance)} · البنك −1500`;
    });

    t('شيك صادر: إصدار ← ارتداد / إلغاء (يعود المستحق للمورد وتُفتح فواتيره)', () => {
      const s0 = snapAP(), n0 = bal('notes_payable');
      const sup = ERP.purchasing.createSupplier({ name: 'مورد شيك مرتد', paymentTerms: 15 });
      const p = ctx.p || mkProduct('STR-002');
      const po = ERP.purchasing.create({ supplierId: sup.id, items: [{ productId: p.id, name: p.name, qty: 10, cost: 40 }] });
      ERP.purchasing.receive(po.id);
      if (!near(ERP.purchasing.supplier(sup.id).balance, 400)) throw new Error('bill');
      const ch = ERP.cheques.issue({ supplierId: sup.id, amount: 400, number: 'O-3002', dueDate: u.todayISO() });
      if (!near(ERP.purchasing.order(po.id).due, 0)) throw new Error('PO not settled by the cheque');
      ERP.cheques.bounce(ch.id, { reason: 'ارتد' });
      if (!near(ERP.purchasing.supplier(sup.id).balance, 400) || !near(ERP.purchasing.order(po.id).due, 400) || !near(bal('notes_payable'), n0) || ERP.db.collection('payments').get(ch.paymentId)) throw new Error(`bounce: bal ${ERP.purchasing.supplier(sup.id).balance} due ${ERP.purchasing.order(po.id).due}`);
      tbOk(); apOk(s0);
      const ch2 = ERP.cheques.issue({ supplierId: sup.id, amount: 100, number: 'O-3003', dueDate: u.todayISO() });
      ERP.cheques.cancel(ch2.id, { reason: 'خطأ إدخال' });
      if (ERP.cheques.get(ch2.id).status !== 'cancelled' || !near(ERP.purchasing.supplier(sup.id).balance, 400) || !near(bal('notes_payable'), n0)) throw new Error('cancel');
      tbOk(); apOk(s0); invOk();
      return `المستحق ${u.fmtNum(ERP.purchasing.supplier(sup.id).balance)} · أوراق الدفع بلا رصيد متبقٍ`;
    });

    t('الاستحقاقات: كشف الشيكات المستحقة قريباً والمتأخرة', () => {
      const today = '2026-06-15';
      const list = [
        { id: 'a', dir: 'in', status: 'safe', dueDate: '2026-06-10', amount: 1 }, { id: 'b', dir: 'in', status: 'collecting', dueDate: '2026-06-17', amount: 1 },
        { id: 'c', dir: 'out', status: 'issued', dueDate: '2026-06-18', amount: 1 }, { id: 'd', dir: 'out', status: 'issued', dueDate: '2026-06-19', amount: 1 },
        { id: 'e', dir: 'in', status: 'collected', dueDate: '2026-06-12', amount: 1 }, { id: 'f', dir: 'out', status: 'cleared', dueDate: '2026-06-16', amount: 1 }, { id: 'g', dir: 'in', status: 'bounced', dueDate: '2026-06-01', amount: 1 },
      ];
      const d = ERP.cheques.due({ days: 3, today, list });
      if (d.map(x => x.cheque.id).join('') !== 'abc') throw new Error('due set ' + d.map(x => x.cheque.id).join(''));
      if (!d[0].overdue || d[0].daysLeft !== -5 || d[1].overdue || d[1].daysLeft !== 2 || d[2].daysLeft !== 3) throw new Error('flags');
      ERP.cheques.notify(); // must not throw with live data
      return `${d.length} مستحقة (1 متأخر 5 أيام)`;
    });

    t('أعمار ديون الموردين: الفئات 0-30/31-60/61-90/+90 والمتأخر حسب مدة السداد', () => {
      const today = '2026-06-30'; const PO = ERP.db.collection('purchases');
      const sup = ERP.purchasing.createSupplier({ name: 'مورد أعمار', paymentTerms: 30 });
      const p = ctx.p || mkProduct('STR-003');
      const bill = (cost, date) => { const po = ERP.purchasing.create({ supplierId: sup.id, items: [{ productId: p.id, name: p.name, qty: 1, cost }] }); ERP.purchasing.receive(po.id); PO.update(po.id, { receivedAt: date + 'T10:00:00.000Z', date: date + 'T09:00:00.000Z' }); return po; };
      bill(300, '2026-03-01'); bill(500, '2026-05-10'); bill(1000, '2026-06-20');
      let r = ERP.cheques.aging({ today, supplierIds: [sup.id] }).rows[0];
      if (!r || !near(r.balance, 1800) || !near(r.b0, 1000) || !near(r.b31, 500) || !near(r.b61, 0) || !near(r.b91, 300)) throw new Error(`buckets ${r && [r.b0, r.b31, r.b61, r.b91]}`);
      if (!near(r.overdue, 800)) throw new Error(`overdue ${r.overdue}`); // 05-10 (+30 = 06-09) and 03-01 are past due; 06-20 due 07-20
      const db = ERP.cheques.dueBills({ days: 3, today }).filter(x => x.supplier.id === sup.id);
      if (db.length !== 2 || !db.every(x => x.overdue)) throw new Error(`dueBills ${db.length}`);
      if (ERP.purchasing.dueDate(ERP.purchasing.orders().find(o => o.supplierId === sup.id && o.total === 1000)) !== '2026-07-20') throw new Error('purchasing.dueDate');
      ERP.purchasing.paySupplier({ supplierId: sup.id, amount: 1000 }); // FIFO settles the two oldest + 200 of the newest
      r = ERP.cheques.aging({ today, supplierIds: [sup.id] }).rows[0];
      if (!near(r.balance, 800) || !near(r.b0, 800) || !near(r.b31 + r.b61 + r.b91, 0) || !near(r.overdue, 0)) throw new Error(`after pay ${[r.b0, r.b31, r.b91, r.overdue]}`);
      const tot = ERP.cheques.aging({ today }).totals; if (!near(tot.b0 + tot.b31 + tot.b61 + tot.b91, tot.balance)) throw new Error('totals ≠ balance');
      return `0-30: ${u.fmtNum(1000)} · 31-60: ${u.fmtNum(500)} · +90: ${u.fmtNum(300)} → بعد السداد 0-30: ${u.fmtNum(r.b0)}`;
    });

    /* ---------------- C) analytics ---------------- */
    t('تحليل ABC: حدود 80% / 95%', () => {
      const rows = [50, 30, 10, 5, 3, 2, 0].map((v, i) => ({ productId: 'x' + i, name: 'x' + i, total: v, profit: v / 2 }));
      const r = ERP.analytics.abcClassify(rows, 'total');
      const cls = r.rows.map(x => x.cls).join('');
      if (cls !== 'AABBCCC' || r.summary.A.count !== 2 || r.summary.B.count !== 2 || r.summary.C.count !== 3) throw new Error('classes ' + cls);
      if (!near(r.summary.A.value, 80) || !near(r.summary.B.value, 15) || !near(r.summary.C.value, 5)) throw new Error('shares');
      const one = ERP.analytics.abcClassify([{ total: 10 }], 'total'); if (one.rows[0].cls !== 'A') throw new Error('single item');
      return `A=2 (80%) · B=2 (15%) · C=3 (5%)`;
    });

    t('الربحية حسب الفئة: إيراد، تكلفة، ربح، هامش، كمية أساسية', () => {
      ensureShift();
      const a = mkProduct('STR-F1', { cost: 6, price: 10, cat: 'cat_food' }), b = mkProduct('STR-F2', { cost: 4, price: 8, cat: 'cat_food' }), c = mkProduct('STR-D1', { cost: 15, price: 20, cat: 'cat_drinks' });
      ERP.sales.create({ cart: [{ productId: a.id, name: a.name, qty: 10, price: 10 }, { productId: b.id, name: b.name, qty: 5, price: 8 }, { productId: c.id, name: c.name, qty: 4, price: 20 }], payments: [{ method: 'cash', amount: 220 }] });
      ERP.sales.create({ cart: [{ productId: c.id, name: c.name, qty: 1, price: 20 }], payments: [{ method: 'cash', amount: 20 }] });
      const today = u.todayISO(); const mine = new Set([a.id, b.id, c.id]);
      const rows = ERP.analytics.productTotals(today, today).filter(r => mine.has(r.productId));
      const pf = ERP.analytics.profitability({ rows, by: 'category' });
      const food = pf.find(x => x.id === 'cat_food'), drinks = pf.find(x => x.id === 'cat_drinks');
      if (!food || !near(food.revenue, 140) || !near(food.cogs, 80) || !near(food.profit, 60) || !near(food.margin, 42.9, 0.05) || !near(food.qty, 15, 0.001) || food.products !== 2) throw new Error(`food ${JSON.stringify(food)}`);
      if (!drinks || !near(drinks.revenue, 100) || !near(drinks.cogs, 75) || !near(drinks.profit, 25) || !near(drinks.margin, 25) || !near(drinks.qty, 5, 0.001)) throw new Error(`drinks ${JSON.stringify(drinks)}`);
      ctx.fast = a; ctx.slow = mkProduct('STR-S1', { stock: 12, cost: 7 });
      invOk(); tbOk();
      return `أغذية: ${u.fmtNum(food.profit)} (${food.margin}%) · مشروبات: ${u.fmtNum(drinks.profit)} (${drinks.margin}%)`;
    });

    t('الأصناف الراكدة والفاقد: بلا مبيعات منذ N يوم + قيمة الهالك', () => {
      const res = ERP.analytics.slowMoving({ days: 30, products: [P.get(ctx.fast.id), P.get(ctx.slow.id)] });
      if (res.length !== 1 || res[0].product.id !== ctx.slow.id || !near(res[0].value, 84) || res[0].lastSale !== null || res[0].daysOfCover !== null) throw new Error(`slow ${res.map(r => r.product.name)}`);
      if (ERP.analytics.lastSold()[ctx.fast.id] !== u.todayISO()) throw new Error('lastSold');
      const today = u.todayISO(); const before = ERP.analytics.shrinkage({ from: today, to: today }).total;
      ERP.inventory.waste({ productId: ctx.slow.id, warehouseId: ERP.inventory.defaultWh(), qty: 2, reason: 'تالف' });
      const sh = ERP.analytics.shrinkage({ from: today, to: today }); const row = sh.rows.find(r => r.productId === ctx.slow.id);
      if (!row || !near(row.waste, 14) || !near(row.qty, 2, 0.001) || !near(sh.total - before, 14)) throw new Error(`shrinkage ${row && row.waste}`);
      const hm = ERP.analytics.heatmap(today, today); if (!(hm.max > 0)) throw new Error('heatmap empty');
      invOk(); tbOk();
      return `راكد: ${res[0].product.name} (${u.fmtNum(res[0].value)}) · هالك ${u.fmtNum(row.waste)}`;
    });
  });
})();
