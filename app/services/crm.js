/* ==========================================================================
   ERP.crm — customers, credit control, receipts, loyalty, statements
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  const u = ERP.utils;
  const C = () => ERP.db.collection('customers');
  const PAY = () => ERP.db.collection('payments');
  const SALES = () => ERP.db.collection('sales');

  const crm = {
    all() { return C().all(); },
    get(id) { return C().get(id); },
    active() { return C().all().filter(c => c.active !== false); },
    findByPhone(phone) { phone = u.normalizeDigits(phone); return C().all().find(c => c.phone && u.normalizeDigits(c.phone) === phone) || null; },
    create(data) {
      if (!data.name) throw new Error('اسم العميل مطلوب');
      if (data.phone && crm.findByPhone(data.phone)) throw new Error('رقم الهاتف مسجل لعميل آخر');
      const c = C().insert({ code: ERP.db.nextSeq('CUS', 'CUS', 4), name: data.name.trim(), phone: data.phone || '', address: data.address || '', email: data.email || '', creditLimit: u.num(data.creditLimit), balance: 0, openingBalance: 0, loyaltyPoints: 0, group: data.group || 'عادي', notes: data.notes || '', active: true, birthday: data.birthday || '', taxNumber: data.taxNumber || '' });
      if (u.num(data.openingBalance) > 0) { C().update(c.id, { balance: u.num(data.openingBalance), openingBalance: u.num(data.openingBalance) }); ERP.accounting.postOpeningAR(c, u.num(data.openingBalance)); }
      ERP.audit.log('customer.create', c.name, c.id);
      return C().get(c.id);
    },
    update(id, patch) { const c = C().update(id, patch); ERP.audit.log('customer.update', c.name, id); return c; },
    remove(id) {
      const c = C().get(id); if (!c) return;
      if (u.num(c.balance) > 0.009) throw new Error('لا يمكن حذف عميل عليه مديونية');
      if (SALES().where({ customerId: id }).length) { C().update(id, { active: false }); ERP.audit.log('customer.update', `تعطيل ${c.name}`); return; }
      C().remove(id); ERP.audit.log('customer.delete', c.name);
    },
    /** balance change (+ increases what the customer owes) */
    adjustBalance(id, delta, { silent = false } = {}) { const c = C().get(id); if (!c) return; return C().update(id, { balance: u.round(u.num(c.balance) + delta), lastActivityAt: u.now() }, { silent }); },
    creditCheck(id, amount) {
      const c = C().get(id); if (!c) return { ok: false, reason: 'العميل غير موجود' };
      if (c.active === false) return { ok: false, reason: 'العميل موقوف' };
      if (c.blocked) return { ok: false, reason: 'العميل محظور من البيع الآجل' };
      const limit = u.num(c.creditLimit);
      if (limit > 0 && u.num(c.balance) + amount > limit) return { ok: false, reason: `تجاوز حد الائتمان (${u.fmtMoney(limit)}) — الرصيد الحالي ${u.fmtMoney(c.balance)}`, over: true };
      return { ok: true };
    },
    receivePayment({ customerId, amount, method = 'cash', notes = '', date = null, saleId = null }) {
      const c = C().get(customerId); amount = u.round(u.num(amount));
      if (!c) throw new Error('العميل غير موجود');
      if (amount <= 0) throw new Error('المبلغ غير صالح');
      const pay = PAY().insert({ no: ERP.db.nextSeq('receipt', ERP.settings.prefix('receipt')), date: date || u.now(), type: 'receipt', partyType: 'customer', partyId: customerId, partyName: c.name, amount, method, refType: saleId ? 'sale' : null, refId: saleId, notes, userId: ERP.auth.current()?.id, shiftId: ERP.shifts.current()?.id || null });
      crm.adjustBalance(customerId, -amount);
      // allocate to open invoices FIFO
      let rem = amount;
      const open = u.sortBy(SALES().all().filter(s => s.customerId === customerId && s.type === 'sale' && s.due > 0 && s.status !== 'void' && (!saleId || s.id === saleId)), 'date');
      const touched = [];
      for (const s of open) { if (rem <= 0) break; const a = u.round(Math.min(rem, s.due)); const paid = u.round(s.paid + a), due = u.round(s.due - a); touched.push(SALES().update(s.id, { paid, due, status: due <= 0 ? 'paid' : 'partial', payments: [...(s.payments || []), { method, amount: a, date: pay.date, receiptId: pay.id }] }, { silent: true })); rem = u.round(rem - a); }
      ERP.bus.emit('db:change', { collection: 'sales', op: 'bulk', docs: touched });
      ERP.accounting.postCustomerReceipt(pay);
      ERP.shifts.recordReceipt(pay);
      ERP.audit.log('customer.receipt', `${c.name}: ${u.fmtMoney(amount)} (${method})`, pay.id);
      return pay;
    },
    /** opts.cheque = true only from ERP.cheques (bounce / cancel keep the cheque record consistent themselves) */
    deleteReceipt(payId, { cheque = false } = {}) {
      const p = PAY().get(payId); if (!p || p.type !== 'receipt') return;
      if (!cheque) { const ch = ERP.cheques && ERP.cheques.linkedTo(p); if (ch) throw new Error(`هذا السند مرتبط بشيك رقم ${ch.number}${ch.status === 'collected' ? ' (تم تحصيله)' : ''} — ألغِ الشيك${ch.status === 'collected' ? ' أو سجّل ارتداده' : ''} من شاشة الشيكات`); }
      // undo the allocations on the invoices (restore paid/due/status)
      const touched = [];
      SALES().all().filter(s => (s.payments || []).some(x => x.receiptId === payId)).forEach(s => {
        const a = u.round(u.sum(s.payments.filter(x => x.receiptId === payId), 'amount'));
        const paid = u.round(Math.max(0, u.num(s.paid) - a)), due = u.round(u.num(s.due) + a);
        const status = s.status === 'returned' || s.status === 'void' ? s.status : due <= 0.009 ? 'paid' : paid > 0.009 ? 'partial' : 'unpaid';
        touched.push(SALES().update(s.id, { paid, due, status, payments: s.payments.filter(x => x.receiptId !== payId) }, { silent: true }));
      });
      if (touched.length) ERP.bus.emit('db:change', { collection: 'sales', op: 'bulk', docs: touched });
      crm.adjustBalance(p.partyId, p.amount);
      ERP.accounting.unpost('receipt', payId);
      ERP.shifts.recordReceipt(p, -1); // take the cash back out of the (open) shift
      PAY().remove(payId);
      ERP.audit.log('customer.receipt', `حذف تحصيل ${p.no}`);
    },
    /** debit/credit statement rows for a customer */
    statement(customerId, { from, to } = {}) {
      const c = C().get(customerId);
      const rows = [];
      SALES().all().filter(s => s.customerId === customerId && s.status !== 'void').forEach(s => {
        if (s.type === 'sale') {
          rows.push({ date: s.date, type: 'فاتورة', ref: s.no, desc: `${s.items.length} صنف`, debit: s.total, credit: 0, doc: s });
          let ch = u.num(s.change); // change handed back is not a payment — net it once (cash first)
          u.sortBy((s.payments || []).filter(p => !p.isCredit && p.amount > 0 && !p.receiptId), p => (p.method === 'cash' ? 0 : 1)).forEach(p => { let a = u.num(p.amount); if (ch > 0) { const c = Math.min(ch, a); a = u.round(a - c); ch = u.round(ch - c); } if (a > 0) rows.push({ date: p.date || s.date, type: 'دفع فوري', ref: s.no, desc: ERP.pos ? ERP.pos.methodName(p.method) : p.method, debit: 0, credit: a }); });
        }
        // a return only reduces the account by the part credited to it (cash refunds settle on the spot)
        else rows.push({ date: s.date, type: 'مرتجع', ref: s.no, desc: `مرتجع ${s.refNo || ''}`, debit: 0, credit: u.round(u.sum((s.payments || []).filter(p => p.isCredit || p.method === 'credit'), 'amount')), doc: s });
      });
      PAY().all().filter(p => p.partyType === 'customer' && p.partyId === customerId).forEach(p => rows.push({ date: p.date, type: 'تحصيل', ref: p.no, desc: p.notes || (ERP.pos ? ERP.pos.methodName(p.method) : p.method), debit: 0, credit: p.amount, doc: p }));
      let list = u.sortBy(rows, 'date');
      // running balance
      let bal = u.num(c && c.openingBalance);
      list = list.map(r => { bal = u.round(bal + r.debit - r.credit); return { ...r, balance: bal }; });
      const opening = list.length && from ? (list.filter(r => u.toISODate(r.date) < from).slice(-1)[0]?.balance ?? u.num(c && c.openingBalance)) : u.num(c && c.openingBalance);
      if (from || to) list = list.filter(r => u.inRange(r.date, from, to));
      return { customer: c, rows: list, opening, closing: bal };
    },
    stats(customerId) {
      const sales = SALES().all().filter(s => s.customerId === customerId && s.type === 'sale' && s.status !== 'void');
      const total = u.sum(sales, 'total');
      return { invoices: sales.length, total, avg: sales.length ? total / sales.length : 0, last: sales.length ? u.sortBy(sales, 'date', 'desc')[0].date : null, profit: u.sum(sales, s => s.total - s.tax - u.num(s.cogs)) };
    },
    debtors() { return C().all().filter(c => u.num(c.balance) > 0.009); },
    overdue(days) {
      days = days ?? u.num(ERP.settings.get('debtDueDays'), 30);
      const cutoff = u.toISODate(u.addDays(new Date(), -days));
      return crm.debtors().map(c => { const oldest = u.sortBy(SALES().all().filter(s => s.customerId === c.id && s.due > 0 && s.status !== 'void'), 'date')[0]; return { customer: c, oldest: oldest ? oldest.date : c.updatedAt, daysOverdue: oldest ? u.daysBetween(oldest.date, new Date()) : 0 }; }).filter(x => u.toISODate(x.oldest) <= cutoff);
    },
    /* ---- loyalty ---- */
    earnPoints(customerId, amount) {
      const s = ERP.settings.all(); if (!s.loyaltyEnabled || !customerId) return 0;
      const pts = Math.floor(u.num(amount) / 10 * u.num(s.loyaltyEarnRate, 1));
      if (pts > 0) { const c = C().get(customerId); C().update(customerId, { loyaltyPoints: u.num(c.loyaltyPoints) + pts, lifetimePoints: u.num(c.lifetimePoints) + pts }, { silent: true }); }
      return pts;
    },
    redeemPoints(customerId, points) {
      const c = C().get(customerId); const s = ERP.settings.all();
      points = Math.min(u.num(points), u.num(c.loyaltyPoints));
      if (points < u.num(s.loyaltyMinRedeem)) throw new Error(`الحد الأدنى للاستبدال ${s.loyaltyMinRedeem} نقطة`);
      C().update(customerId, { loyaltyPoints: u.num(c.loyaltyPoints) - points }, { silent: true });
      return u.round(points * u.num(s.loyaltyRedeemValue));
    },
    pointsValue(points) { return u.round(u.num(points) * u.num(ERP.settings.get('loyaltyRedeemValue'))); },
    GROUPS: ['عادي', 'مميز', 'VIP', 'جملة', 'موظف'],
  };
  ERP.crm = crm;
})();
