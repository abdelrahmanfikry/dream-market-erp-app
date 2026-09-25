/* ==========================================================================
   ERP.audit — immutable activity log of who did what
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  const u = ERP.utils;
  const MAX = 5000;
  const TRIM_SLACK = 200; // trim only every ~200 entries (removeWhere is O(n))
  const LABELS = {
    'auth.login': 'تسجيل دخول', 'auth.logout': 'تسجيل خروج', 'auth.failed': 'محاولة دخول فاشلة', 'auth.pin_changed': 'تغيير رمز الدخول',
    'sale.create': 'إنشاء فاتورة بيع', 'sale.return': 'مرتجع بيع', 'sale.void': 'إلغاء فاتورة', 'sale.payment': 'تحصيل دفعة',
    'product.create': 'إضافة منتج', 'product.update': 'تعديل منتج', 'product.delete': 'حذف منتج', 'product.price': 'تغيير سعر',
    'stock.adjust': 'تسوية مخزون', 'stock.transfer': 'تحويل مخزون', 'stock.count': 'جرد مخزون', 'stock.waste': 'هالك',
    'purchase.create': 'أمر شراء', 'purchase.receive': 'استلام بضاعة', 'purchase.pay': 'سداد مورد', 'purchase.cancel': 'إلغاء أمر شراء', 'purchase.return': 'مرتجع شراء',
    'customer.create': 'إضافة عميل', 'customer.update': 'تعديل عميل', 'customer.delete': 'حذف عميل', 'customer.receipt': 'تحصيل من عميل',
    'supplier.create': 'إضافة مورد', 'supplier.update': 'تعديل مورد', 'supplier.delete': 'حذف مورد',
    'expense.create': 'تسجيل مصروف', 'expense.delete': 'حذف مصروف',
    'journal.post': 'قيد يومية', 'journal.delete': 'حذف قيد',
    'shift.open': 'فتح وردية', 'shift.close': 'إغلاق وردية', 'cash.in': 'إيداع نقدي', 'cash.out': 'سحب نقدي',
    'user.create': 'إضافة مستخدم', 'user.update': 'تعديل مستخدم', 'user.delete': 'حذف مستخدم', 'role.update': 'تعديل صلاحيات',
    'settings.update': 'تعديل الإعدادات', 'backup.export': 'تصدير نسخة احتياطية', 'backup.restore': 'استعادة نسخة احتياطية', 'data.reset': 'مسح البيانات',
    'hr.employee': 'بيانات موظف', 'hr.attendance': 'حضور وانصراف', 'hr.payroll': 'مرتبات', 'hr.advance': 'سلفة',
    'promo.update': 'عروض وخصومات',
    'quotation.create': 'عرض سعر جديد', 'quotation.update': 'تعديل عرض سعر', 'quotation.delete': 'حذف عرض سعر', 'quotation.convert': 'تحويل عرض سعر إلى فاتورة', 'quotation.confirm': 'تأكيد عرض سعر',
  };
  ERP.audit = {
    LABELS,
    log(action, details = '', ref = null) {
      const user = ERP.auth && ERP.auth.current ? ERP.auth.current() : null;
      const col = ERP.db.collection('auditLog');
      const entry = col.insert({
        action, details: typeof details === 'string' ? details : JSON.stringify(details), ref,
        userId: user ? user.id : null, userName: user ? user.name : 'النظام',
        at: u.now(), ua: navigator.userAgent.slice(0, 80),
      }, { silent: true });
      // keep bounded — trim in batches through the db API so rows also leave IndexedDB and the id index stays valid
      const all = col.all();
      if (all.length > MAX + TRIM_SLACK) { const old = new Set(u.sortBy(all, 'at').slice(0, all.length - MAX).map(x => x.id)); col.removeWhere(x => old.has(x.id), { silent: true }); }
      ERP.bus.emit('audit:new', entry);
      return entry;
    },
    label(action) { return LABELS[action] || action; },
    recent(n = 50) { return ERP.db.collection('auditLog').latest(n, 'at'); },
    byUser(userId, n = 100) { return u.sortBy(ERP.db.collection('auditLog').where({ userId }), 'at', 'desc').slice(0, n); },
  };
})();
