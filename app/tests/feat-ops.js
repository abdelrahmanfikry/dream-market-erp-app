/* ==========================================================================
   Feature tests — ops pack: cash denomination count, mobile stocktake merge,
   ETA e-receipt (canonical serialization, UUID, receipt JSON, return chain)
   (runs inside ERP.tests.run — data snapshotted/restored around it)
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  ERP.testSuites = ERP.testSuites || [];
  ERP.testSuites.push((t, h) => {
    const { u, near } = h; const P = ERP.db.collection('products'); const ctx = {};
    const mkProduct = (code, barcode, stock = 50, price = 25) => { const p = P.insert({ code, name: 'صنف ' + code, categoryId: 'cat_other', unitId: 'un_pc', cost: 10, price, stock: 0, stockByWh: {}, batches: [], minStock: 0, taxRate: 0, active: true, barcode }); ERP.inventory.move({ productId: p.id, warehouseId: ERP.inventory.defaultWh(), qty: stock, type: 'opening', unitCost: 10, refType: 'opening', note: 'test' }); return P.get(p.id); };
    const openShift = (cash = 100) => { const cur = ERP.shifts.current(); if (cur) ERP.shifts.close(cur.id, { closingCash: ERP.shifts.expected(cur) }); return ERP.shifts.open({ openingCash: cash }); };

    /* ---------------- A) cash denomination count ---------------- */
    t('عدّ النقدية: مجموع الفئات والفرق', () => {
      const cc = ERP.cashcount; if (!cc) throw new Error('ERP.cashcount missing');
      const r = cc.sum({ lines: [{ denom: 200, count: 2 }, { denom: 50, count: 3 }, { denom: 0.5, count: 5 }, { denom: 0.25, count: 3 }, { denom: 10, count: 0 }], extra: 1.1 });
      if (!near(r.total, 400 + 150 + 2.5 + 0.75 + 1.1) || r.lines.length !== 4) throw new Error(`total ${r.total} lines ${r.lines.length}`);
      if (!near(cc.variance(r.total, 560), -5.65)) throw new Error('variance');
      const d = cc.parseDenoms('٢٠٠, 100،0.5 , 100, x, -5');
      if (d.join('|') !== '200|100|0.5') throw new Error('parseDenoms ' + d.join('|'));
      return `${u.fmtNum(r.total)} · فرق ${u.fmtNum(cc.variance(r.total, 560))}`;
    });

    t('عدّ النقدية: عدّ X ثم إغلاق وردية بتفصيل الفئات', () => {
      const sh = openShift(100); ctx.p = mkProduct('OPS-001', '6999999000101');
      ERP.sales.create({ cart: [{ productId: ctx.p.id, name: ctx.p.name, qty: 2, price: 25 }], payments: [{ method: 'cash', amount: 100 }] });
      const exp = ERP.shifts.expected(ERP.db.collection('shifts').get(sh.id));
      const x = ERP.cashcount.record(sh.id, { lines: [{ denom: 100, count: 1 }], extra: exp - 100 });
      if (!near(x.diff, 0) || (ERP.db.collection('shifts').get(sh.id).counts || []).length !== 1) throw new Error('X count not saved');
      const count = { lines: [{ denom: 100, count: 1 }, { denom: 0.25, count: 4 }], extra: u.round(exp - 101 - 10) }; // 10 short
      const c = ERP.shifts.close(sh.id, { closingCash: 999999, count, notes: 'test' }); // count total wins over closingCash
      if (c.status !== 'closed' || !c.closingCount || c.closingCount.lines.length !== 2) throw new Error('breakdown not saved');
      if (!near(c.closingCash, exp - 10) || !near(c.difference, -10) || !near(c.expectedCash, exp)) throw new Error(`cash ${c.closingCash} diff ${c.difference} exp ${c.expectedCash}`);
      const rows = ERP.cashcount.breakdownRows(c.closingCount); if (!rows.includes('إجمالي المعدود')) throw new Error('report rows');
      return `متوقع ${u.fmtNum(exp)} · معدود ${u.fmtNum(c.closingCash)} · فرق ${u.fmtNum(c.difference)}`;
    });

    /* ---------------- B) mobile stocktake ---------------- */
    t('عدّ الموبايل: قراءة ملف JSON و CSV', () => {
      const mc = ERP.mobilecount;
      const j = mc.parse(JSON.stringify({ format: 'dm-count', v: 1, items: [{ code: '111', qty: 2, name: 'A' }, { code: 'CART', qty: 1 }] }));
      const c = mc.parse('﻿barcode,qty,name\n111,2,"أ, ب"\n٢٢٢,٣,x\nEMPTY,,');
      const s = mc.parse('code;qty\nX1;4');
      if (j.length !== 2 || j[0].qty !== 2 || c.length !== 3 || c[1].code !== '222' || c[1].qty !== 3 || c[0].name !== 'أ, ب' || c[2].qty !== 1 || s[0].qty !== 4) throw new Error(JSON.stringify({ j, c, s }));
      return `JSON ${j.length} · CSV ${c.length} · ; ${s.length}`;
    });

    t('عدّ الموبايل: دمج (جمع/استبدال) + باركود الوحدة + الأكواد غير المعروفة', () => {
      const mc = ERP.mobilecount;
      const products = [{ id: 'a', code: 'A1', barcode: '111', units: [{ id: 'ctn', name: 'كرتونة', factor: 12, barcode: 'CART' }] }, { id: 'b', code: 'B1', barcode: '', barcodes: [{ code: 'PK6', qty: 6 }] }];
      const lines = [{ code: '111', qty: 2 }, { code: 'CART', qty: 1 }, { code: 'PK6', qty: 2 }, { code: 'B1', qty: 1 }, { code: 'zzz', qty: 5 }, { code: 'zzz', qty: 1 }, { code: 'SCALE', qty: 1 }];
      const resolve = c => (c === 'SCALE' ? { product: products[0], qty: 0.5 } : null);
      const s = mc.merge({ a: '3' }, lines, { mode: 'sum', products, resolve });
      if (!near(s.counts.a, 3 + 2 + 12 + 0.5, 0.0001) || !near(s.counts.b, 13, 0.0001)) throw new Error('sum ' + JSON.stringify(s.counts));
      if (s.unmatched.length !== 1 || s.unmatched[0].code !== 'zzz' || s.unmatched[0].qty !== 6) throw new Error('unmatched ' + JSON.stringify(s.unmatched));
      const r = mc.merge({ a: 3, c: 7 }, lines, { mode: 'replace', products, resolve });
      if (!near(r.counts.a, 14.5, 0.0001) || !near(r.counts.b, 13, 0.0001) || r.counts.c !== 7) throw new Error('replace ' + JSON.stringify(r.counts));
      // real catalog: unit barcode on a DB product (product.units) → factor × qty base units
      const p = P.insert({ code: 'OPS-MC', name: 'صنف كرتونة', categoryId: 'cat_other', unitId: 'un_pc', cost: 1, price: 2, stock: 0, stockByWh: {}, batches: [], active: true, barcode: '6999999000200', units: [{ id: 'u1', name: 'كرتونة', factor: 24, price: 40, barcode: '6999999000217' }] });
      const d = mc.merge({}, [{ code: '6999999000217', qty: 2 }, { code: '6999999000200', qty: 3 }], { products: P.all(), resolve: ERP.inventory.resolveScan });
      if (!near(d.counts[p.id], 51, 0.0001)) throw new Error('db unit factor ' + d.counts[p.id]);
      return `جمع a=${s.counts.a} b=${s.counts.b} · استبدال a=${r.counts.a} · كرتونة 2×24+3=${d.counts[p.id]} · غير معروف ${s.unmatched.length}`;
    });

    /* ---------------- C) ETA e-receipt ---------------- */
    const saleDoc = (over = {}) => ({ id: 's-test', no: 'INV-T1', type: 'sale', date: '2026-09-25T10:15:30.123Z', items: [{ productId: 'p1', name: 'A', qty: 3, price: 15, discount: 5, taxRate: 14, taxAmount: 5.6, total: 40 }, { productId: 'p2', name: 'B', qty: 1.5, price: 60, discount: 0, taxRate: 14, taxAmount: 12.6, total: 90 }], subtotal: 135, discount: 5, invoiceDiscount: 0, tax: 18.2, total: 148.2, payments: [{ method: 'cash', amount: 150 }], ...over });
    const etaSettings = () => ({ ...ERP.settings.all(), etaRin: '123456789', etaPosSerial: 'POS-T', etaActivityCode: '4711', etaTradeName: 'Test', etaBranchCode: '0', etaGovernate: 'Cairo', etaRegionCity: 'Nasr City', etaStreet: 'St', etaBuildingNumber: '1', etaItemType: 'EGS', etaDefaultUnit: 'EA', etaWeightUnit: 'KGM', taxInclusive: false });
    const is5 = x => Math.abs(Math.round(x * 1e5) / 1e5 - x) < 1e-12;
    const nums = (o, out = []) => { if (typeof o === 'number') out.push(o); else if (o && typeof o === 'object') Object.values(o).forEach(v => nums(v, out)); return out; };

    t('ETA: التسلسل القانوني (canonical serialization)', () => {
      const s = ERP.eta.serialize({ header: { dateTimeIssued: '2026-01-02T03:04:05Z', uuid: '' }, itemData: [{ quantity: 1, taxableItems: [{ taxType: 'T1', rate: 14 }] }, { quantity: 2.5, taxableItems: [] }], exchangeRate: 0 });
      const exp = '"HEADER""DATETIMEISSUED""2026-01-02T03:04:05Z""UUID""""ITEMDATA""ITEMDATA""QUANTITY""1""TAXABLEITEMS""TAXABLEITEMS""TAXTYPE""T1""RATE""14""ITEMDATA""QUANTITY""2.5""TAXABLEITEMS""EXCHANGERATE""0"';
      if (s !== exp) throw new Error(s);
      return s.slice(0, 60) + '…';
    });

    t('ETA: SHA-256 و UUID حتمي', async () => {
      const abc = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
      if (ERP.eta.sha256HexJs('abc') !== abc || await ERP.eta.sha256Hex('abc') !== abc) throw new Error('sha256("abc")');
      const long = 'إيصال ✓ '.repeat(50); if (ERP.eta.sha256HexJs(long) !== await ERP.eta.sha256Hex(long)) throw new Error('js ≠ webcrypto');
      const rc = ERP.eta.buildReceipt(saleDoc(), { settings: etaSettings() });
      const a = await ERP.eta.computeUUID(rc); rc.header.uuid = 'anything'; const b = await ERP.eta.computeUUID(rc);
      rc.header.previousUUID = 'x'; const c = await ERP.eta.computeUUID(rc);
      if (!/^[0-9a-f]{64}$/.test(a) || a !== b || a === c) throw new Error(`${a} / ${b} / ${c}`);
      return a.slice(0, 16) + '…';
    });

    t('ETA: إيصال بيع بخصم سطر وضريبة 14% (إجماليات 5 منازل)', () => {
      const rc = ERP.eta.buildReceipt(saleDoc(), { settings: etaSettings(), products: { p1: { code: 'TST-1' }, p2: { code: 'TST-2', unitId: 'un_kg' } } });
      const l = rc.itemData[0];
      if (rc.documentType.receiptType !== 'S' || rc.documentType.typeVersion !== '1.2' || rc.header.currency !== 'EGP' || rc.header.dateTimeIssued !== '2026-09-25T10:15:30Z') throw new Error('header');
      if (l.itemCode !== 'EG-123456789-TST-1' || rc.itemData[1].unitType !== 'KGM' || l.totalSale !== 45 || l.netSale !== 40 || l.commercialDiscountData[0].amount !== 5 || l.taxableItems[0].amount !== 5.6 || l.taxableItems[0].subType !== 'V009' || !near(l.total, 45.6, 1e-9)) throw new Error('line ' + JSON.stringify(l));
      if (rc.totalSales !== 135 || rc.totalCommercialDiscount !== 5 || rc.netAmount !== 130 || !near(rc.taxTotals[0].amount, 18.2, 1e-9) || !near(rc.totalAmount, 148.2, 1e-9) || rc.paymentMethod !== 'C') throw new Error('totals ' + JSON.stringify({ ts: rc.totalSales, nd: rc.netAmount, ta: rc.totalAmount }));
      // invoice-level discount + awkward prices → still 5-decimal amounts and consistent totals
      const odd = ERP.eta.buildReceipt(saleDoc({ items: [{ productId: 'p1', name: 'A', qty: 3, price: 3.3333333, discount: 0, taxRate: 14, taxAmount: 1.4, total: 10 }, { productId: 'p2', name: 'B', qty: 7, price: 1.4285714, discount: 1, taxRate: 14, taxAmount: 1.26, total: 9 }], invoiceDiscount: 1.9, loyaltyDiscount: 2 }), { settings: etaSettings() });
      if (!nums(odd).every(is5)) throw new Error('not rounded to 5 decimals');
      if (!near(odd.totalCommercialDiscount, 2.9, 1e-4) || !near(odd.netAmount, odd.totalSales - odd.totalCommercialDiscount, 1e-4) || !near(odd.totalAmount, odd.netAmount + odd.taxTotals[0].amount - 2, 1e-4) || odd.extraReceiptDiscountData[0].amount !== 2) throw new Error('odd totals ' + JSON.stringify({ tcd: odd.totalCommercialDiscount, na: odd.netAmount, ta: odd.totalAmount }));
      return `صافي ${rc.netAmount} + ضريبة ${rc.taxTotals[0].amount} = ${rc.totalAmount}`;
    });

    t('ETA: بدون ضريبة، وأسعار شاملة الضريبة', () => {
      const s0 = saleDoc({ items: saleDoc().items.map(i => ({ ...i, taxRate: 0, taxAmount: 0 })), tax: 0, total: 130 });
      const rc = ERP.eta.buildReceipt(s0, { settings: etaSettings() });
      if (rc.taxTotals.length || rc.itemData.some(l => l.taxableItems.length) || rc.totalAmount !== 130 || rc.netAmount !== 130) throw new Error('no-VAT ' + JSON.stringify({ t: rc.taxTotals, ta: rc.totalAmount }));
      const inc = ERP.eta.buildReceipt(saleDoc({ items: [{ productId: 'p1', name: 'A', qty: 2, price: 57, discount: 0, taxRate: 14, taxAmount: 14, total: 114 }], total: 114 }), { settings: etaSettings() }); // inclusive detected from the stored line tax
      const l = inc.itemData[0];
      if (l.unitPrice !== 50 || l.netSale !== 100 || l.taxableItems[0].amount !== 14 || inc.totalAmount !== 114) throw new Error('inclusive ' + JSON.stringify(l));
      return `بدون ضريبة ${rc.totalAmount} · شامل: ${l.unitPrice}+14% → ${inc.totalAmount}`;
    });

    t('ETA: مرتجع وإلغاء يشيران لإيصال البيع (السلسلة previousUUID)', async () => {
      const eta = ERP.eta; const S = ERP.db.collection('sales');
      const ret = eta.buildReceipt({ ...saleDoc(), type: 'return', no: 'RET-T1', refSaleId: 's-test', discount: 5 }, { settings: etaSettings(), referenceUUID: 'f'.repeat(64), previousUUID: 'e'.repeat(64) });
      if (ret.documentType.receiptType !== 'R' || ret.header.referenceUUID !== 'f'.repeat(64) || ret.header.previousUUID !== 'e'.repeat(64)) throw new Error('pure return');
      // live flow: sale → queued receipt; return → 'R' referencing it; void → automatic 'R'
      ERP.settings.set({ etaEnabled: true, etaRin: '123456789', etaPosSerial: 'POS-TEST', etaActivityCode: '4711', etaGovernate: 'Cairo', etaRegionCity: 'Nasr', etaStreet: 'St', etaBuildingNumber: '1', etaClientId: '', etaClientSecret: '' }); // no credentials → nothing is ever submitted
      eta._allowInTests = true;
      try {
        const sh = openShift(0); const p = ctx.p || mkProduct('OPS-001', '6999999000101');
        const head0 = ERP.db.getMeta('etaPrev:POS-TEST') || '';
        const sale = ERP.sales.create({ cart: [{ productId: p.id, name: p.name, qty: 2, price: 25 }], payments: [{ method: 'cash', amount: 100 }] });
        await u.sleep(15); await eta.idle();
        const s1 = S.get(sale.id); const q1 = ERP.db.collection('etaQueue').all().find(q => q.saleId === sale.id);
        if (s1.etaStatus !== 'queued' || !/^[0-9a-f]{64}$/.test(s1.etaUUID || '') || !q1 || q1.receipt.header.previousUUID !== head0 || q1.uuid !== await eta.computeUUID(q1.receipt)) throw new Error('sale not queued ' + JSON.stringify({ st: s1.etaStatus, u: s1.etaUUID }));
        const r = ERP.sales.createReturn({ saleId: sale.id, lines: [{ productId: p.id, qty: 1 }], refundMethod: 'cash', reason: 'test' });
        await u.sleep(15); await eta.idle();
        const qr = ERP.db.collection('etaQueue').all().find(q => q.saleId === r.id);
        if (!qr || qr.receipt.documentType.receiptType !== 'R' || qr.receipt.header.referenceUUID !== s1.etaUUID || qr.receipt.header.previousUUID !== s1.etaUUID) throw new Error('return receipt ' + JSON.stringify(qr && qr.receipt.header));
        const sale2 = ERP.sales.create({ cart: [{ productId: p.id, name: p.name, qty: 1, price: 25 }], payments: [{ method: 'cash', amount: 25 }] });
        await u.sleep(15); await eta.idle();
        ERP.sales.void(sale2.id, 'test'); await u.sleep(15); await eta.idle();
        const v = S.get(sale2.id); const qv = ERP.db.collection('etaQueue').all().find(q => q.saleId === sale2.id && q.kind === 'void');
        if (!qv || v.etaVoidUUID !== qv.uuid || qv.receipt.header.referenceUUID !== v.etaUUID || qv.receipt.header.receiptNumber !== sale2.no + '-V') throw new Error('void receipt');
        const qi = eta.qrInfo(S.get(sale.id)); if (!qi || !qi.url.includes(s1.etaUUID) || !qi.url.includes('IssuerRIN:123456789')) throw new Error('qr url ' + (qi && qi.url));
        ERP.shifts.close(sh.id, { closingCash: ERP.shifts.expected(ERP.db.collection('shifts').get(sh.id)) });
        return `بيع ${s1.etaUUID.slice(0, 8)}… ← مرتجع R ← إلغاء R (${qv.receipt.header.receiptNumber})`;
      } finally { eta._allowInTests = false; }
    });
  });
})();
