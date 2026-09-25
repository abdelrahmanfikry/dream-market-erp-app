/* ==========================================================================
   ERP.agg — incremental daily aggregates for fast totals (الإجماليات)
   - Maintains per-day buckets for the two heaviest collections: 'sales'
     and 'journal'. Covering {totals: mبيعات, أرباح, نقدية, مدنيون/دائنون,
     قيمة المخزون، الإيرادات والمصروفات} without scanning whole collections.
   - Buckets are updated incrementally on db:change: only the affected day
     is recomputed (O(that day)), so “الإجمالي” stays fast as data grows.
   - A collection revision counter (db.version) detects silent writes and
     full-structure changes (replace / import / reset) and rebuilds on demand.
   - Also caches open customer dues (الأرصدة المفتوحة) keyed by revision.
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  const u = ERP.utils;
  const r2 = n => u.round(n);
  const num = n => u.num(n);
  const dayOf = v => { const d = u.parseDate(v); return d ? u.toISODate(d) : null; };
  const isGift = p => !!(p && (p.isGift || p.method === 'gift'));
  // quantities are summed in BASE units (a carton ×24 line counts 24); unit lines carry baseQty/factor
  const bq = it => it.baseQty != null ? num(it.baseQty) : num(it.qty) * (num(it.factor) || 1);
  const baseName = it => { const p = it.productId && ERP.db.collection('products').get(it.productId); return p ? p.name : it.name; };
  const isInRange = (day, from, to) => (!from || day >= from) && (!to || day <= to);

  const TRACKED = { sales: true, journal: true };
  const ST = {};   // name -> state {built, ver, buckets:Map<day,bl>, dayIds:Map<day,Set<id>>, idDay:Map<id,day>, cust, custVer}

  const state = name => ST[name] || (ST[name] = { built: false, ver: -1, buckets: new Map(), dayIds: new Map(), idDay: new Map(), cust: null, custVer: -1 });

  function dbVer(name) { return ERP.db && ERP.db.version ? ERP.db.version(name) : 0; }

  /* ---------------- sales bucket ---------------- */
  function newSalesBucket() {
    return {
      count: 0, gross: 0, retCount: 0, retTot: 0, retCash: 0,
      items: 0, cogs: 0, retCogs: 0, tax: 0, retTax: 0, discount: 0, cash: 0, credit: 0, profit: 0,
      custSet: new Set(), methods: new Map(), products: new Map(), retItems: new Map(), customers: new Map(),
      hoursT: new Array(24).fill(0), hoursC: new Array(24).fill(0),
      wdayT: new Array(7).fill(0), wdayC: new Array(7).fill(0)
    };
  }
  function fillSalesAdd(bl, s) {
    const payments = s.payments || [];
    const items = s.items || [];
    if (s.type === 'return') {
      bl.retCount++; bl.retTot += num(s.total); bl.retCogs += num(s.cogs); bl.retTax += num(s.tax);
      payments.forEach(p => { if (!p.isCredit && !isGift(p)) bl.retCash += num(p.amount); });
      items.forEach(it => { const k = it.productId || it.name; const r = bl.retItems.get(k) || { qty: 0, total: 0, cost: 0, count: 0 }; r.qty += bq(it); r.total += num(it.total); r.cost += num(it.cost) * num(it.qty); r.count++; bl.retItems.set(k, r); });
      return;
    }
    bl.count++; bl.gross += num(s.total); bl.profit += num(s.profit);
    let qty = 0; items.forEach(it => (qty += bq(it))); bl.items += qty;
    bl.cogs += num(s.cogs); bl.tax += num(s.tax); bl.discount += num(s.discount); bl.credit += num(s.due);
    let cash = 0;
    payments.forEach(p => { if (!p.isCredit && !p.receiptId && !isGift(p)) cash += num(p.amount); }); // gift cards are prepaid liability, not cash
    cash -= num(s.change); bl.cash += cash;
    payments.forEach(p => {
      if (p.receiptId) return;
      const k = p.method || 'cash';
      const m = bl.methods.get(k) || { total: 0, count: 0 };
      m.total += num(p.amount) - (k === 'cash' ? num(s.change) : 0); m.count++;
      bl.methods.set(k, m);
    });
    if (s.customerId) {
      bl.custSet.add(s.customerId);
      const c = bl.customers.get(s.customerId) || { customerId: s.customerId, name: s.customerName || '', total: 0, count: 0, profit: 0 };
      c.total += num(s.total); c.count++; c.profit += num(s.profit);
      bl.customers.set(s.customerId, c);
    }
    items.forEach(it => {
      const k = it.productId || it.name;
      const p = bl.products.get(k) || { productId: it.productId, name: baseName(it), qty: 0, total: 0, cost: 0, count: 0 };
      p.qty += bq(it); p.total += num(it.total); p.cost += num(it.cost) * num(it.qty); p.count++;
      bl.products.set(k, p);
    });
    const dt = u.parseDate(s.date);
    if (dt) { const h = dt.getHours(); bl.hoursT[h] += num(s.total); bl.hoursC[h]++; const w = dt.getDay(); bl.wdayT[w] += num(s.total); bl.wdayC[w]++; }
  }
  /* ---------------- journal bucket (Map<accountId,{dr,cr}>) ---------------- */
  function fillJournalAdd(bm, j) {
    (j.lines || []).forEach(l => { if (!l || l.accountId == null) return; const a = bm.get(l.accountId) || { dr: 0, cr: 0 }; a.dr += num(l.debit); a.cr += num(l.credit); bm.set(l.accountId, a); });
  }

  /* ---------------- build / incremental ---------------- */
  function build(name) {
    const st = state(name);
    st.buckets = new Map(); st.dayIds = new Map(); st.idDay = new Map();
    const col = ERP.db.collection(name);
    for (const d of col.all()) {
      if (name === 'sales' && d.status === 'void') continue;
      const day = dayOf(d.date);
      if (!day || !d.id) continue;
      let bl = st.buckets.get(day);
      if (!bl) { bl = name === 'sales' ? newSalesBucket() : new Map(); st.buckets.set(day, bl); }
      (st.dayIds.get(day) || st.dayIds.set(day, new Set()).get(day)).add(d.id);
      st.idDay.set(d.id, day);
      if (name === 'sales') fillSalesAdd(bl, d); else fillJournalAdd(bl, d);
    }
    st.built = true; st.ver = dbVer(name);
    if (name === 'sales') st.custVer = -1;
    return st;
  }
  /** recompute only one day's bucket from the day's ids (O(day size)) */
  function refreshDay(name, day) {
    const st = state(name);
    const col = ERP.db.collection(name);
    const ids = st.dayIds.get(day) || new Set();
    const bl = name === 'sales' ? newSalesBucket() : new Map();
    for (const id of ids) {
      const d = col.get(id); if (!d) continue;
      if (name === 'sales') { if (d.status === 'void') continue; fillSalesAdd(bl, d); }
      else fillJournalAdd(bl, d);
    }
    st.buckets.set(day, bl);
  }
  function addDoc(name, doc) {
    const st = state(name); const day = dayOf(doc.date);
    if (!doc || !doc.id || !day) return;
    st.idDay.set(doc.id, day);
    (st.dayIds.get(day) || st.dayIds.set(day, new Set()).get(day)).add(doc.id);
    refreshDay(name, day);
    if (name === 'sales') st.custVer = -1;
  }
  function updateDoc(name, doc) {
    const st = state(name); if (!doc || !doc.id) return;
    const oldDay = st.idDay.get(doc.id);
    const newDay = dayOf(doc.date);
    if (oldDay && oldDay !== newDay) {
      const ds = st.dayIds.get(oldDay); if (ds) { ds.delete(doc.id); if (!ds.size) st.dayIds.delete(oldDay); }
    }
    if (newDay) {
      st.idDay.set(doc.id, newDay);
      (st.dayIds.get(newDay) || st.dayIds.set(newDay, new Set()).get(newDay)).add(doc.id);
    }
    if (oldDay) refreshDay(name, oldDay);
    if (newDay && newDay !== oldDay) refreshDay(name, newDay);
    if (name === 'sales') st.custVer = -1;
  }
  function removeDoc(name, doc) {
    const st = state(name); if (!doc || !doc.id) return;
    const oldDay = st.idDay.get(doc.id);
    if (oldDay) {
      const ds = st.dayIds.get(oldDay); if (ds) { ds.delete(doc.id); if (!ds.size) st.dayIds.delete(oldDay); }
      st.idDay.delete(doc.id);
      refreshDay(name, oldDay);
    }
    if (name === 'sales') st.custVer = -1;
  }
  function onChange(evt) {
    const name = evt && evt.collection;
    if (!name || !TRACKED[name]) return;
    const st = state(name);
    if (!st.built) { st.ver = dbVer(name); return; }
    // every mutation bumps the revision by exactly 1 — any other gap means silent writes happened in between
    // (e.g. receipts allocating to invoices then emitting an empty bulk event) → rebuild instead of stamping
    const gap = dbVer(name) - st.ver;
    if (evt.op === 'bulk' && !(evt.docs || []).length) { if (gap) build(name); return; }
    if (gap !== 1) { build(name); return; }
    if (evt.op === 'insert') { if (evt.doc) addDoc(name, evt.doc); }
    else if (evt.op === 'update') { if (evt.doc) updateDoc(name, evt.doc); }
    else if (evt.op === 'remove') { if (evt.doc) removeDoc(name, evt.doc); }
    else if (evt.op === 'bulk') { (evt.docs || []).forEach(d => addDoc(name, d)); }
    else { build(name); return; }
    st.ver = dbVer(name);
  }

  function ensure(name) {
    const st = state(name);
    if (st.built && st.ver === dbVer(name)) return st;
    return build(name);
  }

  /* ---------------- queries ---------------- */
  function saleDays(from, to) {
    const st = ensure('sales');
    const out = [];
    for (const [day, bl] of st.buckets) if (isInRange(day, from, to)) out.push({ day, b: bl });
    return out;
  }
  /** object accountId -> (dr - cr) over the range, from journal day buckets */
  function journalRaw(from, to) {
    const st = ensure('journal');
    const raw = {};
    for (const [day, bm] of st.buckets) {
      if (!isInRange(day, from, to)) continue;
      for (const [accId, v] of bm) raw[accId] = (raw[accId] || 0) + v.dr - v.cr;
    }
    return raw;
  }
  /** Map<customerId,{due,count,oldest}> for open (unpaid, non-void) sale invoices */
  function openDues() {
    const st = ensure('sales');
    const v = dbVer('sales');
    if (st.cust && st.custVer === v) return st.cust;
    const map = new Map();
    for (const s of ERP.db.collection('sales').all()) {
      if (s.type !== 'sale' || s.status === 'void' || s.customerId == null) continue;
      const due = num(s.due);
      if (due <= 0.009) continue;
      let r = map.get(s.customerId);
      if (!r) { r = { due: 0, count: 0, oldest: null }; map.set(s.customerId, r); }
      r.due += due; r.count++;
      const iso = dayOf(s.date);
      if (iso && (!r.oldest || iso < r.oldest)) r.oldest = iso;
    }
    st.cust = map; st.custVer = v;
    return map;
  }

  /* ---------------- lifecycle ---------------- */
  function onImported(e) { (e.cols || []).forEach(n => { if (TRACKED[n]) build(n); }); }
  function onReset() { Object.keys(ST).forEach(k => { ST[k] = { built: false, ver: -1, buckets: new Map(), dayIds: new Map(), idDay: new Map(), cust: null, custVer: -1 }; }); }

  if (ERP.bus) {
    ERP.bus.on('db:change', onChange);
    ERP.bus.on('db:imported', onImported);
    ERP.bus.on('db:reset', onReset);
  }

  ERP.agg = { state, ensure, saleDays, journalRaw, openDues, dayOf };
})();