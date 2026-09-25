/* ==========================================================================
   ERP.dailyReport — daily sales summary → managers on WhatsApp (ERP.whatsapp)
   - build(date) → { text, data } from ERP.reports / ERP.agg (void invoices excluded,
     receipt allocations excluded from sale cash, gift cards are not cash)
   - scheduler: checks every minute, sends once per day (kv 'dr.lastSent'); if the app
     was closed at send time, yesterday's report is sent once on the next launch
   - optional shift Z summary on shift close (db:change on 'shifts' → closed)
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  const u = ERP.utils; const e = u.escapeHtml;
  ERP.settings.extend({ drEnabled: false, drTime: '23:00', drSales: true, drPayments: true, drTop: true, drTopN: 5, drStock: true, drExpiry: true, drDebts: true, drShifts: true, drShiftZ: false, drCatchUp: true });
  const kvGet = k => ERP.db.kvGet(k).catch(() => null), kvSet = (k, v) => ERP.db.kvSet(k, v).catch(() => { });
  const pad = n => String(n).padStart(2, '0');
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const dayOf = v => (ERP.agg && ERP.agg.dayOf ? ERP.agg.dayOf(v) : u.toISODate(v));
  const toDay = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : iso(v ? u.parseDate(v) || new Date() : new Date()));
  const shiftDay = (day, n) => { const [y, m, d] = day.split('-').map(Number); return iso(new Date(y, m - 1, d + n)); };
  const M = n => u.fmtMoney(u.round(n));
  const IN_TYPES = ['in', 'deposit', 'from_bank']; // same direction rules as ERP.shifts.cashMove

  const dr = {
    /** all numbers for one day (YYYY-MM-DD, local) */
    data(date) {
      const s = ERP.settings.all(); const day = toDay(date), prevDay = shiftDay(day, -1);
      const sum = ERP.reports.salesSummary(day, day), prev = ERP.reports.salesSummary(prevDay, prevDay);
      const sales = ERP.db.collection('sales').all().filter(x => x.status !== 'void' && dayOf(x.date) === day);
      const cashSales = u.round(u.sum(sales, x => ERP.shifts._drawer(x).cash)); // drawer logic: change once, receipt allocations & gift excluded, returns negative
      const recs = ERP.db.collection('payments').all().filter(p => p.type === 'receipt' && dayOf(p.date) === day);
      const exp = ERP.reports.expensesSummary(day, day); const expCash = u.round(u.sum(exp.list.filter(x => x.method === 'cash'), 'amount'));
      const cms = ERP.db.collection('cashMoves').all().filter(c => dayOf(c.date) === day);
      const cmIn = u.round(u.sum(cms.filter(c => IN_TYPES.includes(c.type)), 'amount')), cmOut = u.round(u.sum(cms.filter(c => !IN_TYPES.includes(c.type)), 'amount'));
      const receipts = u.round(u.sum(recs, 'amount')), receiptsCash = u.round(u.sum(recs.filter(p => p.method === 'cash'), 'amount'));
      const low = ERP.inventory.lowStock(), expi = ERP.inventory.expiring(), od = ERP.crm.overdue(), open = ERP.shifts.anyOpen();
      const odSorted = u.sortBy(od, x => u.num(x.customer.balance), 'desc');
      return {
        day, prevDay, store: s.storeName, branch: s.branchName || s.branchCode || '',
        count: sum.count, gross: u.round(sum.gross), returns: u.round(sum.returns), returnsCount: sum.returnsCount, net: u.round(sum.net), discounts: u.round(sum.discounts),
        grossProfit: u.round(sum.grossProfit), margin: u.round(sum.margin, 1), avg: u.round(sum.avg), prevNet: u.round(prev.net), deltaNet: prev.net ? u.round((sum.net - prev.net) / Math.abs(prev.net) * 100, 1) : null,
        payments: ERP.reports.paymentMix(day, day).filter(p => Math.abs(p.total) > 0.004).map(p => ({ method: p.method, name: p.name, total: u.round(p.total) })),
        cashSales, receipts, receiptsCount: recs.length, receiptsCash, expenses: u.round(exp.total), expensesCash: expCash, cashIn: cmIn, cashOut: cmOut,
        expectedCash: u.round(cashSales + receiptsCash + cmIn - cmOut - expCash),
        top: ERP.reports.topProducts(day, day, Math.max(1, Math.min(10, u.num(s.drTopN, 5)))).filter(p => p.total > 0).map(p => ({ name: p.name, qty: p.qty, total: u.round(p.total) })),
        lowCount: low.length, lowNames: low.slice(0, 4).map(p => p.name), outCount: ERP.inventory.outOfStock().length,
        expiringCount: expi.filter(x => !x.expired).length, expiredCount: expi.filter(x => x.expired).length, expiryDays: u.num(s.expiryAlertDays, 30),
        overdueCount: od.length, overdueTotal: u.round(u.sum(od, x => u.num(x.customer.balance))), overdueTop: odSorted.slice(0, 3).map(x => ({ name: x.customer.name, balance: u.round(x.customer.balance), days: x.daysOverdue })),
        openShifts: open.map(x => ({ no: x.no, user: x.userName, since: x.openedAt })),
      };
    },
    /** → { text, data } — blocks follow the drSales/drPayments/… switches (opts override) */
    build(date, opts = {}) {
      const s = { ...ERP.settings.all(), ...opts }; const d = dr.data(date); const L = [];
      const pct = v => `${v > 0 ? '▲' : v < 0 ? '▼' : ''}${Math.abs(v)}%`;
      L.push(`📊 التقرير اليومي — ${d.store}${d.branch ? ' (' + d.branch + ')' : ''}`, `📅 ${u.dayName(d.day + 'T12:00:00')} ${u.fmtDate(d.day + 'T12:00:00')}`);
      if (s.drSales) {
        L.push('', `🧾 الفواتير: ${d.count}${d.count ? ` · متوسط ${M(d.avg)}` : ''}`, `إجمالي المبيعات: ${M(d.gross)}`);
        if (d.returns) L.push(`المرتجعات: ${M(d.returns)} (${d.returnsCount})`);
        L.push(`✅ صافي المبيعات: ${M(d.net)}${d.deltaNet !== null ? ` (${pct(d.deltaNet)} عن أمس)` : d.prevNet === 0 && d.net ? ' (لا مبيعات أمس)' : ''}`, `مجمل الربح: ${M(d.grossProfit)} (هامش ${d.margin}%)`);
        if (d.discounts) L.push(`الخصومات: ${M(d.discounts)}`);
      }
      if (s.drPayments) {
        L.push('', '💳 طرق الدفع:'); if (d.payments.length) d.payments.forEach(p => L.push(`• ${p.name}: ${M(p.total)}`)); else L.push('• لا يوجد');
        L.push(`تحصيلات العملاء: ${M(d.receipts)}${d.receiptsCount ? ` (${d.receiptsCount})` : ''}`, `المصروفات: ${M(d.expenses)}`);
        if (d.cashIn || d.cashOut) L.push(`إيداع/سحب نقدي: +${M(d.cashIn)} / -${M(d.cashOut)}`);
        L.push(`💵 النقدية المتوقعة من حركة اليوم: ${M(d.expectedCash)}`);
      }
      if (s.drTop && d.top.length) { L.push('', '🔝 الأكثر مبيعاً:'); d.top.forEach((p, i) => L.push(`${i + 1}. ${p.name} — ${u.fmtQty(p.qty)} · ${M(p.total)}`)); }
      const al = [];
      if (s.drStock && d.lowCount) al.push(`📦 منخفض المخزون: ${d.lowCount}${d.outCount ? ` (نافد ${d.outCount})` : ''} — ${d.lowNames.join('، ')}${d.lowCount > d.lowNames.length ? '…' : ''}`);
      if (s.drExpiry && (d.expiringCount || d.expiredCount)) al.push(`⏳ صلاحية خلال ${d.expiryDays} يوم: ${d.expiringCount} دفعة${d.expiredCount ? ` · منتهية: ${d.expiredCount}` : ''}`);
      if (s.drDebts && d.overdueCount) al.push(`👥 ديون متأخرة: ${M(d.overdueTotal)} (${d.overdueCount} عميل) — ${d.overdueTop.map(x => `${x.name} ${M(x.balance)}`).join('، ')}`);
      if (s.drShifts && d.openShifts.length) al.push(`🕐 ورديات مفتوحة: ${d.openShifts.length} — ${d.openShifts.map(x => `${x.no} ${x.user}`).join('، ')}`);
      if (al.length) L.push('', '⚠️ تنبيهات:', ...al);
      return { text: L.join('\n'), data: d };
    },
    /** send one day's report to the managers (interactive = from a click) */
    async send(date, { interactive = false, reason = 'manual' } = {}) {
      const { text, data } = dr.build(date); let res, err = '';
      try { res = await ERP.whatsapp.send(ERP.whatsapp.recipients(), text, { interactive, title: `التقرير اليومي ${data.day}` }); } catch (ex) { err = ex.message; res = []; }
      const ok = !err && res.some(x => x.ok);
      await kvSet('dr.last', { at: u.now(), day: data.day, reason, ok, err: err || res.filter(x => !x.ok).map(x => `${x.phone}: ${x.err}`).join('، ') });
      if (!ok && ERP.notifications) ERP.notifications.push({ type: 'danger', title: 'تعذر إرسال التقرير اليومي', text: err || 'راجع إعدادات واتساب', link: 'settings', params: { sec: 'dailyreport' }, key: 'drfail_' + data.day });
      return { ok, err, results: res, text };
    },
    /** Z summary text for a shift (same content as the shift screen's owner message) */
    zText(shiftId) {
      const r = ERP.shifts.report(shiftId); if (!r) return ''; const sh = r.shift, s = ERP.settings.all();
      return `📊 ملخص وردية ${sh.no} — ${s.storeName}${s.branchName ? ' (' + s.branchName + ')' : ''}\nالكاشير: ${sh.userName}\nمن ${u.fmtDateTime(sh.openedAt)}${sh.closedAt ? ' إلى ' + u.fmtDateTime(sh.closedAt) : ' (مفتوحة)'}\n\n🧾 الفواتير: ${sh.salesCount}\n💰 المبيعات: ${M(sh.salesTotal)}\nالمرتجعات: ${M(sh.returnsTotal)}\nالخصومات: ${M(r.discounts)}${r.voids ? `\nفواتير ملغاة: ${r.voids}` : ''}\n${Object.entries(r.byMethod).map(([m, v]) => `• ${ERP.sales.methodName(m)}: ${M(v)}`).join('\n')}\n\n💵 النقدية المتوقعة: ${M(r.expected)}${sh.status === 'closed' ? `\n✅ الفعلي: ${M(sh.closingCash)} (${sh.difference >= 0 ? 'زيادة' : 'عجز'} ${M(Math.abs(sh.difference))})` : ''}${r.topItems.length ? `\n\n🔝 ${r.topItems.slice(0, 3).map(i => i.name + ' (' + u.fmtQty(i.qty) + ')').join('، ')}` : ''}`;
    },
    ready() { return !!(ERP.db && ERP.db.isReady && ERP.db.isReady() && !ERP.db.isReadOnly() && ERP.app && ERP.app._shell && ERP.auth && ERP.auth.current() && ERP.whatsapp && !ERP.testing); },
    _launched: false,
    /** every minute while the app is open */
    async tick(now = new Date()) {
      if (!dr.ready() || dr._busy) return;
      const s = ERP.settings.all(); if (!s.drEnabled) return;
      dr._busy = true;
      try {
        const today = iso(now), yesterday = shiftDay(today, -1), hm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
        const last = await kvGet('dr.lastSent');
        if (!dr._launched) { // first check after launch: catch up yesterday once if the app was closed at send time
          dr._launched = true; const base = last || (await kvGet('dr.armed'));
          if (s.drCatchUp && base && base < yesterday) { await kvSet('dr.lastSent', yesterday); await dr.send(yesterday, { reason: 'catch-up' }); }
        }
        if (hm >= (s.drTime || '23:00') && ((await kvGet('dr.lastSent')) || '') < today) { await kvSet('dr.lastSent', today); await dr.send(today, { reason: 'scheduled' }); }
      } finally { dr._busy = false; }
    },
    async last() { return kvGet('dr.last'); },
  };
  ERP.dailyReport = dr;

  /* shift closed → Z summary to managers (listening to db writes; shift files untouched) */
  const seen = new Set();
  ERP.bus.on('db:change', ev => {
    if (!ev || ev.collection !== 'shifts' || ev.op !== 'update' || !ev.doc || ev.doc.status !== 'closed' || seen.has(ev.doc.id)) return;
    if (!ev.doc.closedAt || Date.now() - new Date(ev.doc.closedAt).getTime() > 3 * 60 * 1000) return;
    seen.add(ev.doc.id);
    if (!ERP.settings.get('drShiftZ') || !dr.ready()) return;
    const id = ev.doc.id;
    setTimeout(() => { const t = dr.zText(id); if (t) ERP.whatsapp.send(ERP.whatsapp.recipients(), t, { title: 'ملخص الوردية' }).catch(err => ERP.ui && ERP.ui.warn('ملخص الوردية: ' + err.message)); }, 1200);
  });
  setTimeout(() => { dr.tick().catch(() => { }); setInterval(() => dr.tick().catch(() => { }), 60 * 1000); }, 25 * 1000);

  /* ---------- settings section ---------- */
  const BLOCKS = [['drSales', 'المبيعات والربح والمقارنة بالأمس'], ['drPayments', 'طرق الدفع والتحصيلات والمصروفات والنقدية'], ['drTop', 'الأصناف الأكثر مبيعاً'], ['drStock', 'المخزون المنخفض'], ['drExpiry', 'قرب انتهاء الصلاحية'], ['drDebts', 'الديون المتأخرة'], ['drShifts', 'الورديات المفتوحة']];
  ERP.settingsSections = ERP.settingsSections || [];
  ERP.settingsSections.push({
    id: 'dailyreport', icon: 'chart-simple', label: 'التقرير اليومي (واتساب)',
    render(s, h) {
      const prov = (ERP.whatsapp && ERP.whatsapp.PROVIDERS[s.waProvider || 'link']) || '';
      return `<div class="alert alert-info mb-3"><i class="fas fa-circle-info"></i> يُرسل ملخص مبيعات اليوم لأرقام المديرين عبر: <strong>${e(prov)}</strong> (غيّرها من قسم «واتساب»). يعمل الإرسال التلقائي والبرنامج مفتوح؛ إن كان مغلقاً وقت الإرسال يُرسل تقرير الأمس مرة واحدة عند الفتح التالي.${(s.waProvider || 'link') === 'link' ? ' مع «رابط واتساب» ستظهر رسالة تنبيه وزر لفتح واتساب بدل الإرسال الآلي.' : ''}</div>`
        + h.row('تفعيل الإرسال اليومي', '', h.sw('drEnabled', s.drEnabled))
        + h.row('موعد الإرسال', '', h.inp('drTime', s.drTime, 'time'))
        + h.row('إرسال تقرير الأمس الفائت عند الفتح', 'إذا كان البرنامج مغلقاً وقت الإرسال', h.sw('drCatchUp', s.drCatchUp))
        + h.row('إرسال ملخص الوردية (Z) عند إغلاقها', 'لأرقام المديرين نفسها', h.sw('drShiftZ', s.drShiftZ))
        + `<h4 class="mt-3 mb-2">محتوى التقرير</h4>` + BLOCKS.map(([k, l]) => h.row(l, '', h.sw(k, s[k]))).join('')
        + h.row('عدد الأصناف الأكثر مبيعاً', '5 – 10', h.inp('drTopN', s.drTopN, 'number', 'min="1" max="10" style="max-width:90px"'))
        + `<div class="divider"></div><div class="flex gap-2 flex-wrap items-center"><input type="date" id="dr-date" value="${u.todayISO()}" style="max-width:170px"><button type="button" class="btn btn-outline" id="dr-preview"><i class="fas fa-eye"></i> معاينة التقرير</button><button type="button" class="btn btn-soft-success" id="dr-send"><i class="fab fa-whatsapp"></i> إرسال الآن</button></div><div class="text-sm mt-2" id="dr-last"></div><div class="text-xs muted mt-1">احفظ الإعدادات قبل التجربة.</div>`;
    },
    bind(body) {
      const $b = sel => body.querySelector(sel); const day = () => $b('#dr-date').value || u.todayISO();
      const showLast = () => dr.last().then(l => { const x = $b('#dr-last'); if (x) x.innerHTML = l ? `آخر إرسال: ${l.ok ? '<span class="text-success">نجح</span>' : '<span class="text-danger">فشل</span>'} · تقرير ${e(l.day)} · ${u.relTime(l.at)}${l.err ? ` · <span class="text-danger">${e(l.err)}</span>` : ''}` : 'لم يُرسل أي تقرير بعد'; });
      showLast();
      $b('#dr-preview').onclick = () => { try { const { text } = dr.build(day()); const h = ERP.ui.view('معاينة التقرير اليومي', `<pre style="white-space:pre-wrap;direction:rtl;font-family:inherit;line-height:1.8;background:var(--bg-soft,#f8fafc);padding:1rem;border-radius:8px">${e(text)}</pre><div class="text-xs muted mt-2">${text.length} حرف${(ERP.settings.get('waProvider') === 'cloud' && ERP.settings.get('waCloudMode') !== 'text') ? ' · مع قالب Cloud API يُرسل مضغوطاً في سطر واحد حتى 1024 حرفاً' : ''}</div>`, { icon: 'chart-simple', footer: '<button class="btn" data-act="view-close">إغلاق</button><button class="btn btn-outline" data-act="dr-copy"><i class="fas fa-copy"></i> نسخ</button><button class="btn btn-success" data-act="dr-go"><i class="fab fa-whatsapp"></i> إرسال</button>' }); h.$('[data-act=dr-copy]').onclick = () => { u.copy(text); ERP.ui.success('تم النسخ'); }; h.$('[data-act=dr-go]').onclick = () => { h.close(); $b('#dr-send').click(); }; } catch (err) { ERP.ui.error(err.message); } };
      $b('#dr-send').onclick = async () => { const r = await dr.send(day(), { interactive: true }); if (r.ok) ERP.ui.success('تم إرسال التقرير'); else ERP.ui.error(r.err || r.results.filter(x => !x.ok).map(x => `${x.phone}: ${x.err}`).join(' · ')); showLast(); };
    },
    save(patch) {
      if ('drTopN' in patch) patch.drTopN = Math.min(10, Math.max(1, Math.round(u.num(patch.drTopN, 5))));
      if ('drTime' in patch && !/^\d{2}:\d{2}$/.test(patch.drTime || '')) patch.drTime = '23:00';
      if (patch.drEnabled) kvGet('dr.armed').then(a => { if (!a) kvSet('dr.armed', u.todayISO()); });
    },
  });
})();
