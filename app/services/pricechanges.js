/* ==========================================================================
   ERP.priceChanges — scheduled selling-price changes (collection 'priceChanges')
   { productId, unitId|null, newPrice, oldPrice, startAt, endAt|null, status:
     scheduled|applied|reverted|cancelled, note, createdBy }
   - run() applies every due change (startAt ≤ now) and reverts applied ones
     whose endAt passed (temporary offers). Idempotent: status transitions only.
   - a revert is skipped (revertSkipped) when the price was changed manually
     meanwhile — a later manual price always wins over the automatic revert.
   - runs at boot and every minute while the app is open.
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  const u = ERP.utils;
  const PC = () => ERP.db.collection('priceChanges');
  const P = () => ERP.db.collection('products');
  const T = d => d ? new Date(d).getTime() : NaN;
  const iso = d => { const t = T(d); if (!isFinite(t)) throw new Error('تاريخ غير صالح'); return new Date(t).toISOString(); };

  const pc = {
    STATUS: { scheduled: 'مجدول', applied: 'مطبق', reverted: 'انتهى (أُرجع السعر)', cancelled: 'ملغى' },
    all() { return u.sortBy(PC().all(), 'startAt', 'desc'); },
    get(id) { return PC().get(id); },
    upcoming() { return u.sortBy(PC().all().filter(x => x.status === 'scheduled' || (x.status === 'applied' && x.endAt)), 'startAt'); },
    forProduct(productId) { return pc.all().filter(x => x.productId === productId); },
    current(p, unitId) { return ERP.units.price(p, unitId); },
    schedule({ productId, unitId = null, newPrice, startAt, endAt = null, note = '', silent = false }) {
      const p = P().get(productId); if (!p) throw new Error('المنتج غير موجود');
      if (unitId && !ERP.units.get(p, unitId)) throw new Error('الوحدة غير موجودة');
      const np = Number(newPrice); if (!isFinite(np) || np < 0) throw new Error(`سعر غير صالح للمنتج ${p.name}`);
      const s = iso(startAt || u.now()); const en = endAt ? iso(endAt) : null;
      if (en && T(en) <= T(s)) throw new Error('تاريخ الانتهاء يجب أن يكون بعد تاريخ البدء');
      const doc = PC().insert({ productId, productName: p.name, unitId: unitId || null, unitName: unitId ? ERP.units.name(p, unitId) : '', newPrice: u.round(np), oldPrice: pc.current(p, unitId), startAt: s, endAt: en, status: 'scheduled', note, createdBy: ERP.auth.current()?.id || null, createdByName: ERP.auth.current()?.name || '' }, { silent });
      if (!silent) ERP.audit.log('price.schedule', `${p.name}${doc.unitName ? ` (${doc.unitName})` : ''}: ${doc.oldPrice} → ${doc.newPrice} من ${u.fmtDateTime(s)}${en ? ` حتى ${u.fmtDateTime(en)}` : ''}`, doc.id);
      return doc;
    },
    /** bulk: mode 'pct' | 'fixed' | 'price'; round step (0 = none); includeUnits applies pct/fixed to every unit too */
    newPriceFor(old, { mode, value, round = 0 }) {
      let np = mode === 'pct' ? old * (1 + u.num(value) / 100) : mode === 'fixed' ? old + u.num(value) : u.num(value);
      const rd = u.num(round); if (rd) np = Math.round(np / rd) * rd;
      return u.round(Math.max(0, np));
    },
    bulk({ productIds, mode = 'pct', value, round = 0, includeUnits = false, startAt, endAt = null, note = '' }) {
      if (!productIds || !productIds.length) throw new Error('حدد منتجات');
      if (value === null || value === undefined || value === '' || !isFinite(Number(value))) throw new Error('أدخل القيمة');
      const out = [];
      productIds.forEach(id => {
        const p = P().get(id); if (!p) return;
        const targets = [null, ...(includeUnits && mode !== 'price' ? ERP.units.list(p).map(x => x.id) : [])];
        targets.forEach(unitId => { const old = pc.current(p, unitId); const np = pc.newPriceFor(old, { mode, value, round }); if (Math.abs(np - old) >= 0.005) out.push(pc.schedule({ productId: id, unitId, newPrice: np, startAt, endAt, note, silent: true })); });
      });
      ERP.bus.emit('db:change', { collection: 'priceChanges', op: 'bulk' });
      ERP.audit.log('price.schedule', `جدولة جماعية: ${out.length} تغيير سعر (${mode} ${value}) من ${u.fmtDateTime(startAt || u.now())}`);
      return out;
    },
    /** cancel a scheduled change; an applied temporary offer is ended now (price reverted) */
    cancel(id, reason = '') {
      const x = PC().get(id); if (!x) throw new Error('غير موجود');
      if (x.status === 'scheduled') { const r = PC().update(id, { status: 'cancelled', cancelledAt: u.now(), cancelledBy: ERP.auth.current()?.id || null, cancelReason: reason }); ERP.audit.log('price.cancel', `${x.productName}: إلغاء تغيير السعر المجدول ${x.newPrice}`, id); return r; }
      if (x.status === 'applied' && x.endAt) return pc._revert(x, { early: true });
      throw new Error('لا يمكن إلغاء تغيير تم تطبيقه نهائياً — عدّل السعر يدوياً');
    },
    _apply(x) {
      const p = P().get(x.productId);
      if (!p || (x.unitId && !ERP.units.get(p, x.unitId))) return PC().update(x.id, { status: 'cancelled', cancelReason: 'المنتج أو الوحدة لم تعد موجودة', cancelledAt: u.now() }, { silent: true });
      const old = pc.current(p, x.unitId);
      ERP.units.setPrice(p.id, x.unitId, x.newPrice, { reason: `تغيير مجدول${x.note ? ' — ' + x.note : ''}`, silent: true, audit: false });
      ERP.audit.log('price.apply', `${p.name}${x.unitName ? ` (${x.unitName})` : ''}: ${old} → ${x.newPrice} (مجدول)`, x.id);
      return PC().update(x.id, { status: 'applied', appliedAt: u.now(), oldPrice: old }, { silent: true });
    },
    _revert(x, { early = false } = {}) {
      const p = P().get(x.productId);
      const cur = p ? pc.current(p, x.unitId) : null;
      const skip = !p || (x.unitId && !ERP.units.get(p, x.unitId)) || Math.abs(u.num(cur) - u.num(x.newPrice)) >= 0.005; // price changed manually meanwhile → keep it
      if (!skip) ERP.units.setPrice(p.id, x.unitId, x.oldPrice, { reason: 'انتهاء سعر مؤقت', silent: true, audit: false });
      ERP.audit.log('price.revert', `${x.productName}${x.unitName ? ` (${x.unitName})` : ''}: ${skip ? 'لم يُرجع السعر (تغير يدوياً)' : `${x.newPrice} → ${x.oldPrice}`}${early ? ' — إنهاء مبكر' : ''}`, x.id);
      return PC().update(x.id, { status: 'reverted', revertedAt: u.now(), revertSkipped: !!skip, ...(early ? { endedEarly: true } : {}) }, { silent: !early });
    },
    /** apply due changes & revert expired offers. now = Date|ISO (tests pass a date) */
    run(now = new Date()) {
      if (ERP.db.isReadOnly && ERP.db.isReadOnly()) return { applied: 0, reverted: 0 };
      const t = T(now); let applied = 0, reverted = 0; const names = [];
      u.sortBy(PC().all().filter(x => x.status === 'scheduled' && T(x.startAt) <= t), 'startAt').forEach(x => { try { const r = pc._apply(x); if (r.status === 'applied') { applied++; names.push(x.productName); } } catch (err) { console.warn('[priceChanges] apply', err); } });
      u.sortBy(PC().all().filter(x => x.status === 'applied' && x.endAt && T(x.endAt) <= t), 'endAt').forEach(x => { try { pc._revert(x); reverted++; } catch (err) { console.warn('[priceChanges] revert', err); } });
      if (applied || reverted) {
        ERP.bus.emit('db:change', { collection: 'products', op: 'bulk' }); ERP.bus.emit('db:change', { collection: 'priceChanges', op: 'bulk' });
        if (ERP.notifications && ERP.settings.get('priceChangeNotify') !== false) ERP.notifications.push({ type: 'info', title: 'تغييرات أسعار مجدولة', text: `${applied ? `تم تطبيق ${applied} سعر جديد` : ''}${applied && reverted ? ' · ' : ''}${reverted ? `انتهى ${reverted} عرض وأُرجع السعر` : ''}${names.length ? ` — ${names.slice(0, 3).join('، ')}${names.length > 3 ? '…' : ''}` : ''}. اطبع ملصقات الأسعار الجديدة.`, link: 'products' });
      }
      return { applied, reverted };
    },
    start() {
      if (pc._timer) return;
      const tick = () => { try { if (ERP.db.isReady()) pc.run(); } catch (err) { console.warn('[priceChanges]', err); } };
      tick(); pc._timer = setInterval(tick, 60 * 1000);
    },
  };
  ERP.priceChanges = pc;

  const boot = () => { if (!ERP.db.isReady() || !ERP.settings.all()) return setTimeout(boot, 300); setTimeout(() => pc.start(), 1500); }; // after main.js boot (seed / auth) settles
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0)); else setTimeout(boot, 0);
})();
