/* ==========================================================================
   ERP.autoBackup — automatic backups to a folder / USB drive and Google Drive
   - Local: desktop → IPC write to a chosen folder (retention in main.js);
     browser → File System Access directory handle (kept in its own tiny
     IndexedDB 'dm_erp_fs' — ERP.db.kv JSON-serializes in localStorage mode);
     no API (Firefox, some file:// cases) → a normal download
   - Drive: POST to the owner's Google Apps Script Web App (text/plain → no CORS
     preflight), body { token, name, store, branch, gz, data } (gzip+base64)
   - When: on shift close (db:change on 'shifts') and/or daily at a time
   - File content = ERP.db.export() — the same file the manual backup/restore uses
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  const u = ERP.utils; const e = u.escapeHtml;
  ERP.settings.extend({
    abEnabled: false, abWhen: 'both', abTime: '23:30', abKeep: 14,
    driveEnabled: false, driveUrl: '', driveToken: '', driveWhen: 'same', driveKeep: 30,
  });
  const DRIVE_MAX = 48 * 1024 * 1024; // Apps Script rejects POST bodies around 50MB
  const kvGet = k => ERP.db.kvGet(k).catch(() => null), kvSet = (k, v) => ERP.db.kvSet(k, v).catch(() => { });
  const isDesk = () => !!(window.desktop && window.desktop.writeBackupTo);
  const fsApi = () => typeof window.showDirectoryPicker === 'function';

  /* ---------- tiny IndexedDB just for the directory handle (structured clone keeps it usable) ---------- */
  let hdb = null, memHandle;
  const hOpen = () => hdb || (hdb = new Promise((res, rej) => { const r = indexedDB.open('dm_erp_fs', 1); r.onupgradeneeded = () => r.result.createObjectStore('h'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }));
  const hReq = (mode, fn) => hOpen().then(d => new Promise((res, rej) => { const tx = d.transaction('h', mode); const r = fn(tx.objectStore('h')); tx.oncomplete = () => res(r && r.result); tx.onerror = () => rej(tx.error); }));
  async function getHandle() { if (memHandle !== undefined) return memHandle; try { memHandle = (await hReq('readonly', s => s.get('backupDir'))) || null; } catch { memHandle = null; } return memHandle; }
  async function setHandle(h) { memHandle = h; await hReq('readwrite', s => s.put(h, 'backupDir')); }

  const pad = n => String(n).padStart(2, '0');
  const ab = {
    DRIVE_MAX,
    /* ---------- pure helpers ---------- */
    sanitize(s, def = 'store') { const t = String(s || '').trim().replace(/[\\/:*?"<>|\x00-\x1f]+/g, '').replace(/\s+/g, '_').replace(/^\.+/, '').slice(0, 40); return t || def; },
    prefix(s = ERP.settings.all()) { return `${ab.sanitize(s.storeName)}-${ab.sanitize(s.branchCode, 'MAIN')}-`; },
    /** <store>-<branch>-YYYY-MM-DD_HHmm.json (local time) */
    fileName(s = ERP.settings.all(), d = new Date()) { return `${ab.prefix(s)}${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.json`; },
    snapshot() { return JSON.stringify(ERP.db.export()); },
    b64(buf) { let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000)); return btoa(s); },
    unb64(str) { const bin = atob(str); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; },
    /** gzip+base64 when CompressionStream exists → { gz, data } */
    async encode(json) {
      if (typeof CompressionStream === 'undefined') return { gz: false, data: json };
      const st = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
      return { gz: true, data: ab.b64(new Uint8Array(await new Response(st).arrayBuffer())) };
    },
    /** inverse of encode (what the Apps Script does with base64Decode + ungzip) */
    async decode({ gz, data }) { if (!gz) return data; const st = new Blob([ab.unb64(data)]).stream().pipeThrough(new DecompressionStream('gzip')); return new Response(st).text(); },
    buildDriveBody({ token, name, store, branch, keep }, enc) { return JSON.stringify({ app: 'DreamMarketERP', v: 1, token: String(token || ''), name, store, branch, keep: u.num(keep) || 0, gz: !!enc.gz, data: enc.data }); },
    /** schedule match: when ∈ shift|daily|both|manual, kind ∈ shift|daily */
    due(when, kind) { return when === 'both' || when === kind; },

    /* ---------- local folder ---------- */
    async folderLabel() { if (isDesk()) return (await kvGet('ab.dir')) || ''; const h = fsApi() ? await getHandle() : null; return h ? h.name : ''; },
    async chooseFolder() {
      if (isDesk()) { const d = await window.desktop.chooseBackupFolder(); if (d) await kvSet('ab.dir', d); return d; }
      if (!fsApi()) throw new Error('هذا المتصفح لا يدعم اختيار مجلد (استخدم Chrome أو Edge، أو نسخة سطح المكتب) — سيتم تنزيل النسخ كملفات عادية');
      const h = await window.showDirectoryPicker({ id: 'dm-erp-backup', mode: 'readwrite', startIn: 'documents' });
      await setHandle(h); return h.name;
    },
    openFolder() { if (isDesk()) kvGet('ab.dir').then(d => window.desktop.openBackupFolder(d || '')); },
    /** 'granted' | 'prompt' | 'denied' | 'none' — gesture=true may show the browser permission prompt */
    async permission(gesture = false) {
      const h = await getHandle(); if (!h) return 'none';
      let p = await h.queryPermission({ mode: 'readwrite' });
      if (p !== 'granted' && gesture) p = await h.requestPermission({ mode: 'readwrite' });
      return p;
    },
    async _writeHandle(h, name, json, keep, prefix) {
      const fh = await h.getFileHandle(name, { create: true }); const w = await fh.createWritable(); await w.write(new Blob([json], { type: 'application/json' })); await w.close();
      let removed = 0;
      if (keep > 0) { const mine = []; for await (const [n, x] of h.entries()) if (x.kind === 'file' && n.startsWith(prefix) && /\.json$/i.test(n)) mine.push(n); mine.sort().reverse(); for (const n of mine.slice(keep)) { try { await h.removeEntry(n); removed++; } catch { /* */ } } }
      return removed;
    },
    /** one local backup → result recorded in kv 'ab.last' */
    async runLocal(reason = 'manual', { json, gesture = false } = {}) {
      const s = ERP.settings.all(); const name = ab.fileName(s), prefix = ab.prefix(s), keep = Math.max(0, Math.round(u.num(s.abKeep, 14)));
      json = json || ab.snapshot(); let r;
      try {
        if (isDesk()) {
          const dir = await kvGet('ab.dir');
          const x = await window.desktop.writeBackupTo({ dir: dir || '', name, json, keep, prefix });
          if (!x || !x.ok) throw new Error((x && x.err) || 'فشل الحفظ');
          r = { ok: true, target: 'folder', where: x.dir, removed: x.removed };
        } else if (fsApi() && await getHandle()) {
          const h = await getHandle(); const p = await ab.permission(gesture);
          if (p !== 'granted') { r = { ok: false, needPerm: true, err: 'المتصفح يحتاج إذناً للكتابة في المجلد — اضغط «تفعيل النسخ للمجلد»' }; ab._askPermission(); }
          else r = { ok: true, target: 'folder', where: h.name, removed: await ab._writeHandle(h, name, json, keep, prefix) };
        } else {
          u.downloadBlob(new Blob([json], { type: 'application/json' }), name);
          r = { ok: true, target: 'download', where: 'مجلد التنزيلات', note: fsApi() ? 'لم يُختر مجلد — تم التنزيل' : 'المتصفح لا يدعم الكتابة لمجلد — تم التنزيل' };
        }
      } catch (err) { r = { ok: false, err: String((err && err.message) || err) }; }
      r = { ...r, at: u.now(), reason, name, bytes: json.length };
      await kvSet('ab.last', r);
      if (r.ok) ERP.settings.set({ lastAutoFolderBackup: r.at });
      else if (!r.needPerm) ab._fail('فشل النسخ الاحتياطي للمجلد', r.err);
      ERP.bus.emit('autobackup:done', { kind: 'local', result: r });
      return r;
    },
    _askPermission() {
      if (ERP.notifications) ERP.notifications.push({ type: 'warning', title: 'اضغط لتفعيل النسخ للمجلد', text: 'المتصفح يطلب إذناً جديداً للكتابة في مجلد النسخ الاحتياطي', link: 'settings', params: { sec: 'autobackup' }, key: 'abperm_' + u.todayISO() });
      if (ERP.ui && ERP.ui.toast) ERP.ui.toast('المتصفح يحتاج إذنك لحفظ النسخة في المجلد المختار', 'warning', { title: 'النسخ الاحتياطي', duration: 60000, action: { label: 'اضغط لتفعيل النسخ للمجلد', onClick: () => ab.grantAndRun() } });
    },
    /** must run inside a click (user gesture) */
    async grantAndRun() { try { const p = await ab.permission(true); if (p !== 'granted') return ERP.ui.warn('لم يُمنح الإذن'); const r = await ab.runLocal('manual', { gesture: true }); r.ok ? ERP.ui.success(`تم حفظ النسخة في ${r.where}`) : ERP.ui.error(r.err); } catch (err) { ERP.ui.error(err.message); } },
    _fail(title, err) { if (ERP.notifications) ERP.notifications.push({ type: 'danger', title, text: String(err || ''), link: 'settings', params: { sec: 'autobackup' }, key: 'abfail_' + title + u.todayISO() }); },

    /* ---------- Google Drive (Apps Script Web App) ---------- */
    async _post(url, body) {
      let res;
      try { res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body, redirect: 'follow', cache: 'no-store' }); }
      catch { return { ok: false, unknown: true, err: navigator.onLine === false ? 'لا يوجد اتصال بالإنترنت' : 'تعذر قراءة رد Google (شبكة/CORS) — قد تكون النسخة وصلت؛ تحقق من مجلد Drive ومن أن النشر «Anyone»' }; }
      const t = await res.text().catch(() => ''); let j = null; try { j = JSON.parse(t); } catch { /* */ }
      if (!j) return { ok: false, err: /<html|<!doctype/i.test(t) ? 'الرابط أعاد صفحة HTML بدل JSON — تأكد من النشر كـ Web app بصلاحية Anyone ومن نسخ رابط ‎/exec' : `رد غير متوقع (HTTP ${res.status})` };
      if (!j.ok) return { ok: false, err: j.error === 'unauthorized' ? 'الرمز السري لا يطابق الموجود في السكربت' : String(j.error || 'خطأ من السكربت') };
      return j;
    },
    _driveCheck(s) { if (!/^https:\/\//i.test(s.driveUrl || '')) throw new Error('أدخل رابط Google Apps Script (ينتهي بـ ‎/exec)'); if (!s.driveToken) throw new Error('أدخل الرمز السري (نفس الموجود في السكربت)'); },
    async testDrive() { const s = ERP.settings.all(); ab._driveCheck(s); return ab._post(s.driveUrl.trim(), JSON.stringify({ app: 'DreamMarketERP', v: 1, token: s.driveToken, action: 'ping', store: s.storeName, branch: s.branchCode })); },
    async uploadDrive(reason = 'manual', { json } = {}) {
      const s = ERP.settings.all(); const name = ab.fileName(s); let r;
      try {
        ab._driveCheck(s);
        json = json || ab.snapshot();
        const enc = await ab.encode(json);
        const body = ab.buildDriveBody({ token: s.driveToken, name, store: ab.sanitize(s.storeName), branch: ab.sanitize(s.branchCode, 'MAIN'), keep: s.driveKeep }, enc);
        if (body.length > DRIVE_MAX) throw new Error(`حجم النسخة ${(body.length / 1048576).toFixed(1)} MB يتجاوز حد Google Apps Script (~50MB) — نظّف السجلات القديمة أو استخدم النسخ للمجلد`);
        const j = await ab._post(s.driveUrl.trim(), body);
        r = j.ok ? { ok: true, where: j.folder || 'Google Drive', removed: j.deleted || 0, fileId: j.id || '' } : { ok: false, unknown: !!j.unknown, err: j.err };
        r.bytes = body.length; r.gz = enc.gz;
      } catch (err) { r = { ok: false, err: String((err && err.message) || err) }; }
      r = { ...r, at: u.now(), reason, name };
      await kvSet('drive.last', r);
      if (!r.ok) ab._fail('فشل رفع النسخة إلى Google Drive', r.err);
      ERP.bus.emit('autobackup:done', { kind: 'drive', result: r });
      return r;
    },

    /* ---------- scheduling ---------- */
    driveWhen(s = ERP.settings.all()) { return s.driveWhen === 'same' ? s.abWhen : s.driveWhen; },
    /** kind: 'shift' | 'daily' | 'manual' — runs every enabled target whose schedule matches */
    async trigger(kind, { force = false } = {}) {
      if (ab._busy) return null; ab._busy = true;
      try {
        const s = ERP.settings.all(); const local = s.abEnabled && (force || ab.due(s.abWhen, kind)), drive = s.driveEnabled && !!s.driveUrl && (force || ab.due(ab.driveWhen(s), kind));
        if (!local && !drive) return null;
        const json = ab.snapshot(); const out = {};
        if (local) out.local = await ab.runLocal(kind, { json });
        if (drive) out.drive = await ab.uploadDrive(kind, { json });
        return out;
      } finally { ab._busy = false; }
    },
    ready() { return !!(ERP.db && ERP.db.isReady && ERP.db.isReady() && !ERP.db.isReadOnly() && ERP.app && ERP.app._shell && ERP.auth && ERP.auth.current() && !ERP.testing); },
    /** every minute: daily backups once per day at/after the configured time (a late launch still backs up that day) */
    async tick() {
      if (!ab.ready() || ab._busy) return;
      const s = ERP.settings.all(); const d = new Date(); const now = `${pad(d.getHours())}:${pad(d.getMinutes())}`, today = u.todayISO();
      if (now < (s.abTime || '23:30')) return;
      const wantL = s.abEnabled && ab.due(s.abWhen, 'daily'), wantD = s.driveEnabled && s.driveUrl && ab.due(ab.driveWhen(s), 'daily');
      const doL = wantL && (await kvGet('ab.lastDaily')) !== today, doD = wantD && (await kvGet('drive.lastDaily')) !== today;
      if (!doL && !doD) return;
      ab._busy = true;
      try {
        const json = ab.snapshot();
        if (doL) { await kvSet('ab.lastDaily', today); await ab.runLocal('daily', { json }); }
        if (doD) { await kvSet('drive.lastDaily', today); await ab.uploadDrive('daily', { json }); }
      } finally { ab._busy = false; }
    },
    async last() { return { local: await kvGet('ab.last'), drive: await kvGet('drive.last') }; },
  };
  ERP.autoBackup = ab;

  /* shift closed → backup (listens to db writes; the shift files stay untouched) */
  const seenShift = new Set();
  ERP.bus.on('db:change', ev => {
    if (!ev || ev.collection !== 'shifts' || ev.op !== 'update' || !ev.doc || ev.doc.status !== 'closed' || seenShift.has(ev.doc.id)) return;
    if (!ev.doc.closedAt || Date.now() - new Date(ev.doc.closedAt).getTime() > 3 * 60 * 1000) return; // only a fresh close (not edits of old shifts)
    seenShift.add(ev.doc.id);
    if (!ab.ready()) return;
    setTimeout(() => ab.trigger('shift').catch(err => console.warn('[autobackup]', err && err.message)), 1500);
  });
  setTimeout(() => { ab.tick(); setInterval(() => ab.tick().catch(() => { }), 60 * 1000); }, 20 * 1000);

  /* ---------- Google Apps Script (the owner pastes this in the client's Google account) ---------- */
  ab.appsScript = (token = 'CHANGE_ME') => String.raw`/**
 * Dream Market ERP — استقبال النسخ الاحتياطية في Google Drive
 * انشر كـ Web app:  Execute as = Me ،  Who has access = Anyone
 */
const TOKEN = '` + String(token).replace(/[\\']/g, '') + String.raw`';   // نفس «الرمز السري» في إعدادات النظام
const FOLDER_ID = '';                      // اختياري: ID مجلد محدد (من رابط المجلد) — أو اتركه فارغاً
const FOLDER_NAME = 'Dream Market Backups'; // يُنشأ تلقائياً إن لم يوجد
const KEEP_LAST = 30;                      // عدد النسخ المحفوظة لكل متجر/فرع (0 = بلا حد)
const KEEP_DAYS = 0;                       // حذف النسخ الأقدم من N يوم (0 = معطّل)

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    if (!req || req.token !== TOKEN) return out_({ ok: false, error: 'unauthorized' });
    const folder = folder_();
    if (req.action === 'ping') return out_({ ok: true, folder: folder.getName(), url: folder.getUrl() });
    const prefix = clean_(req.store || 'store') + '-' + clean_(req.branch || 'MAIN') + '-';
    let name = clean_(req.name || '');
    if (name.indexOf(prefix) !== 0) name = prefix + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd_HHmm') + '.json';
    if (!/\.json$/i.test(name)) name += '.json';
    const text = req.gz
      ? Utilities.ungzip(Utilities.newBlob(Utilities.base64Decode(req.data), 'application/x-gzip')).getDataAsString('UTF-8')
      : (typeof req.data === 'string' ? req.data : JSON.stringify(req.data));
    JSON.parse(text); // يرفض الملفات التالفة
    const file = folder.createFile(Utilities.newBlob(text, 'application/json', name));
    const keep = Number(req.keep) > 0 ? Math.min(Number(req.keep), 365) : KEEP_LAST;
    return out_({ ok: true, id: file.getId(), name: name, size: file.getSize(), folder: folder.getName(), deleted: cleanup_(folder, prefix, keep) });
  } catch (err) {
    return out_({ ok: false, error: String(err && err.message || err) });
  }
}
function doGet() { return out_({ ok: true, app: 'DreamMarketERP-backup' }); }
function folder_() {
  if (FOLDER_ID) return DriveApp.getFolderById(FOLDER_ID);
  const it = DriveApp.getFoldersByName(FOLDER_NAME);
  return it.hasNext() ? it.next() : DriveApp.createFolder(FOLDER_NAME);
}
function cleanup_(folder, prefix, keep) {
  const files = [], it = folder.getFiles();
  while (it.hasNext()) { const f = it.next(); if (f.getName().indexOf(prefix) === 0) files.push(f); }
  files.sort(function (a, b) { return b.getDateCreated() - a.getDateCreated(); });
  const cutoff = KEEP_DAYS ? Date.now() - KEEP_DAYS * 864e5 : 0; let n = 0;
  files.forEach(function (f, i) {
    if (i === 0) return; // أحدث نسخة لا تُحذف أبداً
    if ((keep && i >= keep) || (cutoff && f.getDateCreated().getTime() < cutoff)) { f.setTrashed(true); n++; } // إلى سلة Drive (تُستعاد خلال 30 يوماً)
  });
  return n;
}
function clean_(s) { return String(s).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '').replace(/\s+/g, '_').slice(0, 120); }
function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
`;

  /* ---------- settings section ---------- */
  const WHEN = { both: 'عند إغلاق الوردية + يومياً', shift: 'عند إغلاق الوردية فقط', daily: 'يومياً في موعد محدد', manual: 'يدوياً فقط' };
  const fmtRes = r => !r ? 'لم يتم بعد' : `${r.ok ? '<span class="text-success"><i class="fas fa-circle-check"></i> نجح</span>' : `<span class="${r.unknown ? 'text-warning' : 'text-danger'}"><i class="fas fa-${r.unknown ? 'circle-question' : 'circle-xmark'}"></i> ${r.unknown ? 'غير مؤكد' : 'فشل'}</span>`} · ${u.fmtDateTime(r.at)} (${u.relTime(r.at)}) · ${e(r.name || '')}${r.bytes ? ` · ${(r.bytes / 1048576).toFixed(2)} MB` : ''}${r.where ? ` · ${e(r.where)}` : ''}${r.removed ? ` · حُذف ${r.removed} قديم` : ''}${r.note ? ` · ${e(r.note)}` : ''}${r.err ? `<div class="text-danger">${e(r.err)}</div>` : ''}`;
  ERP.settingsSections = ERP.settingsSections || [];
  ERP.settingsSections.push({
    id: 'autobackup', icon: 'hard-drive', label: 'النسخ الاحتياطي التلقائي',
    render(s, h) {
      const opt = (m, cur) => Object.entries(m).map(([k, l]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${l}</option>`).join('');
      const where = isDesk() ? 'تطبيق سطح المكتب: اختر أي مجلد أو فلاشة USB (بدون اختيار → Documents\\Dream Market ERP Backups).' : fsApi() ? 'المتصفح: اختر مجلداً أو فلاشة؛ قد يطلب المتصفح تأكيد الإذن بعد إعادة فتحه — سيظهر لك زر «اضغط لتفعيل النسخ للمجلد».' : 'هذا المتصفح لا يدعم الكتابة المباشرة في مجلد (مثل Firefox أو الفتح كملف) — سيتم تنزيل النسخة كملف في مجلد التنزيلات. استخدم Chrome/Edge أو تطبيق سطح المكتب للحفظ على الفلاشة تلقائياً.';
      return `<h4 class="mb-2"><i class="fas fa-folder-open text-primary"></i> نسخ تلقائي إلى مجلد / فلاشة</h4><div class="alert alert-info mb-3"><i class="fas fa-circle-info"></i> ${e(where)} اسم الملف: <code dir="ltr">${e(ab.fileName(s))}</code> — نفس ملف «نسخة كاملة (JSON)» ويُستعاد من صفحة النسخ الاحتياطي.</div>`
        + h.row('تفعيل النسخ التلقائي للمجلد', '', h.sw('abEnabled', s.abEnabled))
        + h.row('التوقيت', '', `<select name="abWhen">${opt(WHEN, s.abWhen)}</select>`)
        + h.row('موعد النسخة اليومية', 'إن كان البرنامج مغلقاً وقتها تُنسخ عند أول فتح بعده في نفس اليوم', h.inp('abTime', s.abTime, 'time'))
        + h.row('الاحتفاظ بآخر', 'نسخة (الأقدم تُحذف من المجلد تلقائياً)', h.inp('abKeep', s.abKeep, 'number', 'min="1" max="365" style="max-width:100px"'))
        + h.row('المجلد', '<span id="ab-folder">…</span>', `<div class="flex gap-2 flex-wrap">${isDesk() || fsApi() ? '<button type="button" class="btn btn-outline" id="ab-choose"><i class="fas fa-folder-tree"></i> اختيار المجلد</button>' : ''}${isDesk() ? '<button type="button" class="btn btn-ghost" id="ab-open"><i class="fas fa-up-right-from-square"></i> فتح</button>' : ''}${!isDesk() && fsApi() ? '<button type="button" class="btn btn-soft-warning hidden" id="ab-perm"><i class="fas fa-unlock"></i> اضغط لتفعيل النسخ للمجلد</button>' : ''}<button type="button" class="btn btn-primary" id="ab-now"><i class="fas fa-floppy-disk"></i> نسخ الآن</button></div>`)
        + `<div class="text-sm mt-2">آخر نسخة للمجلد: <span id="ab-last">…</span></div>`
        + `<div class="divider"></div><h4 class="mb-2"><i class="fab fa-google-drive text-primary"></i> نسخ إلى Google Drive عبر رابط</h4>`
        + `<div class="alert alert-info mb-3"><i class="fas fa-circle-info"></i> لكل عميل/متجر رابط خاص من حسابه على Google (سكربت صغير أدناه يحفظ النسخ في مجلد Drive ويحذف القديم). الحد الأقصى لحجم النسخة حوالي <strong>50MB</strong> (حد Google Apps Script) — تُضغط تلقائياً (عادةً إلى 10–20٪ من حجمها).</div>`
        + h.row('تفعيل الرفع إلى Drive', '', h.sw('driveEnabled', s.driveEnabled))
        + h.row('رابط Drive (Web App URL)', 'يبدأ بـ https://script.google.com/macros/s/ وينتهي بـ ‎/exec', h.inp('driveUrl', s.driveUrl, 'url', 'dir="ltr" style="min-width:320px" placeholder="https://script.google.com/macros/s/…/exec"'))
        + h.row('الرمز السري', 'يجب أن يطابق TOKEN في السكربت — يمنع أي شخص آخر من الكتابة في المجلد', `<div class="flex gap-2">${h.inp('driveToken', s.driveToken, 'text', 'dir="ltr" id="drv-token" autocomplete="off" style="min-width:220px"')}<button type="button" class="btn btn-ghost" id="drv-gen" data-tip="توليد رمز عشوائي"><i class="fas fa-dice"></i></button></div>`)
        + h.row('توقيت الرفع', '', `<select name="driveWhen">${opt({ same: 'مع جدول النسخ للمجلد', ...WHEN }, s.driveWhen)}</select>`)
        + h.row('عدد النسخ على Drive', 'لكل متجر/فرع — الأقدم تُنقل لسلة Drive', h.inp('driveKeep', s.driveKeep, 'number', 'min="1" max="365" style="max-width:100px"'))
        + `<div class="flex gap-2 flex-wrap mt-2"><button type="button" class="btn btn-outline" id="drv-test"><i class="fas fa-plug-circle-check"></i> اختبار الاتصال</button><button type="button" class="btn btn-primary" id="drv-now"><i class="fas fa-cloud-arrow-up"></i> رفع نسخة الآن</button></div><div class="text-sm mt-2">آخر رفع: <span id="drv-last">…</span></div><div class="text-xs muted mt-1">احفظ الإعدادات قبل الاختبار. للاستعادة: نزّل الملف من Drive ثم «استبدال كامل» من صفحة النسخ الاحتياطي.</div>`
        + `<details class="mt-3"><summary class="cursor-pointer"><strong>طريقة إنشاء رابط Drive (مرة واحدة لكل عميل)</strong></summary><ol class="text-sm mt-2" style="line-height:2">
<li>افتح <a href="https://drive.google.com" target="_blank" rel="noopener">Google Drive</a> بحساب العميل ← جديد ← المزيد ← <strong>Google Apps Script</strong> (أو من أي Google Sheet: الإضافات Extensions ← Apps Script).</li>
<li>امسح الكود الموجود والصق الكود أدناه (زر «نسخ الكود» يضع الرمز السري الحالي تلقائياً). غيّر FOLDER_NAME أو ضع FOLDER_ID إن أردت.</li>
<li>احفظ ← <strong>Deploy / نشر</strong> ← New deployment ← النوع <strong>Web app</strong>.</li>
<li>Execute as: <strong>Me</strong> · Who has access: <strong>Anyone</strong> ← Deploy ← وافق على صلاحيات Drive (Advanced ← Go to… إن ظهر تحذير).</li>
<li>انسخ <strong>Web app URL</strong> (ينتهي بـ ‎/exec) والصقه في «رابط Drive» هنا، احفظ، ثم «اختبار الاتصال».</li>
<li>عند تعديل الكود لاحقاً: Deploy ← Manage deployments ← Edit ← Version: New (ليبقى نفس الرابط).</li></ol>
<div class="flex gap-2 mb-2"><button type="button" class="btn btn-sm btn-soft-primary" id="drv-copy"><i class="fas fa-copy"></i> نسخ الكود</button></div><textarea id="drv-code" readonly rows="14" dir="ltr" style="width:100%;font-family:monospace;font-size:12px">${e(ab.appsScript(s.driveToken || 'CHANGE_ME'))}</textarea></details>`;
    },
    bind(body) {
      const $b = sel => body.querySelector(sel);
      const showLast = () => ab.last().then(l => { const a = $b('#ab-last'), d = $b('#drv-last'); if (a) a.innerHTML = fmtRes(l.local); if (d) d.innerHTML = fmtRes(l.drive); });
      const showFolder = async () => { const f = $b('#ab-folder'); if (!f) return; const l = await ab.folderLabel(); f.textContent = l ? `الحالي: ${l}` : (isDesk() ? 'افتراضي: Documents\\Dream Market ERP Backups' : fsApi() ? 'لم يُختر مجلد — سيتم التنزيل' : 'تنزيل ملف'); const pb = $b('#ab-perm'); if (pb && l) { const p = await ab.permission(false).catch(() => 'none'); pb.classList.toggle('hidden', p === 'granted'); } };
      showLast(); showFolder();
      const off = ERP.bus.on('autobackup:done', () => { if (!body.isConnected) return off(); showLast(); });
      const ch = $b('#ab-choose'); if (ch) ch.onclick = async () => { try { const r = await ab.chooseFolder(); if (r) ERP.ui.success(`تم اختيار المجلد: ${r}`); showFolder(); } catch (err) { if (err && err.name !== 'AbortError') ERP.ui.error(err.message); } };
      const op = $b('#ab-open'); if (op) op.onclick = () => ab.openFolder();
      const pb = $b('#ab-perm'); if (pb) pb.onclick = async () => { await ab.grantAndRun(); showFolder(); };
      $b('#ab-now').onclick = async () => { const l = ERP.ui.loading('جاري إنشاء النسخة…'); try { const r = await ab.runLocal('manual', { gesture: true }); l.close(); r.ok ? ERP.ui.success(`تم حفظ ${r.name} (${r.where})`) : ERP.ui.error(r.err); } catch (err) { l.close(); ERP.ui.error(err.message); } showLast(); showFolder(); };
      const code = $b('#drv-code'), tok = $b('#drv-token');
      const refreshCode = () => { if (code) code.value = ab.appsScript(tok.value.trim() || 'CHANGE_ME'); };
      if (tok) tok.oninput = refreshCode;
      $b('#drv-gen').onclick = () => { const a = new Uint8Array(18); crypto.getRandomValues(a); tok.value = Array.from(a, x => x.toString(36).padStart(2, '0')).join('').slice(0, 28); refreshCode(); ERP.ui.info('تم توليد رمز — احفظ الإعدادات وانسخ الكود من جديد إلى السكربت'); };
      $b('#drv-copy').onclick = () => { refreshCode(); if (u.copy(code.value)) ERP.ui.success('تم نسخ كود السكربت'); else { code.select(); document.execCommand('copy'); ERP.ui.success('تم النسخ'); } };
      $b('#drv-test').onclick = async () => { const l = ERP.ui.loading('جاري الاتصال بـ Google…'); try { const r = await ab.testDrive(); l.close(); r.ok ? ERP.ui.success(`الاتصال سليم — المجلد: ${r.folder || ''}`) : ERP.ui.error(r.err); } catch (err) { l.close(); ERP.ui.error(err.message); } };
      $b('#drv-now').onclick = async () => { const l = ERP.ui.loading('جاري ضغط ورفع النسخة…'); try { const r = await ab.uploadDrive('manual'); l.close(); r.ok ? ERP.ui.success(`تم الرفع: ${r.name}`) : (r.unknown ? ERP.ui.warn(r.err) : ERP.ui.error(r.err)); } catch (err) { l.close(); ERP.ui.error(err.message); } showLast(); };
    },
    save(patch) {
      if ('abKeep' in patch) patch.abKeep = Math.min(365, Math.max(1, Math.round(u.num(patch.abKeep, 14))));
      if ('driveKeep' in patch) patch.driveKeep = Math.min(365, Math.max(1, Math.round(u.num(patch.driveKeep, 30))));
      if ('abTime' in patch && !/^\d{2}:\d{2}$/.test(patch.abTime || '')) patch.abTime = '23:30';
      if ('driveUrl' in patch) patch.driveUrl = String(patch.driveUrl || '').trim();
    },
  });
})();
