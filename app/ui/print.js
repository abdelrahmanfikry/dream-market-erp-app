/* ==========================================================================
   ERP.print — thermal receipts, A4 invoices, quotations, reports, labels
   Renders into a hidden iframe with print.css so app styles never leak.
   Brand identity: color from settings.brandColor, logo, contact, bank, QR.
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  const u = ERP.utils;
  const e = u.escapeHtml;
  let cssCache = null;
  const CSS_PATH = 'assets/css/print.css';
  const cssHref = () => { try { return new URL(CSS_PATH, document.baseURI).href; } catch { return CSS_PATH; } };
  /* minimal inline styles — used only when print.css text can't be read (file:// blocks fetch); the iframe/preview also <link> the real sheet */
  const FALLBACK_CSS = `*{box-sizing:border-box}body{margin:0;font-family:'Cairo','Segoe UI',Tahoma,Arial,sans-serif;color:#000;background:#fff;direction:rtl;font-size:12px;line-height:1.5}.num{font-family:'Segoe UI',Tahoma,Arial,sans-serif;direction:ltr;unicode-bidi:embed}h1,h2,h3,h4{margin:0}table{width:100%;border-collapse:collapse}@media print{.no-print{display:none!important}}
.receipt{width:76mm;margin:0 auto;padding:4mm 2mm;font-size:11px}.receipt .center{text-align:center}.receipt .r-logo{width:60px;height:60px;object-fit:contain;margin:0 auto 4px}.receipt .r-badge{width:52px;height:52px;margin:0 auto 4px;display:grid;place-items:center;border-radius:12px;background:var(--brand,#16a34a);color:#fff;font-size:20px;font-weight:800}.receipt .store{font-size:16px;font-weight:800;color:var(--brand,#16a34a)}.receipt .small,.receipt .contact,.receipt .slogan{font-size:9.5px;color:#333}.receipt .brand-line{height:2px;background:var(--brand,#16a34a);margin:7px 0}.receipt .doc-type{font-weight:800;text-align:center;font-size:12.5px;margin-bottom:6px}.receipt hr{border:0;border-top:1px dashed #000;margin:6px 0}.receipt table td,.receipt table th{padding:2px 0;font-size:10.5px;vertical-align:top}.receipt table th{border-bottom:1px solid #000;text-align:right}.receipt .tot .grand td{font-size:13.5px;font-weight:800;border-top:1px solid #000;padding-top:4px}.receipt .bank{border:1px solid #ccc;border-radius:6px;padding:5px 8px;margin:6px 0;font-size:9.5px;text-align:center}.receipt .qr{width:60px;height:60px;margin:4px auto;display:block}.receipt .thanks{margin-top:8px;font-weight:700}.promo{font-size:9px;font-weight:700}
.a4{width:210mm;min-height:297mm;margin:0 auto;padding:12mm 14mm 16mm}.a4-brand{height:5px;background:var(--brand,#16a34a);margin-bottom:10px}.doc-header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #111;padding-bottom:10px;margin-bottom:14px}.doc-brand{display:flex;gap:12px;align-items:center}.doc-brand .logo,.doc-brand .logo-img{width:56px;height:56px;border-radius:12px;object-fit:contain}.doc-brand .logo{background:var(--brand,#16a34a);color:#fff;display:grid;place-items:center;font-size:24px;font-weight:800}.doc-brand p{margin:0;font-size:11px}.doc-title{text-align:left}.doc-meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:10px 24px;margin-bottom:14px}.doc-meta .box{border:1px solid #dbe1ea;border-radius:8px;padding:8px 10px}.doc-meta .box p{margin:0}.doc-table th{background:#f1f3f6;border:1px solid #ccc;padding:6px 8px;text-align:right}.doc-table td{border:1px solid #ddd;padding:6px 8px}.doc-table td.num,.doc-table th.num{text-align:left}.doc-totals{display:flex;margin-top:12px}.doc-totals table{width:280px}.doc-totals td{padding:5px 8px;border-bottom:1px solid #eee}.doc-totals tr.grand td{font-size:15px;font-weight:800}.doc-footer{display:flex;justify-content:space-between;margin-top:16px;font-size:10px;color:#555}.summary-strip{display:flex;gap:8px;margin-bottom:10px}.summary-strip .cell{flex:1;border:1px solid #ddd;border-radius:6px;padding:6px}`;

  /** print.css as text (inlined, so it also works for the silent desktop print that loads a data: URL). null when unreadable. */
  async function getCss() {
    if (cssCache !== null) return cssCache || null;
    try { const r = await fetch(CSS_PATH); if (!r.ok) throw new Error(String(r.status)); cssCache = await r.text(); }
    catch {
      cssCache = '';
      try { const sh = [...document.styleSheets].find(x => x.href && x.href.endsWith(CSS_PATH)); if (sh) cssCache = [...sh.cssRules].map(r => r.cssText).join('\n'); } catch { /* cross-origin on file:// */ }
    }
    return cssCache || null;
  }
  /** <head> styles for the print iframe / preview: inline text when available, else fallback + <link> to the real sheet (absolute via baseURI, loads on file://) */
  function headStyles(css, extra = '') {
    return css ? `<style>${css}${extra}</style>` : `<style>${FALLBACK_CSS}${extra}</style><link rel="stylesheet" data-pcss href="${e(cssHref())}">`;
  }
  function waitLinks(doc, ms = 1500) {
    const links = [...doc.querySelectorAll("link[data-pcss]")].filter(l => !l.sheet);
    return Promise.race([Promise.all(links.map(l => new Promise(r => { l.onload = l.onerror = r; }))), u.sleep(ms)]);
  }

  /* ---- QR codes (rendered once into a data URL, never needs the DOM in the doc) ---- */
  const qrCache = new Map();
  function qrDataUrl(text, size = 120) {
    if (!text || typeof window.QRCode === 'undefined') return Promise.resolve('');
    const key = text + '|' + size;
    if (qrCache.has(key)) return Promise.resolve(qrCache.get(key));
    return new Promise(res => {
      try {
        const host = document.createElement('div');
        host.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden';
        document.body.appendChild(host);
        new window.QRCode(host, { text, width: size, height: size, colorDark: '#111111', colorLight: '#ffffff', correctLevel: window.QRCode.CorrectLevel ? window.QRCode.CorrectLevel.M : 1 });
        const img = host.querySelector('img'); const cv = host.querySelector('canvas');
        const url = img ? img.src : cv ? cv.toDataURL('image/png') : '';
        host.remove();
        if (!url) return res('');
        qrCache.set(key, url);
        res(url);
      } catch { res(''); }
    });
  }

  /* Logo on documents: the uploaded image, else an optional text badge (settings.logoBadge: none | initials | custom) */
  function logoMark(s, imgCls, badgeCls) {
    if (!s.receiptShowLogo) return '';
    if (s.logo) return `<img class="${imgCls}" src="${e(s.logo)}" alt="">`;
    const txt = s.logoBadge === 'initials' ? u.initials(s.storeName) : s.logoBadge === 'custom' ? String(s.logoText || '').trim() : '';
    return txt ? `<div class="${badgeCls}">${e(txt)}</div>` : '';
  }

  function storeHeader() {
    const s = ERP.settings.all();
    return `<div class="doc-brand">
      ${logoMark(s, 'logo-img', 'logo')}
      <div><h1>${e(s.storeName)}</h1>
        <p>${e(s.address || '')}${s.phone ? ' · ' + e(s.phone) : ''}</p>
        ${s.taxNumber ? `<p>الرقم الضريبي: <span class="num">${e(s.taxNumber)}</span></p>` : ''}
        ${s.commercialReg ? `<p>سجل تجاري: <span class="num">${e(s.commercialReg)}</span></p>` : ''}
        ${s.receiptShowContact && (s.whatsapp || s.email) ? `<p>${[s.whatsapp && 'واتساب: ' + e(s.whatsapp), s.email && e(s.email)].filter(Boolean).join(' · ')}</p>` : ''}</div></div>`;
  }

  function bankBox(s) {
    const vals = [
      s.bankName && ('بنك: ' + e(s.bankName)),
      s.bankAccount && ('حساب: <span class="num">' + e(s.bankAccount) + '</span>'),
      s.bankIban && ('IBAN: <span class="num">' + e(s.bankIban) + '</span>'),
    ].filter(Boolean);
    return vals.length && s.receiptShowBank ? vals.join('<br>') : '';
  }

  /* GS1 check digit (EAN-13 / EAN-8): weights 3,1 from the right, excluding the check digit */
  function eanOk(code) { const d = code.split('').map(Number), chk = d.pop(); const sum = d.reverse().reduce((a, n, i) => a + n * (i % 2 ? 1 : 3), 0); return (10 - (sum % 10)) % 10 === chk; }
  function barcodeSvg(value, { height = 40, width = 1.6 } = {}) {
    if (!value) return '';
    if (typeof JsBarcode === 'undefined') return `<div class="code">${e(value)}</div>`;
    try {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      // EAN only when the check digit is valid — otherwise JsBarcode throws and the label shows plain text; CODE128 scans back to the exact same digits
      const v = String(value), fmt = (/^\d{13}$/.test(v) && eanOk(v)) ? 'EAN13' : (/^\d{8}$/.test(v) && eanOk(v)) ? 'EAN8' : 'CODE128';
      JsBarcode(svg, v, { format: fmt, width, height, displayValue: true, fontSize: 12, margin: 2 });
      return svg.outerHTML;
    } catch { return `<div class="code">${e(value)}</div>`; }
  }

  async function printHtml(html, { title = 'طباعة', autoPrint = true, widthMm } = {}) {
    const css = await getCss();
    if (window.desktop && window.desktop.print && autoPrint) {
      // Electron shell: silent print to the configured printer (falls back to the OS dialog when none is set)
      const st = ERP.settings.all(); const dev = widthMm ? st.printerReceipt : st.printerA4;
      const doc = `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${e(title)}</title><style>${css || FALLBACK_CSS}${widthMm ? `@page{size:${widthMm}mm auto;margin:0}` : ''}</style></head><body>${html}</body></html>`;
      const r = await window.desktop.print(doc, { silent: !!dev, deviceName: dev || undefined, widthMm: widthMm || 0, heightMm: widthMm ? 297 : 0 });
      if (r && !r.ok && r.err) ERP.ui.error('فشل الطباعة: ' + r.err);
      return null;
    }
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;width:0;height:0;border:0;opacity:0;pointer-events:none';
    document.body.appendChild(iframe);
    const doc = iframe.contentDocument;
    doc.open();
    doc.write(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${e(title)}</title>
      <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800&display=swap" rel="stylesheet">
      ${headStyles(css, widthMm ? `@page{size:${widthMm}mm auto;margin:0}` : '')}</head><body>${html}</body></html>`);
    doc.close();
    await Promise.all([u.sleep(350), waitLinks(doc)]); // fonts/images/stylesheet
    if (autoPrint) {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
      setTimeout(() => iframe.remove(), 60000);
    }
    return iframe;
  }

  /** open document in a new tab for preview instead of direct print */
  async function preview(html, title = 'معاينة') {
    const css = await getCss();
    const w = window.open('', '_blank');
    if (!w) { ERP.ui.toast('المتصفح منع النافذة المنبثقة', 'warning'); return; }
    w.document.write(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${e(title)}</title>
      <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800&display=swap" rel="stylesheet">${headStyles(css, `
      .toolbar{position:fixed;top:10px;left:10px;display:flex;gap:8px}.toolbar button{padding:8px 16px;border:0;border-radius:8px;background:#1a56f5;color:#fff;font-weight:700;cursor:pointer;font-family:inherit}`)}</head>
      <body><div class="toolbar no-print"><button onclick="window.print()">🖨️ طباعة</button><button onclick="window.close()" style="background:#64748b">إغلاق</button></div>${html}</body></html>`);
    w.document.close();
  }

  /* ---------------- Documents ---------------- */

  function receiptHtml(sale, qr = '') {
    const s = ERP.settings.all();
    const cust = sale.customerId ? ERP.db.collection('customers').get(sale.customerId) : null;
    const user = sale.userId ? ERP.db.collection('users').get(sale.userId) : null;
    const isReturn = sale.type === 'return';
    const lines = sale.items.map(it => `<tr><td colspan="3" style="padding-bottom:0">${e(it.name)}${it.promoLabel ? `<br><span class="promo">${e(it.promoLabel)}</span>` : ''}</td></tr>
      <tr><td class="num">${u.fmtQty(it.qty)} × ${u.fmtNum(it.price)}</td><td class="num">${it.discount ? '-' + u.fmtNum(it.discount) : ''}</td><td class="num" style="text-align:left">${u.fmtNum(it.total)}</td></tr>`).join('');
    const bank = bankBox(s);
    return `<div class="receipt" style="--brand:${e(s.brandColor)}">
      <div class="center">
        ${logoMark(s, 'r-logo', 'r-badge')}
        <div class="store">${e(s.storeName)}</div>
        ${s.storeSlogan ? `<div class="slogan">${e(s.storeSlogan)}</div>` : ''}
        ${s.address ? `<div class="small">${e(s.address)}</div>` : ''}
        <div class="contact">${[s.phone && 'هاتف: ' + e(s.phone), s.receiptShowContact && s.whatsapp && 'واتساب: ' + e(s.whatsapp), s.receiptShowContact && s.email && e(s.email)].filter(Boolean).join(' · ')}</div>
        ${s.taxNumber || s.commercialReg ? `<div class="small">${[s.taxNumber && ('ر.ض: ' + e(s.taxNumber)), s.commercialReg && ('س.ت: ' + e(s.commercialReg))].filter(Boolean).join(' · ')}</div>` : ''}
      </div>
      <div class="brand-line"></div>
      <div class="doc-type">${isReturn ? 'فاتورة مرتجع' : 'فاتورة مبيعات'}${s.taxEnabled ? ' (ضريبية مبسطة)' : ''}</div>
      <table><tr><td>رقم:</td><td class="num" style="text-align:left">${e(sale.no)}</td></tr>
        <tr><td>التاريخ:</td><td class="num" style="text-align:left">${u.fmtDate(sale.date)} ${u.fmtTime(sale.date)}</td></tr>
        <tr><td>العميل:</td><td style="text-align:left">${e(sale.customerName || s.posDefaultCustomer)}</td></tr>
        ${cust && cust.phone ? `<tr><td>هاتف:</td><td class="num" style="text-align:left">${e(cust.phone)}</td></tr>` : ''}
        ${user ? `<tr><td>الكاشير:</td><td style="text-align:left">${e(user.name)}</td></tr>` : ''}</table>
      <div class="brand-line"></div>
      <table><thead><tr><th>الصنف / الكمية</th><th>خصم</th><th style="text-align:left">الإجمالي</th></tr></thead><tbody>${lines}</tbody></table>
      <div class="brand-line"></div>
      <table class="tot">
        <tr><td>عدد الأصناف</td><td class="num" style="text-align:left">${sale.items.length} (${u.fmtQty(u.sum(sale.items, 'qty'))})</td></tr>
        <tr><td>الإجمالي</td><td class="num" style="text-align:left">${u.fmtNum(sale.subtotal)}</td></tr>
        ${sale.discount ? `<tr><td>الخصم</td><td class="num" style="text-align:left">-${u.fmtNum(sale.discount)}</td></tr>` : ''}
        ${sale.tax ? `<tr><td>ض.ق.م ${s.taxRate}%</td><td class="num" style="text-align:left">${u.fmtNum(sale.tax)}</td></tr>` : ''}
        ${sale.loyaltyDiscount ? `<tr><td>خصم نقاط الولاء</td><td class="num" style="text-align:left">-${u.fmtNum(sale.loyaltyDiscount)}</td></tr>` : ''}
        <tr class="grand"><td>الصافي</td><td class="num" style="text-align:left">${u.fmtNum(sale.total)} ${e(s.currency)}</td></tr>
        ${(sale.payments || []).map(p => `<tr><td>${e(ERP.pos ? ERP.pos.methodName(p.method) : p.method)}</td><td class="num" style="text-align:left">${u.fmtNum(p.amount)}</td></tr>`).join('')}
        ${sale.change ? `<tr><td>الباقي</td><td class="num" style="text-align:left">${u.fmtNum(sale.change)}</td></tr>` : ''}
        ${sale.due > 0 ? `<tr><td style="font-weight:800">المتبقي (آجل)</td><td class="num" style="text-align:left;font-weight:800">${u.fmtNum(sale.due)}</td></tr>` : ''}
        ${cust && cust.balance > 0 ? `<tr><td>رصيد العميل</td><td class="num" style="text-align:left">${u.fmtNum(cust.balance)}</td></tr>` : ''}
        ${sale.loyaltyEarned ? `<tr><td>نقاط مكتسبة</td><td class="num" style="text-align:left">+${sale.loyaltyEarned}</td></tr>` : ''}
      </table>
      <div class="brand-line"></div>
      ${bank ? `<div class="bank"><div class="bank-title">التحويل البنكي</div>${bank}</div>` : ''}
      <div class="center">
        ${qr ? `<img class="qr" src="${qr}" alt="QR">` : ''}
        ${s.receiptFooterBarcode ? barcodeSvg(sale.no, { height: 34, width: 1.3 }) : ''}
        <div class="thanks">${e(s.receiptThanks)}</div>
        ${s.receiptTerms ? `<div class="small" style="margin-top:4px">${e(s.receiptTerms)}</div>` : ''}
        <div class="small" style="margin-top:6px;color:#666">${e(s.storeName)} · Dream Market ERP</div>
      </div></div>`;
  }

  function invoiceA4Html(sale, qr = '') {
    const s = ERP.settings.all();
    const cust = sale.customerId ? ERP.db.collection('customers').get(sale.customerId) : null;
    const isReturn = sale.type === 'return';
    const bank = bankBox(s);
    return `<div class="a4" style="--brand:${e(s.brandColor)}">
      <div class="a4-brand"></div>
      ${sale.status === 'void' ? '<div class="watermark">ملغاة</div>' : ''}
      <div class="doc-header">${storeHeader()}
        <div class="doc-title"><h2>${isReturn ? 'إشعار مرتجع' : s.taxEnabled ? 'فاتورة ضريبية' : 'فاتورة مبيعات'}</h2>
          <div class="doc-no">رقم: <span class="num">${e(sale.no)}</span></div>
          <div class="doc-no">التاريخ: <span class="num">${u.fmtDate(sale.date)} ${u.fmtTime(sale.date)}</span></div>
          <span class="doc-status">${e({ paid: 'مدفوعة', partial: 'مدفوعة جزئياً', unpaid: 'غير مدفوعة', returned: 'مرتجعة', void: 'ملغاة' }[sale.status] || sale.status)}</span></div></div>
      <div class="doc-meta">
        <div class="box"><h4>بيانات العميل</h4><p><strong>${e(sale.customerName || s.posDefaultCustomer)}</strong></p>${cust ? `<p class="num">${e(cust.phone || '')}</p><p>${e(cust.address || '')}</p>` : ''}</div>
        <div class="box"><h4>معلومات الفاتورة</h4><p>طريقة الدفع: ${(sale.payments || []).map(p => e(ERP.pos ? ERP.pos.methodName(p.method) : p.method)).join(' + ') || 'آجل'}</p>${sale.refNo ? `<p>مرجع: <span class="num">${e(sale.refNo)}</span></p>` : ''}${sale.notes ? `<p>${e(sale.notes)}</p>` : ''}</div>
        ${bank ? `<div class="box"><h4>التحويل البنكي</h4><p>${bank}</p></div>` : ''}
      </div>
      <table class="doc-table"><thead><tr><th style="width:36px">#</th><th>الصنف</th><th class="num">الكمية</th><th class="num">السعر</th><th class="num">الخصم</th>${s.taxEnabled ? '<th class="num">الضريبة</th>' : ''}<th class="num">الإجمالي</th></tr></thead>
        <tbody>${sale.items.map((it, i) => `<tr><td class="num">${i + 1}</td><td>${e(it.name)}${it.barcode ? `<br><small class="muted num">${e(it.barcode)}</small>` : ''}</td><td class="num">${u.fmtQty(it.qty)}</td><td class="num">${u.fmtNum(it.price)}</td><td class="num">${it.discount ? u.fmtNum(it.discount) : '—'}</td>${s.taxEnabled ? `<td class="num">${u.fmtNum(it.taxAmount || 0)}</td>` : ''}<td class="num">${u.fmtNum(it.total)}</td></tr>`).join('')}</tbody></table>
      <div class="doc-totals"><table>
        <tr><td>الإجمالي قبل الخصم</td><td class="num">${u.fmtNum(sale.subtotal)}</td></tr>
        ${sale.discount ? `<tr><td>الخصم</td><td class="num">-${u.fmtNum(sale.discount)}</td></tr>` : ''}
        ${sale.tax ? `<tr><td>ضريبة القيمة المضافة (${s.taxRate}%)</td><td class="num">${u.fmtNum(sale.tax)}</td></tr>` : ''}
        <tr class="grand"><td>الإجمالي المستحق</td><td class="num">${u.fmtNum(sale.total)} ${e(s.currency)}</td></tr>
        <tr><td>المدفوع</td><td class="num">${u.fmtNum(sale.paid)}</td></tr>
        ${sale.due > 0 ? `<tr><td><strong>المتبقي</strong></td><td class="num"><strong>${u.fmtNum(sale.due)}</strong></td></tr>` : ''}
      </table></div>
      <div class="doc-meta2"><div class="doc-notes">فقط ${u.numToArabicWords(sale.total)} ${e(s.currency)} لا غير.${s.receiptTerms ? '<br>' + e(s.receiptTerms) : ''}</div>
        ${qr ? `<div class="qr-wrap"><img class="qr qr-lg" src="${qr}" alt="QR"><div class="small">امسح للتحقق</div></div>` : ''}</div>
      <div class="doc-sign"><div>البائع</div><div>المستلم</div><div>الختم</div></div>
      <div class="doc-footer"><span>${e(s.receiptThanks)}</span><span>${e(s.storeName)} — ${s.phone ? e(s.phone) : ''}${s.receiptShowContact && s.whatsapp ? ' · واتساب ' + e(s.whatsapp) : ''}</span></div>
    </div>`;
  }

  function quotationHtml(quote, qr = '') {
    const s = ERP.settings.all();
    const cust = quote.customerId ? ERP.db.collection('customers').get(quote.customerId) : null;
    const user = quote.userId ? ERP.db.collection('users').get(quote.userId) : null;
    const expired = quote.validUntil && quote.validUntil < u.todayISO();
    const stl = quote.status === 'converted' ? 'محوّل لفاتورة' : expired ? 'منتهي الصلاحية' : quote.status === 'confirmed' ? 'مؤكد من العميل' : 'عرض سعر';
    const bank = bankBox(s);
    return `<div class="a4" style="--brand:${e(s.brandColor)}">
      <div class="a4-brand"></div>
      <div class="doc-header">${storeHeader()}
        <div class="doc-title"><h2>عرض سعر</h2>
          <div class="doc-no">رقم: <span class="num">${e(quote.no)}</span></div>
          <div class="doc-no">التاريخ: <span class="num">${u.fmtDate(quote.date)}</span></div>
          ${quote.validUntil ? `<div class="doc-no">ساري حتى: <span class="num">${u.fmtDate(quote.validUntil)}</span></div>` : ''}
          <span class="doc-status">${e(stl)}</span></div></div>
      <div class="doc-meta">
        <div class="box"><h4>العميل</h4><p><strong>${e(quote.customerName || s.posDefaultCustomer)}</strong></p>${cust ? `<p class="num">${e(cust.phone || '')}</p><p>${e(cust.address || '')}</p>` : ''}</div>
        <div class="box"><h4>ملاحظات</h4><p>${e(quote.notes || '—')}</p>${user ? `<p>أُعدّ بواسطة: ${e(user.name)}</p>` : ''}</div>
        ${bank ? `<div class="box"><h4>التحويل البنكي</h4><p>${bank}</p></div>` : ''}
      </div>
      <div class="invoice-note"><i>هذا عرض سعر وليس فاتورة — الأسعار قابلة للتغيير قبل إصدار الفاتورة النهائية.</i></div>
      <table class="doc-table"><thead><tr><th style="width:36px">#</th><th>الصنف</th><th class="num">الكمية</th><th class="num">السعر</th><th class="num">الخصم</th>${s.taxEnabled ? '<th class="num">الضريبة</th>' : ''}<th class="num">الإجمالي</th></tr></thead>
        <tbody>${quote.items.map((it, i) => `<tr><td class="num">${i + 1}</td><td>${e(it.name)}</td><td class="num">${u.fmtQty(it.qty)}</td><td class="num">${u.fmtNum(it.price)}</td><td class="num">${it.discount ? u.fmtNum(it.discount) : '—'}</td>${s.taxEnabled ? `<td class="num">${u.fmtNum(it.taxAmount || 0)}</td>` : ''}<td class="num">${u.fmtNum(it.total)}</td></tr>`).join('')}</tbody></table>
      <div class="doc-totals"><table>
        <tr><td>الإجمالي قبل الخصم</td><td class="num">${u.fmtNum(quote.subtotal)}</td></tr>
        ${quote.discount ? `<tr><td>الخصم</td><td class="num">-${u.fmtNum(quote.discount)}</td></tr>` : ''}
        ${quote.tax ? `<tr><td>ضريبة القيمة المضافة (${s.taxRate}%)</td><td class="num">${u.fmtNum(quote.tax)}</td></tr>` : ''}
        <tr class="grand"><td>الإجمالي</td><td class="num">${u.fmtNum(quote.total)} ${e(s.currency)}</td></tr>
      </table></div>
      <div class="doc-meta2">${qr ? `<div class="qr-wrap"><img class="qr qr-lg" src="${qr}" alt="QR"><div class="small">امسح لفتح العرض</div></div>` : '<div></div>'}</div>
      <div class="doc-sign"><div>إعداد عرض السعر</div><div>ممثل الشركة</div><div>العميل / التوقيع</div></div>
      <div class="doc-footer"><span>${e(s.receiptThanks)}</span><span>${e(s.storeName)} — ${s.phone ? e(s.phone) : ''}${s.receiptShowContact && s.whatsapp ? ' · واتساب ' + e(s.whatsapp) : ''}</span></div>
    </div>`;
  }

  function purchaseHtml(po) {
    const s = ERP.settings.all();
    const sup = ERP.db.collection('suppliers').get(po.supplierId);
    return `<div class="a4" style="--brand:${e(s.brandColor)}"><div class="a4-brand"></div><div class="doc-header">${storeHeader()}<div class="doc-title"><h2>أمر شراء</h2><div class="doc-no">رقم: <span class="num">${e(po.no)}</span></div><div class="doc-no">التاريخ: <span class="num">${u.fmtDate(po.date)}</span></div><span class="doc-status">${e({ draft: 'مسودة', ordered: 'مطلوب', received: 'مستلم', billed: 'مفوتر', cancelled: 'ملغي' }[po.status] || po.status)}</span></div></div>
      <div class="doc-meta"><div class="box"><h4>المورد</h4><p><strong>${e(sup ? sup.name : po.supplierName || '')}</strong></p><p class="num">${e(sup ? sup.phone || '' : '')}</p><p>${e(sup ? sup.address || '' : '')}</p></div>
      <div class="box"><h4>التسليم</h4><p>المخزن: ${e((ERP.db.collection('warehouses').get(po.warehouseId) || {}).name || '')}</p>${po.expectedDate ? `<p>موعد التوريد: <span class="num">${u.fmtDate(po.expectedDate)}</span></p>` : ''}${po.notes ? `<p>${e(po.notes)}</p>` : ''}</div></div>
      <table class="doc-table"><thead><tr><th style="width:36px">#</th><th>الصنف</th><th class="num">الكمية</th><th class="num">المستلم</th><th class="num">سعر الشراء</th><th class="num">الإجمالي</th></tr></thead>
      <tbody>${po.items.map((it, i) => `<tr><td class="num">${i + 1}</td><td>${e(it.name)}</td><td class="num">${u.fmtQty(it.qty)}</td><td class="num">${u.fmtQty(it.received || 0)}</td><td class="num">${u.fmtNum(it.cost)}</td><td class="num">${u.fmtNum(it.total)}</td></tr>`).join('')}</tbody></table>
      <div class="doc-totals"><table><tr><td>الإجمالي</td><td class="num">${u.fmtNum(po.subtotal)}</td></tr>${po.discount ? `<tr><td>الخصم</td><td class="num">-${u.fmtNum(po.discount)}</td></tr>` : ''}${po.tax ? `<tr><td>الضريبة</td><td class="num">${u.fmtNum(po.tax)}</td></tr>` : ''}<tr class="grand"><td>الصافي</td><td class="num">${u.fmtNum(po.total)} ${e(s.currency)}</td></tr><tr><td>المدفوع</td><td class="num">${u.fmtNum(po.paid)}</td></tr><tr><td>المتبقي</td><td class="num">${u.fmtNum(po.due)}</td></tr></table></div>
      <div class="doc-sign"><div>المشتريات</div><div>أمين المخزن</div><div>المورد</div></div>
      <div class="doc-footer"><span>${e(s.storeName)}</span><span class="num">${u.fmtDateTime(new Date())}</span></div></div>`;
  }

  function statementHtml({ title, party, rows, opening = 0, from, to }) {
    const s = ERP.settings.all();
    let bal = opening;
    const body = rows.map(r => { bal += u.num(r.debit) - u.num(r.credit); return `<tr><td class="num">${u.fmtDate(r.date)}</td><td>${e(r.type)}</td><td class="num">${e(r.ref || '')}</td><td>${e(r.desc || '')}</td><td class="num">${r.debit ? u.fmtNum(r.debit) : ''}</td><td class="num">${r.credit ? u.fmtNum(r.credit) : ''}</td><td class="num">${u.fmtNum(bal)}</td></tr>`; }).join('');
    return `<div class="a4" style="--brand:${e(s.brandColor)}"><div class="a4-brand"></div><div class="doc-header">${storeHeader()}<div class="doc-title"><h2>${e(title)}</h2><div class="doc-no">${from || to ? `الفترة: <span class="num">${from ? u.fmtDate(from) : '—'} إلى ${to ? u.fmtDate(to) : '—'}</span>` : ''}</div></div></div>
      <div class="doc-meta"><div class="box"><h4>الطرف</h4><p><strong>${e(party.name)}</strong></p><p class="num">${e(party.phone || '')}</p><p>${e(party.address || '')}</p></div><div class="box"><h4>ملخص</h4><p>رصيد افتتاحي: <span class="num">${u.fmtNum(opening)}</span></p><p>إجمالي مدين: <span class="num">${u.fmtNum(u.sum(rows, 'debit'))}</span></p><p>إجمالي دائن: <span class="num">${u.fmtNum(u.sum(rows, 'credit'))}</span></p><p><strong>الرصيد الختامي: <span class="num">${u.fmtNum(bal)} ${e(s.currency)}</span></strong></p></div></div>
      <table class="doc-table"><thead><tr><th>التاريخ</th><th>النوع</th><th>المرجع</th><th>البيان</th><th class="num">مدين</th><th class="num">دائن</th><th class="num">الرصيد</th></tr></thead><tbody>${opening ? `<tr><td colspan="6">رصيد افتتاحي</td><td class="num">${u.fmtNum(opening)}</td></tr>` : ''}${body}</tbody></table>
      <div class="doc-footer"><span>${e(s.storeName)}</span><span class="num">${u.fmtDateTime(new Date())}</span></div></div>`;
  }

  /** subtitle is plain text (escaped; \n = line break). subtitleHtml is for trusted, already-escaped markup only. */
  function tableHtml({ title, subtitle = '', subtitleHtml = '', columns, rows, summary = [], landscape = false }) {
    const s = ERP.settings.all();
    return `<div class="a4" ${landscape ? 'style="width:297mm"' : ''}><div class="a4-brand" style="${landscape ? 'width:297mm' : ''}"></div>
      <div class="doc-header">${storeHeader()}<div class="doc-title"><h2>${e(title)}</h2><div class="doc-no num">${u.fmtDateTime(new Date())}</div></div></div>
      ${subtitle || subtitleHtml ? `<div class="report-title"><p>${subtitleHtml || e(subtitle).replace(/\n/g, '<br>')}</p></div>` : ''}
      ${summary.length ? `<div class="summary-strip">${summary.map(c => `<div class="cell"><small>${e(c.label)}</small><strong class="num">${e(c.value)}</strong></div>`).join('')}</div>` : ''}
      <table class="doc-table"><thead><tr>${columns.map(c => `<th class="${c.num ? 'num' : ''}">${e(c.label)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(r => `<tr>${r.map((v, i) => `<td class="${columns[i] && columns[i].num ? 'num' : ''}">${e(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>
      <div class="doc-footer"><span>${e(s.storeName)}</span><span>${rows.length} سجل</span></div></div>`;
  }

  function labelsHtml(items) {
    const s = ERP.settings.all();
    // item: { product, qty = copies, unitName?, price? (unit price), oldPrice? (crossed out), barcode? (unit barcode) }
    // [hw] clearance: true → red «تصفية» label (clearanceText = e.g. expiry date)
    return `<div class="labels">${items.flatMap(({ product, qty = 1, unitName = '', price = null, oldPrice = null, barcode = null, clearance = false, clearanceText = '' }) => u.range(qty).map(() => `<div class="label"${clearance ? ' style="border:2px solid #dc2626;color:#b91c1c"' : ''}>${clearance ? `<div style="background:#dc2626;color:#fff;font-weight:800;font-size:12px;margin:-3mm -3mm 2mm;padding:1mm;-webkit-print-color-adjust:exact;print-color-adjust:exact">تصفية${clearanceText ? ` — ${e(clearanceText)}` : ''}</div>` : ''}<div class="name">${e(product.name)}</div>${barcodeSvg(barcode || product.barcode || product.code, { height: 36, width: 1.4 })}<div class="price num">${oldPrice ? `<s style="font-size:10px;font-weight:600;opacity:.7;margin-inline-end:4px">${u.fmtNum(oldPrice)}</s>` : ''}${u.fmtNum(price ?? product.price)} ${e(s.currency)}${unitName ? `<span style="font-size:10px;font-weight:600"> / ${e(unitName)}</span>` : ''}</div></div>`)).join('')}</div>`;
  }

  /* ---- async builders: QR is prepared before the document is rendered ---- */
  async function buildReceipt(sale) {
    const s = ERP.settings.all();
    let qr = '';
    const eta = ERP.eta && ERP.eta.qrInfo(sale); // [eta] e-receipt QR + UUID replace the internal QR
    if (eta) qr = await qrDataUrl(eta.url, 120);
    else if (s.invoiceQR) qr = await qrDataUrl(`فاتورة ${sale.no} | ${u.fmtDate(sale.date)} | ${s.storeName} | ${u.fmtNum(sale.total)} ${s.currency}`, 108);
    const html = receiptHtml(sale, qr);
    return eta ? html.replace('<div class="thanks">', `<div class="small">إيصال إلكتروني — مصلحة الضرائب المصرية</div><div class="small num" style="direction:ltr;word-break:break-all;font-size:8px">UUID: ${e(eta.uuid)}</div><div class="thanks">`) : html;
  }
  async function buildInvoice(sale) {
    const s = ERP.settings.all();
    let qr = '';
    const eta = ERP.eta && ERP.eta.qrInfo(sale); // [eta]
    if (eta) qr = await qrDataUrl(eta.url, 128);
    else if (s.invoiceQR) qr = await qrDataUrl(`فاتورة ${sale.no} | ${u.fmtDate(sale.date)} | ${s.storeName} | ${u.fmtNum(sale.total)} ${s.currency}`, 128);
    const html = invoiceA4Html(sale, qr);
    return eta ? html.replace('<div class="small">امسح للتحقق</div>', '<div class="small">امسح للتحقق — مصلحة الضرائب</div>').replace('<div class="doc-sign">', `<div class="small num" style="direction:ltr;text-align:left;margin:4px 0;word-break:break-all">ETA e-Receipt UUID: ${e(eta.uuid)}</div><div class="doc-sign">`) : html;
  }
  async function buildQuotation(quote) {
    const s = ERP.settings.all();
    let qr = '';
    if (s.invoiceQR) qr = await qrDataUrl(`عرض سعر ${quote.no} | ${s.storeName} | ${u.fmtNum(quote.total)} ${s.currency}`, 128);
    return quotationHtml(quote, qr);
  }

  ERP.print = {
    html: printHtml, preview, barcodeSvg, storeHeader, qrDataUrl,
    receipt: async (sale, { previewOnly = false } = {}) => { const html = await buildReceipt(sale); return previewOnly ? preview(html, sale.no) : printHtml(html, { title: sale.no, widthMm: ERP.settings.get('receiptWidth') || 80 }); },
    invoice: async (sale, { previewOnly = false } = {}) => { const html = await buildInvoice(sale); return previewOnly ? preview(html, sale.no) : printHtml(html, { title: sale.no }); },
    sale: (sale, opts) => (ERP.settings.get('invoiceType') === 'a4' ? ERP.print.invoice(sale, opts) : ERP.print.receipt(sale, opts)),
    quotation: async (quote, opts = {}) => { const html = await buildQuotation(quote); return opts.previewOnly ? preview(html, quote.no) : printHtml(html, { title: quote.no }); },
    purchase: (po, opts = {}) => opts.previewOnly ? preview(purchaseHtml(po), po.no) : printHtml(purchaseHtml(po), { title: po.no }),
    statement: (data, opts = {}) => opts.previewOnly ? preview(statementHtml(data), data.title) : printHtml(statementHtml(data), { title: data.title }),
    table: (data, opts = {}) => opts.previewOnly ? preview(tableHtml(data), data.title) : printHtml(tableHtml(data), { title: data.title }),
    labels: (items, opts = {}) => opts.previewOnly ? preview(labelsHtml(items), 'ملصقات') : (!opts.html && ERP.hardware && ERP.hardware.labels.enabled()) ? ERP.hardware.labels.print(items) /* [hw] raw ZPL / TSPL printer */ : printHtml(labelsHtml(items), { title: 'ملصقات باركود' }),
    receiptHtml, invoiceA4Html, quotationHtml, purchaseHtml, statementHtml, tableHtml,
  };
})();