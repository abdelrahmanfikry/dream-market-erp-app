/* ==========================================================================
   ERP.units — several selling units per product (كرتونة / علبة / قطعة …)
   product.units = [{ id, unitId?, name, factor, price, barcode, cost? }]
   - the base unit is the product's own unitId; stock, cost, stock moves and
     valuation ALWAYS stay in base units — a unit line converts with qty × factor
   - price 0/empty on a unit = base price × factor
   - legacy pack barcodes (p.barcodes [{code, qty>1, price}]) are migrated once
     into units; qty-1 barcodes stay as plain aliases
   ERP.labels — shelf-label queue fed by every selling-price change
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  const u = ERP.utils;
  const P = () => ERP.db.collection('products');
  const LQ = () => ERP.db.collection('labelQueue');
  ['priceChanges', 'labelQueue'].forEach(n => { if (ERP.db.KNOWN && !ERP.db.KNOWN.includes(n)) ERP.db.KNOWN.push(n); }); // part of backups / test snapshots
  ERP.settings.extend({ labelShowOldPrice: true, labelShowUnit: true, priceChangeNotify: true });

  const refName = id => { const r = id && ERP.db.collection('units').get(id); return r ? r.name : ''; };
  const same = (a, b) => (a || null) === (b || null);

  const units = {
    list(p) { return p && Array.isArray(p.units) ? p.units : []; },
    get(p, unitId) { return unitId ? units.list(p).find(x => x.id === unitId) || null : null; },
    factor(p, unitId) { const x = units.get(p, unitId); return x ? u.num(x.factor, 1) : 1; },
    baseName(p) { return refName(p && p.unitId) || 'قطعة'; },
    name(p, unitId) { const x = units.get(p, unitId); return x ? (x.name || refName(x.unitId) || `×${x.factor}`) : units.baseName(p); },
    /** list price of one unit (no customer) */
    price(p, unitId) { const x = units.get(p, unitId); if (!x) return u.num(p && p.price); return u.num(x.price) > 0 ? u.num(x.price) : u.round(u.num(p.price) * u.num(x.factor, 1)); },
    /** selling price of one unit for a customer: the unit's own price, else the customer's base price × factor */
    priceFor(p, unitId, customer) { const x = units.get(p, unitId); const base = ERP.sales.priceFor(p, customer); if (!x) return base; return u.num(x.price) > 0 ? u.num(x.price) : u.round(base * u.num(x.factor, 1)); },
    /** cost of one unit (base weighted-average cost × factor) */
    cost(p, unitId) { return u.num(p && p.cost) * units.factor(p, unitId); },
    /** the product-unit id of a cart/sale/PO line, or null for a base-unit line (old documents stored the base unit ref 'un_…' in unitId) */
    lineUnit(l) { if (!l || !l.unitId) return null; return u.num(l.factor, 0) > 1 || (l.factor === undefined && String(l.unitId).startsWith('pu_')) ? l.unitId : null; },
    lineKey(l) { const x = units.lineUnit(l); return x ? `${l.productId}|${x}` : l.productId; },
    baseQty(l) { return u.round(u.num(l.qty) * u.num(l.factor, 1), 3); },
    /** display name of a sale/PO line: "منتج (كرتونة)" */
    label(name, unitName) { return unitName && !String(name || '').endsWith(`(${unitName})`) ? `${name} (${unitName})` : name; },
    findBarcode(code) {
      code = String(code || '').trim(); if (!code) return null;
      for (const p of P().all()) { const x = units.list(p).find(y => y.barcode && y.barcode === code); if (x) return { product: p, unit: x }; }
      return null;
    },
    /** who uses this code already? → { product, unit|null, kind } */
    barcodeOwner(code, { exceptProductId = null } = {}) {
      code = String(code || '').trim(); if (!code) return null;
      for (const p of P().all()) {
        if (p.id === exceptProductId) continue;
        if (p.barcode === code || p.code === code) return { product: p, unit: null, kind: 'main' };
        if ((p.barcodes || []).some(b => b.code === code)) return { product: p, unit: null, kind: 'alias' };
        const x = units.list(p).find(y => y.barcode === code); if (x) return { product: p, unit: x, kind: 'unit' };
      }
      return null;
    },
    /** normalise + validate a product's unit list (throws with an Arabic message). own = { id, barcode, code, barcodes } */
    validate(own, list) {
      const seen = new Set([own.barcode, own.code, ...(own.barcodes || []).map(b => b.code)].filter(Boolean).map(String));
      const names = new Set();
      return (list || []).filter(x => x && (x.name || x.unitId || x.barcode || u.num(x.factor) || u.num(x.price))).map(x => {
        const name = String(x.name || refName(x.unitId) || '').trim();
        if (!name) throw new Error('اكتب اسم الوحدة (مثال: كرتونة)');
        const factor = Number(x.factor);
        if (!isFinite(factor) || factor <= 1) throw new Error(`معامل الوحدة "${name}" يجب أن يكون أكبر من 1 (عدد الوحدات الأساسية بداخلها)`);
        const price = x.price === null || x.price === '' || x.price === undefined ? 0 : Number(x.price);
        if (!isFinite(price) || price < 0) throw new Error(`سعر الوحدة "${name}" غير صالح`);
        const key = name + '|' + factor; if (names.has(key)) throw new Error(`الوحدة "${name}" مكررة`); names.add(key);
        const barcode = u.normalizeDigits(String(x.barcode || '')).trim();
        if (barcode) {
          if (seen.has(barcode)) throw new Error(`الباركود ${barcode} مكرر داخل نفس المنتج`);
          const o = units.barcodeOwner(barcode, { exceptProductId: own.id || null });
          if (o) throw new Error(`الباركود ${barcode} مستخدم في المنتج "${o.product.name}"${o.unit ? ` (وحدة ${o.unit.name})` : ''}`);
          seen.add(barcode);
        }
        const out = { id: x.id || u.uid('pu'), unitId: x.unitId || null, name, factor: u.round(factor, 3), price: u.round(price), barcode };
        if (u.num(x.cost) > 0) out.cost = u.round(u.num(x.cost), 4);
        return out;
      });
    },
    /** legacy pack barcodes (qty > 1) → units; returns null when nothing to convert */
    fromLegacy(p) {
      const packs = (p.barcodes || []).filter(b => b && b.code && u.num(b.qty, 1) > 1);
      if (!packs.length) return null;
      const list = [...units.list(p)];
      packs.forEach(b => { if (list.some(x => x.barcode === b.code)) return; const f = u.round(u.num(b.qty), 3); list.push({ id: u.uid('pu'), unitId: 'un_pack', name: `${refName('un_pack') || 'عبوة'} ${u.fmtQty(f)}`, factor: f, price: u.round(u.num(b.price)), barcode: String(b.code), migrated: true }); });
      return { units: list, barcodes: (p.barcodes || []).filter(b => !packs.includes(b)) };
    },
    /** one-time migration of pack barcodes into units (idempotent, flag in db meta) */
    migrate({ force = false } = {}) {
      if (!force && ERP.db.getMeta('unitsMigrated')) return 0;
      if (ERP.db.isReadOnly && ERP.db.isReadOnly()) return 0;
      let n = 0;
      P().all().forEach(p => { const r = units.fromLegacy(p); if (r) { P().update(p.id, r, { silent: true }); n++; } });
      ERP.db.setMeta('unitsMigrated', true);
      if (n) { ERP.bus.emit('db:change', { collection: 'products', op: 'bulk' }); ERP.audit.log('product.units', `ترحيل باركودات العبوات إلى وحدات: ${n} منتج`); }
      return n;
    },
    /** change the selling price of a product (unitId null) or one of its units — audit + label queue */
    setPrice(productId, unitId, price, { reason = '', silent = false, audit = true } = {}) {
      const p = P().get(productId); if (!p) throw new Error('المنتج غير موجود');
      price = u.round(u.num(price)); if (price < 0) throw new Error('سعر غير صالح');
      if (unitId) {
        const x = units.get(p, unitId); if (!x) throw new Error('الوحدة غير موجودة');
        const old = units.price(p, unitId); if (Math.abs(old - price) < 0.005 && u.num(x.price) > 0) return old;
        P().update(p.id, { units: units.list(p).map(y => y.id === unitId ? { ...y, price } : y) }, { silent });
        if (audit) ERP.audit.log('product.price', `${p.name} (${x.name}): ${old} → ${price}${reason ? ` — ${reason}` : ''}`, p.id);
        labels.add({ productId: p.id, unitId, oldPrice: old, newPrice: price, reason });
        return old;
      }
      const old = u.num(p.price); if (Math.abs(old - price) < 0.005) return old;
      P().update(p.id, { price }, { silent });
      if (audit) ERP.audit.log('product.price', `${p.name}: ${old} → ${price}${reason ? ` — ${reason}` : ''}`, p.id);
      labels.add({ productId: p.id, unitId: null, oldPrice: old, newPrice: price, reason });
      return old;
    },
    /** price-control floor for a sale line (the entered unit price is compared against it) */
    floor(p, unitId, customer) {
      if (unitId) return units.priceFor(p, unitId, customer);
      const per = units.list(p).filter(x => u.num(x.price) > 0).map(x => u.num(x.price) / u.num(x.factor, 1)); // cheapest per-base price a unit barcode may legitimately yield (orders/quotations scan)
      const legacy = (p.barcodes || []).map(b => u.num(b.price)).filter(x => x > 0);
      return Math.min(ERP.sales.priceFor(p, customer), ...per, ...legacy);
    },
  };

  /* ---------------- shelf-label queue ---------------- */
  const labels = {
    all() { return u.sortBy(LQ().all(), 'at', 'desc'); },
    pending() { return labels.all().filter(x => !x.printed); },
    count() { return LQ().all().filter(x => !x.printed).length; },
    /** queue a price change; an unprinted entry for the same product/unit is updated (and dropped when the price is back to what the shelf shows) */
    add({ productId, unitId = null, oldPrice = null, newPrice, reason = '' }) {
      newPrice = u.round(u.num(newPrice));
      if (oldPrice !== null && Math.abs(u.num(oldPrice) - newPrice) < 0.005) return null;
      const ex = LQ().all().find(x => !x.printed && x.productId === productId && same(x.unitId, unitId));
      if (ex) {
        if (ex.oldPrice !== null && Math.abs(u.num(ex.oldPrice) - newPrice) < 0.005) { LQ().remove(ex.id); ERP.bus.emit('labels:change'); return null; }
        const r = LQ().update(ex.id, { newPrice, at: u.now(), reason: reason || ex.reason }); ERP.bus.emit('labels:change'); return r;
      }
      const r = LQ().insert({ productId, unitId: unitId || null, oldPrice: oldPrice === null ? null : u.round(u.num(oldPrice)), newPrice, at: u.now(), reason, printed: false, userId: ERP.auth.current()?.id || null });
      ERP.bus.emit('labels:change');
      return r;
    },
    /** label print payload for ERP.print.labels */
    items(ids, { copies = 1, showOld = ERP.settings.get('labelShowOldPrice') } = {}) {
      return LQ().byIds(ids).map(x => {
        const p = P().get(x.productId); if (!p) return null;
        const un = units.get(p, x.unitId); const price = units.price(p, x.unitId);
        return { product: p, qty: Math.max(1, Math.floor(u.num(copies, 1))), unitName: un ? units.name(p, un.id) : (ERP.settings.get('labelShowUnit') ? units.baseName(p) : ''), price, oldPrice: showOld && x.oldPrice !== null && x.oldPrice > price ? x.oldPrice : null, barcode: (un && un.barcode) || p.barcode || p.code };
      }).filter(Boolean);
    },
    markPrinted(ids) { ids.forEach(id => LQ().update(id, { printed: true, printedAt: u.now() }, { silent: true })); ERP.bus.emit('db:change', { collection: 'labelQueue', op: 'bulk' }); ERP.bus.emit('labels:change'); },
    remove(ids) { ids.forEach(id => LQ().remove(id, { silent: true })); ERP.bus.emit('db:change', { collection: 'labelQueue', op: 'bulk' }); ERP.bus.emit('labels:change'); },
    clearPrinted() { LQ().removeWhere(x => x.printed); ERP.bus.emit('labels:change'); },
  };

  ERP.units = units;
  ERP.labels = labels;

  /* boot: migrate once the database is ready */
  const boot = () => { if (!ERP.db.isReady()) return setTimeout(boot, 250); try { units.migrate(); } catch (err) { console.warn('[units] migrate', err); } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0)); else setTimeout(boot, 0);

  /* settings section */
  ERP.settingsSections = ERP.settingsSections || [];
  ERP.settingsSections.push({
    id: 'units-labels', icon: 'tags', label: 'الوحدات والملصقات',
    render(s, h) { return `${h.row('إظهار السعر القديم مشطوباً على ملصق الرف', 'عند تخفيض السعر يظهر السعر السابق مشطوباً بجانب الجديد', h.sw('labelShowOldPrice', s.labelShowOldPrice))}${h.row('إظهار اسم الوحدة على الملصق', 'مثال: قطعة / كرتونة', h.sw('labelShowUnit', s.labelShowUnit))}${h.row('إشعار عند تطبيق تغيير سعر مجدول', 'يظهر في مركز الإشعارات عند تطبيق أو إرجاع سعر', h.sw('priceChangeNotify', s.priceChangeNotify))}<div class="text-xs muted mt-2"><i class="fas fa-circle-info"></i> وحدات البيع (كرتونة/علبة…) تُعرَّف من شاشة المنتج. المخزون والتكلفة تُحسب دائماً بالوحدة الأساسية.</div>`; },
  });
})();
