/* ==========================================================================
   ERP.branches — multi-branch: identity, inter-branch transfers (file or
   cloud inbox companies/{cid}/transfers), consolidated KPIs across branches
   (from backup files or the branch summary docs written by ERP.cloud)
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  const u = ERP.utils;
  const T = () => ERP.db.collection('transfers');
  const B = () => ERP.db.collection('branches');
  const STAMP_COLS = new Set(['sales', 'purchases', 'payments', 'expenses', 'stockMoves', 'shifts', 'journal', 'cashMoves', 'stocktakes', 'transfers', 'auditLog', 'payroll', 'advances', 'attendance']);

  const br = {
    STAMP_COLS,
    current() { const s = ERP.settings.all(); return { code: s.branchCode || 'MAIN', name: s.branchName || s.storeName || 'الفرع الرئيسي' }; },
    /** known branches (registry maintained locally: this branch + any seen via transfers/consolidation) */
    all() { const me = br.current(); const list = B().all(); if (!list.some(b => b.code === me.code)) B().insert({ id: 'br_' + me.code, code: me.code, name: me.name, isSelf: true }, { silent: true }); return B().all().map(b => ({ ...b, isSelf: b.code === me.code })); },
    normCode(code) { return String(code || '').trim().toUpperCase().replace(/\s+/g, '-'); },
    /** license branch limit (ERP.license.branches): a NEW code may join the registry only while (known branches + this one) ≤ licensed max */
    checkSlot(code) {
      code = br.normCode(code); const me = br.current().code;
      if (!code || code === me || B().first({ code })) return true;
      const codes = new Set(B().all().map(b => b.code)); codes.add(me);
      return ERP.license && ERP.license.requireBranchSlot ? ERP.license.requireBranchSlot(codes.size + 1) : true;
    },
    register({ code, name, phone = '', address = '' }) {
      code = br.normCode(code); if (!code) throw new Error('كود الفرع مطلوب');
      const ex = B().first({ code }); if (ex) return B().update(ex.id, { name: name || ex.name, phone, address });
      br.checkSlot(code);
      return B().insert({ id: 'br_' + code, code, name: name || code, phone, address });
    },
    remove(id) { const b = B().get(id); if (!b) return; if (b.code === br.current().code) throw new Error('لا يمكن حذف الفرع الحالي'); B().remove(id); },

    /* ---------------- inter-branch transfers ---------------- */
    /** send stock to another branch. Returns the transfer doc (with .payload for file export) */
    sendTransfer({ toBranch, lines, note = '', fromWh = null }) {
      const me = br.current(); if (!toBranch || toBranch === me.code) throw new Error('اختر فرعاً مستلماً مختلفاً');
      if (!lines || !lines.length) throw new Error('أضف أصنافاً');
      const wh = fromWh || ERP.inventory.defaultWh();
      const P = ERP.db.collection('products');
      const detail = lines.map(l => { const p = P.get(l.productId); if (!p) throw new Error('منتج غير موجود'); return { productId: p.id, code: p.code, barcode: p.barcode || '', name: p.name, qty: u.num(l.qty), cost: u.num(p.cost), price: u.num(p.price), categoryId: p.categoryId, unitId: p.unitId }; }).filter(l => l.qty > 0);
      const doc = T().insert({ no: ERP.db.nextSeq('BTRF', 'BT-' + me.code, 4), kind: 'branch', direction: 'out', status: 'sent', date: u.now(), fromBranch: me.code, fromBranchName: me.name, toBranch, fromWh: wh, lines: detail, note, userId: ERP.auth.current()?.id, value: u.round(u.sum(detail, l => l.qty * l.cost)) });
      let value = 0;
      detail.forEach(l => { const mv = ERP.inventory.move({ productId: l.productId, warehouseId: wh, qty: -l.qty, type: 'transfer_out', refType: 'branch_transfer', refId: doc.id, note: `تحويل إلى فرع ${toBranch} — ${doc.no}`, silent: true }); if (mv) value += -mv.value; });
      ERP.bus.emit('db:change', { collection: 'products', op: 'bulk' });
      if (value) ERP.accounting.post({ date: doc.date, memo: `تحويل بضاعة إلى فرع ${toBranch} — ${doc.no}`, refType: 'branch_transfer', refId: doc.id, lines: [{ sys: 'branch_current', debit: u.round(value), desc: `جاري فرع ${toBranch}` }, { sys: 'inventory', credit: u.round(value), desc: 'خروج مخزون' }] });
      ERP.audit.log('stock.transfer', `${doc.no} → فرع ${toBranch}: ${detail.length} صنف بقيمة ${u.fmtMoney(value)}`, doc.id);
      if (ERP.cloud && ERP.cloud.postTransfersSoon) ERP.cloud.postTransfersSoon(); // cloud inbox of the receiving branch (no-op when sync is off / during tests)
      return T().get(doc.id);
    },
    payload(transferId) { const t = T().get(transferId); if (!t) throw new Error('التحويل غير موجود'); return { __type: 'DreamMarketBranchTransfer', __version: 1, id: t.id, no: t.no, date: t.date, fromBranch: t.fromBranch, fromBranchName: t.fromBranchName, toBranch: t.toBranch, note: t.note, lines: t.lines, value: t.value }; },
    exportTransfer(transferId) { const p = br.payload(transferId); u.downloadJSON(p, `transfer-${p.no}-to-${p.toBranch}.json`); T().update(transferId, { exportedAt: u.now() }, { silent: true }); },
    /** receive a transfer sent by another branch (payload object). Matches products by barcode → code → name, creates missing ones. */
    receiveTransfer(payload, { toWh = null, createMissing = true } = {}) {
      if (!payload || payload.__type !== 'DreamMarketBranchTransfer') throw new Error('ملف تحويل غير صالح');
      const me = br.current();
      if (payload.toBranch && payload.toBranch !== me.code) throw new Error(`هذا التحويل موجّه إلى فرع ${payload.toBranch} وليس ${me.code}`);
      if (T().all().some(t => t.kind === 'branch' && t.direction === 'in' && t.sourceId === payload.id)) throw new Error(`تم استلام هذا التحويل (${payload.no}) من قبل`);
      if (payload.fromBranch) br.checkSlot(payload.fromBranch); // before any stock moves (the sender joins the registry below)
      const wh = toWh || ERP.inventory.defaultWh();
      const P = ERP.db.collection('products');
      let value = 0; const lines = [];
      payload.lines.forEach(l => {
        let p = (l.barcode && P.first({ barcode: l.barcode })) || P.first({ code: l.code }) || P.first({ name: l.name });
        if (!p) { if (!createMissing) throw new Error(`الصنف غير موجود: ${l.name}`); p = P.insert({ code: l.code || ERP.db.nextSeq('PRD', 'PRD', 5), barcode: l.barcode || '', name: l.name, categoryId: ERP.db.collection('categories').get(l.categoryId) ? l.categoryId : 'cat_other', unitId: ERP.db.collection('units').get(l.unitId) ? l.unitId : 'un_pc', cost: l.cost, price: l.price, stock: 0, stockByWh: {}, batches: [], minStock: 5, taxRate: 0, active: true }, { silent: true }); }
        const mv = ERP.inventory.move({ productId: p.id, warehouseId: wh, qty: l.qty, type: 'transfer_in', unitCost: l.cost, refType: 'branch_transfer', refId: payload.id, note: `وارد من فرع ${payload.fromBranch} — ${payload.no}`, silent: true });
        if (mv) value += mv.value; lines.push({ ...l, productId: p.id });
      });
      const doc = T().insert({ no: ERP.db.nextSeq('BTRF_IN', 'BR-' + me.code, 4), kind: 'branch', direction: 'in', status: 'received', date: u.now(), sourceId: payload.id, sourceNo: payload.no, fromBranch: payload.fromBranch, fromBranchName: payload.fromBranchName, toBranch: me.code, toWh: wh, lines, note: payload.note || '', value: u.round(value), userId: ERP.auth.current()?.id });
      if (payload.fromBranch) br.register({ code: payload.fromBranch, name: payload.fromBranchName || payload.fromBranch });
      ERP.bus.emit('db:change', { collection: 'products', op: 'bulk' });
      if (value) ERP.accounting.post({ date: doc.date, memo: `استلام بضاعة من فرع ${payload.fromBranch} — ${payload.no}`, refType: 'branch_transfer', refId: doc.id, lines: [{ sys: 'inventory', debit: u.round(value), desc: 'دخول مخزون' }, { sys: 'branch_current', credit: u.round(value), desc: `جاري فرع ${payload.fromBranch}` }] });
      ERP.audit.log('stock.transfer', `استلام ${payload.no} من فرع ${payload.fromBranch}: ${lines.length} صنف بقيمة ${u.fmtMoney(value)}`, doc.id);
      if (ERP.cloud && ERP.cloud.ackTransfer) ERP.cloud.ackTransfer(payload.id).catch(err => console.warn('[branches] cloud ack', err && err.message));
      return doc;
    },
    async receiveFile(file, opts) { const txt = await u.readFile(file); let p; try { p = JSON.parse(txt); } catch { throw new Error('ملف غير صالح'); } return br.receiveTransfer(p, opts); },
    transfers() { return u.sortBy(T().all().filter(t => t.kind === 'branch'), 'date', 'desc'); },
    /** inbound transfers addressed to me in the cloud inbox (companies/{cid}/transfers, status 'sent') not yet received here (dedup by sourceId) */
    pendingCloudInbound() { const me = br.current().code; const got = new Set(T().all().filter(t => t.direction === 'in').map(t => t.sourceId)); return (ERP.cloud && ERP.cloud.inbox ? ERP.cloud.inbox() : []).filter(p => p && p.toBranch === me && !got.has(p.id)); },

    /* ---------------- consolidation ---------------- */
    /** compute branch KPIs from a plain snapshot {collections:{sales,...}} or from separate arrays */
    kpis(cols, { branchCode = '', branchName = '' } = {}) {
      const sales = (cols.sales || []).filter(s => s.status !== 'void');
      const today = u.todayISO(), m0 = u.toISODate(u.startOfMonth());
      const S = (list) => ({ total: u.sum(list.filter(s => s.type === 'sale'), 'total') - u.sum(list.filter(s => s.type === 'return'), 'total'), count: list.filter(s => s.type === 'sale').length, profit: u.sum(list.filter(s => s.type === 'sale'), 'profit') });
      const products = cols.products || [];
      const topM = {}; sales.filter(s => s.type === 'sale' && u.inRange(s.date, m0)).forEach(s => s.items.forEach(it => { topM[it.name] = (topM[it.name] || 0) + it.total; }));
      return {
        code: branchCode, name: branchName, at: u.now(),
        today: S(sales.filter(s => u.inRange(s.date, today, today))), month: S(sales.filter(s => u.inRange(s.date, m0))), all: S(sales),
        debtors: u.sum((cols.customers || []).filter(c => c.balance > 0), 'balance'), debtorsCount: (cols.customers || []).filter(c => c.balance > 0).length,
        payables: u.sum((cols.suppliers || []).filter(s => s.balance > 0), 'balance'),
        stockValue: u.round(u.sum(products.filter(p => p.active !== false), p => u.num(p.stock) * u.num(p.cost))), stockRetail: u.round(u.sum(products.filter(p => p.active !== false), p => u.num(p.stock) * u.num(p.price))), products: products.length,
        lowStock: products.filter(p => p.active !== false && u.num(p.stock) <= u.num(p.minStock, 5)).length,
        expensesMonth: u.sum((cols.expenses || []).filter(e => u.inRange(e.date, m0)), 'amount'),
        openShifts: (cols.shifts || []).filter(s => s.status === 'open').length,
        cashGL: (() => { const cash = (cols.accounts || []).find(a => a.sys === 'cash'); if (!cash) return null; let v = 0; (cols.journal || []).forEach(j => j.lines.forEach(l => { if (l.accountId === cash.id) v += l.debit - l.credit; })); return u.round(v); })(),
        top: u.sortBy(Object.entries(topM).map(([name, total]) => ({ name, total })), 'total', 'desc').slice(0, 5),
        lastSaleAt: sales.length ? u.sortBy(sales, 'date', 'desc')[0].date : null,
      };
    },
    mine() { const me = br.current(); const cols = {}; ['sales', 'customers', 'suppliers', 'products', 'expenses', 'shifts', 'accounts', 'journal'].forEach(n => { cols[n] = ERP.db.collection(n).all(); }); return br.kpis(cols, { branchCode: me.code, branchName: me.name }); },
    /** import a branch backup (JSON export) → store its KPIs locally */
    async importSnapshotFile(file) {
      const txt = await u.readFile(file); let snap; try { snap = JSON.parse(txt); } catch { throw new Error('ملف غير صالح'); }
      if (!snap.collections) throw new Error('هذا ليس ملف نسخة احتياطية من النظام');
      const st = (snap.collections.settings || []).find(s => s.id === 'main') || {};
      const code = st.branchCode || (st.storeName ? u.slug(st.storeName).toUpperCase() : 'BR-' + Date.now().toString(36).slice(-4));
      br.checkSlot(code);
      const k = br.kpis(snap.collections, { branchCode: code, branchName: st.branchName || st.storeName || code }); k.source = 'file'; k.exportedAt = snap.__exportedAt;
      const store = (await ERP.db.kvGet('branchKpis')) || {}; store[code] = k; await ERP.db.kvSet('branchKpis', store);
      br.register({ code, name: k.name });
      return k;
    },
    async savedKpis() { return (await ERP.db.kvGet('branchKpis')) || {}; },
    async forgetBranchKpis(code) { const store = (await ERP.db.kvGet('branchKpis')) || {}; delete store[code]; await ERP.db.kvSet('branchKpis', store); },
    /** consolidation from the cloud: one read per branch (summary doc written by each branch's ERP.cloud) + transfer inbox — no raw data download */
    async pullCloud() {
      if (!ERP.cloud || !ERP.cloud.isConfigured()) throw new Error('المزامنة السحابية غير مُعدّة — أعدّها من الإعدادات ← السحابة');
      if (!ERP.cloud.isSignedIn()) throw new Error('سجّل الدخول بحساب المتجر السحابي أولاً (الإعدادات ← السحابة)');
      const list = await ERP.cloud.branchSummaries(); await ERP.cloud.refreshInbox();
      const me = br.current().code; const out = {}; const store = (await ERP.db.kvGet('branchKpis')) || {};
      list.forEach(b => { if (!b || !b.code || !b.summary || b.code === me) return; const k = { ...b.summary, code: b.code, name: b.name || b.code, at: b.beat ? new Date(b.beat).toISOString() : b.summary.at, lastSync: b.lastSync || null, source: 'cloud' }; try { br.register({ code: b.code, name: k.name }); } catch (err) { console.warn('[branches]', err.message); return; } out[b.code] = k; store[b.code] = k; });
      await ERP.db.kvSet('branchKpis', store);
      return out;
    },
  };
  ERP.branches = br;
})();
