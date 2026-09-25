/* ==========================================================================
   ERP.reports — analytics aggregations for dashboards & report views
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  const u = ERP.utils;

  const R = {
    period(kind) {
      const today = u.todayISO();
      if (kind === 'today') return { from: today, to: today, label: 'اليوم' };
      if (kind === 'yesterday') { const y = u.toISODate(u.addDays(new Date(), -1)); return { from: y, to: y, label: 'أمس' }; }
      if (kind === 'week') return { from: u.toISODate(u.addDays(new Date(), -6)), to: today, label: 'آخر 7 أيام' };
      if (kind === 'month') return { from: u.toISODate(u.startOfMonth()), to: today, label: 'هذا الشهر' };
      if (kind === 'lastMonth') { const d = new Date(); d.setMonth(d.getMonth() - 1); return { from: u.toISODate(u.startOfMonth(d)), to: u.toISODate(u.endOfMonth(d)), label: 'الشهر الماضي' }; }
      if (kind === 'quarter') { const d = new Date(); const q = Math.floor(d.getMonth() / 3) * 3; return { from: u.toISODate(new Date(d.getFullYear(), q, 1)), to: today, label: 'هذا الربع' }; }
      if (kind === 'year') return { from: `${new Date().getFullYear()}-01-01`, to: today, label: 'هذه السنة' };
      if (kind === '30d') return { from: u.toISODate(u.addDays(new Date(), -29)), to: today, label: 'آخر 30 يوم' };
      return { from: null, to: null, label: 'كل الفترات' };
    },

    salesSummary(from, to) {
      const days = ERP.agg.saleDays(from, to);
      let count = 0, gross = 0, returns = 0, returnsCount = 0, cogs = 0, retCogs = 0, tax = 0, retTax = 0;
      let discount = 0, cash = 0, credit = 0, items = 0;
      const custSet = new Set();
      for (const { b } of days) {
        count += b.count; gross += b.gross; returns += b.retTot; returnsCount += b.retCount;
        cogs += b.cogs; retCogs += b.retCogs; tax += b.tax; retTax += b.retTax;
        discount += b.discount; cash += b.cash; credit += b.credit; items += b.items;
        b.custSet.forEach(c => custSet.add(c));
      }
      cogs -= retCogs; tax -= retTax;
      const net = gross - returns;
      return { count, gross, returns, returnsCount, net, tax, cogs, grossProfit: net - tax - cogs, margin: net ? ((net - tax - cogs) / net) * 100 : 0, avg: count ? gross / count : 0, discounts: discount, items, cash, credit, customers: custSet.size };
    },
    compare(kind) {
      const cur = R.period(kind);
      let prev;
      if (kind === 'today') prev = R.period('yesterday');
      else if (kind === 'month') prev = R.period('lastMonth');
      else { const len = u.daysBetween(cur.from, cur.to) + 1; prev = { from: u.toISODate(u.addDays(cur.from, -len)), to: u.toISODate(u.addDays(cur.from, -1)) }; }
      const a = R.salesSummary(cur.from, cur.to), b = R.salesSummary(prev.from, prev.to);
      const delta = (x, y) => y ? ((x - y) / y) * 100 : (x ? 100 : 0);
      return { cur: a, prev: b, deltaNet: delta(a.net, b.net), deltaCount: delta(a.count, b.count), deltaProfit: delta(a.grossProfit, b.grossProfit), deltaAvg: delta(a.avg, b.avg) };
    },
    salesByDay(from, to) {
      const days = []; let d = u.parseDate(from);
      const end = u.parseDate(to);
      while (d <= end) { days.push(u.toISODate(d)); d = u.addDays(d, 1); }
      const bm = ERP.agg.ensure('sales').buckets;
      return days.map(k => { const b = bm.get(k); return { date: k, total: b ? b.gross : 0, count: b ? b.count : 0, profit: b ? b.profit : 0, returns: b ? b.retTot : 0 }; });
    },
    salesByMonth(months = 12) {
      const out = []; const now = new Date();
      for (let i = months - 1; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); out.push({ key: u.monthKey(d), label: u.AR_MONTHS[d.getMonth()] + (d.getFullYear() !== now.getFullYear() ? ' ' + String(d.getFullYear()).slice(2) : ''), total: 0, count: 0, profit: 0, returns: 0, expenses: 0 }); }
      const idx = u.keyBy(out, 'key');
      for (const [day, b] of ERP.agg.ensure('sales').buckets) { const k = u.monthKey(day); if (!idx[k]) continue; idx[k].returns += b.retTot; idx[k].total += b.gross; idx[k].count += b.count; idx[k].profit += b.profit; }
      ERP.db.collection('expenses').all().forEach(e => { const k = u.monthKey(e.date); if (idx[k]) idx[k].expenses += u.num(e.amount); });
      return out;
    },
    salesByHour(from, to) {
      const h = u.range(24).map(i => ({ hour: i, total: 0, count: 0 }));
      ERP.agg.saleDays(from, to).forEach(({ b }) => { for (let i = 0; i < 24; i++) { h[i].total += b.hoursT[i]; h[i].count += b.hoursC[i]; } });
      return h;
    },
    salesByWeekday(from, to) {
      const w = u.range(7).map(i => ({ day: u.AR_DAYS[i], total: 0, count: 0 }));
      ERP.agg.saleDays(from, to).forEach(({ b }) => { for (let i = 0; i < 7; i++) { w[i].total += b.wdayT[i]; w[i].count += b.wdayC[i]; } });
      return w;
    },
    topProducts(from, to, n = 10, by = 'total') {
      const m = {};
      for (const { b } of ERP.agg.saleDays(from, to)) {
        b.products.forEach((p, k) => { const o = m[k] || (m[k] = { productId: p.productId, name: p.name, qty: 0, total: 0, cost: 0, count: 0 }); o.qty += p.qty; o.total += p.total; o.cost += p.cost; o.count += p.count; });
        b.retItems.forEach((r, k) => { const o = m[k]; if (o) { o.qty -= r.qty; o.total -= r.total; o.cost -= r.cost; } });
      }
      return u.sortBy(Object.values(m).map(x => ({ ...x, profit: x.total - x.cost, margin: x.total ? ((x.total - x.cost) / x.total) * 100 : 0 })), by, 'desc').slice(0, n);
    },
    salesByCategory(from, to) {
      const cats = ERP.db.collection('categories').map(), prods = ERP.db.collection('products').map();
      const m = {};
      for (const { b } of ERP.agg.saleDays(from, to)) {
        b.products.forEach(p => {
          const pr = prods[p.productId]; const c = pr ? cats[pr.categoryId] : null;
          const k = c ? c.id : 'other';
          const o = m[k] || (m[k] = { id: k, name: c ? c.name : 'غير مصنف', color: c ? c.color : '#94a3b8', total: 0, qty: 0, profit: 0 });
          o.total += p.total; o.qty += p.qty; o.profit += p.total - p.cost;
        });
      }
      return u.sortBy(Object.values(m), 'total', 'desc');
    },
    topCustomers(from, to, n = 10) {
      const m = {};
      for (const { b } of ERP.agg.saleDays(from, to)) {
        b.customers.forEach((c, cid) => { const o = m[cid] || (m[cid] = { customerId: cid, name: c.name, total: 0, count: 0, profit: 0 }); o.total += c.total; o.count += c.count; o.profit += c.profit; });
      }
      return u.sortBy(Object.values(m), 'total', 'desc').slice(0, n);
    },
    paymentMix(from, to) {
      const m = {};
      for (const { b } of ERP.agg.saleDays(from, to)) b.methods.forEach((v, method) => { m[method] = (m[method] || 0) + v.total; });
      return Object.entries(m).map(([method, total]) => ({ method, name: ERP.sales.methodName(method), total })).sort((a, b) => b.total - a.total);
    },
    expensesSummary(from, to) {
      const list = ERP.db.collection('expenses').all().filter(e => u.inRange(e.date, from, to));
      const by = u.groupBy(list, 'categoryName');
      return { total: u.sum(list, 'amount'), count: list.length, byCategory: u.sortBy(Object.entries(by).map(([name, items]) => ({ name, total: u.sum(items, 'amount'), count: items.length })), 'total', 'desc'), list };
    },
    purchasesSummary(from, to) {
      const pos = ERP.purchasing.orders().filter(p => p.type !== 'return' && p.status !== 'cancelled' && u.inRange(p.receivedAt || p.date, from, to));
      const bySup = u.groupBy(pos, 'supplierName');
      return { total: u.sum(pos, 'total'), count: pos.length, paid: u.sum(pos, 'paid'), due: u.sum(pos, 'due'), bySupplier: u.sortBy(Object.entries(bySup).map(([name, items]) => ({ name, total: u.sum(items, 'total'), count: items.length })), 'total', 'desc') };
    },
    profitLoss(from, to) {
      const s = R.salesSummary(from, to), e = R.expensesSummary(from, to);
      const payroll = u.sum(ERP.db.collection('payroll').all().filter(p => u.inRange(p.paidAt, from, to)), 'gross');
      const netProfit = s.grossProfit - e.total - payroll;
      return { sales: s, expenses: e, payroll, netProfit, netMargin: s.net ? (netProfit / s.net) * 100 : 0 };
    },
    taxReport(from, to) {
      const out = u.sum(ERP.sales.range(from, to), 'tax') - u.sum(ERP.sales.range(from, to, { type: 'return' }), 'tax');
      const inp = u.sum(ERP.purchasing.orders().filter(p => p.status === 'received' && u.inRange(p.receivedAt, from, to)), 'tax');
      return { output: out, input: inp, net: out - inp, salesBase: R.salesSummary(from, to).net };
    },
    inventoryReport() {
      const val = ERP.inventory.valuation();
      const vel = u.keyBy(ERP.inventory.velocity(30), r => r.product.id);
      const cats = ERP.db.collection('categories').map();
      const rows = val.rows.map(r => ({ ...r, category: cats[r.product.categoryId]?.name || '', sold30: vel[r.product.id]?.sold || 0, daysOfCover: vel[r.product.id]?.daysOfCover, dead: vel[r.product.id]?.dead }));
      const byCat = {};
      rows.forEach(r => { byCat[r.category] = byCat[r.category] || { name: r.category || 'غير مصنف', value: 0, qty: 0, count: 0 }; byCat[r.category].value += r.value; byCat[r.category].qty += r.qty; byCat[r.category].count++; });
      return { ...val, rows, byCategory: u.sortBy(Object.values(byCat), 'value', 'desc'), dead: rows.filter(r => r.dead), low: ERP.inventory.lowStock().length, out: ERP.inventory.outOfStock().length };
    },
    debtorsAging() {
      const buckets = [{ label: '0-30 يوم', min: 0, max: 30, total: 0, count: 0 }, { label: '31-60 يوم', min: 31, max: 60, total: 0, count: 0 }, { label: '61-90 يوم', min: 61, max: 90, total: 0, count: 0 }, { label: '+90 يوم', min: 91, max: 1e9, total: 0, count: 0 }];
      const rows = [];
      const dues = ERP.agg.openDues();
      ERP.crm.debtors().forEach(c => {
        const d = dues.get(c.id);
        const open = d ? d.count : 0;
        const oldest = d && d.oldest ? d.oldest : c.updatedAt;
        const days = u.daysBetween(oldest, new Date());
        const b = buckets.find(x => days >= x.min && days <= x.max) || buckets[3];
        b.total += c.balance; b.count++;
        rows.push({ customer: c, days, balance: c.balance, invoices: open, bucket: b.label });
      });
      return { buckets, rows: u.sortBy(rows, 'days', 'desc'), total: u.sum(rows, 'balance') };
    },
    cashFlow(from, to) {
      const inflow = { sales: 0, receipts: 0, other: 0 }, outflow = { purchases: 0, expenses: 0, payroll: 0, other: 0 };
      ERP.agg.saleDays(from, to).forEach(({ b }) => { inflow.sales += b.cash; outflow.other += b.retCash; });
      ERP.db.collection('payments').all().filter(p => u.inRange(p.date, from, to)).forEach(p => { if (p.type === 'receipt') inflow.receipts += p.amount; else outflow.purchases += p.amount; });
      ERP.db.collection('expenses').all().filter(e => u.inRange(e.date, from, to) && e.method !== 'credit').forEach(e => { outflow.expenses += e.amount; });
      ERP.db.collection('payroll').all().filter(p => u.inRange(p.paidAt, from, to)).forEach(p => { outflow.payroll += p.net; });
      ERP.db.collection('advances').all().filter(a => u.inRange(a.date, from, to)).forEach(a => { outflow.other += a.amount; });
      ERP.db.collection('cashMoves').all().filter(c => u.inRange(c.date, from, to)).forEach(c => { if (['deposit', 'in'].includes(c.type)) inflow.other += c.amount; else if (['withdraw', 'out'].includes(c.type)) outflow.other += c.amount; });
      const tin = u.sum(Object.values(inflow)), tout = u.sum(Object.values(outflow));
      return { inflow, outflow, totalIn: tin, totalOut: tout, net: tin - tout };
    },
    recentActivity(n = 12) {
      const items = [];
      ERP.db.collection('sales').latest(n, 'date').forEach(s => items.push({ at: s.date, icon: s.type === 'return' ? 'rotate-left' : 'receipt', kind: s.type === 'return' ? 'warning' : 'success', title: `${s.type === 'return' ? 'مرتجع' : 'فاتورة'} ${s.no}`, sub: `${s.customerName} — ${u.fmtMoney(s.total)}`, action: () => ERP.views.sales && ERP.views.sales.viewInvoice(s.id) }));
      ERP.db.collection('payments').latest(n, 'date').forEach(p => items.push({ at: p.date, icon: p.type === 'receipt' ? 'hand-holding-dollar' : 'money-bill-transfer', kind: p.type === 'receipt' ? 'success' : 'danger', title: p.type === 'receipt' ? `تحصيل ${p.no}` : `سداد ${p.no}`, sub: `${p.partyName} — ${u.fmtMoney(p.amount)}` }));
      ERP.db.collection('purchases').latest(n, 'date').forEach(p => items.push({ at: p.receivedAt || p.date, icon: 'truck', kind: 'info', title: `شراء ${p.no}`, sub: `${p.supplierName} — ${u.fmtMoney(p.total)}` }));
      ERP.db.collection('expenses').latest(n, 'date').forEach(e => items.push({ at: e.date, icon: 'wallet', kind: 'danger', title: `مصروف ${e.title || e.categoryName}`, sub: u.fmtMoney(e.amount) }));
      return u.sortBy(items, 'at', 'desc').slice(0, n);
    },
  };
  ERP.reports = R;
})();
