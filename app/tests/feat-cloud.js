/* ==========================================================================
   Tests: cloud sync v2 (ERP.cloud) — no network: every Firestore call goes
   through an in-memory fake adapter; ERP.testing keeps the live engine idle
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  ERP.testSuites = ERP.testSuites || [];
  ERP.testSuites.push((t, h) => {
    const { u, near } = h; const X = () => ERP.cloud._;
    const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); };
    const ok = (c, m) => { if (!c) throw new Error(m); };
    /** in-memory Firestore stand-in: path → data; commit() can fail or pause (hook) to simulate an in-flight push */
    function fakeAdapter() {
      const A = { docs: new Map(), commits: [], failNext: 0, hook: null,
        async commit(ops) { if (ops.length > 500) throw new Error('batch > 500'); if (A.hook) { const f = A.hook; A.hook = null; await f(); } if (A.failNext) { A.failNext--; const er = new Error('unavailable'); er.code = 'unavailable'; throw er; } A.commits.push(ops.length); ops.forEach(o => { if (o.type === 'delete') A.docs.delete(o.path); else A.docs.set(o.path, o.merge ? { ...(A.docs.get(o.path) || {}), ...o.data } : { ...o.data }); }); },
        async get(p) { return A.docs.has(p) ? A.docs.get(p) : null; },
        async list(p, where) { const d = p.split('/').length + 1; return [...A.docs].filter(([k, v]) => k.startsWith(p + '/') && k.split('/').length === d && (where || []).every(w => v[w[0]] === w[2])).map(([k, v]) => ({ id: k.split('/').pop(), data: v })); },
        async listAll(p) { return A.list(p); }, async count(p, where) { return (await A.list(p, where)).length; } };
      return A;
    }
    function memKv() { const m = new Map(); return { m, get: async k => (m.has(k) ? JSON.parse(m.get(k)) : null), set: async (k, v) => { m.set(k, JSON.stringify(v)); } }; }
    /** isolated engine context over a plain local store {col: [records]} */
    function engine(local) {
      const x = X(); const kv = memKv(); const tracker = new x.Tracker(); const synced = x.makeSynced(kv, () => 'k'); const adapter = fakeAdapter();
      const ctx = { adapter, base: x.paths.branch('uidT', 'BR1'), dev: 'devT', tracker, synced, get: (c, id) => (local[c] || []).find(r => r.id === id) || null, list: c => local[c] || [], count: c => (local[c] || []).length };
      return { x, kv, tracker, synced, adapter, ctx, push: () => x.pushOnce(ctx) };
    }

    t('السحابة: تحويل السجل ↔ مستند (JSON، تاريخ، معرّف آمن، سجل محذوف)', () => {
      const x = X(); const rec = { id: 'inv/1.a', no: 'INV-000007', date: '2026-09-26T10:15:00.000Z', updatedAt: '2026-09-26T10:16:00.000Z', items: [{ name: 'أرز "مصري"', qty: 2, tags: [[1, 2], [3]] }], total: 99.5, note: null };
      const d = x.toDoc('sales', rec, { dev: 'd1', now: 123 });
      ok(typeof d.json === 'string' && d.deleted === false && d.updatedAt === 123 && d.dev === 'd1' && d.rev === rec.updatedAt, 'shape');
      eq(d.dataDate, u.toISODate(rec.date), 'dataDate');
      eq(x.fromDoc(d), rec, 'roundtrip (nested arrays + Arabic)');
      const sid = x.safeId(rec.id); ok(!sid.includes('/') && sid !== rec.id && x.safeId('abc_1-2') === 'abc_1-2' && x.safeId('__x__') !== '__x__', 'safe id ' + sid);
      const path = x.paths.doc(x.paths.branch('U1', 'ALEX 01'), 'sales', rec.id); ok(path.split('/').length === 8, 'path depth ' + path);
      const tb = x.tombstone('p1', { now: 5 }); ok(tb.deleted === true && tb.json === null && x.fromDoc(tb) === null, 'tombstone');
      let big = null; try { x.toDoc('products', { id: 'b', img: 'x'.repeat(1000 * 1024) }); } catch (er) { big = er.code; } eq(big, 'too-big', 'oversize guard');
      return `مسار ${path.split('/').length} مقاطع · ${d.json.length} بايت · حد المستند محمي`;
    });

    t('السحابة: استبعاد الأسرار (قائمة المنع)', () => {
      const x = X(); const s = { id: 'main', storeName: 'متجر', waCloudToken: 'T', driveToken: 'D', driveUrl: 'https://script', etaClientSecret: 'S', etaClientId: 'C', etaPresharedKey: 'K', licenseKey: 'L', firebaseConfig: { apiKey: 'a' }, waCallmebotKeys: '010:1', someApiKey: 'z', taxRate: 14, cloudCfg: { projectId: 'p' } };
      const o = x.strip(s); const leaked = Object.keys(o).filter(k => /token|secret|licen|preshared|apikey|callmebot|drive|firebase|etaClient/i.test(k));
      ok(!leaked.length, 'leaked ' + leaked.join(','));
      ok(o.storeName === 'متجر' && o.taxRate === 14 && o.cloudCfg && o.cloudCfg.projectId === 'p', 'kept normal fields');
      ok(!JSON.parse(x.toDoc('settings', s).json).waCloudToken, 'toDoc strips');
      ok(!x.syncable('users') && !x.syncable('heldCarts') && !x.syncable('notifications') && x.syncable('sales') && x.syncable('settings'), 'collections denylist');
      const tr = new x.Tracker(); tr.mark('users', 'u1'); tr.fromEvent({ collection: 'users', op: 'update', doc: { id: 'u1', pinHash: 'h' } }); eq(tr.size(), 0, 'users never queued');
      return `${Object.keys(s).length - Object.keys(o).length} حقل سري محذوف · ${x.DENY_COLS.length} جداول محلية فقط`;
    });

    t('السحابة: تتبع السجلات المتغيرة من أحداث db:change (يشمل الجماعية)', () => {
      const x = X(); const tr = new x.Tracker();
      tr.fromEvent({ collection: 'products', op: 'insert', doc: { id: 'p1' } });
      tr.fromEvent({ collection: 'products', op: 'update', doc: { id: 'p1' } });
      tr.fromEvent({ collection: 'sales', op: 'remove', doc: { id: 's9' } });
      tr.fromEvent({ collection: 'customers', op: 'bulk', docs: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }] });
      tr.fromEvent({ collection: 'products', op: 'bulk' }); // id-less bulk (inventory.move silent + manual event)
      tr.fromEvent({ collection: 'auditLog', op: 'removeMany', count: 40 });
      tr.fromEvent({ collection: 'journal', op: 'replace' });
      const snap = tr.snapshot(); eq(snap.map(s => s.col + ':' + s.id).sort(), ['customers:c1', 'customers:c2', 'customers:c3', 'products:p1', 'sales:s9'], 'ids');
      eq([...tr.diff].sort(), ['auditLog', 'journal', 'products'], 'diff cols');
      tr.fromFlush('stockMoves', { dirty: ['m1', 'm2'], removed: ['m0'], replaced: false }); tr.fromFlush('expenses', { replaced: true });
      ok(tr.q.get('stockMoves').size === 3 && tr.diff.has('expenses'), 'flush hook ids (silent writes)');
      const j = JSON.parse(JSON.stringify(tr.toJSON())); const t2 = new x.Tracker(); t2.load(j); eq(t2.size(), tr.size(), 'persisted queue reloads');
      return `${snap.length} سجل + ${tr.diff.size} جداول للمقارنة · يُحفظ ويُستعاد`;
    });

    t('السحابة: تقسيم الدفعات ≤ 500 عملية وبحجم محدود', () => {
      const x = X(); const ops = Array.from({ length: 1234 }, (_, i) => ({ i, bytes: 100 }));
      const b = x.splitBatches(ops); ok(b.every(z => z.length <= x.MAX_OPS && z.length <= 500), 'op limit'); eq(b.reduce((a, z) => a + z.length, 0), 1234, 'no op lost'); eq([].concat(...b).map(o => o.i), ops.map(o => o.i), 'order kept');
      const big = x.splitBatches(Array.from({ length: 30 }, () => ({ bytes: 800 * 1024 }))); ok(big.every(z => u.sum(z, 'bytes') <= 8 * 1024 * 1024) && big.length >= 3, 'byte limit ' + big.length);
      return `1234 عملية → ${b.length} دفعات · 30 سجل كبير → ${big.length} دفعات`;
    });

    t('السحابة: لا يضيع تغيير حدث أثناء رفع جارٍ + الفشل يُبقي الطابور', async () => {
      const local = { sales: [{ id: 's1', total: 10, updatedAt: '2026-01-01T00:00:01Z' }, { id: 's2', total: 20, updatedAt: '2026-01-01T00:00:01Z' }] };
      const E = engine(local); E.tracker.mark('sales', 's1'); E.tracker.mark('sales', 's2');
      E.adapter.failNext = 1; let failed = false; try { await E.push(); } catch { failed = true; }
      ok(failed && E.tracker.size() === 2 && !E.adapter.docs.size, 'failure keeps every queued change');
      E.adapter.hook = async () => { local.sales[0] = { ...local.sales[0], total: 11, updatedAt: '2026-01-01T00:00:02Z' }; E.tracker.mark('sales', 's1'); }; // edited while the batch is in flight
      const r1 = await E.push(); const p1 = E.x.paths.doc(E.ctx.base, 'sales', 's1');
      ok(r1.pushed === 2 && E.tracker.size() === 1 && E.tracker.snapshot()[0].id === 's1', 'newer change retained');
      eq(JSON.parse(E.adapter.docs.get(p1).json).total, 10, 'first push wrote the old version');
      const r2 = await E.push(); eq(JSON.parse(E.adapter.docs.get(p1).json).total, 11, 'second push wrote the new version'); ok(r2.pushed === 1 && !E.tracker.size(), 'queue drained');
      ok(E.adapter.docs.get(E.x.paths.col(E.ctx.base, 'sales')).count === 2, 'collection marker count');
      const m = JSON.parse(E.kv.m.get('cloud.synced.sales')).map; eq(m.s1, '2026-01-01T00:00:02Z', 'synced map persisted');
      return `فشل ← لا فقد · تعديل أثناء الرفع ← أُعيد رفعه (${E.adapter.commits.length} commit)`;
    });

    t('السحابة: الحذف = شاهد حذف، والمسح/الاستبدال لا يحذف من السحابة', async () => {
      const local = { products: [{ id: 'a', updatedAt: '1' }, { id: 'b', updatedAt: '1' }], expenses: [] };
      const E = engine(local); ['a', 'b'].forEach(id => E.tracker.mark('products', id)); E.tracker.mark('expenses', 'ghost'); await E.push();
      const pa = E.x.paths.doc(E.ctx.base, 'products', 'a'), pg = E.x.paths.doc(E.ctx.base, 'expenses', 'ghost');
      ok(E.adapter.docs.get(pa).deleted === false && !E.adapter.docs.has(pg), 'never-synced delete skipped');
      local.products = local.products.filter(p => p.id !== 'a'); E.tracker.fromFlush('products', { removed: ['a'] }); await E.push();
      ok(E.adapter.docs.get(pa).deleted === true && E.adapter.docs.get(pa).json === null, 'tombstone written');
      local.products = local.products.map(p => ({ ...p, updatedAt: '1b' })); E.tracker.mark('products', 'b'); // queued edit, then "reset data" clears the table before the push
      local.products = []; E.tracker.fromFlush('products', { replaced: true, dirty: ['b'] }); E.tracker.fromEvent({ collection: 'products', op: 'replace' }); const r = await E.push(); // "مسح كل البيانات" (clear)
      ok(r.pushed === 0 && E.adapter.docs.get(E.x.paths.doc(E.ctx.base, 'products', 'b')).deleted === false, 'clear pushed nothing');
      local.products = [{ id: 'b', updatedAt: '2' }, { id: 'c', updatedAt: '1' }]; E.tracker.fromFlush('products', { replaced: true }); const r2 = await E.push(); // file restore → upserts only
      eq(r2.pushed, 2, 'replace diff upserts changed/new');
      return 'حذف فردي → deleted:true · مسح الجدول → لا شيء يُرفع · استبدال → رفع المختلف فقط';
    });

    t('السحابة: ملخص الفرع (KPIs) يطابق البيانات المحلية', () => {
      const x = X(); const today = u.todayISO(), now = new Date().toISOString(), old = '2001-01-01T10:00:00.000Z';
      const cols = {
        sales: [{ id: 1, type: 'sale', status: 'paid', date: now, total: 100, profit: 30, items: [{ name: 'شاي', qty: 2, total: 60 }, { name: 'سكر', qty: 1, total: 40 }] }, { id: 2, type: 'sale', status: 'paid', date: now, total: 50, profit: 10, items: [{ name: 'شاي', qty: 1, total: 50 }] }, { id: 3, type: 'return', status: 'paid', date: now, total: 20, items: [] }, { id: 4, type: 'sale', status: 'void', date: now, total: 999, items: [{ name: 'X', qty: 1, total: 999 }] }, { id: 5, type: 'sale', status: 'paid', date: old, total: 70, items: [] }],
        products: [{ id: 'p1', name: 'شاي', stock: 2, minStock: 5, cost: 10, price: 15 }, { id: 'p2', name: 'سكر', stock: 50, minStock: 5, cost: 4, price: 6 }, { id: 'p3', name: 'قديم', stock: 0, active: false, cost: 1 }],
        shifts: [{ id: 'sh', status: 'open', no: 'SH-00001', userName: 'كاشير', openedAt: now, openingCash: 100, cashSales: 130, receiptsCash: 0, cashIn: 0, cashOut: 0 }],
        customers: [], suppliers: [], expenses: [], accounts: [{ id: 'a1', sys: 'cash' }], journal: [{ lines: [{ accountId: 'a1', debit: 500, credit: 0 }, { accountId: 'a1', debit: 0, credit: 120 }] }],
      };
      const s = x.buildSummary(cols, { code: 'BR1', name: 'فرع' });
      ok(near(s.todaySales, 130) && s.todayCount === 2 && near(s.returnsToday, 20), `today ${s.todaySales}/${s.todayCount}`);
      ok(near(s.stockValue, 2 * 10 + 50 * 4) && s.lowStock === 1 && s.lowList.length === 1 && s.lowList[0].name === 'شاي', 'stock');
      ok(near(s.cash, 380) && s.openShift && s.openShift.no === 'SH-00001' && near(s.openShift.expected, 230), 'cash / shift');
      ok(s.topToday[0].name === 'شاي' && near(s.topToday[0].total, 110) && near(s.topToday[0].qty, 3) && !s.topToday.some(p => p.name === 'X'), 'top today');
      eq(s.day, today, 'day'); ok(JSON.stringify(s).length < 20000, 'small doc');
      return `مبيعات اليوم ${s.todaySales} · ${s.todayCount} فاتورة · مخزون ${s.stockValue} · نواقص ${s.lowStock} · خزينة ${s.cash}`;
    });

    t('السحابة: الاستعادة تعيد بناء الجداول وترفع العدّادات', async () => {
      const x = X(); const ctx = { now: 1 };
      const docs = { sales: [x.toDoc('sales', { id: 'r1', no: 'INV-000950', type: 'sale', date: '2001-02-03T10:00:00Z', total: 5, updatedAt: 'A' }, ctx), x.tombstone('r2', ctx), { id: 'bad', json: '{oops', deleted: false }], settings: [x.toDoc('settings', { id: 'main', storeName: 'سحابي', waCloudToken: 'CLOUD?', branchCode: 'BR1', updatedAt: 'B' }, ctx)], users: [x.toDoc('users', { id: 'u', pinHash: 'h' }, ctx)] };
      const r = x.buildRestore(docs, { seq: { sale: 700, PRD: 12 }, localMain: { id: 'main', storeName: 'محلي', waCloudToken: 'LOCAL', cloudCfg: { projectId: 'p' }, cloudOn: true } });
      eq(r.collections.sales.map(s => s.id), ['r1'], 'live records only'); ok(!r.collections.users, 'users never restored');
      const m = r.collections.settings[0]; ok(m.storeName === 'سحابي' && m.waCloudToken === 'LOCAL' && m.cloudCfg.projectId === 'p' && m.cloudOn === true, 'settings keeps local secrets + cloud config');
      eq(r.synced.sales, { r1: 'A' }, 'synced map'); eq(r.count, 2, 'count');
      // apply the sales part to the (temporary) test DB exactly like restore() does, then put everything back
      const keep = ERP.db.collection('sales').all().map(d => ({ ...d })), seq0 = { ...(ERP.db.getMeta('seq') || {}) };
      try {
        await ERP.db.import({ collections: { sales: r.collections.sales } }, { mode: 'replace' });
        Object.entries(r.seq).forEach(([k, v]) => { if (+v > (+(ERP.db.getMeta('seq') || {})[k] || 0)) ERP.db.setSeq(k, +v); }); ERP.db.raiseSeqs();
        ok(ERP.db.collection('sales').count() === 1 && ERP.db.peekSeq('sale') >= 951, 'sale counter after restore = ' + ERP.db.peekSeq('sale'));
        ok(ERP.db.peekSeq('PRD') >= 13, 'cloud counter applied');
      } finally { await ERP.db.import({ collections: { sales: keep } }, { mode: 'replace' }); Object.keys(ERP.db.getMeta('seq') || {}).forEach(k => ERP.db.setSeq(k, seq0[k] || 0)); await ERP.db.flush(); }
      ok(x.mergeSeq({ sale: 5 }, { sale: 3, x: 2 }).sale === 5 && !x.seqRaised({ sale: 5 }, { sale: 0 }) && x.seqRaised({ sale: 5 }, { sale: 6 }), 'counters only go up (reset never lowers the cloud)');
      return 'سجل حي واحد (تخطّى المحذوف والتالف) · الفاتورة التالية INV-000951';
    });

    t('السحابة: إعدادات Firebase + الصيغة القديمة + لا شبكة أثناء الاختبار', () => {
      const x = X();
      const c1 = x.parseConfig(`// firebase\nconst firebaseConfig = {\n  apiKey: "AIza-test", // key\n  databaseURL: "https://demo.firebaseio.com",\n  authDomain: 'demo.firebaseapp.com',\n  projectId: "demo",\n  appId: "1:2:web:3",\n};`);
      ok(c1.apiKey === 'AIza-test' && c1.projectId === 'demo' && c1.authDomain === 'demo.firebaseapp.com' && c1.appId === '1:2:web:3', 'js snippet');
      ok(x.parseConfig('{"apiKey":"k","projectId":"p"}').authDomain === 'p.firebaseapp.com', 'json + default authDomain');
      let bad = false; try { x.parseConfig('{"apiKey":"k"}'); } catch { bad = true; } ok(bad, 'missing projectId rejected');
      ok(x.legacyOf({ firebaseConfig: { projectId: 'old' } }) && !x.legacyOf({ firebaseConfig: { projectId: 'old' }, cloudCfg: { projectId: 'n' } }) && !x.legacyOf({}), 'legacy detection');
      ok(ERP.testing === true && !x.tracking(), 'engine idle while ERP.testing');
      return 'JSON/JS · الصيغة القديمة تُكتشف · المحرك متوقف أثناء الاختبار';
    });
  });
})();
