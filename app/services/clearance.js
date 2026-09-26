/* ==========================================================================
   ERP.clearance — تصفية قرب الانتهاء (automatic near-expiry markdowns)
   - tiers: days-left thresholds → discount % (e.g. 30→10, 14→25, 7→40, 2→60);
     a batch with N days left gets the tier with the SMALLEST threshold ≥ N
   - pricing: evaluated by ERP.promotions.evaluate as a dynamic promotion of type
     'clearance' (label «تصفية — ينتهي خلال N يوم»), so sales.compute/create,
     receipts and the POS show it like any other offer. Best-promotion-wins per
     product: the clearance discount competes with the regular item promos and
     the LARGER discount wins (they never stack); cart-level «min_total_percent»
     promos still apply on top, as for every item promo.
   - batch-quantity aware (default mode 'batch'): the discount covers at most the
     units that sit in near-expiry batches of the POS warehouse (FEFO order, each
     batch at its own tier); units beyond that are full price. Expired batches are
     skipped here AND by the sale's FEFO consumption (ERP.inventory.move), so the
     discounted units are exactly the units that leave the near-expiry batches. Mode 'product'
     discounts the whole line at the tier of the earliest near-expiry batch.
   - guards: max discount cap %, excluded categories / products (product.noClearance),
     margin guard: net unit price never below cost × (1 + min margin %) unless
     «السماح بالبيع تحت التكلفة» is on.
   - expired batches (days left < 0) are never discounted — they belong in waste:
     writeOffExpired() uses the standard ERP.inventory.waste flow (GL inv_loss).
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  const u = ERP.utils; const e = u.escapeHtml;
  const P = () => ERP.db.collection('products');
  const DEF_TIERS = [{ days: 30, pct: 10 }, { days: 14, pct: 25 }, { days: 7, pct: 40 }, { days: 2, pct: 60 }];
  ERP.settings.extend({ clearanceEnabled: false, clearanceTiers: DEF_TIERS.map(t => ({ ...t })), clearanceMaxPct: 60, clearanceExcludeCats: [], clearanceAllowBelowCost: false, clearanceMinMarginPct: 0, clearanceMode: 'batch' });

  const S = () => ERP.settings.all();
  const whOf = b => b.warehouseId || ERP.inventory.defaultWh();
  const posWh = () => S().posDefaultWarehouse || ERP.inventory.defaultWh();

  const cl = {
    DEFAULT_TIERS: DEF_TIERS,
    enabled() { return !!S().clearanceEnabled; },
    /** "30:10، 14:25" | "30 يوم → 10%" | [{days,pct}] → [{days,pct}] sorted by days ascending (unique days, pct > 0) */
    parseTiers(v) {
      let arr = Array.isArray(v) ? v : u.normalizeDigits(String(v ?? '')).split(/[,،;\n]+/).map(x => { const n = x.match(/\d+(?:\.\d+)?/g) || []; return n.length >= 2 ? { days: n[0], pct: n[1] } : null; });
      const seen = new Set();
      arr = arr.filter(Boolean).map(t => ({ days: Math.max(0, Math.round(u.num(t.days))), pct: u.clamp(u.round(u.num(t.pct), 2), 0, 100) })).filter(t => t.pct > 0 && !seen.has(t.days) && seen.add(t.days));
      return arr.sort((a, b) => a.days - b.days);
    },
    tiers() { const t = cl.parseTiers(S().clearanceTiers || DEF_TIERS); return t.length ? t : DEF_TIERS.map(x => ({ ...x })); },
    tiersText(t = cl.tiers()) { return t.map(x => `${x.days}:${x.pct}`).join('، '); },
    /** tier for N days left (N ≥ 0) → {days,pct} | null; expired (N < 0) → null */
    tierFor(daysLeft, tiers = cl.tiers()) { if (daysLeft === null || daysLeft === undefined || daysLeft < 0) return null; return tiers.find(t => daysLeft <= t.days) || null; },
    /** discount % after the cap */
    pctFor(daysLeft, tiers) { const t = cl.tierFor(daysLeft, tiers); if (!t) return 0; const cap = u.num(S().clearanceMaxPct, 100); return cap > 0 ? Math.min(t.pct, cap) : t.pct; },
    excluded(p) { if (!p || p.noClearance || (!p.trackExpiry && !(p.batches || []).length)) return true; return (S().clearanceExcludeCats || []).includes(p.categoryId); },
    /** margin guard: discount on ONE base unit selling at perBase */
    unitDiscount(p, perBase, pct) {
      perBase = u.num(perBase); let d = perBase * u.num(pct) / 100; if (d <= 0) return 0;
      const s = S();
      if (!s.clearanceAllowBelowCost) { const floor = u.num(p.cost) * (1 + Math.max(0, u.num(s.clearanceMinMarginPct)) / 100); d = Math.min(d, Math.max(0, perBase - floor)); }
      return Math.max(0, u.round(d, 4));
    },
    /** non-expired near-expiry batches of a product in a warehouse (FEFO order) → [{batch, daysLeft, pct}] */
    nearBatches(p, wh = posWh()) {
      if (!p) return [];
      const today = u.todayISO(), tiers = cl.tiers();
      return u.sortBy((p.batches || []).filter(b => b.expiry && u.num(b.qty) > 0 && whOf(b) === wh), 'expiry')
        .map(b => { const daysLeft = u.daysBetween(today, b.expiry); return { batch: b, daysLeft, pct: cl.pctFor(daysLeft, tiers) }; })
        .filter(x => x.daysLeft >= 0 && x.pct > 0);
    },
    /** clearance discount for a product's cart lines (as grouped by ERP.promotions.evaluate: [{item, f, gross}])
     *  → { discount, label, pct, units, daysLeft } | null */
    forCart(p, lines, { wh = posWh() } = {}) {
      if (!cl.enabled() || cl.excluded(p)) return null;
      const baseQty = u.round(u.sum(lines, l => u.num(l.item.qty) * (u.num(l.f, 1) || 1)), 3); const gross = u.sum(lines, 'gross');
      if (baseQty <= 0 || gross <= 0) return null;
      const near = cl.nearBatches(p, wh); if (!near.length) return null;
      const perBase = gross / baseQty; let d = 0, units = 0, maxPct = 0;
      if (S().clearanceMode === 'product') { units = baseQty; maxPct = near[0].pct; d = baseQty * cl.unitDiscount(p, perBase, maxPct); }
      else {
        let rem = baseQty;
        for (const x of near) { if (rem <= 0.0001) break; const take = Math.min(u.num(x.batch.qty), rem); d += take * cl.unitDiscount(p, perBase, x.pct); units += take; rem = u.round(rem - take, 3); maxPct = Math.max(maxPct, x.pct); }
      }
      d = Math.min(u.round(d), u.round(gross));
      if (d <= 0) return null;
      const days = near[0].daysLeft;
      return { discount: d, label: `تصفية — ينتهي خلال ${days} يوم`, pct: maxPct, units: u.round(units, 3), daysLeft: days };
    },
    /** POS card tag */
    tagFor(p) { if (!cl.enabled() || cl.excluded(p)) return null; const n = cl.nearBatches(p); return n.length ? `تصفية -${n[0].pct}%` : null; },
    /** clearance price of one base unit (list price, margin guarded) */
    priceFor(p, pct) { return u.round(u.num(p.price) - cl.unitDiscount(p, p.price, pct)); },

    /** screen rows: every batch that is expired or inside the largest tier window */
    rows(wh = null) {
      const today = u.todayISO(), tiers = cl.tiers(), maxDays = tiers.length ? tiers[tiers.length - 1].days : 30;
      const out = [];
      P().all().filter(p => p.active !== false).forEach(p => (p.batches || []).forEach(b => {
        if (!b.expiry || u.num(b.qty) <= 0 || (wh && whOf(b) !== wh)) return;
        const daysLeft = u.daysBetween(today, b.expiry); if (daysLeft > maxDays) return;
        const expired = daysLeft < 0, excl = cl.excluded(p), pct = expired || excl ? 0 : cl.pctFor(daysLeft, tiers);
        out.push({ id: `${p.id}|${whOf(b)}|${b.batchNo || ''}|${b.expiry}`, product: p, batch: b, warehouseId: whOf(b), daysLeft, expired, excluded: excl, pct, price: u.num(p.price), clearancePrice: pct ? cl.priceFor(p, pct) : u.num(p.price), qty: u.num(b.qty), value: u.round(u.num(b.qty) * u.num(p.cost)) });
      }));
      return u.sortBy(out, r => r.batch.expiry);
    },
    /** label payload (ERP.print.labels): red «تصفية» label with old / new price, copies = batch qty (capped) */
    labelItems(rows, { copies = null, max = 200 } = {}) {
      return rows.filter(r => r.pct > 0).map(r => ({ product: r.product, qty: Math.max(1, Math.min(max, Math.ceil(copies ?? r.qty))), price: r.clearancePrice, oldPrice: r.price, clearance: true, clearanceText: `ينتهي ${u.fmtDate(r.batch.expiry)}` }));
    },
    /** write off expired batches through the standard waste flow (stock move 'waste' + GL inv_loss). Each waste move names
     *  its batch explicitly — ERP.inventory.move's FEFO consumes NON-expired batches first, so it must not guess here */
    writeOffExpired({ warehouseId = null, productIds = null } = {}) {
      const done = []; let value = 0;
      cl.rows(warehouseId).filter(r => r.expired && (!productIds || productIds.includes(r.product.id))).forEach(r => {
        const p = P().get(r.product.id); const have = ERP.inventory.whQty(p, r.warehouseId);
        const qty = u.round(Math.min(r.qty, Math.max(0, have)), 3); if (qty <= 0) return;
        const mv = ERP.inventory.waste({ productId: p.id, warehouseId: r.warehouseId, qty, reason: `انتهاء صلاحية${r.batch.batchNo ? ' — دفعة ' + r.batch.batchNo : ''} (${r.batch.expiry})`, batch: { batchNo: r.batch.batchNo || '', expiry: r.batch.expiry } });
        const v = -u.num(mv && mv.value); value += v; done.push({ productId: p.id, name: p.name, qty, expiry: r.batch.expiry, value: v });
      });
      if (done.length) ERP.audit.log('stock.waste', `شطب المنتهي: ${done.length} دفعة، قيمة ${u.fmtMoney(value)}`);
      return { count: done.length, value: u.round(value), lines: done };
    },
    /** waste / shrinkage report (moves of type 'waste') */
    wasteReport({ from = u.toISODate(u.addDays(new Date(), -30)), to = u.todayISO(), warehouseId = null } = {}) {
      const moves = ERP.inventory.moves({ type: 'waste', from, to, warehouseId: warehouseId || undefined });
      return { from, to, moves, qty: u.round(u.sum(moves, m => -m.qty), 3), value: u.round(u.sum(moves, m => -m.value)) };
    },
    printWasteReport(opts) {
      const r = cl.wasteReport(opts);
      ERP.print.table({ title: 'تقرير الهالك والفاقد', subtitle: `${u.fmtDate(r.from)} → ${u.fmtDate(r.to)}`, columns: [{ label: 'التاريخ' }, { label: 'الصنف' }, { label: 'الكمية', num: true }, { label: 'التكلفة', num: true }, { label: 'القيمة', num: true }, { label: 'السبب' }], rows: r.moves.map(m => [u.fmtDateTime(m.date), m.productName, u.fmtQty(-m.qty), u.fmtNum(m.unitCost), u.fmtNum(-m.value), m.note || '']), summary: [{ label: 'حركات', value: r.moves.length }, { label: 'الكمية', value: u.fmtQty(r.qty) }, { label: 'القيمة (تكلفة)', value: u.fmtMoney(r.value) }] });
    },

    /* ---------- inventory tab «قرب الانتهاء والتصفية» (mounted by views/inventory.js) ---------- */
    renderPanel(box, wh = null) {
      if (!box) return;
      const rows = cl.rows(wh || null); const canA = ERP.auth.can('inventory.adjust'), canC = ERP.auth.can('products.cost');
      const exp = rows.filter(r => r.expired), sel = rows.filter(r => r.pct > 0);
      box.innerHTML = `${cl.enabled() ? '' : `<div class="alert alert-warning mb-3"><i class="fas fa-circle-info"></i> التصفية التلقائية غير مفعّلة — أسعار التصفية أدناه للعرض فقط. فعّلها من الإعدادات ← تصفية قرب الانتهاء.</div>`}
        <div class="flex gap-2 flex-wrap items-center mb-3"><span class="text-sm muted">الشرائح: ${cl.tiers().map(t => u.badge(`≤ ${t.days} يوم → ${t.pct}%`, 'warning')).join(' ')}</span><span class="flex-1"></span>
        <button class="btn btn-sm btn-outline" data-cl="labels" ${sel.length ? '' : 'disabled'}><i class="fas fa-tags"></i> ملصقات تصفية (${sel.length})</button>
        ${canA ? `<button class="btn btn-sm btn-soft-danger" data-cl="writeoff" ${exp.length ? '' : 'disabled'}><i class="fas fa-trash"></i> شطب المنتهي (${exp.length})</button>` : ''}
        <button class="btn btn-sm btn-ghost" data-cl="waste"><i class="fas fa-file-lines"></i> تقرير الهالك</button></div>
        <div class="table-wrap"><table class="table table-compact"><thead><tr><th>الصنف</th><th>الدفعة</th><th class="num">الانتهاء</th><th class="num">المتبقي</th><th class="num">الكمية</th><th class="num">الخصم</th><th class="num">السعر</th><th class="num">سعر التصفية</th>${canC ? '<th class="num">القيمة (تكلفة)</th>' : ''}<th></th></tr></thead><tbody>${rows.length ? rows.map(r => `<tr class="${r.expired ? 'row-danger' : r.pct ? 'row-warning' : ''}"><td><div class="fw-600">${e(r.product.name)}</div><div class="text-xs muted num">${e(r.product.code || '')}</div></td><td>${e(r.batch.batchNo || '—')}</td><td class="num">${u.fmtDate(r.batch.expiry)}</td><td class="num">${r.expired ? u.badge(`منتهي منذ ${-r.daysLeft} يوم`, 'danger') : u.badge(`${r.daysLeft} يوم`, r.daysLeft <= 7 ? 'danger' : 'warning')}</td><td class="num">${u.fmtQty(r.qty)}</td><td class="num">${r.excluded ? '<span class="text-xs muted">مستثنى</span>' : r.pct ? `${r.pct}%` : '—'}</td><td class="num">${u.fmtNum(r.price)}</td><td class="num fw-700 ${r.pct ? 'text-danger' : ''}">${r.expired ? '—' : u.fmtNum(r.clearancePrice)}</td>${canC ? `<td class="num">${u.fmtNum(r.value)}</td>` : ''}<td class="nowrap">${r.pct ? `<button class="btn btn-sm btn-ghost" data-cl-label="${e(r.id)}" title="ملصق تصفية"><i class="fas fa-tag"></i></button>` : ''}${canA ? `<button class="btn btn-sm btn-ghost text-danger" data-cl-waste="${e(r.id)}" title="نقل للهالك"><i class="fas fa-trash"></i></button>` : ''}</td></tr>`).join('') : `<tr><td colspan="10"><div class="empty-state"><i class="fas fa-calendar-check"></i><h4>لا دفعات قريبة الانتهاء</h4></div></td></tr>`}</tbody></table></div>`;
      const byId = id => rows.find(r => r.id === id);
      box.onclick = async ev => {
        const b = ev.target.closest('[data-cl],[data-cl-label],[data-cl-waste]'); if (!b) return;
        try {
          if (b.dataset.cl === 'labels') ERP.print.labels(cl.labelItems(sel));
          else if (b.dataset.cl === 'waste') cl.printWasteReport({ warehouseId: wh || null });
          else if (b.dataset.cl === 'writeoff') {
            const val = u.sum(exp, 'value');
            if (!(await ERP.ui.confirm(`شطب ${exp.length} دفعة منتهية الصلاحية (${u.fmtQty(u.sum(exp, 'qty'))} وحدة${canC ? `، قيمة ${u.fmtMoney(val)}` : ''}) كهالك؟<br><small class="muted">تُسجَّل كحركة هالك وتُرحّل لحساب خسائر المخزون.</small>`, { title: 'شطب المنتهي', danger: true, okText: 'شطب' }))) return;
            const r = cl.writeOffExpired({ warehouseId: wh || null }); ERP.ui.success(`تم شطب ${r.count} دفعة (${u.fmtMoney(r.value)})`); cl.renderPanel(box, wh);
          } else if (b.dataset.clLabel) { const r = byId(b.dataset.clLabel); if (r) ERP.print.labels(cl.labelItems([r])); }
          else if (b.dataset.clWaste) {
            const r = byId(b.dataset.clWaste); if (!r) return;
            const q = await ERP.ui.prompt(`كمية الهالك من "${e(r.product.name)}" — دفعة ${e(r.batch.batchNo || '—')} (${u.fmtDate(r.batch.expiry)})`, { title: 'نقل للهالك', type: 'number', value: r.qty }); if (q === null || !(u.num(q) > 0)) return;
            ERP.inventory.waste({ productId: r.product.id, warehouseId: r.warehouseId, qty: Math.min(u.num(q), r.qty), reason: r.expired ? 'انتهاء صلاحية' : `قرب انتهاء (${r.batch.expiry})`, batch: { batchNo: r.batch.batchNo || '', expiry: r.batch.expiry } }); ERP.ui.success('تم النقل للهالك'); cl.renderPanel(box, wh);
          }
        } catch (err) { ERP.ui.error(err.message); }
      };
    },
  };
  ERP.clearance = cl;

  /* ---------- settings section ---------- */
  ERP.settingsSections = ERP.settingsSections || [];
  ERP.settingsSections.push({
    id: 'clearance', icon: 'hourglass-half', label: 'تصفية قرب الانتهاء',
    render(s, h) {
      const cats = ERP.db.collection('categories').all(); const ex = s.clearanceExcludeCats || [];
      return `<div class="alert alert-info mb-3"><i class="fas fa-circle-info"></i> خصم تلقائي في نقطة البيع على الأصناف ذات الدفعات قريبة الانتهاء (للأصناف التي تتبع الصلاحية). يظهر كعرض «تصفية — ينتهي خلال N يوم» في السلة والإيصال، وإذا وُجد عرض آخر على نفس الصنف يُطبَّق الخصم الأكبر فقط (لا يتراكمان). الدفعات المنتهية لا تُباع بخصم — تُشطب كهالك من المخزون ← قرب الانتهاء والتصفية.</div>`
        + h.row('تفعيل التصفية التلقائية', '', h.sw('clearanceEnabled', s.clearanceEnabled))
        + h.row('الشرائح (أيام متبقية : نسبة الخصم %)', 'مثال: 30:10، 14:25، 7:40، 2:60 — الدفعة تأخذ شريحة أقل عدد أيام ≥ المتبقي', h.inp('clearanceTiers', ERP.clearance.tiersText(), 'text', 'id="cl-tiers" dir="ltr" style="min-width:260px"') + ' <button type="button" class="btn btn-sm btn-ghost" id="cl-reset">الافتراضي</button>')
        + h.row('أقصى نسبة خصم %', 'سقف لأي شريحة', h.inp('clearanceMaxPct', s.clearanceMaxPct, 'number', 'min="0" max="100" step="any"'))
        + h.row('نطاق الخصم', 'الدفعات: الخصم على عدد الوحدات الموجودة في الدفعات القريبة فقط (الأقرب انتهاءً أولاً) والباقي بالسعر الكامل — الصنف كله: كل الكمية بشريحة أقرب دفعة', `<select name="clearanceMode"><option value="batch" ${s.clearanceMode !== 'product' ? 'selected' : ''}>كمية الدفعات القريبة فقط (موصى به)</option><option value="product" ${s.clearanceMode === 'product' ? 'selected' : ''}>الصنف كله</option></select>`)
        + h.row('حد أدنى لهامش الربح %', 'لا يقل سعر البيع بعد الخصم عن التكلفة × (1 + النسبة)', h.inp('clearanceMinMarginPct', s.clearanceMinMarginPct, 'number', 'min="0" step="any"'))
        + h.row('السماح بالبيع تحت التكلفة', 'يُلغي حارس الهامش (مفيد للأيام الأخيرة قبل الهالك)', h.sw('clearanceAllowBelowCost', s.clearanceAllowBelowCost))
        + `<div class="form-group mt-3"><label>فئات مستثناة من التصفية</label><div class="flex gap-2 flex-wrap">${cats.map(c => `<label class="checkbox"><input type="checkbox" class="cl-cat" value="${h.e(c.id)}" ${ex.includes(c.id) ? 'checked' : ''}> ${h.e(c.name)}</label>`).join('') || '<span class="muted text-sm">لا فئات</span>'}</div></div>`;
    },
    bind(body) { const b = u.$('#cl-reset', body); if (b) b.onclick = () => { u.$('#cl-tiers', body).value = ERP.clearance.tiersText(DEF_TIERS); }; },
    save(patch) {
      if ('clearanceTiers' in patch) { const t = ERP.clearance.parseTiers(patch.clearanceTiers); patch.clearanceTiers = t.length ? t : DEF_TIERS.map(x => ({ ...x })); }
      if ('clearanceMaxPct' in patch) patch.clearanceMaxPct = u.clamp(u.num(patch.clearanceMaxPct), 0, 100);
      if ('clearanceMinMarginPct' in patch) patch.clearanceMinMarginPct = Math.max(0, u.num(patch.clearanceMinMarginPct));
      const f = document.getElementById('st-form'); if (f && 'clearanceMode' in patch) patch.clearanceExcludeCats = u.$$('.cl-cat:checked', f).map(c => c.value);
    },
  });
})();
