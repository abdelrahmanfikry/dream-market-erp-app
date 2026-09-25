/* ==========================================================================
   ERP.backup — export/import (JSON, Excel), auto-backup, cloud sync (Firebase)
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  const u = ERP.utils;
  const SNAP_KEY = 'dm_erp:__autobackup';

  const backup = {
    filename(ext = 'json') { return `dream-market-backup-${u.todayISO()}-${new Date().toTimeString().slice(0, 5).replace(':', '')}.${ext}`; },
    exportJSON(names) {
      const snap = ERP.db.export(names);
      u.downloadJSON(snap, backup.filename('json'));
      ERP.settings.set({ lastManualBackup: u.now() });
      ERP.audit.log('backup.export', names ? names.join(',') : 'كامل');
      return snap;
    },
    exportExcel() {
      if (typeof XLSX === 'undefined') throw new Error('مكتبة Excel غير متاحة');
      const wb = XLSX.utils.book_new(); wb.Workbook = { Views: [{ RTL: true }] };
      const add = (name, rows) => { if (!rows.length) return; const ws = XLSX.utils.json_to_sheet(rows); XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31)); };
      const cats = ERP.db.collection('categories').map(), sups = ERP.db.collection('suppliers').map();
      add('المنتجات', ERP.db.collection('products').all().map(p => ({ 'الكود': p.code, 'الباركود': p.barcode, 'الاسم': p.name, 'الفئة': cats[p.categoryId]?.name || '', 'المورد': sups[p.supplierId]?.name || '', 'التكلفة': p.cost, 'السعر': p.price, 'المخزون': p.stock, 'الحد الأدنى': p.minStock })));
      add('المبيعات', ERP.db.collection('sales').all().map(s => ({ 'الرقم': s.no, 'النوع': s.type, 'التاريخ': u.fmtDateTime(s.date), 'العميل': s.customerName, 'الإجمالي': s.subtotal, 'الخصم': s.discount, 'الضريبة': s.tax, 'الصافي': s.total, 'المدفوع': s.paid, 'المتبقي': s.due, 'الحالة': s.status, 'الكاشير': s.userName })));
      add('بنود المبيعات', ERP.db.collection('sales').all().flatMap(s => s.items.map(it => ({ 'الفاتورة': s.no, 'التاريخ': u.fmtDate(s.date), 'الصنف': it.name, 'الكمية': it.qty, 'السعر': it.price, 'الخصم': it.discount, 'الإجمالي': it.total, 'التكلفة': it.cost }))));
      add('العملاء', ERP.db.collection('customers').all().map(c => ({ 'الكود': c.code, 'الاسم': c.name, 'الهاتف': c.phone, 'العنوان': c.address, 'الرصيد': c.balance, 'حد الائتمان': c.creditLimit, 'النقاط': c.loyaltyPoints, 'المجموعة': c.group })));
      add('الموردين', ERP.db.collection('suppliers').all().map(s => ({ 'الكود': s.code, 'الاسم': s.name, 'الهاتف': s.phone, 'الرصيد': s.balance })));
      add('المشتريات', ERP.db.collection('purchases').all().map(p => ({ 'الرقم': p.no, 'التاريخ': u.fmtDate(p.date), 'المورد': p.supplierName, 'الإجمالي': p.total, 'المدفوع': p.paid, 'المتبقي': p.due, 'الحالة': p.status })));
      add('المصروفات', ERP.db.collection('expenses').all().map(e => ({ 'الرقم': e.no, 'التاريخ': u.fmtDate(e.date), 'البند': e.title, 'الفئة': e.categoryName, 'المبلغ': e.amount, 'الطريقة': e.method })));
      add('التحصيلات والمدفوعات', ERP.db.collection('payments').all().map(p => ({ 'الرقم': p.no, 'التاريخ': u.fmtDate(p.date), 'النوع': p.type === 'receipt' ? 'تحصيل' : 'سداد', 'الطرف': p.partyName, 'المبلغ': p.amount, 'الطريقة': p.method })));
      add('حركات المخزون', ERP.db.collection('stockMoves').all().map(m => ({ 'التاريخ': u.fmtDateTime(m.date), 'الصنف': m.productName, 'النوع': m.type, 'الكمية': m.qty, 'التكلفة': m.unitCost, 'الرصيد بعد': m.balanceAfter, 'ملاحظة': m.note })));
      add('القيود', ERP.db.collection('journal').all().flatMap(j => j.lines.map(l => ({ 'القيد': j.no, 'التاريخ': u.fmtDate(j.date), 'البيان': j.memo, 'الحساب': (ERP.accounting.get(l.accountId) || {}).name, 'مدين': l.debit, 'دائن': l.credit }))));
      XLSX.writeFile(wb, backup.filename('xlsx'));
      ERP.audit.log('backup.export', 'Excel');
    },
    async importFile(file, { mode = 'replace' } = {}) {
      const text = await u.readFile(file);
      let snap;
      try { snap = JSON.parse(text); } catch { throw new Error('الملف ليس بصيغة JSON صحيحة'); }
      if (!snap.collections) {
        // legacy v1 export? {products, sales, debts}
        if (snap.products || snap.sales || snap.debts) { ['products', 'sales', 'debts'].forEach(k => { if (snap[k]) localStorage.setItem(k, JSON.stringify(snap[k])); }); ERP.db.setMeta('legacyMigrated', null); const st = ERP.migrate.run(); ERP.audit.log('backup.restore', 'استيراد ملف النظام القديم'); return { legacy: true, stats: st }; }
        throw new Error('صيغة الملف غير معروفة');
      }
      await backup.snapshotLocal('pre-restore');
      await ERP.db.import(snap, { mode });
      ERP.settings.load();
      ERP.audit.log('backup.restore', `${mode} — ${Object.keys(snap.collections).length} جدول`);
      return { legacy: false, cols: Object.keys(snap.collections).length };
    },
    /** keep one rolling in-browser snapshot for emergency recovery (stored in IndexedDB kv; tiny marker in localStorage for sync display) */
    async snapshotLocal(reason = 'auto') {
      try { const meta = { at: u.now(), reason }; await ERP.db.kvSet('snapshot', { ...meta, snap: ERP.db.export() }); localStorage.setItem(SNAP_KEY, JSON.stringify(meta)); return true; } catch (e) { console.warn('snapshot failed', e); return false; }
    },
    /** sync: when/why the last snapshot was taken */
    localSnapshotMeta() { try { const r = localStorage.getItem(SNAP_KEY); return r ? JSON.parse(r) : null; } catch { return null; } },
    async localSnapshot() { try { return await ERP.db.kvGet('snapshot'); } catch { return null; } },
    async restoreLocalSnapshot() { const s = await backup.localSnapshot(); if (!s || !s.snap) throw new Error('لا توجد نسخة محلية'); await ERP.db.import(s.snap, { mode: 'replace' }); ERP.settings.load(); ERP.audit.log('backup.restore', 'استعادة النسخة المحلية'); },
    /** auto backup: download a file if period elapsed */
    checkAuto() {
      const s = ERP.settings.all(); if (!s.autoBackup) return;
      const last = s.lastAutoBackup ? u.parseDate(s.lastAutoBackup) : null;
      const days = { daily: 1, weekly: 7, monthly: 30 }[s.autoBackupPeriod] || 1;
      if (!last || u.daysBetween(last, new Date()) >= days) {
        backup.snapshotLocal('auto');
        ERP.settings.set({ lastAutoBackup: u.now() });
        ERP.ui.toast('تم إنشاء نسخة احتياطية تلقائية داخل المتصفح. يُنصح بتنزيل نسخة خارجية أيضاً.', 'info', { title: 'نسخة احتياطية', duration: 6000, action: { label: 'تنزيل الآن', onClick: () => backup.exportJSON() } });
      }
    },
    /** import products from Excel/CSV rows */
    async importProducts(file) {
      if (typeof XLSX === 'undefined') throw new Error('مكتبة Excel غير متاحة');
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
      const pick = (r, ...keys) => { for (const k of keys) { const kk = Object.keys(r).find(x => u.normalizeAr(x) === u.normalizeAr(k)); if (kk !== undefined) return r[kk]; } return undefined; };
      const cats = ERP.db.collection('categories'); const P = ERP.db.collection('products');
      let added = 0, updated = 0, stockValue = 0;
      rows.forEach(r => {
        const name = pick(r, 'الاسم', 'اسم المنتج', 'name'); if (!name) return;
        const code = String(pick(r, 'الكود', 'code') || '').trim();
        const barcode = String(pick(r, 'الباركود', 'barcode') || '').trim();
        const catName = pick(r, 'الفئة', 'category');
        let cat = catName ? cats.first({ name: String(catName) }) : null;
        if (catName && !cat) cat = cats.insert({ name: String(catName), icon: 'tag', color: '#64748b' });
        const data = { name: String(name).trim(), barcode, categoryId: cat ? cat.id : 'cat_other', cost: u.num(pick(r, 'التكلفة', 'cost')), price: u.num(pick(r, 'السعر', 'price')), minStock: u.num(pick(r, 'الحد الأدنى', 'minStock'), 5) };
        const ex = (code && P.first({ code })) || (barcode && P.first({ barcode })) || P.first({ name: data.name });
        if (ex) { P.update(ex.id, data, { silent: true }); updated++; }
        else { const stock = u.num(pick(r, 'المخزون', 'الكمية', 'stock')); const np = P.insert({ ...data, code: code || ERP.db.nextSeq('PRD', 'PRD', 5), unitId: 'un_pc', stock: 0, stockByWh: {}, batches: [], active: true, taxRate: 0 }, { silent: true }); if (stock) { const mv = ERP.inventory.move({ productId: np.id, qty: stock, type: 'opening', unitCost: data.cost, refType: 'import', note: 'استيراد Excel', silent: true }); stockValue += mv ? u.num(mv.value) : 0; } added++; }
      });
      if (u.round(stockValue)) ERP.accounting.postOpeningStock(u.round(stockValue)); // imported opening quantities must reach GL inventory (GL = valuation)
      ERP.bus.emit('db:change', { collection: 'products', op: 'bulk' });
      ERP.audit.log('product.create', `استيراد Excel: ${added} جديد، ${updated} محدث`);
      return { added, updated };
    },
  };
  ERP.backup = backup;
})();
