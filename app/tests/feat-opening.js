/* Tests: opening balances import (ERP.openingImport) */
window.ERP = window.ERP || {};
ERP.testSuites = ERP.testSuites || [];
ERP.testSuites.push((t, h) => {
  const { u, near } = h;
  const wbOf = sheets => { const wb = XLSX.utils.book_new(); Object.entries(sheets).forEach(([n, rows]) => XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), n)); return wb; };
  const S = () => ERP.openingImport.SHEETS;

  t('الأرصدة الافتتاحية: رفض الأخطاء (كود غير موجود، مدين ودائن معاً، حساب العملاء كرقم واحد، صنف غير موجود)', () => {
    const ar = ERP.accounting.bySys('ar'), cash = ERP.accounting.bySys('cash');
    const pv = ERP.openingImport.parseWorkbook(wbOf({
      [S().gl]: [{ 'كود الحساب': '99999', 'مدين': 10 }, { 'كود الحساب': cash.code, 'مدين': 5, 'دائن': 5 }, { 'كود الحساب': ar.code, 'مدين': 100 }],
      [S().stock]: [{ 'الكود أو الباركود': 'NO-SUCH-CODE', 'الكمية': 3, 'التكلفة': 2 }],
    }));
    if (pv.ok || pv.errors.length !== 4) throw new Error(`errors ${pv.errors.length}: ${pv.errors.join(' | ')}`);
    let threw = false; try { ERP.openingImport.apply(pv); } catch (e) { threw = true; }
    if (!threw) throw new Error('apply accepted a preview with errors');
    return `${pv.errors.length} أخطاء مرفوضة ولا شيء كُتب`;
  });

  t('الأرصدة الافتتاحية: قيود + عملاء + موردين + مخزون → ميزان متوازن، العملاء = المدينين، المخزون = التقييم', () => {
    const A = ERP.accounting, cash = A.bySys('cash'), bank = A.bySys('bank'), cap = A.bySys('capital');
    const p = ERP.db.collection('products').insert({ code: 'OPN-T1', name: 'صنف افتتاحي', categoryId: 'cat_other', unitId: 'un_pc', cost: 0, price: 20, stock: 0, stockByWh: {}, batches: [], active: true, taxRate: 0 });
    const arB = A.balance('ar'), apB = A.balance('ap'), invB = A.balance('inventory'), valB = ERP.inventory.valuation().totalValue;
    const pv = ERP.openingImport.parseWorkbook(wbOf({
      [S().gl]: [{ 'كود الحساب': cash.code, 'مدين': 5000 }, { 'كود الحساب': bank.code, 'مدين': 20000 }, { 'كود الحساب': cap.code, 'دائن': 24000 }], // 1000 difference → opening account
      [S().cust]: [{ 'الاسم': 'عميل افتتاحي أ', 'الهاتف': '01099990001', 'الرصيد': 350, 'حد الائتمان': 1000 }, { 'الاسم': 'عميل افتتاحي ب', 'الرصيد': 150 }],
      [S().supp]: [{ 'الاسم': 'مورد افتتاحي', 'الرصيد': 1200 }],
      [S().stock]: [{ 'الكود أو الباركود': 'OPN-T1', 'الكمية': 24, 'التكلفة': 12.5 }],
    }));
    if (!pv.ok) throw new Error(pv.errors.join(' | '));
    if (!near(pv.totals.diff, 1000) || !near(pv.totals.ar, 500) || !near(pv.totals.ap, 1200) || !near(pv.totals.inv, 300)) throw new Error(JSON.stringify(pv.totals));
    const r = ERP.openingImport.apply(pv, { date: '2026-01-01' });
    const tb = A.trialBalance(); const dr = u.sum(tb.rows, 'debit'), cr = u.sum(tb.rows, 'credit');
    if (!near(dr, cr)) throw new Error(`TB ${dr}/${cr}`);
    if (!near(A.balance('ar') - arB, 500)) throw new Error(`AR Δ ${A.balance('ar') - arB}`);
    if (!near(A.balance('ap') - apB, 1200)) throw new Error(`AP Δ ${A.balance('ap') - apB}`);
    const c = ERP.db.collection('customers').all().find(x => x.name === 'عميل افتتاحي أ');
    if (!c || !near(c.balance, 350) || !near(c.openingBalance, 350) || c.creditLimit !== 1000) throw new Error('customer balance');
    if (ERP.db.collection('products').get(p.id).stock !== 24) throw new Error('stock');
    if (!near(A.balance('inventory') - invB, ERP.inventory.valuation().totalValue - valB) || !near(A.balance('inventory') - invB, 300)) throw new Error('GL inventory ≠ valuation');
    const j = A.entries({ refType: 'opening' }).find(x => x.refId === r.batch);
    if (!j || !j.date.startsWith('2025-12-31') && !j.date.startsWith('2026-01-01')) throw new Error('opening date');
    return `قيد عام + ${r.customers} عميل + ${r.suppliers} مورد + ${r.stock} صنف · الفرق 1000 للأرصدة الافتتاحية · الميزان متوازن`;
  });

  t('استيراد المنتجات بكمية: قيمة المخزون تصل للحسابات', async () => {
    const invB = ERP.accounting.balance('inventory'), valB = ERP.inventory.valuation().totalValue;
    const ws = XLSX.utils.json_to_sheet([{ 'الاسم': 'صنف مستورد اختبار', 'الكود': 'IMP-T1', 'التكلفة': 8, 'السعر': 12, 'الكمية': 10 }]);
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'P');
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
    const r = await ERP.backup.importProducts({ arrayBuffer: async () => buf });
    if (r.added !== 1) throw new Error(`added ${r.added}`);
    const dGL = ERP.accounting.balance('inventory') - invB, dVal = ERP.inventory.valuation().totalValue - valB;
    if (!near(dGL, 80) || !near(dGL, dVal)) throw new Error(`GL Δ ${dGL} / valuation Δ ${dVal}`);
    return 'المخزون +80 في الحسابات = التقييم';
  });
});
