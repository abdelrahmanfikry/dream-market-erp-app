/* ==========================================================================
   ERP.utils — formatting, dates, DOM helpers, collections
   ========================================================================== */
window.ERP = window.ERP || {};

(function () {
  const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
  const AR_MONTHS = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
  const AR_DAYS = ['الأحد','الإثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];

  const u = {
    AR_MONTHS, AR_DAYS,

    /* ---- ids & sequences ---- */
    uid(prefix = '') {
      const t = Date.now().toString(36);
      const r = Math.random().toString(36).slice(2, 8);
      return (prefix ? prefix + '_' : '') + t + r;
    },

    /* ---- numbers ---- */
    num(v, def = 0) {
      if (v === null || v === undefined || v === '') return def;
      if (typeof v === 'number') return isFinite(v) ? v : def;
      const s = u.normalizeDigits(String(v)).replace(/[^\d.\-]/g, '');
      const n = parseFloat(s);
      return isFinite(n) ? n : def;
    },
    round(n, d = 2) { const f = Math.pow(10, d); return Math.round((u.num(n) + Number.EPSILON) * f) / f; },
    clamp(n, min, max) { return Math.min(max, Math.max(min, n)); },
    pct(part, total) { return total ? (part / total) * 100 : 0; },
    normalizeDigits(s) {
      return String(s ?? '').replace(/[٠-٩]/g, d => AR_DIGITS.indexOf(d)).replace(/[‏‎؜]/g, '');
    },
    fmtNum(n, dec = 2) {
      n = u.num(n);
      if (Math.abs(n) < 0.5 * Math.pow(10, -dec)) n = 0; // avoid "-0.00"
      return n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
    },
    fmtInt(n) { return u.fmtNum(n, 0); },
    fmtQty(n) {
      n = u.num(n);
      return Number.isInteger(n) ? u.fmtNum(n, 0) : u.fmtNum(n, 3).replace(/\.?0+$/, '');
    },
    currency() { return (ERP.settings && ERP.settings.get('currency')) || 'ج.م'; },
    fmtMoney(n, withCur = true) {
      const s = u.fmtNum(n, 2);
      return withCur ? `${s} ${u.currency()}` : s;
    },
    fmtMoneyShort(n) {
      n = u.num(n);
      const abs = Math.abs(n);
      if (abs >= 1e6) return (n / 1e6).toFixed(1) + 'M';
      if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'K';
      return u.fmtNum(n, 0);
    },

    /* ---- dates (ISO strings everywhere) ---- */
    now() { return new Date().toISOString(); },
    todayISO() { return u.toISODate(new Date()); },
    toISODate(d) {
      d = d instanceof Date ? d : new Date(d);
      if (isNaN(d)) return '';
      const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    },
    parseDate(v) {
      if (!v) return null;
      if (v instanceof Date) return isNaN(v) ? null : v;
      let s = u.normalizeDigits(String(v)).trim();
      // ISO
      let d = new Date(s);
      if (!isNaN(d) && /^\d{4}-\d{2}-\d{2}/.test(s)) return d;
      // d/m/y (legacy ar-EG)
      const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/);
      if (m) {
        let y = +m[3]; if (y < 100) y += 2000;
        d = new Date(y, +m[2] - 1, +m[1]);
        return isNaN(d) ? null : d;
      }
      d = new Date(s);
      return isNaN(d) ? null : d;
    },
    fmtDate(v, opts = {}) {
      const d = u.parseDate(v); if (!d) return '—';
      const dd = String(d.getDate()).padStart(2, '0'), mm = String(d.getMonth() + 1).padStart(2, '0');
      if (opts.long) return `${d.getDate()} ${AR_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
      return `${dd}/${mm}/${d.getFullYear()}`;
    },
    fmtTime(v) {
      const d = u.parseDate(v); if (!d) return '—';
      let h = d.getHours(), m = String(d.getMinutes()).padStart(2, '0');
      const ap = h >= 12 ? 'م' : 'ص'; h = h % 12 || 12;
      return `${h}:${m} ${ap}`;
    },
    fmtDateTime(v) { const d = u.parseDate(v); return d ? `${u.fmtDate(d)} ${u.fmtTime(d)}` : '—'; },
    fmtMonth(v) { const d = u.parseDate(v); return d ? `${AR_MONTHS[d.getMonth()]} ${d.getFullYear()}` : '—'; },
    dayName(v) { const d = u.parseDate(v); return d ? AR_DAYS[d.getDay()] : ''; },
    relTime(v) {
      const d = u.parseDate(v); if (!d) return '';
      const diff = (Date.now() - d.getTime()) / 1000;
      if (diff < 60) return 'الآن';
      if (diff < 3600) return `منذ ${Math.floor(diff / 60)} دقيقة`;
      if (diff < 86400) return `منذ ${Math.floor(diff / 3600)} ساعة`;
      if (diff < 86400 * 7) return `منذ ${Math.floor(diff / 86400)} يوم`;
      return u.fmtDate(d);
    },
    addDays(v, n) { const d = new Date(u.parseDate(v) || Date.now()); d.setDate(d.getDate() + n); return d; },
    startOfMonth(v) { const d = u.parseDate(v) || new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); },
    endOfMonth(v) { const d = u.parseDate(v) || new Date(); return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59); },
    daysBetween(a, b) { const da = u.parseDate(a), db = u.parseDate(b); if (!da || !db) return 0; return Math.floor((db - da) / 86400000); },
    inRange(v, from, to) {
      const d = u.parseDate(v); if (!d) return false;
      const iso = u.toISODate(d);
      if (from && iso < from) return false;
      if (to && iso > to) return false;
      return true;
    },
    monthKey(v) { const d = u.parseDate(v); return d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` : ''; },

    /* ---- strings ---- */
    escapeHtml(s) {
      return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    },
    highlight(text, term) {
      text = u.escapeHtml(text);
      if (!term) return text;
      const t = u.escapeHtml(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return text.replace(new RegExp(`(${t})`, 'gi'), '<mark>$1</mark>');
    },
    normalizeAr(s) {
      return String(s ?? '').toLowerCase()
        .replace(/[أإآا]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/[ً-ْ]/g, '').replace(/ـ/g, '');
    },
    match(text, term) {
      if (!term) return true;
      return u.normalizeAr(u.normalizeDigits(text)).includes(u.normalizeAr(u.normalizeDigits(term)));
    },
    initials(name) { return String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join(''); },
    pad(n, w = 5) { return String(n).padStart(w, '0'); },
    slug(s) { return String(s).trim().replace(/\s+/g, '-'); },

    /* ---- collections ---- */
    sum(arr, fn) { return (arr || []).reduce((a, x) => a + u.num(typeof fn === 'function' ? fn(x) : (fn ? x[fn] : x)), 0); },
    groupBy(arr, key) {
      return (arr || []).reduce((acc, x) => { const k = typeof key === 'function' ? key(x) : x[key]; (acc[k] = acc[k] || []).push(x); return acc; }, {});
    },
    sortBy(arr, key, dir = 'asc') {
      const f = typeof key === 'function' ? key : x => x[key];
      return [...(arr || [])].sort((a, b) => {
        const va = f(a), vb = f(b);
        if (va === vb) return 0;
        if (va === null || va === undefined) return 1;
        if (vb === null || vb === undefined) return -1;
        const r = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), 'ar');
        return dir === 'desc' ? -r : r;
      });
    },
    uniq(arr) { return [...new Set(arr)]; },
    keyBy(arr, key = 'id') { const o = {}; const f = typeof key === 'function' ? key : x => x[key]; (arr || []).forEach(x => { o[f(x)] = x; }); return o; },
    deepClone(o) { return o === undefined ? o : JSON.parse(JSON.stringify(o)); },
    chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; },
    range(n) { return Array.from({ length: n }, (_, i) => i); },

    /* ---- functions ---- */
    debounce(fn, ms = 250) { let t; return function (...a) { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), ms); }; },
    throttle(fn, ms = 200) { let last = 0; return function (...a) { const n = Date.now(); if (n - last > ms) { last = n; fn.apply(this, a); } }; },
    sleep(ms) { return new Promise(r => setTimeout(r, ms)); },

    /* ---- DOM ---- */
    $(sel, root = document) { return root.querySelector(sel); },
    $$(sel, root = document) { return Array.from(root.querySelectorAll(sel)); },
    el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; },
    on(root, evt, sel, fn) {
      root.addEventListener(evt, e => { const t = e.target.closest(sel); if (t && root.contains(t)) fn(e, t); });
    },
    formData(form) {
      const o = {};
      u.$$('[name]', form).forEach(inp => {
        const k = inp.name;
        if (inp.type === 'checkbox') o[k] = inp.checked;
        else if (inp.type === 'number') o[k] = inp.value === '' ? null : u.num(inp.value);
        else o[k] = inp.value.trim();
      });
      return o;
    },
    fillForm(form, data = {}) {
      Object.entries(data).forEach(([k, v]) => {
        const inp = form.querySelector(`[name="${k}"]`);
        if (!inp) return;
        if (inp.type === 'checkbox') inp.checked = !!v;
        else inp.value = v ?? '';
      });
    },
    options(items, { value = 'id', label = 'name', selected = '', empty = null } = {}) {
      let html = empty !== null ? `<option value="">${u.escapeHtml(empty)}</option>` : '';
      (items || []).forEach(it => {
        const v = typeof value === 'function' ? value(it) : it[value];
        const l = typeof label === 'function' ? label(it) : it[label];
        html += `<option value="${u.escapeHtml(v)}" ${String(v) === String(selected) ? 'selected' : ''}>${u.escapeHtml(l)}</option>`;
      });
      return html;
    },
    icon(name, cls = '') { return `<i class="fas fa-${name} ${cls}"></i>`; },
    badge(text, kind = 'neutral') { return `<span class="badge badge-${kind}">${u.escapeHtml(text)}</span>`; },
    money(n, cls = '') {
      n = u.num(n);
      const c = n < 0 ? 'text-danger' : '';
      return `<span class="money ${c} ${cls}">${u.fmtMoney(n)}</span>`;
    },

    /* ---- files ---- */
    downloadBlob(blob, filename) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = filename;
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    },
    downloadText(text, filename, type = 'text/plain') { u.downloadBlob(new Blob(['﻿' + text], { type: type + ';charset=utf-8' }), filename); },
    downloadJSON(obj, filename) { u.downloadBlob(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }), filename); },
    toCSV(rows, columns) {
      const esc = v => { v = v ?? ''; v = String(v).replace(/"/g, '""'); return /[",\n]/.test(v) ? `"${v}"` : v; };
      const head = columns.map(c => esc(c.label)).join(',');
      const body = rows.map(r => columns.map(c => esc(typeof c.value === 'function' ? c.value(r) : r[c.key])).join(',')).join('\n');
      return head + '\n' + body;
    },
    readFile(file, as = 'text') {
      return new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result); fr.onerror = rej;
        as === 'dataURL' ? fr.readAsDataURL(file) : fr.readAsText(file, 'utf-8');
      });
    },
    resizeImage(dataURL, max = 320) {
      return new Promise(res => {
        const img = new Image();
        img.onload = () => {
          const s = Math.min(1, max / Math.max(img.width, img.height));
          const c = document.createElement('canvas'); c.width = img.width * s; c.height = img.height * s;
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          res(c.toDataURL('image/jpeg', .82));
        };
        img.onerror = () => res(dataURL);
        img.src = dataURL;
      });
    },

    /* ---- misc ---- */
    statusBadge(status) {
      const map = {
        paid: ['مدفوعة', 'success'], partial: ['جزئي', 'warning'], unpaid: ['غير مدفوعة', 'danger'], returned: ['مرتجعة', 'purple'], void: ['ملغاة', 'neutral'],
        draft: ['مسودة', 'neutral'], ordered: ['مطلوب', 'info'], received: ['مستلم', 'success'], billed: ['مفوتر', 'primary'], cancelled: ['ملغي', 'danger'],
        open: ['مفتوحة', 'success'], closed: ['مغلقة', 'neutral'], active: ['نشط', 'success'], inactive: ['غير نشط', 'neutral'],
        pending: ['معلق', 'warning'], approved: ['معتمد', 'success'], rejected: ['مرفوض', 'danger'], done: ['منجز', 'success'],
        present: ['حاضر', 'success'], absent: ['غائب', 'danger'], late: ['متأخر', 'warning'], leave: ['إجازة', 'info'],
      };
      const [t, k] = map[status] || [status, 'neutral'];
      return u.badge(t, k);
    },
    stockBadge(p) {
      const q = u.num(p.stock), min = u.num(p.minStock, 5);
      if (q <= 0) return u.badge('نفذ', 'danger');
      if (q <= min) return u.badge('منخفض', 'warning');
      return u.badge('متوفر', 'success');
    },
    /* ---- crypto (PBKDF2 for PINs; hashStr is the LEGACY non-cryptographic hash, kept to verify old PINs) ---- */
    hasSubtle() { return !!(window.crypto && crypto.subtle && crypto.getRandomValues); },
    randomBytes(n = 16) { const b = new Uint8Array(n); if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(b); else for (let i = 0; i < n; i++) b[i] = Math.floor(Math.random() * 256); return b; },
    randomHex(n = 16) { return Array.from(u.randomBytes(n), b => b.toString(16).padStart(2, '0')).join(''); },
    b64(bytes) { let s = ''; new Uint8Array(bytes).forEach(b => { s += String.fromCharCode(b); }); return btoa(s); },
    unb64(s) { return Uint8Array.from(atob(s), c => c.charCodeAt(0)); },
    /** PBKDF2-SHA256 → Uint8Array(32). Requires crypto.subtle (secure context / file:// / Electron) */
    async pbkdf2(pass, salt, iterations) {
      const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(pass)), 'PBKDF2', false, ['deriveBits']);
      return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, k, 256));
    },
    /** constant-time string compare */
    safeEq(a, b) { a = String(a); b = String(b); let d = a.length ^ b.length; for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0); return d === 0; },
    hashStr(s) {
      // LEGACY deterministic djb2-xor + FNV 32bit → hex (not cryptographic; only used to verify/upgrade old PIN hashes)
      let h = 5381; s = String(s);
      for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
      let h2 = 0x811c9dc5;
      for (let i = 0; i < s.length; i++) { h2 ^= s.charCodeAt(i); h2 = Math.imul(h2, 0x01000193); }
      return (h >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
    },
    copy(text) { try { navigator.clipboard.writeText(text); return true; } catch { return false; } },
    isMobile() { return window.matchMedia('(max-width: 1024px)').matches; },
    numToArabicWords(n) {
      // Simplified Arabic number-to-words for invoices (up to millions)
      n = Math.floor(Math.abs(u.num(n)));
      if (n === 0) return 'صفر';
      const ones = ['', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة', 'عشرة', 'أحد عشر', 'اثنا عشر', 'ثلاثة عشر', 'أربعة عشر', 'خمسة عشر', 'ستة عشر', 'سبعة عشر', 'ثمانية عشر', 'تسعة عشر'];
      const tens = ['', '', 'عشرون', 'ثلاثون', 'أربعون', 'خمسون', 'ستون', 'سبعون', 'ثمانون', 'تسعون'];
      const hundreds = ['', 'مائة', 'مائتان', 'ثلاثمائة', 'أربعمائة', 'خمسمائة', 'ستمائة', 'سبعمائة', 'ثمانمائة', 'تسعمائة'];
      const below1000 = x => {
        const parts = [];
        const h = Math.floor(x / 100), r = x % 100;
        if (h) parts.push(hundreds[h]);
        if (r < 20) { if (r) parts.push(ones[r]); }
        else { const o = r % 10, t = Math.floor(r / 10); parts.push(o ? `${ones[o]} و${tens[t]}` : tens[t]); }
        return parts.join(' و');
      };
      const parts = [];
      const mil = Math.floor(n / 1e6), th = Math.floor((n % 1e6) / 1000), rest = n % 1000;
      if (mil) parts.push(mil === 1 ? 'مليون' : mil === 2 ? 'مليونان' : `${below1000(mil)} مليون`);
      if (th) parts.push(th === 1 ? 'ألف' : th === 2 ? 'ألفان' : th <= 10 ? `${below1000(th)} آلاف` : `${below1000(th)} ألف`);
      if (rest) parts.push(below1000(rest));
      return parts.join(' و');
    },
  };

  ERP.utils = u;
  // handy globals
  window.$ = u.$; window.$$ = u.$$;
})();
