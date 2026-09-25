/* ==========================================================================
   View: Inventory — stock levels, movements, adjustments, transfers,
   stocktake, expiry, valuation
   ========================================================================== */
window.ERP = window.ERP || {}; ERP.views = ERP.views || {};
(function () {
  const u = ERP.utils; const e = u.escapeHtml;
  let el, tab = 'stock', tables = {};
  const P = () => ERP.db.collection('products');
  const MOVE_TYPES = { sale: 'بيع', purchase: 'شراء', adjust: 'تسوية', transfer_in: 'تحويل وارد', transfer_out: 'تحويل صادر', return_in: 'مرتجع وارد', return_out: 'مرتجع للمورد', opening: 'رصيد افتتاحي', waste: 'هالك', void: 'إلغاء' };

  function whName(id) { return (ERP.db.collection('warehouses').get(id) || {}).name || '—'; }
  function switchTab(t) { tab = t; $$('.tab', $('#inv-tabs', el)).forEach(x => x.classList.toggle('active', x.dataset.t === t)); $$('.tab-pane', el).forEach(x => x.classList.toggle('active', x.dataset.p === t)); refresh(); }

  function refresh() {
    if (!el) return;
    const wh = $('#inv-wh', el).value;
    const canC = ERP.auth.can('products.cost');
    if (tab === 'stock') {
      const rows = P().all().filter(p => p.active !== false).map(p => ({ ...p, whQty: wh ? ERP.inventory.whQty(p, wh) : p.stock }));
      tables.stock.setRows(rows);
      const v = ERP.inventory.valuation(wh || null);
      $('#inv-kpis', el).innerHTML = [['boxes-stacked', 'primary', 'إجمالي الأصناف', u.fmtInt(v.rows.length)], ['layer-group', 'info', 'إجمالي الكميات', u.fmtQty(v.totalQty)], ...(canC ? [['coins', 'success', 'قيمة المخزون (تكلفة)', u.fmtMoney(v.totalValue)], ['chart-line', 'purple', 'قيمة البيع المتوقعة', u.fmtMoney(v.totalRetail)]] : []), ['triangle-exclamation', 'warning', 'منخفض', u.fmtInt(ERP.inventory.lowStock().filter(p => p.stock > 0).length)], ['circle-xmark', 'danger', 'نفذ', u.fmtInt(ERP.inventory.outOfStock().length)]].map(k => `<div class="card kpi"><div class="kpi-icon ${k[1]}"><i class="fas fa-${k[0]}"></i></div><div class="kpi-body"><div class="kpi-label">${k[2]}</div><div class="kpi-value" style="font-size:1.2rem">${k[3]}</div></div></div>`).join('');
    } else if (tab === 'moves') tables.moves.setRows(ERP.inventory.moves({ warehouseId: wh || undefined }).slice(0, 2000));
    else if (tab === 'expiry') { const ex = ERP.inventory.expiring(3650).filter(x => !wh || (x.batch.warehouseId || ERP.inventory.defaultWh()) === wh); tables.expiry.setRows(ex.map(x => ({ id: x.product.id + x.batch.expiry + (x.batch.batchNo || ''), ...x }))); }
    else if (tab === 'velocity') tables.velocity.setRows(ERP.inventory.velocity(30).filter(v => v.product.active !== false).map(v => ({ id: v.product.id, ...v })));
    else if (tab === 'docs') { const docs = [...ERP.db.collection('stocktakes').all().map(d => ({ ...d, kind: 'جرد' })), ...ERP.db.collection('transfers').all().map(d => ({ ...d, kind: 'تحويل' }))]; tables.docs.setRows(u.sortBy(docs, 'date', 'desc')); }
  }

  /* ---- dialogs ---- */
  async function adjustDialog(productId = null) {
    if (!ERP.auth.require('inventory.adjust')) return;
    const whs = ERP.inventory.warehouses();
    const h = ERP.ui.modal({ title: 'تسوية مخزون', icon: 'sliders', body: `<div class="form-group"><label class="required">المنتج</label><input id="adj-p" placeholder="ابحث…" autocomplete="off"></div><div class="form-row cols-2"><div class="form-group"><label>المخزن</label><select id="adj-wh">${u.options(whs, { selected: ERP.inventory.defaultWh() })}</select></div><div class="form-group"><label>الكمية الحالية</label><input id="adj-cur" readonly class="num"></div><div class="form-group"><label class="required">الكمية الفعلية الجديدة</label><input type="number" step="any" id="adj-new" class="num"></div><div class="form-group"><label>الفرق</label><input id="adj-diff" readonly class="num"></div></div><div class="form-group"><label class="required">السبب</label><select id="adj-reason"><option>جرد</option><option>هالك / تلف</option><option>انتهاء صلاحية</option><option>سرقة / فقد</option><option>خطأ إدخال</option><option>عينات / استهلاك داخلي</option><option>أخرى</option></select></div><div class="form-group"><label>ملاحظات</label><input id="adj-note"></div>`, footer: `<button class="btn" data-a="c">إلغاء</button><button class="btn btn-primary" data-a="ok">تنفيذ التسوية</button>` });
    let prod = productId ? P().get(productId) : null;
    const upd = () => { if (!prod) return; const cur = ERP.inventory.whQty(prod, h.$('#adj-wh').value); h.$('#adj-cur').value = u.fmtQty(cur); const nv = h.$('#adj-new').value; h.$('#adj-diff').value = nv === '' ? '' : (u.num(nv) - cur > 0 ? '+' : '') + u.fmtQty(u.num(nv) - cur); };
    ERP.ui.picker(h.$('#adj-p'), { source: () => P().all().filter(p => p.active !== false), sub: p => `${p.code} · مخزون ${u.fmtQty(p.stock)}`, onPick: p => { prod = p; upd(); h.$('#adj-new').focus(); } });
    if (prod) { h.$('#adj-p').value = prod.name; upd(); }
    h.$('#adj-wh').onchange = upd; h.$('#adj-new').oninput = upd;
    h.$('[data-a=c]').onclick = () => h.close();
    h.$('[data-a=ok]').onclick = () => { if (!prod) return ERP.ui.warn('اختر المنتج'); const nv = h.$('#adj-new').value; if (nv === '') return ERP.ui.warn('أدخل الكمية الجديدة'); try { const mv = ERP.inventory.adjust({ productId: prod.id, warehouseId: h.$('#adj-wh').value, newQty: u.num(nv), reason: `${h.$('#adj-reason').value}${h.$('#adj-note').value ? ' — ' + h.$('#adj-note').value : ''}` }); h.close(); ERP.ui.success(mv ? `تمت التسوية (${mv.qty > 0 ? '+' : ''}${u.fmtQty(mv.qty)})` : 'لا يوجد فرق'); } catch (err) { ERP.ui.error(err.message); } };
  }
  async function transferDialog() {
    if (!ERP.auth.require('inventory.transfer')) return;
    const whs = ERP.inventory.warehouses(); if (whs.length < 2) return ERP.ui.warn('أضف مخزناً ثانياً من الإعدادات أولاً');
    let lines = [];
    const h = ERP.ui.modal({ title: 'تحويل بين المخازن', icon: 'right-left', size: 'lg', body: `<div class="form-row cols-2"><div class="form-group"><label>من مخزن</label><select id="tr-from">${u.options(whs, { selected: whs[0].id })}</select></div><div class="form-group"><label>إلى مخزن</label><select id="tr-to">${u.options(whs, { selected: whs[1].id })}</select></div></div><div class="form-group"><label>إضافة صنف</label><input id="tr-p" placeholder="ابحث أو امسح الباركود…" autocomplete="off"></div><div class="doc-lines" id="tr-lines"></div><div class="form-group mt-3"><label>ملاحظات</label><input id="tr-note"></div>`, footer: `<button class="btn" data-a="c">إلغاء</button><button class="btn btn-primary" data-a="ok"><i class="fas fa-check"></i> تنفيذ التحويل</button>` });
    const render = () => { const from = h.$('#tr-from').value; h.$('#tr-lines').innerHTML = `<div class="doc-line head" style="grid-template-columns:2fr 1fr 1fr 40px"><span>الصنف</span><span>المتاح</span><span>الكمية</span><span></span></div>` + (lines.map((l, i) => { const p = P().get(l.productId); return `<div class="doc-line" style="grid-template-columns:2fr 1fr 1fr 40px"><span>${e(p.name)}</span><span class="num">${u.fmtQty(ERP.inventory.whQty(p, from))}</span><input type="number" step="any" value="${l.qty}" data-i="${i}" class="num"><button class="btn btn-icon btn-sm btn-ghost text-danger" data-d="${i}"><i class="fas fa-xmark"></i></button></div>`; }).join('') || '<div class="p-3 text-center muted text-sm">لا أصناف</div>'); };
    render();
    ERP.ui.picker(h.$('#tr-p'), { source: () => P().all().filter(p => p.active !== false), sub: p => `${p.code} · مخزون ${u.fmtQty(p.stock)}`, clearOnPick: true, onPick: p => { const ex = lines.find(l => l.productId === p.id); if (ex) ex.qty++; else lines.push({ productId: p.id, qty: 1 }); render(); } });
    h.$('#tr-lines').addEventListener('input', ev => { if (ev.target.dataset.i !== undefined) lines[+ev.target.dataset.i].qty = u.num(ev.target.value); });
    h.$('#tr-lines').addEventListener('click', ev => { const d = ev.target.closest('[data-d]'); if (d) { lines.splice(+d.dataset.d, 1); render(); } });
    h.$('#tr-from').onchange = render;
    h.$('[data-a=c]').onclick = () => h.close();
    h.$('[data-a=ok]').onclick = () => { lines = lines.filter(l => l.qty > 0); if (!lines.length) return ERP.ui.warn('أضف أصنافاً'); try { const d = ERP.inventory.transfer({ fromWh: h.$('#tr-from').value, toWh: h.$('#tr-to').value, lines, note: h.$('#tr-note').value }); h.close(); ERP.ui.success(`تم التحويل ${d.no}`); } catch (err) { ERP.ui.error(err.message); } };
  }
  async function stocktakeDialog() {
    if (!ERP.auth.require('inventory.adjust')) return;
    const whs = ERP.inventory.warehouses(); const cats = ERP.db.collection('categories').all();
    let wh = ERP.inventory.defaultWh(), catF = '', counts = {}, pinned = null; // counts: productId → counted (survives filtering/search)
    const LIMIT = 200; const dirty = () => Object.values(counts).some(v => v !== '' && v !== undefined);
    const h = ERP.ui.modal({ title: 'جرد المخزون', icon: 'clipboard-check', size: 'xl', closable: false, body: `<div class="flex gap-3 flex-wrap items-end mb-3"><div class="form-group" style="margin:0"><label>المخزن</label><select id="st-wh">${u.options(whs, { selected: wh })}</select></div><div class="form-group" style="margin:0"><label>الفئة</label><select id="st-cat"><option value="">الكل</option>${u.options(cats)}</select></div><div class="form-group flex-1" style="margin:0"><label>بحث / باركود</label><input id="st-q" placeholder="اكتب أو امسح…"></div><button class="btn btn-outline" id="st-fill"><i class="fas fa-equals"></i> افتراض المطابقة للكل</button>${ERP.mobilecount ? `<button class="btn btn-outline" id="st-mimport" title="ملف JSON/CSV مُصدَّر من صفحة عدّ الموبايل"><i class="fas fa-file-import"></i> استيراد عدّ الموبايل</button><input type="file" id="st-mfile" accept=".json,.csv,.txt,application/json,text/csv,text/plain" hidden>${ERP.mobilecount.lanAvailable ? '<button class="btn btn-outline" id="st-mlan"><i class="fas fa-qrcode"></i> عدّ بالموبايل (QR)</button>' : ''}` : ''}</div><div id="st-mpanel" class="card card-body mb-3 hidden"></div><div class="alert alert-info mb-3"><i class="fas fa-circle-info"></i> أدخل الكمية الفعلية المعدودة فقط للأصناف التي تريد تسويتها. الأصناف الفارغة لن تتأثر.</div><div class="table-wrap" style="max-height:52vh;overflow:auto"><table class="table table-compact"><thead><tr><th>الصنف</th><th class="num">المتوقع</th><th class="num" style="width:130px">المعدود</th><th class="num">الفرق</th></tr></thead><tbody id="st-body"></tbody></table></div><div class="flex justify-between mt-3 text-sm"><span id="st-summary"></span><input id="st-note" placeholder="ملاحظات الجرد" style="max-width:320px"></div>`, footer: `<button class="btn" data-a="c">إلغاء</button><button class="btn btn-primary" data-a="ok"><i class="fas fa-check"></i> اعتماد الجرد وتسوية الفروق</button>`, onClose: () => mobileCleanup() });
    const list = () => { const q = h.$('#st-q').value.trim(); return P().all().filter(p => p.active !== false && (!catF || p.categoryId === catF) && (!q || u.match(p.name, q) || u.match(p.code, q) || (p.barcode && p.barcode.includes(q)))); };
    const render = () => { // only the first LIMIT matches are rendered (large catalogs); the last scanned item is pinned on top
      let rows = u.sortBy(list(), 'name'); const total = rows.length;
      if (pinned) { const pp = P().get(pinned); rows = pp ? [pp, ...rows.filter(p => p.id !== pinned)] : rows; }
      rows = rows.slice(0, LIMIT);
      h.$('#st-body').innerHTML = rows.map(p => { const exp = ERP.inventory.whQty(p, wh); const c = counts[p.id]; const diff = c === undefined || c === '' ? null : u.round(u.num(c) - exp, 3); return `<tr class="${diff === null ? '' : diff < 0 ? 'row-danger' : diff > 0 ? 'row-warning' : ''}"><td>${e(p.name)}<div class="text-xs muted num">${e(p.code)}</div></td><td class="num">${u.fmtQty(exp)}</td><td><input type="number" step="any" class="num" data-id="${p.id}" value="${c ?? ''}" style="min-height:32px;padding:.3rem .5rem"></td><td class="num ${diff > 0 ? 'text-success' : diff < 0 ? 'text-danger' : ''}">${diff === null ? '—' : (diff > 0 ? '+' : '') + u.fmtQty(diff)}</td></tr>`; }).join('') + (total > LIMIT ? `<tr><td colspan="4" class="text-center muted text-sm">يُعرض أول ${LIMIT} صنف من ${total} — استخدم البحث أو الفئة أو امسح الباركود للوصول لباقي الأصناف (الكميات المدخلة محفوظة)</td></tr>` : ''); summary(); };
    const summary = () => { const n = Object.values(counts).filter(v => v !== '' && v !== undefined).length; let val = 0, diffs = 0; Object.entries(counts).forEach(([id, v]) => { if (v === '' || v === undefined) return; const p = P().get(id); const d = u.num(v) - ERP.inventory.whQty(p, wh); if (d) { diffs++; val += d * p.cost; } }); h.$('#st-summary').innerHTML = `تم عدّ <strong>${n}</strong> صنف · <strong>${diffs}</strong> فرق · قيمة الفروق <strong class="${val < 0 ? 'text-danger' : 'text-success'}">${u.fmtMoney(val)}</strong>`; };
    render();
    h.$('#st-wh').onchange = async ev => { const next = ev.target.value; if (dirty() && !await ERP.ui.confirm('تغيير المخزن سيمسح كل الكميات المعدودة حتى الآن. متابعة؟', { danger: true, okText: 'تغيير ومسح' })) { ev.target.value = wh; return; } wh = next; counts = {}; pinned = null; render(); }; h.$('#st-cat').onchange = ev => { catF = ev.target.value; render(); }; h.$('#st-q').oninput = u.debounce(render, 150);
    h.$('#st-q').onkeydown = ev => { if (ev.key === 'Enter') { const r = ERP.inventory.resolveScan(ev.target.value.trim()); if (r) { counts[r.product.id] = u.num(counts[r.product.id]) + r.qty; pinned = r.product.id; ev.target.value = ''; render(); } } };
    h.$('#st-body').addEventListener('input', ev => { if (ev.target.dataset.id) { counts[ev.target.dataset.id] = ev.target.value; const tr = ev.target.closest('tr'); const p = P().get(ev.target.dataset.id); const d = ev.target.value === '' ? null : u.round(u.num(ev.target.value) - ERP.inventory.whQty(p, wh), 3); tr.className = d === null ? '' : d < 0 ? 'row-danger' : d > 0 ? 'row-warning' : ''; tr.lastElementChild.innerHTML = d === null ? '—' : (d > 0 ? '+' : '') + u.fmtQty(d); tr.lastElementChild.className = 'num ' + (d > 0 ? 'text-success' : d < 0 ? 'text-danger' : ''); summary(); } });
    h.$('#st-fill').onclick = () => { list().forEach(p => { if (counts[p.id] === undefined || counts[p.id] === '') counts[p.id] = ERP.inventory.whQty(p, wh); }); render(); };
    /* ---- mobile stocktake: file import (everywhere) + LAN/QR live counts (desktop app) — counts are BASE units ---- */
    const mc = ERP.mobilecount; let offLan = null; const lanUnm = [];
    function mobileCleanup() { if (offLan) { offLan(); offLan = null; } if (mc && mc.lan) mc.lanStop(); }
    const applyLines = (lines, mode) => { const r = mc.merge(counts, lines, { mode, products: P().all(), resolve: ERP.inventory.resolveScan }); counts = r.counts; if (r.lastId) pinned = r.lastId; render(); return r; };
    if (mc) {
      h.$('#st-mimport').onclick = () => h.$('#st-mfile').click();
      h.$('#st-mfile').onchange = async ev => { const f = ev.target.files[0]; ev.target.value = ''; if (!f) return; let lines; try { lines = mc.parse(await f.text()); } catch (err) { return ERP.ui.error('ملف غير صالح: ' + err.message); } if (!lines.length) return ERP.ui.warn('الملف لا يحتوي على كميات'); const mode = await mc.askMode(lines.length); if (!mode) return; const r = applyLines(lines, mode); ERP.ui.success(`تم دمج ${r.touched.length} صنف (${mode === 'sum' ? 'جمع' : 'استبدال'})${r.unmatched.length ? ` — ${r.unmatched.length} كود غير معروف` : ''}`); mc.unmatchedView(r.unmatched); };
      const lb = h.$('#st-mlan');
      if (lb) lb.onclick = async () => {
        const pnl = h.$('#st-mpanel');
        if (mc.lan) { mobileCleanup(); pnl.classList.add('hidden'); lb.innerHTML = '<i class="fas fa-qrcode"></i> عدّ بالموبايل (QR)'; return; }
        lb.disabled = true;
        try {
          const r = await mc.lanStart(); pnl.innerHTML = mc.qrPanelHtml(r); pnl.classList.remove('hidden'); lb.innerHTML = '<i class="fas fa-stop"></i> إيقاف خادم الموبايل';
          const draw = () => { const url = mc.url(r, h.$('#mc-ip').value); h.$('#mc-url').textContent = url; ERP.print.qrDataUrl(url, 176).then(src => { h.$('#mc-qr').innerHTML = src ? `<img src="${src}" width="176" height="176" alt="QR">` : '<div class="text-xs muted">QR غير متاح — اكتب العنوان في متصفح الموبايل</div>'; }); };
          draw(); h.$('#mc-ip').onchange = draw;
          let batches = 0, lines = 0;
          offLan = mc.onLan(batch => { const res = applyLines(batch.items || [], 'sum'); batches++; lines += (batch.items || []).length; lanUnm.push(...res.unmatched); const st = h.$('#mc-stat'); if (st) { st.innerHTML = `<i class="fas fa-circle-check text-success"></i> استُلمت <strong class="num">${batches}</strong> دفعة (${lines} سطر) — آخرها من ${e(batch.device || 'موبايل')} ${u.fmtTime(new Date())}${lanUnm.length ? ` · <a href="javascript:void 0" id="mc-unm" class="text-danger">${lanUnm.length} كود غير معروف</a>` : ''}`; const a = h.$('#mc-unm'); if (a) a.onclick = () => mc.unmatchedView(lanUnm); } ERP.ui.toast(`عدّ الموبايل: ${res.touched.length} صنف${res.unmatched.length ? ` · ${res.unmatched.length} غير معروف` : ''}`, res.unmatched.length ? 'warning' : 'success'); });
        } catch (err) { ERP.ui.error(err.message); } finally { lb.disabled = false; }
      };
    }
    h.$('[data-a=c]').onclick = async () => { if (dirty() && !await ERP.ui.confirm('إغلاق الجرد وتجاهل كل الكميات المعدودة؟', { danger: true, okText: 'تجاهل وإغلاق' })) return; h.close(); };
    let busy = false;
    h.$('[data-a=ok]').onclick = async () => { if (busy) return; busy = true; try { await approve(); } finally { busy = false; } };
    const approve = async () => { const lines = Object.entries(counts).filter(([, v]) => v !== '' && v !== undefined).map(([productId, v]) => ({ productId, counted: u.num(v) })); if (!lines.length) return ERP.ui.warn('لم يتم إدخال أي كميات'); if (!await ERP.ui.confirm(`اعتماد جرد ${lines.length} صنف وتسوية الفروق تلقائياً؟`, { okText: 'اعتماد' })) return; try { const d = ERP.inventory.applyStocktake({ warehouseId: wh, lines, note: h.$('#st-note').value }); h.close(); ERP.ui.success(`تم اعتماد الجرد ${d.no}`); switchTab('docs'); } catch (err) { ERP.ui.error(err.message); } };
  }
  function docDetails(d) {
    const isCount = !!d.lines?.[0]?.counted !== undefined && d.no?.startsWith(ERP.settings.prefix('stocktake'));
    if (d.kind === 'جرد') ERP.ui.view(`جرد ${e(d.no)}`, `<div class="detail-grid mb-3"><div class="detail-item"><div class="dl">التاريخ</div><div class="dv num">${u.fmtDateTime(d.date)}</div></div><div class="detail-item"><div class="dl">المخزن</div><div class="dv">${e(whName(d.warehouseId))}</div></div><div class="detail-item"><div class="dl">قيمة الفروق</div><div class="dv ${d.diffValue < 0 ? 'text-danger' : 'text-success'}">${u.fmtMoney(d.diffValue)}</div></div><div class="detail-item"><div class="dl">ملاحظات</div><div class="dv">${e(d.note || '—')}</div></div></div><div class="table-wrap"><table class="table table-compact"><thead><tr><th>الصنف</th><th class="num">المتوقع</th><th class="num">المعدود</th><th class="num">الفرق</th></tr></thead><tbody>${d.lines.map(l => `<tr class="${l.diff < 0 ? 'row-danger' : l.diff > 0 ? 'row-warning' : ''}"><td>${e(l.name)}</td><td class="num">${u.fmtQty(l.expected)}</td><td class="num">${u.fmtQty(l.counted)}</td><td class="num">${l.diff > 0 ? '+' : ''}${u.fmtQty(l.diff)}</td></tr>`).join('')}</tbody></table></div>`);
    else ERP.ui.view(`تحويل ${e(d.no)}`, `<div class="detail-grid mb-3"><div class="detail-item"><div class="dl">التاريخ</div><div class="dv num">${u.fmtDateTime(d.date)}</div></div><div class="detail-item"><div class="dl">من</div><div class="dv">${e(whName(d.fromWh))}</div></div><div class="detail-item"><div class="dl">إلى</div><div class="dv">${e(whName(d.toWh))}</div></div></div><table class="table table-compact"><thead><tr><th>الصنف</th><th class="num">الكمية</th></tr></thead><tbody>${d.lines.map(l => `<tr><td>${e((P().get(l.productId) || {}).name || '')}</td><td class="num">${u.fmtQty(l.qty)}</td></tr>`).join('')}</tbody></table>`);
  }

  ERP.views.inventory = { adjustDialog, transferDialog, stocktakeDialog, moveType: t => MOVE_TYPES[t] || t };
  ERP.router.register({
    id: 'inventory', title: 'المخزون', icon: 'warehouse', section: 'العمليات', order: 3, perm: 'inventory.view',
    badge() { const n = ERP.inventory.lowStock().length; return n ? { text: n, kind: 'danger' } : null; },
    render(root) {
      el = root; const canA = ERP.auth.can('inventory.adjust'), canT = ERP.auth.can('inventory.transfer'), canC = ERP.auth.can('products.cost');
      root.innerHTML = `<div class="page-header"><div><h2><i class="fas fa-warehouse"></i> المخزون</h2><div class="desc">أرصدة، حركات، تسويات، تحويلات، جرد وصلاحية</div></div>
        <div class="page-actions"><select id="inv-wh" style="min-width:170px"><option value="">كل المخازن</option>${u.options(ERP.inventory.warehouses())}</select>${canA ? `<button class="btn btn-outline" id="inv-adj"><i class="fas fa-sliders"></i> تسوية</button><button class="btn btn-outline" id="inv-count"><i class="fas fa-clipboard-check"></i> جرد</button>` : ''}${canT ? `<button class="btn btn-outline" id="inv-tr"><i class="fas fa-right-left"></i> تحويل</button>` : ''}<button class="btn btn-primary" id="inv-print"><i class="fas fa-print"></i> تقرير المخزون</button></div></div>
        <div class="kpi-grid mb-4" id="inv-kpis"></div>
        <div class="tabs" id="inv-tabs"><button class="tab active" data-t="stock"><i class="fas fa-boxes-stacked"></i> الأرصدة</button><button class="tab" data-t="moves"><i class="fas fa-arrow-right-arrow-left"></i> الحركات</button><button class="tab" data-t="expiry"><i class="fas fa-calendar-xmark"></i> الصلاحية</button><button class="tab" data-t="velocity"><i class="fas fa-gauge"></i> سرعة الدوران</button><button class="tab" data-t="docs"><i class="fas fa-file-lines"></i> مستندات الجرد والتحويل</button></div>
        <div class="tab-pane active" data-p="stock"><div id="inv-t-stock"></div></div><div class="tab-pane" data-p="moves"><div id="inv-t-moves"></div></div><div class="tab-pane" data-p="expiry"><div id="inv-t-expiry"></div></div><div class="tab-pane" data-p="velocity"><div id="inv-t-velocity"></div></div><div class="tab-pane" data-p="docs"><div id="inv-t-docs"></div></div>`;
      tables.stock = ERP.ui.table({ el: '#inv-t-stock', rows: [], exportName: 'أرصدة المخزون', defaultSort: { key: 'whQty', dir: 'asc' }, toolbarExtra: `<select id="inv-f" style="min-width:140px"><option value="">الكل</option><option value="low">منخفض</option><option value="out">نفذ</option><option value="ok">طبيعي</option></select>`, columns: [
        { key: 'name', label: 'الصنف', render: (p, t) => `<div class="fw-600">${u.highlight(p.name, t)}</div><div class="text-xs muted num">${e(p.code)}</div>`, text: p => p.name + ' ' + p.code },
        { key: 'categoryId', label: 'الفئة', render: p => e((ERP.db.collection('categories').get(p.categoryId) || {}).name || '—'), text: p => (ERP.db.collection('categories').get(p.categoryId) || {}).name || '' },
        { key: 'whQty', label: 'الرصيد', num: true, render: p => `<strong>${u.fmtQty(p.whQty)}</strong>`, text: p => u.fmtQty(p.whQty), footer: r => u.fmtQty(u.sum(r, 'whQty')) },
        { key: 'minStock', label: 'الحد الأدنى', num: true, render: p => u.fmtQty(p.minStock ?? ERP.settings.get('lowStockThreshold')) },
        ...(canC ? [{ key: 'cost', label: 'التكلفة', num: true, render: p => u.fmtNum(p.cost) }, { id: 'value', label: 'القيمة', num: true, render: p => u.fmtNum(p.whQty * p.cost), sortValue: p => p.whQty * p.cost, text: p => u.fmtNum(p.whQty * p.cost), footer: r => u.fmtMoney(u.sum(r, p => p.whQty * p.cost)) }] : []),
        { id: 'st', label: 'الحالة', render: p => u.stockBadge({ stock: p.whQty, minStock: p.minStock }), text: p => p.whQty <= 0 ? 'نفذ' : p.whQty <= (p.minStock ?? 5) ? 'منخفض' : 'متوفر', sortable: false },
        { key: 'lastMoveAt', label: 'آخر حركة', render: p => `<span class="text-xs muted">${p.lastMoveAt ? u.relTime(p.lastMoveAt) : '—'}</span>` },
        ...(canA ? [{ id: 'a', label: '', sortable: false, export: false, render: p => `<button class="btn btn-sm btn-ghost" data-adj="${p.id}"><i class="fas fa-sliders"></i> تسوية</button>` }] : []),
      ], rowClass: p => p.whQty <= 0 ? 'row-danger' : p.whQty <= u.num(p.minStock, 5) ? 'row-warning' : '', onRowClick: p => ERP.views.products.details(p.id) });
      tables.moves = ERP.ui.table({ el: '#inv-t-moves', rows: [], exportName: 'حركات المخزون', defaultSort: { key: 'date', dir: 'desc' }, toolbarExtra: `<select id="inv-mt" style="min-width:150px"><option value="">كل الأنواع</option>${Object.entries(MOVE_TYPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>`, columns: [
        { key: 'date', label: 'التاريخ', render: m => `<span class="num text-sm">${u.fmtDateTime(m.date)}</span>`, text: m => u.fmtDateTime(m.date) },
        { key: 'productName', label: 'الصنف', render: (m, t) => u.highlight(m.productName, t) },
        { key: 'warehouseId', label: 'المخزن', render: m => e(whName(m.warehouseId)), text: m => whName(m.warehouseId) },
        { key: 'type', label: 'النوع', render: m => u.badge(MOVE_TYPES[m.type] || m.type, m.qty > 0 ? 'success' : 'danger'), text: m => MOVE_TYPES[m.type] || m.type },
        { key: 'qty', label: 'الكمية', num: true, render: m => `<strong class="${m.qty < 0 ? 'text-danger' : 'text-success'}">${m.qty > 0 ? '+' : ''}${u.fmtQty(m.qty)}</strong>`, text: m => u.fmtQty(m.qty) },
        ...(canC ? [{ key: 'unitCost', label: 'التكلفة', num: true, render: m => u.fmtNum(m.unitCost) }, { key: 'value', label: 'القيمة', num: true, render: m => u.fmtNum(m.value) }] : []),
        { key: 'balanceAfter', label: 'الرصيد بعد', num: true, render: m => u.fmtQty(m.balanceAfter) },
        { key: 'note', label: 'مرجع / ملاحظة', render: m => `<span class="text-xs">${e(m.note || '')}</span>` },
      ] });
      tables.expiry = ERP.ui.table({ el: '#inv-t-expiry', rows: [], exportName: 'الصلاحية', columns: [
        { id: 'p', label: 'الصنف', render: x => `<div class="fw-600">${e(x.product.name)}</div><div class="text-xs muted">${e(x.product.code)}</div>`, text: x => x.product.name, sortValue: x => x.product.name },
        { id: 'b', label: 'الدفعة', render: x => e(x.batch.batchNo || '—'), text: x => x.batch.batchNo || '' },
        { id: 'w', label: 'المخزن', render: x => e(whName(x.batch.warehouseId || ERP.inventory.defaultWh())), text: x => whName(x.batch.warehouseId) },
        { id: 'e', label: 'تاريخ الانتهاء', num: true, render: x => u.fmtDate(x.batch.expiry), sortValue: x => x.batch.expiry, text: x => u.fmtDate(x.batch.expiry) },
        { id: 'd', label: 'المتبقي', num: true, render: x => x.expired ? u.badge(`منتهي منذ ${-x.daysLeft} يوم`, 'danger') : x.daysLeft <= 30 ? u.badge(`${x.daysLeft} يوم`, 'warning') : u.badge(`${x.daysLeft} يوم`, 'success'), sortValue: x => x.daysLeft, text: x => x.daysLeft + ' يوم' },
        { id: 'q', label: 'الكمية', num: true, render: x => u.fmtQty(x.batch.qty), text: x => u.fmtQty(x.batch.qty), sortValue: x => x.batch.qty },
        ...(canA ? [{ id: 'a', label: '', sortable: false, export: false, render: x => x.expired ? `<button class="btn btn-sm btn-soft-danger" data-waste="${x.product.id}" data-qty="${x.batch.qty}" data-wh="${x.batch.warehouseId || ''}"><i class="fas fa-trash"></i> إعدام</button>` : '' }] : []),
      ], rowClass: x => x.expired ? 'row-danger' : x.daysLeft <= 30 ? 'row-warning' : '', emptyText: 'لا توجد دفعات بتاريخ صلاحية', emptyIcon: 'calendar-check' });
      tables.velocity = ERP.ui.table({ el: '#inv-t-velocity', rows: [], exportName: 'سرعة الدوران', defaultSort: { id: 'sold', key: 'sold', dir: 'desc' }, columns: [
        { id: 'n', key: 'n', label: 'الصنف', render: v => e(v.product.name), text: v => v.product.name, sortValue: v => v.product.name },
        { key: 'sold', label: 'مبيعات 30 يوم', num: true, render: v => u.fmtQty(v.sold), text: v => u.fmtQty(v.sold) },
        { key: 'perDay', label: 'يومياً', num: true, render: v => u.fmtNum(v.perDay, 2) },
        { id: 's', key: 's', label: 'الرصيد', num: true, render: v => u.fmtQty(v.product.stock), sortValue: v => v.product.stock, text: v => u.fmtQty(v.product.stock) },
        { key: 'daysOfCover', label: 'أيام التغطية', num: true, render: v => v.daysOfCover === null ? u.badge('راكد', 'neutral') : v.daysOfCover <= 7 ? u.badge(`${v.daysOfCover} يوم`, 'danger') : v.daysOfCover <= 30 ? u.badge(`${v.daysOfCover} يوم`, 'warning') : u.badge(`${v.daysOfCover} يوم`, 'success'), text: v => v.daysOfCover ?? 'راكد' },
        { id: 'r', label: 'توصية', sortable: false, render: v => v.dead ? '<span class="text-xs muted">بضاعة راكدة — فكّر في عرض ترويجي</span>' : v.daysOfCover !== null && v.daysOfCover <= 7 ? '<span class="text-xs text-danger fw-600">اطلب الآن</span>' : '' },
      ] });
      tables.docs = ERP.ui.table({ el: '#inv-t-docs', rows: [], exportName: 'مستندات المخزون', defaultSort: { key: 'date', dir: 'desc' }, columns: [
        { key: 'no', label: 'الرقم', render: d => `<strong class="num">${e(d.no)}</strong>` }, { key: 'kind', label: 'النوع', render: d => u.badge(d.kind, d.kind === 'جرد' ? 'info' : 'purple') },
        { key: 'date', label: 'التاريخ', render: d => `<span class="num">${u.fmtDateTime(d.date)}</span>`, text: d => u.fmtDateTime(d.date) },
        { id: 'w', label: 'المخزن', render: d => d.kind === 'جرد' ? e(whName(d.warehouseId)) : `${e(whName(d.fromWh))} ← ${e(whName(d.toWh))}`, sortable: false, text: d => d.kind === 'جرد' ? whName(d.warehouseId) : whName(d.fromWh) + '→' + whName(d.toWh) },
        { id: 'l', label: 'الأصناف', num: true, render: d => d.lines.length, sortable: false, text: d => d.lines.length },
        { key: 'diffValue', label: 'قيمة الفروق', num: true, render: d => d.diffValue !== undefined ? `<span class="${d.diffValue < 0 ? 'text-danger' : 'text-success'}">${u.fmtMoney(d.diffValue)}</span>` : '—', text: d => d.diffValue ?? '' },
        { key: 'note', label: 'ملاحظات', render: d => `<span class="text-xs">${e(d.note || '')}</span>` },
      ], onRowClick: d => docDetails(d) });
      $('#inv-tabs', root).onclick = ev => { const t = ev.target.closest('.tab'); if (t) switchTab(t.dataset.t); };
      $('#inv-wh', root).onchange = refresh;
      $('#inv-f', root).onchange = ev => { const f = ev.target.value; const wh = $('#inv-wh', root).value; tables.stock.setRows(P().all().filter(p => p.active !== false).map(p => ({ ...p, whQty: wh ? ERP.inventory.whQty(p, wh) : p.stock })).filter(p => !f || (f === 'out' ? p.whQty <= 0 : f === 'low' ? p.whQty > 0 && p.whQty <= u.num(p.minStock, 5) : p.whQty > u.num(p.minStock, 5)))); };
      $('#inv-mt', root).onchange = ev => tables.moves.setRows(ERP.inventory.moves({ warehouseId: $('#inv-wh', root).value || undefined, type: ev.target.value || undefined }).slice(0, 2000));
      root.addEventListener('click', async ev => { const a = ev.target.closest('[data-adj]'); if (a) { ev.stopPropagation(); adjustDialog(a.dataset.adj); } const w = ev.target.closest('[data-waste]'); if (w) { ev.stopPropagation(); if (await ERP.ui.confirm(`إعدام ${u.fmtQty(w.dataset.qty)} وحدة منتهية الصلاحية؟`, { danger: true, okText: 'إعدام' })) { try { ERP.inventory.waste({ productId: w.dataset.waste, warehouseId: w.dataset.wh || null, qty: w.dataset.qty, reason: 'انتهاء صلاحية' }); ERP.ui.success('تم الإعدام'); } catch (err) { ERP.ui.error(err.message); } } } });
      if (canA) { $('#inv-adj', root).onclick = () => adjustDialog(); $('#inv-count', root).onclick = stocktakeDialog; }
      if (canT) $('#inv-tr', root).onclick = transferDialog;
      $('#inv-print', root).onclick = () => { const v = ERP.inventory.valuation($('#inv-wh', root).value || null); ERP.print.table({ title: 'تقرير المخزون', subtitle: $('#inv-wh', root).value ? whName($('#inv-wh', root).value) : 'كل المخازن', columns: [{ label: 'الكود' }, { label: 'الصنف' }, { label: 'الكمية', num: true }, ...(canC ? [{ label: 'التكلفة', num: true }, { label: 'القيمة', num: true }] : []), { label: 'الحالة' }], rows: u.sortBy(v.rows, r => r.product.name).map(r => [r.product.code, r.product.name, u.fmtQty(r.qty), ...(canC ? [u.fmtNum(r.cost), u.fmtNum(r.value)] : []), r.qty <= 0 ? 'نفذ' : r.qty <= u.num(r.product.minStock, 5) ? 'منخفض' : 'متوفر']), summary: [{ label: 'الأصناف', value: v.rows.length }, { label: 'الكميات', value: u.fmtQty(v.totalQty) }, ...(canC ? [{ label: 'قيمة التكلفة', value: u.fmtMoney(v.totalValue) }, { label: 'قيمة البيع', value: u.fmtMoney(v.totalRetail) }] : [])] }); };
    },
    onShow(root, params) { if (params.tab) switchTab(params.tab); else refresh(); if (params.filter) { const f = $('#inv-f', root); f.value = params.filter; f.dispatchEvent(new Event('change')); } },
  });
  ERP.bus.on('db:change', u.debounce(ev => { if (el && ERP.router.current() === 'inventory' && ['products', 'stockMoves', 'stocktakes', 'transfers'].includes(ev?.collection)) refresh(); }, 250));
})();
