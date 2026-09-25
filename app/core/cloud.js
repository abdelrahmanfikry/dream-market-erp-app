/* ==========================================================================
   ERP.cloud — separate, self-contained Firebase sync layer
   - Relies on Firestore as the cross-device backbone (multi-branch / backup)
   - Offline-first: every local mutation is queued and pushed when possible
   - Large collections are stored as sharded chunk docs (single Firestore
     document limit is 1 MiB — the old whole-collection doc silently skipped
     anything above 900 KB and LOST that data on push; chunking fixes that)
   - Pull (restore) reassembles chunked docs transparently and stays
     compatible with the previous single-doc cloud format
   - Status notified via the 'cloud:status' bus event (views listen)
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  const u = ERP.utils;

  const MAX_DOC = 380 * 1024;     // safe single Firestore document payload
  const CHUNK = 320 * 1024;       // per-chunk payload
  const CHUNK_THROTTLE_MS = 15 * 60 * 1000; // avoid re-upload storms for big tables

  const C = {
    status: 'off',   // off | disabled | connecting | online | offline | error
    error: null,
    lastSyncAt: null,
    _fs: null, _root: null, _connected: null,
    _adapter: false, _timer: null, _retry: 0, _queue: {}, _busy: false, _lastPush: {},
    _reconn: null, _config: null,
  };

  function cfg(config) {
    const s = ERP.settings && ERP.settings.all ? ERP.settings.all() : {};
    config = config || s.firebaseConfig || null;
    if (!config || !config.projectId) return null;
    return config;
  }
  function storeId(config) { return (ERP.settings.get('cloudStoreId') || config.projectId).replace(/[^\w-]/g, '_'); }
  function notify() { if (ERP.bus && ERP.bus.emit) ERP.bus.emit('cloud:status'); }
  function online() { return typeof navigator === 'undefined' ? true : navigator.onLine !== false; }

  /* ---------------- SDK loading (once, cached) ---------------- */
  const SDK_SRC = ['https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js', 'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore-compat.js'];
  let sdkPromise = null;
  function loadSDK() {
    if (sdkPromise) return sdkPromise;
    if (typeof document === 'undefined' || !document.head) return Promise.reject(new Error('Firebase غير متاح في هذه البيئة'));
    const load = src => new Promise((res, rej) => {
      if (document.querySelector(`script[src="${src}"]`)) return res();
      const s = document.createElement('script'); s.src = src;
      s.onload = res; s.onerror = () => rej(new Error('تعذر تحميل مكتبة Firebase'));
      document.head.appendChild(s);
    });
    sdkPromise = Promise.all(SDK_SRC.map(load)).then(() => window.firebase).catch(e => { sdkPromise = null; throw e; });
    return sdkPromise;
  }

  /* ---------------- connect / reconnect ---------------- */
  async function ensureConnected() {
    if (C._fs && C._root) return C._fs;
    const config = cfg(C._config);
    if (!config) throw new Error('إعدادات Firebase غير مكتملة');
    if (C._connected) return C._connected;
    C.status = 'connecting'; notify();
    C._connected = (async () => {
      const firebase = await loadSDK();
      const app = firebase.apps.length ? firebase.app() : firebase.initializeApp(config);
      const fs = firebase.firestore(app);
      try { await fs.enablePersistence({ synchronizeTabs: true }); } catch (e) { /* already enabled / denied */ }
      C._fs = fs;
      C._root = fs.collection('stores').doc(storeId(config)).collection('data');
      return fs;
    })();
    try { await C._connected; C.status = 'online'; C.error = null; C._retry = 0; notify(); return C._fs; }
    catch (e) { C._connected = null; C.status = 'error'; C.error = e.message; notify(); scheduleReconnect(); throw e; }
  }

  function scheduleReconnect() {
    clearTimeout(C._reconn);
    const back = Math.min(60000, 3000 * Math.pow(2, C._retry++));
    C._reconn = setTimeout(() => { if (cfg(C._config) && C.status !== 'online') ensureConnected().then(run).catch(() => { }); }, back);
  }

  let listening = false;
  function startListeners() {
    if (listening) return; listening = true;
    window.addEventListener('online', () => {
      if (C.status !== 'online' && cfg(C._config)) { ensureConnected().then(run).catch(() => scheduleReconnect()); }
      else run();
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) run(); });
  }

  /* ---------------- chunk encode / decode (pure, unit-testable) ---------------- */
  function chunks(text, size) {
    const s = size || CHUNK; const out = [];
    for (let i = 0; i < text.length; i += s) out.push(text.slice(i, i + s));
    return out;
  }
  function isBig(text) { return text.length > MAX_DOC; }

  async function writeCollection(name, docs) {
    const fs = await ensureConnected();
    const ref = C._root.doc(name);
    const json = JSON.stringify(docs || []);
    const meta = { updatedAt: u.now(), by: (ERP.auth && ERP.auth.current && (ERP.auth.current()?.name || '')) || '', store: (ERP.settings.get('storeName')) || '', v: 1 };
    if (!isBig(json)) { await ref.set({ json, ...meta }); return; }
    const parts = chunks(json);
    const now = Date.now();
    if (now - (C._lastPush[name] || 0) < CHUNK_THROTTLE_MS && C._lastPush[name] !== undefined) { throw new Error('still throttled'); }
    C._lastPush[name] = now;
    // write chunks in parallel (each well under the 1 MiB limit), index doc last
    await Promise.all(parts.map((data, i) => ref.collection('chunks').doc(String(i)).set({ i, data })));
    await ref.set({ chunked: true, count: parts.length, ...meta });
  }

  async function readCollectionData(fs, rootRef, name) {
    const ref = rootRef.doc(name);
    const d = await ref.get();
    if (!d.exists) return null;
    const data = d.data() || {};
    if (!data.chunked) return JSON.parse(data.json || '[]');
    const q = await ref.collection('chunks').get();
    const parts = new Array(data.count);
    q.forEach(c => { const cd = c.data(); parts[cd.i] = cd.data; });
    if (parts.some(p => p == null)) throw new Error('أجزاء ناقصة في السحابة');
    return JSON.parse(parts.join(''));
  }
  async function readCollection(name) {
    await ensureConnected();
    return readCollectionData(C._fs, C._root, name);
  }

  /* ---------------- background adapter (push on change) ---------------- */
  function startAdapter() {
    if (C._adapter) return; C._adapter = true;
    ERP.db.setRemote({ onChange(name, docs) { C._queue[name] = { docs, at: u.now() }; arm(); } });
  }
  function arm(ms) { clearTimeout(C._timer); C._timer = setTimeout(run, ms == null ? 1200 : ms); }

  async function run() {
    if (C._busy || !Object.keys(C._queue).length) return;
    if (!online()) { C.status = 'offline'; notify(); arm(4000); return; }
    let batch;
    try {
      batch = Object.entries(C._queue);
      C._busy = true;
      C.status = 'connecting'; notify();
      await ensureConnected();
      for (const [name, entry] of batch) {
        try { await writeCollection(name, entry.docs); delete C._queue[name]; }
        catch (e) { if (e.message === 'still throttled') { /* keep queued, retry later */ } else throw e; }
      }
      C.status = 'online'; C.error = null; C._retry = 0;
      touchLastSync(60); notify();
    } catch (e) {
      C.error = e.message; C.status = 'offline'; notify();
      scheduleReconnect(); arm(4000);
    } finally { C._busy = false; }
    if (Object.keys(C._queue).length) arm(2000);
  }

  function touchLastSync(minEverySec) {
    const now = u.now();
    if (C.lastSyncAt && now - C.lastSyncAt < (minEverySec || 0) * 1000) return;
    C.lastSyncAt = now;
    try { ERP.settings.set({ lastCloudSync: now }, { silent: true }); } catch (e) { /* */ }
  }

  /* ---------------- public API ---------------- */
  const cloud = {
    get status() { return C.status; },
    get error() { return C.error; },
    get lastSyncAt() { return C.lastSyncAt; },
    pending() { return Object.keys(C._queue).length; },
    chunks,
    isConfigured() { return !!cfg(); },
    async connect(config) {
      C._config = cfg(config) || C._config;
      if (!C._config) throw new Error('إعدادات Firebase غير مكتملة');
      const fs = await ensureConnected();
      startAdapter(); startListeners(); run().catch(() => { });
      return fs;
    },
    async firestore() { return ensureConnected(); },
    async hasRemote() {
      await ensureConnected();
      const qs = await C._root.get();
      return !qs.empty;
    },
    async readStore(storeId) {
      await ensureConnected();
      const root = C._fs.collection('stores').doc(storeId).collection('data');
      const qs = await root.get();
      const out = {};
      for (const d of qs.docs) { try { out[d.id] = await readCollectionData(C._fs, root, d.id); } catch (e) { console.warn('skip store collection', d.id, e); } }
      return out;
    },
    async pushAll() {
      await ensureConnected();
      for (const n of ERP.db.KNOWN) { const c = ERP.db.collection(n); const docs = c.all(); if (docs.length) { await writeCollection(n, docs); delete C._queue[n]; } }
      touchLastSync(60); C.status = 'online'; C.error = null; C._retry = 0; notify();
      ERP.audit.log('backup.export', 'رفع كامل للسحابة');
    },
    async pullAll() {
      await ensureConnected();
      const qs = await C._root.get();
      if (qs.empty) throw new Error('لا توجد بيانات في السحابة');
      const snap = { collections: {} }; let bad = 0;
      for (const doc of qs.docs) {
        try { snap.collections[doc.id] = await readCollection(doc.id); }
        catch (e) { console.warn('skip cloud collection', doc.id, e); bad++; }
      }
      if (ERP.backup && ERP.backup.snapshotLocal) await ERP.backup.snapshotLocal('pre-cloud-pull');
      await ERP.db.import(snap, { mode: 'replace' });
      if (ERP.settings && ERP.settings.load) ERP.settings.load();
      ERP.audit.log('backup.restore', 'استعادة من السحابة');
      return { cols: Object.keys(snap.collections).length, bad };
    },
    async syncNow(opts = {}) {
      if (opts.force) { for (const n of ERP.db.KNOWN) { const docs = ERP.db.collection(n).all(); if (docs.length) { C._queue[n] = { docs, at: u.now() }; } } }
      return run();
    },
    async disconnect() {
      clearTimeout(C._timer); clearTimeout(C._reconn);
      if (C._adapter) { ERP.db.setRemote(null); C._adapter = false; }
      C._root = null; C._fs = null; C._connected = null; C._queue = {}; C._lastPush = {};
      C.status = 'off'; C.error = null; notify();
    },
  };
  ERP.cloud = cloud;
})();