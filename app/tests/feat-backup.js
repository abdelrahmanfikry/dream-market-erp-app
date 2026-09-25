/* ==========================================================================
   Tests: auto backup (folder / Drive), WhatsApp providers, daily report
   - no network: provider requests come from pure build* functions
   - ERP.testing is raised while the runner works so shift-close listeners and
     schedulers (autobackup / Z summary / daily report) stay quiet
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  if (ERP.tests && ERP.tests.run && !ERP.tests.__quiet) {
    const run = ERP.tests.run;
    ERP.tests.run = async function (...a) { ERP.testing = true; try { return await run.apply(this, a); } finally { ERP.testing = false; } };
    ERP.tests.__quiet = true;
  }
  ERP.testSuites = ERP.testSuites || [];
  ERP.testSuites.push((t, h) => {
    const { u, near } = h; const wa = () => ERP.whatsapp, ab = () => ERP.autoBackup;
    const DAY = '2001-02-03', ctx = {};

    t('واتساب: توحيد الأرقام بكود الدولة', () => {
      const n = x => wa().normalize(x, '20');
      const cases = [['01012345678', '201012345678'], ['+20 101 234 5678', '201012345678'], ['00201012345678', '201012345678'], ['1012345678', '201012345678'], ['٠١٠١٢٣٤٥٦٧٨', '201012345678'], ['201012345678', '201012345678'], ['966501234567', '966501234567'], ['123', '']];
      cases.forEach(([i, o]) => { if (n(i) !== o) throw new Error(`${i} → ${n(i)} (المتوقع ${o})`); });
      const l = wa().parseList('010-1234-5678، 01122223333\n01012345678', '20');
      if (l.length !== 2 || l[1] !== '201122223333') throw new Error('parseList ' + l.join(','));
      const k = wa().parseKeys('01012345678:abc123, 01122223333 : 999', '20');
      if (k['201012345678'] !== 'abc123' || k['201122223333'] !== '999') throw new Error('parseKeys');
      return `${cases.length} حالة + قائمة + مفاتيح CallMeBot`;
    });

    t('واتساب: بناء طلبات المزودين (بدون شبكة)', () => {
      const txt = 'تقرير "اليوم"\nسطر 2 & 50%';
      const link = wa().buildLink('201012345678', txt);
      if (link !== 'https://wa.me/201012345678?text=' + encodeURIComponent(txt)) throw new Error('wa.me');
      const cmb = new URL(wa().buildCallmebot('201012345678', txt, 'k&1'));
      if (cmb.host !== 'api.callmebot.com' || cmb.searchParams.get('text') !== txt || cmb.searchParams.get('apikey') !== 'k&1' || cmb.searchParams.get('phone') !== '201012345678') throw new Error('callmebot');
      const c1 = wa().buildCloud({ waCloudPhoneId: '123', waCloudToken: 'TOK', waCloudMode: 'template', waCloudTemplate: 'daily_report', waCloudLang: 'ar' }, '201012345678', 'أ\n\nب    ج\t' + 'x'.repeat(2000));
      const b1 = JSON.parse(c1.init.body); const p1 = b1.template.components[0].parameters[0].text;
      if (c1.url !== 'https://graph.facebook.com/v20.0/123/messages' || c1.init.headers.Authorization !== 'Bearer TOK' || b1.type !== 'template' || b1.template.name !== 'daily_report' || b1.template.language.code !== 'ar') throw new Error('cloud template');
      if (p1.length > 1024 || /[\n\t]| {2,}/.test(p1) || !p1.startsWith('أ | ب ج')) throw new Error('template param not compact: ' + p1.slice(0, 20));
      const b2 = JSON.parse(wa().buildCloud({ waCloudPhoneId: '1', waCloudToken: 'T', waCloudMode: 'text' }, '2010', txt).init.body);
      if (b2.type !== 'text' || b2.text.body !== txt || b2.to !== '2010') throw new Error('cloud text');
      const w1 = wa().buildWebhook({ waWebhookUrl: 'https://gw.example/send', waWebhookMethod: 'POST', waWebhookBody: '{"to":"{phone}","body":"{text}"}' }, '2010', txt);
      const j = JSON.parse(w1.init.body); if (j.to !== '2010' || j.body !== txt || w1.init.headers['Content-Type'] !== 'application/json') throw new Error('webhook json');
      const w2 = wa().buildWebhook({ waWebhookUrl: 'https://gw.example/send', waWebhookBody: 'token=X&to={phone}&body={text}' }, '2010', txt);
      if (new URLSearchParams(w2.init.body).get('body') !== txt || w2.init.headers['Content-Type'] !== 'application/x-www-form-urlencoded') throw new Error('webhook form');
      const w3 = wa().buildWebhook({ waWebhookUrl: 'https://gw.example/s?p={phone}&t={text}', waWebhookMethod: 'GET' }, '2010', txt);
      if (new URL(w3.url).searchParams.get('t') !== txt || w3.init.method !== 'GET') throw new Error('webhook get');
      return 'wa.me · CallMeBot · Cloud (قالب/نص) · Webhook (JSON/form/GET)';
    });

    t('النسخ التلقائي: اسم الملف وتنظيفه', () => {
      const d = new Date(2026, 8, 5, 7, 4);
      const n1 = ab().fileName({ storeName: 'سوبر ماركت الأحلام', branchCode: 'MAIN' }, d);
      if (n1 !== 'سوبر_ماركت_الأحلام-MAIN-2026-09-05_0704.json') throw new Error(n1);
      const n2 = ab().fileName({ storeName: 'a/b:c*?"<>|', branchCode: '' }, d);
      if (n2 !== 'abc-MAIN-2026-09-05_0704.json' || /[\\/:*?"<>|]/.test(n2)) throw new Error(n2);
      if (!n1.startsWith(ab().prefix({ storeName: 'سوبر ماركت الأحلام', branchCode: 'MAIN' }))) throw new Error('prefix');
      if (!ab().due('both', 'shift') || !ab().due('daily', 'daily') || ab().due('shift', 'daily') || ab().due('manual', 'shift')) throw new Error('schedule match');
      return n1;
    });

    t('Google Drive: ترميز gzip→base64 وفكّه واستعادة الملف', async () => {
      const snap = ERP.db.export(['settings', 'products']); const json = JSON.stringify(snap);
      const enc = await ab().encode(json);
      if (typeof CompressionStream !== 'undefined' && (!enc.gz || /[^A-Za-z0-9+/=]/.test(enc.data))) throw new Error('not gzip/base64');
      const back = await ab().decode(enc);
      if (back !== json) throw new Error('roundtrip mismatch');
      const body = JSON.parse(ab().buildDriveBody({ token: 'S3cr3t', name: 'x.json', store: 's', branch: 'b', keep: 7 }, enc));
      if (body.token !== 'S3cr3t' || body.name !== 'x.json' || body.gz !== enc.gz || body.keep !== 7 || !body.data) throw new Error('payload shape');
      const again = JSON.parse(await ab().decode(body)); if (!again.collections || !again.collections.products) throw new Error('restore shape');
      const code = ab().appsScript("ab'c\\d"); if (!code.includes("const TOKEN = 'abcd';") || !code.includes('Utilities.ungzip') || !code.includes('function doPost')) throw new Error('apps script');
      return enc.gz ? `${Math.round(json.length / 1024)} KB → ${Math.round(enc.data.length / 1024)} KB base64` : 'CompressionStream غير متاح — JSON عادي';
    });

    t('التقرير اليومي: تجهيز بيانات يوم اختبار (ملغاة + تحصيل)', () => {
      ctx.shift = ERP.shifts.current() || ERP.shifts.open({ openingCash: 0 });
      const wh = ERP.inventory.defaultWh();
      ctx.p = ERP.db.collection('products').insert({ code: 'TST-DR1', name: 'صنف تقرير يومي', categoryId: 'cat_other', unitId: 'un_pc', cost: 6, price: 10, stock: 0, stockByWh: {}, batches: [], minStock: 0, taxRate: 0, active: true });
      ERP.inventory.move({ productId: ctx.p.id, warehouseId: wh, qty: 100, type: 'opening', unitCost: 6, refType: 'opening', note: 'test' });
      ctx.cust = ERP.crm.create({ name: 'عميل تقرير يومي', phone: '01000000001', creditLimit: 1000 });
      const at = hh => `${DAY}T${hh}:00:00`, line = q => [{ productId: ctx.p.id, name: 'صنف تقرير يومي', qty: q, price: 10 }];
      ERP.sales.create({ cart: line(3), payments: [{ method: 'cash', amount: 50 }], date: at('09') });          // 30 cash, change 20
      ERP.sales.create({ cart: line(2), payments: [{ method: 'card', amount: 20 }], date: at('10') });          // 20 card
      const v = ERP.sales.create({ cart: line(5), payments: [{ method: 'cash', amount: 50 }], date: at('11') }); // 50 → voided
      ERP.sales.void(v.id, 'test', 'test');
      ERP.sales.create({ cart: line(4), customerId: ctx.cust.id, payments: [{ method: 'credit', amount: 0 }], date: at('12') }); // 40 credit
      ERP.crm.receivePayment({ customerId: ctx.cust.id, amount: 25, method: 'cash', date: at('13') });        // receipt → allocation on the credit sale
      return 'نقدي 30 · بطاقة 20 · ملغاة 50 · آجل 40 · تحصيل 25';
    });

    t('التقرير اليومي: الأرقام تطابق حركة اليوم', () => {
      const { text, data: d } = ERP.dailyReport.build(DAY, { drSales: true, drPayments: true, drTop: true });
      const pm = Object.fromEntries(d.payments.map(p => [p.method, p.total]));
      const chk = [['الفواتير', d.count, 3], ['الإجمالي', d.gross, 90], ['الصافي', d.net, 90], ['المرتجعات', d.returns, 0], ['مجمل الربح', d.grossProfit, 36], ['الهامش', d.margin, 40], ['نقدية المبيعات', d.cashSales, 30], ['نقدي (طرق الدفع)', pm.cash, 30], ['بطاقة', pm.card, 20], ['آجل', pm.credit, 40], ['التحصيلات', d.receipts, 25], ['النقدية المتوقعة', d.expectedCash, 55]];
      chk.forEach(([n, a, b]) => { if (!near(a, b)) throw new Error(`${n}: ${a} ≠ ${b}`); });
      if (d.top[0].name !== 'صنف تقرير يومي' || !near(d.top[0].qty, 9) || !near(d.top[0].total, 90)) throw new Error('top product ' + JSON.stringify(d.top[0]));
      if (d.deltaNet !== null) throw new Error('no sales on the previous day → no %');
      if (!text.includes(u.fmtMoney(90)) || !text.includes('صنف تقرير يومي')) throw new Error('text');
      const next = ERP.dailyReport.build('2001-02-04').data; if (!near(next.deltaNet, -100) || next.count !== 0) throw new Error(`next day Δ ${next.deltaNet}`);
      return `3 فواتير (الملغاة مستبعدة) · صافي 90 · نقدية 30 (بدون تحصيل 25 المخصص) · متوقع 55`;
    });

    t('التقرير اليومي: نص مضغوط لقالب Cloud API', () => {
      const { text } = ERP.dailyReport.build(DAY);
      const c = wa().compact(text);
      if (c.length > 1024 || /\n/.test(c)) throw new Error('compact');
      const z = ERP.dailyReport.zText(ctx.shift.id); if (!z.includes(ctx.shift.no)) throw new Error('Z text');
      return `${text.length} → ${c.length} حرف`;
    });
  });
})();
