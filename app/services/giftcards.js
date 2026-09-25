/* ==========================================================================
   ERP.giftcards — gift cards / prepaid balance usable as a POS payment method
   Selling a card: Dr cash|bank, Cr gift-card liability. Redeeming: Dr liability.
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  const u = ERP.utils;
  const G = () => ERP.db.collection('giftCards');
  function genCode() { let c; do { c = 'GC' + Math.random().toString(36).slice(2, 6).toUpperCase() + Math.floor(1000 + Math.random() * 9000); } while (G().first({ code: c })); return c; }

  const gc = {
    all() { return u.sortBy(G().all(), 'createdAt', 'desc'); },
    byCode(code) { code = u.normalizeDigits(String(code || '')).trim().toUpperCase(); return G().all().find(c => c.code === code) || null; },
    ensureMethod() { const PM = ERP.db.collection('paymentMethods'); if (!PM.get('gift')) PM.insert({ id: 'gift', name: 'بطاقة هدايا / رصيد مسبق', icon: 'gift', accountSys: 'gift', active: true, isGift: true }, { silent: true }); },
    /** sell (issue) a card */
    issue({ amount, method = 'cash', customerId = null, expiryMonths = 12, note = '', code = null }) {
      amount = u.round(u.num(amount)); if (amount <= 0) throw new Error('قيمة البطاقة غير صالحة');
      const cust = customerId ? ERP.crm.get(customerId) : null;
      const card = G().insert({ code: code || genCode(), initial: amount, balance: amount, customerId: cust ? cust.id : null, customerName: cust ? cust.name : '', expiry: expiryMonths ? u.toISODate(new Date(new Date().setMonth(new Date().getMonth() + u.num(expiryMonths)))) : null, status: 'active', note, soldBy: ERP.auth.current()?.id, shiftId: ERP.shifts.current()?.id || null, history: [{ at: u.now(), type: 'issue', amount }] });
      ERP.accounting.post({ date: card.createdAt, memo: `بيع بطاقة هدايا ${card.code}`, refType: 'giftcard', refId: card.id, lines: [{ accountId: ERP.accounting.methodAccount(method).id, debit: amount, desc: 'بيع بطاقة' }, { sys: 'gift', credit: amount, desc: card.code }] });
      if (method === 'cash') { const sh = ERP.shifts.current(); if (sh) ERP.db.collection('shifts').update(sh.id, { cashIn: u.round(sh.cashIn + amount) }, { silent: true }); }
      ERP.audit.log('giftcard.issue', `${card.code} — ${u.fmtMoney(amount)}${cust ? ' — ' + cust.name : ''}`, card.id);
      return card;
    },
    topUp(id, amount, method = 'cash') {
      const card = G().get(id); amount = u.round(u.num(amount)); if (!card || amount <= 0) throw new Error('بيانات غير صالحة');
      const upd = G().update(id, { balance: u.round(card.balance + amount), initial: u.round(card.initial + amount), status: 'active', history: [...(card.history || []), { at: u.now(), type: 'topup', amount }] });
      ERP.accounting.post({ date: u.now(), memo: `شحن بطاقة ${card.code}`, refType: 'giftcard', refId: id, lines: [{ accountId: ERP.accounting.methodAccount(method).id, debit: amount }, { sys: 'gift', credit: amount }] });
      if (method === 'cash') { const sh = ERP.shifts.current(); if (sh) ERP.db.collection('shifts').update(sh.id, { cashIn: u.round(sh.cashIn + amount) }, { silent: true }); }
      ERP.audit.log('giftcard.issue', `شحن ${card.code} +${u.fmtMoney(amount)}`, id);
      return upd;
    },
    /** validate a card for payment; returns {card, available} or throws */
    check(code, amount = 0) {
      const card = gc.byCode(code); if (!card) throw new Error('رقم البطاقة غير موجود');
      if (card.status !== 'active') throw new Error('البطاقة غير نشطة');
      if (card.expiry && card.expiry < u.todayISO()) throw new Error(`البطاقة منتهية منذ ${u.fmtDate(card.expiry)}`);
      if (card.balance <= 0) throw new Error('رصيد البطاقة صفر');
      if (amount > card.balance + 0.009) throw new Error(`رصيد البطاقة ${u.fmtMoney(card.balance)} فقط`);
      return { card, available: card.balance };
    },
    /** deduct after a sale is committed (called by sales.create) */
    redeem(code, amount, saleNo) {
      const { card } = gc.check(code, amount);
      const bal = u.round(card.balance - amount);
      G().update(card.id, { balance: bal, status: bal <= 0.009 ? 'used' : 'active', lastUsedAt: u.now(), history: [...(card.history || []), { at: u.now(), type: 'redeem', amount: -amount, ref: saleNo }] }, { silent: true });
      return bal;
    },
    /** give the value back (sale void / return refunded to the card) */
    refund(code, amount, ref) { const card = gc.byCode(code); if (!card) return; G().update(card.id, { balance: u.round(card.balance + amount), status: 'active', history: [...(card.history || []), { at: u.now(), type: 'refund', amount, ref }] }, { silent: true }); },
    deactivate(id) { const c = G().get(id); if (!c) return; G().update(id, { status: 'disabled' }); ERP.audit.log('giftcard.issue', `تعطيل ${c.code}`, id); },
    liability() { return u.sum(G().all().filter(c => c.status === 'active'), 'balance'); },
  };
  ERP.giftcards = gc;
  ERP.audit.LABELS['giftcard.issue'] = 'بطاقة هدايا';
})();
