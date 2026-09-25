/* ==========================================================================
   ERP.shifts — cashier sessions / cash drawer (open, cash in/out, X & Z report)
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  const u = ERP.utils;
  const S = () => ERP.db.collection('shifts');
  const C = () => ERP.db.collection('cashMoves');

  const shifts = {
    current(userId) {
      userId = userId || ERP.auth.current()?.id;
      return S().all().find(s => s.status === 'open' && (!userId || s.userId === userId)) || null;
    },
    anyOpen() { return S().where({ status: 'open' }); },
    open({ openingCash = 0, notes = '' } = {}) {
      const user = ERP.auth.current();
      if (shifts.current(user.id)) throw new Error('لديك وردية مفتوحة بالفعل');
      const sh = S().insert({ no: ERP.db.nextSeq('SHIFT', 'SH', 5), userId: user.id, userName: user.name, openedAt: u.now(), closedAt: null, openingCash: u.num(openingCash), closingCash: null, status: 'open', notes, salesCount: 0, salesTotal: 0, cashSales: 0, cardSales: 0, otherSales: 0, returnsTotal: 0, cashIn: 0, cashOut: 0, receiptsCash: 0 });
      ERP.audit.log('shift.open', `${sh.no} برصيد افتتاحي ${u.fmtMoney(openingCash)}`, sh.id);
      ERP.bus.emit('shift:change', sh);
      return sh;
    },
    /** cash/card/other effect of a sale or return on the drawer (change counted once; receipt allocations excluded) */
    _drawer(sale) {
      const d = { cash: 0, card: 0, other: 0 };
      let ch = sale.type === 'return' ? 0 : u.num(sale.change); // change comes out of cash first (same order as the GL posting)
      u.sortBy((sale.payments || []).filter(p => !p.isCredit && !p.receiptId && p.amount > 0), p => (p.method === 'cash' ? 0 : 1)).forEach(p => { let a = u.num(p.amount); if (ch > 0) { const c = Math.min(ch, a); a -= c; ch -= c; } const k = p.method === 'cash' ? 'cash' : p.method === 'card' ? 'card' : 'other'; d[k] += a; });
      const sg = sale.type === 'return' ? -1 : 1; d.cash = u.round(sg * d.cash); d.card = u.round(sg * d.card); d.other = u.round(sg * d.other);
      return d;
    },
    /** called by sales service after each sale/return (sign = -1 reverses it, used by void) */
    recordSale(sale, sign = 1) {
      const sh = sale.shiftId ? S().get(sale.shiftId) : null; if (!sh || (sign < 0 && sh.status !== 'open')) return;
      const d = shifts._drawer(sale);
      const patch = { cashSales: u.round(u.num(sh.cashSales) + sign * d.cash), cardSales: u.round(u.num(sh.cardSales) + sign * d.card), otherSales: u.round(u.num(sh.otherSales) + sign * d.other) };
      if (sale.type === 'return') patch.returnsTotal = u.round(u.num(sh.returnsTotal) + sign * sale.total);
      else { patch.salesCount = Math.max(0, u.num(sh.salesCount) + sign); patch.salesTotal = u.round(u.num(sh.salesTotal) + sign * sale.total); }
      S().update(sh.id, patch, { silent: true });
    },
    unrecordSale(sale) { return shifts.recordSale(sale, -1); },
    recordReceipt(pay, sign = 1) { const sh = pay.shiftId ? S().get(pay.shiftId) : shifts.current(); if (!sh || sh.status !== 'open' || pay.method !== 'cash') return; S().update(sh.id, { receiptsCash: u.round(u.num(sh.receiptsCash) + sign * pay.amount) }, { silent: true }); },
    cashMove({ type, amount, notes = '' }) {
      const sh = shifts.current(); amount = Math.abs(u.num(amount));
      if (!amount) throw new Error('المبلغ غير صالح');
      const cm = C().insert({ date: u.now(), type, amount, notes, shiftId: sh ? sh.id : null, userId: ERP.auth.current()?.id });
      if (sh) S().update(sh.id, type === 'in' || type === 'deposit' || type === 'from_bank' ? { cashIn: u.round(sh.cashIn + amount) } : { cashOut: u.round(sh.cashOut + amount) }, { silent: true });
      if (['deposit', 'withdraw', 'to_bank', 'from_bank'].includes(type)) ERP.accounting.postCashMove(cm);
      ERP.audit.log(type === 'in' || type === 'deposit' || type === 'from_bank' ? 'cash.in' : 'cash.out', `${u.fmtMoney(amount)} — ${notes}`, cm.id);
      ERP.bus.emit('shift:change', sh);
      return cm;
    },
    expected(sh) { return u.round(sh.openingCash + sh.cashSales + sh.receiptsCash + sh.cashIn - sh.cashOut); },
    /** count (optional) = denomination breakdown { lines:[{denom,count}], extra } — its total becomes the closing cash (ERP.cashcount) */
    close(shiftId, { closingCash, notes = '', count = null, approvedBy = null }) {
      const sh = S().get(shiftId); if (!sh || sh.status !== 'open') throw new Error('الوردية غير مفتوحة');
      const expected = shifts.expected(sh);
      const cnt = count && ERP.cashcount ? ERP.cashcount.sum(count) : null; if (cnt) closingCash = cnt.total;
      const closingCount = cnt ? { lines: cnt.lines, extra: cnt.extra, total: cnt.total, at: u.now(), by: ERP.auth.current()?.name || '' } : null;
      const closed = S().update(shiftId, { status: 'closed', closedAt: u.now(), closingCash: u.num(closingCash), expectedCash: expected, difference: u.round(u.num(closingCash) - expected), closeNotes: notes, closingCount, closeApprovedBy: approvedBy ? { id: approvedBy.id, name: approvedBy.name } : null });
      ERP.audit.log('shift.close', `${sh.no}: متوقع ${u.fmtMoney(expected)} فعلي ${u.fmtMoney(closingCash)} فرق ${u.fmtMoney(closed.difference)}${cnt ? ' (عدّ بالفئات)' : ''}${approvedBy ? ' — اعتماد ' + approvedBy.name : ''}`, sh.id);
      ERP.bus.emit('shift:change', closed);
      return closed;
    },
    report(shiftId) {
      const sh = S().get(shiftId); if (!sh) return null;
      const sales = ERP.db.collection('sales').where({ shiftId });
      const byMethod = {};
      sales.filter(s => s.status !== 'void').forEach(s => { let ch = s.type === 'return' ? 0 : u.num(s.change); u.sortBy((s.payments || []).filter(p => !p.receiptId && p.amount > 0), p => (p.method === 'cash' ? 0 : 1)).forEach(p => { let a = u.num(p.amount); if (ch > 0 && !p.isCredit) { const c = Math.min(ch, a); a -= c; ch -= c; } byMethod[p.method] = u.round((byMethod[p.method] || 0) + (s.type === 'return' ? -a : a)); }); });
      const items = {};
      sales.filter(s => s.status !== 'void').forEach(s => s.items.forEach(it => { const k = it.productId || it.name; items[k] = items[k] || { name: it.name, qty: 0, total: 0 }; items[k].qty += (s.type === 'return' ? -1 : 1) * it.qty; items[k].total += (s.type === 'return' ? -1 : 1) * it.total; }));
      return { shift: sh, sales, byMethod, topItems: u.sortBy(Object.values(items), 'total', 'desc').slice(0, 15), cashMoves: C().where({ shiftId }), expected: shifts.expected(sh), voids: sales.filter(s => s.status === 'void').length, discounts: u.sum(sales.filter(s => s.type === 'sale' && s.status !== 'void'), 'discount') };
    },
    history(n = 50) { return S().latest(n, 'openedAt'); },
  };
  ERP.shifts = shifts;
})();
