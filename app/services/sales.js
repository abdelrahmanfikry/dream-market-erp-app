/* ==========================================================================
   ERP.sales / ERP.pos — invoice engine: totals, promotions, tax, multi-pay,
   credit, loyalty, stock moves, accounting, returns, voids, held carts
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  const u = ERP.utils;
  const SALES = () => ERP.db.collection('sales');
  const P = () => ERP.db.collection('products');
  const PM = () => ERP.db.collection('paymentMethods');

  /** compute a cart into totals (no side effects). cart: [{productId, name, qty, price, discount(line amt), taxRate}] */
  function compute(cart, { discount = 0, discountType = 'fixed', loyaltyDiscount = 0, applyPromos = true } = {}) {
    const s = ERP.settings.all();
    const products = P().map();
    let promo = { lines: {}, byLine: {}, cartDiscount: 0, labels: [] };
    // unit lines (carton ×24 …): qty & price are per unit; factor comes from the product's unit (stored factor as fallback)
    cart = cart.map(it => { const p = products[it.productId]; const uid = ERP.units.lineUnit(it) || (it.unitId && p && ERP.units.get(p, it.unitId) ? it.unitId : null); if (!uid) return { ...it, unitId: null, factor: 1, unitName: '' }; const un = p ? ERP.units.get(p, uid) : null; return { ...it, unitId: uid, factor: un ? u.num(un.factor, 1) : u.num(it.factor, 1), unitName: un ? ERP.units.name(p, uid) : (it.unitName || '') }; });
    const gross = u.round(u.sum(cart, it => it.qty * it.price));
    if (applyPromos) promo = ERP.promotions.evaluate(cart, gross);
    const items = cart.map((it, i) => {
      const p = products[it.productId];
      const lineGross = u.round(it.qty * it.price);
      const pl = (promo.byLine || {})[i];
      const promoD = pl ? pl.discount : 0;
      const manualD = u.num(it.discount);
      const disc = Math.min(lineGross, u.round(promoD + manualD));
      const net = u.round(lineGross - disc);
      const rate = s.taxEnabled ? u.num(it.taxRate ?? (p ? p.taxRate : 0) ?? s.taxRate) : 0;
      const taxAmount = rate ? (s.taxInclusive ? u.round(net - net / (1 + rate / 100)) : u.round(net * rate / 100)) : 0;
      const un = it.unitId && p ? ERP.units.get(p, it.unitId) : null;
      // cost is per LINE unit (base avg cost × factor) so cost × qty = COGS; stock moves use baseQty
      return { productId: it.productId, name: ERP.units.label(it.name, it.unitName), barcode: (un && un.barcode) || (p ? p.barcode : ''), qty: u.num(it.qty), unitId: it.unitId, unitName: it.unitName, factor: it.factor, baseQty: u.round(u.num(it.qty) * it.factor, 3), baseUnitId: p ? p.unitId : null, price: u.num(it.price), cost: p ? u.num(p.cost) * it.factor : u.num(it.cost), discount: disc, promoLabel: pl ? pl.labels.join(', ') : '', taxRate: rate, taxAmount, total: net };
    });
    const subtotal = u.round(u.sum(items, it => it.qty * it.price));
    const lineDiscounts = u.round(u.sum(items, 'discount'));
    const afterLines = subtotal - lineDiscounts;
    let invoiceDiscount = discountType === 'percent' ? u.round(afterLines * u.num(discount) / 100) : u.round(u.num(discount));
    invoiceDiscount = u.clamp(invoiceDiscount + promo.cartDiscount, 0, afterLines);
    const taxable = afterLines - invoiceDiscount;
    let tax = 0;
    if (s.taxEnabled) { const ratio = afterLines ? taxable / afterLines : 1; tax = u.round(u.sum(items, 'taxAmount') * ratio); }
    const loyalty = u.clamp(u.num(loyaltyDiscount), 0, taxable + (s.taxInclusive ? 0 : tax));
    const total = u.round(taxable + (s.taxInclusive ? 0 : tax) - loyalty);
    return { items, subtotal, lineDiscounts, discount: u.round(lineDiscounts + invoiceDiscount), invoiceDiscount, promoDiscount: u.round(promo.lineTotal + promo.cartDiscount), promoLabels: promo.labels, tax, loyaltyDiscount: loyalty, total, cogs: u.round(u.sum(items, it => it.cost * it.qty)), itemCount: items.length, qtyCount: u.sum(items, 'qty') };
  }

  const sales = {
    compute,
    methods() { return PM().all().filter(m => m.active !== false); },
    /** selling price for a product given the customer's group: tier → wholesale fallback → retail */
    priceFor(product, customer) {
      if (!product) return 0;
      const g = customer && customer.group; const tiers = product.priceTiers || {};
      if (g && u.num(tiers[g]) > 0) return u.num(tiers[g]);
      if (g === 'جملة' && u.num(product.wholesalePrice) > 0) return u.num(product.wholesalePrice);
      return u.num(product.price);
    },
    methodName(id) { const m = PM().get(id); return m ? m.name : (id === 'credit' ? 'آجل' : id); },
    all() { return SALES().all(); },
    get(id) { return SALES().get(id); },
    byNo(no) { return SALES().first({ no }); },

    /**
     * Create an invoice. payments: [{method, amount}] — 'credit' method means on account.
     */
    create({ cart, customerId = null, customerName = null, payments = [], discount = 0, discountType = 'fixed', loyaltyPoints = 0, notes = '', warehouseId = null, date = null, quotationId = null, approvedBy = null, deliveryFee = 0, orderId = null, applyPromos = true }) {
      if (!cart || !cart.length) throw new Error('السلة فارغة');
      const s = ERP.settings.all();
      const user = ERP.auth.current();
      const shift = ERP.shifts.current();
      if (s.posRequireShift && !shift && ERP.auth.can('cash.manage')) throw new Error('يجب فتح وردية أولاً');
      const wh = warehouseId || s.posDefaultWarehouse || ERP.inventory.defaultWh();
      const customer = customerId ? ERP.crm.get(customerId) : null;
      /* ---- 1) validate everything — nothing is written until all checks pass ---- */
      const allowNeg = ERP.inventory.canGoNegative();
      const canPrice = ERP.auth.can('pos.price_edit');
      const need = {};
      for (const it of cart) {
        const p = P().get(it.productId); if (!p) throw new Error(`منتج غير موجود: ${it.name}`);
        const q = Number(it.qty), pr = Number(it.price);
        if (!isFinite(q) || q <= 0) throw new Error(`كمية غير صالحة للصنف ${p.name}`);
        if (!isFinite(pr) || pr < 0) throw new Error(`سعر غير صالح للصنف ${p.name}`);
        if (u.num(it.discount) < 0) throw new Error(`خصم غير صالح للصنف ${p.name}`);
        const uid = ERP.units.lineUnit(it) || (it.unitId && ERP.units.get(p, it.unitId) ? it.unitId : null);
        if (uid && !ERP.units.get(p, uid)) throw new Error(`وحدة البيع غير موجودة للصنف ${p.name} — أعد إضافته للسلة`);
        const f = ERP.units.factor(p, uid); // stock is checked in base units: qty × factor over all lines of the product
        need[p.id] = u.round((need[p.id] || 0) + q * f, 3);
        if (!allowNeg && ERP.inventory.whQty(p, wh) < need[p.id] - 0.0001) throw new Error(`رصيد غير كافٍ: ${p.name} (المتاح ${u.fmtQty(ERP.inventory.whQty(p, wh))} ${ERP.units.baseName(p)}${uid ? ` · المطلوب ${u.fmtQty(need[p.id])}` : ''})`);
        const approved = canPrice || it.approvedBy || approvedBy;
        if (p.minPrice && pr < p.minPrice * f && !approved) throw new Error(`السعر أقل من الحد الأدنى للمنتج ${p.name}`);
        // price floor = customer's list price of the line's unit (base line: also a configured unit-barcode per-piece price)
        const floor = ERP.units.floor(p, uid, customer);
        if (pr < floor - 0.0001 && !approved) throw new Error(`سعر "${p.name}" (${u.fmtNum(pr)}) أقل من سعر البيع المعتمد ${u.fmtNum(floor)} — يتطلب صلاحية تعديل السعر أو موافقة مشرف`);
      }
      // loyalty: clamp to the customer's available points, enforce the minimum
      let pts = 0, loyaltyDiscount = 0;
      if (u.num(loyaltyPoints) > 0 && customer) {
        pts = Math.floor(Math.min(u.num(loyaltyPoints), u.num(customer.loyaltyPoints)));
        if (pts <= 0 || pts < u.num(s.loyaltyMinRedeem)) throw new Error(`نقاط العميل غير كافية — الحد الأدنى للاستبدال ${s.loyaltyMinRedeem} نقطة (المتاح ${u.fmtInt(customer.loyaltyPoints)})`);
        loyaltyDiscount = ERP.crm.pointsValue(pts);
      }
      const c = compute(cart, { discount, discountType, loyaltyDiscount, applyPromos });
      if (pts && c.loyaltyDiscount < loyaltyDiscount - 0.009) { const rv = u.num(s.loyaltyRedeemValue); if (rv > 0) pts = Math.ceil(c.loyaltyDiscount / rv - 1e-9); } // capped by the invoice total → fewer points used
      if (!c.loyaltyDiscount) pts = 0;
      c.deliveryFee = u.round(u.num(deliveryFee)); if (c.deliveryFee > 0) c.total = u.round(c.total + c.deliveryFee);
      if (c.discount > 0 && !ERP.auth.can('pos.discount') && u.num(discount) > 0 && !approvedBy) throw new Error('ليس لديك صلاحية منح خصومات');
      // payments
      if (payments.some(p => u.num(p.amount) < 0)) throw new Error('مبلغ دفع سالب غير مسموح');
      const pays = payments.map(p => ({ method: p.method, amount: u.round(u.num(p.amount)), isCredit: p.method === 'credit' || !!(PM().get(p.method) || {}).isCredit, isGift: p.method === 'gift' || !!(PM().get(p.method) || {}).isGift, cardCode: p.cardCode || null, ref: p.ref || '' })).filter(p => p.amount > 0);
      const giftPays = pays.filter(p => p.isGift);
      if (giftPays.length) {
        if (!ERP.giftcards) throw new Error('بطاقات الهدايا غير متاحة');
        const perCard = {};
        giftPays.forEach(p => { if (!p.cardCode) throw new Error('أدخل رقم بطاقة الهدايا'); const k = u.normalizeDigits(String(p.cardCode)).trim().toUpperCase(); perCard[k] = u.round((perCard[k] || 0) + p.amount); });
        Object.entries(perCard).forEach(([code, amt]) => ERP.giftcards.check(code, amt)); // combined amount per card vs its balance
        if (u.sum(giftPays, 'amount') > c.total + 0.009) throw new Error('قيمة بطاقة الهدايا أكبر من الفاتورة — قلّل المبلغ المخصوم منها');
      }
      const cashLike = u.round(u.sum(pays.filter(p => !p.isCredit), 'amount'));
      const change = cashLike > c.total ? u.round(cashLike - c.total) : 0;
      const due = u.round(Math.max(0, c.total - cashLike));
      if (due > 0) {
        if (!customer) throw new Error('البيع الآجل يتطلب اختيار عميل مسجل');
        if (!ERP.auth.can('pos.credit')) throw new Error('ليس لديك صلاحية البيع الآجل');
        const chk = ERP.crm.creditCheck(customer.id, due);
        if (!chk.ok) throw new Error(chk.reason);
      }
      const finalPays = pays.filter(p => !p.isCredit).map(p => ({ ...p, date: date || u.now() }));
      if (due > 0) finalPays.push({ method: 'credit', amount: due, isCredit: true, date: date || u.now() });
      const paid = u.round(c.total - due);
      const doc = {
        date: date || u.now(), type: 'sale',
        customerId: customer ? customer.id : null, customerName: customer ? customer.name : (customerName || s.posDefaultCustomer),
        items: c.items, subtotal: c.subtotal, discount: c.discount, invoiceDiscount: c.invoiceDiscount, discountType, discountInput: u.num(discount), promoDiscount: c.promoDiscount, promoLabels: c.promoLabels,
        tax: c.tax, taxRate: s.taxEnabled ? s.taxRate : 0, loyaltyDiscount: c.loyaltyDiscount, loyaltyPointsUsed: pts, total: c.total, paid, due, change,
        status: due <= 0 ? 'paid' : paid > 0 ? 'partial' : 'unpaid', payments: finalPays, cogs: c.cogs, profit: u.round(c.total - c.tax - c.cogs), deliveryFee: c.deliveryFee || 0, orderId,
        userId: user ? user.id : null, userName: user ? user.name : '', shiftId: shift ? shift.id : null, warehouseId: wh, notes, quotationId, returnedQty: {}, approvedBy: approvedBy ? { id: approvedBy.id, name: approvedBy.name } : (cart.find(i => i.approvedBy) || {}).approvedBy || null,
      };
      ERP.accounting.validate(ERP.accounting.saleLines({ ...doc, no: '' })); // the GL entry must balance before anything is written
      /* ---- 2) write ---- */
      const sale = SALES().insert({ no: ERP.db.nextSeq('sale', s.numbering.sale), ...doc });
      c.items.forEach(it => ERP.inventory.move({ productId: it.productId, warehouseId: wh, qty: -it.baseQty, type: 'sale', refType: 'sale', refId: sale.id, note: sale.no, silent: true, allowNegative: allowNeg }));
      ERP.bus.emit('db:change', { collection: 'products', op: 'bulk' });
      giftPays.forEach(p => ERP.giftcards.redeem(p.cardCode, p.amount, sale.no));
      if (customer) {
        if (due > 0) ERP.crm.adjustBalance(customer.id, due, { silent: true });
        if (pts) { const cc = ERP.crm.get(customer.id); ERP.db.collection('customers').update(cc.id, { loyaltyPoints: Math.max(0, u.num(cc.loyaltyPoints) - pts) }, { silent: true }); }
        const earned = ERP.crm.earnPoints(customer.id, c.total);
        SALES().update(sale.id, { loyaltyEarned: earned }, { silent: true });
        const cc = ERP.crm.get(customer.id);
        ERP.db.collection('customers').update(cc.id, { lastPurchaseAt: sale.date, purchaseCount: u.num(cc.purchaseCount) + 1, totalPurchases: u.round(u.num(cc.totalPurchases) + c.total) }, { silent: true });
        sale.loyaltyEarned = earned;
      }
      ERP.accounting.postSale(sale); // validated above — cannot fail silently
      ERP.shifts.recordSale(sale);
      if (quotationId) ERP.db.collection('quotations').update(quotationId, { status: 'converted', saleId: sale.id }, { silent: true });
      ERP.audit.log('sale.create', `${sale.no} — ${sale.customerName} — ${u.fmtMoney(sale.total)}${due ? ` (آجل ${u.fmtMoney(due)})` : ''}`, sale.id);
      ERP.bus.emit('sale:created', sale);
      return SALES().get(sale.id);
    },

    /** can this document be voided? (returns and invoices with returns/receipts cannot) */
    canVoid(s) { return !!s && s.type === 'sale' && s.status !== 'void' && !s.hasReturns && !(s.payments || []).some(p => p.receiptId); },

    /** return items from an invoice. lines: [{productId, qty}] ; refundMethod: 'cash'|'credit'|... */
    createReturn({ saleId, lines, refundMethod = 'cash', reason = '', approvedBy = null }) {
      const orig = SALES().get(saleId); if (!orig || orig.type !== 'sale') throw new Error('الفاتورة غير موجودة');
      if (orig.status === 'void') throw new Error('الفاتورة ملغاة');
      if (!ERP.auth.can('pos.return') && !approvedBy) throw new Error('ليس لديك صلاحية المرتجعات');
      const returned = { ...(orig.returnedQty || {}) };
      const items = [];
      (lines || []).forEach(l => {
        if (u.num(l.qty) < 0) throw new Error('كمية مرتجع سالبة غير مسموحة');
        // lines are matched per invoice line (product + unit); qty is in that line's unit — returnedQty key = ERP.units.lineKey
        const want = l.unitId || null;
        const it = orig.items.find(x => x.productId === l.productId && ERP.units.lineUnit(x) === want); if (!it) return;
        const key = ERP.units.lineKey(it);
        const already = u.num(returned[key]);
        const qty = u.round(Math.min(u.num(l.qty), it.qty - already), 3);
        if (qty <= 0) return;
        const ratio = qty / it.qty; const f = ERP.units.lineUnit(it) ? u.num(it.factor, 1) : 1;
        items.push({ ...it, qty, baseQty: u.round(qty * f, 3), discount: u.round(it.discount * ratio), taxAmount: u.round(it.taxAmount * ratio), total: u.round(it.total * ratio) });
        returned[key] = u.round(already + qty, 3);
      });
      if (!items.length) throw new Error('لا توجد كميات صالحة للإرجاع');
      // invoice-level discount / loyalty / VAT follow each returned line's own net value and tax
      const taxIncl = ERP.settings.get('taxInclusive');
      const afterLines = u.round(u.num(orig.subtotal) - (u.num(orig.discount) - u.num(orig.invoiceDiscount)));
      const retNet = u.round(u.sum(items, 'total'));
      const share = afterLines > 0 ? retNet / afterLines : 0;
      const discRatio = afterLines > 0 ? (afterLines - u.num(orig.invoiceDiscount)) / afterLines : 1;
      const subtotal = u.round(u.sum(items, it => it.qty * it.price));
      const discount = u.round(u.sum(items, 'discount') + u.num(orig.invoiceDiscount) * share + u.num(orig.loyaltyDiscount) * share);
      const tax = u.num(orig.tax) > 0 ? u.round(u.sum(items, 'taxAmount') * discRatio) : 0;
      const total = u.round(subtotal - discount + (taxIncl ? 0 : tax));
      const cogs = u.round(u.sum(items, it => it.cost * it.qty));
      // refund: if invoice had due, first reduce due (credit), rest refund by method
      let refundCredit = 0, refundCash = 0;
      if (orig.due > 0) { refundCredit = u.round(Math.min(total, orig.due)); }
      refundCash = u.round(total - refundCredit);
      const pays = [];
      if (refundCredit) pays.push({ method: 'credit', amount: refundCredit, isCredit: true });
      if (refundCash) pays.push({ method: refundMethod === 'credit' ? 'credit' : refundMethod, amount: refundCash, isCredit: refundMethod === 'credit' });
      if (refundMethod === 'credit' && refundCash && !orig.customerId) throw new Error('الرد على الحساب يتطلب فاتورة لعميل مسجل');
      const user = ERP.auth.current(); const shift = ERP.shifts.current();
      const doc = { date: u.now(), type: 'return', refSaleId: orig.id, refNo: orig.no, customerId: orig.customerId, customerName: orig.customerName, items, subtotal, discount, tax, total, paid: total, due: 0, status: 'paid', payments: pays, cogs, reason, userId: user?.id, userName: user?.name, shiftId: shift?.id || null, warehouseId: orig.warehouseId, approvedBy: approvedBy ? { id: approvedBy.id, name: approvedBy.name } : null };
      ERP.accounting.validate(ERP.accounting.saleReturnLines({ ...doc, no: '' })); // fail before writing
      const ret = SALES().insert({ no: ERP.db.nextSeq('return', ERP.settings.prefix('return')), ...doc });
      items.forEach(it => ERP.inventory.move({ productId: it.productId, warehouseId: orig.warehouseId, qty: it.baseQty, type: 'return_in', unitCost: u.num(it.cost) / (ERP.units.lineUnit(it) ? u.num(it.factor, 1) : 1), refType: 'sale_return', refId: ret.id, note: ret.no, silent: true }));
      ERP.bus.emit('db:change', { collection: 'products', op: 'bulk' });
      const allReturned = orig.items.every(it => u.num(returned[ERP.units.lineKey(it)]) >= it.qty - 0.0001);
      const newDue = u.round(orig.due - refundCredit);
      SALES().update(orig.id, { returnedQty: returned, due: newDue, status: allReturned ? 'returned' : (newDue <= 0 ? (orig.paid > 0 ? 'paid' : orig.status) : orig.status), hasReturns: true }, { silent: true });
      if (orig.customerId) {
        if (refundCredit) ERP.crm.adjustBalance(orig.customerId, -refundCredit, { silent: true });
        if (refundMethod === 'credit' && refundCash) ERP.crm.adjustBalance(orig.customerId, -refundCash, { silent: true });
        // claw back earned points proportionally
        if (orig.loyaltyEarned) { const c = ERP.crm.get(orig.customerId); const back = Math.round(orig.loyaltyEarned * share); if (c) ERP.db.collection('customers').update(c.id, { loyaltyPoints: Math.max(0, u.num(c.loyaltyPoints) - back) }, { silent: true }); }
      }
      ERP.accounting.postSaleReturn(ret);
      ERP.shifts.recordSale(ret);
      ERP.audit.log('sale.return', `${ret.no} من ${orig.no} — ${u.fmtMoney(total)} — ${reason}`, ret.id);
      ERP.bus.emit('sale:returned', ret);
      return ret;
    },

    void(saleId, reason = '', approvedBy = null) {
      const s = SALES().get(saleId); if (!s) throw new Error('الفاتورة غير موجودة');
      if (s.status === 'void') return s;
      if (!ERP.auth.can('pos.void') && !approvedBy) throw new Error('ليس لديك صلاحية إلغاء الفواتير');
      if (s.type === 'return') throw new Error('لا يمكن إلغاء مستند مرتجع — أنشئ فاتورة بيع جديدة بدلاً منه');
      if (s.hasReturns) throw new Error('لا يمكن إلغاء فاتورة عليها مرتجعات');
      if ((s.payments || []).some(p => p.receiptId)) throw new Error('لا يمكن إلغاء فاتورة عليها تحصيلات — احذف سند التحصيل أولاً');
      if (s.type === 'sale') {
        s.items.forEach(it => { const f = ERP.units.lineUnit(it) ? u.num(it.factor, 1) : 1; ERP.inventory.move({ productId: it.productId, warehouseId: s.warehouseId, qty: u.round(it.qty * f, 3), type: 'return_in', unitCost: u.num(it.cost) / f, refType: 'void', refId: s.id, note: `إلغاء ${s.no}`, silent: true }); });
        const c = s.customerId ? ERP.crm.get(s.customerId) : null;
        if (c) {
          if (s.due > 0) ERP.crm.adjustBalance(c.id, -s.due, { silent: true });
          // points: take back earned, give back redeemed; undo purchase counters
          const cc = ERP.crm.get(c.id);
          ERP.db.collection('customers').update(c.id, { loyaltyPoints: Math.max(0, u.num(cc.loyaltyPoints) - u.num(s.loyaltyEarned) + u.num(s.loyaltyPointsUsed)), lifetimePoints: Math.max(0, u.num(cc.lifetimePoints) - u.num(s.loyaltyEarned)), purchaseCount: Math.max(0, u.num(cc.purchaseCount) - 1), totalPurchases: u.round(Math.max(0, u.num(cc.totalPurchases) - s.total)) }, { silent: true });
        }
        (s.payments || []).filter(p => p.isGift && p.cardCode).forEach(p => ERP.giftcards && ERP.giftcards.refund(p.cardCode, p.amount, 'إلغاء ' + s.no));
        ERP.accounting.unpost('sale', s.id);
        ERP.shifts.unrecordSale(s); // reverse cash/card/other effect on the (open) shift
      }
      ERP.bus.emit('db:change', { collection: 'products', op: 'bulk' });
      const v = SALES().update(saleId, { status: 'void', voidReason: reason, voidedAt: u.now(), voidedBy: ERP.auth.current()?.id, voidApprovedBy: approvedBy ? approvedBy.name : null, due: 0 });
      ERP.audit.log('sale.void', `${s.no} — ${reason}`, s.id);
      return v;
    },

    /** record a payment against a specific invoice */
    addPayment(saleId, amount, method = 'cash', notes = '') {
      const s = SALES().get(saleId); if (!s || s.due <= 0) throw new Error('لا يوجد مبلغ مستحق');
      if (!s.customerId) throw new Error('الفاتورة بدون عميل');
      return ERP.crm.receivePayment({ customerId: s.customerId, amount: Math.min(u.num(amount), s.due), method, notes: notes || `سداد فاتورة ${s.no}`, saleId });
    },

    /* ---- held carts ---- */
    hold(cart, meta = {}) { return ERP.db.collection('heldCarts').insert({ cart, ...meta, userId: ERP.auth.current()?.id, at: u.now() }); },
    held() { return ERP.db.collection('heldCarts').all(); },
    releaseHeld(id) { return ERP.db.collection('heldCarts').remove(id); },

    /* ---- quotations ---- */
    qlist() { return ERP.db.collection('quotations').all(); },
    qget(id) { return ERP.db.collection('quotations').get(id); },
    createQuotation({ cart, customerId, customerName, discount = 0, discountType = 'fixed', notes = '', validDays = null }) {
      if (!cart || !cart.length) throw new Error('العرض بدون أصناف');
      const s = ERP.settings.all(); const vd = u.num(validDays, s.quoteValidityDays);
      const c = compute(cart, { discount, discountType, applyPromos: false });
      const cust = customerId ? ERP.crm.get(customerId) : null;
      const q = ERP.db.collection('quotations').insert({ no: ERP.db.nextSeq('quotation', s.numbering.quotation), date: u.now(), validUntil: u.toISODate(u.addDays(new Date(), vd)), customerId, customerName: cust ? cust.name : customerName || '', items: c.items, subtotal: c.subtotal, discount: c.discount, discountInput: u.num(discount), discountType, tax: c.tax, total: c.total, notes, status: 'open', userId: ERP.auth.current()?.id });
      ERP.audit.log('quotation.create', `${q.no} — ${u.fmtMoney(q.total)}`, q.id);
      return ERP.db.collection('quotations').get(q.id);
    },
    updateQuotation(id, patch) {
      const q = ERP.db.collection('quotations').update(id, patch);
      ERP.audit.log('quotation.update', `${q.no}`, id);
      return q;
    },
    removeQuotation(id) {
      const q = ERP.db.collection('quotations').get(id);
      ERP.db.collection('quotations').remove(id);
      ERP.audit.log('quotation.delete', q ? q.no : id, id);
      return q;
    },
    /** turn an accepted quotation into a paid invoice (items/qty/price/discount preserved) */
    convertQuotation(id, { date = null } = {}) {
      const q = ERP.db.collection('quotations').get(id); if (!q) throw new Error('عرض السعر غير موجود');
      if (q.status === 'converted') throw new Error('تم تحويل عرض السعر إلى فاتورة من قبل');
      const s = sales.create({
        cart: q.items.map(it => ({ productId: it.productId, name: it.name, qty: it.qty, price: it.price, discount: it.discount, taxRate: it.taxRate })), applyPromos: false, // same engine settings as the quotation → identical totals
        customerId: q.customerId, customerName: q.customerName || '', payments: [{ method: ERP.settings.get('defaultPaymentMethod') || 'cash', amount: q.total }],
        discount: q.discountInput || 0, discountType: q.discountType || 'fixed', notes: q.notes || '', date, quotationId: q.id,
      });
      ERP.audit.log('quotation.convert', `${q.no} → ${s.no}`, q.id);
      return s;
    },

    /* ---- queries ---- */
    range(from, to, { type = 'sale', includeVoid = false } = {}) { return SALES().all().filter(s => (!type || s.type === type) && (includeVoid || s.status !== 'void') && u.inRange(s.date, from, to)); },
    today() { const t = u.todayISO(); return sales.range(t, t); },
    unpaid() { return SALES().all().filter(s => s.type === 'sale' && s.due > 0 && s.status !== 'void'); },
    customerHistory(customerId) { return u.sortBy(SALES().where({ customerId }), 'date', 'desc'); },
    productHistory(productId, n = 50) { return u.sortBy(SALES().all().filter(s => s.status !== 'void' && s.items.some(i => i.productId === productId)), 'date', 'desc').slice(0, n); },
  };
  ERP.sales = sales;
  ERP.pos = sales; // alias used by print templates
})();
