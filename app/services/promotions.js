/* ==========================================================================
   ERP.promotions — discount rules applied to a cart
   types: percent | fixed | buy_x_get_y | bundle_price | min_total_percent
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  const u = ERP.utils;
  const R = () => ERP.db.collection('promotions');

  function applies(promo, item, product) {
    if (promo.scope === 'all') return true;
    if (promo.scope === 'products') return (promo.productIds || []).includes(item.productId);
    if (promo.scope === 'categories') return product && (promo.categoryIds || []).includes(product.categoryId);
    return false;
  }
  function activeNow(promo) {
    if (!promo.active) return false;
    const today = u.todayISO();
    if (promo.from && today < promo.from) return false;
    if (promo.to && today > promo.to) return false;
    if (promo.days && promo.days.length && !promo.days.includes(new Date().getDay())) return false;
    return true;
  }

  ERP.promotions = {
    all() { return R().all(); },
    active() { return R().all().filter(activeNow); },
    save(promo) {
      const saved = R().upsert({ active: true, scope: 'all', ...promo });
      ERP.audit.log('promo.update', saved.name, saved.id);
      return saved;
    },
    remove(id) { R().remove(id); },
    /** returns { byLine: {index: {discount, labels}}, lines: {productId: {discount, labels}}, cartDiscount, labels: [], lineTotal }
     *  Multi-unit rule: item promos are evaluated per PRODUCT on its BASE quantity (Σ qty × factor over all of the
     *  product's cart lines, e.g. 2 cartons×24 + 3 pieces = 51). minQty / buyQty / bundleQty are base units,
     *  'fixed' is an amount per base unit, free/bundle units are valued at the cheapest per-base price among the
     *  product's lines; the resulting discount is spread over those lines by their gross value. The best promo per
     *  product wins (as before). A single base-unit line gives exactly the previous results. */
    evaluate(cart, cartTotal) {
      const products = ERP.db.collection('products').map();
      const out = { lines: {}, byLine: {}, cartDiscount: 0, labels: [] };
      const groups = {};
      cart.forEach((item, i) => { (groups[item.productId] = groups[item.productId] || []).push({ item, i, f: u.num(item.factor, 1) || 1, gross: u.num(item.price) * u.num(item.qty) }); });
      const best = {};
      ERP.promotions.active().forEach(pr => {
        if (pr.type === 'min_total_percent') {
          if (cartTotal >= u.num(pr.minTotal)) { let d = u.round(cartTotal * u.num(pr.value) / 100); if (u.num(pr.maxDiscount) > 0) d = Math.min(d, u.round(u.num(pr.maxDiscount))); out.cartDiscount += d; out.labels.push(`${pr.name}: -${u.fmtMoney(d)}`); }
          return;
        }
        Object.entries(groups).forEach(([pid, ls]) => {
          const p = products[pid];
          if (!applies(pr, ls[0].item, p)) return;
          const baseQty = u.round(u.sum(ls, l => u.num(l.item.qty) * l.f), 3);
          if (pr.minQty && baseQty < pr.minQty) return;
          const gross = u.sum(ls, 'gross'); if (gross <= 0) return;
          const perBase = Math.min(...ls.map(l => u.num(l.item.price) / l.f));
          let d = 0;
          if (pr.type === 'percent') d = u.round(u.sum(ls, l => u.round(l.gross * u.num(pr.value) / 100)));
          else if (pr.type === 'fixed') d = u.round(u.sum(ls, l => u.round(u.num(pr.value) * u.num(l.item.qty) * l.f)));
          else if (pr.type === 'buy_x_get_y') { const x = u.num(pr.buyQty, 2), y = u.num(pr.getQty, 1); const free = Math.floor(baseQty / (x + y)) * y; d = u.round(free * perBase); }
          else if (pr.type === 'bundle_price') { const n = u.num(pr.bundleQty, 3); const sets = Math.floor(baseQty / n); if (sets) d = u.round(sets * (perBase * n - u.num(pr.value))); }
          d = Math.min(d, u.round(gross));
          if (d > 0 && (!best[pid] || d > best[pid].discount)) best[pid] = { discount: d, labels: [pr.name] };
        });
      });
      Object.entries(best).forEach(([pid, b]) => {
        out.lines[pid] = b;
        const ls = groups[pid]; const gross = u.sum(ls, 'gross'); let left = b.discount;
        ls.forEach((l, k) => { const d = k === ls.length - 1 ? u.round(left) : u.round(b.discount * l.gross / gross); left = u.round(left - d); out.byLine[l.i] = { discount: d, labels: b.labels }; });
      });
      out.lineTotal = u.sum(Object.values(out.lines), 'discount');
      return out;
    },
    /** tag for POS product card */
    tagFor(productId) {
      const p = ERP.db.collection('products').get(productId); if (!p) return null;
      const pr = ERP.promotions.active().find(x => x.type !== 'min_total_percent' && applies(x, { productId }, p));
      if (!pr) return null;
      return pr.type === 'percent' ? `-${pr.value}%` : pr.type === 'fixed' ? `-${pr.value}` : pr.type === 'buy_x_get_y' ? `${pr.buyQty}+${pr.getQty}` : 'عرض';
    },
    TYPES: { percent: 'خصم نسبة %', fixed: 'خصم مبلغ ثابت / وحدة', buy_x_get_y: 'اشترِ X واحصل على Y', bundle_price: 'سعر الحزمة', min_total_percent: 'خصم على إجمالي الفاتورة' },
  };
})();
