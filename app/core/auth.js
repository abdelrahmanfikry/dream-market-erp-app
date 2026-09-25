/* ==========================================================================
   ERP.auth — users, roles, permissions, session & PIN login
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  const u = ERP.utils;
  const SESSION_KEY = 'dm_erp:session';

  // Every permission the system knows, grouped for the roles UI
  const PERMISSIONS = {
    'لوحة التحكم': { 'dashboard.view': 'عرض لوحة التحكم', 'dashboard.finance': 'عرض الأرقام المالية' },
    'نقطة البيع': { 'pos.use': 'استخدام نقطة البيع', 'pos.discount': 'منح خصومات', 'pos.price_edit': 'تعديل السعر أثناء البيع', 'pos.return': 'عمل مرتجعات', 'pos.void': 'إلغاء فواتير', 'pos.credit': 'البيع بالأجل', 'pos.negative_stock': 'البيع بدون رصيد مخزون (لو الإعداد «بصلاحية فقط»)', 'pos.supervisor': 'اعتماد الخصومات والإلغاءات (مشرف)' },
    'المنتجات والمخزون': { 'products.view': 'عرض المنتجات', 'products.manage': 'إضافة/تعديل/حذف منتجات', 'products.cost': 'عرض سعر التكلفة', 'inventory.view': 'عرض المخزون', 'inventory.adjust': 'تسويات وجرد', 'inventory.transfer': 'تحويلات بين المخازن' },
    'المشتريات والموردين': { 'purchases.view': 'عرض المشتريات', 'purchases.manage': 'إنشاء واستلام أوامر الشراء', 'purchases.pay': 'سداد الموردين', 'suppliers.manage': 'إدارة الموردين' },
    'العملاء': { 'customers.view': 'عرض العملاء', 'customers.manage': 'إدارة العملاء', 'customers.receipt': 'تحصيل من العملاء', 'customers.credit_limit': 'تعديل حدود الائتمان' },
    'المبيعات': { 'sales.view': 'عرض الفواتير', 'sales.manage': 'تعديل/حذف الفواتير', 'sales.export': 'تصدير المبيعات' },
    'المالية': { 'expenses.view': 'عرض المصروفات', 'expenses.manage': 'تسجيل المصروفات', 'accounting.view': 'عرض الحسابات والقيود', 'accounting.manage': 'إنشاء قيود يدوية', 'cash.manage': 'إدارة الخزينة والورديات' },
    'الموارد البشرية': { 'hr.view': 'عرض الموظفين', 'hr.manage': 'إدارة الموظفين والرواتب' },
    'التقارير': { 'reports.view': 'عرض التقارير', 'reports.profit': 'عرض تقارير الأرباح' },
    'النظام': { 'users.manage': 'إدارة المستخدمين والصلاحيات', 'settings.manage': 'تعديل الإعدادات', 'backup.manage': 'النسخ الاحتياطي والاستعادة', 'audit.view': 'عرض سجل النشاطات', 'promotions.manage': 'إدارة العروض' },
  };
  const ALL_PERMS = Object.values(PERMISSIONS).flatMap(g => Object.keys(g));

  const DEFAULT_ROLES = [
    { id: 'admin', name: 'مدير النظام', color: '#dc2626', isSystem: true, permissions: ['*'] },
    { id: 'manager', name: 'مدير المتجر', color: '#7c3aed', isSystem: true, permissions: ALL_PERMS.filter(p => !['users.manage', 'backup.manage'].includes(p)) },
    { id: 'accountant', name: 'محاسب', color: '#0891b2', isSystem: true, permissions: ['dashboard.view', 'dashboard.finance', 'sales.view', 'sales.export', 'purchases.view', 'purchases.pay', 'customers.view', 'customers.receipt', 'expenses.view', 'expenses.manage', 'accounting.view', 'accounting.manage', 'cash.manage', 'reports.view', 'reports.profit', 'hr.view', 'products.view', 'products.cost', 'inventory.view', 'audit.view'] },
    { id: 'cashier', name: 'كاشير', color: '#16a34a', isSystem: true, permissions: ['dashboard.view', 'pos.use', 'pos.credit', 'products.view', 'customers.view', 'customers.manage', 'customers.receipt', 'sales.view', 'cash.manage'] },
    { id: 'storekeeper', name: 'أمين مخزن', color: '#f59e0b', isSystem: true, permissions: ['dashboard.view', 'products.view', 'products.manage', 'products.cost', 'inventory.view', 'inventory.adjust', 'inventory.transfer', 'purchases.view', 'purchases.manage', 'suppliers.manage', 'reports.view'] },
  ];

  let session = null;
  let lockTimer = null;
  let sessTok = null;          // random token of the current session (also stored in ERP.db kv)
  let sessLocked = false;      // lock screen state, persisted with the session (survives F5)
  let kvToken;                 // undefined until auth.init() read the kv token → stored sessions are not trusted before
  const TOKEN_KV = 'sessionToken';
  const PBKDF2_ITER = 60000;
  const SELF_FIELDS = ['pin', 'avatarColor']; // what a user may change on their own record without users.manage

  function users() { return ERP.db.collection('users'); }
  function roles() { return ERP.db.collection('roles'); }
  /** LEGACY sync hash (djb2/FNV + fixed salt) — kept only to verify old PINs; new hashes use PBKDF2 */
  function hashPin(pin) { return u.hashStr('dm|' + String(pin)); }
  /** 'pbkdf2$iter$saltB64$hashB64' (per-user random salt); falls back to the legacy hash without crypto.subtle */
  async function hashPinAsync(pin) {
    if (!u.hasSubtle()) return hashPin(pin);
    const salt = u.randomBytes(16);
    return `pbkdf2$${PBKDF2_ITER}$${u.b64(salt)}$${u.b64(await u.pbkdf2(pin, salt, PBKDF2_ITER))}`;
  }
  const isLegacy = h => !String(h || '').startsWith('pbkdf2$');
  async function checkHash(stored, pin) {
    stored = String(stored || ''); if (!stored) return false;
    if (isLegacy(stored)) return u.safeEq(stored, hashPin(pin));
    const [, it, s, h] = stored.split('$');
    if (!u.hasSubtle() || !s || !h) return false;
    try { return u.safeEq(u.b64(await u.pbkdf2(pin, u.unb64(s), +it || PBKDF2_ITER)), h); } catch (e) { console.warn('[auth] verify', e); return false; }
  }
  /** transparently re-hash a legacy PIN with PBKDF2 (only if the stored hash didn't change meanwhile) */
  function upgradeHash(id, pin, expect) {
    if (!u.hasSubtle() || !isLegacy(expect)) return Promise.resolve();
    return hashPinAsync(pin).then(h => { const cur = users().get(id); if (cur && cur.pinHash === expect) users().update(id, { pinHash: h }, { silent: true }); }).catch(e => console.warn('[auth] pin upgrade', e));
  }
  function need(perm) { if (!auth.can(perm)) throw new Error('ليس لديك صلاحية لهذا الإجراء'); }
  function storeOf() { return localStorage.getItem(SESSION_KEY) ? localStorage : sessionStorage; }
  function saveSession(store) { if (session) (store || storeOf()).setItem(SESSION_KEY, JSON.stringify({ ...session, tok: sessTok, locked: sessLocked })); }
  function setPinHash(id, pinHash) {
    const usr = users().update(id, { pinHash, mustChangePin: false });
    if (usr && session && session.id === id) { session = auth._publicUser(usr); saveSession(); }
    return usr;
  }

  const auth = {
    PERMISSIONS, ALL_PERMS, DEFAULT_ROLES, hashPin, hashPinAsync, PBKDF2_ITER,

    ensureDefaults() {
      const r = roles();
      DEFAULT_ROLES.forEach(dr => { if (!r.get(dr.id)) r.insert(dr, { silent: true }); });
      if (users().count() === 0) {
        const legacy = hashPin('1234');
        users().insert({ id: 'u_admin', name: 'المدير', username: 'admin', roleId: 'admin', pinHash: legacy, active: true, mustChangePin: true, avatarColor: '#1a56f5' }, { silent: true });
        upgradeHash('u_admin', '1234', legacy);
      }
    },
    /** async: read the session token from the db kv store (call once after ERP.db.init, before current()) */
    async init() { try { kvToken = (await ERP.db.kvGet(TOKEN_KV)) || null; } catch (e) { console.warn('[auth] token', e); kvToken = null; } session = null; return auth.current(); },

    /* ---- session ---- */
    current() {
      if (session) return session;
      if (kvToken === undefined) return null; // storage not verified yet
      let raw = null;
      try { raw = JSON.parse(sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(SESSION_KEY) || 'null'); } catch { raw = null; }
      if (!raw || !raw.id || !raw.tok || !kvToken || !u.safeEq(raw.tok, kvToken)) return null; // forged / stale session
      const fresh = users().get(raw.id); if (!fresh || !fresh.active) return null;
      session = auth._publicUser(fresh); sessTok = raw.tok; sessLocked = !!raw.locked;
      return session;
    },
    isLoggedIn() { return !!auth.current(); },
    isLocked() { return !!auth.current() && sessLocked; },
    _publicUser(usr) { const { pinHash, ...pub } = usr; return pub; },

    /** async → {ok, user, mustChangePin, switched} */
    async login(userId, pin, { remember = false } = {}) {
      const usr = users().get(userId);
      if (!usr || !usr.active) return { ok: false, error: 'المستخدم غير موجود أو معطل' };
      if (usr.lockedUntil && new Date(usr.lockedUntil) > new Date()) return { ok: false, error: `الحساب مقفل مؤقتاً حتى ${u.fmtTime(usr.lockedUntil)}` };
      if (!(await checkHash(usr.pinHash, pin))) {
        const fails = ((users().get(userId) || usr).failedAttempts || 0) + 1;
        const patch = { failedAttempts: fails };
        if (fails >= 5) { patch.lockedUntil = new Date(Date.now() + 5 * 60000).toISOString(); patch.failedAttempts = 0; }
        users().update(userId, patch, { silent: true });
        ERP.audit.log('auth.failed', `محاولة فاشلة للمستخدم ${usr.name}`);
        return { ok: false, error: fails >= 5 ? 'تم قفل الحساب 5 دقائق بعد محاولات فاشلة' : `رمز الدخول غير صحيح (${fails}/5)` };
      }
      const prevId = session ? session.id : null;
      users().update(userId, { failedAttempts: 0, lockedUntil: null, lastLogin: u.now() }, { silent: true });
      upgradeHash(userId, pin, usr.pinHash);
      session = auth._publicUser(users().get(userId)); sessTok = u.randomHex(24); sessLocked = false; kvToken = sessTok;
      sessionStorage.removeItem(SESSION_KEY); localStorage.removeItem(SESSION_KEY);
      saveSession(remember ? localStorage : sessionStorage);
      await ERP.db.kvSet(TOKEN_KV, sessTok).catch(e => console.warn('[auth] token save', e)); // committed before a possible reload
      ERP.audit.log('auth.login', `دخول ${session.name}`);
      ERP.bus.emit('auth:login', session);
      auth.resetLockTimer();
      return { ok: true, user: session, mustChangePin: !!usr.mustChangePin, switched: !!prevId && prevId !== userId };
    },
    logout() {
      if (session) ERP.audit.log('auth.logout', `خروج ${session.name}`);
      session = null; sessTok = null; sessLocked = false; kvToken = null; clearTimeout(lockTimer);
      sessionStorage.removeItem(SESSION_KEY); localStorage.removeItem(SESSION_KEY);
      ERP.db.kvSet(TOKEN_KV, null).catch(() => { });
      ERP.bus.emit('auth:logout');
    },
    /** lock the screen; the flag is persisted with the session so F5 shows the lock screen again */
    lock() { if (!auth.current()) return; sessLocked = true; saveSession(); clearTimeout(lockTimer); ERP.bus.emit('auth:lock'); },
    resetLockTimer() {
      clearTimeout(lockTimer);
      const mins = u.num(ERP.settings.get('lockAfterMinutes'));
      if (mins > 0 && session && !sessLocked) lockTimer = setTimeout(() => auth.lock(), mins * 60000);
    },

    /* ---- permissions ---- */
    role(userOrId) {
      const usr = typeof userOrId === 'object' ? userOrId : users().get(userOrId) || auth.current();
      return usr ? roles().get(usr.roleId) : null;
    },
    can(perm, usr) {
      usr = usr || auth.current();
      if (!usr) return false;
      const r = roles().get(usr.roleId);
      if (!r) return false;
      if (r.permissions.includes('*')) return true;
      if (Array.isArray(perm)) return perm.some(p => r.permissions.includes(p));
      return r.permissions.includes(perm);
    },
    require(perm, msg) {
      if (auth.can(perm)) return true;
      if (ERP.ui && ERP.ui.toast) ERP.ui.toast(msg || 'ليس لديك صلاحية لهذا الإجراء', 'error', { title: 'غير مصرح' });
      return false;
    },

    /* ---- supervisor approval ---- */
    /** async → boolean */
    async verifyPin(userId, pin) {
      const usr = users().get(userId);
      if (!usr || usr.active === false) return false;
      const ok = await checkHash(usr.pinHash, pin);
      if (ok) upgradeHash(userId, pin, usr.pinHash);
      return ok;
    },
    /** ask a supervisor (user holding `perm`) to approve an action with their PIN. Resolves {ok, approver} */
    approve({ reason = '', perm = 'pos.supervisor' } = {}) {
      const me = auth.current();
      if (auth.can(perm)) return Promise.resolve({ ok: true, approver: me, self: true });
      const sups = users().all().filter(x => x.active !== false && auth.can(perm, x));
      if (!sups.length) { ERP.ui.error('لا يوجد مشرف يملك صلاحية الاعتماد — أضف الصلاحية لدور المدير'); return Promise.resolve({ ok: false }); }
      return new Promise(resolve => {
        const h = ERP.ui.modal({ title: 'اعتماد المشرف', icon: 'user-shield', size: 'sm', body: `<div class="alert alert-warning mb-3"><i class="fas fa-lock"></i> ${u.escapeHtml(reason || 'هذا الإجراء يحتاج موافقة مشرف')}</div><div class="form-group"><label>المشرف</label><select id="ap-user">${sups.map(x => `<option value="${u.escapeHtml(x.id)}">${u.escapeHtml(x.name)}</option>`).join('')}</select></div><div class="form-group"><label>رمز المشرف</label><input type="password" id="ap-pin" inputmode="numeric" autocomplete="off" style="text-align:center;font-size:1.3rem;letter-spacing:.3em;direction:ltr"></div>`, footer: `<button class="btn" data-a="c">إلغاء</button><button class="btn btn-primary" data-a="ok"><i class="fas fa-check"></i> اعتماد</button>`, onClose: r => resolve(r || { ok: false }) });
        let busy = false;
        const go = async () => {
          if (busy) return; busy = true; const btn = h.$('[data-a=ok]'); btn.disabled = true;
          const id = h.$('#ap-user').value, pin = h.$('#ap-pin').value;
          const ok = await auth.verifyPin(id, pin); busy = false; btn.disabled = false;
          if (ok) { const ap = auth._publicUser(users().get(id)); ERP.audit.log('auth.approval', `${ap.name} اعتمد: ${reason}${me ? ' — للمستخدم ' + me.name : ''}`); h.close({ ok: true, approver: ap }); }
          else { ERP.audit.log('auth.failed', `محاولة اعتماد فاشلة (${reason})`); ERP.ui.error('رمز المشرف غير صحيح'); h.$('#ap-pin').value = ''; h.$('#ap-pin').focus(); }
        };
        h.$('[data-a=ok]').onclick = go; h.$('[data-a=c]').onclick = () => h.close({ ok: false });
        h.$('#ap-pin').addEventListener('keydown', ev => { if (ev.key === 'Enter') go(); });
        setTimeout(() => h.$('#ap-pin').focus(), 50);
      });
    },

    /* ---- user management (requires users.manage; a user may change their own PIN) ---- */
    users() { return users().all(); },
    roles() { return roles().all(); },
    createUser({ name, username, pin, roleId, active = true, employeeId = null, avatarColor }) {
      need('users.manage');
      if (!name || !pin || !roleId) throw new Error('بيانات ناقصة');
      if (String(pin).length < 4) throw new Error('رمز الدخول 4 أرقام على الأقل');
      if (username && users().first({ username })) throw new Error('اسم المستخدم مستخدم بالفعل');
      const legacy = hashPin(pin); // sync placeholder, upgraded to PBKDF2 right away (keeps this API synchronous)
      const usr = users().insert({ name, username: username || u.slug(name), pinHash: legacy, roleId, active, employeeId, mustChangePin: false, avatarColor: avatarColor || ['#1a56f5', '#7c3aed', '#16a34a', '#f59e0b', '#dc2626', '#0891b2'][users().count() % 6] });
      upgradeHash(usr.id, pin, legacy);
      ERP.audit.log('user.create', `مستخدم جديد: ${name}`);
      return usr;
    },
    updateUser(id, patch) {
      const self = !!session && session.id === id;
      if (!auth.can('users.manage') && !(self && Object.keys(patch).every(k => SELF_FIELDS.includes(k)))) throw new Error('ليس لديك صلاحية لهذا الإجراء');
      patch = { ...patch }; let pin = null;
      if (patch.pin) { if (String(patch.pin).length < 4) throw new Error('رمز الدخول 4 أرقام على الأقل'); pin = patch.pin; patch.pinHash = hashPin(pin); patch.mustChangePin = false; }
      delete patch.pin;
      const usr = users().update(id, patch);
      if (!usr) throw new Error('المستخدم غير موجود');
      if (pin) upgradeHash(id, pin, patch.pinHash);
      if (self) { session = auth._publicUser(usr); saveSession(); }
      ERP.audit.log('user.update', `تعديل مستخدم: ${usr.name}`);
      return usr;
    },
    deleteUser(id) {
      need('users.manage');
      const usr = users().get(id);
      if (!usr) return;
      if (usr.roleId === 'admin' && users().where({ roleId: 'admin' }).length <= 1) throw new Error('لا يمكن حذف آخر مدير للنظام');
      users().remove(id);
      ERP.audit.log('user.delete', `حذف مستخدم: ${usr.name}`);
    },
    /** validation errors throw synchronously; returns a promise (old-PIN check + PBKDF2) → callers should return/await it */
    changePin(id, oldPin, newPin) {
      const usr = users().get(id);
      if (!usr) throw new Error('المستخدم غير موجود');
      const self = !!session && session.id === id, admin = auth.can('users.manage');
      if (!self && !admin) throw new Error('ليس لديك صلاحية لهذا الإجراء');
      if (self && oldPin === null && !admin && !usr.mustChangePin) throw new Error('أدخل الرمز الحالي');
      if (String(newPin).length < 4) throw new Error('الرمز الجديد 4 أرقام على الأقل');
      return (async () => {
        if (oldPin !== null && !(await checkHash(usr.pinHash, oldPin))) throw new Error('الرمز الحالي غير صحيح');
        setPinHash(id, await hashPinAsync(newPin));
        ERP.audit.log('auth.pin_changed', `تغيير رمز ${usr.name}`);
        return true;
      })();
    },
    saveRole(role) {
      need('users.manage');
      if (!role.id) role.id = 'r_' + u.uid();
      const saved = roles().upsert(role);
      ERP.audit.log('role.update', `تعديل دور: ${role.name}`);
      return saved;
    },
    deleteRole(id) {
      need('users.manage');
      const r = roles().get(id);
      if (!r || r.isSystem) throw new Error('لا يمكن حذف الأدوار الأساسية');
      if (users().where({ roleId: id }).length) throw new Error('يوجد مستخدمون مرتبطون بهذا الدور');
      roles().remove(id);
    },
  };

  ERP.auth = auth;
  ERP.audit.LABELS['auth.approval'] = 'اعتماد مشرف';
  ['click', 'keydown', 'mousemove', 'touchstart'].forEach(evt => document.addEventListener(evt, u.throttle(() => auth.resetLockTimer(), 5000), { passive: true }));
})();
