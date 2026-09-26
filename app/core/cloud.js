/* ==========================================================================
   ERP.cloud — Firebase sync layer v2 (local-first: IndexedDB is the truth,
   the cloud is incremental sync + backup + owner dashboard feed)
   - Firebase Authentication (email/password): one account per client company;
     companyId = auth uid → rules allow only that account on companies/{uid}/**
   - Layout: companies/{cid}/branches/{code}                 branch doc + KPI summary
             companies/{cid}/branches/{code}/cols/{col}      collection marker (name, count)
             companies/{cid}/branches/{code}/cols/{col}/docs/{id}  one record per doc
             companies/{cid}/branches/{code}/meta/seq        sequence counters (max-merged)
             companies/{cid}/transfers/{id}                  inter-branch transfer inbox
   - Each branch writes ONLY its own namespace → no cross-branch overwrites
   - Incremental: dirty ids come from db.js flushes (incl. silent/bulk writes) and
     db:change events; id-less events are diffed (updatedAt) against a persisted
     last-synced map. Batched writes (≤450 ops), backoff, a queued change is
     cleared only after its batch commits AND if it was not modified meanwhile
   - Deletes → tombstones (deleted:true). Replace/clear (reset data, file restore)
     never produce tombstones; nothing is pushed while ERP.testing
   - Secrets never leave the device (DENY_COLS / DENY_FIELDS / DENY_RE)
   - Status notified via the 'cloud:status' bus event (views listen)
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  const u = ERP.utils; const e = u.escapeHtml;

  const SDK_SRC = ['app', 'auth', 'firestore'].map(n => `https://www.gstatic.com/firebasejs/9.23.0/firebase-${n}-compat.js`);
  const MAX_OPS = 450;                      // Firestore batched write limit = 500
  const MAX_BATCH_BYTES = 8 * 1024 * 1024;  // request payload limit = 10 MiB
  const MAX_JSON = 900 * 1024;              // document limit = 1 MiB
  const SUMMARY_MS = 2 * 60000, HEARTBEAT_MS = 5 * 60000, OTHER_DEV_MS = 15 * 60000;
  const SRV = '__srv__';                    // placeholder → serverTimestamp() in the real adapter
  const DENY_COLS = ['users', 'heldCarts', 'notifications', 'sessions']; // PIN hashes / transient UI state stay local
  const DENY_FIELDS = ['driveToken', 'driveUrl', 'waCloudToken', 'waCallmebotKeys', 'waWebhookUrl', 'waWebhookBody', 'etaClientId', 'etaClientSecret', 'etaPresharedKey', 'firebaseConfig', 'pinHash', 'pin', 'password'];
  const DENY_RE = /token|secret|passw|apikey|api_key|presharedkey|privatekey|licen[cs]e|pinhash/i;
  const LOCAL_KEYS = ['cloudCfg', 'cloudOn', 'cloudEmail', 'cloudSync', 'lastCloudSync']; // device-level settings kept on restore
  const LEGACY_MSG = 'تم إيقاف صيغة المزامنة السحابية القديمة (كانت بدون تسجيل دخول وغير آمنة). بياناتك المحلية لم تتأثر — أعد إعداد السحابة بالنظام الجديد من الإعدادات ← السحابة.';
  ERP.settings.extend({ cloudCfg: null, cloudOn: false, cloudEmail: '' });

  /* ======================= pure helpers (unit-tested) ======================= */
  const syncable = n => !!n && typeof n === 'string' && !DENY_COLS.includes(n) && !n.startsWith('_');
  const sig = r => (r ? String(r.updatedAt || r.createdAt || '') : '');
  const safeId = id => { const s = String(id); return /^[\w-]{1,400}$/.test(s) && !/^__.*__$/.test(s) ? s : 'e_' + encodeURIComponent(s).replace(/\./g, '%2E').replace(/[!'()*~]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()).slice(0, 1400); };
  const isoDay = v => (v ? u.toISODate(v) || null : null);
  const denied = k => DENY_FIELDS.includes(k) || DENY_RE.test(k);
  /** drop secret top-level fields + anything not JSON-safe */
  function strip(rec) { const out = {}; Object.keys(rec || {}).forEach(k => { if (!denied(k) && rec[k] !== undefined && typeof rec[k] !== 'function') out[k] = rec[k]; }); return out; }
  const P = {
    company: cid => `companies/${cid}`,
    branch: (cid, code) => `companies/${cid}/branches/${safeId(code)}`,
    col: (base, c) => `${base}/cols/${safeId(c)}`,
    docs: (base, c) => `${base}/cols/${safeId(c)}/docs`,
    doc: (base, c, id) => `${base}/cols/${safeId(c)}/docs/${safeId(id)}`,
    meta: base => `${base}/meta/seq`,
    transfers: cid => `companies/${cid}/transfers`,
    transfer: (cid, id) => `companies/${cid}/transfers/${safeId(id)}`,
  };
  function toDoc(col, rec, ctx = {}) {
    const json = JSON.stringify(strip(rec));
    if (json.length > MAX_JSON) { const er = new Error(`السجل ${rec.id} في «${col}» أكبر من حد مستند السحابة (${Math.round(json.length / 1024)} KB) — لم يُرفع`); er.code = 'too-big'; throw er; }
    return { id: String(rec.id), json, deleted: false, rev: sig(rec), updatedAt: ctx.now || Date.now(), srv: SRV, dev: ctx.dev || '', dataDate: isoDay(rec.date || rec.at || rec.openedAt || rec.createdAt) };
  }
  function tombstone(id, ctx = {}) { return { id: String(id), json: null, deleted: true, rev: '', updatedAt: ctx.now || Date.now(), srv: SRV, dev: ctx.dev || '', dataDate: null }; }
  function fromDoc(d) { if (!d || d.deleted || typeof d.json !== 'string') return null; try { return JSON.parse(d.json); } catch { return null; } }
  /** split write ops into batches: ≤ max ops and ≤ maxBytes each */
  function splitBatches(ops, max = MAX_OPS, maxBytes = MAX_BATCH_BYTES) {
    const out = []; let cur = [], bytes = 0;
    ops.forEach(o => { const b = o.bytes || 300; if (cur.length && (cur.length >= max || bytes + b > maxBytes)) { out.push(cur); cur = []; bytes = 0; } cur.push(o); bytes += b; });
    if (cur.length) out.push(cur);
    return out;
  }
  const mergeSeq = (a, b) => { const o = { ...(a || {}) }; Object.entries(b || {}).forEach(([k, v]) => { if (+v > (+o[k] || 0)) o[k] = +v; }); return o; };
  const seqRaised = (pushed, cur) => Object.entries(cur || {}).some(([k, v]) => +v > (+(pushed || {})[k] || 0));
  /** accepts pasted JSON or the JS snippet from Firebase console (const firebaseConfig = {...}) */
  function parseConfig(text) {
    if (text && typeof text === 'object') text = JSON.stringify(text);
    let s = String(text || '').trim(); const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a < 0 || b < a) throw new Error('الصق إعدادات الويب من Firebase (كائن يبدأ بـ { )');
    s = s.slice(a, b + 1);
    let o; try { o = JSON.parse(s); } catch { try { o = JSON.parse(s.replace(/(^|[^:])\/\/[^\n]*/g, '$1').replace(/'/g, '"').replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":').replace(/,\s*}/g, '}')); } catch { throw new Error('تعذر قراءة الإعدادات — الصقها كما هي من Firebase Console'); } }
    const out = {}; ['apiKey', 'authDomain', 'projectId', 'storageBucket', 'messagingSenderId', 'appId'].forEach(k => { if (o[k]) out[k] = String(o[k]).trim(); });
    if (!out.apiKey || !out.projectId) throw new Error('الإعدادات ناقصة: apiKey و projectId مطلوبان');
    if (!out.authDomain) out.authDomain = out.projectId + '.firebaseapp.com';
    return out;
  }
  const legacyOf = s => !!(s && !(s.cloudCfg && s.cloudCfg.projectId) && s.firebaseConfig && s.firebaseConfig.projectId);

  /** dirty-record queue: col → Map(id → tick). A tick changes on every mark, so an in-flight push can tell "modified meanwhile" */
  class Tracker {
    constructor() { this.q = new Map(); this.diff = new Set(); this.tick = 0; }
    mark(col, id) { if (!syncable(col) || id == null) return; let m = this.q.get(col); if (!m) this.q.set(col, m = new Map()); m.set(id, ++this.tick); }
    /** db:change payload: {collection, op, doc?, docs?} — id-less ops (bulk w/o docs, removeMany, replace) → diff by updatedAt */
    fromEvent(ev) { if (!ev || !syncable(ev.collection)) return; const c = ev.collection; if (ev.op === 'replace') return this.replaced(c); if (ev.doc && ev.doc.id != null) this.mark(c, ev.doc.id); else if (Array.isArray(ev.docs) && ev.docs.length) ev.docs.forEach(d => d && this.mark(c, d.id)); else this.diff.add(c); }
    /** db.js flush hook: {dirty:[ids], removed:[ids], replaced:bool} (covers silent writes too) */
    fromFlush(col, info) { if (!syncable(col)) return; info = info || { replaced: true }; if (info.replaced) return this.replaced(col); (info.dirty || []).forEach(id => this.mark(col, id)); (info.removed || []).forEach(id => this.mark(col, id)); }
    /** whole collection replaced (clear / reset data / file restore): drop its queued ids so records that vanished are NOT tombstoned; diff → upserts only */
    replaced(col) { this.q.delete(col); this.diff.add(col); }
    size() { let n = this.diff.size; this.q.forEach(m => { n += m.size; }); return n; }
    snapshot() { const out = []; this.q.forEach((m, col) => m.forEach((t, id) => out.push({ col, id, t }))); return out; }
    ack(list) { list.forEach(x => { const m = this.q.get(x.col); if (m && m.get(x.id) === x.t) { m.delete(x.id); if (!m.size) this.q.delete(x.col); } }); }
    clear() { this.q.clear(); this.diff.clear(); }
    toJSON() { const q = {}; this.q.forEach((m, c) => { q[c] = [...m.keys()]; }); return { q, diff: [...this.diff] }; }
    load(j) { if (!j) return; Object.entries(j.q || {}).forEach(([c, ids]) => (ids || []).forEach(id => this.mark(c, id))); (j.diff || []).forEach(c => syncable(c) && this.diff.add(c)); }
  }

  /** per-collection "last synced" map {id: updatedAt} persisted in kv (one key per collection → only touched ones are rewritten) */
  function makeSynced(kv, keyFn) {
    const maps = {}, touched = new Set();
    return {
      async load(col) { if (maps[col]) return maps[col]; let v = null; try { v = await kv.get('cloud.synced.' + col); } catch { v = null; } if (!maps[col]) maps[col] = v && v.key === keyFn() && v.map ? v.map : {}; return maps[col]; },
      peek(col) { return maps[col]; },
      set(col, id, s) { const m = maps[col] || (maps[col] = {}); if (s == null) delete m[id]; else m[id] = s; touched.add(col); },
      replace(col, map) { maps[col] = map || {}; touched.add(col); },
      async save() { const list = [...touched]; touched.clear(); for (const c of list) { try { await kv.set('cloud.synced.' + c, { key: keyFn(), map: maps[c] }); } catch { touched.add(c); } } },
      reset() { Object.keys(maps).forEach(k => delete maps[k]); touched.clear(); },
    };
  }
  const tick0 = () => new Promise(r => setTimeout(r, 0));

  /** one push cycle. x = { adapter, base, dev, tracker, synced, get(col,id), list(col), count(col) } → { pushed, batches, skipped } */
  async function pushOnce(x) {
    const { adapter, base, tracker, synced } = x; const now = Date.now(); const ctx = { dev: x.dev, now };
    const diffCols = [...tracker.diff]; tracker.diff.clear();
    for (const c of diffCols) { const m = await synced.load(c); for (const r of x.list(c) || []) if (r && r.id != null && m[r.id] !== sig(r)) tracker.mark(c, r.id); } // upserts only
    const entries = tracker.snapshot(); if (!entries.length) return { pushed: 0, batches: 0, skipped: [] };
    const ops = [], skipped = [], cols = new Set(); let i = 0;
    for (const en of entries) {
      if (++i % 250 === 0) await tick0(); // big queues: keep the UI responsive
      const m = await synced.load(en.col); const rec = x.get(en.col, en.id);
      if (rec) {
        let data; try { data = toDoc(en.col, rec, ctx); } catch (er) { if (er.code !== 'too-big') throw er; skipped.push({ col: en.col, id: en.id, error: er.message }); tracker.ack([en]); continue; }
        ops.push({ type: 'set', path: P.doc(base, en.col, en.id), data, bytes: data.json.length + 400, en, sig: data.rev }); cols.add(en.col);
      } else if (m[en.id] !== undefined) { ops.push({ type: 'set', path: P.doc(base, en.col, en.id), data: tombstone(en.id, ctx), bytes: 300, en, sig: null }); cols.add(en.col); }
      else tracker.ack([en]); // created and removed before it ever reached the cloud
    }
    cols.forEach(c => ops.push({ type: 'set', merge: true, path: P.col(base, c), data: { name: c, count: x.count(c), updatedAt: now, srv: SRV, dev: x.dev || '' }, bytes: 200 }));
    const batches = splitBatches(ops); let pushed = 0;
    try {
      for (const b of batches) {
        await adapter.commit(b.map(o => ({ type: o.type, path: o.path, data: o.data, merge: !!o.merge })));
        b.forEach(o => { if (!o.en) return; synced.set(o.en.col, o.en.id, o.sig); tracker.ack([o.en]); pushed++; }); // cleared only after COMMIT, and only if unchanged meanwhile
      }
    } finally { await synced.save(); }
    return { pushed, batches: batches.length, skipped };
  }

  /** owner-dashboard summary for the branch doc (built on ERP.branches.kpis so numbers match the branches page) */
  function buildSummary(cols, { code = '', name = '', today = u.todayISO(), lowN = 20 } = {}) {
    const k = ERP.branches.kpis(cols, { branchCode: code, branchName: name });
    const day = (cols.sales || []).filter(s => s.status !== 'void' && u.inRange(s.date, today, today));
    const top = {}; day.filter(s => s.type === 'sale').forEach(s => (s.items || []).forEach(it => { const t = top[it.name] || (top[it.name] = { name: it.name, qty: 0, total: 0 }); t.qty += u.num(it.qty); t.total += u.num(it.total); }));
    const sh = (cols.shifts || []).find(s => s.status === 'open');
    const low = (cols.products || []).filter(p => p.active !== false && u.num(p.stock) <= u.num(p.minStock, 5)).sort((a, b) => u.num(a.stock) - u.num(b.stock)).slice(0, lowN).map(p => ({ name: p.name || '', code: p.code || '', stock: u.round(u.num(p.stock), 3), min: u.num(p.minStock, 5) }));
    return JSON.parse(JSON.stringify({ ...k, day: today, todaySales: u.round(k.today.total), todayCount: k.today.count, returnsToday: u.round(u.sum(day.filter(s => s.type === 'return'), 'total')), cash: k.cashGL, openShift: sh ? { no: sh.no || '', user: sh.userName || '', openedAt: sh.openedAt || null, expected: ERP.shifts && ERP.shifts.expected ? ERP.shifts.expected(sh) : null } : null, topToday: u.sortBy(Object.values(top), 'total', 'desc').slice(0, 10).map(t => ({ name: t.name, qty: u.round(t.qty, 3), total: u.round(t.total) })), lowList: low }));
  }

  /** cloud docs → local snapshot: live records per collection, synced maps, counters; settings.main keeps this device's secrets + cloud keys */
  function buildRestore(docsByCol, { seq = {}, localMain = null } = {}) {
    const collections = {}, synced = {}; let count = 0;
    Object.entries(docsByCol || {}).forEach(([col, docs]) => {
      if (!syncable(col)) return;
      const list = [], map = {};
      (docs || []).forEach(d => { const r = fromDoc(d); if (!r || r.id == null) return; list.push(r); map[r.id] = sig(r); });
      if (col === 'settings' && localMain) { const keep = {}; Object.keys(localMain).forEach(k => { if (denied(k) || LOCAL_KEYS.includes(k)) keep[k] = localMain[k]; }); const i = list.findIndex(r => r.id === 'main'); if (i >= 0) list[i] = { ...list[i], ...keep }; }
      collections[col] = list; synced[col] = map; count += list.length;
    });
    return { collections, synced, seq: mergeSeq({}, seq), count };
  }

  /* ======================= Firestore adapter (compat SDK) ======================= */
  function fsAdapter(fs, firebase) {
    const FV = firebase.firestore.FieldValue;
    const fix = d => { const o = {}; Object.keys(d || {}).forEach(k => { o[k] = d[k] === SRV ? FV.serverTimestamp() : d[k]; }); return o; };
    const query = (path, where) => { let q = fs.collection(path); (where || []).forEach(w => { q = q.where(w[0], w[1], w[2]); }); return q; };
    return {
      async commit(ops) { const b = fs.batch(); ops.forEach(o => { if (o.type === 'delete') b.delete(fs.doc(o.path)); else b.set(fs.doc(o.path), fix(o.data), o.merge ? { merge: true } : {}); }); await b.commit(); },
      async get(path) { const d = await fs.doc(path).get(); return d.exists ? d.data() : null; },
      async list(path, where) { const s = await query(path, where).get(); return s.docs.map(d => ({ id: d.id, data: d.data() })); },
      async listAll(path, size = 1000) { const out = []; const FP = firebase.firestore.FieldPath.documentId(); let last = null; for (;;) { let q = fs.collection(path).orderBy(FP).limit(size); if (last) q = q.startAfter(last); const s = await q.get(); s.docs.forEach(d => out.push({ id: d.id, data: d.data() })); if (s.size < size) break; last = s.docs[s.docs.length - 1]; } return out; },
      async count(path, where) { const q = query(path, where); try { if (typeof q.count === 'function') { const s = await q.count().get(); return s.data().count; } } catch { /* older SDK → fall back */ } return (await q.get()).size; },
    };
  }

  /* ======================= controller ======================= */
  const S = { status: 'off', error: null, errors: [], warning: null, user: null, rawUser: null, uid: null, lastSyncAt: null, needsChoice: null, busy: false, retry: 0, timer: null, hb: null, fb: null, app: null, auth: null, adapter: null, unsub: null, cfgKey: '', on: false, started: false, restoring: false, state: null, lastSummaryAt: 0, inbox: [], lastPush: null, dev: null };
  const tracker = new Tracker();
  const kv = { get: k => ERP.db.kvGet(k), set: (k, v) => ERP.db.kvSet(k, v) };
  const cfg = () => { const c = ERP.settings.get('cloudCfg'); return c && c.projectId && c.apiKey ? c : null; };
  const enabled = () => !!cfg() && !!ERP.settings.get('cloudOn');
  const br = () => (ERP.branches ? ERP.branches.current() : { code: ERP.settings.get('branchCode') || 'MAIN', name: ERP.settings.get('storeName') || '' });
  const key = () => (S.uid ? `${S.uid}|${br().code}` : '');
  const base = () => P.branch(S.uid, br().code);
  const synced = makeSynced(kv, key);
  const online = () => typeof navigator === 'undefined' || navigator.onLine !== false;
  const tracking = () => !ERP.testing && !S.restoring && enabled() && !!(S.state && S.state.baseline && S.state.key === key());
  const allCols = () => Object.keys(ERP.db.export().collections).filter(syncable);
  const localGet = (c, id) => { const col = ERP.db.collection(c); return col.get(id) || (typeof id === 'string' && /^\d+$/.test(id) ? col.get(+id) : null); };
  const appVersion = () => { const x = ERP.version || ERP.APP_VERSION || (ERP.updater && (ERP.updater.version || ERP.updater.current)); return typeof x === 'string' ? x : ''; };
  function devId() { if (S.dev) return S.dev; try { S.dev = localStorage.getItem('dm_erp:__cloudDev'); if (!S.dev) { S.dev = 'dev_' + u.uid(); localStorage.setItem('dm_erp:__cloudDev', S.dev); } } catch { S.dev = S.dev || 'dev_' + u.uid(); } return S.dev; }
  function notify() { if (ERP.bus) ERP.bus.emit('cloud:status'); }
  function setStatus(st, err) { S.status = st; if (err !== undefined) S.error = err; notify(); }
  function logErr(msg) { S.errors.unshift({ at: Date.now(), msg: String(msg) }); if (S.errors.length > 10) S.errors.length = 10; }
  function errText(er) {
    const c = (er && er.code) || ''; const M = { 'permission-denied': 'رفض الصلاحية — تأكد من لصق قواعد الأمان (firestore.rules) ومن تسجيل الدخول بحساب المتجر', unavailable: 'السحابة غير متاحة حالياً (إنترنت ضعيف) — ستُعاد المحاولة', 'resource-exhausted': 'تم تجاوز حصة Firebase اليومية', unauthenticated: 'انتهت جلسة الدخول — سجّل الدخول مرة أخرى', 'auth/invalid-email': 'البريد الإلكتروني غير صحيح', 'auth/user-not-found': 'الحساب غير موجود', 'auth/wrong-password': 'كلمة المرور غير صحيحة', 'auth/invalid-credential': 'البريد أو كلمة المرور غير صحيحة', 'auth/invalid-login-credentials': 'البريد أو كلمة المرور غير صحيحة', 'auth/email-already-in-use': 'هذا البريد مسجّل بالفعل — استخدم «تسجيل الدخول»', 'auth/weak-password': 'كلمة المرور ضعيفة (6 أحرف على الأقل)', 'auth/network-request-failed': 'لا يوجد اتصال بالإنترنت', 'auth/too-many-requests': 'محاولات كثيرة — انتظر قليلاً ثم أعد المحاولة', 'auth/operation-not-allowed': 'تسجيل الدخول بالبريد وكلمة المرور غير مفعّل في مشروع Firebase', 'auth/admin-restricted-operation': 'إنشاء الحسابات من التطبيق معطّل في Firebase — أنشئ الحساب من Firebase Console', 'auth/api-key-not-valid.-please-pass-a-valid-api-key.': 'apiKey غير صحيح' };
    return M[c] || (er && er.message) || String(er);
  }

  async function loadState() {
    let st = null; try { st = await kv.get('cloud.state'); } catch { st = null; }
    const k = key();
    if (st && st.key === k) { S.state = { ...st, queue: null }; tracker.clear(); tracker.load(st.queue); }
    else { S.state = { key: k, baseline: null, lastSync: null, metaPushed: {} }; tracker.clear(); synced.reset(); }
    S.lastSyncAt = S.state.lastSync || null;
  }
  let saveT = null;
  function saveState(now) { clearTimeout(saveT); const go = () => { if (!S.state || !S.state.key || ERP.testing) return; kv.set('cloud.state', { ...S.state, queue: tracker.toJSON() }).catch(() => { }); }; if (now) go(); else saveT = setTimeout(go, 1500); }
  function markAllDiff() { allCols().forEach(c => tracker.diff.add(c)); } // catches writes made while the app was closed / offline before sign-in (upserts)
  function touch() { S.lastSyncAt = Date.now(); if (S.state) S.state.lastSync = S.lastSyncAt; }

  const SDK = { p: null };
  function loadSDK() {
    if (window.firebase && window.firebase.auth && window.firebase.firestore) return Promise.resolve(window.firebase);
    if (SDK.p) return SDK.p;
    if (typeof document === 'undefined' || !document.head) return Promise.reject(new Error('Firebase غير متاح في هذه البيئة'));
    const load = src => new Promise((res, rej) => { const old = document.querySelector(`script[src="${src}"]`); if (old && old.dataset.ok) return res(); const s = document.createElement('script'); s.src = src; s.onload = () => { s.dataset.ok = '1'; res(); }; s.onerror = () => { s.remove(); rej(new Error('تعذر تحميل مكتبة Firebase (تحقق من الإنترنت)')); }; document.head.appendChild(s); });
    SDK.p = SDK_SRC.reduce((p, src) => p.then(() => load(src)), Promise.resolve()).then(() => window.firebase).catch(er => { SDK.p = null; throw er; }); // app first, then auth + firestore
    return SDK.p;
  }
  async function teardown() {
    clearTimeout(S.timer); if (S.unsub) { try { S.unsub(); } catch { /* */ } S.unsub = null; }
    if (S.app) { try { await S.app.delete(); } catch { /* */ } }
    S.app = S.auth = S.adapter = null; S.user = S.rawUser = null; S.cfgKey = '';
  }
  async function initFirebase() {
    const c = cfg(); if (!c || ERP.testing) return;
    const k = c.projectId + '|' + c.apiKey; if (S.adapter && S.cfgKey === k) return;
    await teardown(); setStatus('connecting');
    const firebase = await loadSDK(); S.fb = firebase;
    const ex = (firebase.apps || []).find(x => x.name === 'dmerp'); if (ex) { try { await ex.delete(); } catch { /* */ } }
    const app = firebase.initializeApp(c, 'dmerp'); // stable app name → Firebase Auth restores the persisted session after a reload
    S.app = app; S.auth = app.auth(); S.adapter = fsAdapter(app.firestore(), firebase); S.cfgKey = k; // auth session persists (LOCAL) → no password is ever stored by the app
    S.unsub = S.auth.onAuthStateChanged(user => onUser(user).catch(fail));
  }
  async function onUser(user) {
    S.rawUser = user; S.user = user ? { uid: user.uid, email: user.email || '' } : null;
    if (!user) { S.needsChoice = null; return setStatus(enabled() ? 'signed-out' : 'disabled', null); }
    if (S.uid !== user.uid) { S.uid = user.uid; kv.set('cloud.uid', user.uid).catch(() => { }); synced.reset(); await loadState(); }
    else if (!S.state || S.state.key !== key()) await loadState();
    if (!enabled()) return setStatus('disabled', null);
    if (ERP.settings.get('cloudEmail') !== S.user.email) ERP.settings.set({ cloudEmail: S.user.email });
    setStatus('connecting');
    const bd = await S.adapter.get(base());
    if (!S.state.baseline) {
      if (!bd) { // brand-new branch namespace → first full upload — only while the company stays within the licensed branch count
        if (ERP.license && ERP.license.branchLimit && ERP.license.branchLimit() !== Infinity) {
          const codes = new Set((await S.adapter.list(`companies/${S.uid}/branches`)).map(d => (d.data && d.data.code) || d.id)); codes.add(br().code);
          try { ERP.license.requireBranchSlot(codes.size); } catch (er) { logErr(er.message); return setStatus('error', er.message); }
        }
        await pushAll().catch(() => { }); return;
      }
      S.needsChoice = { lastSync: bd.lastSync || bd.beat || null, name: bd.name || '', code: bd.code || br().code, sameDev: bd.dev === devId() };
      return setStatus('choice', null);
    }
    checkOther(bd); S.needsChoice = null; markAllDiff(); setStatus('online', null); schedule(800); setTimeout(() => heartbeat(true), 3000);
  }
  function checkOther(bd) { S.warning = bd && bd.dev && bd.dev !== devId() && Date.now() - (+bd.beat || 0) < OTHER_DEV_MS ? `جهاز آخر يزامن نفس كود الفرع «${bd.code || br().code}» (آخر نشاط ${u.relTime(new Date(+bd.beat))}). تشغيل أكثر من جهاز على نفس الفرع غير مدعوم حالياً — أعطِ كل جهاز كود فرع مختلفاً.` : null; }

  function schedule(ms = 2500) { clearTimeout(S.timer); S.timer = setTimeout(() => run().catch(() => { }), ms); }
  function fail(er) { const m = errText(er); console.warn('[cloud]', m, er); logErr(m); S.retry++; setStatus(online() ? 'error' : 'offline', m); schedule(Math.min(300000, 5000 * 2 ** Math.min(S.retry, 6))); }
  const ctx = () => ({ adapter: S.adapter, base: base(), dev: devId(), tracker, synced, get: localGet, list: c => ERP.db.collection(c).all(), count: c => ERP.db.collection(c).count() });
  async function run() {
    if (!S.started || !enabled()) return;
    if (ERP.testing || S.restoring) return schedule(10000);
    if (S.busy) return schedule(3000);
    if (!S.adapter) { if (!online()) { setStatus('offline'); return schedule(15000); } return initFirebase().catch(fail); }
    if (S.user && !S.needsChoice && !(S.state && S.state.baseline) && S.rawUser) return onUser(S.rawUser).catch(fail); // first upload / branch check failed earlier → retry (with backoff via fail)
    if (!S.user || !tracking()) return;
    if (!tracker.size() && !seqRaised(S.state.metaPushed, ERP.db.getMeta('seq'))) return;
    if (!online()) { setStatus('offline'); return schedule(15000); }
    S.busy = true; setStatus('syncing');
    try {
      const r = await pushOnce(ctx()); await pushMeta();
      r.skipped.forEach(x => logErr(x.error));
      S.retry = 0; S.lastPush = { at: Date.now(), pushed: r.pushed, batches: r.batches }; touch(); S.busy = false; setStatus('online', null);
      if (Date.now() - S.lastSummaryAt > SUMMARY_MS) heartbeat(true);
    } catch (er) { S.busy = false; fail(er); } finally { S.busy = false; saveState(); }
    if (tracker.size() && S.status === 'online') schedule(1500);
  }
  async function pushMeta() {
    const cur = ERP.db.getMeta('seq') || {}; if (!seqRaised(S.state.metaPushed, cur)) return;
    const m = mergeSeq(S.state.metaPushed, cur); // counters only go up (a "reset data" that zeroes them never lowers the cloud copy)
    await S.adapter.commit([{ type: 'set', path: P.meta(base()), data: { seq: m, updatedAt: Date.now(), srv: SRV, dev: devId() } }]);
    S.state.metaPushed = m;
  }
  const kpiCols = () => { const o = {}; ['sales', 'customers', 'suppliers', 'products', 'expenses', 'shifts', 'accounts', 'journal'].forEach(n => { o[n] = ERP.db.collection(n).all(); }); return o; };
  function branchDoc() {
    const me = br(); let summary = null; try { summary = buildSummary(kpiCols(), { code: me.code, name: me.name }); } catch (er) { console.warn('[cloud] summary', er); }
    return { code: me.code, name: me.name, store: ERP.settings.get('storeName') || '', currency: ERP.settings.get('currency') || '', lastSync: S.lastSyncAt || null, beat: Date.now(), appVersion: appVersion(), dev: devId(), pending: tracker.size(), summary, srv: SRV };
  }
  async function heartbeat(force) {
    if (!S.user || !S.adapter || !tracking() || !online()) return;
    if (!force && Date.now() - S.lastSummaryAt < HEARTBEAT_MS) return;
    S.lastSummaryAt = Date.now();
    try {
      checkOther(await S.adapter.get(base()));
      await S.adapter.commit([{ type: 'set', path: base(), data: branchDoc() }]);
      await postTransfers(); await refreshInbox(); notify();
    } catch (er) { logErr(errText(er)); notify(); }
  }

  /* ---------- inter-branch transfers: companies/{cid}/transfers/{id} ---------- */
  async function postTransfers() {
    const me = br().code; const T = ERP.db.collection('transfers');
    const out = T.all().filter(t => t.kind === 'branch' && t.direction === 'out' && t.fromBranch === me && !t.cloudPostedAt);
    if (!out.length) return 0;
    const ops = out.map(t => { const json = JSON.stringify(ERP.branches.payload(t.id)); return { type: 'set', path: P.transfer(S.uid, t.id), data: { id: String(t.id), no: t.no || '', from: t.fromBranch, fromName: t.fromBranchName || '', to: t.toBranch, status: 'sent', value: u.num(t.value), json, createdAt: Date.now(), srv: SRV }, bytes: json.length + 400 }; });
    for (const b of splitBatches(ops)) { await S.adapter.commit(b.map(o => ({ type: o.type, path: o.path, data: o.data }))); b.forEach(o => T.update(o.data.id, { cloudPostedAt: u.now() }, { silent: true })); }
    return out.length;
  }
  async function refreshInbox() {
    if (!S.user || !S.adapter || ERP.testing) return S.inbox;
    const list = await S.adapter.list(P.transfers(S.uid), [['to', '==', br().code], ['status', '==', 'sent']]);
    S.inbox = list.map(d => { try { return JSON.parse(d.data.json); } catch { return null; } }).filter(p => p && p.__type === 'DreamMarketBranchTransfer');
    if (ERP.router && ERP.router.refreshBadges) try { ERP.router.refreshBadges(); } catch { /* */ }
    return S.inbox;
  }
  async function ackTransfer(id) {
    S.inbox = S.inbox.filter(p => p.id !== id);
    if (!S.user || !S.adapter || ERP.testing) return false;
    await S.adapter.commit([{ type: 'set', merge: true, path: P.transfer(S.uid, id), data: { status: 'received', receivedAt: Date.now(), receivedBy: br().code, srv: SRV } }]);
    return true;
  }

  /* ---------- explicit actions ---------- */
  function ready() { if (ERP.testing) throw new Error('السحابة متوقفة أثناء الاختبارات'); if (!cfg()) throw new Error('أدخل إعدادات Firebase أولاً (الإعدادات ← السحابة)'); if (!S.user || !S.adapter) throw new Error('سجّل الدخول بحساب المتجر السحابي أولاً'); }
  async function waitIdle() { for (let i = 0; S.busy && i < 600; i++) await new Promise(r => setTimeout(r, 100)); }
  /** upload every local record of this branch (upsert). mirror=true also tombstones cloud records this device synced before but no longer has */
  async function pushAll({ mirror = false } = {}) {
    ready(); await waitIdle(); S.busy = true; setStatus('syncing');
    try {
      for (const c of allCols()) { const m = await synced.load(c); const ids = new Set(); ERP.db.collection(c).all().forEach(r => { if (r && r.id != null) { tracker.mark(c, r.id); ids.add(String(r.id)); } }); if (mirror) Object.keys(m).forEach(id => { if (!ids.has(id)) tracker.mark(c, id); }); }
      await S.adapter.commit([{ type: 'set', merge: true, path: P.company(S.uid), data: { email: S.user.email, store: ERP.settings.get('storeName') || '', updatedAt: Date.now(), srv: SRV } }]);
      let total = 0; for (let g = 0; tracker.snapshot().length && g < 50; g++) { const r = await pushOnce(ctx()); total += r.pushed; r.skipped.forEach(x => logErr(x.error)); if (!r.batches) break; }
      await pushMeta();
      S.state.baseline = S.state.baseline || Date.now(); S.needsChoice = null; S.retry = 0; touch(); saveState(true);
      S.busy = false; setStatus('online', null); heartbeat(true);
      if (ERP.audit && !ERP.testing) ERP.audit.log('backup.export', `رفع كامل للسحابة: ${total} سجل${mirror ? ' (مطابقة)' : ''}`);
      return { pushed: total };
    } catch (er) { S.busy = false; fail(er); throw new Error(errText(er)); } finally { S.busy = false; saveState(); }
  }
  async function restorePreview() {
    ready(); const b = base();
    const [bd, list, meta] = await Promise.all([S.adapter.get(b), S.adapter.list(`${b}/cols`), S.adapter.get(P.meta(b))]);
    const cols = list.map(d => ({ name: (d.data && d.data.name) || d.id, count: +(d.data && d.data.count) || 0, updatedAt: d.data && d.data.updatedAt })).filter(c => syncable(c.name));
    return { branch: bd, cols, seq: (meta && meta.seq) || {}, total: u.sum(cols, 'count') };
  }
  async function restore(preview) {
    ready(); await waitIdle(); preview = preview || await restorePreview();
    if (!preview.cols.length) throw new Error('لا توجد بيانات لهذا الفرع في السحابة');
    S.restoring = true; setStatus('syncing');
    try {
      const docsByCol = {}; for (const c of preview.cols) docsByCol[c.name] = (await S.adapter.listAll(P.docs(base(), c.name))).map(d => d.data);
      const r = buildRestore(docsByCol, { seq: preview.seq, localMain: ERP.db.collection('settings').get('main') });
      if (ERP.backup && ERP.backup.snapshotLocal) await ERP.backup.snapshotLocal('pre-cloud-restore');
      Object.entries(r.synced).forEach(([c, m]) => synced.replace(c, m)); await synced.save(); tracker.clear();
      await ERP.db.import({ collections: r.collections }, { mode: 'replace' }); // keeps users / held carts (not in the cloud)
      const cur = ERP.db.getMeta('seq') || {}; Object.entries(r.seq).forEach(([k, v]) => { if (+v > (+cur[k] || 0)) ERP.db.setSeq(k, +v); }); ERP.db.raiseSeqs();
      if (ERP.settings.load) ERP.settings.load();
      S.state.metaPushed = mergeSeq(S.state.metaPushed, r.seq); S.state.baseline = Date.now(); S.needsChoice = null; touch(); saveState(true);
      await ERP.db.flush();
      if (ERP.audit) ERP.audit.log('backup.restore', `استعادة من السحابة: ${r.count} سجل`);
      return { cols: Object.keys(r.collections).length, docs: r.count };
    } finally { S.restoring = false; setStatus(S.user ? 'online' : 'signed-out'); }
  }
  async function compare() {
    ready(); const b = base(); const remote = (await S.adapter.list(`${b}/cols`)).map(d => (d.data && d.data.name) || d.id);
    const names = u.uniq(allCols().filter(c => ERP.db.collection(c).count()).concat(remote)).filter(syncable).sort();
    const rows = []; for (const c of names) { const cloudN = await S.adapter.count(P.docs(b, c), [['deleted', '==', false]]); const local = ERP.db.collection(c).count(); rows.push({ col: c, local, cloud: cloudN, diff: local - cloudN }); }
    return rows;
  }

  async function start() {
    if (ERP.testing) return;
    S.on = !!ERP.settings.get('cloudOn');
    if (!cfg()) { await teardown(); return setStatus(legacyOf(ERP.settings.all()) ? 'legacy' : 'off', null); }
    if (!S.on) { await teardown(); return setStatus('disabled', null); }
    if (!S.uid) S.uid = (await kv.get('cloud.uid').catch(() => null)) || null;
    if (S.uid && (!S.state || S.state.key !== key())) await loadState();
    if (!online()) { setStatus('offline'); schedule(15000); return; }
    await initFirebase();
  }
  function boot() {
    if (S.started || !ERP.db.isReady() || (ERP.db.isReadOnly && ERP.db.isReadOnly())) return;
    S.started = true; devId();
    ERP.db.setRemote({ onChange(n, docs, info) { if (!tracking() || !syncable(n)) return; tracker.fromFlush(n, info); saveState(); schedule(); } });
    ERP.bus.on('db:change', ev => { if (tracking() && ev && syncable(ev.collection)) tracker.fromEvent(ev); });
    ERP.bus.on('settings:change', () => {
      const c = cfg(); const k = c ? c.projectId + '|' + c.apiKey : '';
      if (k !== S.cfgKey || !!ERP.settings.get('cloudOn') !== S.on) start().catch(fail);
      else if (S.rawUser && S.state && S.state.key !== key()) onUser(S.rawUser).catch(fail); // branch code changed → its own namespace
    });
    if (typeof window !== 'undefined') { window.addEventListener('online', () => { S.retry = 0; schedule(500); }); window.addEventListener('offline', () => { if (enabled()) setStatus('offline'); }); }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(1000); });
    S.hb = setInterval(() => heartbeat(false), 60000);
    start().catch(fail);
  }
  if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => { let n = 0; const t = () => { if (ERP.db && ERP.db.isReady && ERP.db.isReady() && !ERP.testing) return boot(); if (++n < 240) setTimeout(t, 500); }; setTimeout(t, 1500); });

  /* ---------- labels ---------- */
  const LABELS = { off: ['غير مُعدّة', 'warning'], disabled: ['متوقفة', 'warning'], legacy: ['صيغة قديمة — تحتاج إعداداً جديداً', 'danger'], 'signed-out': ['بانتظار تسجيل الدخول', 'warning'], connecting: ['جارٍ الاتصال…', 'info'], online: ['متصل ومتزامن', 'success'], syncing: ['جارٍ الرفع…', 'info'], offline: ['غير متصل — سيُستأنف تلقائياً', 'danger'], error: ['خطأ', 'danger'], choice: ['بانتظار قرارك: استعادة أم رفع', 'warning'] };

  /* ---------- public API ---------- */
  const cloud = {
    get status() { return S.status; }, get error() { return S.error; }, get errors() { return S.errors.slice(); }, get warning() { return S.warning; },
    get lastSyncAt() { return S.lastSyncAt; }, get user() { return S.user; }, get needsChoice() { return S.needsChoice; }, get lastPush() { return S.lastPush; },
    LEGACY_MSG, label: st => (LABELS[st || S.status] || LABELS.off)[0], kind: st => (LABELS[st || S.status] || LABELS.off)[1],
    pending() { return tracker.size(); },
    /** legacy helper (old chunked format) kept for the e2e suite */
    chunks(text, size) { const s = size || 320 * 1024; const out = []; for (let i = 0; i < text.length; i += s) out.push(text.slice(i, i + s)); return out; },
    isConfigured() { return !!cfg(); }, isEnabled: enabled, isSignedIn() { return !!S.user; }, isLegacy() { return legacyOf(ERP.settings.all()); },
    parseConfig,
    /** save the Firebase web config (public identifiers; security = Auth + rules) and turn sync on */
    configure(text) { const c = parseConfig(text); ERP.settings.set({ cloudCfg: c, cloudOn: true, cloudSync: false }); return c; },
    /** main.js calls connect() for the retired format → rejects without touching the network */
    async connect() { if (!cfg()) { if (legacyOf(ERP.settings.all())) { setStatus('legacy', LEGACY_MSG); throw new Error(LEGACY_MSG); } throw new Error('إعدادات Firebase غير مكتملة'); } boot(); return start(); },
    async signIn(email, password) { if (ERP.testing) throw new Error('غير متاح أثناء الاختبارات'); if (!cfg()) throw new Error('أدخل إعدادات Firebase أولاً'); if (!ERP.settings.get('cloudOn')) ERP.settings.set({ cloudOn: true }); boot(); await initFirebase(); try { await S.auth.signInWithEmailAndPassword(String(email || '').trim(), String(password || '')); } catch (er) { throw new Error(errText(er)); } return S.user; },
    async createAccount(email, password) { if (ERP.testing) throw new Error('غير متاح أثناء الاختبارات'); if (!cfg()) throw new Error('أدخل إعدادات Firebase أولاً'); if (!ERP.settings.get('cloudOn')) ERP.settings.set({ cloudOn: true }); boot(); await initFirebase(); try { await S.auth.createUserWithEmailAndPassword(String(email || '').trim(), String(password || '')); } catch (er) { throw new Error(errText(er)); } return S.user; },
    async signOut() { if (S.auth) await S.auth.signOut(); S.user = S.rawUser = null; S.needsChoice = null; setStatus('signed-out', null); },
    async resetPassword(email) { await initFirebase(); try { await S.auth.sendPasswordResetEmail(String(email || '').trim()); } catch (er) { throw new Error(errText(er)); } },
    pushAll, restorePreview, restore, compare,
    async pullAll() { return restore(); },
    async hasRemote() { return false; }, // no silent auto-restore: restore always goes through the confirmation in the UI
    async syncNow() { S.retry = 0; if (!S.started) boot(); return run(); },
    async disconnect() { ERP.settings.set({ cloudOn: false }); await teardown(); setStatus('disabled', null); },
    inbox() { return S.inbox.slice(); }, refreshInbox, ackTransfer,
    postTransfersSoon() { if (tracking()) setTimeout(() => heartbeat(true), 1500); },
    async branchSummaries() { ready(); return (await S.adapter.list(`companies/${S.uid}/branches`)).map(d => ({ ...d.data, id: d.id })); },
    /** internals for tests (no network: tests pass their own in-memory adapter) */
    _: { toDoc, fromDoc, tombstone, strip, syncable, sig, safeId, splitBatches, mergeSeq, seqRaised, parseConfig, legacyOf, Tracker, makeSynced, pushOnce, buildSummary, buildRestore, paths: P, DENY_COLS, DENY_FIELDS, MAX_OPS, tracking, state: () => S },
  };
  ERP.cloud = cloud;

  /* ======================= UI (settings section + dialogs shared with the backup page) ======================= */
  function statusHtml() {
    const s = ERP.settings.all(); const me = br(); const lp = S.lastPush;
    const rows = [['الحالة', `${u.badge(cloud.label(), cloud.kind())}${S.error && S.status !== 'legacy' ? ` <span class="text-danger text-xs">${e(S.error)}</span>` : ''}`], ['الحساب', S.user ? `<span dir="ltr">${e(S.user.email)}</span> <span class="text-xs muted num" dir="ltr">(${e(S.user.uid.slice(0, 8))}…)</span>` : (s.cloudEmail ? `<span class="muted" dir="ltr">${e(s.cloudEmail)}</span> — غير مسجّل` : '—')], ['الفرع', `${e(me.name)} <span class="badge badge-primary num">${e(me.code)}</span>`], ['آخر مزامنة', S.lastSyncAt ? `${u.relTime(new Date(S.lastSyncAt))} <span class="text-xs muted">${u.fmtDateTime(new Date(S.lastSyncAt))}</span>` : 'لم تتم'], ['بانتظار الرفع', `<span class="num ${tracker.size() ? 'text-warning fw-700' : ''}">${tracker.size()}</span>${lp ? ` <span class="text-xs muted">· آخر دفعة ${lp.pushed} سجل</span>` : ''}`]];
    return `${S.status === 'legacy' || cloud.isLegacy() ? `<div class="alert alert-danger mb-3"><i class="fas fa-triangle-exclamation"></i> ${e(LEGACY_MSG)}</div>` : ''}${S.warning ? `<div class="alert alert-warning mb-3"><i class="fas fa-users-viewfinder"></i> ${e(S.warning)}</div>` : ''}${S.needsChoice ? `<div class="alert alert-warning mb-3"><i class="fas fa-code-branch"></i> يوجد بالفعل بيانات في السحابة لفرع «${e(S.needsChoice.name || S.needsChoice.code)}» (آخر مزامنة ${S.needsChoice.lastSync ? e(u.fmtDateTime(new Date(S.needsChoice.lastSync))) : 'غير معروفة'}). اختر: <strong>استعادة من السحابة</strong> (جهاز جديد) أو <strong>رفع كل البيانات</strong> (دمج بيانات هذا الجهاز فوقها). لن يُرفع شيء قبل اختيارك.</div>` : ''}<div class="detail-grid">${rows.map(r => `<div class="detail-item"><div class="dl">${r[0]}</div><div class="dv">${r[1]}</div></div>`).join('')}</div>${S.errors.length ? `<details class="mt-2"><summary class="text-xs text-danger">آخر الأخطاء (${S.errors.length})</summary><div class="text-xs">${S.errors.map(x => `<div><span class="num muted">${e(u.fmtDateTime(new Date(x.at)))}</span> — ${e(x.msg)}</div>`).join('')}</div></details>` : ''}`;
  }
  async function uiPushAll() {
    const n = allCols().reduce((a, c) => a + ERP.db.collection(c).count(), 0);
    const r = await ERP.ui.form({ title: 'رفع كل البيانات الآن', icon: 'cloud-arrow-up', fields: [{ name: 'i', type: 'html', cols: 2, html: `<div class="alert alert-info"><i class="fas fa-circle-info"></i> سيتم رفع <strong class="num">${n}</strong> سجل من هذا الجهاز إلى فرع «${e(br().name)}» (<span class="num">${e(br().code)}</span>). السجلات الموجودة في السحابة تُحدَّث ولا يُحذف شيء — المستخدمون ورموز الدخول والتوكنات لا تُرفع أبداً.</div>` }, { name: 'mirror', type: 'checkbox', checkLabel: 'مطابقة تامة: احذف من السحابة السجلات التي حُذفت من هذا الجهاز (مثلاً بعد «مسح كل البيانات»)' }], submitText: 'رفع الآن' });
    if (!r) return; const l = ERP.ui.loading('جاري الرفع إلى السحابة…');
    try { const x = await pushAll({ mirror: !!r.mirror }); l.close(); ERP.ui.success(`تم رفع ${x.pushed} سجل`); } catch (er) { l.close(); ERP.ui.error(er.message); }
  }
  async function uiRestore() {
    const l = ERP.ui.loading('جاري فحص بيانات السحابة…'); let p;
    try { p = await restorePreview(); } catch (er) { l.close(); return ERP.ui.error(er.message); } l.close();
    if (!p.cols.length) return ERP.ui.warn('لا توجد بيانات لهذا الفرع في السحابة');
    const bd = p.branch || {};
    const ok = await ERP.ui.confirm(`<div class="mb-2">فرع السحابة: <strong>${e(bd.name || br().code)}</strong> <span class="badge badge-primary num">${e(br().code)}</span> · آخر مزامنة: <strong>${bd.lastSync ? e(u.fmtDateTime(new Date(bd.lastSync))) : 'غير معروفة'}</strong>${bd.dev === devId() ? ' (من هذا الجهاز)' : ''}</div><div class="table-wrap" style="max-height:40vh;overflow:auto"><table class="table table-compact"><thead><tr><th>الجدول</th><th class="num">في السحابة</th><th class="num">على الجهاز الآن</th></tr></thead><tbody>${p.cols.map(c => `<tr><td>${e(c.name)}</td><td class="num">${c.count}</td><td class="num">${ERP.db.collection(c.name).count()}</td></tr>`).join('')}</tbody></table></div><div class="alert alert-warning mt-2"><i class="fas fa-triangle-exclamation"></i> <strong class="text-danger">ستُستبدل جداول هذا الجهاز</strong> بنسخة السحابة (تُحفظ نسخة أمان محلية أولاً). المستخدمون ورموز الدخول تبقى كما هي على هذا الجهاز. عدّادات الترقيم تُرفع لأعلى رقم مستخدم.</div>`, { title: 'استعادة من السحابة', danger: true, okText: 'استعادة الآن' });
    if (!ok) return; const l2 = ERP.ui.loading('جاري تنزيل بيانات الفرع…');
    try { const r = await restore(p); l2.close(); ERP.ui.success(`تمت الاستعادة: ${r.docs} سجل في ${r.cols} جدول`); setTimeout(() => location.reload(), 900); } catch (er) { l2.close(); ERP.ui.error(errText(er)); }
  }
  async function uiCompare() {
    const l = ERP.ui.loading('جاري المقارنة…'); let rows;
    try { rows = await compare(); } catch (er) { l.close(); return ERP.ui.error(errText(er)); } l.close();
    const bad = rows.filter(r => r.diff);
    ERP.ui.view('مقارنة الجهاز بالسحابة', `<div class="alert ${bad.length ? 'alert-warning' : 'alert-success'} mb-3"><i class="fas fa-${bad.length ? 'triangle-exclamation' : 'circle-check'}"></i> ${bad.length ? `${bad.length} جدول مختلف — ${tracker.size() ? `يوجد ${tracker.size()} تغيير بانتظار الرفع. ` : ''}استخدم «رفع كل البيانات الآن» لمطابقة السحابة.` : 'السحابة مطابقة لهذا الجهاز'}</div><div class="table-wrap" style="max-height:60vh;overflow:auto"><table class="table table-compact"><thead><tr><th>الجدول</th><th class="num">على الجهاز</th><th class="num">في السحابة</th><th class="num">الفرق</th></tr></thead><tbody>${rows.map(r => `<tr class="${r.diff ? 'row-danger' : ''}"><td>${e(r.col)}</td><td class="num">${r.local}</td><td class="num">${r.cloud}</td><td class="num">${r.diff > 0 ? '+' : ''}${r.diff}</td></tr>`).join('')}</tbody></table></div><div class="text-xs muted mt-2">لا تُرفع: ${DENY_COLS.map(e).join('، ')} + حقول التوكنات والأسرار.</div>`);
  }
  cloud.ui = { statusHtml, pushAll: uiPushAll, restore: uiRestore, compare: uiCompare };
  if (ERP.bus) ERP.bus.on('cloud:status', () => { const x = typeof document !== 'undefined' && document.getElementById('cl-status'); if (x) x.innerHTML = statusHtml(); const a = typeof document !== 'undefined' && document.getElementById('cl-account'); if (a && !!a.dataset.in !== !!S.user && cloud._rerender) cloud._rerender(); });

  ERP.settingsSections = ERP.settingsSections || [];
  ERP.settingsSections.push({
    id: 'cloud', icon: 'cloud', label: 'السحابة',
    render(s, h) {
      const c = s.cloudCfg; const signed = !!S.user;
      return `<div class="alert alert-info mb-3"><i class="fas fa-circle-info"></i> البيانات تبقى على هذا الجهاز أولاً؛ السحابة (Firebase) للنسخ الاحتياطي ولوحة المالك (<a href="owner.html" target="_blank">owner.html</a>) والتحويلات بين الفروع. كل فرع يرفع بياناته فقط. دليل الإعداد خطوة بخطوة: <strong>CLOUD-SETUP.md</strong>.</div><div class="card card-body mb-3" id="cl-status">${statusHtml()}</div>`
        + `<h4 class="mb-2">1) مشروع Firebase</h4>` + h.row('إعدادات الويب (firebaseConfig)', 'من Firebase Console ← Project settings ← Your apps ← Web. الصقها كما هي (JSON أو كود JavaScript). هذه معرّفات عامة — الحماية بتسجيل الدخول وقواعد الأمان.', `<textarea name="cloudCfgText" rows="5" dir="ltr" style="min-width:280px;font-family:monospace;font-size:.75rem" placeholder='{ "apiKey": "...", "authDomain": "...", "projectId": "..." }'>${c ? e(JSON.stringify(c, null, 1)) : ''}</textarea>`) + h.row('تفعيل المزامنة', 'رفع التغييرات تلقائياً بعد تسجيل الدخول', h.sw('cloudOn', s.cloudOn))
        + `<h4 class="mt-4 mb-2">2) حساب المتجر السحابي</h4><div id="cl-account" ${signed ? 'data-in="1"' : ''}>${signed ? `<div class="flex items-center gap-2 flex-wrap"><i class="fas fa-circle-check text-success"></i> مسجّل الدخول: <strong dir="ltr">${e(S.user.email)}</strong><button type="button" class="btn btn-sm btn-outline" id="cl-out"><i class="fas fa-right-from-bracket"></i> تسجيل الخروج</button></div>` : `<div class="text-sm muted mb-2">حساب واحد لكل شركة (عميل) — نفس الحساب على كل فروعها وفي لوحة المالك. لا تُحفظ كلمة المرور في النظام أو النسخ الاحتياطية.</div><div class="form-row cols-2"><div class="form-group"><label>البريد الإلكتروني</label><input type="email" id="cl-email" dir="ltr" autocomplete="username" value="${e(s.cloudEmail || '')}"></div><div class="form-group"><label>كلمة المرور</label><input type="password" id="cl-pass" dir="ltr" autocomplete="current-password"></div></div><div class="flex gap-2 flex-wrap"><button type="button" class="btn btn-primary" id="cl-in"><i class="fas fa-right-to-bracket"></i> تسجيل الدخول</button><button type="button" class="btn btn-outline" id="cl-new"><i class="fas fa-user-plus"></i> إنشاء حساب سحابي للمتجر</button><button type="button" class="btn btn-ghost" id="cl-reset">نسيت كلمة المرور</button></div>`}</div>`
        + `<h4 class="mt-4 mb-2">3) هوية الفرع</h4>` + h.row('كود الفرع', 'فريد لكل فرع/جهاز داخل الشركة (MAIN، ALEX-01…). اضبطه قبل أول مزامنة — تغييره ينقل الجهاز إلى مساحة فرع أخرى.', h.inp('branchCode', s.branchCode, 'text', 'dir="ltr" style="max-width:160px"')) + h.row('اسم الفرع', '', h.inp('branchName', s.branchName))
        + `<div class="alert alert-warning mt-2"><i class="fas fa-triangle-exclamation"></i> جهاز واحد فقط يكتب لكل كود فرع. أكثر من كاشير في نفس الفرع بنفس الكود غير مدعوم حالياً (يظهر تحذير إن اكتُشف).</div>`
        + `<h4 class="mt-4 mb-2">4) إجراءات</h4><div class="flex gap-2 flex-wrap"><button type="button" class="btn btn-soft-primary" id="cl-sync"><i class="fas fa-rotate"></i> مزامنة الآن</button><button type="button" class="btn btn-outline" id="cl-push"><i class="fas fa-cloud-arrow-up"></i> رفع كل البيانات الآن</button><button type="button" class="btn btn-outline" id="cl-pull"><i class="fas fa-cloud-arrow-down"></i> استعادة من السحابة</button><button type="button" class="btn btn-outline" id="cl-cmp"><i class="fas fa-scale-balanced"></i> مقارنة</button></div><div class="text-xs muted mt-2">لا يُرفع أبداً: المستخدمون ورموز الدخول، السلال المعلّقة، الإشعارات، وحقول التوكنات والأسرار (واتساب، Google Drive، الفاتورة الإلكترونية، الترخيص). «مسح كل البيانات» لا يمسح السحابة.</div>`;
    },
    bind(body, h) {
      const $b = id => body.querySelector('#' + id);
      cloud._rerender = () => { if (body.isConnected) h.rerender(); };
      const act = (id, fn) => { const b = $b(id); if (b) b.onclick = async () => { b.disabled = true; try { await fn(); } catch (er) { ERP.ui.error(er.message); } b.disabled = false; }; };
      const creds = () => { const em = ($b('cl-email') || {}).value || '', pw = ($b('cl-pass') || {}).value || ''; if (!em || !pw) throw new Error('اكتب البريد وكلمة المرور'); return [em, pw]; };
      const needCfg = () => { const t = body.querySelector('[name=cloudCfgText]'); if (!cfg() && t && t.value.trim()) cloud.configure(t.value); if (!cfg()) throw new Error('الصق إعدادات Firebase ثم احفظ الإعدادات أولاً'); };
      act('cl-in', async () => { needCfg(); const [em, pw] = creds(); await cloud.signIn(em, pw); ERP.ui.success('تم تسجيل الدخول'); h.rerender(); });
      act('cl-new', async () => { needCfg(); const [em, pw] = creds(); if (!await ERP.ui.confirm(`إنشاء حساب سحابي جديد لهذه الشركة بالبريد <strong dir="ltr">${e(em)}</strong>؟ استخدم نفس الحساب لاحقاً على باقي الفروع وفي لوحة المالك.`, { okText: 'إنشاء الحساب' })) return; await cloud.createAccount(em, pw); ERP.ui.success('تم إنشاء الحساب وتسجيل الدخول'); h.rerender(); });
      act('cl-reset', async () => { needCfg(); const em = ($b('cl-email') || {}).value; if (!em) throw new Error('اكتب البريد أولاً'); await cloud.resetPassword(em); ERP.ui.success('تم إرسال رابط إعادة التعيين إلى البريد'); });
      act('cl-out', async () => { if (!await ERP.ui.confirm('تسجيل الخروج من حساب السحابة على هذا الجهاز؟ تتوقف المزامنة وتبقى التغييرات في قائمة الانتظار.')) return; await cloud.signOut(); h.rerender(); });
      act('cl-sync', async () => { if (!S.user) throw new Error('سجّل الدخول أولاً'); if (S.needsChoice) throw new Error('اختر أولاً: استعادة من السحابة أو رفع كل البيانات'); await cloud.syncNow(); ERP.ui.success(S.status === 'online' ? 'تمت المزامنة' : cloud.label()); });
      act('cl-push', uiPushAll); act('cl-pull', uiRestore); act('cl-cmp', uiCompare);
    },
    save(patch) {
      if ('cloudCfgText' in patch) { const t = String(patch.cloudCfgText || '').trim(); delete patch.cloudCfgText; if (!t) patch.cloudCfg = null; else { try { patch.cloudCfg = parseConfig(t); patch.cloudSync = false; } catch (er) { ERP.ui.error(er.message); } } }
      if ('branchCode' in patch) patch.branchCode = String(patch.branchCode || '').trim().toUpperCase().replace(/\s+/g, '-') || 'MAIN';
    },
  });
})();
