/* ==========================================================================
   ERP.eta — Egyptian Tax Authority e-receipt (منظومة الإيصال الإلكتروني, B2C) v1.2
   - buildReceipt(sale) → receipt JSON (header/documentType/seller/buyer/itemData/totals)
   - serialize(receipt) → ETA canonical string; uuid = SHA-256 hex of it with header.uuid = ''
   - previousUUID chain per POS serial (kept in db meta → travels with backups)
   - every new sale / return (db:change on 'sales' insert) is built + queued (collection etaQueue);
     a voided sale that already has a receipt gets an automatic return receipt (type 'R')
   - worker: token (POST {id}/connect/token) → POST {api}/api/v1/receiptsubmissions → poll details
     HTTP goes through the desktop app (window.desktop.etaRequest) — browsers are blocked by CORS;
     browser-only installs keep receipts queued and can export them as JSON
   - B2B e-invoices (USB-token signature) are OUT of scope
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  const u = ERP.utils; const e = u.escapeHtml;
  const Q = () => ERP.db.collection('etaQueue');
  const SALES = () => ERP.db.collection('sales');
  const P = () => ERP.db.collection('products');
  ERP.settings.extend({
    etaEnabled: false, etaEnv: 'preprod',
    etaIdUrlPreprod: 'https://id.preprod.eta.gov.eg', etaApiUrlPreprod: 'https://api.preprod.invoicing.eta.gov.eg',
    etaIdUrlProd: 'https://id.eta.gov.eg', etaApiUrlProd: 'https://api.invoicing.eta.gov.eg',
    etaShareUrlPreprod: 'https://preprod.invoicing.eta.gov.eg/receipts/search/{uuid}/share/{dateTimeIssued}#Total:{total},IssuerRIN:{rin}',
    etaShareUrlProd: 'https://invoicing.eta.gov.eg/receipts/search/{uuid}/share/{dateTimeIssued}#Total:{total},IssuerRIN:{rin}',
    etaClientId: '', etaClientSecret: '', etaPosSerial: '', etaPosOsVersion: 'Windows 10', etaPosModel: '', etaPresharedKey: '',
    etaRin: '', etaTradeName: '', etaBranchCode: '0', etaCountry: 'EG', etaGovernate: '', etaRegionCity: '', etaStreet: '', etaBuildingNumber: '', etaPostalCode: '', etaActivityCode: '',
    etaItemType: 'EGS', etaDefaultUnit: 'EA', etaWeightUnit: 'KGM', etaBuyerIdThreshold: 150000, etaBatchSize: 50,
  });

  /* ---------------- pure helpers ---------------- */
  const r5 = n => u.round(n, 5); // ETA amounts: 5 decimals
  const isoZ = d => new Date(d || Date.now()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  /** ETA canonical serialization: "KEY" + value for every property (keys upper-cased, values quoted as-is);
   *  an array writes its key once, then "KEY" + serialized element for each element */
  function serialize(v) {
    if (v === null || v === undefined) return '""';
    if (typeof v !== 'object') return '"' + String(v) + '"';
    let s = '';
    Object.keys(v).forEach(k => {
      const K = '"' + k.toUpperCase() + '"'; const x = v[k];
      if (Array.isArray(x)) { s += K; x.forEach(el => { s += K + serialize(el); }); } else s += K + serialize(x);
    });
    return s;
  }
  /* SHA-256 — WebCrypto when available (secure context), otherwise a small pure-JS fallback (same result) */
  const KS = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
  function sha256HexJs(str) {
    const ror = (x, n) => (x >>> n) | (x << (32 - n));
    const bytes = new TextEncoder().encode(str); const l = bytes.length; const len = ((l + 9 + 63) >> 6) << 6;
    const m = new Uint8Array(len); m.set(bytes); m[l] = 0x80; const dv = new DataView(m.buffer);
    dv.setUint32(len - 4, (l * 8) >>> 0); dv.setUint32(len - 8, Math.floor(l * 8 / 0x100000000));
    const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]; const w = new Uint32Array(64);
    for (let i = 0; i < len; i += 64) {
      for (let t = 0; t < 16; t++) w[t] = dv.getUint32(i + t * 4);
      for (let t = 16; t < 64; t++) { const x = w[t - 15], y = w[t - 2]; w[t] = (w[t - 16] + (ror(x, 7) ^ ror(x, 18) ^ (x >>> 3)) + w[t - 7] + (ror(y, 17) ^ ror(y, 19) ^ (y >>> 10))) >>> 0; }
      let [A, B, C, D, E, F, G, Hh] = H;
      for (let t = 0; t < 64; t++) { const t1 = (Hh + (ror(E, 6) ^ ror(E, 11) ^ ror(E, 25)) + ((E & F) ^ (~E & G)) + KS[t] + w[t]) >>> 0; const t2 = ((ror(A, 2) ^ ror(A, 13) ^ ror(A, 22)) + ((A & B) ^ (A & C) ^ (B & C))) >>> 0; Hh = G; G = F; F = E; E = (D + t1) >>> 0; D = C; C = B; B = A; A = (t1 + t2) >>> 0; }
      H[0] = (H[0] + A) >>> 0; H[1] = (H[1] + B) >>> 0; H[2] = (H[2] + C) >>> 0; H[3] = (H[3] + D) >>> 0; H[4] = (H[4] + E) >>> 0; H[5] = (H[5] + F) >>> 0; H[6] = (H[6] + G) >>> 0; H[7] = (H[7] + Hh) >>> 0;
    }
    return H.map(x => x.toString(16).padStart(8, '0')).join('');
  }
  async function sha256Hex(str) {
    try { if (window.crypto && crypto.subtle && window.isSecureContext !== false) { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)); return Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, '0')).join(''); } } catch { /* fall back */ }
    return sha256HexJs(str);
  }
  async function computeUUID(receipt) { const c = JSON.parse(JSON.stringify(receipt)); c.header.uuid = ''; return sha256Hex(serialize(c)); }

  const PAY = { cash: 'C', card: 'V', visa: 'V', gift: 'GC', points: 'P', loyalty: 'P', voucher: 'VO' };
  function payCode(sale) { const ps = (sale.payments || []).filter(p => !p.receiptId && u.num(p.amount) > 0); if (!ps.length) return 'C'; const top = u.sortBy(ps, p => u.num(p.amount), 'desc')[0]; return PAY[top.method] || (top.isGift ? 'GC' : 'O'); }
  /** inclusive VAT? decided from the stored line tax (the sale doc doesn't keep the flag) */
  function detectInclusive(sale, s) {
    let vi = 0, ve = 0;
    (sale.items || []).forEach(it => { const r = u.num(it.taxRate), t = u.num(it.total), tx = u.num(it.taxAmount); if (!r || !tx) return; vi += Math.abs(tx - (t - t / (1 + r / 100))); ve += Math.abs(tx - t * r / 100); });
    return vi === ve ? !!s.taxInclusive : vi < ve;
  }
  function unitType(p, s) { if (p.etaUnitType) return p.etaUnitType; if (p.unitId === 'un_kg') return s.etaWeightUnit || 'KGM'; if (p.unitId === 'un_g') return 'GRM'; return s.etaDefaultUnit || 'EA'; }
  function itemCode(p, s, internal, barcode) { if (p.etaItemCode) return p.etaItemCode; const t = p.etaItemType || s.etaItemType || 'EGS'; if (t === 'GS1' && /^\d{8,14}$/.test(barcode || '')) return barcode; return `EG-${s.etaRin || ''}-${internal}`; }

  /**
   * PURE: sale / return doc → ETA receipt (header.uuid = '').
   * o: { settings, products (id → product), customer, kind: 'sale'|'return'|'void', previousUUID, referenceUUID, referenceOldUUID, dateTimeIssued, receiptNumber, taxInclusive }
   * amounts: unitPrice excl. VAT; line + invoice discounts (pre-tax) → commercialDiscountData;
   * loyalty points (after tax) → extraReceiptDiscountData; delivery fee → feesAmount
   */
  function buildReceipt(sale, o = {}) {
    const s = o.settings || ERP.settings.all(); const pm = o.products || {};
    const retDoc = sale.type === 'return'; const isR = retDoc || o.kind === 'void' || o.kind === 'return';
    const items = sale.items || []; const incl = o.taxInclusive != null ? !!o.taxInclusive : detectInclusive(sale, s);
    const lineNet = items.map(it => u.num(it.total)); const netSum = u.sum(lineNet);
    const invDisc = Math.max(0, retDoc ? u.round(u.num(sale.discount) - u.sum(items, 'discount')) : u.num(sale.invoiceDiscount));
    const shares = lineNet.map(n => (netSum ? invDisc * n / netSum : 0)); if (shares.length && invDisc) shares[shares.length - 1] = invDisc - u.sum(shares.slice(0, -1));
    const itemData = items.map((it, i) => {
      const p = pm[it.productId] || {}; const rate = u.num(it.taxRate); const f = incl && rate ? 1 / (1 + rate / 100) : 1;
      const internal = String(p.code || it.productId || i + 1); const type = p.etaItemType || s.etaItemType || 'EGS';
      const unitPrice = r5(u.num(it.price) * f); const totalSale = r5(u.num(it.qty) * unitPrice);
      const disc = []; if (u.num(it.discount)) disc.push({ amount: r5(u.num(it.discount) * f), description: String(it.promoLabel || 'خصم الصنف') }); if (r5(shares[i])) disc.push({ amount: r5(shares[i] * f), description: 'خصم الفاتورة' });
      const netSale = r5(totalSale - u.sum(disc, 'amount')); const tax = rate ? r5(netSale * rate / 100) : 0;
      const line = { internalCode: internal, description: String(it.name || p.name || internal), itemType: type, itemCode: itemCode(p, s, internal, it.barcode || p.barcode), unitType: unitType(p, s), quantity: r5(it.qty), unitPrice, netSale, totalSale, total: r5(netSale + tax) };
      if (disc.length) line.commercialDiscountData = disc;
      line.taxableItems = rate ? [{ taxType: 'T1', amount: tax, subType: 'V009', rate }] : [];
      return line;
    });
    const header = { dateTimeIssued: o.dateTimeIssued || isoZ(sale.date), receiptNumber: String(o.receiptNumber || sale.no || ''), uuid: '', previousUUID: o.previousUUID || '' };
    if (isR) header.referenceUUID = o.referenceUUID || '';
    if (o.referenceOldUUID) header.referenceOldUUID = o.referenceOldUUID;
    header.currency = 'EGP'; header.exchangeRate = 0;
    const branchAddress = { country: s.etaCountry || 'EG', governate: s.etaGovernate || '', regionCity: s.etaRegionCity || '', street: s.etaStreet || '', buildingNumber: s.etaBuildingNumber || '' }; if (s.etaPostalCode) branchAddress.postalCode = s.etaPostalCode;
    const c = o.customer || null; const buyer = { type: 'P' };
    if (c && (c.nationalId || c.taxId)) buyer.id = String(c.nationalId || c.taxId);
    if (c && c.name) buyer.name = c.name; if (c && c.phone) buyer.mobileNumber = u.normalizeDigits(c.phone).replace(/\D/g, '');
    const taxT = r5(u.sum(itemData, l => u.sum(l.taxableItems, 'amount')));
    const extra = retDoc ? 0 : r5(u.num(sale.loyaltyDiscount)); const fees = r5(u.num(sale.deliveryFee));
    const rc = {
      header, documentType: { receiptType: isR ? 'R' : 'S', typeVersion: '1.2' },
      seller: { rin: s.etaRin || '', companyTradeName: s.etaTradeName || s.storeName || '', branchCode: String(s.etaBranchCode ?? '0'), branchAddress, deviceSerialNumber: s.etaPosSerial || '', activityCode: s.etaActivityCode || '' },
      buyer, itemData,
      totalSales: r5(u.sum(itemData, 'totalSale')), totalCommercialDiscount: r5(u.sum(itemData, l => u.sum(l.commercialDiscountData || [], 'amount'))), totalItemsDiscount: 0,
    };
    if (extra) rc.extraReceiptDiscountData = [{ amount: extra, description: 'نقاط ولاء' }];
    Object.assign(rc, { netAmount: r5(u.sum(itemData, 'netSale')), feesAmount: fees, totalAmount: r5(u.sum(itemData, 'total') - extra + fees), taxTotals: taxT ? [{ taxType: 'T1', amount: taxT }] : [], paymentMethod: payCode(sale), adjustment: 0 });
    return rc;
  }
  /** validation warnings before submission (missing setup / buyer id above threshold) */
  function check(rc, s = ERP.settings.all()) {
    const w = [];
    if (!s.etaRin) w.push('رقم التسجيل الضريبي (RIN) غير محدد'); if (!s.etaPosSerial) w.push('الرقم التسلسلي لنقطة البيع غير محدد'); if (!s.etaActivityCode) w.push('كود النشاط غير محدد');
    if (!s.etaGovernate || !s.etaRegionCity || !s.etaStreet || !s.etaBuildingNumber) w.push('عنوان الفرع ناقص');
    if (rc && rc.totalAmount >= u.num(s.etaBuyerIdThreshold) && !rc.buyer.id) w.push(`الإيصال ≥ ${u.fmtNum(s.etaBuyerIdThreshold, 0)} — يلزم الرقم القومي للمشتري`);
    return w;
  }

  /* ---------------- queue ---------------- */
  const urls = (s = ERP.settings.all()) => { const pr = s.etaEnv === 'prod'; const t = x => String(x || '').trim().replace(/\/+$/, ''); return { id: t(pr ? s.etaIdUrlProd : s.etaIdUrlPreprod), api: t(pr ? s.etaApiUrlProd : s.etaApiUrlPreprod), share: pr ? s.etaShareUrlProd : s.etaShareUrlPreprod }; };
  const chainKey = (s = ERP.settings.all()) => 'etaPrev:' + (s.etaPosSerial || 'POS');
  let chainP = Promise.resolve();
  const serialQ = fn => (chainP = chainP.then(fn, fn)); // receipts are built one at a time so previousUUID is a strict chain
  const worker = { paused: false, running: false, lastRun: null, lastError: '', timer: null };
  let tok = null;

  function setSale(id, patch) { if (SALES().get(id)) SALES().update(id, patch); }
  function enqueue(sale, kind = 'sale', extra = {}) {
    return serialQ(async () => {
      const s = ERP.settings.all(); const cur = SALES().get(sale.id) || sale;
      let referenceUUID = extra.referenceUUID || '';
      if (kind === 'return' && !referenceUUID) { const orig = cur.refSaleId ? SALES().get(cur.refSaleId) : null; referenceUUID = orig && orig.etaUUID || ''; if (!referenceUUID) { setSale(cur.id, { etaStatus: 'error', etaError: 'الفاتورة الأصلية ليس لها إيصال إلكتروني — أرسلها أولاً ثم أعد إرسال المرتجع' }); return null; } }
      const prev = ERP.db.getMeta(chainKey(s)) || '';
      const rc = buildReceipt(cur, { settings: s, products: P().map(), customer: cur.customerId ? ERP.db.collection('customers').get(cur.customerId) : null, kind, previousUUID: prev, referenceUUID, referenceOldUUID: extra.referenceOldUUID || '', receiptNumber: extra.receiptNumber, dateTimeIssued: kind === 'void' ? isoZ() : isoZ(cur.date) });
      rc.header.uuid = await computeUUID(rc);
      if (worker.paused && !eta._allowInTests) return null; // test run restored the data meanwhile
      ERP.db.setMeta(chainKey(s), rc.header.uuid);
      const q = Q().insert({ saleId: cur.id, saleNo: cur.no, kind, receiptNumber: rc.header.receiptNumber, uuid: rc.header.uuid, issuedAt: rc.header.dateTimeIssued, total: rc.totalAmount, receipt: rc, status: 'queued', attempts: 0, nextAt: 0, error: '', warnings: check(rc, s), env: s.etaEnv });
      if (kind === 'void') setSale(cur.id, { etaVoidStatus: 'queued', etaVoidUUID: rc.header.uuid });
      else setSale(cur.id, { etaStatus: 'queued', etaUUID: rc.header.uuid, etaIssuedAt: rc.header.dateTimeIssued, etaTotal: rc.totalAmount, etaError: '' });
      kick();
      return q;
    });
  }
  function onNewSale(id) { const s = SALES().get(id); if (!s || s.etaUUID || s.status === 'void') return; return enqueue(s, s.type === 'return' ? 'return' : 'sale'); }
  function onVoid(id) {
    const s = SALES().get(id); if (!s || s.etaVoidUUID || !s.etaUUID) return;
    if (s.etaStatus === 'rejected') { setSale(id, { etaVoidStatus: 'n/a' }); return; }
    return enqueue(s, 'void', { referenceUUID: s.etaUUID, receiptNumber: `${s.no}-V` });
  }
  const voiding = new Set();
  ERP.bus.on('db:change', ev => {
    if (!ev || ev.collection !== 'sales' || !ev.doc || !ERP.settings.get('etaEnabled')) return;
    if ((ERP.db.isReadOnly && ERP.db.isReadOnly()) || (worker.paused && !eta._allowInTests)) return;
    const d = ev.doc;
    if (ev.op === 'insert' && !d.etaUUID) setTimeout(() => onNewSale(d.id), 0);
    else if (ev.op === 'update' && d.status === 'void' && d.etaUUID && !d.etaVoidUUID && d.etaVoidStatus !== 'n/a' && !voiding.has(d.id)) { voiding.add(d.id); setTimeout(() => Promise.resolve(onVoid(d.id)).finally(() => voiding.delete(d.id)), 0); }
  });

  /* ---------------- transport + API ---------------- */
  function transport() { if (eta.transport) return eta.transport; return window.desktop && window.desktop.etaRequest ? req => window.desktop.etaRequest(req) : null; }
  const errText = x => { if (!x) return ''; if (typeof x === 'string') return x.slice(0, 400); const out = []; const walk = (o, depth) => { if (!o || depth > 4) return; if (typeof o === 'string') { out.push(o); return; } if (Array.isArray(o)) { o.forEach(v => walk(v, depth + 1)); return; } if (typeof o === 'object') { const msg = o.message || o.error_description || o.Message; if (o.code || msg) out.push([o.code, o.propertyPath || o.target, msg].filter(Boolean).join(': ')); ['details', 'error', 'errors', 'innerError'].forEach(k => o[k] && typeof o[k] === 'object' && walk(o[k], depth + 1)); if (typeof o.error === 'string') out.push(o.error); } }; walk(x, 0); return u.uniq(out).join(' | ').slice(0, 600); };
  const parse = t => { try { return JSON.parse(t); } catch { return null; } };
  async function request(req) { const t = transport(); if (!t) { const er = new Error('لا يمكن الاتصال بالضرائب من المتصفح (CORS) — استخدم تطبيق سطح المكتب أو «تصدير JSON»'); er.noTransport = true; throw er; } const r = await t(req); if (!r) throw new Error('لا رد'); if (r.status === 0) throw new Error('تعذّر الاتصال: ' + (r.err || 'network')); return { ...r, json: parse(r.text) }; }
  async function token(force = false) {
    if (!force && tok && tok.exp > Date.now() + 60000) return tok.value;
    const s = ERP.settings.all(); if (!s.etaClientId || !s.etaClientSecret) throw new Error('Client ID / Client Secret غير محددين');
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', posserial: s.etaPosSerial || '', pososversion: s.etaPosOsVersion || '', presharedkey: s.etaPresharedKey || '' }; if (s.etaPosModel) headers.posmodelframework = s.etaPosModel;
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: s.etaClientId, client_secret: s.etaClientSecret }).toString();
    const r = await request({ url: urls(s).id + '/connect/token', method: 'POST', headers, body });
    if (!r.ok || !r.json || !r.json.access_token) throw new Error(`فشل تسجيل الدخول للضرائب (${r.status}) ${errText(r.json || r.text)}`);
    tok = { value: r.json.access_token, exp: Date.now() + u.num(r.json.expires_in, 3600) * 1000 };
    return tok.value;
  }
  const backoff = n => Date.now() + Math.min(3600, 30 * 2 ** Math.max(0, n - 1)) * 1000;
  function mark(q, patch) { const d = Q().update(q.id, patch); const sp = {}; const st = patch.status; if (st) { if (q.kind === 'void') sp.etaVoidStatus = st; else { sp.etaStatus = st; sp.etaError = patch.error || ''; if (patch.longId) sp.etaLongId = patch.longId; } setSale(q.saleId, sp); } return d; }
  async function submitBatch(batch) {
    const s = ERP.settings.all(); const t = await token();
    const r = await request({ url: urls(s).api + '/api/v1/receiptsubmissions', method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t }, body: JSON.stringify({ receipts: batch.map(q => q.receipt) }) });
    if (r.status === 401) { tok = null; throw new Error('انتهت صلاحية الدخول (401) — ستُعاد المحاولة'); }
    const j = r.json || {};
    const acc = j.acceptedDocuments || j.acceptedReceipts || []; const rej = j.rejectedDocuments || j.rejectedReceipts || [];
    if (!r.ok && !acc.length && !rej.length) {
      const msg = `(${r.status}) ${errText(j) || String(r.text || '').slice(0, 300)}`;
      if (r.status >= 400 && r.status < 500 && r.status !== 429 && r.status !== 408) { batch.forEach(q => mark(q, { status: 'rejected', error: msg, attempts: q.attempts + 1, lastTryAt: u.now() })); return { rejected: batch.length }; }
      throw new Error(msg);
    }
    const sub = j.submissionUUID || j.submissionId || j.submissionUuid || '';
    let ok = 0, bad = 0;
    batch.forEach(q => {
      const a = acc.find(x => x.uuid === q.uuid || x.receiptNumber === q.receiptNumber);
      const b = rej.find(x => x.uuid === q.uuid || x.receiptNumber === q.receiptNumber);
      if (a) { ok++; mark(q, { status: 'submitted', submissionUUID: sub, longId: a.longId || '', submittedAt: u.now(), attempts: q.attempts + 1, error: '' }); }
      else if (b) { const msg = errText(b.error || b); if (/duplicate|already\s*(exist|submitted)/i.test(msg)) { ok++; mark(q, { status: 'submitted', submissionUUID: sub, submittedAt: u.now(), error: '', attempts: q.attempts + 1 }); } else { bad++; mark(q, { status: 'rejected', error: msg || 'مرفوض', attempts: q.attempts + 1, lastTryAt: u.now() }); } }
      else mark(q, { status: 'error', error: 'لا يوجد رد لهذا الإيصال في نتيجة الإرسال', attempts: q.attempts + 1, nextAt: backoff(q.attempts + 1), lastTryAt: u.now() });
    });
    return { accepted: ok, rejected: bad, submissionUUID: sub };
  }
  async function pollSubmitted() {
    const s = ERP.settings.all(); const list = Q().all().filter(q => q.status === 'submitted' && q.submissionUUID && u.num(q.polls) < 20 && Date.now() - new Date(q.submittedAt).getTime() > 20000).slice(0, 10);
    const bySub = u.groupBy(list, 'submissionUUID');
    for (const [sub, qs] of Object.entries(bySub)) {
      const t = await token();
      const r = await request({ url: `${urls(s).api}/api/v1/receiptsubmissions/${encodeURIComponent(sub)}/details?PageNo=1&PageSize=100`, method: 'GET', headers: { Authorization: 'Bearer ' + t } });
      qs.forEach(q => Q().update(q.id, { polls: u.num(q.polls) + 1 }));
      if (!r.ok || !r.json) continue;
      const rows = r.json.receipts || r.json.documentSummary || r.json.result || [];
      qs.forEach(q => { const x = rows.find(y => y.uuid === q.uuid || y.receiptNumber === q.receiptNumber); if (!x) return; const st = String(x.status || '').toLowerCase(); if (st === 'valid') mark(q, { status: 'valid', validatedAt: u.now() }); else if (st === 'invalid' || st === 'rejected') mark(q, { status: 'rejected', error: errText(x.errors || x.validationResults || x.error) || 'Invalid' }); });
    }
  }
  const configured = (s = ERP.settings.all()) => !!(s.etaEnabled && s.etaClientId && s.etaClientSecret && s.etaRin && s.etaPosSerial);
  async function run({ force = false } = {}) {
    if (worker.running || (worker.paused && !force)) return { skipped: true };
    const s = ERP.settings.all(); if (!s.etaEnabled || !transport() || (ERP.db.isReadOnly && ERP.db.isReadOnly())) return { skipped: true };
    if (!configured(s)) { worker.lastError = 'إعدادات الضرائب غير مكتملة (Client ID / Secret / RIN / POS serial)'; return { skipped: true }; }
    worker.running = true; worker.lastRun = u.now(); const res = { accepted: 0, rejected: 0 };
    try {
      const now = Date.now();
      const due = u.sortBy(Q().all().filter(q => (q.status === 'queued' || q.status === 'error') && (force || u.num(q.nextAt) <= now)), 'issuedAt');
      for (const batch of u.chunk(due, Math.max(1, Math.min(100, u.num(s.etaBatchSize, 50))))) { // in chain order; a transport failure stops the run
        try { const r = await submitBatch(batch); res.accepted += r.accepted || 0; res.rejected += r.rejected || 0; }
        catch (err) { worker.lastError = err.message; batch.forEach(q => mark(q, { status: 'error', error: err.message, attempts: q.attempts + 1, nextAt: backoff(q.attempts + 1), lastTryAt: u.now() })); break; }
      }
      try { await pollSubmitted(); } catch (err) { worker.lastError = err.message; }
      if (!res.rejected && res.accepted) worker.lastError = '';
    } finally { worker.running = false; }
    return res;
  }
  const kick = u.debounce(() => { run().catch(err => { worker.lastError = err.message; }); }, 3000);
  function start() { if (worker.timer) return; wrapTests(); worker.timer = setInterval(() => { run().catch(err => { worker.lastError = err.message; }); }, 30000); }
  /* the self-tests must never submit/queue real receipts: the worker pauses while ERP.tests.run() is active */
  function wrapTests() { if (!ERP.tests || ERP.tests.__etaWrapped) return; const orig = ERP.tests.run; ERP.tests.run = async function (...a) { worker.paused = true; try { return await orig.apply(this, a); } finally { await chainP.catch(() => { }); worker.paused = false; eta._allowInTests = false; } }; ERP.tests.__etaWrapped = true; }
  document.addEventListener('DOMContentLoaded', wrapTests);
  ERP.bus.on('auth:login', () => setTimeout(start, 4000));

  /* ---------------- resend / export / print ---------------- */
  const lastQ = (saleId, kind) => u.sortBy(Q().all().filter(q => q.saleId === saleId && (kind ? q.kind === kind : q.kind !== 'void')), 'createdAt', 'desc')[0] || null;
  async function resend(saleId) {
    const s = SALES().get(saleId); if (!s) throw new Error('الفاتورة غير موجودة');
    const q = lastQ(saleId);
    if (q && (q.status === 'error' || q.status === 'queued')) { mark(q, { status: 'queued', attempts: 0, nextAt: 0, error: '' }); run({ force: true }).catch(() => { }); return 'retry'; }
    if (q && q.status === 'rejected') { Q().update(q.id, { status: 'replaced' }); await enqueue(s, q.kind, { referenceOldUUID: q.uuid, referenceUUID: q.kind === 'void' ? s.etaUUID : '', receiptNumber: q.kind === 'void' ? s.no + '-V' : undefined }); run({ force: true }).catch(() => { }); return 'rebuilt'; }
    if (!q) { await enqueue(s, s.type === 'return' ? 'return' : 'sale'); run({ force: true }).catch(() => { }); return 'queued'; }
    return 'noop';
  }
  const canResend = s => !!s && ERP.settings.get('etaEnabled') && (['error', 'rejected'].includes(s.etaStatus) || (!s.etaStatus && s.status !== 'void'));
  function exportQueued() { const list = u.sortBy(Q().all().filter(q => ['queued', 'error'].includes(q.status)), 'issuedAt'); if (!list.length) { ERP.ui.info('لا توجد إيصالات في الانتظار'); return 0; } u.downloadJSON({ receipts: list.map(q => q.receipt) }, `eta-receipts-${u.todayISO()}.json`); return list.length; }
  /** ETA share URL for the receipt QR — null when the sale has no e-receipt */
  function qrInfo(sale) {
    if (!sale || !sale.etaUUID || !sale.etaIssuedAt) return null; const s = ERP.settings.all();
    const url = String(urls(s).share || '').replace('{uuid}', sale.etaUUID).replace('{dateTimeIssued}', sale.etaIssuedAt).replace('{total}', String(sale.etaTotal ?? sale.total)).replace('{rin}', s.etaRin || '');
    return { url, uuid: sale.etaUUID, status: sale.etaStatus };
  }
  const LABELS = { queued: ['بانتظار الإرسال', 'warning'], submitted: ['مُرسل', 'info'], valid: ['مقبول', 'success'], rejected: ['مرفوض', 'danger'], error: ['خطأ', 'danger'], replaced: ['مُستبدل', 'neutral'], 'n/a': ['—', 'neutral'] };
  const badge = s => { if (!s || !s.etaStatus) return '<span class="muted text-xs">—</span>'; const l = LABELS[s.etaStatus] || [s.etaStatus, 'neutral']; return `<span title="${e(s.etaError || s.etaUUID || '')}">${u.badge(l[0], l[1])}</span>${s.etaVoidStatus && s.etaVoidStatus !== 'n/a' ? ` <span title="إيصال إلغاء">${u.badge('إلغاء: ' + (LABELS[s.etaVoidStatus] || [s.etaVoidStatus])[0], (LABELS[s.etaVoidStatus] || [0, 'neutral'])[1])}</span>` : ''}`; };
  function stats() { const all = Q().all(); const by = u.groupBy(all, 'status'); return { total: all.length, by: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.length])), errors: u.sortBy(all.filter(q => q.status === 'error' || q.status === 'rejected'), 'updatedAt', 'desc').slice(0, 8), chainHead: ERP.db.getMeta(chainKey()) || '' }; }

  const eta = { serialize, sha256Hex, sha256HexJs, computeUUID, buildReceipt, check, round5: r5, isoZ, urls, enqueue, onNewSale, onVoid, run, token, resend, canResend, exportQueued, qrInfo, badge, stats, worker, start, transport: null, _allowInTests: false, idle: () => chainP.catch(() => { }), LABELS, configured };
  ERP.eta = eta;

  /* ---------------- settings section ---------------- */
  ERP.settingsSections = ERP.settingsSections || [];
  ERP.settingsSections.push({
    id: 'eta', icon: 'file-shield', label: 'الإيصال الإلكتروني (الضرائب)',
    render(s, h) {
      const st = stats(); const desk = !!(window.desktop && window.desktop.etaRequest);
      const f = (name, label, type = 'text', extra = '') => `<div class="form-group"><label>${label}</label>${h.inp(name, s[name], type, extra)}</div>`;
      const sel = (name, opts) => `<select name="${name}">${opts.map(([v, l]) => `<option value="${h.e(v)}" ${String(s[name]) === String(v) ? 'selected' : ''}>${h.e(l)}</option>`).join('')}</select>`;
      return `<div class="alert alert-info mb-3"><i class="fas fa-circle-info"></i> منظومة الإيصال الإلكتروني لمصلحة الضرائب المصرية (B2C — إيصالات نقاط البيع، إصدار 1.2). كل بيع أو مرتجع يُبنى له إيصال ويُضاف لقائمة الانتظار ويُرسل تلقائياً${desk ? '' : ' — <strong>الإرسال المباشر متاح في تطبيق سطح المكتب فقط</strong> (المتصفح ممنوع من الاتصال بخوادم الضرائب)، ويمكن هنا «تصدير JSON» للإرسال بأداة أخرى'}. الفاتورة الإلكترونية B2B (بتوقيع USB Token) خارج هذا النطاق.</div>`
        + `<div class="kpi-grid mb-3">${[['clock', 'warning', 'بانتظار الإرسال', (st.by.queued || 0)], ['paper-plane', 'info', 'مُرسل', st.by.submitted || 0], ['circle-check', 'success', 'مقبول', st.by.valid || 0], ['circle-xmark', 'danger', 'مرفوض / خطأ', (st.by.rejected || 0) + (st.by.error || 0)]].map(k => `<div class="card kpi" style="padding:.7rem 1rem"><div class="kpi-icon ${k[1]}" style="width:38px;height:38px;font-size:1rem"><i class="fas fa-${k[0]}"></i></div><div class="kpi-body"><div class="kpi-label">${k[2]}</div><div class="kpi-value" style="font-size:1.1rem">${u.fmtInt(k[3])}</div></div></div>`).join('')}</div>`
        + `<div class="flex gap-2 flex-wrap mb-3"><button type="button" class="btn btn-outline" id="eta-test" ${desk ? '' : 'disabled'}><i class="fas fa-plug"></i> اختبار الاتصال</button><button type="button" class="btn btn-outline" id="eta-run" ${desk ? '' : 'disabled'}><i class="fas fa-paper-plane"></i> إرسال الآن</button><button type="button" class="btn btn-outline" id="eta-export"><i class="fas fa-file-export"></i> تصدير JSON</button><button type="button" class="btn btn-ghost" id="eta-retry"><i class="fas fa-rotate"></i> إعادة محاولة الأخطاء</button></div>`
        + (worker.lastError || st.errors.length ? `<div class="alert alert-danger mb-3 text-sm"><i class="fas fa-triangle-exclamation"></i> ${worker.lastError ? `<div><strong>آخر خطأ:</strong> ${h.e(worker.lastError)}</div>` : ''}${st.errors.map(q => `<div><span class="num">${h.e(q.receiptNumber)}</span> — ${h.e((LABELS[q.status] || [q.status])[0])}: ${h.e(q.error || '')}</div>`).join('')}</div>` : '')
        + h.row('تفعيل الإيصال الإلكتروني', 'يُنشئ إيصالاً لكل فاتورة ومرتجع جديد ويرسله للمنظومة', h.sw('etaEnabled', s.etaEnabled))
        + h.row('البيئة', 'ابدأ بالتجريبية (Pre-production) حتى تُقبل الإيصالات', sel('etaEnv', [['preprod', 'تجريبية (Pre-production)'], ['prod', 'فعلية (Production)']]))
        + `<h4 class="mt-4 mb-2"><i class="fas fa-key text-primary"></i> بيانات الربط (من بوابة المنظومة)</h4><div class="form-row cols-2">${f('etaClientId', 'Client ID', 'text', 'dir="ltr" autocomplete="off"')}${f('etaClientSecret', 'Client Secret', 'password', 'dir="ltr" autocomplete="new-password"')}${f('etaPosSerial', 'الرقم التسلسلي لنقطة البيع (POS Serial)', 'text', 'dir="ltr"')}${f('etaPosOsVersion', 'نظام تشغيل نقطة البيع (POS OS version)', 'text', 'dir="ltr"')}${f('etaPresharedKey', 'Pre-shared key', 'password', 'dir="ltr" autocomplete="new-password"')}${f('etaPosModel', 'POS model framework (اختياري)', 'text', 'dir="ltr"')}</div>`
        + `<h4 class="mt-4 mb-2"><i class="fas fa-building text-primary"></i> بيانات البائع والفرع</h4><div class="form-row cols-2">${f('etaRin', 'رقم التسجيل الضريبي (RIN)', 'text', 'dir="ltr" inputmode="numeric"')}${f('etaTradeName', 'الاسم التجاري')}${f('etaBranchCode', 'كود الفرع (0 = الرئيسي)', 'text', 'dir="ltr"')}${f('etaActivityCode', 'كود النشاط', 'text', 'dir="ltr"')}${f('etaCountry', 'الدولة', 'text', 'dir="ltr" maxlength="2"')}${f('etaGovernate', 'المحافظة')}${f('etaRegionCity', 'المدينة / المنطقة')}${f('etaStreet', 'الشارع')}${f('etaBuildingNumber', 'رقم المبنى')}${f('etaPostalCode', 'الرمز البريدي (اختياري)', 'text', 'dir="ltr"')}</div>`
        + `<h4 class="mt-4 mb-2"><i class="fas fa-tags text-primary"></i> الأصناف</h4>` + h.row('نوع كود الصنف الافتراضي', 'EGS: كود داخلي مسجّل على المنظومة (EG-RIN-الكود) · GS1: الباركود الدولي', sel('etaItemType', [['EGS', 'EGS'], ['GS1', 'GS1']])) + h.row('وحدة القياس الافتراضية', 'كود وحدة المنظومة (EA قطعة)', h.inp('etaDefaultUnit', s.etaDefaultUnit, 'text', 'dir="ltr" style="max-width:120px"')) + h.row('وحدة الأصناف الموزونة', 'للأصناف بالكيلو (KGM)', h.inp('etaWeightUnit', s.etaWeightUnit, 'text', 'dir="ltr" style="max-width:120px"')) + h.row('حد إلزام بيانات المشتري', 'إيصال بقيمة ≥ هذا المبلغ يحتاج الرقم القومي للمشتري', h.inp('etaBuyerIdThreshold', s.etaBuyerIdThreshold, 'number', 'min="0" step="any"'))
        + `<div class="form-group mt-2"><div class="flex gap-2 flex-wrap items-end"><input id="eta-pq" placeholder="ابحث عن صنف بالاسم أو الكود أو الباركود…" class="flex-1"><button type="button" class="btn btn-sm btn-outline" id="eta-gen">توليد أكواد EGS للأصناف الفارغة</button></div><div class="text-xs muted mt-1">كود الصنف ووحدة القياس يُحفظان على الصنف فور التعديل. الفارغ يستخدم الافتراضي.</div><div class="table-wrap mt-2" style="max-height:340px;overflow:auto"><table class="table table-compact"><thead><tr><th>الصنف</th><th>الباركود</th><th style="width:230px">كود الصنف في المنظومة</th><th style="width:110px">الوحدة</th></tr></thead><tbody id="eta-pt"></tbody></table></div></div>`
        + `<h4 class="mt-4 mb-2"><i class="fas fa-link text-primary"></i> عناوين الخوادم (قابلة للتعديل)</h4><div class="form-row cols-2">${f('etaIdUrlPreprod', 'Identity — تجريبي', 'url', 'dir="ltr"')}${f('etaApiUrlPreprod', 'API — تجريبي', 'url', 'dir="ltr"')}${f('etaIdUrlProd', 'Identity — فعلي', 'url', 'dir="ltr"')}${f('etaApiUrlProd', 'API — فعلي', 'url', 'dir="ltr"')}${f('etaShareUrlPreprod', 'رابط QR — تجريبي', 'text', 'dir="ltr"')}${f('etaShareUrlProd', 'رابط QR — فعلي', 'text', 'dir="ltr"')}</div><div class="text-xs muted">رأس السلسلة (previousUUID): <span class="num">${h.e(st.chainHead || '—')}</span></div>`;
    },
    bind(body, h) {
      const $b = id => u.$('#' + id, body);
      const drawProducts = () => { const q = ($b('eta-pq').value || '').trim(); const rows = P().all().filter(p => p.active !== false && (!q || u.match(p.name, q) || u.match(p.code, q) || (p.barcode || '').includes(q))).slice(0, 150); $b('eta-pt').innerHTML = rows.map(p => `<tr><td>${e(p.name)}<div class="text-xs muted num">${e(p.code || '')}</div></td><td class="num text-sm">${e(p.barcode || '')}</td><td><input data-pid="${e(p.id)}" data-f="etaItemCode" value="${e(p.etaItemCode || '')}" placeholder="${e(itemCode({}, ERP.settings.all(), p.code || p.id, p.barcode))}" dir="ltr" style="min-height:30px;padding:.2rem .4rem"></td><td><input data-pid="${e(p.id)}" data-f="etaUnitType" value="${e(p.etaUnitType || '')}" placeholder="${e(unitType({ unitId: p.unitId }, ERP.settings.all()))}" dir="ltr" style="min-height:30px;padding:.2rem .4rem"></td></tr>`).join('') || '<tr><td colspan="4" class="muted text-center">لا أصناف</td></tr>'; };
      drawProducts(); $b('eta-pq').oninput = u.debounce(drawProducts, 200);
      $b('eta-pt').addEventListener('change', ev => { const t = ev.target; if (!t.dataset.pid) return; P().update(t.dataset.pid, { [t.dataset.f]: t.value.trim() }); ERP.ui.toast('تم الحفظ على الصنف', 'success', { duration: 1200 }); });
      $b('eta-gen').onclick = async () => { const s = ERP.settings.all(); if (!s.etaRin) return ERP.ui.warn('أدخل رقم التسجيل الضريبي (RIN) واحفظ أولاً'); const list = P().all().filter(p => !p.etaItemCode && p.code); if (!list.length) return ERP.ui.info('كل الأصناف لها أكواد'); if (!await ERP.ui.confirm(`توليد كود EGS لعدد ${list.length} صنف بصيغة EG-${e(s.etaRin)}-الكود؟ (يجب تسجيل نفس الأكواد على بوابة المنظومة)`)) return; list.forEach(p => P().update(p.id, { etaItemCode: `EG-${s.etaRin}-${p.code}` }, { silent: true })); ERP.bus.emit('db:change', { collection: 'products', op: 'bulk' }); drawProducts(); ERP.ui.success('تم'); };
      $b('eta-export').onclick = () => { const n = exportQueued(); if (n) ERP.ui.success(`تم تصدير ${n} إيصال`); };
      $b('eta-retry').onclick = () => { let n = 0; Q().all().filter(q => q.status === 'error').forEach(q => { mark(q, { status: 'queued', attempts: 0, nextAt: 0, error: '' }); n++; }); ERP.ui.success(`أُعيدت ${n} للانتظار`); h.rerender(); };
      $b('eta-test').onclick = async () => { try { await token(true); ERP.ui.success('تم الاتصال بنجاح وتم استلام رمز الدخول ✓'); } catch (err) { ERP.ui.error(err.message); } };
      $b('eta-run').onclick = async () => { const b = $b('eta-run'); b.disabled = true; try { const r = await run({ force: true }); if (r.skipped) ERP.ui.warn(worker.lastError || 'الإرسال غير متاح (فعّل الخدمة وأكمل الإعدادات)'); else ERP.ui.success(`مقبول ${r.accepted} · مرفوض ${r.rejected}`); } catch (err) { ERP.ui.error(err.message); } finally { b.disabled = false; h.rerender(); } };
    },
    save(patch) { if ('etaRin' in patch) patch.etaRin = u.normalizeDigits(patch.etaRin).replace(/\s/g, ''); if ('etaCountry' in patch) patch.etaCountry = String(patch.etaCountry || 'EG').toUpperCase(); tok = null; },
  });
})();
