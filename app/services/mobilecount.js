/* ==========================================================================
   ERP.mobilecount — mobile stocktake (count.html on the phone)
   - parse(text): counts file exported by count.html (JSON / CSV) → [{code, qty}]
   - merge(counts, lines, {mode, products}) — PURE: file/LAN lines → stocktake map
     (BASE units: a unit barcode (product.units[].barcode) adds factor × qty,
     alt barcodes (product.barcodes[].qty) add their pack qty)
   - LAN (desktop app only): window.desktop.lanCount* starts an HTTPS server that
     serves count.html + /api/products + /api/counts (token protected); incoming
     batches arrive through window.desktop.onMobileCounts
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  const u = ERP.utils; const e = u.escapeHtml;
  const P = () => ERP.db.collection('products');
  const norm = c => u.normalizeDigits(String(c ?? '')).trim();

  const mc = {
    /** counts file → [{code, qty, name?}] (JSON from count.html, a plain array, or CSV "barcode,qty[,name]") */
    parse(text) {
      text = String(text || '').replace(/^﻿/, '').trim(); if (!text) return [];
      if (/^[[{]/.test(text)) {
        const j = JSON.parse(text); const arr = Array.isArray(j) ? j : (j.items || j.counts || j.lines || []);
        return arr.map(x => ({ code: norm(x.code ?? x.barcode ?? x.productId ?? x.c), qty: u.num(x.qty ?? x.q ?? x.count ?? 1), name: x.name || x.n || '', productId: x.productId || null })).filter(x => x.code || x.productId);
      }
      const rows = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const sep = [',', ';', '\t'].map(s => [s, (rows[0].match(new RegExp(s === '\t' ? '\\t' : s, 'g')) || []).length]).sort((a, b) => b[1] - a[1])[0][0];
      const split = l => { const out = []; let cur = '', q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === sep && !q) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out.map(x => x.trim()); };
      let ci = 0, qi = 1, ni = 2; const head = split(rows[0]).map(h => h.toLowerCase());
      const hasHead = head.some(h => /code|barcode|باركود|كود|qty|كمية|العدد/.test(h));
      if (hasHead) { const f = re => head.findIndex(h => re.test(h)); ci = Math.max(0, f(/barcode|باركود|code|كود/)); const q = f(/qty|quantity|count|كمية|العدد|المعدود/); qi = q < 0 ? 1 : q; const n = f(/name|اسم|الصنف/); ni = n < 0 ? -1 : n; }
      return rows.slice(hasHead ? 1 : 0).map(l => { const c = split(l); return { code: norm(c[ci]), qty: c[qi] === undefined || c[qi] === '' ? 1 : u.num(norm(c[qi])), name: ni >= 0 ? c[ni] || '' : '' }; }).filter(x => x.code);
    },
    /** code → { product, factor } for barcode, unit barcodes, alt barcodes and product code */
    index(products) {
      const ix = new Map(); const put = (k, v) => { k = norm(k); if (k && !ix.has(k)) ix.set(k, v); };
      (products || []).forEach(p => { if (p.barcode) put(p.barcode, { product: p, factor: 1 }); });
      (products || []).forEach(p => { (p.units || []).forEach(un => { if (un && un.barcode) put(un.barcode, { product: p, factor: u.num(un.factor, 1) || 1, unit: un.name }); }); (p.barcodes || []).forEach(b => { if (b && b.code) put(b.code, { product: p, factor: u.num(b.qty, 1) || 1 }); }); });
      (products || []).forEach(p => { if (p.code) put(p.code, { product: p, factor: 1 }); });
      return ix;
    },
    /** resolve one code: index first, then the app's scan resolver (scale barcodes …) */
    match(code, ix, resolve) {
      code = norm(code); const hit = ix.get(code); if (hit) return hit;
      if (resolve) { try { const r = resolve(code); if (r && r.product) return { product: r.product, factor: u.num(r.qty, 1) || 1 }; } catch { /* resolver failed */ } }
      return null;
    },
    /**
     * PURE merge of mobile lines into a stocktake map (productId → counted BASE qty)
     * mode 'sum' adds to what is already counted, 'replace' sets the counted qty of each product in the file
     * returns { counts (new object), matched, unmatched:[{code, qty, name}], touched:[productId], lastId }
     */
    merge(counts, lines, { mode = 'sum', products = [], resolve = null } = {}) {
      const ix = mc.index(products); const byId = new Map(products.map(p => [p.id, p]));
      const add = {}; const unmatched = {}; let matched = 0, lastId = null;
      (lines || []).forEach(l => {
        const qty = u.num(l.qty); if (!qty && mode === 'sum') return;
        const hit = l.productId && byId.has(l.productId) ? { product: byId.get(l.productId), factor: 1 } : mc.match(l.code, ix, resolve);
        if (!hit) { const k = norm(l.code || l.productId); const x = unmatched[k] = unmatched[k] || { code: k, qty: 0, name: l.name || '' }; x.qty = u.round(x.qty + qty, 3); return; }
        matched++; lastId = hit.product.id;
        add[hit.product.id] = u.round(u.num(add[hit.product.id]) + qty * hit.factor, 4);
      });
      const out = { ...(counts || {}) };
      Object.entries(add).forEach(([id, q]) => { out[id] = mode === 'replace' ? q : u.round(u.num(out[id]) + q, 4); });
      return { counts: out, matched, unmatched: Object.values(unmatched), touched: Object.keys(add), lastId };
    },
    /** product list for the phone (names/units) — small keys to keep it light */
    catalog() {
      return P().all().filter(p => p.active !== false).map(p => ({ id: p.id, c: p.code || '', b: u.uniq([p.barcode, ...(p.barcodes || []).map(b => b.code)].filter(Boolean)), n: p.name, un: (ERP.db.collection('units').get(p.unitId) || {}).name || '', u: (p.units || []).filter(x => x && x.barcode).map(x => ({ b: x.barcode, n: x.name, f: u.num(x.factor, 1) })) }));
    },

    /* ---------- LAN (desktop) ---------- */
    get lanAvailable() { return !!(window.desktop && window.desktop.lanCountStart); },
    lan: null, // { urls, token, port, proto, warning }
    async lanStart() {
      if (!mc.lanAvailable) throw new Error('متاح في تطبيق سطح المكتب فقط');
      const r = await window.desktop.lanCountStart({ products: mc.catalog(), store: ERP.settings.get('storeName') || '', port: 8765 });
      if (!r || !r.ok) throw new Error((r && r.err) || 'تعذّر تشغيل خادم الشبكة');
      mc.lan = r; return r;
    },
    async lanStop() { mc.lan = null; if (mc.lanAvailable) { try { await window.desktop.lanCountStop(); } catch { /* */ } } },
    onLan(cb) { return mc.lanAvailable && window.desktop.onMobileCounts ? window.desktop.onMobileCounts(cb) : () => { }; },
    url(r, ip) { r = r || mc.lan; if (!r) return ''; return `${r.proto}://${ip || r.ips[0]}:${r.port}/count.html?token=${encodeURIComponent(r.token)}`; },

    /* ---------- UI helpers for the stocktake dialog ---------- */
    /** ask sum/replace → resolves 'sum' | 'replace' | null */
    askMode(n) {
      return new Promise(res => {
        const h = ERP.ui.modal({ title: 'دمج عدّ الموبايل', icon: 'mobile-screen', size: 'sm', body: `<p>الملف يحتوي على <strong class="num">${n}</strong> سطر. كيف تريد دمجه مع الكميات المعدودة حالياً؟</p><ul class="text-sm muted mt-2" style="padding-inline-start:1.2rem"><li><strong>جمع</strong>: تُضاف الكميات على المعدود (عدّ أكثر من شخص / أكثر من رف)</li><li><strong>استبدال</strong>: كمية الصنف الموجود في الملف تحل محل المعدود له</li></ul>`, footer: `<button class="btn" data-m="">إلغاء</button><div class="flex-1"></div><button class="btn btn-outline" data-m="replace">استبدال</button><button class="btn btn-primary" data-m="sum">جمع</button>`, onClose: r => res(r || null) });
        h.el.addEventListener('click', ev => { const b = ev.target.closest('[data-m]'); if (b) h.close(b.dataset.m || null); });
      });
    },
    unmatchedView(list) {
      if (!list.length) return;
      ERP.ui.view('أكواد غير معروفة', `<div class="alert alert-warning mb-3"><i class="fas fa-triangle-exclamation"></i> ${list.length} كود لم يُطابق أي صنف (باركود / باركود وحدة / كود) — لم تُضف للجرد.</div><div class="table-wrap" style="max-height:50vh;overflow:auto"><table class="table table-compact"><thead><tr><th>الكود</th><th>الاسم (من الموبايل)</th><th class="num">الكمية</th></tr></thead><tbody>${list.map(x => `<tr><td class="num">${e(x.code)}</td><td>${e(x.name || '—')}</td><td class="num">${u.fmtQty(x.qty)}</td></tr>`).join('')}</tbody></table></div>`, { size: '', footer: `<button class="btn" data-act="view-close">إغلاق</button><button class="btn btn-outline" id="mc-unm-copy"><i class="fas fa-copy"></i> نسخ</button>` });
      const b = document.getElementById('mc-unm-copy'); if (b) b.onclick = () => { u.copy(list.map(x => `${x.code},${x.qty},${x.name || ''}`).join('\n')); ERP.ui.success('تم النسخ'); };
    },
    /** QR panel html for a running LAN session */
    qrPanelHtml(r) {
      return `<div class="flex gap-3 flex-wrap items-start"><div id="mc-qr" style="background:#fff;padding:8px;border-radius:8px;min-width:176px;min-height:176px"></div><div class="flex-1" style="min-width:240px"><div class="form-group" style="margin:0 0 .5rem"><label>عنوان الجهاز على الشبكة</label><select id="mc-ip">${r.ips.map(ip => `<option value="${e(ip)}">${e(ip)}</option>`).join('')}</select></div><div class="text-sm num" id="mc-url" style="direction:ltr;word-break:break-all"></div><div class="mt-2">رمز الجلسة: <strong class="num" style="font-size:1.3rem;letter-spacing:.15em">${e(r.token)}</strong></div><div class="text-sm mt-2" id="mc-stat">في انتظار الموبايل…</div></div></div><div class="alert alert-info mt-3 text-sm"><i class="fas fa-circle-info"></i> ${r.proto === 'https' ? 'امسح الرمز بكاميرا الموبايل (نفس شبكة الواي فاي). أول مرة سيظهر تحذير «الاتصال ليس خاصاً» لأن الشهادة ذاتية التوقيع وخاصة بهذا الجهاز: اضغط <strong>متقدم ← المتابعة إلى العنوان</strong> — مرة واحدة فقط. بعدها تعمل الكاميرا لمسح الباركود.' : 'الخادم يعمل بدون تشفير (HTTP): الكاميرا لن تعمل في المتصفح إلا بتفعيل chrome://flags ← «Insecure origins treated as secure» لهذا العنوان، أو استخدم الإدخال اليدوي / قارئ الباركود البلوتوث.'} الكميات المرسلة تُضاف (جمع) للجرد المفتوح مباشرة. إذا لم يفتح الرابط على الموبايل: تأكد أن الجهازين على نفس الشبكة واسمح للبرنامج في «جدار حماية Windows» (الشبكات الخاصة) عند ظهور السؤال.${r.warning ? `<br>${e(r.warning)}` : ''}</div>`;
    },
  };
  ERP.mobilecount = mc;
})();
