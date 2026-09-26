/* ==========================================================================
   ERP.purchasing — suppliers, purchase orders, goods receipt, bills, payments
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  const u = ERP.utils;
  const S = () => ERP.db.collection('suppliers');
  const PO = () => ERP.db.collection('purchases');
  const PAY = () => ERP.db.collection('payments');

  function calc(items, discount = 0, taxRate = 0) {
    const lines = items.map(it => ({ ...it, qty: u.num(it.qty), cost: u.num(it.cost), total: u.round(u.num(it.qty) * u.num(it.cost)) }));
    const subtotal = u.round(u.sum(lines, 'total'));
    const tax = u.round((subtotal - u.num(discount)) * u.num(taxRate) / 100);
    return { items: lines, subtotal, discount: u.num(discount), tax, total: u.round(subtotal - u.num(discount) + tax) };
  }

  /** PO/return line unit info: qty & cost are per line unit (e.g. carton); stock/cost go in base units (qty × factor, cost ÷ factor) */
  function unitOf(it) {
    const p = ERP.db.collection('products').get(it.productId);
    const uid = ERP.units.lineUnit(it) || (it.unitId && p && ERP.units.get(p, it.unitId) ? it.unitId : null);
    if (!uid) return { unitId: null, unitName: '', factor: 1, ...(p ? { name: p.name } : {}) };
    const un = p ? ERP.units.get(p, uid) : null;
    if (!un && !(u.num(it.factor) > 1)) throw new Error(`وحدة الشراء غير موجودة للصنف ${it.name || ''}`);
    const unitName = un ? ERP.units.name(p, uid) : (it.unitName || '');
    return { unitId: uid, unitName, factor: un ? u.num(un.factor, 1) : u.num(it.factor, 1), ...(p ? { name: ERP.units.label(p.name, unitName) } : {}) };
  }

  const pur = {
    unitOf,
    /* ---- suppliers ---- */
    suppliers() { return S().all(); },
    supplier(id) { return S().get(id); },
    createSupplier(data) {
      if (!data.name) throw new Error('اسم المورد مطلوب');
      const s = S().insert({ code: ERP.db.nextSeq('SUP', 'SUP', 4), name: data.name.trim(), phone: data.phone || '', address: data.address || '', email: data.email || '', taxNumber: data.taxNumber || '', contact: data.contact || '', balance: 0, openingBalance: 0, notes: data.notes || '', active: true, paymentTerms: u.num(data.paymentTerms) });
      if (u.num(data.openingBalance) > 0) { S().update(s.id, { balance: u.num(data.openingBalance), openingBalance: u.num(data.openingBalance) }); ERP.accounting.postOpeningAP(s, u.num(data.openingBalance)); }
      ERP.audit.log('supplier.create', s.name, s.id);
      return S().get(s.id);
    },
    updateSupplier(id, patch) { const s = S().update(id, patch); ERP.audit.log('supplier.update', s.name, id); return s; },
    removeSupplier(id) {
      const s = S().get(id); if (!s) return;
      if (u.num(s.balance) > 0.009) throw new Error('لا يمكن حذف مورد له رصيد مستحق');
      if (PO().where({ supplierId: id }).length) { S().update(id, { active: false }); return; }
      S().remove(id); ERP.audit.log('supplier.delete', s.name);
    },
    adjustSupplierBalance(id, delta) { const s = S().get(id); if (s) S().update(id, { balance: u.round(u.num(s.balance) + delta), lastActivityAt: u.now() }); },

    /* ---- purchase orders ---- */
    orders() { return PO().all(); },
    order(id) { return PO().get(id); },
    create({ supplierId, items, discount = 0, taxRate = 0, warehouseId = null, expectedDate = '', notes = '', status = 'ordered', date = null, refNo = '' }) {
      const sup = S().get(supplierId); if (!sup) throw new Error('اختر المورد');
      if (!items || !items.length) throw new Error('أضف أصنافاً لأمر الشراء');
      const c = calc(items.map(it => ({ productId: it.productId, name: it.name, qty: it.qty, cost: it.cost, received: 0, expiry: it.expiry || null, batchNo: it.batchNo || '', newPrice: it.newPrice || null, ...unitOf(it) })), discount, taxRate);
      const po = PO().insert({ no: ERP.db.nextSeq('purchase', ERP.settings.prefix('purchase')), date: date || u.now(), supplierId, supplierName: sup.name, ...c, taxRate: u.num(taxRate), paid: 0, due: c.total, status, warehouseId: warehouseId || ERP.inventory.defaultWh(), expectedDate, notes, refNo, userId: ERP.auth.current()?.id, receivedAt: null });
      ERP.audit.log('purchase.create', `${po.no} — ${sup.name} — ${u.fmtMoney(po.total)}`, po.id);
      return po;
    },
    update(id, { items, discount, taxRate, notes, expectedDate, warehouseId, supplierId, refNo }) {
      const po = PO().get(id); if (!po) throw new Error('أمر الشراء غير موجود');
      if (!['draft', 'ordered'].includes(po.status)) throw new Error('لا يمكن تعديل أمر شراء تم استلامه');
      const sup = supplierId ? S().get(supplierId) : null;
      const c = calc((items || po.items).map(it => ({ ...it, received: 0, ...unitOf(it) })), discount ?? po.discount, taxRate ?? po.taxRate);
      return PO().update(id, { ...c, taxRate: u.num(taxRate ?? po.taxRate), due: c.total - po.paid, notes: notes ?? po.notes, expectedDate: expectedDate ?? po.expectedDate, warehouseId: warehouseId || po.warehouseId, supplierId: sup ? sup.id : po.supplierId, supplierName: sup ? sup.name : po.supplierName, refNo: refNo ?? po.refNo });
    },
    /** receive goods (full or partial). receipts: [{productId, qty, cost?, expiry?, batchNo?, newPrice?}]
     *  Stock is always valued at the real (discount-net) PO cost so the weighted average and GL agree;
     *  `updateCost` is kept for API compatibility only (skipping it would make GL ≠ valuation). */
    receive(id, receipts = null, { updateCost = true, updatePrices = true } = {}) {
      const po = PO().get(id); if (!po) throw new Error('أمر الشراء غير موجود');
      if (['received', 'cancelled'].includes(po.status)) throw new Error('تم استلام هذا الأمر بالفعل');
      const items = po.items.map(it => ({ ...it }));
      const hadReceipts = items.some(it => u.num(it.received) > 0);
      // header discount is spread proportionally into every unit cost
      const dRatio = u.num(po.subtotal) > 0 ? u.clamp(u.num(po.discount) / u.num(po.subtotal), 0, 1) : 0;
      let value = 0;
      items.forEach(it => {
        const r = receipts ? (receipts.find(x => x.productId === it.productId && (x.unitId || null) === (ERP.units.lineUnit(it) || null)) || (receipts.every(x => x.unitId === undefined) ? receipts.find(x => x.productId === it.productId) : null)) : { qty: it.qty - (it.received || 0) };
        if (!r) return;
        const qty = u.round(Math.min(u.num(r.qty), it.qty - (it.received || 0)), 3);
        if (qty <= 0) return;
        const cost = u.num(r.cost ?? it.cost);
        const f = ERP.units.lineUnit(it) ? u.num(it.factor, 1) : 1; // e.g. 5 cartons × 240 → 120 pieces × 10
        const netCost = u.round(cost * (1 - dRatio), 4);
        const netBase = u.round(cost * (1 - dRatio) / f, 4);
        const mv = ERP.inventory.move({ productId: it.productId, warehouseId: po.warehouseId, qty: u.round(qty * f, 3), type: 'purchase', unitCost: netBase, refType: 'purchase', refId: po.id, note: `استلام ${po.no}`, batch: (r.expiry || it.expiry) ? { batchNo: r.batchNo || it.batchNo || po.no, expiry: r.expiry || it.expiry } : null, silent: true });
        it.received = u.round((it.received || 0) + qty, 3); it.cost = cost;
        value += mv ? mv.value : 0;
        const p = ERP.db.collection('products').get(it.productId);
        if (p) {
          const patch = {};
          if (!p.supplierId) patch.supplierId = po.supplierId;
          if (Object.keys(patch).length) ERP.db.collection('products').update(p.id, patch, { silent: true });
          // new selling price of the line's unit (or base) — audit + shelf-label queue
          const uid = ERP.units.lineUnit(it); const hasUnit = !uid || ERP.units.get(p, uid);
          const np = u.num(r.newPrice ?? it.newPrice);
          if (updatePrices && np > 0 && hasUnit) ERP.units.setPrice(p.id, uid, np, { reason: `من ${po.no}`, silent: true });
          const pp = hasUnit ? ERP.units.price(ERP.db.collection('products').get(p.id), uid) : 0;
          if (hasUnit && pp < netCost) ERP.notifications && ERP.notifications.push({ type: 'warning', title: 'سعر بيع أقل من التكلفة', text: `${p.name}${uid ? ` (${it.unitName})` : ''}: التكلفة ${u.fmtMoney(netCost)} والسعر ${u.fmtMoney(pp)}`, link: 'products' });
        }
      });
      value = u.round(value);
      const allReceived = items.every(it => (it.received || 0) >= it.qty - 0.0001);
      const c = calc(items, po.discount, po.taxRate);
      PO().update(id, { items: c.items, subtotal: c.subtotal, tax: c.tax, total: c.total, due: u.round(c.total - po.paid), status: allReceived ? 'received' : 'ordered', receivedAt: allReceived ? u.now() : po.receivedAt, partial: !allReceived });
      // AP recognised at the discount-net received value (+ tax on full receipt)
      if (value > 0) {
        const taxPart = allReceived ? u.round(c.tax - (po.taxPosted || 0)) : 0;
        let ap = u.round(value + taxPart);
        const prevAP = po.apPosted ?? (hadReceipts ? null : 0);
        if (allReceived && prevAP !== null) ap = u.round(c.total - prevAP); // last receipt closes AP exactly at the PO total
        const diff = u.round(ap - value - taxPart); // rounding of the spread discount
        const lines = [{ sys: 'inventory', debit: value, desc: 'مخزون' }];
        if (taxPart > 0) lines.push({ sys: 'vat_out', debit: taxPart, desc: 'ض.ق.م مشتريات' });
        if (diff > 0) lines.push({ sys: 'inv_loss', debit: diff, desc: 'فرق تقريب خصم مورد' }); else if (diff < 0) lines.push({ sys: 'inv_gain', credit: -diff, desc: 'فرق تقريب خصم مورد' });
        lines.push({ sys: 'ap', credit: ap, desc: po.supplierName });
        ERP.accounting.post({ date: u.now(), memo: `استلام ${po.no} — ${po.supplierName}`, refType: 'purchase', refId: po.id, lines });
        pur.adjustSupplierBalance(po.supplierId, ap);
        PO().update(id, { ...(allReceived ? { taxPosted: c.tax } : {}), ...(prevAP !== null ? { apPosted: u.round(prevAP + ap) } : {}) }, { silent: true });
      }
      ERP.bus.emit('db:change', { collection: 'products', op: 'bulk' });
      ERP.audit.log('purchase.receive', `${po.no}: ${allReceived ? 'استلام كامل' : 'استلام جزئي'} بقيمة ${u.fmtMoney(value)}`, po.id);
      return PO().get(id);
    },
    cancel(id) {
      const po = PO().get(id); if (!po) return;
      if (po.items.some(it => it.received > 0)) throw new Error('لا يمكن إلغاء أمر تم استلام جزء منه — استخدم مرتجع الشراء');
      PO().update(id, { status: 'cancelled' });
      ERP.audit.log('purchase.cancel', po.no, id);
    },
    remove(id) { const po = PO().get(id); if (!po) return; if (po.status !== 'draft' && po.status !== 'cancelled') throw new Error('احذف المسودات أو الملغاة فقط'); PO().remove(id); },
    paySupplier({ supplierId, amount, method = 'cash', notes = '', poId = null, date = null }) {
      const sup = S().get(supplierId); amount = u.round(u.num(amount));
      if (!sup) throw new Error('المورد غير موجود');
      if (amount <= 0) throw new Error('المبلغ غير صالح');
      const pay = PAY().insert({ no: ERP.db.nextSeq('payment', ERP.settings.prefix('payment')), date: date || u.now(), type: 'payment', partyType: 'supplier', partyId: supplierId, partyName: sup.name, amount, method, refType: poId ? 'purchase' : null, refId: poId, notes, userId: ERP.auth.current()?.id });
      pur.adjustSupplierBalance(supplierId, -amount);
      let rem = amount;
      const open = u.sortBy(PO().all().filter(p => p.supplierId === supplierId && p.due > 0 && !['cancelled', 'draft'].includes(p.status) && (!poId || p.id === poId)), 'date');
      for (const p of open) { if (rem <= 0) break; const a = Math.min(rem, p.due); PO().update(p.id, { paid: u.round(p.paid + a), due: u.round(p.due - a), payments: [...(p.payments || []), { method, amount: a, date: pay.date, paymentId: pay.id }] }, { silent: true }); rem -= a; }
      ERP.bus.emit('db:change', { collection: 'purchases', op: 'bulk' });
      ERP.accounting.postSupplierPayment(pay);
      if (method === 'cash') { const sh = ERP.shifts.current(); if (sh) ERP.db.collection('shifts').update(sh.id, { cashOut: u.round(sh.cashOut + amount) }, { silent: true }); }
      ERP.audit.log('purchase.pay', `${sup.name}: ${u.fmtMoney(amount)}`, pay.id);
      return pay;
    },
    /** [cheques] undo a supplier payment: restores the bills it settled, the supplier balance, the GL entry and (cash) the open shift */
    deletePayment(payId) {
      const p = PAY().get(payId); if (!p || p.type !== 'payment') return;
      PO().all().filter(o => (o.payments || []).some(x => x.paymentId === payId)).forEach(o => { const a = u.round(u.sum(o.payments.filter(x => x.paymentId === payId), 'amount')); PO().update(o.id, { paid: u.round(Math.max(0, u.num(o.paid) - a)), due: u.round(u.num(o.due) + a), payments: o.payments.filter(x => x.paymentId !== payId) }, { silent: true }); });
      ERP.bus.emit('db:change', { collection: 'purchases', op: 'bulk' });
      pur.adjustSupplierBalance(p.partyId, p.amount);
      ERP.accounting.unpost('payment', payId);
      if (p.method === 'cash') { const sh = ERP.shifts.current(); if (sh && u.toISODate(p.date) >= u.toISODate(sh.openedAt)) ERP.db.collection('shifts').update(sh.id, { cashOut: u.round(Math.max(0, u.num(sh.cashOut) - p.amount)) }, { silent: true }); }
      PAY().remove(payId);
      ERP.audit.log('purchase.pay', `حذف سداد ${p.no}`, payId);
    },
    /** [cheques] bill due date = explicit po.dueDate, else receipt (or order) date + payment terms (PO terms, else the supplier's) */
    dueDate(po) { if (!po) return null; if (po.dueDate) return po.dueDate; const sup = S().get(po.supplierId); const terms = u.num(po.paymentTerms ?? (sup && sup.paymentTerms)); return u.toISODate(u.addDays(po.receivedAt || po.date, terms)); },
    /** return goods to supplier: items [{productId, qty, cost}] — from the PO's warehouse, input VAT reversed */
    returnToSupplier({ supplierId, items, notes = '', poId = null, warehouseId = null }) {
      const sup = S().get(supplierId); if (!sup) throw new Error('المورد غير موجود');
      if (!items || !items.length) throw new Error('حدد أصناف المرتجع');
      const po = poId ? PO().get(poId) : null;
      const wh = warehouseId || (po && po.warehouseId) || ERP.inventory.defaultWh();
      // same discount spread as on receipt, so the supplier is debited the net price actually billed
      const dRatio = po && u.num(po.subtotal) > 0 ? u.clamp(u.num(po.discount) / u.num(po.subtotal), 0, 1) : 0;
      const allowNeg = ERP.inventory.canGoNegative(); const need = {};
      const lines = items.map(it => {
        const p = ERP.db.collection('products').get(it.productId); if (!p) throw new Error('المنتج غير موجود');
        const qty = Number(it.qty), cost = Number(it.cost);
        if (!isFinite(qty) || qty <= 0) throw new Error(`كمية غير صالحة للصنف ${p.name}`);
        if (!isFinite(cost) || cost < 0) throw new Error(`سعر غير صالح للصنف ${p.name}`);
        const un = unitOf(it); // qty/cost per unit (carton) → stock moves in base units
        need[p.id] = u.round((need[p.id] || 0) + qty * un.factor, 3);
        if (!allowNeg && ERP.inventory.whQty(p, wh) < need[p.id] - 0.0001) throw new Error(`رصيد غير كافٍ للمنتج "${p.name}" (المتاح ${u.fmtQty(ERP.inventory.whQty(p, wh))})`);
        const net = u.round(cost * (1 - dRatio), 4);
        return { ...it, ...un, qty, baseQty: u.round(qty * un.factor, 3), cost: net, grossCost: cost, total: u.round(qty * net) };
      });
      const subtotal = u.round(u.sum(lines, 'total'));
      const taxRate = po && u.num(po.taxPosted) > 0 ? u.num(po.taxRate) : 0; // only reverse input VAT that was actually posted
      const tax = taxRate > 0 ? u.round(subtotal * taxRate / 100) : 0;
      const total = u.round(subtotal + tax);
      const ret = PO().insert({ no: ERP.db.nextSeq('PRET', 'PRET', 5), date: u.now(), type: 'return', supplierId, supplierName: sup.name, items: lines, subtotal, discount: 0, taxRate, tax, total, paid: 0, due: 0, status: 'received', refPoId: poId, notes, userId: ERP.auth.current()?.id, warehouseId: wh });
      let invValue = 0;
      lines.forEach(l => { const mv = ERP.inventory.move({ productId: l.productId, warehouseId: wh, qty: -l.baseQty, type: 'return_out', refType: 'purchase_return', refId: ret.id, note: `مرتجع للمورد ${sup.name}`, allowNegative: allowNeg, silent: true }); if (mv) invValue += -mv.value; });
      PO().update(ret.id, { invValue: u.round(invValue) }, { silent: true });
      pur.adjustSupplierBalance(supplierId, -total);
      ERP.accounting.postPurchaseReturn(ret, u.round(invValue));
      ERP.bus.emit('db:change', { collection: 'products', op: 'bulk' });
      ERP.audit.log('purchase.return', `${ret.no} — ${sup.name} — ${u.fmtMoney(total)}`, ret.id);
      return ret;
    },
    statement(supplierId, { from, to } = {}) {
      const s = S().get(supplierId);
      const rows = [];
      PO().all().filter(p => p.supplierId === supplierId && !['cancelled', 'draft'].includes(p.status)).forEach(p => {
        if (p.type === 'return') rows.push({ date: p.date, type: 'مرتجع', ref: p.no, desc: `${p.items.length} صنف`, debit: p.total, credit: 0, doc: p });
        else if (p.receivedAt || p.items.some(i => i.received > 0)) rows.push({ date: p.receivedAt || p.date, type: 'فاتورة شراء', ref: p.no, desc: `${p.items.length} صنف`, debit: 0, credit: u.round(u.sum(p.items, i => (i.received || 0) * i.cost) + (p.status === 'received' ? p.tax - p.discount : 0)), doc: p });
      });
      PAY().all().filter(p => p.partyType === 'supplier' && p.partyId === supplierId).forEach(p => rows.push({ date: p.date, type: 'سداد', ref: p.no, desc: p.notes, debit: p.amount, credit: 0, doc: p }));
      let list = u.sortBy(rows, 'date'); let bal = u.num(s && s.openingBalance);
      list = list.map(r => { bal = u.round(bal + r.credit - r.debit); return { ...r, balance: bal }; });
      const opening = from ? (list.filter(r => u.toISODate(r.date) < from).slice(-1)[0]?.balance ?? u.num(s && s.openingBalance)) : u.num(s && s.openingBalance);
      if (from || to) list = list.filter(r => u.inRange(r.date, from, to));
      return { supplier: s, rows: list, opening, closing: bal };
    },
    performance(supplierId) {
      const pos = PO().all().filter(p => p.supplierId === supplierId && p.type !== 'return' && p.status !== 'cancelled');
      const received = pos.filter(p => p.receivedAt);
      const leadTimes = received.filter(p => p.expectedDate).map(p => u.daysBetween(p.expectedDate, p.receivedAt));
      return { orders: pos.length, total: u.sum(pos, 'total'), received: received.length, onTime: leadTimes.filter(d => d <= 0).length, late: leadTimes.filter(d => d > 0).length, avgLateDays: leadTimes.length ? u.sum(leadTimes.filter(d => d > 0)) / Math.max(1, leadTimes.filter(d => d > 0).length) : 0, lastOrder: pos.length ? u.sortBy(pos, 'date', 'desc')[0].date : null };
    },
    /** auto-generate draft POs grouped by supplier from reorder suggestions */
    autoReorderDrafts() {
      const sugg = ERP.inventory.reorderSuggestions().filter(s => s.supplierId);
      const bySup = u.groupBy(sugg, 'supplierId');
      const created = [];
      Object.entries(bySup).forEach(([supplierId, list]) => {
        if (!S().get(supplierId)) return;
        created.push(pur.create({ supplierId, items: list.map(s => ({ productId: s.product.id, name: s.product.name, qty: Math.ceil(s.suggested), cost: s.product.cost })), status: 'draft', notes: 'أمر تلقائي من اقتراحات إعادة الطلب' }));
      });
      return created;
    },
  };
  ERP.purchasing = pur;
})();
