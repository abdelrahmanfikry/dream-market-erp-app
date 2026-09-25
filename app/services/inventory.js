/* ==========================================================================
   ERP.inventory — stock ledger, weighted-average cost, warehouses,
   adjustments, transfers, stocktakes, expiry batches, valuation
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  const u = ERP.utils;
  const P = () => ERP.db.collection('products');
  const M = () => ERP.db.collection('stockMoves');
  const W = () => ERP.db.collection('warehouses');

  function defaultWh() { const w = W().first({ isDefault: true }) || W().all()[0]; return w ? w.id : 'wh_main'; }
  function whQty(p, wh) { return u.num((p.stockByWh || {})[wh]); }

  const inv = {
    defaultWh, whQty,
    warehouses() { return W().all(); },
    product(id) { return P().get(id); },
    findByBarcode(code) {
      code = String(code || '').trim(); if (!code) return null;
      return P().all().find(p => p.barcode === code || (p.barcodes || []).some(b => b.code === code) || (p.units || []).some(x => x.barcode === code) || p.code === code) || null;
    },
    /**
     * Resolve a scanned code → {product, qty, price}
     * - unit barcodes (ERP.units: carton ×24 …) return qty = factor in BASE units, price = unit price / factor (per base unit)
     *   and `unit` = the product unit, so unit-aware callers (POS, purchases) add 1 of that unit instead
     * - legacy pack barcodes (p.barcodes with qty) still return the pack qty
     * - scale barcodes (EAN-13 starting with the configured prefix): prefix(2) + PLU(5) + value(5) + check(1)
     *   value = weight in grams (mode 'weight') or total price in piasters/cents (mode 'price')
     */
    resolveScan(code) {
      code = u.normalizeDigits(String(code || '')).trim();
      const hit = ERP.units ? ERP.units.findBarcode(code) : null;
      if (hit && hit.product.barcode !== code) { const f = u.num(hit.unit.factor, 1), up = u.num(hit.unit.price); return { product: hit.product, qty: f, price: up > 0 ? u.round(up / f, 4) : null, unit: hit.unit }; }
      const p = inv.findByBarcode(code);
      if (p) { const alt = (p.barcodes || []).find(b => b.code === code); return { product: p, qty: alt ? u.num(alt.qty, 1) : 1, price: alt && alt.price ? alt.price : null }; }
      const sc = inv.parseScaleBarcode(code);
      if (sc) return sc;
      return null;
    },
    parseScaleBarcode(code) {
      const s = ERP.settings.all();
      if (!s.scaleBarcodeEnabled || !/^\d{13}$/.test(code)) return null;
      const prefix = String(s.scaleBarcodePrefix || '2');
      if (!code.startsWith(prefix)) return null;
      const pluLen = u.num(s.scaleBarcodePluLength, 5);
      const plu = code.slice(prefix.length, prefix.length + pluLen);
      const value = u.num(code.slice(prefix.length + pluLen, 12));
      const prod = P().all().find(x => x.scalePlu && u.normalizeDigits(String(x.scalePlu)).padStart(pluLen, '0') === plu) || P().all().find(x => x.barcode === prefix + plu || x.code === plu);
      if (!prod) return null;
      if (s.scaleBarcodeMode === 'price') { const total = value / 100; const qty = prod.price ? u.round(total / prod.price, 3) : 1; return { product: prod, qty, price: null, scale: { total } }; }
      const qty = u.round(value / 1000, 3); // grams → kg
      return { product: prod, qty: qty > 0 ? qty : 1, price: null, scale: { grams: value } };
    },

    /**
     * Core ledger write. qty>0 increases stock, qty<0 decreases.
     * Weighted-average cost is updated on inbound moves that carry a unitCost.
     */
    /** negative-stock policy: 'block' (nobody), 'permission' (users with pos.negative_stock), 'allow' (everyone) */
    negativeMode() { const s = ERP.settings.all(); if (s.posAllowNegativeStock) return 'allow'; return s.negativeStockMode === 'permission' ? 'permission' : 'block'; },
    canGoNegative() { const m = inv.negativeMode(); return m === 'allow' || (m === 'permission' && !!ERP.auth && ERP.auth.can('pos.negative_stock')); },
    move({ productId, warehouseId, qty, type, unitCost = null, refType = null, refId = null, note = '', batch = null, date = null, silent = false, allowNegative = null }) {
      const p = P().get(productId); if (!p) throw new Error('المنتج غير موجود');
      qty = u.round(u.num(qty), 3); if (!qty) return null;
      warehouseId = warehouseId || defaultWh();
      const cur = whQty(p, warehouseId);
      const total = u.num(p.stock);
      if (qty < 0 && cur + qty < -0.0001) {
        const allow = allowNegative !== null ? allowNegative : inv.canGoNegative();
        if (!allow) throw new Error(`رصيد غير كافٍ للمنتج "${p.name}" (المتاح ${u.fmtQty(cur)})`);
      }
      // weighted average cost on inbound
      let newCost = u.num(p.cost);
      const costed = qty > 0 && unitCost !== null && unitCost >= 0 && ['purchase', 'opening', 'adjust', 'return_in'].includes(type);
      if (costed) {
        const base = Math.max(0, total);
        newCost = base + qty > 0 ? u.round(((base * newCost) + (qty * unitCost)) / (base + qty), 4) : unitCost;
        if (type === 'purchase' || type === 'opening') newCost = base > 0 ? newCost : unitCost;
      }
      const costUsed = unitCost !== null ? unitCost : u.num(p.cost);
      const stockByWh = { ...(p.stockByWh || {}) }; stockByWh[warehouseId] = u.round(cur + qty, 3);
      let batches = p.batches || [];
      if (p.trackExpiry && batch && batch.expiry) {
        batches = [...batches];
        const i = batches.findIndex(b => b.batchNo === (batch.batchNo || '') && b.expiry === batch.expiry && (b.warehouseId || warehouseId) === warehouseId);
        if (i >= 0) batches[i] = { ...batches[i], qty: u.round(batches[i].qty + qty, 3) }; else if (qty > 0) batches.push({ batchNo: batch.batchNo || '', expiry: batch.expiry, qty, warehouseId });
        batches = batches.filter(b => b.qty > 0.0001);
      } else if (p.trackExpiry && qty < 0 && batches.length) {
        // FEFO consumption
        let rem = -qty; batches = u.sortBy(batches, 'expiry').map(b => ({ ...b }));
        for (const b of batches) { if (rem <= 0) break; if ((b.warehouseId || warehouseId) !== warehouseId) continue; const take = Math.min(b.qty, rem); b.qty = u.round(b.qty - take, 3); rem -= take; }
        batches = batches.filter(b => b.qty > 0.0001);
      }
      P().update(productId, { stock: u.round(total + qty, 3), stockByWh, cost: newCost, batches, lastMoveAt: u.now() }, { silent });
      const mv = M().insert({ date: date || u.now(), productId, productName: p.name, warehouseId, qty, type, unitCost: costUsed, value: u.round(qty * costUsed), refType, refId, note, batch: batch ? (batch.batchNo || '') : '', expiry: batch ? batch.expiry : null, balanceAfter: u.round(total + qty, 3), userId: ERP.auth.current()?.id || null }, { silent });
      // inbound into negative stock: the missing units were costed at the old average — settle them at the new
      // cost and post the difference (inv_gain / inv_loss) so GL inventory keeps equal to the valuation
      if (costed && total < -0.0001) {
        const adj = u.round(u.round((total + qty) * newCost) - u.round(total * u.num(p.cost)) - mv.value);
        if (Math.abs(adj) >= 0.01) { ERP.accounting.postStockAdjust({ id: mv.id, date: mv.date, note: `تسوية تكلفة رصيد سالب — ${p.name}` }, adj); M().update(mv.id, { revalue: adj }, { silent: true }); mv.revalue = adj; }
      }
      return mv;
    },

    adjust({ productId, warehouseId, newQty, reason = '', unitCost = null }) {
      const p = P().get(productId); const wh = warehouseId || defaultWh();
      const diff = u.round(u.num(newQty) - whQty(p, wh), 3);
      if (!diff) return null;
      const mv = inv.move({ productId, warehouseId: wh, qty: diff, type: 'adjust', unitCost: diff > 0 ? (unitCost ?? p.cost) : null, refType: 'adjust', note: reason, allowNegative: true });
      ERP.accounting.postStockAdjust(mv, mv.value);
      ERP.audit.log('stock.adjust', `${p.name}: ${diff > 0 ? '+' : ''}${u.fmtQty(diff)} (${reason})`, mv.id);
      return mv;
    },
    waste({ productId, warehouseId, qty, reason = 'هالك' }) {
      const p = P().get(productId);
      const mv = inv.move({ productId, warehouseId, qty: -Math.abs(u.num(qty)), type: 'waste', refType: 'waste', note: reason, allowNegative: true });
      ERP.accounting.postStockAdjust(mv, mv.value);
      ERP.audit.log('stock.waste', `${p.name}: ${u.fmtQty(qty)} — ${reason}`, mv.id);
      return mv;
    },
    transfer({ fromWh, toWh, lines, note = '' }) {
      if (fromWh === toWh) throw new Error('المخزن المصدر والوجهة متطابقان');
      const T = ERP.db.collection('transfers');
      if (!lines || !lines.length) throw new Error('أضف أصنافاً للتحويل');
      // validate every line before anything moves (no half-applied transfers)
      const allowNeg = inv.canGoNegative(); const need = {};
      lines.forEach(l => {
        const p = P().get(l.productId); if (!p) throw new Error('المنتج غير موجود');
        const q = Number(l.qty); if (!isFinite(q) || q <= 0) throw new Error(`كمية غير صالحة للصنف ${p.name}`);
        need[p.id] = u.round((need[p.id] || 0) + q, 3);
        if (!allowNeg && whQty(p, fromWh) < need[p.id] - 0.0001) throw new Error(`رصيد غير كافٍ للمنتج "${p.name}" في المخزن المصدر (المتاح ${u.fmtQty(whQty(p, fromWh))})`);
      });
      const doc = T.insert({ no: ERP.db.nextSeq('transfer', ERP.settings.prefix('transfer')), date: u.now(), fromWh, toWh, lines, note, userId: ERP.auth.current()?.id });
      lines.forEach(l => {
        inv.move({ productId: l.productId, warehouseId: fromWh, qty: -Math.abs(l.qty), type: 'transfer_out', refType: 'transfer', refId: doc.id, note, silent: true });
        inv.move({ productId: l.productId, warehouseId: toWh, qty: Math.abs(l.qty), type: 'transfer_in', refType: 'transfer', refId: doc.id, note, silent: true });
      });
      ERP.bus.emit('db:change', { collection: 'products', op: 'bulk' });
      ERP.audit.log('stock.transfer', `${doc.no}: ${lines.length} صنف`, doc.id);
      return doc;
    },
    /** apply a completed stocktake: lines [{productId, counted}] */
    applyStocktake({ warehouseId, lines, note = '' }) {
      const S = ERP.db.collection('stocktakes');
      const wh = warehouseId || defaultWh();
      const detail = lines.map(l => { const p = P().get(l.productId); const expected = whQty(p, wh); return { productId: l.productId, name: p.name, expected, counted: u.num(l.counted), diff: u.round(u.num(l.counted) - expected, 3), cost: p.cost }; });
      const doc = S.insert({ no: ERP.db.nextSeq('stocktake', ERP.settings.prefix('stocktake')), date: u.now(), warehouseId: wh, lines: detail, note, status: 'done', diffValue: u.round(u.sum(detail, d => d.diff * d.cost)), userId: ERP.auth.current()?.id });
      let value = 0;
      detail.filter(d => d.diff).forEach(d => { const mv = inv.move({ productId: d.productId, warehouseId: wh, qty: d.diff, type: 'adjust', unitCost: d.diff > 0 ? d.cost : null, refType: 'stocktake', refId: doc.id, note: `جرد ${doc.no}`, allowNegative: true, silent: true }); value += mv.value; });
      if (value) ERP.accounting.post({ date: doc.date, memo: `فروق جرد ${doc.no}`, refType: 'stocktake', refId: doc.id, lines: value > 0 ? [{ sys: 'inventory', debit: value }, { sys: 'inv_gain', credit: value }] : [{ sys: 'inv_loss', debit: -value }, { sys: 'inventory', credit: -value }] });
      ERP.bus.emit('db:change', { collection: 'products', op: 'bulk' });
      ERP.audit.log('stock.count', `${doc.no}: ${detail.filter(d => d.diff).length} فرق، قيمة ${u.fmtMoney(value)}`, doc.id);
      return doc;
    },

    /* ---- queries ---- */
    moves({ productId, warehouseId, from, to, type } = {}) {
      let list = M().all();
      if (productId) list = list.filter(m => m.productId === productId);
      if (warehouseId) list = list.filter(m => m.warehouseId === warehouseId);
      if (type) list = list.filter(m => m.type === type);
      if (from || to) list = list.filter(m => u.inRange(m.date, from, to));
      return u.sortBy(list, 'date', 'desc');
    },
    lowStock() { const th = u.num(ERP.settings.get('lowStockThreshold'), 5); const key = `l:${ERP.db.version('products')}:${th}`; if (inv.__low && inv.__low.key === key) return inv.__low.val; const v = P().all().filter(p => p.active !== false && u.num(p.stock) <= u.num(p.minStock, th)); inv.__low = { key, val: v }; return v; },
    outOfStock() { const key = `o:${ERP.db.version('products')}`; if (inv.__out && inv.__out.key === key) return inv.__out.val; const v = P().all().filter(p => p.active !== false && u.num(p.stock) <= 0); inv.__out = { key, val: v }; return v; },
    expiring(days) {
      days = days ?? u.num(ERP.settings.get('expiryAlertDays'), 30);
      const key = `e:${ERP.db.version('products')}:${days}:${u.todayISO()}`;
      if (inv.__exp && inv.__exp.key === key) return inv.__exp.val;
      const limit = u.toISODate(u.addDays(new Date(), days)); const today = u.todayISO();
      const out = [];
      P().all().forEach(p => (p.batches || []).forEach(b => { if (b.expiry && b.qty > 0 && b.expiry <= limit) out.push({ product: p, batch: b, expired: b.expiry < today, daysLeft: u.daysBetween(today, b.expiry) }); }));
      const val = u.sortBy(out, o => o.batch.expiry);
      inv.__exp = { key, val };
      return val;
    },
    valuation(warehouseId = null) {
      const rows = P().all().filter(p => p.active !== false).map(p => { const q = warehouseId ? whQty(p, warehouseId) : u.num(p.stock); return { product: p, qty: q, cost: u.num(p.cost), value: u.round(q * u.num(p.cost)), retail: u.round(q * u.num(p.price)) }; });
      return { rows, totalValue: u.sum(rows, 'value'), totalRetail: u.sum(rows, 'retail'), totalQty: u.sum(rows, 'qty'), potentialProfit: u.sum(rows, 'retail') - u.sum(rows, 'value') };
    },
    /** reorder proposals: demand forecast (30-day velocity × lead + safety days) with product-level floors */
    reorderSuggestions() {
      const lead = u.num(ERP.settings.get('reorderLeadDays'), 7), safety = u.num(ERP.settings.get('reorderSafetyDays'), 3);
      const vel = u.keyBy(inv.velocity(30), v => v.product.id);
      return inv.lowStock().map(p => {
        const v = vel[p.id]; const perDay = v ? v.perDay : 0; const target = perDay * (lead + safety);
        const suggested = Math.max(u.num(p.reorderQty), Math.ceil(target - u.num(p.stock)), u.num(p.maxStock) - u.num(p.stock), u.num(p.minStock, 5) * 2 - u.num(p.stock), 1);
        return { product: p, suggested, supplierId: p.supplierId, perDay, daysOfCover: v ? v.daysOfCover : null, forecastDays: lead + safety, forecastQty: u.round(target, 1) };
      });
    },
    /** days of cover & turnover based on last N days sales */
    velocity(days = 30) {
      const from = u.toISODate(u.addDays(new Date(), -days));
      const sold = inv._velocitySold(from);
      return P().all().map(p => { const q = sold[p.id] || 0; const perDay = q / days; return { product: p, sold: q, perDay, daysOfCover: perDay > 0 ? Math.round(u.num(p.stock) / perDay) : null, dead: q === 0 && u.num(p.stock) > 0 }; });
    },
    _velocitySold(from) {
      const key = `${from}:${ERP.db.version('sales')}`;
      if (inv.__vel && inv.__vel.key === key) return inv.__vel.val;
      const sold = {};
      ERP.agg.saleDays(from, null).forEach(({ b }) => b.products.forEach(p => { if (p.productId) sold[p.productId] = (sold[p.productId] || 0) + p.qty; }));
      inv.__vel = { key, val: sold };
      return sold;
    },
  };
  ERP.inventory = inv;
})();
