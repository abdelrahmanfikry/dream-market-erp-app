/* ==========================================================================
   ERP.openingImport — استيراد الأرصدة الافتتاحية من Excel
   One workbook, four sheets (all optional, at least one must have rows):
     «القيود الافتتاحية»  كود الحساب · مدين · دائن · البيان   (general GL balances)
     «العملاء»            الاسم · الهاتف · الرصيد · حد الائتمان  (→ AR per customer)
     «الموردين»           الاسم · الهاتف · الرصيد                (→ AP per supplier)
     «المخزون»            الكود/الباركود · الكمية · التكلفة · المخزن (→ stock + GL inventory)
   AR / AP / inventory may NOT be typed as GL lines: they come from their own
   sheets so customer balances = AR and GL inventory = stock valuation.
   Any debit/credit difference goes to the system «الأرصدة الافتتاحية» account.
   Flow: template() → parse(file) → preview (errors/warnings/totals) → apply(preview, {date})
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  const u = ERP.utils;
  const SHEETS = { gl: 'القيود الافتتاحية', cust: 'العملاء', supp: 'الموردين', stock: 'المخزون' };
  const LOCKED = { ar: SHEETS.cust, ap: SHEETS.supp, inventory: SHEETS.stock }; // sys accounts fed by their own sheet
  const r2 = n => u.round(n, 2);
  const digits = s => String(s || '').replace(/\D/g, '');
  const norm = s => u.normalizeAr ? u.normalizeAr(String(s || '').trim()) : String(s || '').trim().toLowerCase();
  const pick = (r, ...keys) => { for (const k of keys) { const kk = Object.keys(r).find(x => norm(x) === norm(k)); if (kk !== undefined && r[kk] !== '' && r[kk] != null) return r[kk]; } return undefined; };
  const numOf = v => { if (v === undefined || v === null || v === '') return 0; const n = Number(String(v).replace(/[,\s]/g, '').replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))); return isFinite(n) ? n : NaN; };
  const findSheet = (wb, name) => { const k = wb.SheetNames.find(n => norm(n) === norm(name)); return k ? XLSX.utils.sheet_to_json(wb.Sheets[k], { defval: '' }) : []; };
  const nonEmpty = r => Object.values(r).some(v => String(v).trim() !== '');

  const imp = {
    SHEETS,
    /** downloadable template: the four sheets with one example row each + the chart of accounts for reference */
    template() {
      if (typeof XLSX === 'undefined') throw new Error('مكتبة Excel غير متاحة');
      const wb = XLSX.utils.book_new(); wb.Workbook = { Views: [{ RTL: true }] };
      const add = (name, rows, w = 22) => { const ws = XLSX.utils.json_to_sheet(rows); ws['!cols'] = Object.keys(rows[0] || {}).map(() => ({ wch: w })); XLSX.utils.book_append_sheet(wb, ws, name); };
      const cash = ERP.accounting.bySys('cash'), bank = ERP.accounting.bySys('bank'), cap = ERP.accounting.bySys('capital');
      add(SHEETS.gl, [
        { 'كود الحساب': cash ? cash.code : '1110', 'اسم الحساب': cash ? cash.name : 'الخزينة', 'مدين': 5000, 'دائن': 0, 'البيان': 'نقدية بالخزينة أول المدة' },
        { 'كود الحساب': bank ? bank.code : '1120', 'اسم الحساب': bank ? bank.name : 'البنك', 'مدين': 20000, 'دائن': 0, 'البيان': 'رصيد البنك' },
        { 'كود الحساب': cap ? cap.code : '3100', 'اسم الحساب': cap ? cap.name : 'رأس المال', 'مدين': 0, 'دائن': 25000, 'البيان': 'رأس المال' },
      ]);
      add(SHEETS.cust, [{ 'الاسم': 'عميل مثال', 'الهاتف': '01000000000', 'الرصيد': 350, 'حد الائتمان': 1000 }]);
      add(SHEETS.supp, [{ 'الاسم': 'مورد مثال', 'الهاتف': '01100000000', 'الرصيد': 1200 }]);
      add(SHEETS.stock, [{ 'الكود أو الباركود': 'PRD-00001', 'اسم الصنف': '(للمراجعة فقط)', 'الكمية': 24, 'التكلفة': 12.5, 'المخزن': '' }]);
      const coa = ERP.accounting.tree().map(a => ({ 'الكود': a.code, 'الحساب': '  '.repeat(a.level - 1) + a.name, 'النوع': ({ asset: 'أصول', liability: 'التزامات', equity: 'حقوق ملكية', revenue: 'إيرادات', expense: 'مصروفات' })[a.type] || a.type, 'ملاحظة': LOCKED[a.sys] ? `من صفحة «${LOCKED[a.sys]}»` : (a.sys === 'opening' ? 'يستقبل الفرق تلقائياً' : '') }));
      add('شجرة الحسابات (مرجع)', coa, 28);
      XLSX.writeFile(wb, 'نموذج-الأرصدة-الافتتاحية.xlsx');
    },

    async parse(file) {
      if (typeof XLSX === 'undefined') throw new Error('مكتبة Excel غير متاحة');
      return imp.parseWorkbook(XLSX.read(await file.arrayBuffer(), { type: 'array' }));
    },

    /** pure-ish: reads the workbook against current data, writes nothing */
    parseWorkbook(wb) {
      const errors = [], warnings = [];
      const accs = ERP.accounting.accounts(); const byCode = new Map(accs.map(a => [String(a.code).trim(), a]));
      // --- GL lines
      const gl = [];
      findSheet(wb, SHEETS.gl).filter(nonEmpty).forEach((r, i) => {
        const row = i + 2, code = String(pick(r, 'كود الحساب', 'الكود', 'code') ?? '').trim();
        const debit = numOf(pick(r, 'مدين', 'debit')), credit = numOf(pick(r, 'دائن', 'credit')), desc = String(pick(r, 'البيان', 'بيان', 'desc') || '').trim();
        const where = `«${SHEETS.gl}» سطر ${row}`;
        if (!code) return errors.push(`${where}: كود الحساب فارغ`);
        const a = byCode.get(code); if (!a) return errors.push(`${where}: الكود ${code} غير موجود في شجرة الحسابات`);
        if (isNaN(debit) || isNaN(credit)) return errors.push(`${where}: قيمة غير رقمية`);
        if (debit < 0 || credit < 0) return errors.push(`${where}: لا تُقبل قيم سالبة — ضع المبلغ في العمود الآخر`);
        if (debit && credit) return errors.push(`${where}: السطر فيه مدين ودائن معاً`);
        if (!debit && !credit) return warnings.push(`${where}: بدون مبلغ — تم تجاهله`);
        if (LOCKED[a.sys]) return errors.push(`${where}: حساب «${a.name}» يُحسب من صفحة «${LOCKED[a.sys]}» — لا تكتبه كرقم واحد`);
        gl.push({ accountId: a.id, code, name: a.name, debit: r2(debit), credit: r2(credit), desc });
      });
      // --- customers / suppliers
      const party = (sheet, col, withLimit) => {
        const out = []; const seen = new Set();
        findSheet(wb, sheet).filter(nonEmpty).forEach((r, i) => {
          const where = `«${sheet}» سطر ${i + 2}`;
          const name = String(pick(r, 'الاسم', 'اسم العميل', 'اسم المورد', 'name') || '').trim(), phone = String(pick(r, 'الهاتف', 'الموبايل', 'phone') || '').trim();
          const bal = numOf(pick(r, 'الرصيد', 'المديونية', 'balance')), limit = withLimit ? numOf(pick(r, 'حد الائتمان', 'creditLimit')) : 0;
          if (!name) return errors.push(`${where}: الاسم فارغ`);
          if (isNaN(bal) || isNaN(limit)) return errors.push(`${where}: قيمة غير رقمية`);
          const key = digits(phone) || norm(name); if (seen.has(key)) return errors.push(`${where}: «${name}» مكرر في الملف`); seen.add(key);
          const list = ERP.db.collection(col).all();
          const ex = (digits(phone) && list.find(x => digits(x.phone) && digits(x.phone) === digits(phone))) || list.find(x => norm(x.name) === norm(name));
          if (ex && u.num(ex.openingBalance)) warnings.push(`${where}: «${ex.name}» له رصيد افتتاحي ${u.fmtNum(ex.openingBalance)} بالفعل — سيُضاف عليه`);
          if (!bal && ex) return warnings.push(`${where}: «${name}» موجود ورصيده 0 — تم تجاهله`);
          out.push({ name, phone, balance: r2(bal), creditLimit: limit, existingId: ex ? ex.id : null });
        });
        return out;
      };
      const customers = party(SHEETS.cust, 'customers', true);
      const suppliers = party(SHEETS.supp, 'suppliers', false);
      // --- stock
      const stock = []; const whs = ERP.inventory.warehouses(); const P = ERP.db.collection('products').all();
      findSheet(wb, SHEETS.stock).filter(nonEmpty).forEach((r, i) => {
        const where = `«${SHEETS.stock}» سطر ${i + 2}`;
        const code = String(pick(r, 'الكود أو الباركود', 'الكود', 'الباركود', 'code', 'barcode') ?? '').trim();
        const qty = numOf(pick(r, 'الكمية', 'qty')), cost = numOf(pick(r, 'التكلفة', 'cost')), whName = String(pick(r, 'المخزن', 'warehouse') || '').trim();
        if (!code) return errors.push(`${where}: الكود فارغ`);
        const p = P.find(x => String(x.code) === code || String(x.barcode || '') === code || (x.barcodes || []).some(b => String(b.code) === code));
        if (!p) return errors.push(`${where}: لا يوجد صنف بالكود/الباركود ${code} — أضفه من المنتجات أو استيراد المنتجات أولاً`);
        if (isNaN(qty) || isNaN(cost)) return errors.push(`${where}: قيمة غير رقمية`);
        if (qty <= 0) return errors.push(`${where}: الكمية يجب أن تكون أكبر من صفر`);
        if (cost < 0) return errors.push(`${where}: تكلفة سالبة`);
        let wh = null; if (whName) { wh = whs.find(w => norm(w.name) === norm(whName) || String(w.code || '') === whName); if (!wh) return errors.push(`${where}: المخزن «${whName}» غير موجود`); }
        const useCost = cost || u.num(p.cost); if (!cost) warnings.push(`${where}: بدون تكلفة — استُخدمت تكلفة الصنف ${u.fmtNum(useCost)}`);
        if (u.num(p.stock)) warnings.push(`${where}: «${p.name}» رصيده الحالي ${u.fmtQty(p.stock)} — الكمية ستُضاف عليه`);
        stock.push({ productId: p.id, name: p.name, qty: u.round(qty, 3), cost: u.round(useCost, 4), warehouseId: wh ? wh.id : null, value: r2(qty * useCost) });
      });
      // --- totals: every piece posts against «الأرصدة الافتتاحية»; GL lines' own difference also lands there
      const glDr = r2(u.sum(gl, 'debit')), glCr = r2(u.sum(gl, 'credit'));
      const ar = r2(u.sum(customers, 'balance')), ap = r2(u.sum(suppliers, 'balance')), inv = r2(u.sum(stock, 'value'));
      const diff = r2(glDr - glCr);
      if (diff) warnings.push(`القيود العامة غير متوازنة بفرق ${u.fmtNum(Math.abs(diff))} (${diff > 0 ? 'مدين' : 'دائن'} أكبر) — سيُرحّل الفرق لحساب «الأرصدة الافتتاحية»`);
      // net effect on the opening-balance account (credit positive = equity)
      const openingNet = r2(glDr - glCr + ar - ap + inv);
      const empty = !gl.length && !customers.length && !suppliers.length && !stock.length;
      if (empty && !errors.length) errors.push('الملف لا يحتوي على بيانات — استخدم «نموذج الأرصدة الافتتاحية»');
      const prev = ERP.accounting.entries({ refType: 'opening' }).filter(j => String(j.refId || '').startsWith('import:'));
      if (prev.length) warnings.push(`تم استيراد أرصدة افتتاحية من قبل (${prev.length} قيد) — الاستيراد مرة أخرى يضيف عليها`);
      return { gl, customers, suppliers, stock, errors, warnings, totals: { glDr, glCr, diff, ar, ap, inv, openingNet }, ok: !errors.length };
    },

    /** writes everything; refuses when the preview has errors. date = opening date (YYYY-MM-DD) */
    apply(pv, { date = null } = {}) {
      if (!ERP.auth.require('accounting.manage')) throw new Error('لا تملك صلاحية إدارة الحسابات');
      if (!pv || !pv.ok) throw new Error('صحّح الأخطاء أولاً');
      const when = date ? new Date(date + 'T00:00:00').toISOString() : u.now();
      const batch = 'import:' + u.uid().slice(-8);
      const A = ERP.accounting; const done = { gl: 0, customers: 0, suppliers: 0, stock: 0 };
      const post = (memo, refId, lines) => A.post({ date: when, memo, refType: 'opening', refId, lines });
      // 1) general GL balances in one entry (+ difference to the opening account)
      if (pv.gl.length) {
        const lines = pv.gl.map(l => ({ accountId: l.accountId, debit: l.debit, credit: l.credit, desc: l.desc || 'رصيد افتتاحي' }));
        const d = pv.totals.diff; if (d > 0) lines.push({ sys: 'opening', credit: d, desc: 'فرق الأرصدة الافتتاحية' }); else if (d < 0) lines.push({ sys: 'opening', debit: -d, desc: 'فرق الأرصدة الافتتاحية' });
        post('أرصدة افتتاحية (استيراد Excel)', batch, lines); done.gl = pv.gl.length;
      }
      // 2) customers → AR (sub-ledger balance moves with the GL)
      const C = ERP.db.collection('customers');
      pv.customers.forEach(x => {
        let c = x.existingId ? C.get(x.existingId) : null;
        if (!c) c = ERP.crm.create({ name: x.name, phone: x.phone, creditLimit: x.creditLimit || 0 });
        else if (x.creditLimit && !u.num(c.creditLimit)) C.update(c.id, { creditLimit: x.creditLimit });
        if (x.balance) {
          C.update(c.id, { balance: r2(u.num(C.get(c.id).balance) + x.balance), openingBalance: r2(u.num(C.get(c.id).openingBalance) + x.balance) });
          post(`رصيد افتتاحي عميل ${c.name}`, `${batch}:c:${c.id}`, x.balance > 0 ? [{ sys: 'ar', debit: x.balance, desc: c.name }, { sys: 'opening', credit: x.balance }] : [{ sys: 'opening', debit: -x.balance }, { sys: 'ar', credit: -x.balance, desc: c.name }]);
        }
        done.customers++;
      });
      // 3) suppliers → AP
      const S = ERP.db.collection('suppliers');
      pv.suppliers.forEach(x => {
        let s = x.existingId ? S.get(x.existingId) : null;
        if (!s) s = ERP.purchasing.createSupplier({ name: x.name, phone: x.phone });
        if (x.balance) {
          S.update(s.id, { balance: r2(u.num(S.get(s.id).balance) + x.balance), openingBalance: r2(u.num(S.get(s.id).openingBalance) + x.balance) });
          post(`رصيد افتتاحي مورد ${s.name}`, `${batch}:s:${s.id}`, x.balance > 0 ? [{ sys: 'opening', debit: x.balance }, { sys: 'ap', credit: x.balance, desc: s.name }] : [{ sys: 'ap', debit: -x.balance, desc: s.name }, { sys: 'opening', credit: -x.balance }]);
        }
        done.suppliers++;
      });
      // 4) stock: moves at the given cost, GL debit = the actual valuation change (keeps GL inventory = valuation)
      if (pv.stock.length) {
        let value = 0;
        pv.stock.forEach(x => { const mv = ERP.inventory.move({ productId: x.productId, warehouseId: x.warehouseId || ERP.inventory.defaultWh(), qty: x.qty, type: 'opening', unitCost: x.cost, refType: 'opening', refId: batch, note: 'رصيد افتتاحي (استيراد Excel)', date: when, silent: true }); value += mv ? u.num(mv.value) : 0; done.stock++; }); // a negative-stock revalue is already posted by inventory.move itself
        value = r2(value);
        if (value) post('رصيد مخزون افتتاحي (استيراد Excel)', `${batch}:stock`, [{ sys: 'inventory', debit: value }, { sys: 'opening', credit: value }]);
        ERP.bus.emit('db:change', { collection: 'products', op: 'bulk' });
      }
      ERP.bus.emit('db:change', { collection: 'journal', op: 'bulk' });
      ERP.audit.log('accounting.opening_import', `استيراد أرصدة افتتاحية ${batch}: ${done.gl} قيد، ${done.customers} عميل، ${done.suppliers} مورد، ${done.stock} صنف`);
      return { batch, ...done };
    },
  };
  ERP.openingImport = imp;
})();
