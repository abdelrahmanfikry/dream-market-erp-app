/* ==========================================================================
   ERP.analytics + View «تحليلات متقدمة» — ABC, profitability by category/supplier,
   slow-moving / dead stock, shrinkage & waste, weekday × hour heatmap.
   Sales figures come from the daily aggregate buckets (ERP.agg, base quantities, net of returns);
   results are cached per (range, collection revision) so re-renders never rescan.
   Revenue = invoice line totals (after line/promo discounts, before invoice-level discount).
   ========================================================================== */
window.ERP = window.ERP || {}; ERP.views = ERP.views || {};
(function () {
  const u = ERP.utils; const e = u.escapeHtml;
  const cache = new Map();
  const memo = (key, fn) => { if (cache.has(key)) return cache.get(key); if (cache.size > 40) cache.clear(); const v = fn(); cache.set(key, v); return v; };
  const ver = (...cols) => cols.map(c => ERP.db.version(c)).join('.');
  const day = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : u.toISODate(v));
  const dayDiff = (a, b) => Math.round((Date.parse(day(b)) - Date.parse(day(a))) / 864e5);

  const AN = {
    /** per-product totals net of returns → [{ productId, name, qty(base), total, cost, profit, count }] */
    productTotals(from, to) {
      return memo(`pt:${from}:${to}:${ver('sales')}`, () => {
        const m = new Map();
        for (const { b } of ERP.agg.saleDays(from, to)) {
          b.products.forEach((p, k) => { const o = m.get(k) || { productId: p.productId, name: p.name, qty: 0, total: 0, cost: 0, count: 0 }; o.qty += p.qty; o.total += p.total; o.cost += p.cost; o.count += p.count; m.set(k, o); });
          b.retItems.forEach((r, k) => { const o = m.get(k) || { productId: typeof k === 'string' && ERP.db.collection('products').get(k) ? k : null, name: String(k), qty: 0, total: 0, cost: 0, count: 0 }; o.qty -= r.qty; o.total -= r.total; o.cost -= r.cost; m.set(k, o); });
        }
        return [...m.values()].map(o => ({ ...o, qty: u.round(o.qty, 3), total: u.round(o.total), cost: u.round(o.cost), profit: u.round(o.total - o.cost) }));
      });
    },
    /** A = items making the first 80% of the metric, B = next 15%, C = the rest (and anything ≤ 0).
     *  An item is A while the cumulative share BEFORE it is < 80% (so the item crossing 80% is still A). */
    abcClassify(rows, key = 'total', { a = 80, b = 95 } = {}) {
      const pos = u.sortBy(rows.filter(r => u.num(r[key]) > 0), key, 'desc');
      const total = u.sum(pos, key); let cum = 0;
      const out = pos.map(r => { const before = total ? (cum / total) * 100 : 100; cum += u.num(r[key]); const share = total ? (u.num(r[key]) / total) * 100 : 0; return { ...r, share, cumShare: total ? (cum / total) * 100 : 0, cls: before < a ? 'A' : before < b ? 'B' : 'C' }; });
      rows.filter(r => !(u.num(r[key]) > 0)).forEach(r => out.push({ ...r, share: 0, cumShare: 100, cls: 'C' }));
      const sum = { A: { count: 0, value: 0 }, B: { count: 0, value: 0 }, C: { count: 0, value: 0 } };
      out.forEach(r => { sum[r.cls].count++; sum[r.cls].value += Math.max(0, u.num(r[key])); });
      return { rows: out, summary: sum, total };
    },
    abc({ from = null, to = null, by = 'total' } = {}) { return AN.abcClassify(AN.productTotals(from, to), by === 'profit' ? 'profit' : 'total'); },
    /** by = 'category' | 'supplier' → [{ id, name, revenue, cogs, profit, margin, qty, products }] */
    profitability({ from = null, to = null, by = 'category', rows = null } = {}) {
      const prods = ERP.db.collection('products').map();
      const names = by === 'supplier' ? ERP.db.collection('suppliers').map() : ERP.db.collection('categories').map();
      const m = {};
      (rows || AN.productTotals(from, to)).forEach(r => {
        const p = prods[r.productId]; const id = (p && (by === 'supplier' ? p.supplierId : p.categoryId)) || 'none';
        const o = m[id] || (m[id] = { id, name: names[id] ? names[id].name : (by === 'supplier' ? 'بدون مورد' : 'غير مصنف'), color: names[id] && names[id].color, revenue: 0, cogs: 0, qty: 0, products: 0 });
        o.revenue += r.total; o.cogs += r.cost; o.qty += r.qty; o.products++;
      });
      return u.sortBy(Object.values(m).map(o => ({ ...o, revenue: u.round(o.revenue), cogs: u.round(o.cogs), qty: u.round(o.qty, 3), profit: u.round(o.revenue - o.cogs), margin: o.revenue ? u.round(((o.revenue - o.cogs) / o.revenue) * 100, 1) : 0 })), 'profit', 'desc');
    },
    /** productId → last sale day (one pass over the day buckets, cached per sales revision) */
    lastSold() {
      return memo(`ls:${ver('sales')}`, () => { const last = {}; for (const { day: d, b } of ERP.agg.saleDays(null, null)) b.products.forEach(p => { if (p.productId && (!last[p.productId] || d > last[p.productId])) last[p.productId] = d; }); return last; });
    },
    /** stocked items with no sale in `days` days → [{ product, qty, value, lastSale, daysSince, sold30, perDay, daysOfCover }] */
    slowMoving({ days = 30, today = null, products = null } = {}) {
      today = day(today || u.now()); const last = AN.lastSold(); const cut = new Date(Date.parse(today) - days * 864e5).toISOString().slice(0, 10);
      const from30 = new Date(Date.parse(today) - 29 * 864e5).toISOString().slice(0, 10);
      const sold30 = memo(`s30:${from30}:${today}:${ver('sales')}`, () => { const s = {}; ERP.agg.saleDays(from30, today).forEach(({ b }) => b.products.forEach(p => { if (p.productId) s[p.productId] = (s[p.productId] || 0) + p.qty; })); return s; });
      return u.sortBy((products || ERP.db.collection('products').all()).filter(p => p.active !== false && u.num(p.stock) > 0 && !(last[p.id] && last[p.id] > cut)).map(p => {
        const q = u.num(p.stock), perDay = (sold30[p.id] || 0) / 30;
        return { product: p, qty: q, value: u.round(q * u.num(p.cost)), lastSale: last[p.id] || null, daysSince: last[p.id] ? dayDiff(last[p.id], today) : null, sold30: u.round(sold30[p.id] || 0, 3), perDay, daysOfCover: perDay > 0 ? Math.round(q / perDay) : null };
      }), 'value', 'desc');
    },
    /** waste, negative adjustments and stocktake shortages in the range (value at cost) */
    shrinkage({ from = null, to = null } = {}) {
      return memo(`sh:${from}:${to}:${ver('stockMoves', 'products')}`, () => {
        const prods = ERP.db.collection('products').map(), cats = ERP.db.collection('categories').map();
        const byP = {}, byC = {}, byT = { waste: 0, adjust: 0, stocktake: 0 }; let gains = 0;
        ERP.db.collection('stockMoves').all().forEach(m => {
          if (!(m.type === 'waste' || m.type === 'adjust') || !u.inRange(m.date, from, to)) return;
          if (u.num(m.qty) > 0) { if (m.type === 'adjust') gains += u.num(m.value); return; }
          const kind = m.type === 'waste' ? 'waste' : m.refType === 'stocktake' ? 'stocktake' : 'adjust';
          const val = -u.num(m.value), qty = -u.num(m.qty);
          const p = prods[m.productId]; const c = p ? cats[p.categoryId] : null;
          const o = byP[m.productId] || (byP[m.productId] = { productId: m.productId, name: p ? p.name : m.productName, category: c ? c.name : 'غير مصنف', qty: 0, value: 0, waste: 0, adjust: 0, stocktake: 0, count: 0, lastAt: null });
          o.qty += qty; o.value += val; o[kind] += val; o.count++; if (!o.lastAt || m.date > o.lastAt) o.lastAt = m.date;
          const ck = c ? c.id : 'none'; const oc = byC[ck] || (byC[ck] = { id: ck, name: c ? c.name : 'غير مصنف', color: c && c.color, value: 0, qty: 0, waste: 0, adjust: 0, stocktake: 0 });
          oc.value += val; oc.qty += qty; oc[kind] += val; byT[kind] += val;
        });
        const r2 = o => ({ ...o, value: u.round(o.value), qty: u.round(o.qty, 3), waste: u.round(o.waste), adjust: u.round(o.adjust), stocktake: u.round(o.stocktake) });
        return { rows: u.sortBy(Object.values(byP).map(r2), 'value', 'desc'), byCategory: u.sortBy(Object.values(byC).map(r2), 'value', 'desc'), byType: { waste: u.round(byT.waste), adjust: u.round(byT.adjust), stocktake: u.round(byT.stocktake) }, total: u.round(byT.waste + byT.adjust + byT.stocktake), gains: u.round(gains) };
      });
    },
    /** 7 × 24 matrix of sales totals (weekday of the bucket day × hour) */
    heatmap(from = null, to = null) {
      return memo(`hm:${from}:${to}:${ver('sales')}`, () => {
        const T = u.range(7).map(() => new Array(24).fill(0)), N = u.range(7).map(() => new Array(24).fill(0));
        ERP.agg.saleDays(from, to).forEach(({ day: d, b }) => { const w = new Date(d + 'T12:00:00').getDay(); for (let h = 0; h < 24; h++) { T[w][h] += b.hoursT[h]; N[w][h] += b.hoursC[h]; } });
        const max = Math.max(0, ...T.flat());
        return { total: T, count: N, max };
      });
    },
  };
  ERP.analytics = AN;

  /* ============================== view ============================== */
  let el, period = 'month', from = '', to = '', tab = 'abc', abcBy = 'total', profBy = 'category', slowDays = 60;
  const tables = {}; let current = { title: '', columns: [], rows: [] };
  const range = () => (period === 'custom' ? { from: from || null, to: to || null, label: `${from || '…'} → ${to || '…'}` } : ERP.reports.period(period));
  const CLS = { A: 'success', B: 'warning', C: 'neutral' };
  const pct = n => `${u.fmtNum(n, 1)}%`;
  const card = (icon, kind, label, val) => `<div class="card kpi"><div class="kpi-icon ${kind}"><i class="fas fa-${icon}"></i></div><div class="kpi-body"><div class="kpi-label">${label}</div><div class="kpi-value" style="font-size:1.15rem">${val}</div></div></div>`;
  function mkTable(id, opts) { tables[id] = ERP.ui.table({ el: `#an-t-${id}`, rows: [], exportPerm: 'reports.view', pageSize: 50, ...opts }); return tables[id]; }

  function renderAbc() {
    const R = range(); const res = AN.abc({ from: R.from, to: R.to, by: abcBy }); const key = abcBy === 'profit' ? 'profit' : 'total';
    const S = res.summary, tot = res.total || 0;
    el.querySelector('#an-abc-kpis').innerHTML = ['A', 'B', 'C'].map(c => card(c === 'A' ? 'star' : c === 'B' ? 'circle-half-stroke' : 'circle', CLS[c], `فئة ${c} — ${S[c].count} صنف`, `${u.fmtMoney(S[c].value)} <span class="text-xs muted">(${pct(tot ? S[c].value / tot * 100 : 0)})</span>`)).join('');
    ERP.charts.doughnut('#an-abc-chart', { labels: ['A', 'B', 'C'].map(c => `فئة ${c} (${S[c].count} صنف)`), data: ['A', 'B', 'C'].map(c => u.round(S[c].value)), colors: ['#16a34a', '#f59e0b', '#94a3b8'] });
    tables.abc.setRows(res.rows);
    current = { title: `تحليل ABC حسب ${abcBy === 'profit' ? 'الربح' : 'الإيراد'}`, columns: [{ label: 'الفئة' }, { label: 'الصنف' }, { label: 'الكمية', num: true }, { label: 'الإيراد', num: true }, { label: 'الربح', num: true }, { label: 'النسبة', num: true }, { label: 'التراكمي', num: true }], rows: res.rows.map(r => [r.cls, r.name, u.fmtQty(r.qty), u.fmtNum(r.total), u.fmtNum(r.profit), pct(r.share), pct(r.cumShare)]) };
    return key;
  }
  function renderProf() {
    const R = range(); const rows = AN.profitability({ from: R.from, to: R.to, by: profBy });
    const tr = u.sum(rows, 'revenue'), tp = u.sum(rows, 'profit');
    el.querySelector('#an-prof-kpis').innerHTML = card('sack-dollar', 'primary', 'الإيراد', u.fmtMoney(tr)) + card('box', 'danger', 'التكلفة', u.fmtMoney(u.sum(rows, 'cogs'))) + card('chart-line', 'success', 'مجمل الربح', u.fmtMoney(tp)) + card('percent', 'info', 'الهامش', pct(tr ? tp / tr * 100 : 0));
    const top = rows.slice(0, 12);
    ERP.charts.bar('#an-prof-chart', { labels: top.map(r => r.name), series: [{ label: 'الإيراد', data: top.map(r => r.revenue) }, { label: 'مجمل الربح', data: top.map(r => r.profit), color: '#16a34a' }] });
    tables.prof.setRows(rows);
    current = { title: `الربحية حسب ${profBy === 'supplier' ? 'المورد' : 'الفئة'}`, columns: [{ label: profBy === 'supplier' ? 'المورد' : 'الفئة' }, { label: 'الأصناف', num: true }, { label: 'الكمية', num: true }, { label: 'الإيراد', num: true }, { label: 'التكلفة', num: true }, { label: 'مجمل الربح', num: true }, { label: 'الهامش', num: true }], rows: rows.map(r => [r.name, r.products, u.fmtQty(r.qty), u.fmtNum(r.revenue), u.fmtNum(r.cogs), u.fmtNum(r.profit), pct(r.margin)]) };
  }
  function renderSlow() {
    const rows = AN.slowMoving({ days: slowDays }); const never = rows.filter(r => !r.lastSale).length;
    el.querySelector('#an-slow-kpis').innerHTML = card('hourglass-half', 'warning', `أصناف بلا مبيعات منذ ${slowDays} يوم`, u.fmtInt(rows.length)) + card('ban', 'danger', 'لم تُبع أبداً', u.fmtInt(never)) + card('sack-dollar', 'danger', 'رأس مال مجمّد (بالتكلفة)', u.fmtMoney(u.sum(rows, 'value'))) + card('tags', 'info', 'بسعر البيع', u.fmtMoney(u.sum(rows, r => r.qty * u.num(r.product.price))));
    tables.slow.setRows(rows);
    current = { title: `أصناف راكدة — بلا مبيعات منذ ${slowDays} يوم`, columns: [{ label: 'الصنف' }, { label: 'المخزون', num: true }, { label: 'القيمة', num: true }, { label: 'آخر بيع' }, { label: 'منذ (يوم)', num: true }, { label: 'مبيع 30 يوم', num: true }, { label: 'أيام التغطية', num: true }], rows: rows.map(r => [r.product.name, u.fmtQty(r.qty), u.fmtNum(r.value), r.lastSale ? u.fmtDate(r.lastSale) : 'لم يُبع', r.daysSince ?? '—', u.fmtQty(r.sold30), r.daysOfCover ?? '∞']) };
  }
  function renderShrink() {
    const R = range(); const s = AN.shrinkage({ from: R.from, to: R.to });
    el.querySelector('#an-shr-kpis').innerHTML = card('trash', 'danger', 'هالك', u.fmtMoney(s.byType.waste)) + card('clipboard-check', 'warning', 'عجز جرد', u.fmtMoney(s.byType.stocktake)) + card('sliders', 'info', 'تسويات بالنقص', u.fmtMoney(s.byType.adjust)) + card('scale-balanced', 'success', 'زيادات (تسويات/جرد)', u.fmtMoney(s.gains));
    ERP.charts.bar('#an-shr-chart', { labels: s.byCategory.map(c => c.name), series: [{ label: 'هالك', data: s.byCategory.map(c => c.waste), color: '#dc2626' }, { label: 'عجز جرد', data: s.byCategory.map(c => c.stocktake), color: '#f59e0b' }, { label: 'تسويات', data: s.byCategory.map(c => c.adjust), color: '#0891b2' }], stacked: true });
    tables.shr.setRows(s.rows);
    current = { title: 'الفاقد والهالك', columns: [{ label: 'الصنف' }, { label: 'الفئة' }, { label: 'الكمية', num: true }, { label: 'هالك', num: true }, { label: 'عجز جرد', num: true }, { label: 'تسويات', num: true }, { label: 'الإجمالي', num: true }], rows: s.rows.map(r => [r.name, r.category, u.fmtQty(r.qty), u.fmtNum(r.waste), u.fmtNum(r.stocktake), u.fmtNum(r.adjust), u.fmtNum(r.value)]) };
  }
  function renderHeat() {
    const R = range(); const hm = AN.heatmap(R.from, R.to); const hours = u.range(24).filter(h => u.range(7).some(w => hm.count[w][h])); const H = hours.length ? hours : u.range(16).map(i => i + 8);
    const cell = (w, h) => { const v = hm.total[w][h]; const a = hm.max ? v / hm.max : 0; return `<td class="num" title="${u.AR_DAYS[w]} ${h}:00 — ${u.fmtMoney(v)} (${hm.count[w][h]} فاتورة)" style="background:rgba(22,163,74,${(0.08 + a * 0.85).toFixed(2)});color:${a > 0.55 ? '#fff' : 'inherit'};font-size:.72rem;padding:.35rem .25rem;text-align:center">${v ? u.fmtMoneyShort(v) : ''}</td>`; };
    el.querySelector('#an-heat').innerHTML = `<div class="table-wrap"><table class="table table-compact" style="min-width:720px"><thead><tr><th></th>${H.map(h => `<th class="num" style="text-align:center">${h}</th>`).join('')}<th class="num">الإجمالي</th></tr></thead><tbody>${u.range(7).map(w => `<tr><th>${u.AR_DAYS[w]}</th>${H.map(h => cell(w, h)).join('')}<td class="num fw-700">${u.fmtNum(u.sum(hm.total[w]))}</td></tr>`).join('')}</tbody></table></div><div class="text-xs muted mt-2">كل خلية = إجمالي المبيعات في هذه الساعة لهذا اليوم من الأسبوع خلال الفترة (مرّر الماوس للتفاصيل).</div>`;
    current = { title: 'خريطة المبيعات حسب اليوم والساعة', columns: [{ label: 'اليوم' }, ...H.map(h => ({ label: String(h), num: true }))], rows: u.range(7).map(w => [u.AR_DAYS[w], ...H.map(h => u.fmtNum(hm.total[w][h]))]), landscape: true };
  }
  const RENDER = { abc: renderAbc, prof: renderProf, slow: renderSlow, shr: renderShrink, heat: renderHeat };
  function refresh() { if (!el) return; el.querySelectorAll('#an-tabs .tab').forEach(x => x.classList.toggle('active', x.dataset.t === tab)); el.querySelectorAll('.an-pane').forEach(x => x.classList.toggle('hidden', x.dataset.p !== tab)); try { RENDER[tab](); } catch (err) { console.error(err); ERP.ui.error(err.message); } }

  ERP.router.register({
    id: 'analytics', title: 'تحليلات متقدمة', icon: 'chart-column', section: 'المالية', order: 3.5, perm: 'reports.profit',
    render(root) {
      el = root;
      root.innerHTML = `<div class="page-header"><div><h2><i class="fas fa-chart-column"></i> تحليلات متقدمة</h2><div class="desc">ABC، الربحية، الراكد، الفاقد، وأوقات الذروة</div></div>
        <div class="page-actions"><div class="pills" id="an-period">${['today', 'week', 'month', '30d', 'quarter', 'year', 'all'].map(k => `<button class="pill ${k === period ? 'active' : ''}" data-p="${k}">${ERP.reports.period(k).label}</button>`).join('')}<button class="pill" data-p="custom">مخصص</button></div><div id="an-custom" class="flex gap-2 hidden"><input type="date" id="an-from"><input type="date" id="an-to"></div><button class="btn btn-outline" id="an-print"><i class="fas fa-print"></i> طباعة</button></div></div>
        <div class="tabs mb-3" id="an-tabs"><button class="tab active" data-t="abc">تحليل ABC</button><button class="tab" data-t="prof">الربحية</button><button class="tab" data-t="slow">الراكد والميت</button><button class="tab" data-t="shr">الفاقد والهالك</button><button class="tab" data-t="heat">أوقات الذروة</button></div>
        <div class="an-pane" data-p="abc"><div class="flex gap-2 mb-3 items-center"><span class="text-sm">التصنيف حسب</span><div class="pills" id="an-abc-by"><button class="pill active" data-v="total">الإيراد</button><button class="pill" data-v="profit">الربح</button></div><span class="text-xs muted">A = أول 80% · B = الـ15% التالية · C = آخر 5%</span></div><div class="kpi-grid mb-3" id="an-abc-kpis"></div><div class="grid" style="grid-template-columns:minmax(0,280px) minmax(0,1fr);gap:1rem;align-items:start"><div class="card"><div class="card-body" style="height:260px"><canvas id="an-abc-chart"></canvas></div></div><div id="an-t-abc"></div></div></div>
        <div class="an-pane hidden" data-p="prof"><div class="flex gap-2 mb-3 items-center"><span class="text-sm">حسب</span><div class="pills" id="an-prof-by"><button class="pill active" data-v="category">الفئة</button><button class="pill" data-v="supplier">المورد</button></div></div><div class="kpi-grid mb-3" id="an-prof-kpis"></div><div class="card mb-3"><div class="card-body" style="height:260px"><canvas id="an-prof-chart"></canvas></div></div><div id="an-t-prof"></div></div>
        <div class="an-pane hidden" data-p="slow"><div class="flex gap-2 mb-3 items-center"><label class="text-sm">بلا مبيعات منذ <input type="number" id="an-slow-days" value="${slowDays}" min="1" style="width:80px"> يوم</label></div><div class="kpi-grid mb-3" id="an-slow-kpis"></div><div id="an-t-slow"></div></div>
        <div class="an-pane hidden" data-p="shr"><div class="kpi-grid mb-3" id="an-shr-kpis"></div><div class="card mb-3"><div class="card-body" style="height:240px"><canvas id="an-shr-chart"></canvas></div></div><div id="an-t-shr"></div></div>
        <div class="an-pane hidden" data-p="heat" id="an-heat"></div>`;
      mkTable('abc', { exportName: 'تحليل-ABC', defaultSort: { key: 'share', dir: 'desc' }, columns: [
        { key: 'cls', label: 'الفئة', render: r => u.badge(r.cls, CLS[r.cls]) },
        { key: 'name', label: 'الصنف', render: (r, t) => u.highlight(r.name, t) },
        { key: 'qty', label: 'الكمية', num: true, render: r => u.fmtQty(r.qty) },
        { key: 'total', label: 'الإيراد', num: true, render: r => u.fmtNum(r.total), footer: rs => u.fmtMoney(u.sum(rs, 'total')) },
        { key: 'profit', label: 'الربح', num: true, render: r => `<span class="${r.profit < 0 ? 'text-danger' : ''}">${u.fmtNum(r.profit)}</span>`, footer: rs => u.fmtMoney(u.sum(rs, 'profit')) },
        { key: 'share', label: 'النسبة', num: true, render: r => pct(r.share) },
        { key: 'cumShare', label: 'التراكمي', num: true, render: r => pct(r.cumShare) }] });
      mkTable('prof', { exportName: 'الربحية', defaultSort: { key: 'profit', dir: 'desc' }, columns: [
        { key: 'name', label: 'الاسم', render: (r, t) => `${r.color ? `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${e(r.color)};margin-left:6px"></span>` : ''}${u.highlight(r.name, t)}` },
        { key: 'products', label: 'الأصناف', num: true },
        { key: 'qty', label: 'الكمية (وحدة أساسية)', num: true, render: r => u.fmtQty(r.qty) },
        { key: 'revenue', label: 'الإيراد', num: true, render: r => u.fmtNum(r.revenue), footer: rs => u.fmtMoney(u.sum(rs, 'revenue')) },
        { key: 'cogs', label: 'التكلفة', num: true, render: r => u.fmtNum(r.cogs), footer: rs => u.fmtMoney(u.sum(rs, 'cogs')) },
        { key: 'profit', label: 'مجمل الربح', num: true, render: r => `<strong class="${r.profit < 0 ? 'text-danger' : 'text-success'}">${u.fmtNum(r.profit)}</strong>`, footer: rs => u.fmtMoney(u.sum(rs, 'profit')) },
        { key: 'margin', label: 'الهامش %', num: true, render: r => pct(r.margin) }] });
      mkTable('slow', { exportName: 'الأصناف-الراكدة', defaultSort: { key: 'value', dir: 'desc' }, columns: [
        { key: 'name', label: 'الصنف', render: (r, t) => `<div class="fw-600">${u.highlight(r.product.name, t)}</div><div class="text-xs muted num">${e(r.product.code || '')}</div>`, text: r => r.product.name + ' ' + (r.product.code || ''), sortValue: r => r.product.name },
        { key: 'qty', label: 'المخزون', num: true, render: r => u.fmtQty(r.qty) },
        { key: 'value', label: 'القيمة بالتكلفة', num: true, render: r => `<strong>${u.fmtNum(r.value)}</strong>`, footer: rs => u.fmtMoney(u.sum(rs, 'value')) },
        { key: 'lastSale', label: 'آخر بيع', render: r => r.lastSale ? `<span class="num">${u.fmtDate(r.lastSale)}</span>` : u.badge('لم يُبع', 'danger'), sortValue: r => r.lastSale || '' },
        { key: 'daysSince', label: 'منذ (يوم)', num: true, render: r => r.daysSince ?? '—', sortValue: r => r.daysSince ?? 1e9 },
        { key: 'sold30', label: 'مبيع 30 يوم', num: true, render: r => u.fmtQty(r.sold30) },
        { key: 'daysOfCover', label: 'أيام التغطية', num: true, render: r => r.daysOfCover ?? '∞', sortValue: r => r.daysOfCover ?? 1e9 }] });
      mkTable('shr', { exportName: 'الفاقد-والهالك', defaultSort: { key: 'value', dir: 'desc' }, columns: [
        { key: 'name', label: 'الصنف', render: (r, t) => u.highlight(r.name, t) },
        { key: 'category', label: 'الفئة' },
        { key: 'qty', label: 'الكمية', num: true, render: r => u.fmtQty(r.qty) },
        { key: 'waste', label: 'هالك', num: true, render: r => r.waste ? u.fmtNum(r.waste) : '—', footer: rs => u.fmtMoney(u.sum(rs, 'waste')) },
        { key: 'stocktake', label: 'عجز جرد', num: true, render: r => r.stocktake ? u.fmtNum(r.stocktake) : '—', footer: rs => u.fmtMoney(u.sum(rs, 'stocktake')) },
        { key: 'adjust', label: 'تسويات بالنقص', num: true, render: r => r.adjust ? u.fmtNum(r.adjust) : '—', footer: rs => u.fmtMoney(u.sum(rs, 'adjust')) },
        { key: 'value', label: 'الإجمالي', num: true, render: r => `<strong class="text-danger">${u.fmtNum(r.value)}</strong>`, footer: rs => u.fmtMoney(u.sum(rs, 'value')) },
        { key: 'lastAt', label: 'آخر حركة', render: r => `<span class="num text-xs">${u.fmtDate(r.lastAt)}</span>` }] });
      root.querySelector('#an-period').onclick = ev => { const b = ev.target.closest('.pill'); if (!b) return; period = b.dataset.p; root.querySelectorAll('#an-period .pill').forEach(x => x.classList.toggle('active', x === b)); root.querySelector('#an-custom').classList.toggle('hidden', period !== 'custom'); if (period !== 'custom') refresh(); };
      root.querySelector('#an-from').onchange = root.querySelector('#an-to').onchange = () => { from = root.querySelector('#an-from').value; to = root.querySelector('#an-to').value; refresh(); };
      root.querySelector('#an-tabs').onclick = ev => { const b = ev.target.closest('.tab'); if (!b) return; tab = b.dataset.t; refresh(); };
      root.querySelector('#an-abc-by').onclick = ev => { const b = ev.target.closest('.pill'); if (!b) return; abcBy = b.dataset.v; root.querySelectorAll('#an-abc-by .pill').forEach(x => x.classList.toggle('active', x === b)); refresh(); };
      root.querySelector('#an-prof-by').onclick = ev => { const b = ev.target.closest('.pill'); if (!b) return; profBy = b.dataset.v; root.querySelectorAll('#an-prof-by .pill').forEach(x => x.classList.toggle('active', x === b)); refresh(); };
      root.querySelector('#an-slow-days').onchange = ev => { slowDays = Math.max(1, Math.round(u.num(ev.target.value)) || 60); refresh(); };
      root.querySelector('#an-print').onclick = () => { const R = range(); ERP.print.table({ title: current.title, subtitle: tab === 'slow' ? `حتى ${u.fmtDate(u.todayISO())}` : `الفترة: ${R.label}`, columns: current.columns, rows: current.rows, landscape: !!current.landscape }); };
    },
    onShow(root, params) { if (params.tab && RENDER[params.tab]) tab = params.tab; refresh(); },
  });
})();
