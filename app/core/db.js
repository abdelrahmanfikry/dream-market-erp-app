/* ==========================================================================
   ERP.db — offline-first document store
   - Synchronous API over an in-memory cache (views/services never await)
   - Persistence: IndexedDB (hundreds of MB); localStorage only when IndexedDB is
     unsupported or the user accepts it after an open failure (merged back later)
   - Writes clear their pending sets only after the transaction COMMITS; failures
     are retried with backoff and reported (db:error + alert) — never silent
   - Single writer: navigator.locks guard, a 2nd tab is blocked until taken over
   - One-time migration from the old localStorage store (dm_erp:*)
   - Every write emits bus events: db:change {collection, op, doc}
   - Sequences for document numbering (INV-000001 …)
   - Import/export for backups, optional remote adapter for cloud sync
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  const u = ERP.utils;
  const NS = 'dm_erp:';
  const META_KEY = NS + '__meta';
  const IDB_NAME = 'dm_erp';
  const IDB_VERSION = 1;

  const cache = {};            // name -> array of docs
  const dirty = {};            // name -> Set(ids) changed since last flush
  const removed = {};          // name -> Set(ids) deleted since last flush
  const replaced = new Set();  // collections fully replaced (clear + rewrite)
  let persistTimer = null;
  let remote = null;
  let meta = null;
  let metaDirty = false;
  let idb = null;              // IDBDatabase or null (localStorage mode)
  let mode = 'ls';             // 'idb' | 'ls'
  const versions = {};         // name -> monotonic mutation counter (revision)
  let ready = false;
  let flushing = null;         // pending flush promise
  let failures = 0;            // consecutive failed flushes (retried with backoff)
  let readOnly = false;        // another tab took over (single-writer guard) → this tab never writes
  const DEBOUNCE = 60;
  const LS_FALLBACK = NS + '__lsFallback'; // set while a session had to run on localStorage although IndexedDB exists
  const isDataKey = k => k.startsWith(NS) && k !== META_KEY && k !== NS + 'session' && !k.startsWith(NS + '__');

  /* ---------------- IndexedDB helpers ---------------- */
  function openIDB() {
    return new Promise((res, rej) => {
      if (!window.indexedDB) return rej(new Error('no indexedDB'));
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('docs')) { const s = d.createObjectStore('docs', { keyPath: '_k' }); s.createIndex('col', '_c', { unique: false }); }
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv', { keyPath: 'k' });
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error || new Error('idb open failed'));
      req.onblocked = () => rej(new Error('idb blocked'));
    });
  }
  const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const txDone = tx => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error('aborted')); });
  const key = (col, id) => `${col}::${id}`;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function idbLoadAll() {
    const tx = idb.transaction(['docs', 'kv'], 'readonly');
    const rows = await reqP(tx.objectStore('docs').getAll());
    const m = await reqP(tx.objectStore('kv').get('meta'));
    rows.forEach(r => { (cache[r._c] = cache[r._c] || []).push(r.d); });
    meta = (m && m.v) || null;
  }
  function touchedNames() { return u.uniq(Object.keys(dirty).filter(n => dirty[n].size).concat(Object.keys(removed).filter(n => removed[n].size)).concat([...replaced])); }
  /** move pending changes into a job (fresh sets collect new changes meanwhile); restoreJob() puts them back on failure */
  function takeJob() {
    const job = { names: touchedNames(), dirty: {}, removed: {}, replaced: new Set(replaced), meta: metaDirty };
    job.names.forEach(n => { job.dirty[n] = dirty[n] || new Set(); job.removed[n] = removed[n] || new Set(); dirty[n] = new Set(); removed[n] = new Set(); });
    replaced.clear(); metaDirty = false;
    return job;
  }
  function restoreJob(job) {
    job.names.forEach(n => {
      const d = dirty[n] = dirty[n] || new Set(), r = removed[n] = removed[n] || new Set();
      job.dirty[n].forEach(id => { if (!r.has(id)) d.add(id); }); job.removed[n].forEach(id => { if (!d.has(id)) r.add(id); });
    });
    job.replaced.forEach(n => replaced.add(n)); if (job.meta) metaDirty = true;
  }
  /** one readwrite transaction; resolves only after COMMIT (oncomplete), rejects on error/abort (e.g. QuotaExceededError) */
  function idbWrite(job) {
    return new Promise((res, rej) => {
      const tx = idb.transaction(['docs', 'kv'], 'readwrite'); const docs = tx.objectStore('docs');
      tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error || new Error('idb write failed')); tx.onabort = () => rej(tx.error || new Error('idb write aborted'));
      const put = (n, d) => docs.put({ _k: key(n, d.id), _c: n, d });
      try {
        for (const n of job.names) {
          if (job.replaced.has(n)) { const r = docs.index('col').getAllKeys(n); r.onsuccess = () => { r.result.forEach(k => docs.delete(k)); (cache[n] || []).forEach(d => put(n, d)); }; continue; }
          const c = db.collection(n);
          job.dirty[n].forEach(id => { const d = c.get(id); if (d) put(n, d); });
          job.removed[n].forEach(id => docs.delete(key(n, id)));
        }
        if (job.meta) tx.objectStore('kv').put({ k: 'meta', v: meta });
        if (!job.replaced.size && tx.commit) tx.commit(); // commit early (helps on unload)
      } catch (e) { try { tx.abort(); } catch { /* */ } rej(e); }
    });
  }

  /* ---------------- localStorage fallback ---------------- */
  function lsRead() {
    const cols = {}; let m = null;
    Object.keys(localStorage).filter(isDataKey).forEach(k => {
      try { const v = JSON.parse(localStorage.getItem(k)); cols[k.slice(NS.length)] = Array.isArray(v) ? v : []; } catch { cols[k.slice(NS.length)] = []; }
    });
    try { m = JSON.parse(localStorage.getItem(META_KEY)); } catch { m = null; }
    return { cols, meta: m };
  }
  function lsLoadAll() { const r = lsRead(); Object.assign(cache, r.cols); meta = r.meta; }
  /** throws on the first failure (the caller restores the job) */
  function lsWrite(job) {
    job.names.forEach(n => localStorage.setItem(NS + n, JSON.stringify(cache[n] || [])));
    if (job.meta) localStorage.setItem(META_KEY, JSON.stringify(meta));
  }
  function lsHasData() { return Object.keys(localStorage).some(isDataKey); }
  function lsClear() { Object.keys(localStorage).filter(k => isDataKey(k) || k === META_KEY || k === LS_FALLBACK).forEach(k => localStorage.removeItem(k)); }

  /* ---------------- persistence errors are never silent ---------------- */
  function onPersistError(e, names) {
    failures++;
    console.error('[db] persist failed', names, e);
    ERP.bus.emit('db:error', { names, error: e, failures, mode });
    const quota = e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message || ''));
    const msg = quota ? 'مساحة التخزين ممتلئة! لم يتم حفظ آخر التعديلات. قم بعمل نسخة احتياطية فوراً وتنظيف البيانات القديمة.' : 'تعذر حفظ البيانات على الجهاز — ستتم إعادة المحاولة تلقائياً. لا تغلق البرنامج قبل عمل نسخة احتياطية.';
    if (failures === 1) { try { window.alert('خطأ حفظ البيانات\n\n' + msg); } catch { /* */ } }
    else if (failures % 10 === 0 && ERP.ui && ERP.ui.toast) ERP.ui.toast(msg, 'error', { title: 'خطأ حفظ', duration: 15000 });
    clearTimeout(persistTimer); persistTimer = setTimeout(flush, Math.min(30000, 1000 * 2 ** Math.min(failures, 5)));
  }

  /* ---------------- single-writer guard: one app tab per browser profile ---------------- */
  const LOCK_NAME = 'dm_erp_writer';
  const TRAP_EVENTS = ['keydown', 'keypress', 'keyup'];
  function blockScreen(text, btnText, onBtn) {
    let el = document.getElementById('db-block');
    if (!el) {
      el = document.createElement('div'); el.id = 'db-block'; el.setAttribute('dir', 'rtl');
      el.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(15,23,42,.97);color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1.2rem;font-family:Cairo,system-ui,sans-serif;text-align:center;padding:2rem';
      el._trap = ev => { if (!el.contains(ev.target)) { ev.stopImmediatePropagation(); ev.preventDefault(); } };
      TRAP_EVENTS.forEach(t => window.addEventListener(t, el._trap, true));
      document.body.appendChild(el);
    }
    el.innerHTML = `<div style="font-size:3rem">⚠️</div><div style="font-size:1.4rem;font-weight:800;max-width:560px;line-height:1.8"></div>${btnText ? '<button style="font:inherit;font-size:1.1rem;padding:.7rem 1.6rem;border:0;border-radius:10px;background:#1a56f5;color:#fff;cursor:pointer"></button>' : ''}`;
    el.children[1].textContent = text; if (btnText) { el.children[2].textContent = btnText; el.children[2].onclick = onBtn; }
    return el;
  }
  function unblock() { const el = document.getElementById('db-block'); if (el) { TRAP_EVENTS.forEach(t => window.removeEventListener(t, el._trap, true)); el.remove(); } }
  function lostWriter() {
    if (readOnly) return;
    try { persistNow(); } catch { /* */ } // hand over this tab's last changes
    readOnly = true; clearTimeout(persistTimer);
    ERP.bus.emit('db:readonly');
    blockScreen('تم فتح النظام في نافذة أخرى — هذه النافذة متوقفة عن الحفظ.', 'استخدمه هنا (إعادة تحميل)', () => location.reload());
  }
  /** resolves once this tab is the only writer; meanwhile shows a blocking message */
  function acquireWriter() {
    const L = navigator.locks;
    const msg = 'النظام مفتوح في نافذة أخرى — أغلقها أو اضغط لاستخدامه هنا';
    if (L && L.request) {
      return new Promise(resolve => {
        let got = false;
        const forever = () => new Promise(() => { }); // lock held until the tab closes
        const hold = () => { if (!got) { got = true; unblock(); resolve(); } return forever(); };
        const onErr = e => { if (got) { if (e && e.name === 'AbortError') lostWriter(); } else { console.warn('[db] locks', e); hold(); } };
        L.request(LOCK_NAME, { ifAvailable: true }, lock => {
          if (lock) return hold();
          blockScreen(msg, 'استخدمه هنا', () => L.request(LOCK_NAME, { steal: true }, () => sleep(700).then(hold)).catch(onErr)); // 700ms: let the other tab write its last changes
          L.request(LOCK_NAME, () => (readOnly ? null : hold())).catch(e => { if (!got) onErr(e); }); // …or take over when the other tab closes
          return null;
        }).catch(onErr);
      });
    }
    if (!window.BroadcastChannel) return Promise.resolve();
    return new Promise(resolve => { // fallback: BroadcastChannel ping/pong
      const ch = new BroadcastChannel(LOCK_NAME); let writer = false, other = false;
      const become = () => { if (writer) return; writer = true; unblock(); resolve(); };
      ch.onmessage = ev => { const t = ev.data && ev.data.t; if (t === 'ping' && writer && !readOnly) ch.postMessage({ t: 'pong' }); else if (t === 'pong') other = true; else if (t === 'steal' && writer) lostWriter(); };
      ch.postMessage({ t: 'ping' });
      setTimeout(() => { if (!other) return become(); blockScreen(msg, 'استخدمه هنا', () => { ch.postMessage({ t: 'steal' }); setTimeout(become, 700); }); }, 300);
    });
  }

  /* ---------------- core ---------------- */
  function ensureMeta() { meta = meta || {}; meta.seq = meta.seq || {}; meta.version = meta.version || 2; return meta; }
  function saveMeta() { metaDirty = true; schedulePersist(); }
  function load(name) { return cache[name] || (cache[name] = []); }
  function markDirty(name, id) { (dirty[name] = dirty[name] || new Set()).add(id); (removed[name] = removed[name] || new Set()).delete(id); schedulePersist(); }
  function markRemoved(name, id) { (removed[name] = removed[name] || new Set()).add(id); (dirty[name] = dirty[name] || new Set()).delete(id); schedulePersist(); }
  function markReplaced(name) { replaced.add(name); schedulePersist(); }
  function schedulePersist() { if (failures || readOnly) return; clearTimeout(persistTimer); persistTimer = setTimeout(flush, DEBOUNCE); } // while failing, keep the backoff retry timer
  function hasPending() { return metaDirty || replaced.size > 0 || Object.values(dirty).some(s => s.size) || Object.values(removed).some(s => s.size); }

  /** persist pending changes. Resolves true once the write COMMITTED, false on failure (changes stay pending and are retried) */
  function flush() {
    if (readOnly) return Promise.resolve(false);
    if (flushing) return flushing.then(() => (hasPending() && !failures ? flush() : !failures));
    clearTimeout(persistTimer);
    if (!hasPending()) return Promise.resolve(true);
    const job = takeJob();
    const run = mode === 'idb' && idb ? idbWrite(job) : new Promise(res => { lsWrite(job); res(); });
    flushing = run.then(() => {
      flushing = null; failures = 0;
      if (remote && remote.onChange) job.names.forEach(n => { try { remote.onChange(n, cache[n]); } catch (e) { console.warn('remote', e); } });
      ERP.bus.emit('db:flushed', job.names);
      if (hasPending()) schedulePersist();
      return true;
    }, e => { flushing = null; restoreJob(job); onPersistError(e, job.names); return false; });
    return flushing;
  }
  /** issue the write synchronously (unload paths): requests are queued before the page goes away */
  function persistNow() {
    if (readOnly || !hasPending()) return;
    clearTimeout(persistTimer);
    const job = takeJob();
    const fail = e => { restoreJob(job); console.error('[db] unload write failed', e); };
    try { if (mode === 'idb' && idb) idbWrite(job).catch(fail); else lsWrite(job); } catch (e) { fail(e); }
  }

  /** raise sequence counters to the highest number already used (after import/restore) */
  const SEQS = [ // [seqKey, collection, field, settings numbering kind | '=literal prefix' | RegExp]
    ['sale', 'sales', 'no', 'sale'], ['return', 'sales', 'no', 'return'], ['purchase', 'purchases', 'no', 'purchase'], ['PRET', 'purchases', 'no', '=PRET'],
    ['receipt', 'payments', 'no', 'receipt'], ['payment', 'payments', 'no', 'payment'], ['expense', 'expenses', 'no', 'expense'], ['journal', 'journal', 'no', 'journal'],
    ['transfer', 'transfers', 'no', 'transfer'], ['stocktake', 'stocktakes', 'no', 'stocktake'], ['quotation', 'quotations', 'no', 'quotation'], ['order', 'orders', 'no', '=ORD'],
    ['SHIFT', 'shifts', 'no', '=SH'], ['BTRF', 'transfers', 'no', /^BT-.+-(\d+)$/], ['BTRF_IN', 'transfers', 'no', /^BR-.+-(\d+)$/],
    ['PRD', 'products', 'code', '=PRD'], ['CUS', 'customers', 'code', '=CUS'], ['SUP', 'suppliers', 'code', '=SUP'], ['EMP', 'employees', 'code', '=EMP'], ['AST', 'assets', 'code', '=AST'],
  ];
  const reEsc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function raiseSeqs() {
    ensureMeta();
    const st = (load('settings').find(d => d.id === 'main') || {}).numbering || {};
    const pre = kind => st[kind] || (ERP.settings && ERP.settings.DEFAULTS && ERP.settings.DEFAULTS.numbering[kind]) || kind.toUpperCase();
    let changed = false;
    SEQS.forEach(([k, col, field, p]) => {
      const re = p instanceof RegExp ? p : new RegExp('^' + reEsc(p[0] === '=' ? p.slice(1) : pre(p)) + '-(\\d+)$');
      let max = 0; for (const d of load(col)) { const m = typeof d[field] === 'string' && re.exec(d[field]); if (m) max = Math.max(max, +m[1]); }
      if (max > (meta.seq[k] || 0)) { meta.seq[k] = max; changed = true; }
    });
    if (changed) saveMeta();
    return changed;
  }
  /** merge docs into a collection: new ids are added, an existing doc is only overwritten by a NEWER one (updatedAt) */
  function mergeInto(n, incoming) {
    const cur = load(n); const idx = u.keyBy(cur); let count = 0;
    (incoming || []).forEach(d => {
      if (!d || d.id == null) return; const ex = idx[d.id];
      if (!ex) { const c = { ...d }; cur.push(c); idx[d.id] = c; markDirty(n, d.id); count++; }
      else if (!ex.updatedAt || (d.updatedAt && d.updatedAt > ex.updatedAt)) { Object.assign(ex, d); markDirty(n, d.id); count++; }
    });
    if (collections[n]) { collections[n].invalidate(); collections[n]._bump(); } else versions[n] = (versions[n] || 0) + 1;
    return count;
  }

  function stamp(doc, isNew, col) {
    const now = u.now();
    const user = ERP.auth && ERP.auth.current ? (ERP.auth.current()?.id ?? null) : null;
    if (isNew) { doc.id = doc.id || u.uid(); doc.createdAt = doc.createdAt || now; doc.createdBy = doc.createdBy ?? user; if (col && !doc.branch && ERP.branches && ERP.branches.STAMP_COLS.has(col)) { try { doc.branch = ERP.branches.current().code; } catch { /* settings not ready */ } } }
    doc.updatedAt = now;
    if (user) doc.updatedBy = user;
    return doc;
  }
  function matches(doc, where) {
    return Object.entries(where).every(([k, v]) => {
      if (typeof v === 'function') return v(doc[k], doc);
      if (Array.isArray(v)) return v.includes(doc[k]);
      return doc[k] === v;
    });
  }

  class Collection {
    constructor(name) { this.name = name; this._idx = null; this._mapC = null; }
    all() { return load(this.name); }
    count() { return this.all().length; }
    /** version/revision — bumped on EVERY mutation (incl. silent) */
    version() { return versions[this.name] || 0; }
    _bump() { versions[this.name] = (versions[this.name] || 0) + 1; this._mapC = null; }
    invalidate() { this._idx = null; this._mapC = null; }
    /** O(1) lookup by id (index built lazily, kept in sync) */
    get(id) {
      if (id == null) return null;
      const i = this._ensureIdx().get(id);
      return i != null ? this.all()[i] || null : null;
    }
    _ensureIdx() {
      if (!this._idx) {
        const arr = this.all(); this._idx = new Map();
        for (let i = 0; i < arr.length; i++) this._idx.set(arr[i].id, i);
      }
      return this._idx;
    }
    _idxAt(id) { const v = this._ensureIdx().get(id); return v == null ? -1 : v; }
    _indexAdded() {
      if (!this._idx) return;
      this._idx.set(this.all()[this.all().length - 1].id, this.all().length - 1);
    }
    find(pred) { return this.all().filter(pred); }
    findOne(pred) { return this.all().find(pred) || null; }
    where(obj) { return this.all().filter(d => matches(d, obj)); }
    first(obj) { return this.all().find(d => matches(d, obj)) || null; }
    byIds(ids) { const s = new Set(ids); return this.all().filter(d => s.has(d.id)); }
    map() {
      if (!this._mapC) { const m = {}; for (const d of this.all()) m[d.id] = d; this._mapC = m; }
      return this._mapC;
    }

    insert(doc, { silent = false } = {}) {
      doc = stamp({ ...doc }, true, this.name);
      this.all().push(doc); markDirty(this.name, doc.id);
      this._bump(); this._indexAdded();
      if (!silent) ERP.bus.emit('db:change', { collection: this.name, op: 'insert', doc });
      return doc;
    }
    bulkInsert(docs, { silent = false } = {}) {
      const arr = this.all();
      const out = docs.map(d => { const s = stamp({ ...d }, true, this.name); arr.push(s); markDirty(this.name, s.id); return s; });
      this._bump();
      if (this._idx) for (let i = 0; i < out.length; i++) this._idx.set(out[i].id, this.all().length - out.length + i);
      if (!silent) ERP.bus.emit('db:change', { collection: this.name, op: 'bulk', docs: out });
      return out;
    }
    update(id, patch, { silent = false } = {}) {
      const arr = this.all();
      let i = this._idxAt(id);
      if (i < 0) { i = arr.findIndex(d => d.id === id); if (i < 0) return null; }
      const next = typeof patch === 'function' ? patch({ ...arr[i] }) : { ...arr[i], ...patch };
      arr[i] = stamp(next, false, this.name); markDirty(this.name, id);
      this._bump();
      if (!silent) ERP.bus.emit('db:change', { collection: this.name, op: 'update', doc: arr[i] });
      return arr[i];
    }
    upsert(doc) { return this.get(doc.id) ? this.update(doc.id, doc) : this.insert(doc); }
    remove(id, { silent = false } = {}) {
      const arr = this.all();
      let i = this._idxAt(id);
      if (i < 0) { i = arr.findIndex(d => d.id === id); if (i < 0) return null; }
      const [doc] = arr.splice(i, 1); markRemoved(this.name, id);
      this._bump(); this.invalidate();
      if (!silent) ERP.bus.emit('db:change', { collection: this.name, op: 'remove', doc });
      return doc;
    }
    removeWhere(pred, { silent = false } = {}) {
      const arr = this.all();
      const gone = arr.filter(pred);
      if (gone.length) { const ids = new Set(gone.map(d => d.id)); gone.forEach(d => markRemoved(this.name, d.id)); cache[this.name] = arr.filter(d => !ids.has(d.id)); this._bump(); this.invalidate(); if (!silent) ERP.bus.emit('db:change', { collection: this.name, op: 'removeMany', count: gone.length }); }
      return gone.length;
    }
    replaceAll(docs) {
      cache[this.name] = docs.map(d => ({ ...d })); markReplaced(this.name);
      this._bump(); this.invalidate();
      ERP.bus.emit('db:change', { collection: this.name, op: 'replace' });
    }
    clear() { this.replaceAll([]); }
    latest(n = 20, field = 'createdAt') { return u.sortBy(this.all(), field, 'desc').slice(0, n); }
  }

  const collections = {};
  const KNOWN = [
    'settings', 'users', 'roles', 'auditLog', 'notifications',
    'categories', 'units', 'warehouses', 'paymentMethods', 'expenseCategories',
    'products', 'stockMoves', 'stocktakes', 'transfers',
    'customers', 'suppliers', 'sales', 'purchases', 'payments', 'expenses',
    'accounts', 'journal', 'employees', 'attendance', 'payroll', 'advances',
    'shifts', 'promotions', 'heldCarts', 'quotations', 'assets', 'cashMoves', 'giftCards', 'branches'
  ];

  const db = {
    NS, KNOWN,
    /** open storage, load everything into memory, migrate from localStorage if needed */
    async init() {
      if (ready) return db;
      await acquireWriter(); // blocks (with a message) while another tab of the app is the writer
      let err = null;
      if (window.indexedDB) for (let i = 0; i < 3 && !idb; i++) { try { idb = await openIDB(); } catch (e) { err = e; idb = null; await sleep(300 * (i + 1)); } } // retry one-off open failures
      if (idb) {
        mode = 'idb';
        await idbLoadAll();
        const idbEmpty = !Object.keys(cache).length && !meta, fellBack = localStorage.getItem(LS_FALLBACK);
        if ((idbEmpty || fellBack) && lsHasData()) {
          if (idbEmpty) { lsLoadAll(); Object.keys(cache).forEach(n => replaced.add(n)); ensureMeta(); metaDirty = true; }
          else { // a previous session had to run on localStorage → merge it back (newer updatedAt wins)
            const r = lsRead(); Object.keys(r.cols).forEach(n => mergeInto(n, r.cols[n]));
            ensureMeta(); Object.entries((r.meta && r.meta.seq) || {}).forEach(([k, v]) => { if (+v > (meta.seq[k] || 0)) meta.seq[k] = +v; }); raiseSeqs(); metaDirty = true;
          }
          if (await flush()) { lsClear(); console.info('[db] localStorage → IndexedDB', idbEmpty ? 'migrated' : 'merged'); }
        } else if (fellBack) localStorage.removeItem(LS_FALLBACK);
      } else if (!window.indexedDB) {
        console.warn('[db] IndexedDB not supported, using localStorage');
        mode = 'ls'; lsLoadAll();
      } else {
        const msg = (err && (err.message || err.name)) || 'unknown';
        console.error('[db] IndexedDB open failed', err);
        ERP.bus.emit('db:error', { names: [], error: err, failures: 0, mode: 'open' });
        if (window.confirm(`تعذر فتح قاعدة البيانات (${msg}).\n\nموافق = إعادة المحاولة (مستحسن)\nإلغاء = العمل مؤقتاً على تخزين محدود — لن تظهر بياناتك المحفوظة الآن، وسيتم دمج ما تسجله تلقائياً عند عودة قاعدة البيانات.`)) { location.reload(); return new Promise(() => { }); }
        mode = 'ls'; lsLoadAll(); ensureMeta(); if (!lsHasData()) meta.demoSeeded = true; // don't seed demo data into the temporary store
        try { localStorage.setItem(LS_FALLBACK, u.now()); } catch { /* */ }
      }
      ensureMeta(); ready = true;
      return db;
    },
    mode() { return mode; },
    isReady() { return ready; },
    /** true when another tab took over — this tab no longer persists anything */
    isReadOnly() { return readOnly; },
    hasPending,
    collection(name) { return collections[name] || (collections[name] = new Collection(name)); },
    col(name) { return db.collection(name); },
    /** revision counter for a collection (bumped on every mutation incl. silent) */
    version(name) { return versions[name] || 0; },
    /** persist now; resolves true after commit (false = failed, will retry) */
    flush,
    nextSeq(k, prefix = k, width = 6) { ensureMeta(); meta.seq[k] = (meta.seq[k] || 0) + 1; saveMeta(); return `${prefix}-${String(meta.seq[k]).padStart(width, '0')}`; },
    peekSeq(k) { ensureMeta(); return (meta.seq[k] || 0) + 1; },
    setSeq(k, val) { ensureMeta(); meta.seq[k] = val; saveMeta(); },
    raiseSeqs,
    getMeta(k) { return ensureMeta()[k]; },
    setMeta(k, v) { ensureMeta(); meta[k] = v; saveMeta(); },

    export(names) {
      const out = { __app: 'DreamMarketERP', __version: 2, __exportedAt: u.now(), __meta: JSON.parse(JSON.stringify(ensureMeta())), collections: {} };
      (names || u.uniq([...KNOWN, ...Object.keys(cache)])).forEach(n => { out.collections[n] = load(n); });
      return out;
    },
    /** restore a snapshot. mode: 'replace' | 'merge' (newer updatedAt wins). Returns a promise that resolves when persisted. */
    import(snapshot, { mode: m = 'replace', names } = {}) {
      if (!snapshot || !snapshot.collections) throw new Error('ملف غير صالح');
      const cols = names || Object.keys(snapshot.collections);
      cols.forEach(n => {
        const incoming = snapshot.collections[n] || [];
        if (m === 'merge') { mergeInto(n, incoming); return; }
        cache[n] = incoming.map(d => ({ ...d })); replaced.add(n);
        if (collections[n]) { collections[n].invalidate(); collections[n]._bump(); } else versions[n] = (versions[n] || 0) + 1;
      });
      const sm = snapshot.__meta ? JSON.parse(JSON.stringify(snapshot.__meta)) : null;
      if (sm && m === 'replace') { meta = sm; ensureMeta(); }
      else if (sm && sm.seq) { ensureMeta(); Object.entries(sm.seq).forEach(([k, v]) => { if (+v > (meta.seq[k] || 0)) meta.seq[k] = +v; }); }
      raiseSeqs(); // counters never restart below numbers already used (INV-000001 duplicates)
      metaDirty = true;
      const p = flush();
      ERP.bus.emit('db:imported', { mode: m, cols });
      return p;
    },
    /** wipe everything (all collections, meta, snapshots) */
    async reset() {
      clearTimeout(persistTimer); failures = 0;
      Object.keys(cache).forEach(k => delete cache[k]);
      Object.values(collections).forEach(c => c.invalidate());
      Object.keys(dirty).forEach(k => delete dirty[k]); Object.keys(removed).forEach(k => delete removed[k]); replaced.clear(); metaDirty = false; meta = null;
      Object.keys(localStorage).filter(k => k.startsWith(NS)).forEach(k => localStorage.removeItem(k));
      if (idb) { try { const tx = idb.transaction(['docs', 'kv'], 'readwrite'); tx.objectStore('docs').clear(); tx.objectStore('kv').clear(); await txDone(tx); } catch (e) { console.warn(e); } }
      ERP.bus.emit('db:reset');
    },
    /** storage usage — sync estimate from cache; usageAsync() adds the browser quota */
    usage() {
      let bytes = 0;
      Object.keys(cache).forEach(n => { bytes += JSON.stringify(cache[n]).length * 2; });
      const limit = mode === 'idb' ? 500 * 1024 * 1024 : 5 * 1024 * 1024;
      return { kb: Math.round(bytes / 1024), pct: Math.min(100, Math.round(bytes / limit * 100)), mode, docs: Object.values(cache).reduce((a, c) => a + c.length, 0) };
    },
    async usageAsync() {
      const base = db.usage();
      try { if (navigator.storage && navigator.storage.estimate) { const e = await navigator.storage.estimate(); base.quotaMB = Math.round(e.quota / 1048576); base.usedMB = Math.round(e.usage / 1048576 * 10) / 10; if (e.quota) base.pct = Math.min(100, Math.round(e.usage / e.quota * 100)); } } catch { /* */ }
      return base;
    },
    /** key/value store for large blobs (emergency snapshot etc.) */
    async kvSet(k, v) { if (readOnly) return; if (idb) { const tx = idb.transaction('kv', 'readwrite'); tx.objectStore('kv').put({ k, v }); await txDone(tx); } else localStorage.setItem(NS + '__kv_' + k, JSON.stringify(v)); },
    async kvGet(k) { if (idb) { const tx = idb.transaction('kv', 'readonly'); const r = await reqP(tx.objectStore('kv').get(k)); return r ? r.v : null; } try { const r = localStorage.getItem(NS + '__kv_' + k); return r ? JSON.parse(r) : null; } catch { return null; } },
    setRemote(adapter) { remote = adapter; },
    remote() { return remote; },
  };

  ERP.db = db;
  // unload: issue the write synchronously (desktop/main.js additionally awaits ERP.db.flush() before closing the window)
  window.addEventListener('beforeunload', persistNow);
  window.addEventListener('pagehide', persistNow);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && hasPending()) flush(); });
})();
