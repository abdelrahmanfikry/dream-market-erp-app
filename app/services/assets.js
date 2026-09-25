/* ==========================================================================
   ERP.assets — fixed assets register & straight-line monthly depreciation
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  const u = ERP.utils;
  const A = () => ERP.db.collection('assets');
  const CATS = ['ثلاجات وتبريد', 'أرفف وعرض', 'أجهزة كاشير وكمبيوتر', 'أثاث', 'سيارات ونقل', 'مباني وتشطيبات', 'أخرى'];

  function monthlyDep(a) { return u.round(Math.max(0, u.num(a.cost) - u.num(a.salvage)) / Math.max(1, u.num(a.lifeMonths)), 2); }
  function nextMonth(key) { const [y, m] = key.split('-').map(Number); const d = new Date(y, m, 1); return u.monthKey(d); }

  const assets = {
    CATS, monthlyDep,
    all() { return A().all(); },
    get(id) { return A().get(id); },
    active() { return A().all().filter(a => a.status === 'active'); },
    create(d) {
      if (!d.name) throw new Error('اسم الأصل مطلوب');
      const cost = u.num(d.cost); if (cost <= 0) throw new Error('التكلفة غير صالحة');
      const a = A().insert({ code: ERP.db.nextSeq('AST', 'AST', 4), name: d.name.trim(), category: d.category || 'أخرى', purchaseDate: d.purchaseDate || u.todayISO(), cost, salvage: u.num(d.salvage), lifeMonths: Math.max(1, u.num(d.lifeMonths, 60)), accumulated: 0, bookValue: cost, status: 'active', lastDepMonth: d.startMonth || u.monthKey(d.purchaseDate || new Date()), supplierId: d.supplierId || null, serial: d.serial || '', location: d.location || '', notes: d.notes || '', method: 'straight', payMethod: d.payMethod || 'cash' });
      // acquisition entry: Dr fixed assets / Cr cash|bank|AP
      const credit = d.payMethod === 'credit' ? { sys: 'ap', credit: cost, desc: 'مورد الأصل' } : d.payMethod === 'opening' ? { sys: 'opening', credit: cost, desc: 'رصيد افتتاحي' } : { accountId: ERP.accounting.methodAccount(d.payMethod || 'cash').id, credit: cost, desc: 'شراء أصل' };
      ERP.accounting.post({ date: new Date(a.purchaseDate + 'T12:00:00').toISOString(), memo: `شراء أصل ثابت: ${a.name}`, refType: 'asset', refId: a.id, lines: [{ sys: 'fixed_assets', debit: cost, desc: a.name }, credit] });
      if (d.payMethod === 'credit' && d.supplierId) ERP.purchasing.adjustSupplierBalance(d.supplierId, cost);
      ERP.audit.log('asset.create', `${a.name} — ${u.fmtMoney(cost)}`, a.id);
      return a;
    },
    update(id, patch) { return A().update(id, patch); },
    /** post depreciation for every active asset up to and including `month` (YYYY-MM). Returns number of entries. */
    runDepreciation(month = u.monthKey(new Date())) {
      let n = 0, total = 0;
      assets.active().forEach(a => {
        let m = a.lastDepMonth || u.monthKey(a.purchaseDate);
        let acc = u.num(a.accumulated), book = u.num(a.bookValue);
        const dep = monthlyDep(a);
        const lines = [];
        while (m < month && book - u.num(a.salvage) > 0.009) {
          m = nextMonth(m);
          const amt = Math.min(dep, u.round(book - u.num(a.salvage)));
          if (amt <= 0) break;
          acc = u.round(acc + amt); book = u.round(book - amt); total += amt; n++;
          ERP.accounting.post({ date: new Date(m + '-28T12:00:00').toISOString(), memo: `إهلاك ${a.name} — ${u.fmtMonth(m + '-01')}`, refType: 'depreciation', refId: a.id, lines: [{ sys: 'depreciation', debit: amt, desc: a.name }, { sys: 'acc_dep', credit: amt, desc: a.name }] });
          lines.push({ month: m, amount: amt });
        }
        if (lines.length) A().update(a.id, { accumulated: acc, bookValue: book, lastDepMonth: m, status: book - u.num(a.salvage) <= 0.009 ? 'fully_depreciated' : 'active', history: [...(a.history || []), ...lines] });
      });
      if (n) ERP.audit.log('asset.depreciation', `${n} قيد إهلاك بقيمة ${u.fmtMoney(total)} حتى ${month}`);
      return { entries: n, total: u.round(total) };
    },
    /** months of depreciation pending for the current month */
    pending(month = u.monthKey(new Date())) { return assets.active().filter(a => (a.lastDepMonth || u.monthKey(a.purchaseDate)) < month); },
    dispose(id, { salePrice = 0, method = 'cash', date = null, notes = '' }) {
      const a = A().get(id); if (!a || a.status === 'disposed') throw new Error('الأصل غير متاح');
      salePrice = u.num(salePrice);
      const lines = [{ sys: 'acc_dep', debit: u.num(a.accumulated), desc: 'إقفال مجمع الإهلاك' }, { sys: 'fixed_assets', credit: u.num(a.cost), desc: a.name }];
      if (salePrice > 0) lines.push({ accountId: ERP.accounting.methodAccount(method).id, debit: salePrice, desc: 'بيع أصل' });
      const diff = u.round(salePrice - u.num(a.bookValue));
      if (diff > 0) lines.push({ sys: 'other_income', credit: diff, desc: 'ربح بيع أصل' }); else if (diff < 0) lines.push({ sys: 'misc', debit: -diff, desc: 'خسارة استبعاد أصل' });
      ERP.accounting.post({ date: date || u.now(), memo: `استبعاد أصل: ${a.name}`, refType: 'asset_disposal', refId: a.id, lines });
      const upd = A().update(id, { status: 'disposed', disposedAt: date || u.now(), salePrice, disposalNotes: notes, gainLoss: diff });
      ERP.audit.log('asset.dispose', `${a.name} — بيع ${u.fmtMoney(salePrice)} (${diff >= 0 ? 'ربح' : 'خسارة'} ${u.fmtMoney(Math.abs(diff))})`, id);
      return upd;
    },
    summary() { const act = A().all().filter(a => a.status !== 'disposed'); return { count: act.length, cost: u.sum(act, 'cost'), accumulated: u.sum(act, 'accumulated'), bookValue: u.sum(act, 'bookValue'), monthly: u.sum(assets.active(), monthlyDep), pending: assets.pending().length }; },
  };
  ERP.assets = assets;
  ERP.audit.LABELS['asset.create'] = 'إضافة أصل ثابت'; ERP.audit.LABELS['asset.depreciation'] = 'إهلاك أصول'; ERP.audit.LABELS['asset.dispose'] = 'استبعاد أصل';
})();
