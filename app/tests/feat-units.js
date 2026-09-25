/* ==========================================================================
   Feature tests — multiple selling units, scheduled price changes, shelf-label queue
   (data is snapshotted and restored by ERP.tests.run)
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  ERP.testSuites = ERP.testSuites || [];
  ERP.testSuites.push((t, h) => {
    const { u, near } = h;
    const P = ERP.db.collection('products');
    const ctx = {};
    const wh = () => ERP.settings.get('posDefaultWarehouse') || ERP.inventory.defaultWh();
    const gap = () => u.round(ERP.accounting.balance('inventory') - ERP.inventory.valuation().totalValue, 2); // must not move
    const tb = () => { const x = ERP.accounting.trialBalance(); if (!near(x.totalDebit, x.totalCredit)) throw new Error(`ميزان المراجعة غير متوازن ${x.totalDebit} ≠ ${x.totalCredit}`); };
    const inv = () => { if (!near(gap(), ctx.gap0, 0.05)) throw new Error(`GL مخزون − التقييم تغيّر: ${gap()} (كان ${ctx.gap0})`); };
    const carton = () => ERP.units.list(P.get(ctx.p.id)).find(x => x.factor === 24);
    const line = (unit, qty, price) => ({ productId: ctx.p.id, name: ctx.p.name, qty, price, unitId: unit ? unit.id : null, unitName: unit ? unit.name : '', factor: unit ? unit.factor : 1 });

    t('الوحدات: صنف بوحدة أساسية (قطعة) + كرتونة ×24 ورصيد افتتاحي', () => {
      ERP.settings.set({ posRequireShift: false, posAllowNegativeStock: false, negativeStockMode: 'block', taxEnabled: false });
      ERP.db.collection('promotions').all().forEach(x => ERP.db.collection('promotions').update(x.id, { active: false }, { silent: true })); // isolate totals from the store's own offers
      ctx.gap0 = gap();
      const code = 'UT' + Date.now().toString().slice(-8);
      ctx.cbc = '69' + Date.now().toString().slice(-11);
      let bad = false; try { ERP.units.validate({ id: null, barcode: code }, [{ name: 'كرتونة', factor: 1, price: 10 }]); } catch (e) { bad = /أكبر من 1/.test(e.message); }
      if (!bad) throw new Error('factor 1 accepted');
      const units = ERP.units.validate({ id: null, barcode: code }, [{ unitId: 'un_box', name: 'كرتونة', factor: 24, price: 240, barcode: ctx.cbc }]);
      ctx.p = P.insert({ code: 'TST-UNIT', name: 'صنف وحدات', categoryId: 'cat_other', unitId: 'un_pc', cost: 10, price: 12, stock: 0, stockByWh: {}, batches: [], taxRate: 0, active: true, barcode: code, units });
      ERP.inventory.move({ productId: ctx.p.id, warehouseId: wh(), qty: 100, type: 'opening', unitCost: 10, refType: 'opening', note: 'test' });
      ERP.accounting.postOpeningStock(1000);
      let dup = false; try { ERP.units.validate({ id: 'other' }, [{ name: 'علبة', factor: 6, barcode: ctx.cbc }]); } catch (e) { dup = /مستخدم/.test(e.message); }
      if (!dup) throw new Error('duplicate unit barcode across products accepted');
      inv(); tb();
      return `قطعة 12 · كرتونة ×24 = 240 · رصيد 100 · باركود مكرر مرفوض`;
    });

    t('الوحدات: قراءة باركود الكرتونة (resolveScan متوافق للخلف)', () => {
      const r = ERP.inventory.resolveScan(ctx.cbc);
      if (!r || r.product.id !== ctx.p.id || !r.unit || r.unit.factor !== 24 || r.qty !== 24 || !near(r.price, 10, 0.0001)) throw new Error(`scan → ${JSON.stringify(r && { q: r.qty, p: r.price, u: !!r.unit })}`);
      const b = ERP.inventory.resolveScan(ctx.p.barcode); if (!b || b.unit || b.qty !== 1) throw new Error('base barcode');
      if (ERP.inventory.findByBarcode(ctx.cbc).id !== ctx.p.id) throw new Error('findByBarcode');
      // legacy pack barcode migrates into a unit
      const lp = P.insert({ code: 'TST-LEG', name: 'صنف قديم', categoryId: 'cat_other', unitId: 'un_pc', cost: 5, price: 7, stock: 0, stockByWh: {}, batches: [], active: true, barcodes: [{ code: 'LEG-6-' + ctx.cbc, qty: 6, price: 39 }, { code: 'ALIAS-' + ctx.cbc, qty: 1 }] });
      ERP.units.migrate({ force: true });
      const m = P.get(lp.id); const x = ERP.units.list(m)[0];
      if (!x || x.factor !== 6 || x.price !== 39 || m.barcodes.length !== 1) throw new Error('legacy migration');
      const r2 = ERP.inventory.resolveScan('LEG-6-' + ctx.cbc); if (!r2 || r2.qty !== 6 || !r2.unit) throw new Error('migrated scan');
      P.remove(lp.id);
      return 'كرتونة → 24 قطعة (سعر القطعة 10) · باركود عبوة قديم ×6 تحوّل لوحدة';
    });

    t('الوحدات: بيع 2 كرتونة + 3 قطع → المخزون −51 والتكلفة 51 × المتوسط', () => {
      const c = carton(); const s0 = P.get(ctx.p.id).stock, avg = P.get(ctx.p.id).cost;
      ctx.sale = ERP.sales.create({ cart: [line(c, 2, 240), line(null, 3, 12)], payments: [{ method: 'cash', amount: 516 }] });
      const st = P.get(ctx.p.id).stock;
      if (!near(st, s0 - 51, 0.0001)) throw new Error(`stock ${st} ≠ ${s0 - 51}`);
      if (!near(ctx.sale.total, 516)) throw new Error(`total ${ctx.sale.total}`);
      if (!near(ctx.sale.cogs, 51 * avg)) throw new Error(`cogs ${ctx.sale.cogs} ≠ ${51 * avg}`);
      const it = ctx.sale.items[0]; if (it.unitId !== c.id || it.factor !== 24 || it.baseQty !== 48 || !/كرتونة/.test(it.name)) throw new Error('unit info on the line');
      inv(); tb();
      return `${ctx.sale.no}: 516 · مخزون ${s0} → ${st} · COGS ${u.fmtNum(ctx.sale.cogs)}`;
    });

    t('الوحدات: مرتجع كرتونة واحدة → +24 والكمية تُتحقق لكل سطر بوحدته', () => {
      const c = carton(); const s0 = P.get(ctx.p.id).stock;
      const r = ERP.sales.createReturn({ saleId: ctx.sale.id, lines: [{ productId: ctx.p.id, unitId: c.id, qty: 1 }], refundMethod: 'cash', reason: 'test' });
      if (!near(P.get(ctx.p.id).stock, s0 + 24, 0.0001)) throw new Error(`stock ${P.get(ctx.p.id).stock}`);
      if (!near(r.total, 240) || !near(r.cogs, 240)) throw new Error(`return total ${r.total} cogs ${r.cogs}`);
      const o = ERP.sales.get(ctx.sale.id);
      if (o.returnedQty[`${ctx.p.id}|${c.id}`] !== 1 || o.returnedQty[ctx.p.id]) throw new Error('returnedQty per line');
      const r2 = ERP.sales.createReturn({ saleId: ctx.sale.id, lines: [{ productId: ctx.p.id, unitId: c.id, qty: 5 }], refundMethod: 'cash' });
      if (r2.items[0].qty !== 1 || !near(P.get(ctx.p.id).stock, s0 + 48, 0.0001)) throw new Error('over-return not capped to the remaining carton');
      inv(); tb();
      return `مرتجع 1 كرتونة = 240 (+24 قطعة) · طلب 5 كراتين قُصر على المتبقي 1`;
    });

    t('الوحدات: كرتونة مرفوضة عند توفر 20 قطعة فقط (منع البيع بالسالب)', () => {
      ERP.settings.set({ posAllowNegativeStock: false, negativeStockMode: 'block' });
      ERP.inventory.adjust({ productId: ctx.p.id, warehouseId: wh(), newQty: 20, reason: 'test' });
      const n0 = ERP.sales.all().length;
      let rej = false; try { ERP.sales.create({ cart: [line(carton(), 1, 240)], payments: [{ method: 'cash', amount: 240 }] }); } catch (e) { rej = /رصيد غير كاف/.test(e.message); }
      if (!rej) throw new Error('carton sold with only 20 pieces');
      let rej2 = false; try { ERP.sales.create({ cart: [line(null, 20, 12), line(carton(), 1, 240)], payments: [{ method: 'cash', amount: 480 }] }); } catch (e) { rej2 = /رصيد غير كاف/.test(e.message); }
      if (!rej2 || ERP.sales.all().length !== n0 || P.get(ctx.p.id).stock !== 20) throw new Error('mixed lines not summed in base units');
      const ok = ERP.sales.create({ cart: [line(null, 20, 12)], payments: [{ method: 'cash', amount: 240 }] });
      ERP.sales.void(ok.id, 'test');
      if (P.get(ctx.p.id).stock !== 20) throw new Error('void');
      inv(); tb();
      return 'كرتونة (24) > 20 مرفوضة · 20 قطعة + كرتونة مرفوضة · 20 قطعة مقبولة';
    });

    t('الوحدات: شراء 5 كراتين × 240 → تكلفة القطعة 10 والمخزون +120', () => {
      const sup = ERP.purchasing.createSupplier({ name: 'مورد وحدات اختبار' });
      const c = carton(); const s0 = P.get(ctx.p.id).stock;
      const po = ERP.purchasing.create({ supplierId: sup.id, items: [{ productId: ctx.p.id, name: ctx.p.name, qty: 5, cost: 240, unitId: c.id, newPrice: 250 }] });
      if (po.items[0].factor !== 24 || !near(po.total, 1200)) throw new Error('PO line unit');
      ERP.purchasing.receive(po.id);
      const p = P.get(ctx.p.id);
      if (!near(p.stock, s0 + 120, 0.0001)) throw new Error(`stock ${p.stock}`);
      const mv = ERP.inventory.moves({ productId: ctx.p.id, type: 'purchase' })[0];
      if (!mv || mv.qty !== 120 || !near(mv.unitCost, 10, 0.0001)) throw new Error(`move ${mv && mv.qty} @ ${mv && mv.unitCost}`);
      if (!near(p.cost, 10, 0.001)) throw new Error(`avg ${p.cost}`);
      if (ERP.units.price(p, c.id) !== 250) throw new Error('unit price from PO new price');
      ctx.poId = po.id; ctx.sup = sup;
      inv(); tb();
      const s1 = p.stock;
      ERP.purchasing.returnToSupplier({ supplierId: sup.id, items: [{ productId: ctx.p.id, name: ctx.p.name, qty: 1, cost: 240, unitId: c.id }], poId: po.id });
      if (!near(P.get(ctx.p.id).stock, s1 - 24, 0.0001)) throw new Error('purchase return in base units');
      inv(); tb();
      return `5 كراتين = 1200 → +120 قطعة @ 10 · سعر الكرتونة الجديد 250 · مرتجع كرتونة −24`;
    });

    t('الوحدات: التحكم في السعر يقارن بسعر الوحدة', () => {
      const can0 = ERP.auth.can; ERP.auth.can = perm => perm === 'pos.price_edit' ? false : can0.call(ERP.auth, perm);
      try {
        const c = carton(); const up = ERP.units.price(P.get(ctx.p.id), c.id); // 250 (< 24 × 12 = 288 → a carton at its own price is fine)
        let rej = false; try { ERP.sales.create({ cart: [line(c, 1, up - 5)], payments: [{ method: 'cash', amount: up - 5 }] }); } catch (e) { rej = /صلاحية تعديل السعر/.test(e.message); }
        if (!rej) throw new Error('carton below its unit price accepted');
        const ok = ERP.sales.create({ cart: [line(c, 1, up)], payments: [{ method: 'cash', amount: up }] });
        if (!ok || !near(ok.total, up)) throw new Error('carton at unit price rejected');
        return `كرتونة بـ ${up - 5} مرفوضة · بسعرها ${up} مقبولة (رغم أنها أقل من 24×12)`;
      } finally { ERP.auth.can = can0; }
    });

    t('الوحدات: العروض تُحسب على الكمية الأساسية لكل المنتج', () => {
      const c = carton();
      const pr = ERP.promotions.save({ name: 'اختبار 3+1', type: 'buy_x_get_y', buyQty: 3, getQty: 1, scope: 'products', productIds: [ctx.p.id], active: true });
      try {
        const r = ERP.sales.compute([line(c, 1, 240), line(null, 4, 12)]); // 28 pieces → 7 free × cheapest per-piece (10) = 70
        if (!near(r.promoDiscount, 70)) throw new Error(`promo ${r.promoDiscount}`);
        if (!near(u.sum(r.items, 'discount'), 70)) throw new Error('spread over lines');
        const r2 = ERP.sales.compute([line(null, 4, 12)]); if (!near(r2.promoDiscount, 12)) throw new Error('base line unchanged');
      } finally { ERP.promotions.remove(pr.id); }
      return 'كرتونة + 4 قطع = 28 → 7 مجاناً × 10 = 70 موزعة على السطرين';
    });

    t('الأسعار المجدولة: تُطبَّق عند البدء وتُرجع عند الانتهاء + قائمة الملصقات', () => {
      const p0 = P.get(ctx.p.id); const old = p0.price;
      ERP.labels.remove(ERP.labels.pending().map(x => x.id));
      const now = Date.now();
      const x = ERP.priceChanges.schedule({ productId: ctx.p.id, newPrice: 11, startAt: new Date(now + 3600e3).toISOString(), endAt: new Date(now + 7200e3).toISOString(), note: 'عرض' });
      ERP.priceChanges.run(); if (ERP.priceChanges.get(x.id).status !== 'scheduled' || P.get(ctx.p.id).price !== old) throw new Error('applied before startAt');
      ERP.db.collection('priceChanges').update(x.id, { startAt: new Date(now - 60e3).toISOString() });
      const r1 = ERP.priceChanges.run(); ERP.priceChanges.run(); // idempotent
      if (r1.applied !== 1 || ERP.priceChanges.get(x.id).status !== 'applied' || P.get(ctx.p.id).price !== 11) throw new Error('not applied at startAt');
      const q = ERP.labels.pending().find(l => l.productId === ctx.p.id && !l.unitId);
      if (!q || q.oldPrice !== old || q.newPrice !== 11) throw new Error('label queue after apply');
      if (!ERP.labels.items([q.id])[0] || ERP.labels.items([q.id])[0].oldPrice !== old) throw new Error('label payload (old price crossed out)');
      ERP.labels.markPrinted([q.id]);
      ERP.db.collection('priceChanges').update(x.id, { endAt: new Date(now - 1000).toISOString() });
      const r2 = ERP.priceChanges.run();
      if (r2.reverted !== 1 || ERP.priceChanges.get(x.id).status !== 'reverted' || P.get(ctx.p.id).price !== old) throw new Error('not reverted at endAt');
      const q2 = ERP.labels.pending().find(l => l.productId === ctx.p.id && !l.unitId);
      if (!q2 || q2.newPrice !== old) throw new Error('label queue after revert');
      // cancel a scheduled unit change; bulk schedule with percent + rounding
      const c = carton(); const y = ERP.priceChanges.schedule({ productId: ctx.p.id, unitId: c.id, newPrice: 230, startAt: new Date(now + 86400e3).toISOString() });
      ERP.priceChanges.cancel(y.id); ERP.priceChanges.run();
      if (ERP.priceChanges.get(y.id).status !== 'cancelled' || ERP.units.price(P.get(ctx.p.id), c.id) !== 250) throw new Error('cancel');
      const list = ERP.priceChanges.bulk({ productIds: [ctx.p.id], mode: 'pct', value: 10, round: 0.5, includeUnits: true, startAt: new Date(now - 1000).toISOString() });
      ERP.priceChanges.run();
      if (list.length !== 2 || P.get(ctx.p.id).price !== 13 || ERP.units.price(P.get(ctx.p.id), c.id) !== 275) throw new Error(`bulk ${P.get(ctx.p.id).price} / ${ERP.units.price(P.get(ctx.p.id), c.id)}`);
      return `12 → 11 عند البدء → 12 عند الانتهاء · ملصق لكل تغيير · جماعي +10% (تقريب 0.5): 13 / كرتونة 275`;
    });

    t('ملصقات الأسعار: تعديل يدوي واستلام شراء بسعر جديد يضيفان للقائمة', () => {
      const c = carton(); ERP.labels.remove(ERP.labels.pending().map(x => x.id));
      ERP.units.setPrice(ctx.p.id, null, 14, { reason: 'test' });
      ERP.units.setPrice(ctx.p.id, null, 13); // back to the shelf price before printing → entry dropped
      if (ERP.labels.pending().some(l => l.productId === ctx.p.id && !l.unitId)) throw new Error('entry should drop when price returns to shelf price');
      const po = ERP.purchasing.create({ supplierId: ctx.sup.id, items: [{ productId: ctx.p.id, name: ctx.p.name, qty: 1, cost: 240, unitId: c.id, newPrice: 280 }] });
      ERP.purchasing.receive(po.id);
      const q = ERP.labels.pending().find(l => l.productId === ctx.p.id && l.unitId === c.id);
      if (!q || q.newPrice !== 280 || q.oldPrice !== 275) throw new Error('PO receive new price not queued');
      inv(); tb();
      return `استلام بسعر كرتونة 280 → ملصق (275 → 280)`;
    });
  });
})();
