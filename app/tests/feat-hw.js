/* ==========================================================================
   Feature tests — near-expiry clearance pricing, expired write-off, scale parser,
   ZPL / TSPL label builders (no real hardware; data snapshotted/restored by ERP.tests.run)
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  ERP.testSuites = ERP.testSuites || [];
  ERP.testSuites.push((t, h) => {
    const { u, near } = h;
    const P = ERP.db.collection('products');
    const ctx = {};
    const wh = () => ERP.settings.get('posDefaultWarehouse') || ERP.inventory.defaultWh();
    const day = n => u.toISODate(u.addDays(new Date(), n));
    const gap = () => u.round(ERP.accounting.balance('inventory') - ERP.inventory.valuation().totalValue, 2);
    const tb = () => { const x = ERP.accounting.trialBalance(); if (!near(x.totalDebit, x.totalCredit)) throw new Error(`ميزان المراجعة غير متوازن ${x.totalDebit} ≠ ${x.totalCredit}`); };
    const inv = () => { if (!near(gap(), ctx.gap0, 0.05)) throw new Error(`GL مخزون − التقييم تغيّر: ${gap()} (كان ${ctx.gap0})`); };
    const CL = { clearanceEnabled: true, clearanceTiers: ERP.clearance.DEFAULT_TIERS.map(x => ({ ...x })), clearanceMaxPct: 60, clearanceExcludeCats: [], clearanceAllowBelowCost: false, clearanceMinMarginPct: 0, clearanceMode: 'batch' };
    const cart = (qty, p = ctx.p) => [{ productId: p.id, name: p.name, qty, price: p.price, discount: 0, taxRate: 0, factor: 1 }];
    const stock = (p, qty, cost, batch) => { ERP.inventory.move({ productId: p.id, warehouseId: wh(), qty, type: 'opening', unitCost: cost, refType: 'opening', note: 'test', batch }); ERP.accounting.postOpeningStock(u.round(qty * cost)); };

    t('التصفية: تجهيز صنف بدفعتين (5 وحدات تنتهي بعد 5 أيام + 20 بعد 60 يوماً)', () => {
      ERP.settings.set({ posRequireShift: false, posAllowNegativeStock: false, negativeStockMode: 'block', taxEnabled: false, ...CL });
      ERP.db.collection('promotions').all().forEach(x => ERP.db.collection('promotions').update(x.id, { active: false }, { silent: true }));
      ctx.gap0 = gap();
      ctx.p = P.insert({ code: 'TST-CLR', name: 'زبادي اختبار تصفية', categoryId: 'cat_other', unitId: 'un_pc', cost: 6, price: 10, stock: 0, stockByWh: {}, batches: [], taxRate: 0, active: true, trackExpiry: true, barcode: 'CLR' + Date.now().toString().slice(-8) });
      stock(ctx.p, 5, 6, { batchNo: 'B-NEAR', expiry: day(5) });
      stock(ctx.p, 20, 6, { batchNo: 'B-FAR', expiry: day(60) });
      ctx.p = P.get(ctx.p.id);
      if (ctx.p.batches.length !== 2 || ctx.p.stock !== 25) throw new Error('batches ' + JSON.stringify(ctx.p.batches));
      inv(); tb();
      return 'رصيد 25 · دفعتان';
    });

    t('التصفية: اختيار الشريحة حسب الأيام المتبقية', () => {
      const c = ERP.clearance; const exp = [[31, 0], [30, 10], [15, 10], [14, 25], [8, 25], [7, 40], [3, 40], [2, 60], [0, 60], [-1, 0]];
      const bad = exp.filter(([d, p]) => c.pctFor(d) !== p); if (bad.length) throw new Error('tier ' + JSON.stringify(bad.map(([d]) => [d, c.pctFor(d)])));
      const pt = c.parseTiers('30 يوم → 10%، 14:25\n٧:٤٠'); if (JSON.stringify(pt) !== JSON.stringify([{ days: 7, pct: 40 }, { days: 14, pct: 25 }, { days: 30, pct: 10 }])) throw new Error('parse ' + JSON.stringify(pt));
      if (c.tierFor(-3) !== null) throw new Error('expired got a tier');
      return exp.map(([d, p]) => `${d}ي→${p}%`).join(' ');
    });

    t('التصفية: السقف وحارس هامش الربح', () => {
      const c = ERP.clearance; const p = ctx.p;
      ERP.settings.set({ clearanceMaxPct: 30 }); if (c.pctFor(1) !== 30) throw new Error('cap ' + c.pctFor(1));
      ERP.settings.set({ clearanceMaxPct: 60 });
      const d60 = c.unitDiscount(p, 10, 60); if (!near(d60, 4)) throw new Error('margin guard (cost 6) → ' + d60); // 10 − 6 = 4 max
      ERP.settings.set({ clearanceMinMarginPct: 10 }); const dm = c.unitDiscount(p, 10, 60); if (!near(dm, 3.4)) throw new Error('min margin 10% → ' + dm);
      ERP.settings.set({ clearanceMinMarginPct: 0, clearanceAllowBelowCost: true }); const db = c.unitDiscount(p, 10, 60); if (!near(db, 6)) throw new Error('below cost allowed → ' + db);
      ERP.settings.set({ clearanceAllowBelowCost: false });
      if (!near(c.unitDiscount(p, 10, 40), 4)) throw new Error('40% of 10');
      return 'سقف 30% · 60% على تكلفة 6 → خصم 4 · هامش 10% → 3.4 · تحت التكلفة → 6';
    });

    t('التصفية: الخصم على كمية الدفعة القريبة فقط (5 من 8)', () => {
      const c = ERP.sales.compute(cart(8)); const it = c.items[0];
      if (!near(it.discount, 20) || !/تصفية/.test(it.promoLabel)) throw new Error(`discount ${it.discount} label ${it.promoLabel}`); // 5 × 10 × 40%
      if (!near(c.total, 60)) throw new Error('total ' + c.total);
      const c3 = ERP.sales.compute(cart(3)); if (!near(c3.items[0].discount, 12)) throw new Error('3 units → ' + c3.items[0].discount);
      ERP.settings.set({ clearanceMode: 'product' }); const cp = ERP.sales.compute(cart(8)); ERP.settings.set({ clearanceMode: 'batch' });
      if (!near(cp.items[0].discount, 32)) throw new Error('product mode → ' + cp.items[0].discount);
      const tag = ERP.promotions.tagFor(ctx.p.id); if (!/تصفية/.test(tag || '')) throw new Error('tag ' + tag);
      ERP.settings.set({ clearanceEnabled: false }); const off = ERP.sales.compute(cart(8)); ERP.settings.set({ clearanceEnabled: true });
      if (off.items[0].discount) throw new Error('disabled still discounts');
      return `8 وحدات: خصم 20 (5 × 4) · «${it.promoLabel}» · وضع الصنف كله 32`;
    });

    t('التصفية مع عرض نسبة عادي: الخصم الأكبر يفوز', () => {
      const big = ERP.promotions.save({ name: 'اختبار 30%', type: 'percent', value: 30, scope: 'products', productIds: [ctx.p.id], active: true });
      let a; try { a = ERP.sales.compute(cart(8)); } finally { ERP.promotions.remove(big.id); }
      if (!near(a.items[0].discount, 24) || a.items[0].promoLabel !== 'اختبار 30%') throw new Error(`30% → ${a.items[0].discount} ${a.items[0].promoLabel}`);
      const small = ERP.promotions.save({ name: 'اختبار 20%', type: 'percent', value: 20, scope: 'products', productIds: [ctx.p.id], active: true });
      let b; try { b = ERP.sales.compute(cart(8)); } finally { ERP.promotions.remove(small.id); }
      if (!near(b.items[0].discount, 20) || !/تصفية/.test(b.items[0].promoLabel)) throw new Error(`20% → ${b.items[0].discount} ${b.items[0].promoLabel}`);
      return 'عرض 30% (24) يغلب التصفية (20) · التصفية (20) تغلب عرض 20% (16) — لا تراكم';
    });

    t('التصفية: فاتورة بيع فعلية (sales.create) + ميزان المراجعة + GL = التقييم', () => {
      const s = ERP.sales.create({ cart: cart(8), payments: [{ method: 'cash', amount: 60 }] });
      const it = s.items[0];
      if (!near(it.discount, 20) || !near(s.total, 60) || !/تصفية/.test(it.promoLabel) || !near(s.promoDiscount, 20)) throw new Error(`sale ${s.total} disc ${it.discount} ${it.promoLabel}`);
      const p = P.get(ctx.p.id); if (p.stock !== 17 || p.batches.length !== 1 || p.batches[0].batchNo !== 'B-FAR' || p.batches[0].qty !== 17) throw new Error('FEFO ' + JSON.stringify(p.batches));
      const again = ERP.sales.compute(cart(2, p)); if (again.items[0].discount) throw new Error('near batch sold out but still discounted');
      inv(); tb();
      return `${s.no}: صافي 60 (خصم تصفية 20) · الدفعة القريبة نفدت (FEFO) · TB متوازن · GL = التقييم`;
    });

    t('شطب الدفعات المنتهية عبر مسار الهالك (inv_loss) و GL = التقييم', () => {
      const p = P.insert({ code: 'TST-EXP', name: 'لبن منتهي اختبار', categoryId: 'cat_other', unitId: 'un_pc', cost: 5, price: 8, stock: 0, stockByWh: {}, batches: [], taxRate: 0, active: true, trackExpiry: true });
      stock(p, 4, 5, { batchNo: 'E-OLD', expiry: day(-2) });
      stock(p, 6, 5, { batchNo: 'E-NEW', expiry: day(90) });
      const loss0 = ERP.accounting.balance('inv_loss');
      const rows = ERP.clearance.rows().filter(r => r.product.id === p.id); if (rows.length !== 1 || !rows[0].expired || rows[0].pct) throw new Error('rows ' + JSON.stringify(rows.map(r => [r.daysLeft, r.pct])));
      const c = ERP.sales.compute(cart(2, P.get(p.id))); if (c.items[0].discount) throw new Error('expired batch discounted');
      const r = ERP.clearance.writeOffExpired({ productIds: [p.id] });
      if (r.count !== 1 || !near(r.value, 20)) throw new Error('writeoff ' + JSON.stringify(r));
      const q = P.get(p.id); if (q.stock !== 6 || q.batches.length !== 1 || q.batches[0].batchNo !== 'E-NEW') throw new Error('after ' + JSON.stringify(q.batches));
      if (!near(ERP.accounting.balance('inv_loss') - loss0, 20)) throw new Error('inv_loss Δ ' + (ERP.accounting.balance('inv_loss') - loss0));
      const mv = ERP.inventory.moves({ productId: p.id, type: 'waste' }); if (mv.length !== 1) throw new Error('waste moves ' + mv.length);
      if (ERP.clearance.wasteReport().moves.every(m => m.productId !== p.id)) throw new Error('waste report');
      inv(); tb();
      return 'شطب 4 وحدات (20) → inv_loss +20 · الرصيد 6 · GL = التقييم';
    });

    t('الميزان: محلل البث المستمر / طلب-استجابة / جرام / A9', () => {
      const S = ERP.hardware.scale;
      const cas = S.createParser({ unit: 'auto' });
      let r = cas.push('ST,GS,+  1.2'); if (r.length) throw new Error('partial frame parsed');
      r = cas.push('35kg\r\nUS,GS,+  1.240kg\r\nST,GS,-  0.010kg\r\n');
      if (r.length !== 3 || r[0].kg !== 1.235 || r[0].stable !== true || r[1].stable !== false || r[2].kg !== -0.01) throw new Error('cas ' + JSON.stringify(r));
      const bytes = Uint8Array.from('ST,NT,+  0.750kg\r\n', ch => ch.charCodeAt(0)); const rb = S.createParser({}).push(bytes); if (!rb[0] || rb[0].kg !== 0.75) throw new Error('bytes');
      const g = S.createParser({ unit: 'g' }).push('   1235\r\n  500 g\r\n'); if (g[0].kg !== 1.235 || g[1].kg !== 0.5) throw new Error('grams ' + JSON.stringify(g));
      const tol = S.createParser({ unit: 'kg' }).push('\x0201.235\r'); if (!tol[0] || tol[0].kg !== 1.235 || tol[0].stable !== null) throw new Error('toledo ' + JSON.stringify(tol));
      const rx = S.createParser({ regex: 'W:\\s*([\\d.]+)\\s*(kg|g)' }).push('\x06W: 850 g\x03'); if (!rx[0] || rx[0].kg !== 0.85) throw new Error('regex ' + JSON.stringify(rx));
      const a9 = S.createParser({ reverse: true, unit: 'kg' }).push('=532.1000=532.1000='); if (a9.length !== 2 || a9[0].kg !== 1.235) throw new Error('a9 ' + JSON.stringify(a9));
      if (S.unescape('\\x05') !== '\x05' || S.unescape('W\\r') !== 'W\r' || S.unescape('<ENQ>') !== '\x05') throw new Error('unescape');
      const unk = { kg: 1.2, stable: null }; if (S.isStable(unk, null) || !S.isStable(unk, { kg: 1.2 }) || S.isStable({ kg: 1.2, stable: false }, { kg: 1.2 })) throw new Error('stability');
      if (S.parseFrame('ST,GS,+  1.235kg').kg !== 1.235 || S.parseFrame('   ') !== null) throw new Error('parseFrame');
      return 'CAS 1.235 كجم (ST/US) · بايتات · جرام · Toledo · Regex · A9 معكوس';
    });

    t('ملصقات ZPL / TSPL: أمر الباركود وأبعاد الصورة', () => {
      const L = ERP.hardware.labels;
      const spec = L.spec({ type: 'zpl', widthMm: 40, heightMm: 25, dpi: 203, darkness: 12, gapMm: 2, speed: 4, flip: false });
      if (spec.W !== 320 || spec.H !== 200 || spec.bpr !== 40) throw new Error(`spec ${spec.W}x${spec.H}/${spec.bpr}`);
      const s300 = L.spec({ widthMm: 50, heightMm: 30, dpi: 300 }); if (s300.W !== 591 || s300.H !== 354 || s300.bpr !== 74) throw new Error(`300dpi ${s300.W}x${s300.H}/${s300.bpr}`);
      const fake = (it, sp) => ({ width: sp.W, height: sp.H, bpr: sp.bpr, bits: new Uint8Array(sp.bpr * sp.H) });
      const prod = { name: 'أرز مصري ١ كجم', price: 32.5, barcode: '4006381333931' };
      const z = L.buildZpl([{ product: prod, qty: 3 }], { spec, bitmap: fake });
      const m = /\^GFA,(\d+),(\d+),(\d+),([0-9A-F]+)\^FS/.exec(z);
      if (!m || +m[1] !== 8000 || +m[2] !== 8000 || +m[3] !== 40 || m[4].length !== 16000) throw new Error('GFA ' + (m ? m.slice(1, 4) : 'missing'));
      if (!/\^BEN,\d+,Y,N\^FD400638133393\^FS/.test(z) || !/\^PQ3/.test(z) || !/\^PW320\^LL200/.test(z) || !/~SD12/.test(z)) throw new Error('zpl cmds');
      const z128 = L.buildZpl([{ product: { name: 'x', price: 1, code: 'ABC-123' } }], { spec, bitmap: fake }); if (!/\^BCN,\d+,Y,N,N,A\^FDABC-123\^FS/.test(z128)) throw new Error('code128 zpl');
      const tspec = L.spec({ type: 'tspl', widthMm: 40, heightMm: 25, dpi: 203, darkness: 10, gapMm: 2, speed: 4 });
      const b = L.buildTspl([{ product: prod, qty: 2 }], { spec: tspec, bitmap: fake });
      const txt = Array.from(b, c => String.fromCharCode(c)).join('');
      const head = 'BITMAP 0,0,40,200,0,'; const i = txt.indexOf(head); if (i < 0 || !/SIZE 40 mm,25 mm/.test(txt) || !/GAP 2 mm,0 mm/.test(txt) || !/DENSITY 5/.test(txt)) throw new Error('tspl header');
      const start = i + head.length; const data = b.slice(start, start + 8000);
      if (data.length !== 8000 || data.some(x => x !== 0xFF)) throw new Error('bitmap bytes (bit 0 = black → blank label all 0xFF)');
      if (!txt.slice(start + 8000).startsWith('\r\nBARCODE ') || !/BARCODE \d+,\d+,"EAN13",\d+,1,0,\d,\d,"400638133393"/.test(txt) || !/PRINT 1,2/.test(txt)) throw new Error('tspl barcode/print');
      let real = '';
      if (typeof document !== 'undefined' && document.createElement('canvas').getContext) { const bm = L.renderBitmap({ product: prod, price: 30, oldPrice: 32.5, clearance: true, clearanceText: 'ينتهي قريباً' }, spec); const black = bm.bits.reduce((a, x) => a + (x ? 1 : 0), 0); if (bm.bits.length !== 8000 || bm.bpr !== 40 || !black) throw new Error('canvas bitmap'); real = ` · صورة حقيقية ${black} بايت أسود`; }
      return `ZPL ^GFA 8000/40 + ^BE · TSPL BITMAP 40×200 + EAN13 · 300dpi 591×354${real}`;
    });
  });
})();
