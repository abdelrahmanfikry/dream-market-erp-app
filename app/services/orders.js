/* ==========================================================================
   ERP.orders — customer orders & delivery (new → preparing → out → delivered)
   Delivery converts the order into a regular sale (stock, GL, shift).
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  const u = ERP.utils;
  const O = () => ERP.db.collection('orders');
  const STATUS = { new: 'جديد', preparing: 'قيد التجهيز', ready: 'جاهز', out: 'خرج للتوصيل', delivered: 'تم التوصيل', cancelled: 'ملغي' };
  const FLOW = ['new', 'preparing', 'ready', 'out', 'delivered'];

  function calc(items, discount = 0, deliveryFee = 0) {
    const c = ERP.sales.compute(items, { discount, applyPromos: false });
    return { items: c.items, subtotal: c.subtotal, discount: c.discount, tax: c.tax, total: c.total, deliveryFee: u.num(deliveryFee), grand: u.round(c.total + u.num(deliveryFee)) };
  }

  const orders = {
    STATUS, FLOW,
    all() { return u.sortBy(O().all(), 'date', 'desc'); },
    get(id) { return O().get(id); },
    open() { return O().all().filter(o => !['delivered', 'cancelled'].includes(o.status)); },
    create({ customerId = null, customerName = '', phone = '', address = '', items, discount = 0, deliveryFee = 0, notes = '', scheduledAt = null, driverId = null, source = 'phone' }) {
      if (!items || !items.length) throw new Error('أضف أصنافاً للطلب');
      const cust = customerId ? ERP.crm.get(customerId) : null;
      const c = calc(items, discount, deliveryFee);
      const o = O().insert({ no: ERP.db.nextSeq('order', 'ORD'), date: u.now(), status: 'new', customerId: cust ? cust.id : null, customerName: cust ? cust.name : (customerName || 'عميل'), phone: phone || (cust ? cust.phone : ''), address: address || (cust ? cust.address : ''), ...c, discountInput: u.num(discount), notes, scheduledAt, driverId, source, userId: ERP.auth.current()?.id, history: [{ at: u.now(), status: 'new', by: ERP.auth.current()?.name }] });
      ERP.audit.log('order.create', `${o.no} — ${o.customerName} — ${u.fmtMoney(o.grand)}`, o.id);
      return o;
    },
    update(id, { items, discount, deliveryFee, notes, address, phone, scheduledAt, driverId, customerName }) {
      const o = O().get(id); if (!o) throw new Error('الطلب غير موجود');
      if (['delivered', 'cancelled'].includes(o.status)) throw new Error('لا يمكن تعديل طلب منتهٍ');
      const c = calc(items || o.items, discount ?? o.discountInput, deliveryFee ?? o.deliveryFee);
      return O().update(id, { ...c, discountInput: u.num(discount ?? o.discountInput), notes: notes ?? o.notes, address: address ?? o.address, phone: phone ?? o.phone, scheduledAt: scheduledAt ?? o.scheduledAt, driverId: driverId ?? o.driverId, customerName: customerName ?? o.customerName });
    },
    setStatus(id, status, extra = {}) {
      const o = O().get(id); if (!o) throw new Error('الطلب غير موجود');
      if (!STATUS[status]) throw new Error('حالة غير معروفة');
      if (['delivered', 'cancelled'].includes(o.status)) throw new Error('الطلب منتهٍ');
      const upd = O().update(id, { status, ...extra, history: [...(o.history || []), { at: u.now(), status, by: ERP.auth.current()?.name }] });
      ERP.audit.log('order.status', `${o.no} → ${STATUS[status]}`, id);
      return upd;
    },
    /** deliver: creates the sale (stock out, GL, shift) and closes the order */
    deliver(id, { payments = [], collectedBy = null } = {}) {
      const o = O().get(id); if (!o) throw new Error('الطلب غير موجود');
      if (o.status === 'delivered') throw new Error('تم توصيل الطلب بالفعل');
      if (o.status === 'cancelled') throw new Error('الطلب ملغي');
      const pays = payments.length ? payments : [{ method: o.customerId ? 'credit' : 'cash', amount: o.grand }];
      const sale = ERP.sales.create({ cart: o.items.map(it => ({ productId: it.productId, name: it.name, qty: it.qty, price: it.price, discount: it.discount, taxRate: it.taxRate })), applyPromos: false, customerId: o.customerId, customerName: o.customerName, payments: pays, discount: o.discountInput, deliveryFee: o.deliveryFee, notes: `طلب توصيل ${o.no}${o.address ? ' — ' + o.address : ''}`, orderId: o.id });
      const upd = O().update(id, { status: 'delivered', saleId: sale.id, saleNo: sale.no, deliveredAt: u.now(), collectedBy, history: [...(o.history || []), { at: u.now(), status: 'delivered', by: ERP.auth.current()?.name }] });
      ERP.audit.log('order.status', `${o.no} تم التوصيل → فاتورة ${sale.no}`, id);
      return { order: upd, sale };
    },
    cancel(id, reason = '') { return orders.setStatus(id, 'cancelled', { cancelReason: reason }); },
    /** WhatsApp text summary for the customer */
    message(o) {
      const s = ERP.settings.all();
      return `طلبك من ${s.storeName} رقم ${o.no}\n${o.items.map(it => `• ${it.name} × ${u.fmtQty(it.qty)} = ${u.fmtNum(it.total)}`).join('\n')}\n${o.deliveryFee ? `رسوم التوصيل: ${u.fmtNum(o.deliveryFee)}\n` : ''}الإجمالي: ${u.fmtMoney(o.grand)}\nالحالة: ${STATUS[o.status]}${o.address ? '\nالعنوان: ' + o.address : ''}\nشكراً لك 🌟`;
    },
    stats() { const all = O().all(); const today = u.todayISO(); return { open: orders.open().length, out: all.filter(o => o.status === 'out').length, today: all.filter(o => u.inRange(o.date, today, today)).length, todayValue: u.sum(all.filter(o => u.inRange(o.date, today, today) && o.status !== 'cancelled'), 'grand'), delivered: all.filter(o => o.status === 'delivered').length, cancelled: all.filter(o => o.status === 'cancelled').length, avgMinutes: (() => { const d = all.filter(o => o.deliveredAt); return d.length ? Math.round(u.sum(d, o => (u.parseDate(o.deliveredAt) - u.parseDate(o.date)) / 60000) / d.length) : 0; })() }; },
  };
  ERP.orders = orders;
  ERP.audit.LABELS['order.create'] = 'طلب توصيل جديد'; ERP.audit.LABELS['order.status'] = 'تغيير حالة طلب';
})();
