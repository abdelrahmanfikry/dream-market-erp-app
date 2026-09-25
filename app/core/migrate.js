/* ==========================================================================
   ERP.migrate — one-time import of the legacy app's localStorage data
   Legacy keys: products, sales, debts (v1 schema)
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  const u = ERP.utils;
  const LEGACY_FLAG = 'legacyMigrated';

  function legacyLoad(key) { try { const r = localStorage.getItem(key); return r ? JSON.parse(r) : null; } catch { return null; } }

  function legacyDateISO(dateStr, timeStr) {
    const d = u.parseDate(dateStr) || new Date();
    if (timeStr) {
      const t = u.normalizeDigits(timeStr);
      const m = t.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(ص|م|AM|PM)?/i);
      if (m) {
        let h = +m[1]; const ap = (m[4] || '').toUpperCase();
        if (ap === 'م' || ap === 'PM') { if (h < 12) h += 12; }
        if ((ap === 'ص' || ap === 'AM') && h === 12) h = 0;
        d.setHours(h, +m[2], +(m[3] || 0), 0);
      }
    }
    return d.toISOString();
  }

  const CAT_MAP = { 'أغذية': 'cat_food', 'مشروبات': 'cat_drinks', 'منظفات': 'cat_clean', 'أخرى': 'cat_other' };

  ERP.migrate = {
    hasLegacy() { return !ERP.db.getMeta(LEGACY_FLAG) && (!!legacyLoad('products') || !!legacyLoad('sales') || !!legacyLoad('debts')); },

    run() {
      if (!ERP.migrate.hasLegacy()) return null;
      const db = ERP.db;
      const products = legacyLoad('products') || [];
      const sales = legacyLoad('sales') || [];
      const debts = legacyLoad('debts') || [];
      const legacySettings = legacyLoad('settings') || legacyLoad('appSettings') || {};
      const stats = { products: 0, sales: 0, customers: 0, payments: 0 };
      const wh = ERP.settings.get('posDefaultWarehouse') || 'wh_main';

      /* ---- products ---- */
      const prodIdMap = {}; // legacy numeric id -> new id
      const pcol = db.collection('products');
      const supCol = db.collection('suppliers');
      const supByName = {};
      products.forEach(lp => {
        let supplierId = null;
        if (lp.supplier) {
          if (!supByName[lp.supplier]) {
            const ex = supCol.first({ name: lp.supplier });
            supByName[lp.supplier] = ex || supCol.insert({ code: db.nextSeq('SUP', 'SUP', 4), name: lp.supplier, phone: '', balance: 0, active: true }, { silent: true });
          }
          supplierId = supByName[lp.supplier].id;
        }
        const stock = u.num(lp.stock);
        const price = u.num(lp.price);
        const np = pcol.insert({
          code: lp.code || db.nextSeq('PRD', 'PRD', 5), barcode: lp.barcode || '', barcodes: [],
          name: lp.name, categoryId: CAT_MAP[lp.category] || 'cat_other', unitId: 'un_pc',
          cost: u.num(lp.cost, u.round(price * 0.8)), price, wholesalePrice: 0, minPrice: 0, taxRate: 0,
          minStock: 5, reorderQty: 0, supplierId, image: (lp.image && !lp.image.startsWith('data:image/svg')) ? lp.image : '',
          trackExpiry: false, active: true, stock, stockByWh: { [wh]: stock }, batches: [], legacyId: lp.id,
        }, { silent: true });
        prodIdMap[lp.id] = np.id;
        stats.products++;
      });

      /* ---- customers from debts + sales ---- */
      const ccol = db.collection('customers');
      const custByName = {};
      const getCustomer = (name, phone = '') => {
        name = (name || '').trim();
        if (!name || name === 'عميل نقدي') return null;
        if (custByName[name]) return custByName[name];
        const ex = ccol.first({ name });
        const c = ex || ccol.insert({ code: db.nextSeq('CUS', 'CUS', 4), name, phone: phone || '', address: '', creditLimit: 0, balance: 0, loyaltyPoints: 0, group: 'عادي', active: true, notes: '' }, { silent: true });
        if (!ex) stats.customers++;
        custByName[name] = c;
        return c;
      };
      debts.forEach(d => getCustomer(d.customer, d.phone));

      /* ---- sales & payments ---- */
      const scol = db.collection('sales');
      const paycol = db.collection('payments');
      const balanceDelta = {}; // customerId -> computed due from sales - receipts
      u.sortBy(sales, s => legacyDateISO(s.date, s.time)).forEach(ls => {
        const at = legacyDateISO(ls.date, ls.time);
        const cust = getCustomer(ls.customer);
        if (ls.paymentStatus === 'payment') {
          // legacy stored debt repayments as pseudo-sales
          const amt = Math.abs(u.num(ls.amount));
          if (cust && amt > 0) {
            paycol.insert({ no: db.nextSeq('receipt', ERP.settings.prefix('receipt')), date: at, type: 'receipt', partyType: 'customer', partyId: cust.id, partyName: cust.name, amount: amt, method: 'cash', refType: 'legacy', refId: ls.id, notes: ls.notes || 'تحصيل (مستورد)', legacy: true }, { silent: true });
            balanceDelta[cust.id] = (balanceDelta[cust.id] || 0) - amt;
            stats.payments++;
          }
          return;
        }
        const items = (ls.items || []).map(it => {
          const qty = u.num(it.quantity, 1), price = u.num(it.price);
          const pid = prodIdMap[it.productId] || null;
          const prod = pid ? pcol.get(pid) : null;
          return { productId: pid, name: it.name, qty, price, cost: prod ? prod.cost : u.round(price * 0.8), discount: 0, taxRate: 0, total: u.round(qty * price) };
        });
        const total = u.num(ls.amount) || u.sum(items, 'total');
        const isDebt = ls.paymentStatus === 'debt' || ls.paymentStatus === 'unpaid';
        const paid = isDebt ? 0 : (ls.paymentStatus === 'partial' ? u.num(ls.paidAmount, 0) : total);
        const due = u.round(total - paid);
        const status = due <= 0 ? 'paid' : paid > 0 ? 'partial' : 'unpaid';
        scol.insert({
          id: undefined, no: ls.id || db.nextSeq('sale', ERP.settings.prefix('sale')), date: at, type: 'sale',
          customerId: cust ? cust.id : null, customerName: ls.customer || 'عميل نقدي',
          items, subtotal: u.sum(items, 'total'), discount: 0, discountType: 'fixed', tax: 0, total, paid, due, status,
          payments: paid > 0 ? [{ method: 'cash', amount: paid }] : [], cogs: u.sum(items, it => it.cost * it.qty),
          userId: null, shiftId: null, warehouseId: wh, notes: ls.notes || '', legacy: true,
        }, { silent: true });
        if (cust && due > 0) balanceDelta[cust.id] = (balanceDelta[cust.id] || 0) + due;
        stats.sales++;
      });

      /* ---- reconcile customer balances ---- */
      Object.values(custByName).forEach(c => {
        const computed = u.round(balanceDelta[c.id] || 0);
        const legacyDebt = debts.find(d => d.customer === c.name);
        // Trust computed balance when sales exist; otherwise use legacy totalDebt as opening balance
        let balance = computed;
        let opening = 0;
        if (legacyDebt && Math.abs(computed) < 0.01 && u.num(legacyDebt.totalDebt) > 0) { opening = u.num(legacyDebt.totalDebt); balance = opening; }
        else if (legacyDebt && u.num(legacyDebt.totalDebt) > computed + 0.01) { opening = u.round(u.num(legacyDebt.totalDebt) - computed); balance = computed + opening; }
        ccol.update(c.id, { balance: Math.max(0, u.round(balance)), openingBalance: opening, phone: c.phone || (legacyDebt ? legacyDebt.phone : '') }, { silent: true });
      });

      /* ---- settings ---- */
      const patch = {};
      if (legacySettings.storeName) patch.storeName = legacySettings.storeName;
      if (legacySettings.receiptThanks) patch.receiptThanks = legacySettings.receiptThanks;
      if (legacySettings.receiptTerms) patch.receiptTerms = legacySettings.receiptTerms;
      if (legacySettings.lowStockThreshold) patch.lowStockThreshold = u.num(legacySettings.lowStockThreshold);
      if (Object.keys(patch).length) ERP.settings.set(patch);

      db.setMeta(LEGACY_FLAG, u.now());
      db.setMeta('legacyStats', stats);
      // keep the legacy keys as a safety net but rename them
      ['products', 'sales', 'debts'].forEach(k => { const v = localStorage.getItem(k); if (v !== null) { localStorage.setItem('legacy_backup_' + k, v); localStorage.removeItem(k); } });
      db.flush();
      ERP.audit.log('backup.restore', `استيراد بيانات النظام القديم: ${stats.products} منتج، ${stats.sales} فاتورة، ${stats.customers} عميل`);
      return stats;
    },
  };
})();
