/* ==========================================================================
   ERP.hardware — retail hardware
   - scale: serial-port scale via the Web Serial API (Chromium / Electron —
     desktop/main.js [hw] grants the permission and picks the saved port).
     Configurable parser: continuous stream or request byte(s) ('W', ENQ 0x05 …),
     weight extracted by a default heuristic or a custom regex, kg / g / lb,
     stability flag (ST/US …) when present, reversed-digit indicators (XK3190-A9).
     readWeight() → kg (timeout), onLive(fn) for a live display.
   - labels: raw ZPL (Zebra) / TSPL (TSC, Xprinter, Gprinter …) label printing.
     Text (Arabic) is rendered to a monochrome bitmap in a canvas and sent as
     ^GFA (ZPL) / BITMAP (TSPL); the barcode uses the printer's native command
     (crisp bars). Sent through desktop IPC 'raw-print' to \\host\share or
     COM/LPT (same allowlist as the cash drawer); in the browser a .prn file is
     downloaded instead. Type 'html' (default) keeps the normal print dialog.
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  const u = ERP.utils; const e = u.escapeHtml;
  ERP.settings.extend({
    hwScaleEnabled: false, hwScalePreset: 'generic', hwScaleBaud: 9600, hwScaleDataBits: 8, hwScaleParity: 'none', hwScaleStopBits: 1,
    hwScaleMode: 'continuous', hwScaleRequest: '', hwScaleRegex: '', hwScaleUnit: 'auto', hwScaleReverse: false, hwScaleRequireStable: true,
    hwScaleTimeoutMs: 3000, hwScaleAutoRead: false, hwScalePortInfo: null,
    hwLabelType: 'html', hwLabelTarget: '', hwLabelWidthMm: 40, hwLabelHeightMm: 25, hwLabelDpi: 203, hwLabelDarkness: 10, hwLabelGapMm: 2, hwLabelSpeed: 4, hwLabelFlip: false,
  });
  const S = () => ERP.settings.all();

  /* ---------------- scale: presets + parser (pure) ---------------- */
  const PRESETS = {
    generic: { label: 'عام — بث مستمر (أغلب الموازين الصينية ACS / JCS)', mode: 'continuous', baud: 9600, dataBits: 8, parity: 'none', stopBits: 1, request: '', unit: 'auto', reverse: false },
    cas: { label: 'CAS (PR / ER / PDN / AP) — «ST,GS,+  1.235kg»', mode: 'continuous', baud: 9600, dataBits: 8, parity: 'none', stopBits: 1, request: '', unit: 'auto', reverse: false },
    a9: { label: 'مؤشر XK3190-A9 / A12 (=أرقام معكوسة)', mode: 'continuous', baud: 9600, dataBits: 8, parity: 'none', stopBits: 1, request: '', unit: 'kg', reverse: true },
    toledo: { label: 'Mettler Toledo 8217 — طلب «W»', mode: 'request', baud: 9600, dataBits: 7, parity: 'even', stopBits: 1, request: 'W', unit: 'kg', reverse: false },
    enq: { label: 'طلب ENQ (0x05) — Dibal / ACLAS / DIGI / Rongta', mode: 'request', baud: 9600, dataBits: 8, parity: 'none', stopBits: 1, request: '\\x05', unit: 'auto', reverse: false },
    custom: { label: 'مخصص (يدوي)' },
  };
  /** "W\r" / "\x05" / "<ENQ>" → byte string */
  function unescape(s) {
    return String(s || '').replace(/<ENQ>/gi, '\x05').replace(/<STX>/gi, '\x02').replace(/<ETX>/gi, '\x03').replace(/<CR>/gi, '\r').replace(/<LF>/gi, '\n')
      .replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\r/g, '\r').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  }
  const toBytes = s => Uint8Array.from(String(s), c => c.charCodeAt(0) & 255);
  const toStr = b => typeof b === 'string' ? b : Array.from(b || [], c => String.fromCharCode(c)).join('');
  function scaleConfig(over = {}) {
    const s = S(); const pr = PRESETS[s.hwScalePreset] && s.hwScalePreset !== 'custom' ? PRESETS[s.hwScalePreset] : {};
    const c = { mode: s.hwScaleMode || pr.mode || 'continuous', baud: u.num(s.hwScaleBaud, pr.baud || 9600), dataBits: u.num(s.hwScaleDataBits, 8), parity: s.hwScaleParity || 'none', stopBits: u.num(s.hwScaleStopBits, 1), request: s.hwScaleRequest ?? pr.request ?? '', regex: s.hwScaleRegex || '', unit: s.hwScaleUnit || 'auto', reverse: !!s.hwScaleReverse, requireStable: s.hwScaleRequireStable !== false, timeout: u.num(s.hwScaleTimeoutMs, 3000) };
    return { ...c, ...over };
  }
  /** one frame (text between CR/LF/ETX) → { kg, stable (true|false|null), raw } | null */
  function parseFrame(frame, cfg = {}) {
    const raw = String(frame || ''); const s = raw.replace(/[\x00-\x1f\x7f]/g, ' ');
    if (!s.trim()) return null;
    let stable = null;
    if (/(^|[^A-Z])(US|UNST|UNSTABLE|MOTION)([^A-Z]|$)|\?/i.test(s)) stable = false;
    else if (/(^|[^A-Z])(ST|STAB|STABLE)([^A-Z]|$)/i.test(s)) stable = true;
    let num = null, unit = '', sign = '';
    if (cfg.regex) {
      let re; try { re = new RegExp(cfg.regex, 'i'); } catch { return null; }
      const m = re.exec(s); if (!m) return null;
      num = (m.groups && m.groups.w) ?? m[1]; unit = (m.groups && m.groups.u) ?? m[2] ?? '';
      if (num == null) return null; num = String(num).replace(/\s+/g, ''); if (num.startsWith('-')) { sign = '-'; num = num.slice(1); } else if (num.startsWith('+')) num = num.slice(1);
    } else if (cfg.reverse) {
      const m = /=\s*([-0-9.]+)/.exec(s); if (!m) return null;
      num = m[1].split('').reverse().join(''); if (num.endsWith('-')) { sign = '-'; num = num.slice(0, -1); }
    } else {
      const re = /([+-]?)\s*(\d+(?:\.\d+)?)\s*(kg|g|lb|oz)?\b/gi; let m, pick = null;
      while ((m = re.exec(s))) { if (m[3]) { pick = m; break; } pick = m; }
      if (!pick) return null; sign = pick[1] === '-' ? '-' : ''; num = pick[2]; unit = pick[3] || '';
    }
    let v = Number(String(num).replace(',', '.')); if (!Number.isFinite(v)) return null;
    const un = String(unit || cfg.unit || 'auto').toLowerCase();
    if (un === 'g') v /= 1000; else if (un === 'lb') v *= 0.45359237; else if (un === 'oz') v *= 0.028349523;
    if (sign === '-') v = -v;
    return { kg: u.round(v, 3), stable, raw: s.trim() };
  }
  /** streaming parser: push(bytes|string) → readings found in the complete frames so far */
  function createParser(cfg = {}) {
    let buf = '';
    return {
      push(chunk) {
        buf += toStr(chunk); if (buf.length > 8192) buf = buf.slice(-1024);
        let frames;
        if (cfg.reverse && !/[\r\n\x03]/.test(buf)) { const p = buf.split('='); buf = '=' + p.pop(); frames = p.filter(Boolean).map(x => '=' + x); } // A9 streams "=…=…" without CR/LF
        else { frames = buf.split(/[\r\n\x03]+/); buf = frames.pop(); }
        return frames.map(f => parseFrame(f, cfg)).filter(Boolean);
      },
      reset() { buf = ''; },
    };
  }

  /* ---------------- scale: Web Serial connection ---------------- */
  const scale = {
    PRESETS, parseFrame, createParser, unescape, config: scaleConfig,
    port: null, reader: null, parser: null, last: null, prev: null, listeners: new Set(), keep: false,
    supported() { return typeof navigator !== 'undefined' && !!navigator.serial; },
    enabled() { return !!S().hwScaleEnabled; },
    available() { return scale.enabled() && scale.supported(); },
    connected() { return !!(scale.port && scale.keep); },
    portLabel() { const i = S().hwScalePortInfo; return i ? `USB ${Number(i.usbVendorId || 0).toString(16).padStart(4, '0')}:${Number(i.usbProductId || 0).toString(16).padStart(4, '0')}` : 'غير محدد'; },
    async prefer() { if (window.desktop && window.desktop.hwSerialPrefer) { try { await window.desktop.hwSerialPrefer(S().hwScalePortInfo || null); } catch { /* old desktop shell */ } } },
    /** browser: the Chromium picker (needs a click); Electron: main [hw] picks the saved port or asks via IPC */
    async choosePort() {
      if (!scale.supported()) throw new Error('المتصفح لا يدعم المنافذ التسلسلية (Web Serial) — استخدم Chrome / Edge أو تطبيق سطح المكتب');
      await scale.prefer();
      const port = await navigator.serial.requestPort({});
      const info = port.getInfo ? port.getInfo() : {}; ERP.settings.set({ hwScalePortInfo: info && (info.usbVendorId || info.usbProductId) ? { usbVendorId: info.usbVendorId, usbProductId: info.usbProductId } : null });
      return port;
    },
    async findPort() {
      if (!scale.supported()) return null;
      const ports = await navigator.serial.getPorts(); const want = S().hwScalePortInfo;
      if (want) { const hit = ports.find(p => { const i = p.getInfo ? p.getInfo() : {}; return i.usbVendorId === want.usbVendorId && i.usbProductId === want.usbProductId; }); if (hit) return hit; }
      return ports.length === 1 ? ports[0] : null;
    },
    async connect({ ask = false } = {}) {
      if (scale.connected()) return scale.port;
      if (!scale.supported()) throw new Error('المتصفح لا يدعم المنافذ التسلسلية (Web Serial) — استخدم Chrome / Edge أو تطبيق سطح المكتب');
      let port = await scale.findPort();
      if (!port && (ask || window.desktop)) port = await scale.choosePort();
      if (!port) throw new Error('لم يتم اختيار منفذ الميزان — الإعدادات ← الأجهزة ← اختيار المنفذ');
      const c = scaleConfig();
      try { await port.open({ baudRate: c.baud, dataBits: c.dataBits, parity: c.parity, stopBits: c.stopBits, bufferSize: 4096 }); }
      catch (err) { if (!/already open/i.test(err.message)) throw new Error('تعذّر فتح منفذ الميزان: ' + err.message); }
      scale.port = port; scale.keep = true; scale.parser = createParser(c); scale.last = scale.prev = null;
      scale.loop(port);
      return port;
    },
    async loop(port) {
      while (scale.keep && scale.port === port && port.readable) {
        const reader = port.readable.getReader(); scale.reader = reader;
        try {
          for (;;) {
            const { value, done } = await reader.read(); if (done) break;
            scale.parser.push(value).forEach(r => { scale.prev = scale.last; scale.last = { ...r, at: Date.now() }; scale.listeners.forEach(fn => { try { fn(scale.last); } catch { /* listener */ } }); });
          }
        } catch (err) { console.warn('[hw] scale read', err.message); if (/lost|disconnected|device has been/i.test(err.message)) scale.keep = false; }
        finally { try { reader.releaseLock(); } catch { /* */ } scale.reader = null; }
      }
    },
    async disconnect() {
      scale.keep = false; const p = scale.port; scale.port = null;
      try { if (scale.reader) await scale.reader.cancel(); } catch { /* */ }
      try { if (p) await p.close(); } catch { /* */ }
    },
    async write(str) { if (!scale.port || !scale.port.writable) return; const w = scale.port.writable.getWriter(); try { await w.write(toBytes(unescape(str))); } finally { w.releaseLock(); } },
    onLive(fn) { scale.listeners.add(fn); return () => scale.listeners.delete(fn); },
    /** accept a reading: flagged stable, or (no flag in the protocol) two identical consecutive readings */
    isStable(r, prev) { return r.stable === true || (r.stable === null && !!prev && prev.kg === r.kg); },
    /** → kg (> 0). Rejects on timeout / zero / negative weight */
    async readWeight({ timeout, requireStable } = {}) {
      await scale.connect();
      const c = scaleConfig(); const ms = u.num(timeout, c.timeout) || 3000; const needStable = requireStable ?? c.requireStable;
      return new Promise((resolve, reject) => {
        let prev = null, lastSeen = null, timer = null, poll = null;
        const finish = (err, kg) => { clearTimeout(timer); clearInterval(poll); off(); err ? reject(err) : resolve(kg); };
        const off = scale.onLive(r => {
          lastSeen = r; const ok = !needStable || (r.stable !== false && scale.isStable(r, prev)); prev = r;
          if (ok && r.kg > 0) finish(null, r.kg);
        });
        timer = setTimeout(() => finish(new Error(lastSeen ? (lastSeen.kg <= 0 ? 'الميزان يقرأ صفر — ضع الصنف على الميزان' : 'الوزن غير مستقر — انتظر ثبات الميزان وأعد المحاولة') : 'لا توجد قراءة من الميزان — تأكد من التوصيل وإعدادات المنفذ')), ms);
        if (c.mode === 'request' && c.request) { const send = () => scale.write(c.request).catch(() => { }); send(); poll = setInterval(send, 400); }
      });
    },
  };

  /** products sold by weight: scale PLU set, or a base unit that accepts decimals (كجم / جم / لتر) */
  function isWeighed(p) { if (!p) return false; if (p.scalePlu) return true; const un = p.unitId && ERP.db.collection('units').get(p.unitId); return !!(un && un.decimal); }
  /* POS helpers */
  scale.autoFor = p => scale.available() && !!S().hwScaleAutoRead && isWeighed(p);
  scale.showButton = (p, line) => scale.available() && isWeighed(p) && !(line && u.num(line.factor, 1) > 1);
  scale.posRead = async () => { try { ERP.ui.info('جاري قراءة الوزن من الميزان…', { duration: 1200 }); const kg = await scale.readWeight(); return kg; } catch (err) { ERP.ui.beep && ERP.ui.beep('err'); ERP.ui.warn(err.message); return null; } };

  /* Electron: when several serial ports exist and none matches the saved one, main [hw] asks the page to pick */
  function portPicker(d) {
    return new Promise(resolve => {
      const ports = (d && d.ports) || [];
      const h = ERP.ui.modal({ title: 'اختر منفذ الميزان', icon: 'weight-scale', size: 'sm', body: `<select id="hw-pp" style="width:100%">${ports.map(p => `<option value="${e(p.portId)}">${e(p.displayName || p.portName || p.portId)}${p.portName ? ` (${e(p.portName)})` : ''}</option>`).join('')}</select>`, footer: `<button class="btn" data-a="c">إلغاء</button><button class="btn btn-primary" data-a="ok">اختيار</button>`, onClose: () => resolve('') });
      h.$('[data-a=c]').onclick = () => h.close();
      h.$('[data-a=ok]').onclick = () => { const v = h.$('#hw-pp').value; resolve(v); h.close(); };
    });
  }
  if (window.desktop && window.desktop.onSerialChoose) { try { window.desktop.onSerialChoose(portPicker); } catch { /* */ } }

  /* ---------------- label printers: ZPL / TSPL ---------------- */
  const dots = (mm, dpi) => Math.round(u.num(mm) * u.num(dpi, 203) / 25.4);
  function eanOk(code) { const d = code.split('').map(Number), chk = d.pop(); const sum = d.reverse().reduce((a, n, i) => a + n * (i % 2 ? 1 : 3), 0); return (10 - (sum % 10)) % 10 === chk; }
  function labelSpec(over = {}) {
    const s = S(); const c = { type: s.hwLabelType || 'html', target: String(s.hwLabelTarget || '').trim(), widthMm: u.num(s.hwLabelWidthMm, 40), heightMm: u.num(s.hwLabelHeightMm, 25), dpi: u.num(s.hwLabelDpi, 203) === 300 ? 300 : 203, darkness: u.clamp(Math.round(u.num(s.hwLabelDarkness, 10)), 0, 30), gapMm: u.num(s.hwLabelGapMm, 2), speed: u.clamp(Math.round(u.num(s.hwLabelSpeed, 4)), 1, 14), flip: !!s.hwLabelFlip, ...over };
    c.W = dots(c.widthMm, c.dpi); c.H = dots(c.heightMm, c.dpi); c.bpr = Math.ceil(c.W / 8);
    return c;
  }
  /** native barcode placement: EAN-13 when the check digit is valid, otherwise Code 128 (ASCII only) */
  function barcodeFor(code, spec) {
    let v = String(code || '').trim(); const ean = /^\d{13}$/.test(v) && eanOk(v);
    if (!ean) v = v.replace(/[^\x20-\x7e]/g, '').replace(/[\^~"\\]/g, '');
    if (!v) return null;
    const mods = ean ? 95 : (/^\d+$/.test(v) && v.length >= 4 ? (Math.ceil(v.length / 2) + 3) * 11 + 2 : (v.length + 3) * 11 + 2);
    const module = u.clamp(Math.floor((spec.W - 16) / mods), 1, 4);
    const h = Math.max(20, Math.round(spec.H * 0.22));
    return { type: ean ? 'EAN13' : 'CODE128', data: ean ? v.slice(0, 12) : v, full: v, module, h, x: Math.max(0, Math.round((spec.W - mods * module) / 2)), y: Math.round(spec.H * 0.40) };
  }
  /** text part of a label → monochrome bitmap { width, height, bpr, bits (1 = black) } via canvas */
  function renderBitmap(item, spec) {
    const W = spec.W, H = spec.H, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); ctx.fillStyle = '#000'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; try { ctx.direction = 'rtl'; } catch { /* */ }
    const font = (px, w = 700) => `${w} ${Math.max(8, Math.round(px))}px Cairo, Tahoma, 'Segoe UI', Arial, sans-serif`;
    const fit = (text, px, maxW, w) => { let sz = px; ctx.font = font(sz, w); while (sz > 9 && ctx.measureText(text).width > maxW) { sz -= 1; ctx.font = font(sz, w); } return sz; };
    const s = S(); const p = item.product || {}; let top = 2;
    if (item.clearance) { // black band, white «تصفية» text (the red label of the HTML version)
      const bh = Math.round(H * 0.17); ctx.fillRect(0, 0, W, bh); ctx.fillStyle = '#fff'; const t = `تصفية${item.clearanceText ? ' — ' + item.clearanceText : ''}`; fit(t, bh * 0.75, W - 8); ctx.fillText(t, W / 2, bh / 2 + 1); ctx.fillStyle = '#000'; top = bh + 2;
    }
    const nameH = Math.round(H * 0.40) - top - 2; const name = String(p.name || '');
    let sz = fit(name, Math.min(nameH * 0.9, H * 0.16), W - 8);
    if (ctx.measureText(name).width > W - 8 || sz < H * 0.1) { // two lines
      const words = name.split(/\s+/); let a = '', b = ''; words.forEach(w => { if (!b && ctx.measureText((a ? a + ' ' : '') + w).width <= W - 8) a = (a ? a + ' ' : '') + w; else b = (b ? b + ' ' : '') + w; });
      sz = Math.min(fit(a, nameH * 0.48, W - 8), fit(b, nameH * 0.48, W - 8)); ctx.font = font(sz); ctx.fillText(a, W / 2, top + nameH * 0.27); ctx.fillText(b, W / 2, top + nameH * 0.75);
    } else ctx.fillText(name, W / 2, top + nameH / 2);
    const py = Math.round(H * 0.87), cur = s.currency || '', price = `${u.fmtNum(item.price ?? p.price)} ${cur}${item.unitName ? ' / ' + item.unitName : ''}`;
    if (item.oldPrice) {
      const old = u.fmtNum(item.oldPrice); const osz = fit(old, H * 0.12, W * 0.3, 600); const ow = ctx.measureText(old).width; ctx.textAlign = 'left'; ctx.fillText(old, 4, py); ctx.fillRect(4, py - 1, ow, Math.max(2, Math.round(osz / 9)));
      ctx.textAlign = 'center'; fit(price, H * 0.2, W * 0.64, 800); ctx.fillText(price, W * 0.64, py);
    } else { fit(price, H * 0.21, W - 8, 800); ctx.fillText(price, W / 2, py); }
    const img = ctx.getImageData(0, 0, W, H).data; const bpr = Math.ceil(W / 8); const bits = new Uint8Array(bpr * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; if (img[i] * 0.299 + img[i + 1] * 0.587 + img[i + 2] * 0.114 < 140) bits[y * bpr + (x >> 3)] |= 0x80 >> (x & 7); }
    return { width: W, height: H, bpr, bits };
  }
  const hex = bits => { let s = ''; for (let i = 0; i < bits.length; i++) s += (bits[i] < 16 ? '0' : '') + bits[i].toString(16).toUpperCase(); return s; };
  const copies = it => Math.max(1, Math.floor(u.num(it.qty, 1)));
  /** ZPL II (Zebra): ^GFA bitmap for the text + native ^BE / ^BC barcode. opts.bitmap(item, spec) overrides the canvas renderer */
  function buildZpl(items, { spec = labelSpec(), bitmap = renderBitmap } = {}) {
    return items.map(it => {
      const bm = bitmap(it, spec); const total = bm.bpr * bm.height; const bc = barcodeFor(it.barcode || (it.product && (it.product.barcode || it.product.code)), spec);
      const bar = !bc ? '' : bc.type === 'EAN13' ? `^FO${bc.x},${bc.y}^BY${bc.module}^BEN,${bc.h},Y,N^FD${bc.data}^FS` : `^FO${bc.x},${bc.y}^BY${bc.module}^BCN,${bc.h},Y,N,N,A^FD${bc.data}^FS`;
      return `~SD${String(spec.darkness).padStart(2, '0')}\n^XA^CI28^PW${spec.W}^LL${spec.H}^LH0,0${spec.flip ? '^POI' : '^PON'}\n^FO0,0^GFA,${total},${total},${bm.bpr},${hex(bm.bits)}^FS\n${bar}\n^PQ${copies(it)}\n^XZ\n`;
    }).join('');
  }
  /** TSPL (TSC / Xprinter / Gprinter): binary BITMAP (bit 0 = black, so the bitmap is inverted) + native BARCODE → Uint8Array */
  function buildTspl(items, { spec = labelSpec(), bitmap = renderBitmap } = {}) {
    const enc = s => toBytes(s); const parts = [];
    items.forEach(it => {
      const bm = bitmap(it, spec); const bc = barcodeFor(it.barcode || (it.product && (it.product.barcode || it.product.code)), spec);
      parts.push(enc(`SIZE ${spec.widthMm} mm,${spec.heightMm} mm\r\nGAP ${spec.gapMm} mm,0 mm\r\nDIRECTION ${spec.flip ? 0 : 1}\r\nREFERENCE 0,0\r\nDENSITY ${Math.round(spec.darkness / 2)}\r\nSPEED ${spec.speed}\r\nCLS\r\nBITMAP 0,0,${bm.bpr},${bm.height},0,`));
      const inv = new Uint8Array(bm.bits.length); for (let i = 0; i < inv.length; i++) inv[i] = ~bm.bits[i] & 255; parts.push(inv);
      parts.push(enc(`\r\n${bc ? `BARCODE ${bc.x},${bc.y},"${bc.type === 'EAN13' ? 'EAN13' : '128'}",${bc.h},1,0,${bc.module},${bc.module},"${bc.data}"\r\n` : ''}PRINT 1,${copies(it)}\r\n`));
    });
    const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0; parts.forEach(p => { out.set(p, o); o += p.length; });
    return out;
  }
  const labels = {
    spec: labelSpec, barcodeFor, renderBitmap, buildZpl, buildTspl, dots,
    type() { return S().hwLabelType || 'html'; },
    /** raw printer configured (ZPL / TSPL) → print.js sends raw commands instead of the HTML dialog */
    enabled() { return ['zpl', 'tspl'].includes(labels.type()); },
    build(items, opts = {}) { const spec = opts.spec || labelSpec(); return spec.type === 'tspl' ? { bytes: buildTspl(items, { ...opts, spec }), ext: 'prn' } : { bytes: toBytes(unescapeNone(buildZpl(items, { ...opts, spec }))), ext: 'zpl' }; },
    async print(items, opts = {}) {
      if (!items || !items.length) return { ok: false, err: 'no items' };
      const spec = labelSpec(opts.spec); const { bytes, ext } = labels.build(items, { spec });
      if (window.desktop && window.desktop.rawPrint && spec.target) {
        const r = await window.desktop.rawPrint(spec.target, bytes);
        if (r && r.ok) ERP.ui.success(`تم إرسال ${u.sum(items, copies)} ملصق للطابعة (${spec.type.toUpperCase()})`); else ERP.ui.error('فشل إرسال الملصقات للطابعة: ' + ((r && r.err) || 'غير معروف'));
        return r || { ok: false };
      }
      u.downloadBlob(new Blob([bytes], { type: 'application/octet-stream' }), `labels-${u.todayISO()}.${ext}`);
      ERP.ui.info(window.desktop ? 'لم يُحدد مسار طابعة الملصقات — تم تنزيل ملف الأوامر' : 'تم تنزيل ملف أوامر الطابعة (.' + ext + ') — أرسله للطابعة مثل: copy /b الملف \\\\PC\\Printer');
      return { ok: true, downloaded: true, bytes: bytes.length };
    },
    test() { const p = ERP.db.collection('products').all().find(x => x.barcode) || { name: 'صنف تجريبي — اختبار', price: 12.5, barcode: '6221234567890' }; return labels.print([{ product: p, qty: 1 }]); },
  };
  function unescapeNone(s) { return String(s).replace(/[^\x00-\xff]/g, '?'); } // ZPL text is ASCII only (Arabic goes in the bitmap)

  ERP.hardware = { scale, labels, isWeighed };

  /* reconnect with the new port settings after they change */
  if (ERP.bus) ERP.bus.on('settings:change', () => { if (scale.connected()) scale.disconnect(); });

  /* ---------------- settings section «الأجهزة» ---------------- */
  ERP.settingsSections = ERP.settingsSections || [];
  ERP.settingsSections.push({
    id: 'hardware', icon: 'weight-scale', label: 'الأجهزة (ميزان وملصقات)',
    render(s, h) {
      const sel = (name, val, opts) => `<select name="${name}">${opts.map(([v, l]) => `<option value="${h.e(v)}" ${String(val) === String(v) ? 'selected' : ''}>${h.e(l)}</option>`).join('')}</select>`;
      return `<h4 class="mb-2"><i class="fas fa-weight-scale text-primary"></i> الميزان (منفذ تسلسلي COM / USB)</h4>
        ${scale.supported() ? '' : '<div class="alert alert-warning mb-2"><i class="fas fa-triangle-exclamation"></i> هذا المتصفح لا يدعم Web Serial — استخدم Chrome / Edge (على localhost أو https) أو تطبيق سطح المكتب.</div>'}
        ${h.row('تفعيل الميزان', 'يظهر زر «⚖ وزن» على أصناف الوزن في نقطة البيع (الأصناف ذات كود ميزان PLU أو وحدة تقبل الكسور)', h.sw('hwScaleEnabled', s.hwScaleEnabled))}
        ${h.row('نوع الميزان', 'قالب جاهز يملأ الإعدادات أدناه — البروتوكولات تختلف، راجع دليل الميزان', `<select name="hwScalePreset" id="hw-preset">${Object.entries(PRESETS).map(([k, p]) => `<option value="${k}" ${s.hwScalePreset === k ? 'selected' : ''}>${h.e(p.label)}</option>`).join('')}</select>`)}
        ${h.row('المنفذ', `المحفوظ: <span class="num" id="hw-port-lbl">${h.e(scale.portLabel())}</span>`, `<button type="button" class="btn btn-sm btn-outline" id="hw-port"><i class="fas fa-plug"></i> اختيار المنفذ</button>`)}
        ${h.row('السرعة (Baud)', '', sel('hwScaleBaud', s.hwScaleBaud, [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200].map(x => [x, x])))}
        ${h.row('بتات البيانات / التماثل / بت التوقف', '', `<div class="flex gap-2">${sel('hwScaleDataBits', s.hwScaleDataBits, [[8, '8'], [7, '7']])}${sel('hwScaleParity', s.hwScaleParity, [['none', 'بدون'], ['even', 'زوجي Even'], ['odd', 'فردي Odd']])}${sel('hwScaleStopBits', s.hwScaleStopBits, [[1, '1'], [2, '2']])}</div>`)}
        ${h.row('طريقة القراءة', 'بث مستمر: الميزان يرسل الوزن باستمرار — طلب: يُرسل البرنامج أمراً ويرد الميزان', sel('hwScaleMode', s.hwScaleMode, [['continuous', 'بث مستمر'], ['request', 'طلب / استجابة']]))}
        ${h.row('أمر الطلب', 'مثل W أو \\x05 (ENQ) أو W\\r — يُستخدم مع «طلب / استجابة»', h.inp('hwScaleRequest', s.hwScaleRequest, 'text', 'dir="ltr" style="max-width:140px"'))}
        ${h.row('تعبير استخراج الوزن (اختياري)', 'Regex: المجموعة الأولى = الرقم، الثانية = الوحدة. اتركه فارغاً للاكتشاف التلقائي', h.inp('hwScaleRegex', s.hwScaleRegex, 'text', 'dir="ltr" placeholder="([\\d.]+)\\s*(kg|g)"'))}
        ${h.row('وحدة الأرقام بدون وحدة', '', sel('hwScaleUnit', s.hwScaleUnit, [['auto', 'تلقائي (كجم)'], ['kg', 'كجم'], ['g', 'جرام']]))}
        ${h.row('أرقام معكوسة (A9)', 'مؤشرات XK3190-A9 ترسل «=» ثم الأرقام بالعكس', h.sw('hwScaleReverse', s.hwScaleReverse))}
        ${h.row('انتظار ثبات الوزن', 'يقبل القراءة المعلَّمة ST أو قراءتين متطابقتين متتاليتين', h.sw('hwScaleRequireStable', s.hwScaleRequireStable))}
        ${h.row('مهلة القراءة (ملّي ثانية)', '', h.inp('hwScaleTimeoutMs', s.hwScaleTimeoutMs, 'number', 'min="500" step="100"'))}
        ${h.row('قراءة الوزن تلقائياً عند إضافة صنف وزن', 'عند الضغط على صنف وزن في نقطة البيع يُقرأ الوزن ويُضاف مباشرة (باركود الميزان المطبوع يعمل كما هو)', h.sw('hwScaleAutoRead', s.hwScaleAutoRead))}
        <div class="flex gap-2 items-center mt-2"><button type="button" class="btn btn-outline" id="hw-test"><i class="fas fa-weight-scale"></i> اختبار القراءة</button><span class="kpi-value num" id="hw-live" style="font-size:1.4rem">—</span><span class="text-xs muted num" id="hw-raw" dir="ltr"></span></div>
        <div class="divider"></div>
        <h4 class="mb-2"><i class="fas fa-barcode text-primary"></i> طابعة الملصقات</h4>
        ${h.row('نوع الطابعة', 'HTML: نافذة الطباعة العادية (الافتراضي) — ZPL: زيبرا — TSPL: TSC / Xprinter / Gprinter. النص العربي يُطبع كصورة والباركود بأمر الطابعة', sel('hwLabelType', s.hwLabelType, [['html', 'متصفح / HTML'], ['zpl', 'ZPL (Zebra)'], ['tspl', 'TSPL (TSC / Xprinter)']]))}
        ${h.row('مسار الطابعة', window.desktop ? 'طابعة مشاركة مثل \\\\localhost\\Zebra أو منفذ COM3 / LPT1' : 'في المتصفح يُنزَّل ملف .prn بدلاً من الإرسال المباشر', h.inp('hwLabelTarget', s.hwLabelTarget, 'text', 'dir="ltr" placeholder="\\\\localhost\\LABEL"'))}
        ${h.row('مقاس الملصق (مم)', 'العرض × الارتفاع', `<div class="flex gap-2">${h.inp('hwLabelWidthMm', s.hwLabelWidthMm, 'number', 'min="15" max="120" step="any" style="max-width:90px"')}<span>×</span>${h.inp('hwLabelHeightMm', s.hwLabelHeightMm, 'number', 'min="10" max="200" step="any" style="max-width:90px"')}</div>`)}
        ${h.row('الدقة (DPI)', '', sel('hwLabelDpi', s.hwLabelDpi, [[203, '203 (8 نقطة/مم)'], [300, '300 (12 نقطة/مم)']]))}
        ${h.row('درجة السواد', '0–30', h.inp('hwLabelDarkness', s.hwLabelDarkness, 'number', 'min="0" max="30"'))}
        ${h.row('الفراغ بين الملصقات (مم) / السرعة', 'TSPL', `<div class="flex gap-2">${h.inp('hwLabelGapMm', s.hwLabelGapMm, 'number', 'min="0" step="any" style="max-width:90px"')}${h.inp('hwLabelSpeed', s.hwLabelSpeed, 'number', 'min="1" max="14" style="max-width:90px"')}</div>`)}
        ${h.row('قلب اتجاه الطباعة 180°', '', h.sw('hwLabelFlip', s.hwLabelFlip))}
        <button type="button" class="btn btn-outline mt-2" id="hw-lbl-test"><i class="fas fa-print"></i> طباعة ملصق تجريبي</button> <span class="text-xs muted">احفظ الإعدادات أولاً</span>`;
    },
    bind(body) {
      const $ = sel => u.$(sel, body);
      const ps = $('#hw-preset'); if (ps) ps.onchange = () => { const p = PRESETS[ps.value]; if (!p || ps.value === 'custom') return; const set = (n, v) => { const x = body.querySelector(`[name="${n}"]`); if (!x) return; if (x.type === 'checkbox') x.checked = !!v; else x.value = v; }; set('hwScaleMode', p.mode); set('hwScaleBaud', p.baud); set('hwScaleDataBits', p.dataBits); set('hwScaleParity', p.parity); set('hwScaleStopBits', p.stopBits); set('hwScaleRequest', p.request); set('hwScaleUnit', p.unit); set('hwScaleReverse', p.reverse); };
      const pb = $('#hw-port'); if (pb) pb.onclick = async () => { try { await scale.disconnect(); await scale.choosePort(); $('#hw-port-lbl').textContent = scale.portLabel(); ERP.ui.success('تم اختيار المنفذ'); } catch (err) { if (err.name !== 'NotFoundError') ERP.ui.error(err.message); } };
      const tb = $('#hw-test'); if (tb) tb.onclick = async () => {
        const live = $('#hw-live'), raw = $('#hw-raw'); live.textContent = '…';
        try {
          await scale.connect({ ask: true }); $('#hw-port-lbl').textContent = scale.portLabel();
          const off = scale.onLive(r => { if (!live.isConnected) return off(); live.textContent = `${u.fmtNum(r.kg, 3)} كجم${r.stable === false ? ' ~' : ''}`; raw.textContent = r.raw.slice(0, 40); });
          setTimeout(off, 20000);
          const kg = await scale.readWeight(); live.textContent = `${u.fmtNum(kg, 3)} كجم ✓`;
        } catch (err) { live.textContent = '—'; ERP.ui.warn(err.message); }
      };
      const lt = $('#hw-lbl-test'); if (lt) lt.onclick = async () => { try { if (labels.enabled()) await labels.test(); else ERP.print.labels([{ product: ERP.db.collection('products').all()[0] || { name: 'صنف تجريبي', price: 10, barcode: '6221234567890' }, qty: 1 }], { previewOnly: true }); } catch (err) { ERP.ui.error(err.message); } };
    },
    save(patch) {
      ['hwScaleBaud', 'hwScaleDataBits', 'hwScaleStopBits', 'hwLabelDpi'].forEach(k => { if (k in patch) patch[k] = u.num(patch[k]); });
      if ('hwScaleTimeoutMs' in patch) patch.hwScaleTimeoutMs = Math.max(500, u.num(patch.hwScaleTimeoutMs, 3000));
      if ('hwScaleRegex' in patch && patch.hwScaleRegex) { try { new RegExp(patch.hwScaleRegex); } catch { ERP.ui.warn('تعبير استخراج الوزن غير صالح — تم تجاهله'); patch.hwScaleRegex = ''; } }
      if ('hwLabelDarkness' in patch) patch.hwLabelDarkness = u.clamp(Math.round(u.num(patch.hwLabelDarkness, 10)), 0, 30);
      if ('hwLabelWidthMm' in patch) patch.hwLabelWidthMm = u.clamp(u.num(patch.hwLabelWidthMm, 40), 15, 120);
      if ('hwLabelHeightMm' in patch) patch.hwLabelHeightMm = u.clamp(u.num(patch.hwLabelHeightMm, 25), 10, 200);
    },
  });
})();
