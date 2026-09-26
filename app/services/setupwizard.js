/* ==========================================================================
   ERP.setupWizard — first-run setup wizard (معالج الإعداد)
   Shown once after the first admin login while setup isn't completed (kv flag 'setupWizard');
   re-open from الإعدادات ← معالج الإعداد, the dashboard button or Ctrl+K. Never during ERP.testing.
   Steps (all skippable): 1 بيانات المحل · 2 الطباعة · 3 البيانات التجريبية (wipe) · 4 الاستيراد (Import Center)
                          5 المستخدمون · 6 الترخيص · 7 تم
   wipeDemo(): clears products + every transactional collection (sales, purchases, stock moves, journal …),
   keeps chart of accounts, settings, users/roles, units, categories, warehouses, payment methods, expense
   categories, employees, branches → journal empty (TB balanced) and no stock (GL inventory = valuation = 0).
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  const u = ERP.utils; const e = u.escapeHtml;
  const KV = 'setupWizard';
  const WORD = 'مسح';
  /* collections cleared by «البدء على نظيف» (others may push their transactional collections here) */
  const WIPE = ['products', 'stockMoves', 'stocktakes', 'transfers', 'customers', 'suppliers', 'sales', 'purchases', 'payments', 'expenses', 'journal', 'attendance', 'payroll', 'advances', 'shifts', 'heldCarts', 'quotations', 'assets', 'cashMoves', 'giftCards', 'orders', 'promotions', 'priceChanges', 'labelQueue', 'etaQueue', 'importBatches', 'notifications', 'cheques', 'cashCounts'];
  /* document counters reset with them (never the kept collections' counters, e.g. EMP) */
  const SEQ_OF = { sale: 'sales', return: 'sales', purchase: 'purchases', PRET: 'purchases', receipt: 'payments', payment: 'payments', expense: 'expenses', journal: 'journal', transfer: 'transfers', stocktake: 'stocktakes', quotation: 'quotations', order: 'orders', SHIFT: 'shifts', PRD: 'products', CUS: 'customers', SUP: 'suppliers', AST: 'assets', IMP: 'importBatches', cheque: 'cheques' };
  const STEPS = [['store', 'store', 'بيانات المحل'], ['print', 'print', 'الطباعة'], ['demo', 'broom', 'البيانات التجريبية'], ['import', 'file-import', 'الاستيراد'], ['users', 'users', 'المستخدمون'], ['license', 'key', 'الترخيص'], ['done', 'flag-checkered', 'تم']];
  let flag = null; // { done, dismissed, at } cached from kv

  const wiz = {
    WIPE, WORD, STEPS,
    async load() { try { flag = (await ERP.db.kvGet(KV)) || {}; } catch { flag = {}; } return flag; },
    isDone() { return !!(flag && flag.done); },
    async mark(patch) { flag = { ...(flag || {}), ...patch, at: u.now() }; try { await ERP.db.kvSet(KV, flag); } catch { /* */ } wiz.injectDashboard(); },

    /** demo-data footprint (for step 3) */
    demoInfo() {
      const names = new Set(ERP.seed.demoProducts().map(p => p.name));
      const C = n => ERP.db.collection(n);
      return { demoProducts: C('products').all().filter(p => names.has(p.name)).length, products: C('products').count(), customers: C('customers').count(), suppliers: C('suppliers').count(), sales: C('sales').count(), purchases: C('purchases').count(), journal: C('journal').count() };
    },
    /** «مسح البيانات التجريبية والبدء على نظيف» — confirm must equal WORD. Returns { removed: {collection: n}, total } */
    wipeDemo({ confirm } = {}) {
      if (String(confirm || '').trim() !== WORD) throw new Error(`اكتب كلمة «${WORD}» للتأكيد`);
      if (!ERP.auth.can('settings.manage') || !ERP.auth.can('backup.manage')) throw new Error('هذا الإجراء لمدير النظام فقط');
      if (ERP.db.isReadOnly()) throw new Error('النظام مفتوح في نافذة أخرى — أغلقها أولاً');
      const removed = {}; let total = 0; const known = new Set(ERP.db.KNOWN);
      WIPE.forEach(n => { if (!known.has(n) && !ERP.db.collection(n).count()) return; const c = ERP.db.collection(n); const k = c.count(); if (k) { c.clear(); removed[n] = k; total += k; } });
      const seq = ERP.db.getMeta('seq') || {};
      Object.keys(seq).forEach(k => { if (SEQ_OF[k] && WIPE.includes(SEQ_OF[k])) ERP.db.setSeq(k, 0); });
      ERP.db.raiseSeqs();
      ERP.db.setMeta('demoSeeded', true); // never re-seed demo products into the clean store
      ERP.audit.log('backup.restore', `معالج الإعداد: مسح البيانات التجريبية (${total} سجل)`);
      ERP.bus.emit('db:change', { collection: 'products', op: 'bulk' });
      return { removed, total };
    },

    /* ---------- auto show ---------- */
    /** after login (main.js): first admin login + setup not done/dismissed + store not in real use → open once no other modal is up */
    async maybeShow() {
      if (ERP.testing) return;
      await wiz.load(); wiz.injectDashboard();
      const me = ERP.auth.current(); if (!me || !ERP.auth.can('settings.manage') || !ERP.auth.can('users.manage')) return;
      if (flag.done || flag.dismissed) return;
      const real = ERP.db.collection('sales').count() > 0 || ERP.db.collection('purchases').count() > 0;
      if (real) { await wiz.mark({ done: true, auto: 'existing-data' }); return; } // an upgraded install already in use — don't nag
      let tries = 0;
      const tick = () => { if (ERP.testing || ++tries > 600) return; if (document.body.classList.contains('modal-open') || document.getElementById('login')) return setTimeout(tick, 1000); wiz.open(); };
      setTimeout(tick, 1500);
    },
    injectDashboard() {
      const pa = document.querySelector('#view-dashboard .page-actions'); if (!pa) return;
      let b = pa.querySelector('#dash-setup');
      if (wiz.isDone() || !ERP.auth.can('settings.manage')) { if (b) b.remove(); return; }
      if (!b) { b = u.el('<button class="btn btn-soft-primary btn-outline" id="dash-setup"><i class="fas fa-wand-magic-sparkles"></i> معالج الإعداد</button>'); b.onclick = () => wiz.open(); pa.insertBefore(b, pa.firstChild); }
    },

    /* ---------- the wizard ---------- */
    open(startAt = 0) {
      if (ERP.testing) return null;
      if (!ERP.auth.can('settings.manage')) { ERP.ui.error('معالج الإعداد لمدير النظام فقط'); return null; }
      if (document.getElementById('wiz-root')) return null;
      let step = Math.max(0, Math.min(STEPS.length - 1, startAt)); let finished = false;
      const h = ERP.ui.modal({ title: 'معالج إعداد المتجر', icon: 'wand-magic-sparkles', size: 'lg', body: '<div id="wiz-root"></div>', footer: '<button class="btn btn-ghost" data-w="prev"><i class="fas fa-arrow-right"></i> السابق</button><span class="flex-1"></span><button class="btn" data-w="skip">تخطي</button><button class="btn btn-primary" data-w="next">التالي <i class="fas fa-arrow-left"></i></button>', onClose: () => { if (!finished && !wiz.isDone()) wiz.mark({ dismissed: true }); } });
      const root = h.$('#wiz-root');
      const S = () => ERP.settings.all();
      const val = sel => { const x = root.querySelector(sel); return x ? x.value : ''; };
      const saveStep = () => {
        const id = STEPS[step][0];
        if (id === 'store') { const name = val('#wz-name').trim(); if (!name) throw new Error('اسم المحل مطلوب'); ERP.settings.set({ storeName: name, phone: val('#wz-phone').trim(), address: val('#wz-address').trim(), taxNumber: val('#wz-tax').trim(), brandColor: val('#wz-color') || S().brandColor }); ERP.bus.emit('settings:change', ERP.settings.all()); }
        if (id === 'print') { const patch = { receiptWidth: +val('#wz-width') || 80, invoiceType: val('#wz-type') || 'receipt' }; const pr = root.querySelector('#wz-printer'); if (pr) patch.printerReceipt = pr.value; ERP.settings.set(patch); }
      };
      const bar = () => `<div class="flex gap-1 mb-2">${STEPS.map((x, i) => `<div title="${e(x[2])}" style="flex:1;height:6px;border-radius:4px;background:${i <= step ? 'var(--primary)' : 'rgba(127,127,127,.2)'}"></div>`).join('')}</div><div class="flex items-center justify-between mb-3 text-sm"><strong><i class="fas fa-${STEPS[step][1]} text-primary"></i> ${step + 1}/${STEPS.length} — ${e(STEPS[step][2])}</strong><span class="muted">${Math.round(step / (STEPS.length - 1) * 100)}%</span></div>`;
      const fg = (label, input, full) => `<div class="form-group"${full ? ' style="grid-column:1/-1"' : ''}><label>${label}</label>${input}</div>`;
      const views = {
        store: s => `<p class="muted mb-3">هذه البيانات تظهر على الفواتير والإيصالات وشاشة الدخول.</p><div class="form-row cols-2">${fg('اسم المحل *', `<input id="wz-name" value="${e(s.storeName)}">`)}${fg('الهاتف', `<input id="wz-phone" type="tel" value="${e(s.phone)}">`)}${fg('العنوان', `<input id="wz-address" value="${e(s.address)}">`, true)}${fg('الرقم الضريبي', `<input id="wz-tax" value="${e(s.taxNumber)}">`)}${fg('لون الهوية', `<input id="wz-color" type="color" value="${e(s.brandColor || '#16a34a')}" style="width:64px;height:38px">`)}</div><div class="setting-row"><div class="info"><strong>الشعار</strong><span>صورة مربعة واضحة (تُصغّر تلقائياً)</span></div><div class="flex gap-3 items-center"><div class="avatar lg" id="wz-logo" style="border-radius:12px">${s.logo ? `<img src="${e(s.logo)}">` : '<i class="fas fa-store"></i>'}</div><input type="file" accept="image/*" id="wz-logo-file" style="max-width:220px"></div></div>`,
        print: s => `<div class="form-row cols-2">${fg('نوع الطباعة الافتراضي', `<select id="wz-type"><option value="receipt" ${s.invoiceType !== 'a4' ? 'selected' : ''}>إيصال حراري</option><option value="a4" ${s.invoiceType === 'a4' ? 'selected' : ''}>فاتورة A4</option></select>`)}${fg('عرض ورق الإيصال', `<select id="wz-width"><option value="80" ${+s.receiptWidth !== 58 ? 'selected' : ''}>80 مم</option><option value="58" ${+s.receiptWidth === 58 ? 'selected' : ''}>58 مم</option></select>`)}${window.desktop && window.desktop.printers ? fg('طابعة الإيصالات (طباعة صامتة)', '<select id="wz-printer"><option value="">— نافذة الطباعة —</option></select>', true) : ''}</div>${window.desktop ? '' : '<div class="alert alert-info"><i class="fas fa-desktop"></i> الطباعة الصامتة واختيار الطابعة متاحان في تطبيق سطح المكتب.</div>'}<button type="button" class="btn btn-outline" id="wz-test"><i class="fas fa-print"></i> طباعة تجريبية</button>`,
        demo: () => { const d = wiz.demoInfo(); return `<p class="mb-2">عند أول تشغيل يضيف النظام <strong>بيانات تجريبية</strong> (منتجات وأرصدة) لتجربة البيع والتقارير. قبل البدء الفعلي امسحها لتبدأ على نظيف.</p><div class="grid grid-3 gap-2 mb-3 text-sm">${[['منتجات', d.products + (d.demoProducts ? ` (${d.demoProducts} تجريبي)` : '')], ['عملاء', d.customers], ['موردون', d.suppliers], ['فواتير بيع', d.sales], ['أوامر شراء', d.purchases], ['قيود', d.journal]].map(([l, v]) => `<div class="card card-body" style="padding:.6rem"><div class="muted text-xs">${l}</div><strong class="num">${e(v)}</strong></div>`).join('')}</div><div class="alert alert-warning"><i class="fas fa-triangle-exclamation"></i> سيتم حذف: المنتجات، العملاء، الموردون، المبيعات، المشتريات، حركات المخزون، المصروفات، القيود، الورديات والطلبات. <br>يبقى: شجرة الحسابات، الإعدادات، المستخدمون، الوحدات، الفئات، المخازن وطرق الدفع. تُؤخذ نسخة احتياطية داخلية قبل المسح.</div><div class="form-group"><label>للتأكيد اكتب كلمة «${WORD}»</label><input id="wz-word" autocomplete="off" style="max-width:200px"></div><button type="button" class="btn btn-danger" id="wz-wipe"><i class="fas fa-broom"></i> مسح البيانات التجريبية والبدء على نظيف</button>`; },
        import: () => `<p class="mb-3">استورد بياناتك من Excel — كل زر يفتح معالج الاستيراد بنموذج جاهز للتنزيل ومعاينة قبل الحفظ وإمكانية التراجع.</p><div class="grid grid-2 gap-2">${[['products', 'boxes-stacked', 'المنتجات والأسعار والأرصدة'], ['customers', 'users', 'العملاء وأرصدتهم'], ['suppliers', 'truck-field', 'الموردون وأرصدتهم'], ['opening', 'scale-balanced', 'الأرصدة الافتتاحية']].filter(x => ERP.importTypes && ERP.importTypes.get(x[0])).map(([id, ic, l]) => `<button type="button" class="btn btn-outline btn-block" data-imp="${id}" style="justify-content:flex-start;padding:.8rem"><i class="fas fa-${ic}"></i> ${l}</button>`).join('')}</div><p class="text-xs muted mt-3">يمكنك الرجوع لاحقاً من القائمة: مركز الاستيراد.</p>`,
        users: () => { const roles = ERP.auth.roles(); return `<p class="mb-2">أضف الكاشير والموظفين — كل مستخدم يدخل برمز PIN خاص وصلاحيات دوره.</p><div class="mb-3">${ERP.auth.users().map(x => `<div class="list-row"><div class="avatar" style="background:${e(x.avatarColor || '#1a56f5')};color:#fff">${e(u.initials(x.name))}</div><div class="grow"><div class="title">${e(x.name)}</div><div class="sub">${e((roles.find(r => r.id === x.roleId) || {}).name || '')}${x.active === false ? ' · معطل' : ''}</div></div></div>`).join('')}</div><div class="form-row cols-3">${fg('الاسم', '<input id="wz-u-name">')}${fg('رمز الدخول (4 أرقام+)', '<input id="wz-u-pin" type="password" inputmode="numeric" autocomplete="new-password" style="direction:ltr">')}${fg('الدور', `<select id="wz-u-role">${roles.filter(r => r.id !== 'admin').map(r => `<option value="${e(r.id)}" ${r.id === 'cashier' ? 'selected' : ''}>${e(r.name)}</option>`).join('')}</select>`)}</div><button type="button" class="btn btn-primary" id="wz-u-add"><i class="fas fa-user-plus"></i> إضافة مستخدم</button>`; },
        license: () => `<div id="wz-lic">${ERP.license ? ERP.license.panelHtml() : ''}</div>`,
        done: s => { const lic = ERP.license ? ERP.license.statusText() : ''; return `<div class="text-center mb-3"><i class="fas fa-circle-check text-success" style="font-size:3rem"></i><h3 class="mt-2">المتجر جاهز!</h3></div><div class="grid grid-2 gap-2 text-sm mb-3">${[['المحل', s.storeName], ['الهاتف', s.phone || '—'], ['الطباعة', `${s.invoiceType === 'a4' ? 'A4' : 'إيصال'} ${s.receiptWidth} مم`], ['المنتجات', ERP.db.collection('products').count()], ['العملاء', ERP.db.collection('customers').count()], ['المستخدمون', ERP.auth.users().length], ['الترخيص', lic]].map(([l, v]) => `<div class="list-row"><span class="muted">${l}</span><strong class="grow" style="text-align:left">${e(v)}</strong></div>`).join('')}</div><div class="text-center"><button type="button" class="btn btn-success btn-lg" id="wz-start"><i class="fas fa-cash-register"></i> ابدأ البيع</button></div>`; },
      };
      const render = () => {
        const id = STEPS[step][0];
        root.innerHTML = bar() + views[id](S());
        h.$('[data-w=prev]').style.visibility = step ? 'visible' : 'hidden';
        h.$('[data-w=skip]').style.display = id === 'done' ? 'none' : '';
        h.$('[data-w=next]').innerHTML = id === 'done' ? 'إنهاء <i class="fas fa-check"></i>' : 'التالي <i class="fas fa-arrow-left"></i>';
        bind(id);
      };
      const bind = id => {
        if (id === 'store') { const f = root.querySelector('#wz-logo-file'); f.onchange = async ev => { const file = ev.target.files[0]; if (!file) return; const img = await u.resizeImage(await u.readFile(file, 'dataURL'), 240); ERP.settings.set({ logo: img }); root.querySelector('#wz-logo').innerHTML = `<img src="${e(img)}">`; ERP.bus.emit('settings:change', ERP.settings.all()); }; }
        if (id === 'print') {
          const sel = root.querySelector('#wz-printer'); if (sel) window.desktop.printers().then(list => (list || []).forEach(pr => { const o = document.createElement('option'); o.value = pr.name; o.textContent = pr.name + (pr.isDefault ? ' (افتراضية)' : ''); o.selected = pr.name === S().printerReceipt; sel.appendChild(o); })).catch(() => { });
          root.querySelector('#wz-test').onclick = () => { try { saveStep(); } catch (ex) { return ERP.ui.error(ex.message); } const s = S(); const it = [{ name: 'صنف تجريبي 1', qty: 2, price: 10, discount: 0, total: 20 }, { name: 'صنف تجريبي 2', qty: 1, price: 15.5, discount: 0, total: 15.5 }]; const doc = { no: 'TEST-000001', date: u.now(), type: 'sale', customerName: 'عميل تجريبي', items: it, subtotal: 35.5, discount: 0, tax: 0, total: 35.5, paid: 35.5, due: 0, payments: [{ method: 'cash', amount: 35.5 }], change: 0, status: 'paid' }; if (s.invoiceType === 'a4' && ERP.print.invoice) ERP.print.invoice(doc, {}); else ERP.print.receipt(doc, {}); };
        }
        if (id === 'demo') root.querySelector('#wz-wipe').onclick = async ev => {
          const w = root.querySelector('#wz-word').value;
          if (w.trim() !== WORD) return ERP.ui.warn(`اكتب «${WORD}» في خانة التأكيد`);
          if (!await ERP.ui.confirm('سيتم حذف كل المنتجات والحركات والقيود الحالية نهائياً. متابعة؟', { danger: true, okText: 'مسح والبدء على نظيف' })) return;
          ev.target.disabled = true;
          try { await ERP.backup.snapshotLocal('pre-setup-wipe'); const r = wiz.wipeDemo({ confirm: w }); await ERP.db.flush(); ERP.ui.success(`تم المسح (${r.total} سجل) — المتجر نظيف الآن`); render(); }
          catch (ex) { ERP.ui.error(ex.message); ev.target.disabled = false; }
        };
        if (id === 'import') root.onclick = ev => { const b = ev.target.closest('[data-imp]'); if (b && ERP.views.imports) ERP.views.imports.open(b.dataset.imp); };
        else root.onclick = null;
        if (id === 'users') root.querySelector('#wz-u-add').onclick = () => {
          try { const name = val('#wz-u-name').trim(), pin = u.normalizeDigits(val('#wz-u-pin').trim()); if (!name) throw new Error('اكتب اسم المستخدم'); if (!/^\d{4,}$/.test(pin)) throw new Error('رمز الدخول أرقام فقط (4 أو أكثر)'); ERP.auth.createUser({ name, pin, roleId: val('#wz-u-role') }); ERP.ui.success(`تمت إضافة ${name}`); render(); }
          catch (ex) { ERP.ui.error(ex.message); }
        };
        if (id === 'license' && ERP.license) { const lr = root.querySelector('#wz-lic'); ERP.license.bindPanel(lr, () => render()); }
        if (id === 'done') root.querySelector('#wz-start').onclick = () => finish(true);
      };
      const finish = async pos => { finished = true; await wiz.mark({ done: true, dismissed: false }); ERP.audit.log('settings.update', 'اكتمال معالج الإعداد'); h.close(); if (pos && ERP.auth.can('pos.use')) ERP.router.go('pos'); else ERP.router.go('dashboard'); };
      h.footer.onclick = ev => {
        const b = ev.target.closest('[data-w]'); if (!b) return; const a = b.dataset.w;
        if (a === 'prev' && step > 0) { step--; render(); }
        if (a === 'skip' && step < STEPS.length - 1) { step++; render(); }
        if (a === 'next') { if (STEPS[step][0] === 'done') return finish(false); try { saveStep(); } catch (ex) { return ERP.ui.error(ex.message); } step++; render(); }
      };
      render();
      return h;
    },
  };
  ERP.setupWizard = wiz;

  ERP.bus.on('view:show', v => { if (v && v.id === 'dashboard') wiz.injectDashboard(); });
  ERP.bus.on('auth:login', () => { if (ERP.ui.cmdk && !wiz._cmdk) { wiz._cmdk = true; ERP.ui.cmdk.addAction({ icon: 'wand-magic-sparkles', title: 'معالج الإعداد', perm: 'settings.manage', run: () => wiz.open() }); } });

  /* settings section: معالج الإعداد */
  ERP.settingsSections = ERP.settingsSections || [];
  ERP.settingsSections.push({
    id: 'setup', icon: 'wand-magic-sparkles', label: 'معالج الإعداد',
    render(s, h) { return `<p class="mb-3">معالج خطوة بخطوة لتجهيز المتجر: بيانات المحل، الطباعة، مسح البيانات التجريبية، استيراد البيانات، المستخدمين والترخيص.</p>${h.row('حالة الإعداد', '', wiz.isDone() ? '<span class="badge badge-success">مكتمل</span>' : '<span class="badge badge-warning">غير مكتمل</span>')}<div class="flex gap-2 flex-wrap mt-3">${STEPS.slice(0, -1).map((x, i) => `<button type="button" class="btn btn-outline" data-wz="${i}"><i class="fas fa-${x[1]}"></i> ${h.e(x[2])}</button>`).join('')}</div><button type="button" class="btn btn-primary mt-3" data-wz="0"><i class="fas fa-wand-magic-sparkles"></i> فتح المعالج من البداية</button>`; },
    bind(body, h) { if (flag === null) wiz.load().then(() => h.rerender()); body.addEventListener('click', ev => { const b = ev.target.closest('[data-wz]'); if (b) wiz.open(+b.dataset.wz); }); },
  });
})();
