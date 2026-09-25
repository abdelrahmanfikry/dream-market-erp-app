/* ==========================================================================
   ERP.accounting — double-entry general ledger
   Every business event (sale, purchase, payment, expense…) posts a balanced
   journal entry. Reports are derived from the journal, never stored.
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  const u = ERP.utils;
  const acc = () => ERP.db.collection('accounts');
  const jr = () => ERP.db.collection('journal');
  const NORMAL_DEBIT = { asset: true, expense: true, liability: false, equity: false, revenue: false };

  function bySys(sys) { const a = acc().first({ sys }); if (!a) throw new Error(`حساب النظام غير موجود: ${sys}`); return a; }
  function methodAccount(methodId) {
    const m = ERP.db.collection('paymentMethods').get(methodId);
    const sys = m ? m.accountSys : 'cash';
    return bySys(sys);
  }

  const A = {
    NORMAL_DEBIT,
    accounts() { return acc().all(); },
    get(id) { return acc().get(id); },
    bySys, methodAccount,
    tree() {
      const all = u.sortBy(acc().all(), 'code');
      const children = u.groupBy(all, a => a.parentId || 'root');
      const walk = (pid, lvl) => (children[pid] || []).flatMap(a => [{ ...a, level: lvl, hasChildren: !!children[a.id] }, ...walk(a.id, lvl + 1)]);
      return walk('root', 1);
    },
    createAccount({ code, name, type, parentId }) {
      if (acc().first({ code })) throw new Error('كود الحساب مستخدم');
      return acc().insert({ code, name, type, parentId: parentId || null, sys: null, isSystem: false, active: true });
    },
    updateAccount(id, patch) { const a = acc().get(id); if (!a) throw new Error('الحساب غير موجود'); if (a.isSystem) delete patch.type; return acc().update(id, patch); },
    deleteAccount(id) {
      const a = acc().get(id); if (!a) return;
      if (a.isSystem) throw new Error('لا يمكن حذف حسابات النظام');
      if (acc().where({ parentId: id }).length) throw new Error('الحساب له حسابات فرعية');
      if (jr().all().some(j => j.lines.some(l => l.accountId === id))) throw new Error('الحساب عليه حركات');
      acc().remove(id);
    },

    /** post a balanced entry. lines: [{accountId|sys, debit, credit, desc}] */
    /** normalise + validate lines without writing (throws on unknown account / imbalance) */
    validate(lines, { allowUnbalanced = false } = {}) {
      const norm = lines.map(l => ({ accountId: l.accountId || bySys(l.sys).id, debit: u.round(u.num(l.debit)), credit: u.round(u.num(l.credit)), desc: l.desc || '' })).filter(l => l.debit || l.credit);
      if (norm.some(l => l.debit < 0 || l.credit < 0)) throw new Error('القيد يحتوي على مبالغ سالبة');
      const d = u.round(u.sum(norm, 'debit')), c = u.round(u.sum(norm, 'credit'));
      if (!allowUnbalanced && Math.abs(d - c) > 0.011) throw new Error(`القيد غير متوازن: مدين ${d} / دائن ${c}`);
      return norm;
    },
    post({ date, memo, refType = null, refId = null, lines, silent = false, allowUnbalanced = false }) {
      const norm = A.validate(lines, { allowUnbalanced });
      if (!norm.length) return null;
      const d = u.round(u.sum(norm, 'debit'));
      const entry = jr().insert({ no: ERP.db.nextSeq('journal', ERP.settings.prefix('journal')), date: date || u.now(), memo: memo || '', refType, refId, lines: norm, total: d, userId: ERP.auth.current()?.id || null, manual: refType === 'manual' }, { silent });
      if (!silent) ERP.bus.emit('accounting:posted', entry);
      return entry;
    },
    /** remove entries that reference a document (used when voiding) */
    unpost(refType, refId) { return jr().removeWhere(j => j.refType === refType && j.refId === refId); },
    reverse(entryId, memo) {
      const e = jr().get(entryId); if (!e) throw new Error('القيد غير موجود');
      return A.post({ date: u.now(), memo: memo || `عكس قيد ${e.no}`, refType: 'reversal', refId: e.id, lines: e.lines.map(l => ({ accountId: l.accountId, debit: l.credit, credit: l.debit, desc: l.desc })) });
    },
    entries({ from, to, accountId, refType, q } = {}) {
      let list = jr().all();
      if (from || to) list = list.filter(j => u.inRange(j.date, from, to));
      if (accountId) list = list.filter(j => j.lines.some(l => l.accountId === accountId));
      if (refType) list = list.filter(j => j.refType === refType);
      if (q) list = list.filter(j => u.match(j.memo + ' ' + j.no, q));
      return u.sortBy(list, 'date', 'desc');
    },

    /* ------------- balances & reports ------------- */
    /** signed balance per account (positive = normal side), including children */
    balances({ from, to } = {}) {
      const raw = ERP.agg ? ERP.agg.journalRaw(from, to) : {};
      const all = acc().all(); const byId = u.keyBy(all);
      const total = {};
      const roll = id => { if (total[id] !== undefined) return total[id]; let t = raw[id] || 0; all.filter(a => a.parentId === id).forEach(ch => { t += roll(ch.id); }); total[id] = t; return t; };
      all.forEach(a => roll(a.id));
      const out = {};
      all.forEach(a => { const dr = total[a.id]; out[a.id] = { debitBal: dr, balance: NORMAL_DEBIT[a.type] ? dr : -dr, own: raw[a.id] || 0 }; });
      return out;
    },
    balance(accountIdOrSys, opts) { const id = acc().get(accountIdOrSys) ? accountIdOrSys : bySys(accountIdOrSys).id; return (A.balances(opts)[id] || { balance: 0 }).balance; },
    ledger(accountId, { from, to } = {}) {
      const opening = from ? u.num((A.balances({ to: u.toISODate(u.addDays(from, -1)) })[accountId] || {}).own) : 0; // own postings, same basis as rows
      const a = acc().get(accountId);
      let bal = from ? opening : 0;
      const rows = [];
      u.sortBy(jr().all().filter(j => u.inRange(j.date, from, to)), 'date').forEach(j => j.lines.filter(l => l.accountId === accountId).forEach(l => { bal += l.debit - l.credit; rows.push({ date: j.date, no: j.no, memo: l.desc || j.memo, refType: j.refType, refId: j.refId, debit: l.debit, credit: l.credit, balance: NORMAL_DEBIT[a.type] ? bal : -bal, entryId: j.id }); }));
      return { account: a, opening: NORMAL_DEBIT[a.type] ? opening : -opening, rows, closing: rows.length ? rows[rows.length - 1].balance : (NORMAL_DEBIT[a.type] ? opening : -opening) };
    },
    trialBalance({ from, to } = {}) {
      const b = A.balances({ from, to });
      // every account with its OWN postings (parents may carry direct entries too)
      const rows = acc().all().map(a => { const v = b[a.id].own; return { account: a, debit: v > 0 ? v : 0, credit: v < 0 ? -v : 0 }; }).filter(r => r.debit > 0.001 || r.credit > 0.001);
      return { rows: u.sortBy(rows, r => r.account.code), totalDebit: u.sum(rows, 'debit'), totalCredit: u.sum(rows, 'credit') };
    },
    pnl({ from, to } = {}) {
      const b = A.balances({ from, to });
      const byType = t => acc().all().filter(a => a.type === t && Math.abs(b[a.id].own) > 0.001).map(a => ({ account: a, amount: NORMAL_DEBIT[t] ? b[a.id].own : -b[a.id].own }));
      const revenue = byType('revenue'), expense = byType('expense');
      const sales = b[bySys('sales').id].balance, returns = b[bySys('sales_returns').id].balance, discounts = b[bySys('discounts').id].balance;
      const netSales = sales + returns + discounts; // contra accounts carry negative balance
      const cogs = b[bySys('cogs').id].balance;
      const totalRevenue = u.sum(revenue, 'amount'), totalExpense = u.sum(expense, 'amount');
      const otherIncome = totalRevenue - netSales;
      const opex = totalExpense - cogs;
      return { revenue, expense, sales, returns, discounts, netSales, cogs, grossProfit: netSales - cogs, otherIncome, opex, totalRevenue, totalExpense, netProfit: totalRevenue - totalExpense, margin: netSales ? ((netSales - cogs) / netSales) * 100 : 0 };
    },
    balanceSheet({ asOf } = {}) {
      const b = A.balances({ to: asOf });
      const leaf = t => acc().all().filter(a => a.type === t && Math.abs(b[a.id].own) > 0.001).map(a => ({ account: a, amount: NORMAL_DEBIT[t] ? b[a.id].own : -b[a.id].own }));
      const assets = leaf('asset'), liabilities = leaf('liability'), equity = leaf('equity');
      const p = A.pnl({ to: asOf });
      const tA = u.sum(assets, 'amount'), tL = u.sum(liabilities, 'amount'), tE = u.sum(equity, 'amount') + p.netProfit;
      return { assets, liabilities, equity, currentProfit: p.netProfit, totalAssets: tA, totalLiabilities: tL, totalEquity: tE, balanced: Math.abs(tA - (tL + tE)) < 0.05 };
    },
    cashPosition() { const b = A.balances(); const g = sys => (b[bySys(sys).id] || { balance: 0 }).balance; return { cash: g('cash'), bank: g('bank'), wallet: g('wallet'), ar: g('ar'), ap: g('ap'), inventory: g('inventory') }; },

    /* ------------- auto-posting helpers ------------- */
    postSale(sale) { return A.post({ date: sale.date, memo: `فاتورة بيع ${sale.no} — ${sale.customerName}`, refType: 'sale', refId: sale.id, lines: A.saleLines(sale) }); },
    saleLines(sale) {
      const s = ERP.settings.all();
      const lines = [];
      const gross = u.round(sale.subtotal), disc = u.round(sale.discount + (sale.loyaltyDiscount || 0)), tax = u.round(sale.tax);
      // Dr cash/bank per payment (net of change returned to the customer), Dr AR for due
      let change = u.num(sale.change);
      const pays = u.sortBy((sale.payments || []).filter(p => p.amount > 0 && !p.isCredit), p => (p.method === 'cash' ? 0 : 1));
      pays.forEach(p => { let amt = p.amount; if (change > 0) { const c = Math.min(change, amt); amt = u.round(amt - c); change = u.round(change - c); } if (amt > 0) lines.push({ accountId: methodAccount(p.method).id, debit: amt, desc: `تحصيل ${sale.no}` }); });
      if (sale.due > 0) lines.push({ sys: 'ar', debit: sale.due, desc: `آجل ${sale.customerName}` });
      if (sale.loyaltyDiscount > 0) lines.push({ sys: 'loyalty', debit: sale.loyaltyDiscount, desc: 'استبدال نقاط' });
      if (disc - (sale.loyaltyDiscount || 0) > 0) lines.push({ sys: 'discounts', debit: disc - (sale.loyaltyDiscount || 0), desc: 'خصم مبيعات' });
      // Cr sales (net of tax when prices are tax-inclusive), Cr VAT
      lines.push({ sys: 'sales', credit: s.taxInclusive ? u.round(gross - tax) : gross, desc: `مبيعات ${sale.no}` });
      if (tax > 0) lines.push({ sys: 'vat_out', credit: tax, desc: 'ض.ق.م' });
      if (u.num(sale.deliveryFee) > 0) lines.push({ sys: 'other_income', credit: u.num(sale.deliveryFee), desc: 'رسوم توصيل' });
      // COGS
      if (sale.cogs > 0) { lines.push({ sys: 'cogs', debit: sale.cogs, desc: 'تكلفة البضاعة' }); lines.push({ sys: 'inventory', credit: sale.cogs, desc: 'خروج مخزون' }); }
      // loyalty earned liability (expense recognised in discounts)
      if (sale.loyaltyEarned > 0 && s.loyaltyEnabled) { const v = u.round(sale.loyaltyEarned * u.num(s.loyaltyRedeemValue)); if (v > 0) { lines.push({ sys: 'discounts', debit: v, desc: 'نقاط ولاء مكتسبة' }); lines.push({ sys: 'loyalty', credit: v, desc: 'التزام نقاط' }); } }
      return lines;
    },
    postSaleReturn(ret) { return A.post({ date: ret.date, memo: `مرتجع بيع ${ret.no} — ${ret.customerName}`, refType: 'sale_return', refId: ret.id, lines: A.saleReturnLines(ret) }); },
    saleReturnLines(ret) {
      const lines = [];
      // net revenue reversed = refund − VAT (works for tax-inclusive and exclusive prices)
      lines.push({ sys: 'sales_returns', debit: u.round(ret.total - u.num(ret.tax)), desc: `مرتجع ${ret.no}` });
      if (ret.tax > 0) lines.push({ sys: 'vat_out', debit: ret.tax, desc: 'عكس ض.ق.م' });
      (ret.payments || []).forEach(p => { if (p.amount > 0) lines.push({ accountId: p.method === 'credit' ? bySys('ar').id : methodAccount(p.method).id, credit: p.amount, desc: 'رد للعميل' }); });
      if (ret.cogs > 0) { lines.push({ sys: 'inventory', debit: ret.cogs, desc: 'عودة مخزون' }); lines.push({ sys: 'cogs', credit: ret.cogs, desc: 'عكس تكلفة' }); }
      return lines;
    },
    postCustomerReceipt(pay) {
      return A.post({ date: pay.date, memo: `تحصيل من ${pay.partyName}`, refType: 'receipt', refId: pay.id, lines: [{ accountId: methodAccount(pay.method).id, debit: pay.amount, desc: pay.notes }, { sys: 'ar', credit: pay.amount, desc: pay.partyName }] });
    },
    postPurchaseReceive(po, receivedValue) {
      // goods received: Dr inventory, Cr AP (bill recognised at receipt)
      const lines = [{ sys: 'inventory', debit: receivedValue, desc: `استلام ${po.no}` }];
      if (po.tax > 0) lines.push({ sys: 'vat_out', debit: po.tax, desc: 'ض.ق.م مشتريات' });
      lines.push({ sys: 'ap', credit: receivedValue + u.num(po.tax), desc: po.supplierName });
      return A.post({ date: u.now(), memo: `استلام أمر شراء ${po.no} — ${po.supplierName}`, refType: 'purchase', refId: po.id, lines });
    },
    postSupplierPayment(pay) {
      return A.post({ date: pay.date, memo: `سداد للمورد ${pay.partyName}`, refType: 'payment', refId: pay.id, lines: [{ sys: 'ap', debit: pay.amount, desc: pay.partyName }, { accountId: methodAccount(pay.method).id, credit: pay.amount, desc: pay.notes }] });
    },
    postPurchaseReturn(ret, invValue = null) {
      // supplier is debited at the agreed return price; inventory leaves at average cost; the difference is a stock gain/loss
      const tax = u.round(u.num(ret.tax)), net = u.round(ret.total - tax);
      const inv = invValue === null ? net : u.round(invValue);
      const diff = u.round(net - inv);
      const lines = [{ sys: 'ap', debit: ret.total, desc: ret.supplierName }, { sys: 'inventory', credit: inv, desc: 'خروج مخزون' }];
      if (tax > 0) lines.push({ sys: 'vat_out', credit: tax, desc: 'عكس ض.ق.م مشتريات' });
      if (diff > 0) lines.push({ sys: 'inv_gain', credit: diff, desc: 'فرق سعر مرتجع' }); else if (diff < 0) lines.push({ sys: 'inv_loss', debit: -diff, desc: 'فرق سعر مرتجع' });
      return A.post({ date: ret.date, memo: `مرتجع شراء ${ret.no}`, refType: 'purchase_return', refId: ret.id, lines });
    },
    postExpense(exp) {
      const cat = ERP.db.collection('expenseCategories').get(exp.categoryId);
      const expAcc = cat && cat.accountCode ? acc().first({ code: cat.accountCode }) : null;
      return A.post({ date: exp.date, memo: `مصروف: ${exp.title || (cat ? cat.name : '')}`, refType: 'expense', refId: exp.id, lines: [{ accountId: (expAcc || bySys('misc')).id, debit: exp.amount, desc: exp.notes }, { accountId: exp.method === 'credit' ? bySys('ap').id : methodAccount(exp.method).id, credit: exp.amount, desc: exp.title }] });
    },
    postStockAdjust(move, value) {
      if (!value) return null;
      const gain = value > 0;
      return A.post({ date: move.date, memo: `تسوية مخزون: ${move.note || ''}`, refType: 'stock_adjust', refId: move.id, lines: gain ? [{ sys: 'inventory', debit: value }, { sys: 'inv_gain', credit: value }] : [{ sys: 'inv_loss', debit: -value }, { sys: 'inventory', credit: -value }] });
    },
    postOpeningStock(value) {
      if (!value) return null;
      return A.post({ date: u.now(), memo: 'رصيد مخزون افتتاحي', refType: 'opening', refId: 'stock', lines: [{ sys: 'inventory', debit: value }, { sys: 'opening', credit: value }] });
    },
    postOpeningAR(customer, amount) {
      return A.post({ date: u.now(), memo: `رصيد افتتاحي عميل ${customer.name}`, refType: 'opening', refId: customer.id, lines: [{ sys: 'ar', debit: amount }, { sys: 'opening', credit: amount }] });
    },
    postOpeningAP(supplier, amount) {
      return A.post({ date: u.now(), memo: `رصيد افتتاحي مورد ${supplier.name}`, refType: 'opening', refId: supplier.id, lines: [{ sys: 'opening', debit: amount }, { sys: 'ap', credit: amount }] });
    },
    postCashMove(cm) {
      // owner deposit / withdrawal / bank transfer
      const map = { deposit: [{ sys: 'cash', debit: cm.amount }, { sys: 'capital', credit: cm.amount }], withdraw: [{ sys: 'drawings', debit: cm.amount }, { sys: 'cash', credit: cm.amount }], to_bank: [{ sys: 'bank', debit: cm.amount }, { sys: 'cash', credit: cm.amount }], from_bank: [{ sys: 'cash', debit: cm.amount }, { sys: 'bank', credit: cm.amount }] };
      return A.post({ date: cm.date, memo: cm.notes || { deposit: 'إيداع رأس مال', withdraw: 'مسحوبات المالك', to_bank: 'تحويل للبنك', from_bank: 'سحب من البنك' }[cm.type], refType: 'cash_move', refId: cm.id, lines: map[cm.type] });
    },
    postPayroll(pr) {
      // absence reduces the salary expense itself; other deductions (penalties) are other income
      const absent = u.round(u.num(pr.absentDeduction)), other = u.round(Math.max(0, u.num(pr.deductions) - absent));
      const lines = [{ sys: 'salaries', debit: u.round(pr.gross - absent), desc: pr.employeeName }];
      if (pr.advancesDeducted > 0) lines.push({ sys: 'advances', credit: pr.advancesDeducted, desc: 'خصم سلف' });
      lines.push({ accountId: methodAccount(pr.method || 'cash').id, credit: pr.net, desc: 'صرف راتب' });
      if (other > 0) lines.push({ sys: 'other_income', credit: other, desc: 'خصومات' });
      return A.post({ date: pr.paidAt || u.now(), memo: `راتب ${pr.employeeName} — ${pr.month}`, refType: 'payroll', refId: pr.id, lines });
    },
    postAdvance(adv) {
      return A.post({ date: adv.date, memo: `سلفة ${adv.employeeName}`, refType: 'advance', refId: adv.id, lines: [{ sys: 'advances', debit: adv.amount }, { accountId: methodAccount(adv.method || 'cash').id, credit: adv.amount }] });
    },
  };
  ERP.accounting = A;
})();
