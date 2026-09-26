/* ==========================================================================
   Feature tests — distribution: licensing (ECDSA P-256 verify, trial math, read-only guard),
   updater version compare, setup-wizard demo-data wipe invariants
   (runs inside ERP.tests.run — data snapshotted/restored around it; the private signing key is NEVER used here:
    licenses are signed with a throw-away key pair generated in the test)
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  ERP.testSuites = ERP.testSuites || [];
  ERP.testSuites.push((t, h) => {
    const { u, near } = h; const L = () => ERP.license; const A = ERP.accounting; const P = ERP.db.collection('products');
    const throws = async fn => { try { await fn(); return null; } catch (e) { return e; } };
    const tbOk = () => { const tb = A.trialBalance(); if (!near(tb.totalDebit, tb.totalCredit)) throw new Error(`TB ${tb.totalDebit} ≠ ${tb.totalCredit}`); };
    let kp = null;
    const sign = async (payload, key = kp.privateKey) => { const p = L().b64u(new TextEncoder().encode(JSON.stringify(payload))); const s = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(p)); return `${p}.${L().b64u(new Uint8Array(s))}`; };
    const base = over => ({ v: 1, id: 'LIC-T1', store: 'محل اختبار', phone: '01000000000', machine: 'DM-TEST-0001', plan: 'pro', branches: 2, issued: '2026-01-01', expires: '2099-12-31', features: [], ...over });

    t('الترخيص: التحقق من التوقيع (صالح · معدّل · جهاز آخر · منتهي · مفتاح غريب)', async () => {
      if (!u.hasSubtle()) return 'تخطي: crypto.subtle غير متاح';
      kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      const key = kp.publicKey, machine = 'DM-TEST-0001', now = new Date('2026-06-01T10:00:00').getTime();
      const good = await sign(base());
      const r1 = await L().verify(good, { key, machine, now }); if (!r1.ok || r1.payload.store !== 'محل اختبار') throw new Error('valid: ' + r1.error);
      const r1b = await L().verify(good.replace('.', '.\n'), { key, machine: 'dm test 0001', now }); if (!r1b.ok) throw new Error('whitespace / case-insensitive machine code: ' + r1b.error);
      const [p, s] = good.split('.'); const forged = L().b64u(new TextEncoder().encode(JSON.stringify(base({ branches: 99 })))) + '.' + s;
      const r2 = await L().verify(forged, { key, machine, now }); if (r2.ok || r2.code !== 'signature') throw new Error('tampered payload accepted');
      const r2b = await L().verify(p + '.' + s.slice(0, -4) + 'AAAA', { key, machine, now }); if (r2b.ok) throw new Error('tampered signature accepted');
      const r3 = await L().verify(good, { key, machine: 'DM-OTHR-9999', now }); if (r3.ok || r3.code !== 'machine') throw new Error('wrong machine accepted');
      const any = await sign(base({ machine: '*' })); const r3b = await L().verify(any, { key, machine: 'DM-OTHR-9999', now }); if (!r3b.ok) throw new Error('machine * rejected');
      const old = await sign(base({ expires: '2026-05-31' })); const r4 = await L().verify(old, { key, machine, now }); if (r4.ok || r4.code !== 'expired' || !r4.expired) throw new Error('expired accepted');
      const r4b = await L().verify(await sign(base({ expires: '2026-06-01' })), { key, machine, now }); if (!r4b.ok) throw new Error('expiry day itself must still be valid');
      const r4c = await L().verify(await sign(base({ expires: null })), { key, machine, now: new Date('2090-01-01').getTime() }); if (!r4c.ok) throw new Error('lifetime rejected');
      const r5 = await L().verify(good, { machine, now }); if (r5.ok || r5.code !== 'signature') throw new Error('embedded public key accepted a foreign-signed license');
      const r6 = await L().verify('abc', { key, machine, now }); if (r6.ok || r6.code !== 'format') throw new Error('garbage accepted');
      const code = L().codeFrom(new Uint8Array([1, 2, 3, 4, 5, 6])); if (!/^DM-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code)) throw new Error('machine code format ' + code);
      return 'صالح ✓ · تعديل الحمولة/التوقيع ✗ · جهاز آخر ✗ · * ✓ · منتهي ✗ · مدى الحياة ✓ · مفتاح غير مفتاحنا ✗';
    });

    t('الترخيص: حساب الأيام المتبقية للفترة التجريبية (14 يوم)', () => {
      const D = 86400000, s = '2026-03-01T08:00:00.000Z', t0 = new Date(s).getTime(), ti = x => L().trialInfo(s, t0 + x);
      const cases = [[0, 14, false], [1, 14, false], [D, 13, false], [13.5 * D, 1, false], [14 * D - 1, 1, false], [14 * D, 0, true], [20 * D, 0, true], [-D, 15, false]];
      cases.forEach(([dt, left, exp]) => { const r = ti(dt); if (r.daysLeft !== left || r.expired !== exp) throw new Error(`+${dt / D}d → ${r.daysLeft}/${r.expired} (المتوقع ${left}/${exp})`); });
      if (L().trialInfo(s, t0).ends !== new Date(t0 + 14 * D).toISOString()) throw new Error('ends');
      if (L().TRIAL_DAYS !== 14) throw new Error('trial days');
      return cases.map(c => `${+(c[0] / D).toFixed(2)}ي→${c[1]}`).join(' · ');
    });

    t('الترخيص: وضع القراءة فقط يمنع البيع/المخزون/المصروف — ويسمح أثناء الاختبارات', async () => {
      const wasTesting = ERP.testing; ERP.testing = true;
      try {
        if (!ERP.sales.create.__licWrapped || !ERP.inventory.move.__licWrapped || !ERP.purchasing.receive.__licWrapped || !ERP.crm.receivePayment.__licWrapped) throw new Error('write entry points are not wrapped');
        const wh = ERP.inventory.defaultWh(); if (!ERP.shifts.current()) ERP.shifts.open({ openingCash: 0 });
        const p = P.insert({ code: 'DST-001', name: 'صنف ترخيص', categoryId: 'cat_other', unitId: 'un_pc', cost: 10, price: 20, stock: 0, stockByWh: {}, batches: [], minStock: 0, taxRate: 0, active: true });
        ERP.inventory.move({ productId: p.id, warehouseId: wh, qty: 10, type: 'opening', unitCost: 10, refType: 'opening', note: 'test' }); A.postOpeningStock(100);
        const n0 = ERP.db.collection('sales').count(), j0 = ERP.db.collection('journal').count(), x0 = ERP.db.collection('expenses').count();
        const sale = () => ERP.sales.create({ cart: [{ productId: p.id, name: 'x', qty: 1, price: 20 }], payments: [{ method: 'cash', amount: 20 }] });
        L()._force = { active: false };
        try {
          if (L().isActive()) throw new Error('forced state not active=false');
          const e1 = await throws(sale); if (!e1 || e1.code !== 'LICENSE_READONLY' || !/القراءة فقط/.test(e1.message)) throw new Error('sale not blocked: ' + (e1 && e1.message));
          const e2 = await throws(() => ERP.inventory.adjust({ productId: p.id, warehouseId: wh, newQty: 3, reason: 'x' })); if (!e2 || e2.code !== 'LICENSE_READONLY') throw new Error('adjust not blocked');
          const e3 = await throws(() => ERP.db.collection('expenses').insert({ no: 'X', title: 'x', amount: 1 })); if (!e3 || e3.code !== 'LICENSE_READONLY') throw new Error('expense not blocked');
          const e4 = await throws(() => ERP.purchasing.create({ supplierId: 'none', items: [] })); if (!e4 || e4.code !== 'LICENSE_READONLY') throw new Error('purchase not blocked');
          if (ERP.db.collection('sales').count() !== n0 || ERP.db.collection('journal').count() !== j0 || ERP.db.collection('expenses').count() !== x0 || P.get(p.id).stock !== 10) throw new Error('a blocked call left data behind');
          if (ERP.db.export().collections.products.length < 1) throw new Error('read/export must keep working');
        } finally { L()._force = null; }
        if (!L().isActive()) throw new Error('ERP.testing bypass off');
        const s = sale(); if (!s || !near(s.total, 20) || P.get(p.id).stock !== 9) throw new Error('sale during ERP.testing should pass');
        tbOk();
        return 'مقفول: البيع ✗ التسوية ✗ المصروف ✗ الشراء ✗ بلا أثر · أثناء الاختبار: البيع ✓';
      } finally { ERP.testing = wasTesting; L()._force = null; }
    });

    t('التحديثات: مقارنة الإصدارات (3.3.0 < 3.10.0)', () => {
      const c = ERP.updater.compare;
      const cases = [['3.3.0', '3.10.0', -1], ['3.10.0', '3.3.0', 1], ['v3.10.0', '3.10.0', 0], ['3.10.1', '3.10.0', 1], ['3.9.9', '4.0.0', -1], ['3.2', '3.2.0', 0], ['10.0.0', '9.99.99', 1]];
      cases.forEach(([a, b, r]) => { if (c(a, b) !== r) throw new Error(`${a} vs ${b} → ${c(a, b)}`); });
      return cases.map(x => `${x[0]}${x[2] < 0 ? '<' : x[2] > 0 ? '>' : '='}${x[1]}`).join(' · ');
    });

    t('معالج الإعداد: مسح البيانات التجريبية — ميزان المراجعة متوازن والمخزون = التقييم = صفر', async () => {
      const snap = JSON.parse(JSON.stringify(ERP.db.export()));
      try {
        const C = n => ERP.db.collection(n);
        if (!P.count()) { const p = P.insert({ code: 'DST-002', name: 'صنف', categoryId: 'cat_other', unitId: 'un_pc', cost: 5, price: 9, stock: 0, stockByWh: {}, batches: [], minStock: 0, taxRate: 0, active: true }); ERP.inventory.move({ productId: p.id, warehouseId: ERP.inventory.defaultWh(), qty: 4, type: 'opening', unitCost: 5, refType: 'opening', note: 't' }); A.postOpeningStock(20); }
        const keep = { accounts: C('accounts').count(), users: C('users').count(), units: C('units').count(), categories: C('categories').count(), paymentMethods: C('paymentMethods').count(), warehouses: C('warehouses').count() };
        const bad = await throws(() => ERP.setupWizard.wipeDemo({ confirm: 'نعم' })); if (!bad) throw new Error('wrong confirmation word accepted');
        if (!P.count()) throw new Error('refused wipe removed data');
        const r = ERP.setupWizard.wipeDemo({ confirm: ERP.setupWizard.WORD });
        ['products', 'customers', 'suppliers', 'sales', 'purchases', 'journal', 'stockMoves', 'expenses', 'payments'].forEach(n => { if (C(n).count()) throw new Error(`${n} not empty (${C(n).count()})`); });
        Object.entries(keep).forEach(([n, k]) => { if (C(n).count() !== k) throw new Error(`${n} changed ${k} → ${C(n).count()}`); });
        tbOk();
        const g = A.balance('inventory'), v = ERP.inventory.valuation().totalValue; if (!near(g, 0) || !near(v, 0) || !near(g, v)) throw new Error(`GL ${g} / valuation ${v}`);
        if (ERP.db.peekSeq('sale') !== 1 || ERP.db.peekSeq('PRD') !== 1) throw new Error(`counters not reset (sale ${ERP.db.peekSeq('sale')}, PRD ${ERP.db.peekSeq('PRD')})`);
        return `${r.total} سجل حُذف · الحسابات ${keep.accounts} والمستخدمون ${keep.users} باقون · TB متوازن · GL = التقييم = 0`;
      } finally { await ERP.db.import(snap, { mode: 'replace' }); ERP.settings.load(); }
    });
  });
})();
