/* ==========================================================================
   ERP.cheques — cheques register (incoming from customers / outgoing to suppliers),
   due-date reminders and supplier payables aging (0-30 / 31-60 / 61-90 / 90+)
   Accounting (sys accounts cheques_in 1190 · notes_payable 2170, seeded by ensureAccounts):
   - receive  : customer receipt paid by method 'cheque'   → Dr شيكات تحت التحصيل / Cr العملاء
   - collect  : Dr البنك (أو الخزينة) / Cr شيكات تحت التحصيل
   - bounce   : receipt undone (invoices reopen, balance back) and the GL story kept under the cheque:
                Dr شيكات تحت التحصيل / Cr العملاء (original date) + Dr العملاء / Cr شيكات تحت التحصيل
   - issue    : supplier payment by method 'cheque_out'     → Dr الموردين / Cr أوراق الدفع
   - clear    : Dr أوراق الدفع / Cr البنك
   - bounce   : payment undone (bills reopen, AP back) + Dr الموردين / Cr أوراق الدفع and its reversal
   - cancel   : the receipt / payment is removed entirely (entered by mistake, cheque returned)
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  const u = ERP.utils;
  const CH = () => ERP.db.collection('cheques');
  const PAY = () => ERP.db.collection('payments');
  if (ERP.db.KNOWN && !ERP.db.KNOWN.includes('cheques')) ERP.db.KNOWN.push('cheques'); // part of backups / test snapshots
  if (ERP.branches && ERP.branches.STAMP_COLS) ERP.branches.STAMP_COLS.add('cheques');
  ERP.settings.extend({ chequeAlertDays: 3, apAlertDays: 3 });

  const IN = { safe: ['في الخزينة', 'info'], collecting: ['تحت التحصيل', 'warning'], collected: ['محصّل', 'success'], bounced: ['مرتد', 'danger'], cancelled: ['ملغي', 'neutral'] };
  const OUT = { issued: ['صادر', 'warning'], cleared: ['مصروف', 'success'], bounced: ['مرتد', 'danger'], cancelled: ['ملغي', 'neutral'] };
  const OPEN = { in: ['safe', 'collecting'], out: ['issued'] };
  const METHODS = [
    { id: 'cheque', name: 'شيك وارد', icon: 'money-check', accountSys: 'cheques_in', active: false, isCheque: true },
    { id: 'cheque_out', name: 'شيك صادر', icon: 'money-check-dollar', accountSys: 'notes_payable', active: false, isCheque: true },
  ];
  /* date-only helpers (YYYY-MM-DD, timezone-safe) */
  const day = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : u.toISODate(v));
  const dayDiff = (a, b) => Math.round((Date.parse(day(b)) - Date.parse(day(a))) / 864e5);
  const addDay = (d, n) => new Date(Date.parse(day(d)) + n * 864e5).toISOString().slice(0, 10);
  const who = () => (ERP.auth.current() || {}).name || '';
  const hist = (status, note) => ({ at: u.now(), status, note: note || '', user: who() });
  const atDate = d => (d ? new Date(day(d) + 'T12:00:00').toISOString() : u.now());

  function get(id) { const c = CH().get(id); if (!c) throw new Error('الشيك غير موجود'); return c; }
  function move(c, status, note, patch = {}) { return CH().update(c.id, { ...patch, status, history: [...(c.history || []), hist(status, note)] }); }
  function need(c, dir, statuses, what) { if (c.dir !== dir || !statuses.includes(c.status)) throw new Error(`لا يمكن ${what} — حالة الشيك: ${chq.statusLabel(c)}`); }
  function validate({ number, amount, dueDate }) {
    if (!String(number || '').trim()) throw new Error('رقم الشيك مطلوب');
    if (!(u.round(u.num(amount)) > 0)) throw new Error('المبلغ غير صالح');
    if (!dueDate || !/^\d{4}-\d{2}-\d{2}$/.test(day(dueDate))) throw new Error('تاريخ الاستحقاق مطلوب');
  }
  function dup(dir, number, bank) { const n = String(number).trim(), b = String(bank || '').trim(); return CH().all().some(c => c.dir === dir && c.status !== 'cancelled' && c.number === n && String(c.bank || '').trim() === b); }

  const chq = {
    IN, OUT, OPEN, METHODS, day, dayDiff, addDay,
    all() { return CH().all(); },
    get(id) { return CH().get(id); },
    statusLabel(c) { return ((c.dir === 'out' ? OUT : IN)[c.status] || [c.status])[0]; },
    statusBadge(c) { const x = (c.dir === 'out' ? OUT : IN)[c.status] || [c.status, 'neutral']; return u.badge(x[0], x[1]); },
    /** sys accounts (existing installs get them from seed.ensureAccounts) + hidden payment methods used by receipts/payments */
    ensure() {
      const A = ERP.db.collection('accounts');
      if (!A.first({ sys: 'cheques_in' }) || !A.first({ sys: 'notes_payable' })) ERP.seed.ensureAccounts();
      const PM = ERP.db.collection('paymentMethods');
      METHODS.forEach(m => { if (!PM.get(m.id)) PM.insert({ ...m }, { silent: true }); });
    },

    /* ---------------- incoming (from customers) ---------------- */
    receive({ customerId, amount, number, bank = '', issueDate = '', dueDate, notes = '', saleId = null }) {
      chq.ensure(); validate({ number, amount, dueDate });
      const c = ERP.crm.get(customerId); if (!c) throw new Error('اختر العميل');
      if (dup('in', number, bank)) throw new Error('شيك بنفس الرقم والبنك مسجل من قبل');
      amount = u.round(u.num(amount));
      const pay = ERP.crm.receivePayment({ customerId, amount, method: 'cheque', notes: `شيك ${String(number).trim()}${bank ? ' — ' + bank : ''} يستحق ${day(dueDate)}${notes ? ' · ' + notes : ''}`, saleId });
      const ch = CH().insert({ no: ERP.db.nextSeq('cheque', 'CHQ', 5), dir: 'in', number: String(number).trim(), bank: String(bank || '').trim(), partyType: 'customer', partyId: c.id, partyName: c.name, amount, issueDate: day(issueDate || u.now()), dueDate: day(dueDate), status: 'safe', receiptId: pay.id, receiptNo: pay.no, receiptDate: pay.date, notes, history: [hist('safe', `استلام — إيصال ${pay.no}`)] });
      PAY().update(pay.id, { chequeId: ch.id }, { silent: true });
      ERP.audit.log('cheque.receive', `${ch.no} · ${c.name} · ${u.fmtMoney(amount)}`, ch.id);
      return ch;
    },
    /** handed to the bank for collection (no GL — still under collection) */
    deposit(id, { bank = '', note = '' } = {}) { const c = get(id); need(c, 'in', ['safe'], 'إيداع الشيك'); const r = move(c, 'collecting', note || `إيداع للتحصيل${bank ? ' — ' + bank : ''}`, { depositedAt: u.now(), depositBank: bank }); ERP.audit.log('cheque.deposit', c.no, id); return r; },
    collect(id, { date = null, accountSys = 'bank', note = '' } = {}) {
      const c = get(id); need(c, 'in', ['safe', 'collecting'], 'تحصيل الشيك');
      if (!['bank', 'cash'].includes(accountSys)) throw new Error('حساب التحصيل غير صالح');
      const at = atDate(date);
      ERP.accounting.post({ date: at, memo: `تحصيل شيك ${c.number} — ${c.partyName}`, refType: 'cheque', refId: c.id, lines: [{ sys: accountSys, debit: c.amount, desc: `شيك ${c.number}` }, { sys: 'cheques_in', credit: c.amount, desc: c.partyName }] });
      const r = move(c, 'collected', note || 'تم التحصيل', { collectedAt: at, collectAccountSys: accountSys });
      ERP.audit.log('cheque.collect', `${c.no} · ${u.fmtMoney(c.amount)}`, id); return r;
    },

    /* ---------------- outgoing (to suppliers) ---------------- */
    issue({ supplierId, amount, number, bank = '', issueDate = '', dueDate, notes = '', poId = null }) {
      chq.ensure(); validate({ number, amount, dueDate });
      const s = ERP.purchasing.supplier(supplierId); if (!s) throw new Error('اختر المورد');
      if (dup('out', number, bank)) throw new Error('شيك بنفس الرقم والبنك مسجل من قبل');
      amount = u.round(u.num(amount));
      const pay = ERP.purchasing.paySupplier({ supplierId, amount, method: 'cheque_out', notes: `شيك ${String(number).trim()}${bank ? ' — ' + bank : ''} يستحق ${day(dueDate)}${notes ? ' · ' + notes : ''}`, poId });
      const ch = CH().insert({ no: ERP.db.nextSeq('cheque', 'CHQ', 5), dir: 'out', number: String(number).trim(), bank: String(bank || '').trim(), partyType: 'supplier', partyId: s.id, partyName: s.name, amount, issueDate: day(issueDate || u.now()), dueDate: day(dueDate), status: 'issued', paymentId: pay.id, paymentNo: pay.no, paymentDate: pay.date, notes, history: [hist('issued', `إصدار — سند ${pay.no}`)] });
      PAY().update(pay.id, { chequeId: ch.id }, { silent: true });
      ERP.audit.log('cheque.issue', `${ch.no} · ${s.name} · ${u.fmtMoney(amount)}`, ch.id);
      return ch;
    },
    clear(id, { date = null, note = '' } = {}) {
      const c = get(id); need(c, 'out', ['issued'], 'صرف الشيك');
      const at = atDate(date);
      ERP.accounting.post({ date: at, memo: `صرف شيك صادر ${c.number} — ${c.partyName}`, refType: 'cheque', refId: c.id, lines: [{ sys: 'notes_payable', debit: c.amount, desc: `شيك ${c.number}` }, { sys: 'bank', credit: c.amount, desc: c.partyName }] });
      const r = move(c, 'cleared', note || 'صُرف من البنك', { clearedAt: at });
      ERP.audit.log('cheque.clear', `${c.no} · ${u.fmtMoney(c.amount)}`, id); return r;
    },

    /* ---------------- bounce / cancel (both directions) ---------------- */
    bounce(id, { reason = '' } = {}) {
      const c = get(id);
      if (c.dir === 'in') {
        need(c, 'in', ['safe', 'collecting', 'collected'], 'ارتداد الشيك');
        if (c.status === 'collected') ERP.accounting.post({ memo: `عكس تحصيل شيك مرتد ${c.number}`, refType: 'cheque', refId: c.id, lines: [{ sys: 'cheques_in', debit: c.amount, desc: `شيك ${c.number}` }, { sys: c.collectAccountSys || 'bank', credit: c.amount, desc: 'ارتداد' }] });
        const pay = c.receiptId && PAY().get(c.receiptId);
        if (pay) {
          ERP.crm.deleteReceipt(pay.id); // invoices reopen, customer balance back, receipt entry removed …
          // … and the story is kept under the cheque: receipt at its original date, then the bounce
          ERP.accounting.post({ date: c.receiptDate || c.createdAt, memo: `استلام شيك ${c.number} — ${c.partyName} (إيصال ${c.receiptNo})`, refType: 'cheque', refId: c.id, lines: [{ sys: 'cheques_in', debit: c.amount, desc: `شيك ${c.number}` }, { sys: 'ar', credit: c.amount, desc: c.partyName }] });
          ERP.accounting.post({ memo: `ارتداد شيك ${c.number} — ${c.partyName}`, refType: 'cheque', refId: c.id, lines: [{ sys: 'ar', debit: c.amount, desc: c.partyName }, { sys: 'cheques_in', credit: c.amount, desc: `شيك مرتد ${c.number}` }] });
        }
      } else {
        need(c, 'out', ['issued'], 'ارتداد الشيك');
        const pay = c.paymentId && PAY().get(c.paymentId);
        if (pay) {
          ERP.purchasing.deletePayment(pay.id); // bills reopen, supplier balance back, payment entry removed …
          ERP.accounting.post({ date: c.paymentDate || c.createdAt, memo: `شيك صادر ${c.number} — ${c.partyName} (سند ${c.paymentNo})`, refType: 'cheque', refId: c.id, lines: [{ sys: 'ap', debit: c.amount, desc: c.partyName }, { sys: 'notes_payable', credit: c.amount, desc: `شيك ${c.number}` }] });
          ERP.accounting.post({ memo: `ارتداد شيك صادر ${c.number} — ${c.partyName}`, refType: 'cheque', refId: c.id, lines: [{ sys: 'notes_payable', debit: c.amount, desc: `شيك مرتد ${c.number}` }, { sys: 'ap', credit: c.amount, desc: c.partyName }] });
        }
      }
      const r = move(get(id), 'bounced', reason || 'ارتد الشيك', { bouncedAt: u.now(), bounceReason: reason });
      ERP.audit.log('cheque.bounce', `${c.no} · ${c.partyName} · ${u.fmtMoney(c.amount)}${reason ? ' · ' + reason : ''}`, id);
      return r;
    },
    cancel(id, { reason = '' } = {}) {
      const c = get(id);
      need(c, c.dir, OPEN[c.dir] || [], 'إلغاء الشيك');
      if (c.dir === 'in') { if (c.receiptId && PAY().get(c.receiptId)) ERP.crm.deleteReceipt(c.receiptId); }
      else if (c.paymentId && PAY().get(c.paymentId)) ERP.purchasing.deletePayment(c.paymentId);
      const r = move(get(id), 'cancelled', reason || 'إلغاء', { cancelledAt: u.now() });
      ERP.audit.log('cheque.cancel', `${c.no}${reason ? ' · ' + reason : ''}`, id);
      return r;
    },
    /** allowed actions for a cheque in its current state */
    actions(c) {
      if (c.dir === 'in') return { safe: ['deposit', 'collect', 'bounce', 'cancel'], collecting: ['collect', 'bounce', 'cancel'], collected: ['bounce'] }[c.status] || [];
      return { issued: ['clear', 'bounce', 'cancel'] }[c.status] || [];
    },

    /* ---------------- reminders ---------------- */
    /** open cheques due within `days` (and overdue ones) → [{ cheque, overdue, daysLeft }] */
    due({ days = null, today = null, list = null } = {}) {
      days = days ?? u.num(ERP.settings.get('chequeAlertDays'), 3); today = day(today || u.now());
      const lim = addDay(today, days);
      return u.sortBy((list || CH().all()).filter(c => (OPEN[c.dir] || []).includes(c.status) && c.dueDate && c.dueDate <= lim).map(c => ({ cheque: c, overdue: c.dueDate < today, daysLeft: dayDiff(today, c.dueDate) })), x => x.cheque.dueDate);
    },
    totals(list = CH().all()) {
      const s = (dir, st) => u.round(u.sum(list.filter(c => c.dir === dir && st.includes(c.status)), 'amount'));
      return { inSafe: s('in', ['safe']), inCollecting: s('in', ['collecting']), inOpen: s('in', OPEN.in), outOpen: s('out', OPEN.out) };
    },

    /* ---------------- supplier payables: bills, due dates, aging ---------------- */
    /** received purchase bills of a supplier → [{ po, billDate, dueDate, amount, terms }] */
    bills(supplierId) {
      const sup = ERP.purchasing.supplier(supplierId);
      return ERP.purchasing.orders().filter(p => p.supplierId === supplierId && p.type !== 'return' && !['cancelled', 'draft'].includes(p.status) && (p.receivedAt || (p.items || []).some(i => u.num(i.received) > 0))).map(p => {
        const amount = p.status === 'received' ? u.num(p.total) : u.num(p.apPosted ?? u.sum(p.items, i => u.num(i.received) * u.num(i.cost)));
        const terms = u.num(p.paymentTerms ?? (sup && sup.paymentTerms));
        const billDate = day(p.receivedAt || p.date);
        return { po: p, billDate, dueDate: p.dueDate ? day(p.dueDate) : addDay(billDate, terms), amount: u.round(amount), terms, explicit: !!p.dueDate };
      });
    },
    bucketOf(age) { return age <= 30 ? 'b0' : age <= 60 ? 'b31' : age <= 90 ? 'b61' : 'b91'; },
    BUCKETS: { b0: '0-30 يوم', b31: '31-60 يوم', b61: '61-90 يوم', b91: 'أكثر من 90 يوم' },
    /** allocate each supplier's balance to its newest bills first (what is still owed is the latest billing);
     *  any remainder (opening balance / older history) is aged from the supplier's creation date. Totals = balances. */
    aging({ today = null, supplierIds = null } = {}) {
      today = day(today || u.now());
      const sups = ERP.purchasing.suppliers().filter(s => u.num(s.balance) > 0.009 && (!supplierIds || supplierIds.includes(s.id)));
      const rows = sups.map(s => {
        let rem = u.round(u.num(s.balance)); const row = { supplier: s, balance: rem, b0: 0, b31: 0, b61: 0, b91: 0, overdue: 0, unallocated: 0, bills: [] };
        for (const b of u.sortBy(chq.bills(s.id), x => x.billDate, 'desc')) {
          if (rem <= 0.009) break;
          const open = u.round(Math.min(rem, b.amount)); if (open <= 0) continue; rem = u.round(rem - open);
          const age = Math.max(0, dayDiff(b.billDate, today)); const k = chq.bucketOf(age);
          row[k] = u.round(row[k] + open);
          const late = dayDiff(b.dueDate, today); // > 0 → days past due
          if (late > 0) row.overdue = u.round(row.overdue + open);
          row.bills.push({ ...b, open, age, bucket: k, lateDays: late });
        }
        if (rem > 0.009) { const age = Math.max(0, dayDiff(s.createdAt || today, today)); const k = chq.bucketOf(age); row[k] = u.round(row[k] + rem); row.unallocated = rem; }
        return row;
      });
      const tot = k => u.round(u.sum(rows, k));
      return { today, rows: u.sortBy(rows, 'balance', 'desc'), totals: { balance: tot('balance'), b0: tot('b0'), b31: tot('b31'), b61: tot('b61'), b91: tot('b91'), overdue: tot('overdue') } };
    },
    /** open bills with a real due date (terms > 0 or explicit) due within `days` or overdue → [{ supplier, bill, overdue, daysLeft }] */
    dueBills({ days = null, today = null } = {}) {
      days = days ?? u.num(ERP.settings.get('apAlertDays'), 3); today = day(today || u.now());
      const lim = addDay(today, days); const out = [];
      chq.aging({ today }).rows.forEach(r => r.bills.forEach(b => { if ((b.terms > 0 || b.explicit) && b.dueDate <= lim) out.push({ supplier: r.supplier, bill: b, overdue: b.dueDate < today, daysLeft: dayDiff(today, b.dueDate) }); }));
      return u.sortBy(out, x => x.bill.dueDate);
    },

    /** notification-center alerts (runs inside ERP.notifications.scan) */
    notify() {
      const N = ERP.notifications; if (!N) return; const today = u.todayISO(); const days = u.num(ERP.settings.get('chequeAlertDays'), 3);
      const d = chq.due(); const od = d.filter(x => x.overdue), soon = d.filter(x => !x.overdue);
      const txt = l => l.slice(0, 3).map(x => `${x.cheque.dir === 'in' ? 'وارد' : 'صادر'} ${x.cheque.number} — ${x.cheque.partyName} (${u.fmtMoney(x.cheque.amount)})`).join('، ') + (l.length > 3 ? '…' : '');
      if (od.length) N.push({ type: 'danger', title: `${od.length} شيك تجاوز تاريخ الاستحقاق`, text: txt(od), link: 'cheques', params: { tab: 'due' }, key: 'chq_od_' + today });
      if (soon.length) N.push({ type: 'warning', title: `${soon.length} شيك يستحق خلال ${days} يوم`, text: txt(soon), link: 'cheques', params: { tab: 'due' }, key: 'chq_soon_' + today });
      const bills = chq.dueBills(); const bo = bills.filter(x => x.overdue), bs = bills.filter(x => !x.overdue);
      const btxt = l => l.slice(0, 3).map(x => `${x.bill.po.no} — ${x.supplier.name} (${u.fmtMoney(x.bill.open)})`).join('، ') + (l.length > 3 ? '…' : '');
      if (bo.length) N.push({ type: 'danger', title: `${bo.length} فاتورة مورد متأخرة السداد (${u.fmtMoney(u.sum(bo, x => x.bill.open))})`, text: btxt(bo), link: 'cheques', params: { tab: 'aging' }, key: 'apdue_od_' + today });
      if (bs.length) N.push({ type: 'warning', title: `${bs.length} فاتورة مورد تستحق قريباً`, text: btxt(bs), link: 'cheques', params: { tab: 'aging' }, key: 'apdue_soon_' + today });
    },
  };
  ERP.cheques = chq;

  if (ERP.notifications && !ERP.notifications.__chq) {
    const orig = ERP.notifications.scan;
    ERP.notifications.scan = function () { try { chq.ensure(); chq.notify(); } catch (err) { console.warn('[cheques] notify', err); } return orig.apply(this, arguments); };
    ERP.notifications.__chq = true;
  }
})();
