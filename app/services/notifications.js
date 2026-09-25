/* ==========================================================================
   ERP.notifications — alert center (low stock, expiry, overdue debts, POs…)
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  const u = ERP.utils;
  const N = () => ERP.db.collection('notifications');
  const MAX = 300;

  const notif = {
    all() { return u.sortBy(N().all(), 'at', 'desc'); },
    unread() { return N().all().filter(n => !n.read); },
    unreadCount() { return notif.unread().length; },
    push({ type = 'info', title, text = '', link = null, key = null, params = null }) {
      // dedupe by key within 24h
      if (key) { const ex = N().all().find(n => n.key === key && u.daysBetween(n.at, new Date()) < 1); if (ex) return ex; }
      const n = N().insert({ type, title, text, link, params, key, read: false, at: u.now() }, { silent: true });
      const all = N().all(); if (all.length > MAX) { const sorted = u.sortBy(all, 'at'); N().replaceAll(sorted.slice(all.length - MAX)); }
      ERP.bus.emit('notif:new', n);
      return n;
    },
    markRead(id) { N().update(id, { read: true }, { silent: true }); ERP.bus.emit('notif:change'); },
    markAllRead() { N().all().forEach(n => { n.read = true; }); N().replaceAll(N().all()); ERP.bus.emit('notif:change'); },
    clear() { N().clear(); ERP.bus.emit('notif:change'); },
    remove(id) { N().remove(id, { silent: true }); ERP.bus.emit('notif:change'); },

    /** scan the system and generate alerts (runs at boot & periodically) */
    scan() {
      const today = u.todayISO();
      const low = ERP.inventory.lowStock();
      const out = ERP.inventory.outOfStock();
      if (out.length) notif.push({ type: 'danger', title: `${out.length} منتج نفذ من المخزون`, text: out.slice(0, 3).map(p => p.name).join('، ') + (out.length > 3 ? '…' : ''), link: 'inventory', params: { filter: 'out' }, key: 'out_' + today });
      const lowOnly = low.filter(p => u.num(p.stock) > 0);
      if (lowOnly.length) notif.push({ type: 'warning', title: `${lowOnly.length} منتج منخفض المخزون`, text: lowOnly.slice(0, 3).map(p => `${p.name} (${u.fmtQty(p.stock)})`).join('، '), link: 'inventory', params: { filter: 'low' }, key: 'low_' + today });
      const exp = ERP.inventory.expiring();
      const expired = exp.filter(e => e.expired);
      if (expired.length) notif.push({ type: 'danger', title: `${expired.length} دفعة منتهية الصلاحية`, text: expired.slice(0, 3).map(e => e.product.name).join('، '), link: 'inventory', params: { tab: 'expiry' }, key: 'expired_' + today });
      const soon = exp.filter(e => !e.expired);
      if (soon.length) notif.push({ type: 'warning', title: `${soon.length} دفعة تقترب من انتهاء الصلاحية`, text: soon.slice(0, 3).map(e => `${e.product.name} (${e.daysLeft} يوم)`).join('، '), link: 'inventory', params: { tab: 'expiry' }, key: 'expiring_' + today });
      const overdue = ERP.crm.overdue();
      if (overdue.length) notif.push({ type: 'warning', title: `${overdue.length} عميل متأخر في السداد`, text: overdue.slice(0, 3).map(o => `${o.customer.name} (${u.fmtMoney(o.customer.balance)})`).join('، '), link: 'customers', params: { filter: 'overdue' }, key: 'overdue_' + today });
      const latePO = ERP.purchasing.orders().filter(p => p.status === 'ordered' && p.expectedDate && p.expectedDate < today);
      if (latePO.length) notif.push({ type: 'info', title: `${latePO.length} أمر شراء متأخر عن موعد التوريد`, text: latePO.slice(0, 3).map(p => `${p.no} — ${p.supplierName}`).join('، '), link: 'purchases', key: 'latepo_' + today });
      const dueAP = ERP.purchasing.suppliers().filter(s => u.num(s.balance) > 0);
      if (dueAP.length) notif.push({ type: 'info', title: `مستحقات موردين: ${u.fmtMoney(u.sum(dueAP, 'balance'))}`, text: `${dueAP.length} مورد`, link: 'suppliers', key: 'ap_' + today });
      const openShifts = ERP.shifts.anyOpen().filter(s => u.daysBetween(s.openedAt, new Date()) >= 1);
      if (openShifts.length) notif.push({ type: 'warning', title: 'وردية مفتوحة منذ أكثر من يوم', text: openShifts.map(s => `${s.no} — ${s.userName}`).join('، '), link: 'shifts', key: 'shift_' + today });
      const usage = ERP.db.usage();
      if (usage.pct > 80) notif.push({ type: 'danger', title: 'مساحة التخزين المحلية تقترب من الامتلاء', text: `${usage.kb} KB (${usage.pct}%) — قم بنسخة احتياطية`, link: 'backup', key: 'storage_' + today });
      if (ERP.assets) { const pd = ERP.assets.pending(); if (pd.length) notif.push({ type: 'info', title: `إهلاك ${pd.length} أصل لم يُسجَّل لهذا الشهر`, text: 'شغّل «إهلاك الشهر» من صفحة الأصول الثابتة', link: 'assets', key: 'dep_' + u.monthKey(new Date()) }); }
      const admin = ERP.db.collection('users').get('u_admin');
      if (admin && admin.mustChangePin) notif.push({ type: 'danger', title: 'غيّر رمز الدخول الافتراضي للمدير', text: 'الرمز الافتراضي 1234 غير آمن', link: 'users', key: 'pin_default' });
      ERP.bus.emit('notif:change');
    },
  };
  ERP.notifications = notif;
})();
