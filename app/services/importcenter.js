/* ==========================================================================
   ERP.importCenter — مركز الاستيراد: one engine for every Excel import
   ERP.importTypes.register(def) — one def per importable thing (importtypes.js)
     def = { id, label, icon, group, perm, desc, columns:[{key,label,aliases,required,type,help,example,latin,phone,values}],
             modes, matchBy:[{key,label}], options:[{key,label,type,choices(),default()}], unique?, examples?, refSheets?(),
             prepare(ctx), checkOptions?(ctx), scan?(rows,ctx), validate(row,ctx), finalize?(items,ctx), totals?(valid,ctx),
             apply(valid,ctx) → {summary, extra}, multiSheet?, parseWorkbook?(wb,ctx), template?() }
   Flow: template(type) → read(file) → preview(type, wb, opts) → apply(pv) → batch (importBatches)
   - preview validates every row against the current data and writes nothing
   - apply re-validates, refuses on any error (unless validOnly), then writes in one pass.
     Every doc the pass inserts / changes / removes is captured by a before/after diff of the
     collections → exact rollback when an exception happens mid-way, and the batch's undo data.
   - undo(batchId): only when safe (nothing it created or changed was touched later). Removes created
     docs + the batch's journal entries, restores the changed fields, posts reversing stock moves for
     products that stay (history kept) → trial balance, GL = valuation, AR/AP = balances all hold.
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  const u = ERP.utils;
  const C = n => ERP.db.collection(n);
  const B = () => C('importBatches');
  if (ERP.db.KNOWN && !ERP.db.KNOWN.includes('importBatches')) ERP.db.KNOWN.push('importBatches'); // part of backups / test snapshots
  const SKIP_COLS = new Set(['auditLog', 'notifications', 'importBatches', 'settings', 'users', 'roles']); // never part of a batch's undo data
  const META = new Set(['updatedAt', 'updatedBy', '_undoAt']);
  const GROUPS = ['بيانات أساسية', 'مخزون وأسعار', 'حسابات ومصروفات', 'مشتريات'];
  const MODES = { upsert: 'إضافة الجديد وتحديث الموجود', create: 'إضافة الجديد فقط', update: 'تحديث الموجود فقط' };
  const TYPE_AR = { text: 'نص', number: 'رقم', int: 'رقم صحيح', date: 'تاريخ (يوم/شهر/سنة)', bool: 'نعم / لا', list: 'قائمة مفصولة بفاصلة' };
  const COL_AR = { products: 'منتج', customers: 'عميل', suppliers: 'مورد', employees: 'موظف', accounts: 'حساب', assets: 'أصل ثابت', purchases: 'أمر شراء', expenses: 'مصروف', journal: 'قيد', stockMoves: 'حركة مخزون', categories: 'فئة', expenseCategories: 'فئة مصروفات', transfers: 'تحويل مخزني', priceChanges: 'تغيير سعر مجدول', labelQueue: 'ملصق سعر', payments: 'سند', sales: 'فاتورة' };
  const ERR_COL = 'الخطأ';
  ERP.audit.LABELS['import.apply'] = 'استيراد من Excel'; ERP.audit.LABELS['import.undo'] = 'تراجع عن استيراد';

  /* ---------------- registry ---------------- */
  const reg = new Map();
  const types = {
    GROUPS,
    register(def) {
      if (!def || !def.id) throw new Error('import type: id مطلوب');
      def.modes = def.modes && def.modes.length ? def.modes : ['create']; def.matchBy = def.matchBy || []; def.columns = def.columns || []; def.options = def.options || [];
      reg.set(def.id, def); return def;
    },
    get(id) { return reg.get(id) || null; },
    all() { return [...reg.values()]; },
    allowed() { return types.all().filter(d => !d.perm || ERP.auth.can(d.perm)); },
  };
  const need = id => { const d = reg.get(id); if (!d) throw new Error(`نوع استيراد غير معروف: ${id}`); return d; };
  const permLabel = p => { for (const g of Object.values(ERP.auth.PERMISSIONS)) if (g[p]) return g[p]; return p; };

  /* ---------------- value parsing ---------------- */
  const latin = s => u.normalizeDigits(String(s ?? '').replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 1776))); // Persian → Latin too
  const norm = s => u.normalizeAr(latin(s)).replace(/[*:]/g, '').replace(/\s+/g, ' ').trim();
  const blank = v => v === null || v === undefined || String(v).trim() === '';
  const iso = (y, m, d) => { const dt = new Date(y, m - 1, d); return y > 1900 && dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null; };
  const serial = n => { if (!(n > 0 && n < 2958466) || typeof XLSX === 'undefined') return null; const d = XLSX.SSF.parse_date_code(n); return d ? iso(d.y, d.m, d.d) : null; };
  const TRUE = ['1', 'نعم', 'ايوه', 'اه', 'صح', 'true', 'yes', 'y', 'x', '✓', '✔', 'نشط', 'فعال', 'مفعل'];
  const FALSE = ['0', 'لا', 'خطا', 'false', 'no', 'n', 'غير نشط', 'موقوف', 'غير مفعل'];
  /** one cell → { value } | { error }; blank → { value: null } */
  function coerce(col, v) {
    if (blank(v)) return { value: null };
    const t = col.type || 'text', lbl = `«${col.label}»`;
    if (t === 'number' || t === 'int') {
      let n = typeof v === 'number' ? v : NaN;
      if (typeof v !== 'number') { let s = latin(v).trim().replace(/٫/g, '.').replace(/[,٬\s ]/g, '').replace(/(ج\.?م\.?|جنيه|egp|%)$/i, ''); const neg = /^\(.*\)$/.test(s); s = s.replace(/[()]/g, ''); if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(s)) n = Number(s) * (neg ? -1 : 1); }
      if (!isFinite(n)) return { error: `${lbl}: "${String(v).trim()}" ليست رقماً` };
      if (t === 'int' && !Number.isInteger(n)) return { error: `${lbl}: يجب أن يكون رقماً صحيحاً` };
      return { value: n };
    }
    if (t === 'date') {
      let d = null;
      if (v instanceof Date) d = isNaN(v) ? null : u.toISODate(v);
      else if (typeof v === 'number') d = serial(v);
      else {
        const s = latin(v).trim(); let m;
        if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/))) d = iso(+m[1], +m[2], +m[3]);
        else if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/))) d = iso(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1]); // Egypt: day/month/year
        else if (/^\d{4,6}(\.\d+)?$/.test(s)) d = serial(Number(s));
      }
      return d ? { value: d } : { error: `${lbl}: التاريخ "${String(v).trim()}" غير صالح — اكتبه يوم/شهر/سنة مثل 25/12/2025` };
    }
    if (t === 'bool') { const s = norm(v); if (TRUE.includes(s)) return { value: true }; if (FALSE.includes(s)) return { value: false }; return { error: `${lbl}: اكتب نعم أو لا` }; }
    let s = typeof v === 'number' ? String(v) : String(v).trim();
    if (col.latin || col.phone) s = latin(s).trim();
    if (col.phone) { s = s.replace(/[\s\-().]/g, ''); if (s.startsWith('+20')) s = '0' + s.slice(3); else if (s.startsWith('0020')) s = '0' + s.slice(4); if (/^1\d{9}$/.test(s)) s = '0' + s; } // Excel drops the leading 0 of 01xxxxxxxxx
    if (t === 'list') return { value: s.split(/[,،;؛\n]+/).map(x => x.trim()).filter(Boolean) };
    return { value: s };
  }

  /* ---------------- workbook → rows ---------------- */
  async function read(src) {
    if (typeof XLSX === 'undefined') throw new Error('مكتبة Excel غير متاحة');
    if (src && src.SheetNames) return src;
    if (!src || !src.arrayBuffer) throw new Error('اختر ملف Excel');
    return XLSX.read(await src.arrayBuffer(), { type: 'array', codepage: 65001 });
  }
  function sheetOf(def, wb) {
    const want = [def.sheetName, ...(def.sheetAliases || [])].filter(Boolean).map(norm);
    return wb.SheetNames.find(s => want.includes(norm(s))) || wb.SheetNames.find(s => norm(s) !== norm('تعليمات') && !/مرجع/.test(s)) || wb.SheetNames[0];
  }
  /** header matching by label / key / aliases (Arabic-normalised), typed cells, Excel row numbers kept */
  function parse(typeId, wb) {
    const def = typeof typeId === 'string' ? need(typeId) : typeId;
    const fileErrors = [], fileWarnings = [];
    const name = sheetOf(def, wb); const ws = name ? wb.Sheets[name] : null;
    const empty = { sheet: name, headers: [], cols: {}, rows: [], fileErrors: ['الملف فارغ — لا توجد بيانات'], fileWarnings };
    if (!ws || !ws['!ref']) return empty;
    const base = XLSX.utils.decode_range(ws['!ref']).s.r;
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '', blankrows: true });
    const h = aoa.findIndex(r => (r || []).some(c => !blank(c))); if (h < 0) return empty;
    const headers = aoa[h].map(x => String(x ?? '').trim());
    const lookup = new Map(); def.columns.forEach(c => [c.label, c.key, ...(c.aliases || [])].forEach(a => { const k = norm(a); if (k && !lookup.has(k)) lookup.set(k, c.key); }));
    const cols = {}, unknown = [];
    headers.forEach((hd, i) => { if (!hd) return; const k = lookup.get(norm(hd)); if (k && cols[k] === undefined) cols[k] = i; else if (k) fileWarnings.push(`العمود «${hd}» مكرر — استُخدم الأول فقط`); else if (norm(hd) !== norm(ERR_COL)) unknown.push(hd); });
    if (unknown.length) fileWarnings.push(`أعمدة غير معروفة تم تجاهلها: ${unknown.map(x => `«${x}»`).join('، ')}`);
    def.columns.filter(c => c.required && cols[c.key] === undefined).forEach(c => fileErrors.push(`العمود «${c.label}» مطلوب وغير موجود في الملف`));
    const rows = [];
    for (let i = h + 1; i < aoa.length; i++) {
      const raw = aoa[i] || []; if (!raw.some(c => !blank(c))) continue; // empty rows are ignored
      const row = { _row: base + i + 1, _raw: headers.map((_, j) => raw[j] ?? ''), _errors: [], _bad: new Set() };
      def.columns.forEach(c => { if (cols[c.key] === undefined) { row[c.key] = null; return; } const r = coerce(c, raw[cols[c.key]]); if (r.error) { row._errors.push(r.error); row._bad.add(c.key); row[c.key] = null; } else row[c.key] = r.value; });
      rows.push(row);
    }
    if (!rows.length && !fileErrors.length) fileErrors.push('الملف لا يحتوي على أسطر بيانات — استخدم «تحميل النموذج»');
    return { sheet: name, headers, cols, rows, fileErrors, fileWarnings };
  }

  /* ---------------- preview ---------------- */
  function optionValues(def, given = {}) { const o = {}; def.options.forEach(x => { const v = given[x.key]; o[x.key] = v === undefined || v === null || v === '' ? (x.default ? x.default() : (x.type === 'bool' ? false : '')) : v; }); return o; }
  const statusOf = it => (it.errors.length ? 'error' : it.action);
  function summarise(def, ctx, items, fileErrors, fileWarnings, parsed, opts) {
    if (def.finalize) def.finalize(items, ctx);
    items.forEach(it => { it.status = statusOf(it); });
    const n = s => items.filter(i => i.status === s).length;
    const counts = { total: items.length, create: n('create'), update: n('update'), skip: n('skip'), error: n('error'), warn: items.filter(i => i.warnings.length).length };
    const valid = items.filter(i => i.status === 'create' || i.status === 'update');
    const totals = def.totals && valid.length ? def.totals(valid, ctx) : null;
    const pv = { typeId: def.id, label: def.label, parsed, opts: { mode: ctx.mode, matchBy: ctx.matchBy, options: ctx.options, validOnly: !!opts.validOnly, fileName: opts.fileName || '' }, items, counts, totals, fileErrors, fileWarnings, ok: !fileErrors.length && !counts.error && valid.length > 0 };
    Object.defineProperty(pv, 'ctx', { value: ctx, enumerable: false }); // lookups for apply (not serialised)
    return pv;
  }
  /** src = workbook | parsed rows (from parse). opts = { mode, matchBy, options, validOnly, fileName } — writes nothing */
  function preview(typeId, src, opts = {}) {
    const def = need(typeId);
    const mode = def.modes.includes(opts.mode) ? opts.mode : def.modes[0];
    const matchBy = def.matchBy.some(m => m.key === opts.matchBy) ? opts.matchBy : (def.matchBy[0] || {}).key || null;
    const ctx = { def, mode, matchBy, options: optionValues(def, opts.options), state: {} };
    if (def.multiSheet) {
      const wb = src && src.wb ? src.wb : src;
      ctx.has = () => true; ctx.cache = def.prepare ? def.prepare(ctx) || {} : {};
      const r = def.parseWorkbook(wb, ctx) || {};
      const items = (r.items || []).map(it => ({ row: it.row || null, raw: it.raw || [], action: it.action || 'create', label: it.label || '', data: it.data || null, errors: it.errors || [], warnings: it.warnings || [], sheet: it.sheet || '' }));
      ctx.payload = r.payload;
      const pv = summarise(def, ctx, items, [...(r.fileErrors || []), ...(def.checkOptions ? def.checkOptions(ctx) || [] : [])], r.fileWarnings || [], { multi: true, wb, headers: [] }, opts);
      if (r.totals) pv.totals = r.totals;
      return pv;
    }
    const parsed = src && src.rows ? src : parse(def, src);
    ctx.has = k => parsed.cols[k] !== undefined; ctx.rows = parsed.rows;
    ctx.cache = def.prepare ? def.prepare(ctx) || {} : {};
    const fileErrors = [...parsed.fileErrors, ...(def.checkOptions ? def.checkOptions(ctx) || [] : [])];
    if (def.scan) def.scan(parsed.rows, ctx);
    const uniq = (def.unique || def.matchBy.map(m => m.key)).map(k => (typeof k === 'string' ? { key: r => (r[k] === null ? null : norm(r[k])), label: `«${(def.columns.find(c => c.key === k) || {}).label || k}»` } : k));
    const seen = uniq.map(() => new Map());
    const items = parsed.rows.map(row => {
      const it = { row: row._row, raw: row._raw, action: 'skip', label: def.rowLabel ? def.rowLabel(row) : ([row.name, row.code, row.barcode, row.account, row.entryNo].find(v => !blank(v)) || ''), data: null, errors: [...row._errors], warnings: [], group: def.groupKey ? def.groupKey(row) : null };
      def.columns.forEach(c => { if (c.required && row[c.key] === null && !row._bad.has(c.key) && ctx.has(c.key)) it.errors.push(`«${c.label}» مطلوب`); });
      uniq.forEach((q, i) => { const v = q.key(row, ctx); if (blank(v)) return; const prev = seen[i].get(v); if (prev) it.errors.push(`مكرر في الملف — نفس ${q.label} موجود في السطر ${prev}`); else seen[i].set(v, row._row); });
      if (!it.errors.length) {
        try { const r = def.validate(row, ctx) || {}; it.action = r.action || 'create'; if (r.label) it.label = r.label; it.data = r.data || null; it.errors.push(...(r.errors || [])); it.warnings.push(...(r.warnings || [])); }
        catch (err) { it.errors.push(err.message || String(err)); }
      }
      return it;
    });
    return summarise(def, ctx, items, fileErrors, [...parsed.fileWarnings], parsed, opts);
  }
  async function previewFile(typeId, file, opts = {}) { return preview(typeId, await read(file), { ...opts, fileName: opts.fileName || (file && file.name) || '' }); }

  /* ---------------- change tracking (exact rollback + undo data) ---------------- */
  const tracked = () => ERP.db.KNOWN.filter(n => !SKIP_COLS.has(n));
  function snap() { const s = {}; tracked().forEach(n => { const m = new Map(); for (const d of C(n).all()) m.set(d.id, d); s[n] = m; }); return s; } // docs are immutable (update() replaces the object) → references are the before-images
  function diffOf(before) {
    const out = { created: [], updated: [], removed: [] };
    Object.entries(before).forEach(([n, m]) => {
      const seen = new Set();
      for (const d of C(n).all()) { seen.add(d.id); const b = m.get(d.id); if (!b) out.created.push({ col: n, id: d.id }); else if (b !== d) out.updated.push({ col: n, id: d.id, prev: b }); }
      m.forEach((b, id) => { if (!seen.has(id)) out.removed.push({ col: n, doc: b }); });
    });
    return out;
  }
  function emitCols(names) { u.uniq(names).forEach(n => ERP.bus.emit('db:change', { collection: n, op: 'bulk' })); }
  function revertExact(d) {
    d.created.slice().reverse().forEach(x => C(x.col).remove(x.id, { silent: true }));
    d.updated.forEach(x => C(x.col).update(x.id, () => ({ ...x.prev }), { silent: true }));
    d.removed.forEach(x => { if (!C(x.col).get(x.doc.id)) C(x.col).insert({ ...x.doc }, { silent: true }); });
    emitCols([...d.created, ...d.updated, ...d.removed].map(x => x.col));
  }
  /** run fn; on an exception undo exactly what it wrote, then rethrow */
  function track(fn) {
    const before = snap(); let out;
    try { out = fn(); } catch (err) { try { revertExact(diffOf(before)); } catch (e2) { console.error('[import] rollback failed', e2); } throw err; }
    return { diff: diffOf(before), out };
  }
  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  function undoData(d) {
    const created = [], journal = [], moves = [], updated = [], removed = [];
    d.created.forEach(x => (x.col === 'journal' ? journal.push(x.id) : x.col === 'stockMoves' ? moves.push(x.id) : created.push({ col: x.col, id: x.id })));
    d.updated.forEach(x => {
      const cur = C(x.col).get(x.id); if (!cur) return; const before = {}, unset = [];
      new Set([...Object.keys(x.prev), ...Object.keys(cur)]).forEach(k => { if (META.has(k) || JSON.stringify(x.prev[k]) === JSON.stringify(cur[k])) return; if (x.prev[k] === undefined) unset.push(k); else before[k] = clone(x.prev[k]); });
      if (Object.keys(before).length || unset.length) updated.push({ col: x.col, id: x.id, before, ...(unset.length ? { unset } : {}) });
    });
    d.removed.forEach(x => removed.push({ col: x.col, doc: clone(x.doc) }));
    return { created, updated, removed, journal, moves };
  }

  /* ---------------- apply ---------------- */
  function apply(pv, { validOnly = pv && pv.opts ? pv.opts.validOnly : false, fileName = pv && pv.opts ? pv.opts.fileName : '' } = {}) {
    if (!pv || !pv.typeId) throw new Error('لا توجد معاينة');
    const def = need(pv.typeId);
    if (def.perm && !ERP.auth.can(def.perm)) throw new Error(`ليس لديك صلاحية «${permLabel(def.perm)}» لاستيراد ${def.label}`);
    if (ERP.db.isReadOnly && ERP.db.isReadOnly()) throw new Error('النظام مفتوح في نافذة أخرى — لا يمكن الحفظ هنا');
    // validate everything again against the data as it is NOW (the preview may be minutes old)
    const fresh = preview(def.id, pv.parsed.multi ? pv.parsed.wb : pv.parsed, { ...pv.opts, validOnly, fileName });
    if (fresh.fileErrors.length) throw new Error(fresh.fileErrors.join('\n'));
    if (fresh.counts.error && (!validOnly || def.multiSheet)) throw new Error(`يوجد ${fresh.counts.error} سطر به أخطاء — صححها${def.multiSheet ? '' : ' أو اختر «استيراد الأسطر السليمة فقط»'}`);
    const items = fresh.items.filter(i => i.status === 'create' || i.status === 'update');
    if (!items.length) throw new Error('لا توجد أسطر صالحة للاستيراد');
    const me = ERP.auth.current();
    const batch = { id: u.uid('imp'), no: ERP.db.nextSeq('IMP', 'IMP', 6), typeId: def.id, label: def.label, fileName: fileName || '', mode: fresh.opts.mode, matchBy: fresh.opts.matchBy, options: clone(fresh.opts.options), validOnly: !!validOnly, counts: { ...fresh.counts, imported: items.length }, totals: clone(fresh.totals), userId: me ? me.id : null, userName: me ? me.name : '', status: 'applied' };
    const { diff, out } = track(() => def.apply(items, { ...fresh.ctx, batch }) || {});
    batch.at = u.now(); // every doc written above has updatedAt ≤ at → a later change is detectable
    Object.assign(batch, undoData(diff), { summary: out.summary || '', extra: clone(out.extra || {}) });
    const doc = B().insert(batch);
    const c = fresh.counts;
    ERP.audit.log('import.apply', `${batch.no} — ${def.label}: ${items.length} سطر (${c.create} جديد، ${c.update} تحديث${c.error ? `، تجاهل ${c.error} سطر خاطئ` : ''})${fileName ? ` — ${fileName}` : ''}`, batch.id);
    emitCols([...diff.created, ...diff.updated, ...diff.removed].map(x => x.col));
    return doc;
  }

  /* ---------------- undo ---------------- */
  const has = (col, pred) => C(col).all().some(pred);
  const lineOf = x => x.items || x.lines || x.cart || [];
  /** later dependent activity on a doc the batch created → reason | null. mine(col,id) = created by this batch */
  const DEPS = {
    products: (d, mine) => {
      if (has('stockMoves', m => m.productId === d.id && !mine('stockMoves', m.id))) return 'له حركات مخزون من خارج الاستيراد';
      for (const [col, l] of [['sales', 'فواتير بيع'], ['purchases', 'أوامر شراء'], ['quotations', 'عروض أسعار'], ['orders', 'طلبات'], ['transfers', 'تحويلات']]) if (has(col, x => !mine(col, x.id) && lineOf(x).some(it => it.productId === d.id))) return `مستخدم في ${l}`;
      if (has('priceChanges', x => x.productId === d.id && !mine('priceChanges', x.id))) return 'له تغييرات أسعار مجدولة';
      return null;
    },
    customers: (d, mine) => (has('sales', s => s.customerId === d.id) ? 'له فواتير بيع' : has('payments', p => p.partyType === 'customer' && p.partyId === d.id) ? 'له سندات تحصيل' : has('quotations', q => q.customerId === d.id) || has('orders', o => o.customerId === d.id) ? 'له عروض أسعار أو طلبات' : null),
    suppliers: (d, mine) => (has('purchases', p => p.supplierId === d.id && !mine('purchases', p.id)) ? 'له أوامر شراء' : has('payments', p => p.partyType === 'supplier' && p.partyId === d.id) ? 'له سندات سداد' : has('expenses', x => x.supplierId === d.id && !mine('expenses', x.id)) ? 'له مصروفات' : has('products', p => p.supplierId === d.id && !mine('products', p.id)) ? 'مرتبط بمنتجات' : has('assets', a => a.supplierId === d.id && !mine('assets', a.id)) ? 'مرتبط بأصول' : null),
    accounts: (d, mine) => (has('journal', j => !mine('journal', j.id) && j.lines.some(l => l.accountId === d.id)) ? 'عليه قيود' : has('accounts', a => a.parentId === d.id && !mine('accounts', a.id)) ? 'له حسابات فرعية' : has('expenseCategories', x => x.accountCode === d.code && !mine('expenseCategories', x.id)) ? 'مرتبط بفئة مصروفات' : null),
    categories: (d, mine) => (has('products', p => p.categoryId === d.id && !mine('products', p.id)) ? 'بها منتجات أخرى' : null),
    expenseCategories: (d, mine) => (has('expenses', x => x.categoryId === d.id && !mine('expenses', x.id)) ? 'عليها مصروفات أخرى' : null),
    employees: d => (has('attendance', a => a.employeeId === d.id) || has('payroll', p => p.employeeId === d.id) || has('advances', a => a.employeeId === d.id) ? 'له حضور أو رواتب أو سلف' : null),
    assets: (d, mine) => (has('journal', j => j.refId === d.id && !mine('journal', j.id)) ? 'عليه قيود إهلاك أو استبعاد' : null),
    purchases: d => (has('payments', p => p.refId === d.id) || has('purchases', p => p.refPoId === d.id) ? 'عليه سداد أو مرتجع' : null),
    expenses: () => null,
  };
  const docName = d => d.name || d.no || d.code || d.productName || d.title || d.id;
  /** can this batch be undone now? → { ok, reasons[], summary } */
  function undoCheck(id) {
    const b = B().get(id);
    if (!b) return { ok: false, reasons: ['سجل الاستيراد غير موجود'] };
    if (b.status === 'undone') return { ok: false, reasons: [`تم التراجع عن ${b.no} من قبل`] };
    const def = types.get(b.typeId); const reasons = []; let more = 0;
    const add = r => { if (reasons.length < 25) reasons.push(r); else more++; };
    if (def && def.perm && !ERP.auth.can(def.perm)) add(`ليس لديك صلاحية «${permLabel(def.perm)}»`);
    const mineSet = new Set([...b.created.map(x => `${x.col}:${x.id}`), ...b.journal.map(i => `journal:${i}`), ...b.moves.map(i => `stockMoves:${i}`)]);
    const mine = (col, i) => mineSet.has(`${col}:${i}`);
    const later = d => d && d.updatedAt && d.updatedAt > b.at && d.updatedAt !== d._undoAt; // _undoAt: restored by undoing a later batch → not a user change
    const what = x => COL_AR[x.col] || x.col;
    b.updated.forEach(x => { if (x.col === 'labelQueue') return; const d = C(x.col).get(x.id); if (!d) add(`${what(x)} (${x.id}) حُذف بعد الاستيراد`); else if (later(d)) add(`${what(x)} «${docName(d)}» تغيّر بعد الاستيراد (${u.fmtDateTime(d.updatedAt)})`); });
    b.created.forEach(x => { if (x.col === 'labelQueue') return; const d = C(x.col).get(x.id); if (!d) return; if (later(d)) add(`${what(x)} «${docName(d)}» تم تعديله بعد الاستيراد`); const dep = DEPS[x.col] ? DEPS[x.col](d, mine) : null; if (dep) add(`${what(x)} «${docName(d)}»: ${dep}`); });
    const J = C('journal').all();
    if (b.journal.some(jid => J.some(j => j.refType === 'reversal' && j.refId === jid))) add('أحد قيود الاستيراد تم عكسه يدوياً — احذف القيد العكسي أولاً');
    if (def && def.undoCheck) (def.undoCheck(b) || []).forEach(add);
    if (more) reasons.push(`و ${more} سبب آخر`);
    const by = list => { const o = {}; list.forEach(x => { const k = COL_AR[x.col] || x.col; o[k] = (o[k] || 0) + 1; }); return o; };
    return { ok: !reasons.length, reasons, summary: { remove: by(b.created), restore: by(b.updated), journal: b.journal.length, moves: b.moves.length } };
  }
  function undo(id) {
    const chk = undoCheck(id); if (!chk.ok) throw new Error('لا يمكن التراجع: ' + chk.reasons.join('؛ '));
    const b = B().get(id); const def = types.get(b.typeId); const me = ERP.auth.current();
    const P = C('products'), M = C('stockMoves'), LQ = C('labelQueue');
    const createdP = new Set(b.created.filter(x => x.col === 'products').map(x => x.id));
    // shelf labels already printed with the imported price need a correction label after the restore
    const priced = b.updated.filter(x => x.col === 'products' && ('price' in x.before || 'units' in x.before)).map(x => x.id);
    const printedAfter = (pid, unitId) => LQ.all().some(l => l.productId === pid && (l.unitId || null) === (unitId || null) && l.printed && l.printedAt && l.printedAt > b.at);
    const pricesNow = new Map(priced.map(pid => { const p = P.get(pid); return [pid, p ? [null, ...ERP.units.list(p).map(x => x.id)].map(uid => ({ uid, price: ERP.units.price(p, uid) })) : []]; }));
    const cols = new Set(['products', 'stockMoves', 'journal']);
    track(() => {
      if (def && def.undo) def.undo(b);
      // 1) stock of products that stay: reversing moves (history kept); the snapshot restore below brings qty & average cost back exactly
      const bal = {};
      b.moves.map(mid => M.get(mid)).filter(m => m && !createdP.has(m.productId)).reverse().forEach(m => {
        const p = P.get(m.productId); if (!p) return;
        bal[p.id] = u.round((bal[p.id] ?? u.num(p.stock)) - u.num(m.qty), 3);
        M.insert({ date: u.now(), productId: p.id, productName: p.name, warehouseId: m.warehouseId, qty: -u.num(m.qty), type: 'import_undo', unitCost: m.unitCost, value: -u.num(m.value), refType: 'import_undo', refId: b.id, note: `تراجع عن استيراد ${b.no}`, batch: m.batch || '', expiry: m.expiry || null, balanceAfter: bal[p.id], userId: me ? me.id : null }, { silent: true });
      });
      b.moves.forEach(mid => { const m = M.get(mid); if (m && createdP.has(m.productId)) M.remove(mid, { silent: true }); }); // leave with their product
      // 2) the batch's journal entries
      b.journal.forEach(jid => C('journal').remove(jid, { silent: true }));
      // 3) created docs out, removed docs back, changed fields restored
      b.created.slice().reverse().forEach(x => { C(x.col).remove(x.id, { silent: true }); cols.add(x.col); });
      b.removed.forEach(x => { if (!C(x.col).get(x.doc.id)) C(x.col).insert(clone(x.doc), { silent: true }); cols.add(x.col); });
      b.updated.forEach(x => {
        const doc = C(x.col).update(x.id, d => { const n = { ...d, ...clone(x.before) }; (x.unset || []).forEach(k => delete n[k]); return n; }, { silent: true });
        if (doc) doc._undoAt = doc.updatedAt; // same tick, before any flush: marks "restored by an undo" for older batches' checks
        cols.add(x.col);
      });
      // 4) correction shelf labels
      priced.forEach(pid => { const p = P.get(pid); if (!p) return; (pricesNow.get(pid) || []).forEach(({ uid, price }) => { if (uid && !ERP.units.get(p, uid)) return; const np = ERP.units.price(p, uid); if (Math.abs(np - price) >= 0.005 && printedAfter(pid, uid)) ERP.labels.add({ productId: pid, unitId: uid, oldPrice: price, newPrice: np, reason: `تراجع عن استيراد ${b.no}` }); }); });
    });
    const doc = B().update(id, { status: 'undone', undoneAt: u.now(), undoneBy: me ? me.id : null, undoneByName: me ? me.name : '' });
    ERP.audit.log('import.undo', `${b.no} — ${b.label}: حذف ${b.created.length} سجل، استرجاع ${b.updated.length}، ${b.journal.length} قيد`, b.id);
    emitCols([...cols]);
    return doc;
  }

  /* ---------------- templates & error files ---------------- */
  function book() { const wb = XLSX.utils.book_new(); wb.Workbook = { Views: [{ RTL: true }] }; return wb; }
  function addSheet(wb, name, rows, w = 18) { const ws = Array.isArray(rows[0]) ? XLSX.utils.aoa_to_sheet(rows) : XLSX.utils.json_to_sheet(rows.length ? rows : [{}]); const n = (Array.isArray(rows[0]) ? rows[0] : Object.keys(rows[0] || {})).length; ws['!cols'] = Array.from({ length: n }, () => ({ wch: w })); XLSX.utils.book_append_sheet(wb, ws, String(name).slice(0, 31)); return ws; }
  /** Excel template: data sheet (every column + examples) + «تعليمات» + reference sheets */
  function template(typeId, { download = true } = {}) {
    if (typeof XLSX === 'undefined') throw new Error('مكتبة Excel غير متاحة');
    const def = need(typeId);
    if (def.template) return def.template({ download });
    const wb = book(); const cols = def.columns;
    const ex = def.examples ? def.examples() : [Object.fromEntries(cols.map(c => [c.key, c.example ?? '']))];
    addSheet(wb, def.sheetName || 'البيانات', [cols.map(c => c.label), ...ex.map(r => cols.map(c => (r[c.key] === undefined ? '' : r[c.key])))]);
    const help = [['العمود', 'إلزامي', 'النوع', 'الشرح', 'القيم المقبولة / مثال', 'أسماء بديلة مقبولة للعمود']];
    cols.forEach(c => help.push([c.label, c.required ? 'نعم' : (c.requiredNote || 'لا'), TYPE_AR[c.type || 'text'], c.help || '', c.values ? (typeof c.values === 'function' ? c.values() : c.values) : (c.example ?? ''), (c.aliases || []).join('، ')]));
    help.push([], ['ملاحظات'], [def.desc || '']);
    if (def.modes.length > 1 || def.matchBy.length) help.push([`طرق الاستيراد: ${def.modes.map(m => MODES[m]).join(' · ')}${def.matchBy.length ? ` — البحث عن الموجود بـ: ${def.matchBy.map(m => m.label).join(' / ')}` : ''}`]);
    (def.notes || []).forEach(n => help.push([n]));
    help.push(['الخلايا الفارغة عند التحديث = بدون تغيير. الأرقام العربية (١٢٣) والفواصل (1,250) والتواريخ يوم/شهر/سنة مقبولة.'], ['بعد المعاينة يمكنك تنزيل الأسطر الخاطئة مع عمود «الخطأ» وتصحيحها ثم رفع الملف مرة أخرى.']);
    const ws = addSheet(wb, 'تعليمات', help, 26); ws['!cols'] = [{ wch: 22 }, { wch: 8 }, { wch: 16 }, { wch: 60 }, { wch: 30 }, { wch: 34 }];
    (def.refSheets ? def.refSheets() : []).forEach(s => addSheet(wb, s.name, s.rows, s.width || 22));
    if (download) XLSX.writeFile(wb, `نموذج-استيراد-${def.label}.xlsx`);
    return wb;
  }
  /** the rows with errors: original columns + «الخطأ» → fix and re-upload */
  function errorWorkbook(pv) {
    const wb = book(); const bad = pv.items.filter(i => i.status === 'error');
    if (pv.parsed.multi) addSheet(wb, 'الأخطاء', [['الصفحة / السطر', ERR_COL], ...pv.fileErrors.map(x => ['', x]), ...bad.map(i => [`${i.sheet || ''} ${i.row || ''}`, i.errors.join(' ؛ ')])], 40);
    else { const idx = pv.parsed.headers.map((h, i) => (h && norm(h) !== norm(ERR_COL) ? i : -1)).filter(i => i >= 0); addSheet(wb, pv.parsed.sheet || 'البيانات', [[...idx.map(i => pv.parsed.headers[i]), ERR_COL], ...bad.map(it => [...idx.map(i => it.raw[i] ?? ''), `سطر ${it.row}: ${it.errors.join(' ؛ ')}`])]); }
    return wb;
  }
  function downloadErrors(pv) { if (typeof XLSX === 'undefined') throw new Error('مكتبة Excel غير متاحة'); XLSX.writeFile(errorWorkbook(pv), `أخطاء-استيراد-${pv.label}.xlsx`); }

  ERP.importTypes = types;
  ERP.importCenter = {
    GROUPS, MODES, TYPE_AR, COL_AR, ERR_COL,
    types: () => types.allowed(), type: id => types.get(id),
    norm, latin, coerce, read, parse, preview, previewFile, apply, undo, undoCheck, template, errorWorkbook, downloadErrors,
    batches() { return u.sortBy(B().all(), 'at', 'desc'); },
    batch(id) { return B().get(id); },
  };
})();
