/* ==========================================================================
   ERP.updater — renderer side of the desktop auto-updater (desktop/main.js [dist] block)
   - desktop (portable exe): check GitHub latest release → offer → download with progress (size + sha256
     verified in the main process) → «إعادة التشغيل الآن» (ERP.db flushed, new exe spawned, old one quits)
   - on start: optional silent check (setting updateAutoCheck) + offer to delete older portable exes
   - browser / PWA: the web version updates itself (service worker) — we only show the version
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  const u = ERP.utils; const e = u.escapeHtml;
  ERP.settings.extend({ updateAutoCheck: true, updateSkipVersion: '', updateLastCheck: null });
  const D = () => (window.desktop && typeof window.desktop.updateCheck === 'function' ? window.desktop : null);
  const fmtSize = b => b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round((b || 0) / 1024)} KB`;
  let webVer = null;

  const up = {
    /** semver-ish compare of 'vX.Y.Z' strings → -1 | 0 | 1 (numeric per part: 3.3.0 < 3.10.0) */
    compare(a, b) {
      const p = v => String(v || '').trim().replace(/^v/i, '').split('.').map(x => parseInt(x, 10) || 0);
      const x = p(a), y = p(b);
      for (let i = 0; i < Math.max(3, x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d < 0 ? -1 : 1; }
      return 0;
    },
    isDesktop() { return !!D(); },
    async version() {
      if (window.desktop && window.desktop.info) { try { return (await window.desktop.info()).version; } catch { /* */ } }
      if (webVer) return webVer;
      try { if (location.protocol.startsWith('http')) { const t = await (await fetch('sw.js', { cache: 'no-cache' })).text(); const m = /VERSION\s*=\s*'[^']*?v?(\d+\.\d+\.\d+)'/.exec(t); if (m) return (webVer = m[1]); } } catch { /* offline */ }
      return '—';
    },
    /** check GitHub. silent: no message when offline / nothing new / skipped */
    async check({ silent = false } = {}) {
      const d = D(); if (!d) { if (!silent) ERP.ui.info('نسخة الويب تتحدث تلقائياً عند فتحها مع وجود إنترنت'); return null; }
      let r; try { r = await d.updateCheck(); } catch (err) { r = { ok: false, err: err.message }; }
      ERP.settings.set({ updateLastCheck: u.now() });
      if (!r || !r.ok) { if (!silent) ERP.ui.warn(r && r.err === 'no-release' ? 'لا توجد إصدارات منشورة بعد' : 'تعذر الاتصال بخادم التحديثات — تأكد من الإنترنت وحاول مرة أخرى', { title: 'التحديثات' }); return r; }
      if (!r.newer) { if (!silent) ERP.ui.success(`أنت تستخدم أحدث إصدار (${r.current})`); return r; }
      if (!r.hasAsset) { if (!silent) ERP.ui.warn(`الإصدار ${r.latest} منشور لكن بدون ملف النسخة المحمولة`); return r; }
      if (silent && ERP.settings.get('updateSkipVersion') === r.latest) return r;
      up.offer(r); return r;
    },
    offer(r) {
      if (ERP.testing || document.getElementById('upd-modal')) return null;
      const h = ERP.ui.modal({
        title: `تحديث جديد ${e(r.latest)} متاح`, icon: 'cloud-arrow-down', size: 'md',
        body: `<div id="upd-modal"><div class="alert alert-info mb-3"><i class="fas fa-circle-info"></i> الإصدار الحالي <strong class="num">${e(r.current)}</strong> ← الجديد <strong class="num">${e(r.latest)}</strong>${r.size ? ` · حجم التحميل <span class="num">${fmtSize(r.size)}</span>` : ''}</div>${r.notes ? `<h4 class="mb-2">ما الجديد</h4><div class="text-sm" style="white-space:pre-wrap;max-height:240px;overflow:auto;background:rgba(127,127,127,.08);padding:.6rem .8rem;border-radius:8px">${e(r.notes)}</div>` : ''}<div id="upd-prog" class="hidden mt-3"><div class="text-sm mb-1" id="upd-prog-t">جاري التحميل…</div><div style="height:10px;border-radius:6px;background:rgba(127,127,127,.18);overflow:hidden"><div id="upd-bar" style="height:100%;width:0;background:var(--primary);transition:width .2s"></div></div></div><div id="upd-err" class="alert alert-danger hidden mt-3"></div><p class="text-xs muted mt-3">${r.portable ? 'يُحفظ الملف الجديد بجوار البرنامج الحالي، وبياناتك تبقى كما هي.' : 'يُحفظ الملف في مجلد التحديثات داخل بيانات البرنامج، وبياناتك تبقى كما هي.'} خذ نسخة احتياطية قبل التحديث إن أردت.</p></div>`,
        footer: `<button class="btn btn-ghost" data-a="skip">تخطي هذا الإصدار</button><button class="btn" data-a="later">لاحقاً</button><button class="btn btn-primary" data-a="dl"><i class="fas fa-download"></i> تحميل</button>`,
      });
      const $ = s => h.$(s); let off = null;
      const fail = msg => { const x = $('#upd-err'); x.textContent = msg; x.classList.remove('hidden'); };
      h.footer.onclick = async ev => {
        const b = ev.target.closest('[data-a]'); if (!b) return; const a = b.dataset.a;
        if (a === 'later') return h.close();
        if (a === 'skip') { ERP.settings.set({ updateSkipVersion: r.latest }); return h.close(); }
        if (a === 'dl') {
          b.disabled = true; $('#upd-err').classList.add('hidden'); $('#upd-prog').classList.remove('hidden');
          off = D().onUpdateProgress(p => { const pct = p.total ? Math.min(100, Math.round(p.received / p.total * 100)) : 0; $('#upd-bar').style.width = pct + '%'; $('#upd-prog-t').textContent = `جاري التحميل… ${pct}% (${fmtSize(p.received)} / ${fmtSize(p.total)})`; });
          let res; try { res = await D().updateDownload(); } catch (err) { res = { ok: false, err: err.message }; }
          if (off) { off(); off = null; }
          if (!res || !res.ok) { b.disabled = false; return fail('فشل التحميل: ' + ((res && res.err) || 'خطأ غير معروف')); }
          ERP.audit.log('settings.update', `تحميل تحديث ${res.version}`);
          $('#upd-bar').style.width = '100%'; $('#upd-prog-t').innerHTML = `<i class="fas fa-circle-check text-success"></i> تم التحميل والتحقق من الملف (الحجم${res.verifiedSha ? ' + بصمة SHA-256' : ''})`;
          h.footer.innerHTML = `<button class="btn" data-a="later">لاحقاً</button><button class="btn btn-success" data-a="restart"><i class="fas fa-rotate"></i> إعادة التشغيل الآن</button>`;
        }
        if (a === 'restart') {
          if (ERP.shifts && ERP.shifts.current && ERP.shifts.current() && !await ERP.ui.confirm('لديك وردية مفتوحة — ستبقى مفتوحة بعد إعادة التشغيل. متابعة؟', { okText: 'إعادة التشغيل' })) return;
          b.disabled = true; let res; try { res = await D().updateInstall(); } catch (err) { res = { ok: false, err: err.message }; }
          if (!res || !res.ok) { b.disabled = false; fail((res && res.err) || 'تعذر التشغيل'); }
        }
      };
      return h;
    },
    /** older portable exes next to the running one → offer to delete */
    async cleanupOld() {
      const d = D(); if (!d || !d.updateOldVersions || ERP.testing) return;
      let r; try { r = await d.updateOldVersions(); } catch { return; }
      const files = (r && r.files) || []; if (!files.length) return;
      if (!await ERP.ui.confirm(`تم التحديث بنجاح. توجد ${files.length === 1 ? 'نسخة قديمة' : files.length + ' نسخ قديمة'} من البرنامج بجوار النسخة الحالية:<br>${files.map(f => `<span class="num" dir="ltr">${e(f.name)}</span>`).join('<br>')}<br><br>حذفها لتوفير المساحة؟`, { title: 'نسخ قديمة', okText: 'حذف', icon: 'broom' })) return;
      const x = await d.updateDeleteOld(files.map(f => f.name));
      if (x && x.removed) ERP.ui.success(`تم حذف ${x.removed} ملف`); if (x && x.errs && x.errs.length) ERP.ui.warn('تعذر حذف: ' + x.errs.join('، '));
    },
    /** after login (main.js) */
    init() {
      if (!D() || ERP.testing) return;
      setTimeout(() => { if (ERP.testing) return; up.cleanupOld().catch(() => { }); if (ERP.settings.get('updateAutoCheck') !== false) up.check({ silent: true }).catch(() => { }); }, 8000);
    },
  };
  ERP.updater = up;

  /* settings section: التحديثات */
  ERP.settingsSections = ERP.settingsSections || [];
  ERP.settingsSections.push({
    id: 'updates', icon: 'cloud-arrow-down', label: 'التحديثات',
    render(s, h) {
      const last = s.updateLastCheck ? u.fmtDateTime(s.updateLastCheck) : 'لم يتم بعد';
      return h.row('الإصدار الحالي', up.isDesktop() ? 'تطبيق سطح المكتب (نسخة محمولة)' : 'نسخة الويب', '<strong class="num" id="upd-ver">…</strong>') +
        (up.isDesktop()
          ? h.row('البحث عن تحديث', `آخر فحص: ${h.e(last)}`, '<button type="button" class="btn btn-outline" id="upd-check"><i class="fas fa-rotate"></i> تحقق الآن</button>') + h.row('التحقق تلقائياً عند التشغيل', 'يظهر إشعار عند توفر إصدار جديد (بدون تحميل تلقائي)', h.sw('updateAutoCheck', s.updateAutoCheck !== false)) + (s.updateSkipVersion ? h.row('إصدار متخطّى', 'لن يظهر إشعار له عند التشغيل', `<span class="num">${h.e(s.updateSkipVersion)}</span> <button type="button" class="btn btn-sm btn-ghost" id="upd-unskip">إلغاء التخطي</button>`) : '') + '<div class="alert alert-info mt-3"><i class="fas fa-shield-halved"></i> التحديثات تُحمّل من صفحة الإصدارات الرسمية على GitHub فقط، ويتم التحقق من حجم الملف (وبصمته إن وُجدت) قبل التشغيل. بياناتك لا تتأثر بالتحديث.</div>'
          : '<div class="alert alert-info mt-3"><i class="fas fa-globe"></i> نسخة الويب تتحدث تلقائياً: عند فتح النظام مع وجود إنترنت يتم تحميل أحدث نسخة في الخلفية وتُطبّق عند إعادة الفتح.</div>');
    },
    bind(body, h) {
      up.version().then(v => { const x = body.querySelector('#upd-ver'); if (x) x.textContent = v; });
      const c = body.querySelector('#upd-check'); if (c) c.onclick = async () => { c.disabled = true; try { await up.check(); } finally { c.disabled = false; h.rerender(); } };
      const us = body.querySelector('#upd-unskip'); if (us) us.onclick = () => { ERP.settings.set({ updateSkipVersion: '' }); h.rerender(); };
    },
  });
})();
