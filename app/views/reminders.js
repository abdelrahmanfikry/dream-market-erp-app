/* ==========================================================================
   View: Debt reminders center (WhatsApp / SMS links, templates, log)
   ========================================================================== */
window.ERP = window.ERP || {}; ERP.views = ERP.views || {};
(function () {
  const u = ERP.utils; const e = u.escapeHtml;
  let el, table, filter = 'overdue';
  const DEFAULT_TPL = 'مرحباً {name}،\nنود تذكيركم برصيد مستحق لدى {store} بقيمة {balance} منذ {days} يوم.\nنشكر تعاونكم ونسعد بخدمتكم دائماً.\n{phone}';

  function phoneIntl(p) { let d = u.normalizeDigits(p || '').replace(/\D/g, ''); if (!d) return ''; if (d.startsWith('00')) d = d.slice(2); else if (d.startsWith('0')) d = (ERP.settings.get('countryCode') || '20') + d.slice(1); return d; }
  function message(c) {
    const s = ERP.settings.all(); const tpl = s.reminderTemplate || DEFAULT_TPL;
    const open = ERP.sales.unpaid().filter(x => x.customerId === c.id); const oldest = open.length ? u.sortBy(open, 'date')[0].date : c.updatedAt;
    return tpl.replace(/\{name\}/g, c.name).replace(/\{store\}/g, s.storeName).replace(/\{balance\}/g, u.fmtMoney(c.balance)).replace(/\{days\}/g, u.daysBetween(oldest, new Date())).replace(/\{phone\}/g, s.phone || '').replace(/\{invoices\}/g, open.length);
  }
  function rows() {
    const min = u.num(ERP.settings.get('reminderMinBalance'));
    const overdue = new Set(ERP.crm.overdue().map(o => o.customer.id));
    return ERP.crm.debtors().filter(c => c.balance >= min).filter(c => filter === 'all' || (filter === 'overdue' ? overdue.has(c.id) : filter === 'phone' ? !!c.phone : true)).map(c => { const open = ERP.sales.unpaid().filter(x => x.customerId === c.id); const oldest = open.length ? u.sortBy(open, 'date')[0].date : c.updatedAt; return { ...c, days: u.daysBetween(oldest, new Date()), open: open.length, overdue: overdue.has(c.id) }; });
  }
  function refresh() { if (!table) return; const r = rows(); table.setRows(r); $('#rm-kpis', el).innerHTML = [['users', 'primary', 'عملاء مطالَبون', r.length], ['sack-dollar', 'danger', 'إجمالي المستحق', u.fmtMoney(u.sum(r, 'balance'))], ['clock', 'warning', 'متأخرون', r.filter(x => x.overdue).length], ['paper-plane', 'success', 'ذُكِّروا خلال 7 أيام', r.filter(x => x.lastReminderAt && u.daysBetween(x.lastReminderAt, new Date()) <= 7).length]].map(k => `<div class="card kpi"><div class="kpi-icon ${k[1]}"><i class="fas fa-${k[0]}"></i></div><div class="kpi-body"><div class="kpi-label">${k[2]}</div><div class="kpi-value" style="font-size:1.2rem">${k[3]}</div></div></div>`).join(''); }
  function markReminded(id, channel) { const c = ERP.crm.get(id); ERP.db.collection('customers').update(id, { lastReminderAt: u.now(), reminders: [...(c.reminders || []).slice(-19), { at: u.now(), channel, balance: c.balance, by: ERP.auth.current()?.name }] }); ERP.audit.log('customer.reminder', `تذكير ${channel} لـ ${c.name} (${u.fmtMoney(c.balance)})`, id); }
  function send(id, channel) {
    const c = ERP.crm.get(id); const msg = message(c); const ph = phoneIntl(c.phone);
    if (channel === 'wa') { if (!ph) return ERP.ui.warn('لا يوجد رقم هاتف'); window.open(`https://wa.me/${ph}?text=${encodeURIComponent(msg)}`, '_blank'); }
    else if (channel === 'sms') { if (!ph) return ERP.ui.warn('لا يوجد رقم هاتف'); window.open(`sms:${c.phone}?body=${encodeURIComponent(msg)}`, '_blank'); }
    else if (channel === 'copy') { u.copy(msg); ERP.ui.success('تم نسخ الرسالة'); }
    markReminded(id, channel);
  }
  async function bulk() {
    const list = table.getSelected().length ? rows().filter(r => table.getSelected().includes(r.id)) : rows().filter(r => r.phone);
    if (!list.length) return ERP.ui.warn('لا عملاء بأرقام هواتف');
    let i = 0;
    const h = ERP.ui.modal({ title: `إرسال جماعي عبر واتساب (${list.length})`, icon: 'paper-plane', body: `<div class="alert alert-info mb-3"><i class="fas fa-circle-info"></i> واتساب لا يسمح بالإرسال الآلي؛ سيفتح النظام محادثة كل عميل بالرسالة جاهزة — اضغط إرسال ثم «التالي».</div><div id="bk-cur" class="card card-body"></div>`, footer: `<button class="btn" data-a="c">إنهاء</button><button class="btn btn-outline" data-a="skip">تخطي</button><button class="btn btn-success" data-a="next"><i class="fab fa-whatsapp"></i> فتح واتساب والتالي</button>` });
    const show = () => { if (i >= list.length) { h.close(); ERP.ui.success('انتهت القائمة'); refresh(); return; } const c = list[i]; h.$('#bk-cur').innerHTML = `<div class="flex items-center gap-3 mb-2"><div class="avatar">${e(u.initials(c.name))}</div><div><div class="fw-700">${e(c.name)} <span class="muted text-sm">(${i + 1}/${list.length})</span></div><div class="text-sm muted num">${e(c.phone)} · ${u.fmtMoney(c.balance)} · ${c.days} يوم</div></div></div><pre style="white-space:pre-wrap;font-family:inherit;background:var(--bg-subtle);padding:.75rem;border-radius:8px;font-size:.9rem">${e(message(c))}</pre>`; };
    show();
    h.$('[data-a=c]').onclick = () => { h.close(); refresh(); };
    h.$('[data-a=skip]').onclick = () => { i++; show(); };
    h.$('[data-a=next]').onclick = () => { send(list[i].id, 'wa'); i++; show(); };
  }
  async function editTemplate() {
    if (!ERP.auth.require('settings.manage')) return;
    const r = await ERP.ui.form({ title: 'قالب رسالة التذكير', icon: 'message', size: 'lg', values: { reminderTemplate: ERP.settings.get('reminderTemplate') || DEFAULT_TPL, reminderMinBalance: ERP.settings.get('reminderMinBalance') || 0, countryCode: ERP.settings.get('countryCode') || '20' }, fields: [{ name: 'reminderTemplate', label: 'نص الرسالة', type: 'textarea', cols: 2, help: 'المتغيرات: {name} {store} {balance} {days} {invoices} {phone}' }, { name: 'reminderMinBalance', label: 'الحد الأدنى للرصيد لإرسال تذكير', type: 'number', min: 0 }, { name: 'countryCode', label: 'كود الدولة لواتساب', placeholder: '20' }], onSubmit: d => { ERP.settings.set(d); } });
    if (r) { ERP.ui.success('تم الحفظ'); refresh(); }
  }
  ERP.views.reminders = { send, message, refresh };
  ERP.audit.LABELS['customer.reminder'] = 'تذكير بمديونية';
  ERP.router.register({
    id: 'reminders', title: 'تذكيرات المديونيات', icon: 'bell-concierge', section: 'الأطراف', order: 3, perm: 'customers.receipt',
    badge() { const n = ERP.crm.overdue().filter(o => !o.customer.lastReminderAt || u.daysBetween(o.customer.lastReminderAt, new Date()) > 7).length; return n ? { text: n, kind: 'danger' } : null; },
    render(root) {
      el = root;
      root.innerHTML = `<div class="page-header"><div><h2><i class="fas fa-bell-concierge"></i> تذكيرات المديونيات</h2><div class="desc">رسائل واتساب/SMS جاهزة للعملاء المدينين مع سجل التذكيرات</div></div><div class="page-actions"><div class="pills" id="rm-f"><button class="pill ${filter === 'overdue' ? 'active' : ''}" data-f="overdue">المتأخرون</button><button class="pill" data-f="phone">لهم هاتف</button><button class="pill" data-f="all">كل المدينين</button></div><button class="btn btn-outline" id="rm-tpl"><i class="fas fa-message"></i> قالب الرسالة</button><button class="btn btn-success" id="rm-bulk"><i class="fab fa-whatsapp"></i> إرسال جماعي</button></div></div><div class="kpi-grid mb-4" id="rm-kpis"></div><div id="rm-table"></div>`;
      table = ERP.ui.table({ el: '#rm-table', rows: [], selectable: true, exportName: 'تذكيرات', defaultSort: { key: 'days', dir: 'desc' }, columns: [
        { key: 'name', label: 'العميل', render: (c, t) => `<div class="flex items-center gap-2"><div class="avatar sm">${e(u.initials(c.name))}</div><div><div class="fw-600">${u.highlight(c.name, t)}</div><div class="text-xs muted num">${e(c.phone || 'بدون هاتف')}</div></div></div>`, text: c => c.name + ' ' + (c.phone || '') },
        { key: 'balance', label: 'المستحق', num: true, render: c => `<strong class="text-danger">${u.fmtNum(c.balance)}</strong>`, footer: r => `<span class="text-danger">${u.fmtMoney(u.sum(r, 'balance'))}</span>` },
        { key: 'days', label: 'منذ (يوم)', num: true, render: c => c.overdue ? u.badge(`${c.days} يوم`, c.days > 60 ? 'danger' : 'warning') : `<span class="muted">${c.days} يوم</span>` },
        { key: 'open', label: 'فواتير مفتوحة', num: true },
        { key: 'lastReminderAt', label: 'آخر تذكير', render: c => c.lastReminderAt ? `<span class="text-xs">${u.relTime(c.lastReminderAt)} <span class="muted">(${(c.reminders || []).length})</span></span>` : '<span class="text-xs muted">لم يُذكَّر</span>' },
        { id: 'a', label: '', sortable: false, export: false, class: 'actions', render: c => `<button class="btn btn-sm btn-soft-success" data-s="wa" data-id="${c.id}" ${c.phone ? '' : 'disabled'}><i class="fab fa-whatsapp"></i> واتساب</button><button class="btn btn-icon btn-sm btn-ghost" data-s="sms" data-id="${c.id}" data-tip="SMS" ${c.phone ? '' : 'disabled'}><i class="fas fa-comment-sms"></i></button><button class="btn btn-icon btn-sm btn-ghost" data-s="copy" data-id="${c.id}" data-tip="نسخ الرسالة"><i class="fas fa-copy"></i></button><button class="btn btn-icon btn-sm btn-ghost" data-s="pay" data-id="${c.id}" data-tip="تحصيل"><i class="fas fa-hand-holding-dollar"></i></button>` },
      ], onRowClick: c => ERP.views.customers.details(c.id) });
      $('#rm-f', root).onclick = ev => { const b = ev.target.closest('.pill'); if (!b) return; filter = b.dataset.f; $$('.pill', ev.currentTarget).forEach(x => x.classList.toggle('active', x === b)); refresh(); };
      $('#rm-tpl', root).onclick = editTemplate; $('#rm-bulk', root).onclick = bulk;
      root.addEventListener('click', ev => { const b = ev.target.closest('[data-s][data-id]'); if (!b || b.disabled) return; ev.stopPropagation(); if (b.dataset.s === 'pay') ERP.views.customers.receiptDialog(b.dataset.id); else { send(b.dataset.id, b.dataset.s); refresh(); } });
    },
    onShow() { refresh(); },
  });
  ERP.bus.on('db:change', u.debounce(ev => { if (table && ERP.router.current() === 'reminders' && ['customers', 'sales', 'payments'].includes(ev?.collection)) refresh(); }, 300));
})();
