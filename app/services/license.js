/* ==========================================================================
   ERP.license — offline signed licenses (ECDSA P-256 / SHA-256, WebCrypto) + 14-day trial
   - license = base64url(JSON payload) + '.' + base64url(signature over the payload string, IEEE-P1363 r||s)
     payload { v:1, id, store, phone, machine ('DM-XXXX-XXXX' | '*'), plan ('trial'|'basic'|'pro'), branches, issued, expires (YYYY-MM-DD | null), features:[] }
   - only the PUBLIC key is embedded here; the private key stays with the owner (tools/license-generator.html signs)
   - machine code: desktop → hash(hostname + primary MAC + OS user) from the main process (window.desktop.machineId);
     browser → random install id kept in IndexedDB kv + localStorage
   - trial start is stored in 3 places (db kv, localStorage outside the db namespace, db meta) and the EARLIEST wins;
     a clock set backwards is ignored (last-seen time). This only makes trivial resets harder — it is NOT tamper-proof
     (everything runs on the client; a determined user can patch the JS).
   - expired trial / license → READ-ONLY: login, view, print, export and backups keep working; the write entry points
     (sales, returns, purchases, stock moves, receipts, expenses, payroll, imports…) are wrapped with requireActive()
   - NEVER locks while ERP.testing (self-tests) or in DEVELOPER MODE (page served from localhost / 127.0.0.1 / [::1]).
     Tests simulate a locked, non-dev state explicitly with ERP.license._force = { active: false }.
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  const u = ERP.utils; const e = u.escapeHtml;
  /* public key (kid f7b39f80c282) — the matching private-key.json is kept OUTSIDE the project by the owner */
  const PUBLIC_JWK = { kty: 'EC', crv: 'P-256', x: '_ZmImNf0N1QBybshnn5p3xhs8i7X59MVXpyXUvAYK9A', y: 'hhcV1uJWVGVWibzEyPxqeJgryhRJHJwj-Ivpngs_0qY' };
  const TRIAL_DAYS = 14, DAY = 86400000;
  const SUPPORT = [{ name: 'عبدالرحمن فكري', phone: '01009022067' }, { name: 'عبدالرحمن فكري', phone: '01552294082' }];
  const PLANS = { trial: 'تجريبي', basic: 'أساسي', pro: 'احترافي' };
  const LS = { trial: 'dm_lic_trial', seen: 'dm_lic_seen', key: 'dm_lic_key', install: 'dm_install_id' }; // outside the 'dm_erp:' namespace → survives ERP.db.reset()
  const KV = { trial: 'licTrialStart', key: 'license', install: 'installId' };
  const CH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* private mode */ } };
  const kvGet = async k => { try { return await ERP.db.kvGet(k); } catch { return null; } };
  const kvSet = async (k, v) => { try { await ERP.db.kvSet(k, v); } catch { /* read-only tab */ } };

  /* ---------- encoding helpers ---------- */
  const b64u = bytes => u.b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64u = s => { s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return u.unb64(s); };
  const codeFrom = bytes => { let bits = 0, val = 0, out = ''; for (const b of bytes) { val = ((val << 8) | b) & 0xffff; bits += 8; while (bits >= 5 && out.length < 8) { out += CH[(val >>> (bits - 5)) & 31]; bits -= 5; } if (out.length >= 8) break; } return `DM-${out.slice(0, 4)}-${out.slice(4, 8)}`; };
  const normCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9*]/g, '');
  const todayISO = (now = Date.now()) => u.toISODate(new Date(now));
  let pubKey = null;
  const importPub = jwk => crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);

  /* ---------- state ---------- */
  const st = { ready: false, status: 'trial', machine: '', trialStart: null, payload: null, token: '', error: '', daysLeft: TRIAL_DAYS, clockBack: false };
  let timer = null;

  const lic = {
    PUBLIC_JWK, TRIAL_DAYS, SUPPORT, PLANS,
    /** internal test hook: { active:false } simulates an expired, non-developer install (overrides the ERP.testing / dev bypass) */
    _force: null,
    b64u, unb64u, codeFrom, normCode,

    /** DEVELOPER MODE bypass (explicit): served from localhost / 127.0.0.1 / [::1] → never locks. file:// (desktop) and real hosts are not dev */
    isDev() { return /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(location.hostname || ''); },

    /** trial countdown math → { start, ends, daysLeft, expired } — daysLeft is whole days, rounded up */
    trialInfo(startISO, now = Date.now(), days = TRIAL_DAYS) {
      const start = new Date(startISO || now).getTime(); const ends = start + days * DAY; const ms = ends - now;
      return { start: new Date(start).toISOString(), ends: new Date(ends).toISOString(), daysLeft: Math.max(0, Math.ceil(ms / DAY)), expired: ms <= 0 };
    },

    /** verify a license string → { ok, payload, error, expired?, code? }. opts: machine, now, key (CryptoKey / JWK — tests) */
    async verify(token, { machine = st.machine, now = Date.now(), key = null } = {}) {
      token = String(token || '').replace(/\s+/g, '');
      const parts = token.split('.');
      if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, error: 'صيغة الترخيص غير صحيحة — انسخ النص كاملاً كما وصلك', code: 'format' };
      let payload; try { payload = JSON.parse(new TextDecoder().decode(unb64u(parts[0]))); } catch { return { ok: false, error: 'صيغة الترخيص غير صحيحة', code: 'format' }; }
      if (!u.hasSubtle()) return { ok: false, error: 'المتصفح لا يدعم التحقق من التوقيع (افتح النظام من التطبيق أو عبر https)', code: 'crypto' };
      let ok = false;
      try {
        const k = key ? (key.type ? key : await importPub(key)) : (pubKey || (pubKey = await importPub(PUBLIC_JWK)));
        ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, k, unb64u(parts[1]), new TextEncoder().encode(parts[0]));
      } catch { ok = false; }
      if (!ok) return { ok: false, error: 'توقيع الترخيص غير صحيح — الترخيص معدّل أو غير صادر من Dream Market ERP', code: 'signature' };
      if (!payload || payload.v !== 1) return { ok: false, error: 'إصدار ترخيص غير مدعوم', code: 'version', payload };
      if (payload.machine !== '*' && normCode(payload.machine) !== normCode(machine)) return { ok: false, error: `هذا الترخيص صادر لجهاز آخر (${payload.machine}) — كود هذا الجهاز ${machine}`, code: 'machine', payload };
      if (payload.expires && todayISO(now) > String(payload.expires).slice(0, 10)) return { ok: false, expired: true, error: `انتهت صلاحية الترخيص في ${u.fmtDate(payload.expires)}`, code: 'expired', payload };
      return { ok: true, payload };
    },

    /* ---------- boot (main.js calls this after ERP.auth.init) ---------- */
    async init() {
      try {
        st.machine = await lic.machineCode();
        // effective "now": never earlier than the last time we ran (clock turned back to stretch the trial)
        const seen = +lsGet(LS.seen) || 0; st.clockBack = Date.now() < seen - 2 * DAY; lsSet(LS.seen, String(Math.max(seen, Date.now())));
        // trial start: earliest of the 3 stores; first run → now
        const kvT = await kvGet(KV.trial);
        const cands = [kvT, lsGet(LS.trial), ERP.db.getMeta('trialStart')].map(x => x && new Date(x).getTime()).filter(x => x > 0 && x <= Date.now() + DAY);
        const start = cands.length ? new Date(Math.min(...cands)).toISOString() : u.now();
        st.trialStart = start;
        if (kvT !== start) await kvSet(KV.trial, start);
        if (lsGet(LS.trial) !== start) lsSet(LS.trial, start);
        if (ERP.db.getMeta('trialStart') !== start && !ERP.db.isReadOnly()) ERP.db.setMeta('trialStart', start);
        // stored license (kv first, localStorage mirror)
        st.token = (await kvGet(KV.key)) || lsGet(LS.key) || '';
        await lic.refresh();
      } catch (err) { console.warn('[license] init', err); }
      st.ready = true;
      lic.wrapAll();
      clearInterval(timer); timer = setInterval(() => { lsSet(LS.seen, String(Math.max(+lsGet(LS.seen) || 0, Date.now()))); lic.refresh(); }, 30 * 60000);
      return lic.state();
    },
    now() { return Math.max(Date.now(), +lsGet(LS.seen) || 0); },
    /** recompute status from the stored license / trial; emits license:change when it changes */
    async refresh() {
      const prev = st.status + '|' + (st.payload && st.payload.id);
      st.payload = null; st.error = '';
      const now = lic.now();
      if (st.token) {
        const r = await lic.verify(st.token, { now });
        if (r.ok) { st.payload = r.payload; st.status = 'licensed'; st.daysLeft = r.payload.expires ? Math.max(0, Math.ceil((new Date(r.payload.expires + 'T23:59:59').getTime() - now) / DAY)) : null; }
        else if (r.expired) { st.payload = r.payload; st.status = 'expired'; st.daysLeft = 0; st.error = r.error; }
        else st.error = r.error;
      }
      if (!st.payload) { const t = lic.trialInfo(st.trialStart, now); st.status = t.expired ? 'trial-expired' : 'trial'; st.daysLeft = t.daysLeft; }
      if (prev !== st.status + '|' + (st.payload && st.payload.id)) ERP.bus.emit('license:change', lic.state());
      lic.renderBanner();
      return lic.state();
    },
    state() { return { ...st, active: lic.isActive(), dev: lic.isDev(), plan: st.payload ? st.payload.plan : 'trial', trial: lic.trialInfo(st.trialStart || u.now(), lic.now()) }; },
    /** status alone (licensed / trial are active) */
    statusActive() { return st.status === 'licensed' || st.status === 'trial'; },
    /** may the app write? dev mode + self-tests always may (unless a test forces the locked state) */
    isActive() {
      if (lic._force) return !!lic._force.active;
      if (ERP.testing || lic.isDev()) return true;
      if (!(ERP.app && ERP.app._shell)) return true; // boot-time internal writes (first-run demo seed, legacy migration) run before anyone can log in
      return lic.statusActive();
    },
    lockReason() { return st.status === 'expired' ? 'انتهت صلاحية الترخيص' : 'انتهت الفترة التجريبية'; },
    /** THE guard: every wrapped write entry point calls this first */
    requireActive() {
      if (lic.isActive()) return true;
      const msg = `${lic.lockReason()} — النظام في وضع القراءة فقط (العرض والطباعة والتصدير والنسخ الاحتياطي متاحة). للتفعيل: الإعدادات ← الترخيص`;
      if (!ERP.testing && !lic._force) lic._nudge();
      const err = new Error(msg); err.code = 'LICENSE_READONLY'; throw err;
    },
    _nudge: u.debounce(() => { if (!document.getElementById('lic-modal')) lic.showActivation(); }, 300),
    has(feature) { return !!(st.payload && (st.payload.features || []).includes(feature)); },
    limits() { return { branches: st.payload ? u.num(st.payload.branches) || 1 : 1, plan: st.payload ? st.payload.plan : 'trial' }; },
    /** licensed branch count: trial = 1, a license = its `branches` (≥ 1). Unlimited in dev mode / self-tests (like requireActive);
     *  tests simulate a real install with ERP.license._force = { active: true, branches: N } */
    branchLimit() {
      if (lic._force) return lic._force.branches != null ? Math.max(1, u.num(lic._force.branches)) : lic.limits().branches;
      if (ERP.testing || lic.isDev()) return Infinity;
      return lic.limits().branches;
    },
    /** throws when having `count` branches would exceed the license (ERP.branches.register, cloud branch namespaces) */
    requireBranchSlot(count) {
      const max = lic.branchLimit(); if (count <= max) return true;
      const err = new Error(`تم الوصول للحد الأقصى للفروع في الترخيص الحالي (${max} ${max === 1 ? 'فرع' : 'فروع'}) — لإضافة فرع جديد اطلب ترخيصاً بعدد فروع أكبر (الإعدادات ← الترخيص)`);
      err.code = 'LICENSE_BRANCHES'; throw err;
    },

    /* ---------- machine code ---------- */
    async machineCode() {
      if (st.machine) return st.machine;
      if (window.desktop && typeof window.desktop.machineId === 'function') { try { const m = await window.desktop.machineId(); if (m && /^DM-/.test(m)) return m; } catch { /* old preload */ } }
      let id = lsGet(LS.install) || await kvGet(KV.install);
      if (!id || !/^DM-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(id)) id = codeFrom(u.randomBytes(6));
      lsSet(LS.install, id); await kvSet(KV.install, id);
      return id;
    },

    /* ---------- activate / deactivate ---------- */
    async activate(token) {
      token = String(token || '').replace(/\s+/g, '');
      const r = await lic.verify(token, { now: lic.now() });
      if (!r.ok) throw new Error(r.error);
      st.token = token; await kvSet(KV.key, token); lsSet(LS.key, token);
      ERP.audit.log('license.activate', `تفعيل ترخيص ${r.payload.id || ''} — ${r.payload.store || ''} (${PLANS[r.payload.plan] || r.payload.plan})`);
      await lic.refresh(); ERP.bus.emit('license:change', lic.state());
      return r.payload;
    },
    async deactivate() {
      st.token = ''; await kvSet(KV.key, null); lsSet(LS.key, null);
      ERP.audit.log('license.activate', 'إلغاء تفعيل الترخيص على هذا الجهاز');
      await lic.refresh(); ERP.bus.emit('license:change', lic.state());
    },

    /* ---------- read-only enforcement: wrap the service write entry points (monkey-patch — the service files stay untouched) ---------- */
    GUARDED: {
      sales: ['create', 'createReturn', 'void', 'addPayment', 'convertQuotation'],
      purchasing: ['create', 'update', 'receive', 'paySupplier', 'returnToSupplier'],
      inventory: ['move', 'adjust', 'waste', 'transfer', 'applyStocktake'],
      crm: ['receivePayment'],
      hr: ['paySalary', 'giveAdvance'],
      giftcards: ['issue', 'topUp'],
      orders: ['create', 'deliver'],
      assets: ['create', 'runDepreciation', 'dispose'],
      shifts: ['cashMove'],
      branches: ['sendTransfer', 'receiveTransfer'],
      pricechanges: ['schedule', 'bulk'],
      importCenter: ['apply'],
      openingImport: ['apply'],
    },
    wrap(obj, names) {
      let n = 0;
      (names || []).forEach(name => {
        const f = obj && obj[name]; if (typeof f !== 'function' || f.__licWrapped) return;
        const isAsync = f.constructor && f.constructor.name === 'AsyncFunction';
        const w = function (...a) { if (isAsync) { try { lic.requireActive(); } catch (err) { return Promise.reject(err); } } else lic.requireActive(); return f.apply(this, a); };
        w.__licWrapped = true; w.__orig = f; obj[name] = w; n++;
      });
      return n;
    },
    /** idempotent — called when this file loads and again at boot / login (services loaded later get wrapped then) */
    wrapAll() {
      let n = 0;
      Object.entries(lic.GUARDED).forEach(([svc, names]) => { n += lic.wrap(ERP[svc], names); });
      // expenses are written by the view straight into the collection → guard that collection instance
      try { if (ERP.db && ERP.db.isReady && ERP.db.isReady()) n += lic.wrap(ERP.db.collection('expenses'), ['insert', 'update']); } catch { /* */ }
      return n;
    },

    /* ---------- UI ---------- */
    statusText(s = lic.state()) {
      if (s.status === 'licensed') return `مُفعّل — ${PLANS[s.payload.plan] || s.payload.plan}${s.payload.expires ? ` حتى ${u.fmtDate(s.payload.expires)}` : ' (مدى الحياة)'}`;
      if (s.status === 'expired') return `الترخيص منتهي منذ ${u.fmtDate(s.payload.expires)} — وضع القراءة فقط`;
      if (s.status === 'trial') return `نسخة تجريبية — متبقي ${s.daysLeft} يوم`;
      return 'انتهت الفترة التجريبية — وضع القراءة فقط';
    },
    renderBanner() {
      const main = document.querySelector('.app .main'); if (!main || !ERP.app || !ERP.app._shell) return;
      let b = document.getElementById('lic-banner');
      const s = lic.state(); const locked = !lic.statusActive(); const soon = s.status === 'licensed' && s.daysLeft != null && s.daysLeft <= 7;
      if (s.status === 'licensed' && !soon) { if (b) b.remove(); return; }
      if (!b) { b = document.createElement('div'); b.id = 'lic-banner'; main.insertBefore(b, main.querySelector('.content')); }
      const k = locked ? 'danger' : 'warning';
      const txt = soon ? `الترخيص ينتهي خلال ${s.daysLeft} يوم` : lic.statusText(s);
      b.style.cssText = `display:flex;align-items:center;justify-content:center;gap:.75rem;padding:.3rem 1rem;font-size:.85rem;background:var(--${k}-bg);color:var(--${k}-fg);border-bottom:1px solid var(--${k})`;
      b.innerHTML = `<i class="fas fa-${locked ? 'lock' : 'hourglass-half'}"></i><span>${e(txt)}${s.dev && locked ? ' <small>(وضع المطوّر — لا قفل على localhost)</small>' : ''}</span><button class="btn btn-sm btn-${locked ? 'danger' : 'warning'}" id="lic-banner-go" style="padding:.1rem .7rem">تفعيل</button>`;
      b.querySelector('#lic-banner-go').onclick = () => lic.showActivation();
    },
    /** the activation panel (settings section, setup wizard step and modal share it) */
    panelHtml() {
      const s = lic.state(); const locked = !lic.statusActive(); const p = s.payload;
      const k = s.status === 'licensed' ? 'success' : locked ? 'danger' : 'warning';
      return `<div class="alert alert-${k} mb-3"><i class="fas fa-${s.status === 'licensed' ? 'circle-check' : locked ? 'lock' : 'hourglass-half'}"></i> <strong>${e(lic.statusText(s))}</strong>${locked ? '<div class="text-sm mt-1">يمكنك الدخول والعرض وطباعة التقارير والتصدير وأخذ نسخة احتياطية، لكن لا يمكن تسجيل مبيعات أو مشتريات أو حركات مخزون حتى التفعيل.</div>' : ''}${s.dev ? '<div class="text-xs mt-1">وضع المطوّر: النظام مفتوح على localhost ولن يُقفل.</div>' : ''}</div>
        ${p ? `<div class="grid grid-2 gap-2 mb-3 text-sm"><div><span class="muted">المحل:</span> <strong>${e(p.store || '')}</strong></div><div><span class="muted">الباقة:</span> <strong>${e(PLANS[p.plan] || p.plan)}</strong></div><div><span class="muted">الفروع المسموحة:</span> <strong class="num">${e(p.branches || 1)}</strong></div><div><span class="muted">الانتهاء:</span> <strong>${p.expires ? u.fmtDate(p.expires) : 'مدى الحياة'}</strong></div><div><span class="muted">رقم الترخيص:</span> <span class="num">${e(p.id || '')}</span></div><div><span class="muted">تاريخ الإصدار:</span> ${p.issued ? u.fmtDate(p.issued) : '—'}</div></div>` : `<div class="text-sm mb-3"><span class="muted">بداية الفترة التجريبية:</span> ${u.fmtDate(s.trial.start)} · <span class="muted">تنتهي:</span> ${u.fmtDate(s.trial.ends)} · <span class="muted">الفروع المسموحة:</span> <strong class="num">1</strong></div>`}
        <div class="setting-row"><div class="info"><strong>كود الجهاز</strong><span>أرسله للدعم الفني لإصدار ترخيص لهذا الجهاز</span></div><div class="flex gap-2 items-center"><code class="num" id="lic-code" style="font-size:1.15rem;letter-spacing:.08em;direction:ltr;padding:.3rem .6rem;border-radius:8px;background:rgba(127,127,127,.12)">${e(s.machine)}</code><button type="button" class="btn btn-sm btn-outline" data-lic="copy"><i class="fas fa-copy"></i> نسخ</button></div></div>
        <div class="form-group mt-3"><label>لصق الترخيص</label><textarea id="lic-input" rows="3" dir="ltr" spellcheck="false" style="font-family:monospace;font-size:.8rem" placeholder="eyJ2IjoxLC..."></textarea></div>
        <div id="lic-err" class="alert alert-danger hidden"></div>
        <div class="flex gap-2 flex-wrap"><button type="button" class="btn btn-primary" data-lic="activate"><i class="fas fa-key"></i> تفعيل</button>${st.token ? '<button type="button" class="btn btn-ghost text-danger" data-lic="deactivate"><i class="fas fa-ban"></i> إلغاء التفعيل على هذا الجهاز</button>' : ''}</div>
        <div class="divider"></div><div class="text-sm"><strong><i class="fas fa-headset text-primary"></i> للتفعيل والدعم الفني:</strong> ${SUPPORT.map(x => `<a href="https://wa.me/2${e(x.phone)}" target="_blank" rel="noopener" class="num" style="margin-inline-start:.5rem">${e(x.phone)}</a>`).join(' · ')} <span class="muted">(${e(SUPPORT[0].name)} — واتساب أو اتصال)</span></div>`;
    },
    bindPanel(root, onDone) {
      root.addEventListener('click', async ev => {
        const b = ev.target.closest('[data-lic]'); if (!b || !root.contains(b)) return;
        const a = b.dataset.lic; const err = root.querySelector('#lic-err');
        if (a === 'copy') { u.copy(st.machine); ERP.ui.success('تم نسخ كود الجهاز'); }
        if (a === 'activate') {
          b.disabled = true;
          try { const p = await lic.activate(root.querySelector('#lic-input').value); ERP.ui.success(`تم التفعيل — ${p.store || ''}`); onDone && onDone(); }
          catch (ex) { if (err) { err.textContent = ex.message; err.classList.remove('hidden'); } else ERP.ui.error(ex.message); }
          finally { b.disabled = false; }
        }
        if (a === 'deactivate' && await ERP.ui.confirm('إلغاء تفعيل الترخيص على هذا الجهاز؟ سيعود النظام للفترة التجريبية (أو وضع القراءة فقط إن انتهت).', { danger: true, okText: 'إلغاء التفعيل' })) { await lic.deactivate(); onDone && onDone(); }
      });
    },
    showActivation() {
      if (ERP.testing) return null;
      const h = ERP.ui.modal({ title: 'تفعيل Dream Market ERP', icon: 'key', size: 'md', body: `<div id="lic-modal">${lic.panelHtml()}</div>`, footer: null });
      lic.bindPanel(h.body, () => h.close());
      return h;
    },
    /** after login (main.js): banner + read-only notice once per session */
    afterLogin() {
      lic.wrapAll(); lic.renderBanner();
      let seen = false; try { seen = !!sessionStorage.getItem('dm_lic_notice'); sessionStorage.setItem('dm_lic_notice', '1'); } catch { /* */ }
      if (!lic.isActive() && !ERP.testing && !seen) setTimeout(() => lic.showActivation(), 900);
    },
  };

  ERP.license = lic;
  ERP.audit.LABELS['license.activate'] = 'الترخيص';
  lic.wrapAll(); // services loaded before this file

  /* settings section: الترخيص */
  ERP.settingsSections = ERP.settingsSections || [];
  ERP.settingsSections.push({
    id: 'license', icon: 'key', label: 'الترخيص',
    render() { return `<div id="lic-sec">${lic.panelHtml()}</div>`; },
    bind(body, h) { const root = body.querySelector('#lic-sec'); if (root) lic.bindPanel(root, () => h.rerender()); },
  });
})();
