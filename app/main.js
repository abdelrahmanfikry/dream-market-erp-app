/* ==========================================================================
   ERP.app — bootstrap: migrate → seed → login → shell → router
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  const u = ERP.utils; const e = u.escapeHtml;

  const app = {
    applyTheme(t) { document.documentElement.setAttribute('data-theme', t); ERP.bus.emit('theme:change', t); },
    toggleTheme() { const t = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'; ERP.settings.set({ theme: t }); app.applyTheme(t); },

    /* ---------- login screen ---------- */
    showLogin(locked = false) {
      if (document.getElementById('login')) return;
      if (locked && ERP.auth.current() && !ERP.auth.isLocked()) { ERP.auth.lock(); if (document.getElementById('login')) return; } // persist the lock (F5 keeps it) — auth:lock re-enters here
      document.querySelector('.app').classList.add('locked');
      const users = ERP.auth.users().filter(x => x.active !== false);
      const s = ERP.settings.all();
      let selected = locked && ERP.auth.current() ? ERP.auth.current().id : (users[0] || {}).id;
      let pin = '';
      const el = u.el(`<div class="login-screen" id="login">
        <div class="login-hero"><div><div class="flex items-center gap-3"><div class="brand-logo" style="width:52px;height:52px;font-size:1.5rem">${s.logo ? `<img src="${e(s.logo)}" style="width:100%;height:100%;object-fit:contain;border-radius:10px">` : '<i class="fas fa-store"></i>'}</div><div><div class="fw-800 text-lg" style="color:#fff">${e(s.storeName)}</div><div class="text-xs" style="color:#94a3b8">Dream Market ERP</div></div></div>
          <h1>نظام إدارة متكامل<br>لمتجرك بالكامل</h1><p>نقطة بيع سريعة، مخزون دقيق، حسابات بقيد مزدوج، عملاء وموردون، موظفون وتقارير — كله في مكان واحد ويعمل بدون إنترنت.</p>
          <div class="login-features">${[['cash-register', 'نقطة بيع مع باركود وورديات'], ['warehouse', 'مخزون متعدد المخازن وصلاحية'], ['scale-balanced', 'محاسبة قيد مزدوج تلقائية'], ['users', 'عملاء، آجل، ونقاط ولاء'], ['truck', 'مشتريات وموردون'], ['chart-pie', 'تقارير وتحليلات ذكية']].map(f => `<div class="login-feature"><i class="fas fa-${f[0]}"></i>${f[1]}</div>`).join('')}</div></div>
          <div class="text-xs" style="color:#64748b">© ${new Date().getFullYear()} — يعمل محلياً على جهازك · بياناتك ملكك</div></div>
        <div class="login-form-wrap"><div class="login-form">
          <h2>${locked ? 'الشاشة مقفلة' : 'تسجيل الدخول'}</h2><p class="sub">${locked ? 'أدخل رمزك للمتابعة' : 'اختر المستخدم وأدخل رمز الدخول'}</p>
          <div class="user-picker" id="lg-users">${users.map(x => `<button class="user-pick ${x.id === selected ? 'active' : ''}" data-id="${x.id}"><div class="avatar" style="background:${x.avatarColor || 'var(--primary)'};color:#fff">${e(u.initials(x.name))}</div><span>${e(x.name)}</span><small>${e((ERP.auth.role(x) || {}).name || '')}</small></button>`).join('')}</div>
          <div class="form-group"><label>رمز الدخول (PIN)</label><input type="password" id="lg-pin" inputmode="numeric" autocomplete="off" style="font-size:1.6rem;letter-spacing:.4em;text-align:center;direction:ltr" placeholder="••••"></div>
          <div class="pin-pad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button data-k="${n}">${n}</button>`).join('')}<button data-k="del"><i class="fas fa-delete-left"></i></button><button data-k="0">0</button><button data-k="ok" class="btn-primary" style="background:var(--primary);color:#fff"><i class="fas fa-arrow-left"></i></button></div>
          <label class="checkbox mt-4"><input type="checkbox" id="lg-remember"> تذكرني على هذا الجهاز</label>
          <div id="lg-err" class="alert alert-danger mt-3 hidden"></div>
          ${users.length === 1 && users[0].mustChangePin && !locked ? '<div class="alert alert-info mt-3 text-sm"><i class="fas fa-circle-info"></i> أول دخول: المستخدم <strong>المدير</strong> والرمز الافتراضي <strong class="num">1234</strong> — غيّره فوراً بعد الدخول.</div>' : ''}
          ${locked ? '<button class="btn btn-ghost btn-block mt-3" id="lg-logout">تسجيل خروج بدلاً من ذلك</button>' : ''}
        </div></div></div>`);
      document.body.appendChild(el);
      const pinInp = el.querySelector('#lg-pin'); const err = el.querySelector('#lg-err');
      // while this screen is up no global shortcut (F1, POS keys, Ctrl+K, modal Esc…) may fire: swallow keys outside it (capture) and stop keys inside it from bubbling
      const KEYS = ['keydown', 'keypress', 'keyup'];
      const trap = ev => { if (el.contains(ev.target)) return; ev.stopImmediatePropagation(); if (!/^F(5|12)$/.test(ev.key)) { ev.preventDefault(); if (ev.type === 'keydown') pinInp.focus(); } };
      const stop = ev => ev.stopPropagation();
      KEYS.forEach(t => { window.addEventListener(t, trap, true); el.addEventListener(t, stop); });
      const release = () => KEYS.forEach(t => window.removeEventListener(t, trap, true));
      el.querySelector('#lg-users').onclick = ev => { const b = ev.target.closest('.user-pick'); if (!b) return; selected = b.dataset.id; el.querySelectorAll('.user-pick').forEach(x => x.classList.toggle('active', x === b)); pinInp.focus(); };
      let busy = false;
      const submit = async () => {
        if (!selected || busy) return; busy = true;
        const prev = ERP.auth.current(); const prevId = prev ? prev.id : null;
        let r; try { r = await ERP.auth.login(selected, pinInp.value, { remember: el.querySelector('#lg-remember').checked }); } catch (ex) { r = { ok: false, error: ex.message }; } finally { busy = false; }
        if (!r.ok) { err.textContent = r.error; err.classList.remove('hidden'); pinInp.value = ''; pinInp.focus(); el.querySelector('.login-form').style.animation = 'none'; return; }
        release();
        if (app._shell && prevId && prevId !== r.user.id) { location.reload(); return; } // UI (sidebar, permission-gated views) was built for the previous user
        el.style.animation = 'fadeOut .25s forwards'; setTimeout(() => el.remove(), 240);
        document.querySelector('.app').classList.remove('locked');
        if (!app._shell) app.afterLogin(r);
        else ERP.ui.success(`مرحباً ${r.user.name}`);
      };
      el.querySelector('.pin-pad').onclick = ev => { const b = ev.target.closest('[data-k]'); if (!b) return; const k = b.dataset.k; if (k === 'del') pinInp.value = pinInp.value.slice(0, -1); else if (k === 'ok') submit(); else pinInp.value += k; };
      pinInp.addEventListener('keydown', ev => { if (ev.key === 'Enter') submit(); });
      const lo = el.querySelector('#lg-logout'); if (lo) lo.onclick = () => { release(); ERP.auth.logout(); location.reload(); };
      setTimeout(() => pinInp.focus(), 60);
    },

    afterLogin(r) {
      app._shell = true;
      app.buildShell();
      ERP.router.renderSidebar();
      ERP.router.start();
      ERP.notifications.scan();
      ERP.backup.checkAuto();
      if (r.mustChangePin) setTimeout(() => app.forcePinChange(), 600);
      const st = ERP.db.getMeta('legacyStats'); if (st && !ERP.db.getMeta('legacyNotified')) { ERP.db.setMeta('legacyNotified', true); ERP.ui.toast(`تم استيراد بيانات النظام القديم: ${st.products} منتج، ${st.sales} فاتورة، ${st.customers} عميل. راجع أسعار التكلفة للمنتجات.`, 'success', { title: 'تم الترحيل', duration: 10000 }); }
    },
    async forcePinChange() {
      const me = ERP.auth.current();
      const r = await ERP.ui.form({ title: 'غيّر رمز الدخول الافتراضي', icon: 'shield-halved', fields: [{ name: 'i', type: 'html', cols: 2, html: '<div class="alert alert-warning"><i class="fas fa-triangle-exclamation"></i> أنت تستخدم الرمز الافتراضي 1234. لحماية بياناتك، اختر رمزاً جديداً (4 أرقام أو أكثر).</div>' }, { name: 'pin', label: 'الرمز الجديد', type: 'password', required: true }, { name: 'pin2', label: 'تأكيد الرمز', type: 'password', required: true }], submitText: 'حفظ الرمز', onSubmit: d => { if (d.pin !== d.pin2) throw new Error('الرمزان غير متطابقين'); if (d.pin === '1234') throw new Error('اختر رمزاً غير الافتراضي'); return ERP.auth.changePin(me.id, null, d.pin); } });
      if (r) ERP.ui.success('تم تحديث الرمز'); else ERP.ui.warn('لم يتم تغيير الرمز — سيُطلب منك لاحقاً');
    },

    /* ---------- app shell ---------- */
    buildShell() {
      const s = ERP.settings.all(); const me = ERP.auth.current(); const role = ERP.auth.role(me);
      const root = document.querySelector('.app');
      root.classList.toggle('sidebar-collapsed', !!s.sidebarCollapsed);
      root.innerHTML = `
        <div class="sidebar-overlay" id="sidebar-overlay"></div>
        <aside class="sidebar"><div class="sidebar-brand"><div class="brand-logo">${s.logo ? `<img src="${e(s.logo)}" style="width:100%;height:100%;object-fit:contain;border-radius:10px">` : '<i class="fas fa-store"></i>'}</div><div class="brand-text"><div class="brand-name" id="brand-name">${e(s.storeName)}</div><div class="brand-sub">Dream Market ERP</div></div></div>
          <nav class="sidebar-nav" id="sidebar-nav"></nav>
          <div class="sidebar-footer"><button class="user-chip" id="user-chip"><div class="avatar" style="background:${me.avatarColor || 'var(--primary)'};color:#fff">${e(u.initials(me.name))}</div><div class="flex-1 min-w-0"><div class="user-chip-name truncate">${e(me.name)}</div><div class="user-chip-role">${e(role ? role.name : '')}</div></div><i class="fas fa-ellipsis-vertical muted"></i></button></div></aside>
        <div class="main">
          <header class="topbar"><button class="topbar-btn" id="sidebar-toggle"><i class="fas fa-bars"></i></button><div class="topbar-title"><i class="fas fa-gauge-high text-primary" id="page-icon"></i><h1 id="page-title">لوحة التحكم</h1></div>
            <div class="topbar-search"><i class="fas fa-magnifying-glass"></i><input type="text" placeholder="بحث سريع… منتج، عميل، فاتورة" id="global-search" readonly><kbd>Ctrl K</kbd></div>
            <div class="topbar-actions"><div class="sync-indicator" id="net-status"><span class="dot"></span><span>متصل</span></div><div class="topbar-clock"><strong id="clock-time"></strong><span id="clock-date"></span></div>
              ${ERP.auth.can('pos.use') ? '<button class="topbar-btn" id="tb-pos" data-tip="نقطة البيع"><i class="fas fa-cash-register"></i></button>' : ''}
              <button class="topbar-btn" id="tb-theme" data-tip="الوضع الليلي"><i class="fas fa-${s.theme === 'dark' ? 'sun' : 'moon'}"></i></button>
              <button class="topbar-btn" id="tb-notif" data-tip="الإشعارات"><i class="fas fa-bell"></i><span class="count-badge hidden" id="notif-count">0</span></button>
              <button class="topbar-btn" id="tb-lock" data-tip="قفل الشاشة"><i class="fas fa-lock"></i></button></div></header>
          <main class="content" id="content"></main></div>
        <div class="panel-drawer" id="notif-panel"><div class="panel-drawer-header"><h3><i class="fas fa-bell text-primary"></i> الإشعارات</h3><div class="flex gap-1"><button class="btn btn-sm btn-ghost" id="notif-read-all">قراءة الكل</button><button class="btn btn-sm btn-ghost" id="notif-clear">مسح</button><button class="modal-close" id="notif-close"><i class="fas fa-xmark"></i></button></div></div><div class="panel-drawer-body" id="notif-body"></div></div>`;
      // sidebar
      $('#sidebar-toggle').onclick = () => { if (u.isMobile()) root.classList.toggle('sidebar-open'); else { root.classList.toggle('sidebar-collapsed'); ERP.settings.set({ sidebarCollapsed: root.classList.contains('sidebar-collapsed') }); } };
      $('#sidebar-overlay').onclick = () => root.classList.remove('sidebar-open');
      $('#global-search').onclick = () => ERP.ui.cmdk.open();
      $('#tb-theme').onclick = () => { app.toggleTheme(); $('#tb-theme i').className = `fas fa-${document.documentElement.getAttribute('data-theme') === 'dark' ? 'sun' : 'moon'}`; };
      $('#tb-lock').onclick = () => ERP.auth.lock();
      const tp = $('#tb-pos'); if (tp) tp.onclick = () => ERP.router.go('pos');
      $('#tb-notif').onclick = () => { $('#notif-panel').classList.toggle('open'); app.renderNotifs(); };
      $('#notif-close').onclick = () => $('#notif-panel').classList.remove('open');
      $('#notif-read-all').onclick = () => { ERP.notifications.markAllRead(); app.renderNotifs(); };
      $('#notif-clear').onclick = () => { ERP.notifications.clear(); app.renderNotifs(); };
      $('#notif-body').onclick = ev => { const it = ev.target.closest('.notif-item'); if (!it) return; const n = ERP.db.collection('notifications').get(it.dataset.id); ERP.notifications.markRead(it.dataset.id); if (n && n.link) { ERP.router.go(n.link, n.params || {}); $('#notif-panel').classList.remove('open'); } app.renderNotifs(); };
      $('#user-chip').onclick = () => app.userMenu();
      app.tick(); setInterval(app.tick, 1000);
      app.updateNotifBadge();
      window.addEventListener('online', app.netStatus); window.addEventListener('offline', app.netStatus); app.netStatus();
      ERP.bus.on('notif:change', app.updateNotifBadge); ERP.bus.on('notif:new', app.updateNotifBadge);
      ERP.bus.on('settings:change', st => { $('#brand-name').textContent = st.storeName; });
      ERP.bus.on('auth:lock', () => app.showLogin(true));
      ERP.bus.on('db:change', u.debounce(() => ERP.router.updateBadges(), 800));
      setInterval(() => { ERP.notifications.scan(); ERP.router.updateBadges(); }, 5 * 60 * 1000);
      // command palette actions
      [{ icon: 'cash-register', title: 'بيع جديد', perm: 'pos.use', run: () => ERP.router.go('pos'), shortcut: 'F1' }, { icon: 'plus', title: 'إضافة منتج', perm: 'products.manage', run: () => ERP.views.products.openForm() }, { icon: 'user-plus', title: 'عميل جديد', perm: 'customers.manage', run: () => ERP.views.customers.openForm() }, { icon: 'truck', title: 'أمر شراء جديد', perm: 'purchases.manage', run: () => ERP.views.purchases.openForm() }, { icon: 'wallet', title: 'تسجيل مصروف', perm: 'expenses.manage', run: () => ERP.views.expenses.openForm() }, { icon: 'sliders', title: 'تسوية مخزون', perm: 'inventory.adjust', run: () => ERP.views.inventory.adjustDialog() }, { icon: 'moon', title: 'تبديل الوضع الليلي', run: () => $('#tb-theme').click() }, { icon: 'lock', title: 'قفل الشاشة', run: () => ERP.auth.lock() }, { icon: 'right-from-bracket', title: 'تسجيل خروج', run: () => app.logout() }, { icon: 'download', title: 'تنزيل نسخة احتياطية', perm: 'backup.manage', run: () => ERP.backup.exportJSON() }].forEach(a => ERP.ui.cmdk.addAction(a));
      document.addEventListener('keydown', ev => { if (ev.key === 'F1' && !document.getElementById('login') && ERP.auth.can('pos.use')) { ev.preventDefault(); ERP.router.go('pos'); } });
    },
    tick() { const d = new Date(); const t = $('#clock-time'), dt = $('#clock-date'); if (t) t.textContent = u.fmtTime(d); if (dt) dt.textContent = `${u.dayName(d)} ${u.fmtDate(d)}`; },
    netStatus() { const el = $('#net-status'); if (!el) return; const on = navigator.onLine; el.classList.toggle('offline', !on); const sync = !!(ERP.cloud && ERP.cloud.status === 'online'); el.querySelector('span:last-child').textContent = on ? (sync ? 'متصل ومتزامن' : 'متصل') : 'بدون إنترنت — يعمل محلياً'; },
    updateNotifBadge() { const n = ERP.notifications.unreadCount(); const b = $('#notif-count'); if (b) { b.textContent = n > 99 ? '99+' : n; b.classList.toggle('hidden', !n); } },
    renderNotifs() { const list = ERP.notifications.all().slice(0, 100); const ic = { danger: ['circle-xmark', 'danger'], warning: ['triangle-exclamation', 'warning'], info: ['circle-info', 'info'], success: ['circle-check', 'success'] }; $('#notif-body').innerHTML = list.length ? list.map(n => { const [i, k] = ic[n.type] || ic.info; return `<div class="notif-item ${n.read ? '' : 'unread'} cursor-pointer" data-id="${n.id}"><div class="notif-icon" style="background:var(--${k}-bg);color:var(--${k})"><i class="fas fa-${i}"></i></div><div class="flex-1"><div class="notif-title">${e(n.title)}</div><div class="notif-text">${e(n.text)}</div><div class="notif-time">${u.relTime(n.at)}</div></div></div>`; }).join('') : '<div class="empty-state"><i class="fas fa-bell-slash"></i><h4>لا إشعارات</h4></div>'; },
    userMenu() {
      const me = ERP.auth.current();
      const h = ERP.ui.modal({ title: e(me.name), icon: 'user', size: 'sm', body: `<div class="text-center mb-3"><div class="avatar lg" style="margin:0 auto .5rem;background:${me.avatarColor || 'var(--primary)'};color:#fff">${e(u.initials(me.name))}</div><div class="muted text-sm">${e((ERP.auth.role(me) || {}).name || '')} · آخر دخول ${u.relTime(me.lastLogin)}</div></div><div class="flex flex-col gap-2"><button class="btn btn-outline btn-block" data-a="pin"><i class="fas fa-key"></i> تغيير رمز الدخول</button><button class="btn btn-outline btn-block" data-a="audit"><i class="fas fa-clipboard-list"></i> نشاطاتي</button><button class="btn btn-outline btn-block" data-a="lock"><i class="fas fa-lock"></i> قفل الشاشة</button><button class="btn btn-danger btn-block" data-a="out"><i class="fas fa-right-from-bracket"></i> تسجيل خروج</button></div>`, footer: null });
      h.body.onclick = async ev => { const b = ev.target.closest('[data-a]'); if (!b) return; h.close(); const a = b.dataset.a; if (a === 'out') app.logout(); if (a === 'lock') ERP.auth.lock(); if (a === 'pin') { const r = await ERP.ui.form({ title: 'تغيير رمز الدخول', icon: 'key', fields: [{ name: 'old', label: 'الرمز الحالي', type: 'password', required: true }, { name: 'pin', label: 'الجديد', type: 'password', required: true }, { name: 'pin2', label: 'تأكيد', type: 'password', required: true }], onSubmit: d => { if (d.pin !== d.pin2) throw new Error('غير متطابق'); return ERP.auth.changePin(me.id, d.old, d.pin); } }); if (r) ERP.ui.success('تم'); } if (a === 'audit') { const list = ERP.audit.byUser(me.id, 50); ERP.ui.view('نشاطاتي الأخيرة', `<div class="timeline">${list.map(x => `<div class="timeline-item"><div class="text-sm"><strong>${e(ERP.audit.label(x.action))}</strong> <span class="muted">${u.relTime(x.at)}</span></div><div class="text-xs muted">${e(x.details)}</div></div>`).join('') || '<p class="muted">لا نشاط</p>'}</div>`); } };
    },
    async logout() { const sh = ERP.shifts.current(); if (sh && !await ERP.ui.confirm('لديك وردية مفتوحة. تسجيل الخروج بدون إغلاقها؟', { okText: 'خروج' })) return; ERP.auth.logout(); location.reload(); },

    /* ---------- boot ---------- */
    async boot() {
      try {
        await ERP.db.init();
        console.info(`[db] storage mode: ${ERP.db.mode()}`);
        ERP.settings.load();
        app.applyTheme(ERP.settings.get('theme') || 'light');
        ERP.seed.ensureReferenceData();
        if (ERP.giftcards) ERP.giftcards.ensureMethod();
        ERP.settings.load();
        await ERP.auth.init(); // stored session accepted only if its token matches the one in the db kv store
        // legacy migration
        if (ERP.migrate.hasLegacy()) { try { ERP.migrate.run(); } catch (err) { console.error('migration failed', err); } }
        // demo data on very first run (nothing at all)
        if (ERP.db.collection('products').count() === 0 && ERP.db.collection('sales').count() === 0 && !ERP.db.getMeta('demoSeeded') && !ERP.db.getMeta('legacyMigrated')) {
          const wh = ERP.inventory.defaultWh(); let value = 0;
          ERP.seed.demoProducts().forEach(p => { const np = ERP.db.collection('products').insert({ ...p, code: ERP.db.nextSeq('PRD', 'PRD', 5), stock: 0, stockByWh: {}, batches: [] }, { silent: true }); if (p.stock > 0) { ERP.inventory.move({ productId: np.id, warehouseId: wh, qty: p.stock, type: 'opening', unitCost: p.cost, refType: 'opening', note: 'رصيد افتتاحي', silent: true, batch: p.trackExpiry ? { batchNo: 'B1', expiry: u.toISODate(u.addDays(new Date(), 20 + Math.floor(Math.random() * 60))) } : null }); value += p.stock * p.cost; } });
          if (value) ERP.accounting.postOpeningStock(u.round(value));
          ERP.db.setMeta('demoSeeded', true); ERP.db.flush();
        }
        // cloud (separate Firebase layer — ERP.cloud)
        if (ERP.cloud && ERP.settings.get('cloudSync') && ERP.settings.get('firebaseConfig')) {
          const emptyLocal = ERP.db.collection('products').count() === 0 && ERP.db.collection('sales').count() === 0;
          ERP.cloud.connect().then(async () => { if (emptyLocal && await ERP.cloud.hasRemote()) { try { await ERP.cloud.pullAll(); ERP.settings.load(); } catch (e) { console.warn('bootstrap', e.message); } } }).catch(err => console.warn('cloud', (err && err.message) || err));
        }
        // desktop: write a rolling backup file to Documents each day (Electron only)
        if (ERP.native && ERP.native.available) ERP.native.autoBackupNow().catch(() => { });
        // PWA
        if ('serviceWorker' in navigator && location.protocol.startsWith('http') && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) navigator.serviceWorker.register('sw.js').catch(() => { });
        // login
        const overlay = document.getElementById('loading'); if (overlay) { overlay.classList.add('hide'); setTimeout(() => overlay.remove(), 400); }
        if (ERP.auth.isLoggedIn() && ERP.auth.isLocked()) app.showLogin(true); // locked before F5/restart → PIN required again
        else if (ERP.auth.isLoggedIn()) app.afterLogin({ user: ERP.auth.current(), mustChangePin: !!(ERP.db.collection('users').get(ERP.auth.current().id) || {}).mustChangePin });
        else app.showLogin(false);
      } catch (err) {
        console.error(err);
        document.body.innerHTML = `<div style="padding:2rem;font-family:sans-serif;direction:rtl"><h2>حدث خطأ أثناء تشغيل النظام</h2><pre style="background:#fee;padding:1rem;border-radius:8px;white-space:pre-wrap">${e(err.stack || err.message)}</pre><button onclick="location.reload()">إعادة المحاولة</button> <button onclick="if(confirm('مسح كل البيانات؟')){localStorage.clear();location.reload()}">مسح البيانات وإعادة التشغيل</button></div>`;
      }
    },
  };
  ERP.app = app;
  document.addEventListener('DOMContentLoaded', app.boot);
})();
