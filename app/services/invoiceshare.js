/* ==========================================================================
   ERP.invoiceShare — send an invoice to the customer on WhatsApp
   - buildText(sale): pure message builder (lines capped, totals, paid/change/due, balance, points, ETA link)
   - savePdf(sale, kind): desktop → save dialog (window.desktop.printPdf) · browser → print dialog «حفظ كـ PDF»
   - dialog(sale): phone (prefilled, editable) + editable preview + PDF + send via ERP.whatsapp
   Honest limits: wa.me links can't attach files, and ERP.whatsapp sends text only (no media upload),
   so the PDF is saved locally and the user attaches it in WhatsApp.
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  const u = ERP.utils; const e = u.escapeHtml;
  ERP.settings.extend({ invShareHeader: '', invShareFooter: '', invShareLines: true, invShareMaxLines: 25, invShareAutoOffer: false, invSharePdf: 'receipt' });

  const fill = (tpl, v) => String(tpl || '').replace(/\{(store|no|date|customer|total)\}/g, (_, k) => v[k] ?? '');
  const money = n => u.fmtMoney(u.round(u.num(n)));

  const share = {
    /** the WhatsApp text for a sale. opts: { s (settings), customer, maxLines, includeLines, etaUrl } — no side effects */
    buildText(sale, opts = {}) {
      const s = opts.s || ERP.settings.all();
      const customer = opts.customer !== undefined ? opts.customer : (sale.customerId && ERP.crm ? ERP.crm.get(sale.customerId) : null);
      const maxLines = Math.max(1, u.num(opts.maxLines ?? s.invShareMaxLines, 25) || 25);
      const includeLines = opts.includeLines ?? s.invShareLines !== false;
      const isRet = sale.type === 'return';
      const vars = { store: s.storeName || '', no: sale.no, date: u.fmtDateTime(sale.date), customer: customer ? customer.name : (sale.customerName || ''), total: money(sale.total) };
      const L = [];
      L.push(s.invShareHeader ? fill(s.invShareHeader, vars) : `*${s.storeName || ''}*${s.branchName ? ' — ' + s.branchName : ''}`);
      L.push(`${isRet ? 'مرتجع' : 'فاتورة'} رقم: ${sale.no}`);
      L.push(`التاريخ: ${vars.date}`);
      if (customer) L.push(`العميل: ${customer.name}`);
      const items = sale.items || [];
      if (includeLines && items.length) {
        L.push('────────');
        items.slice(0, maxLines).forEach(it => L.push(`• ${it.name} × ${u.fmtQty(it.qty)} = ${u.fmtNum(it.total)}`));
        if (items.length > maxLines) L.push(`… و ${items.length - maxLines} أصناف أخرى`);
      } else if (items.length) L.push(`عدد الأصناف: ${items.length}`);
      L.push('────────');
      const disc = u.round(u.num(sale.discount));
      if (disc > 0) { L.push(`الإجمالي قبل الخصم: ${money(sale.subtotal)}`); L.push(`الخصم: -${money(disc)}`); }
      if (u.num(sale.loyaltyDiscount) > 0) L.push(`خصم نقاط الولاء: -${money(sale.loyaltyDiscount)}`);
      if (u.num(sale.deliveryFee) > 0) L.push(`رسوم التوصيل: ${money(sale.deliveryFee)}`);
      if (u.num(sale.tax) > 0) L.push(`الضريبة: ${money(sale.tax)}`);
      L.push(`*الإجمالي: ${money(sale.total)}*`);
      if (!isRet) {
        // what was paid at the counter (receipts collected later are excluded; change is shown separately)
        const paidNow = u.round(u.sum((sale.payments || []).filter(p => !p.isCredit && !p.receiptId && p.amount > 0), 'amount'));
        if (paidNow > 0) L.push(`المدفوع: ${money(paidNow)}`);
        if (u.num(sale.change) > 0) L.push(`الباقي لكم: ${money(sale.change)}`);
        if (u.num(sale.due) > 0.009) L.push(`المتبقي (آجل): ${money(sale.due)}`);
      }
      if (customer) {
        const bal = u.round(u.num(customer.balance));
        if (Math.abs(bal) > 0.009) L.push(bal > 0 ? `رصيد حسابكم المستحق: ${money(bal)}` : `رصيد دائن لكم: ${money(-bal)}`);
        const pts = u.num(customer.loyaltyPoints);
        if (s.loyaltyEnabled && (pts > 0 || u.num(sale.loyaltyEarned) > 0)) L.push(`نقاط الولاء: ${u.fmtInt(pts)}${u.num(sale.loyaltyEarned) > 0 ? ` (+${u.fmtInt(sale.loyaltyEarned)} من هذه الفاتورة)` : ''}`);
      }
      const etaUrl = opts.etaUrl !== undefined ? opts.etaUrl : (ERP.eta && ERP.eta.qrInfo ? (ERP.eta.qrInfo(sale) || {}).url : '');
      if (etaUrl) L.push(`الإيصال الإلكتروني (مصلحة الضرائب): ${etaUrl}`);
      L.push('');
      L.push(s.invShareFooter ? fill(s.invShareFooter, vars) : (s.receiptThanks || 'شكراً لتعاملكم معنا'));
      return L.filter((x, i, a) => !(x === '' && a[i - 1] === '')).join('\n').trim();
    },
    phoneOf(sale) { const c = sale && sale.customerId && ERP.crm ? ERP.crm.get(sale.customerId) : null; return (c && c.phone) || sale.customerPhone || ''; },

    /** document HTML (receipt or A4) with the same QR/ETA handling as ERP.print */
    async docHtml(sale, kind = 'receipt') {
      const s = ERP.settings.all(); let qr = '';
      const eta = ERP.eta && ERP.eta.qrInfo ? ERP.eta.qrInfo(sale) : null;
      if (eta) qr = await ERP.print.qrDataUrl(eta.url, 128);
      else if (s.invoiceQR) qr = await ERP.print.qrDataUrl(`فاتورة ${sale.no} | ${u.fmtDate(sale.date)} | ${s.storeName} | ${u.fmtNum(sale.total)} ${s.currency}`, 120);
      return kind === 'a4' ? ERP.print.invoiceA4Html(sale, qr) : ERP.print.receiptHtml(sale, qr);
    },
    async _css() {
      if (share.__css !== undefined) return share.__css;
      let css = '';
      try { const r = await fetch('assets/css/print.css'); if (r.ok) css = await r.text(); } catch { /* file:// */ }
      if (!css) { try { const sh = [...document.styleSheets].find(x => x.href && x.href.endsWith('assets/css/print.css')); if (sh) css = [...sh.cssRules].map(r => r.cssText).join('\n'); } catch { /* */ } }
      share.__css = css; return css;
    },
    fileName(sale) { return `${sale.type === 'return' ? 'مرتجع' : 'فاتورة'}-${sale.no}`; },
    /** → { ok, mode: 'desktop'|'browser', saved } */
    async savePdf(sale, kind = null) {
      kind = kind || ERP.settings.get('invSharePdf') || 'receipt';
      const html = await share.docHtml(sale, kind);
      if (window.desktop && window.desktop.printPdf) {
        const css = await share._css();
        const doc = `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${e(share.fileName(sale))}</title><style>${css}${kind === 'a4' ? '' : '@page{size:80mm auto;margin:0}'}</style>${css ? '' : '<link rel="stylesheet" href="' + e(new URL('assets/css/print.css', document.baseURI).href) + '">'}</head><body>${html}</body></html>`;
        const saved = await window.desktop.printPdf(doc, { a4: kind === 'a4', name: share.fileName(sale) });
        return { ok: true, mode: 'desktop', saved: !!saved };
      }
      await ERP.print.html(html, { title: share.fileName(sale), widthMm: kind === 'a4' ? undefined : (ERP.settings.get('receiptWidth') || 80) });
      return { ok: true, mode: 'browser', saved: null };
    },
    async send(sale, phone, text) {
      if (!ERP.whatsapp) throw new Error('خدمة واتساب غير متاحة');
      const num = ERP.whatsapp.normalize(phone); if (!num) throw new Error('رقم واتساب غير صالح');
      const r = await ERP.whatsapp.send([num], text, { interactive: true, title: `${sale.type === 'return' ? 'مرتجع' : 'فاتورة'} ${sale.no}` });
      const bad = r.filter(x => !x.ok); if (bad.length) throw new Error(bad.map(x => x.err).join(' · '));
      ERP.db.collection('sales').update(sale.id, { waSentAt: u.now(), waSentTo: num }, { silent: true });
      ERP.audit.log('sale.share', `${sale.no} → +${num}`, sale.id);
      return r;
    },
    providerNote() {
      const p = ERP.settings.get('waProvider') || 'link';
      if (p === 'link') return 'يفتح واتساب والرسالة جاهزة — روابط wa.me لا تستطيع إرفاق ملفات، لذلك احفظ الـ PDF أولاً ثم اسحبه/أرفقه داخل المحادثة.';
      if (p === 'cloud') return 'WhatsApp Cloud API: يُرسل النص فقط' + (ERP.settings.get('waCloudMode') === 'text' ? ' (نص حر — يعمل فقط لو راسلك العميل خلال 24 ساعة)' : ' عبر القالب المعتمد (سطر واحد مضغوط)') + '. إرسال مستند يحتاج رابطاً عاماً للملف أو رفعه لـ Meta، وهذا غير مدعوم هنا — أرفق الـ PDF يدوياً عند الحاجة.';
      return 'يُرسل النص عبر مزوّد الواتساب المضبوط في الإعدادات (نص فقط). أرفق الـ PDF يدوياً إن أردت.';
    },

    /** modal: phone (editable) + message preview (editable) + PDF + send */
    dialog(saleOrId) {
      const sale = typeof saleOrId === 'string' ? ERP.db.collection('sales').get(saleOrId) : saleOrId;
      if (!sale) return ERP.ui.error('الفاتورة غير موجودة');
      const s = ERP.settings.all(); let lines = s.invShareLines !== false;
      const h = ERP.ui.modal({ title: `إرسال ${sale.type === 'return' ? 'المرتجع' : 'الفاتورة'} <span class="num">${e(sale.no)}</span> واتساب`, icon: 'paper-plane', size: 'lg', body: `
        <div class="alert alert-info mb-3 text-sm"><i class="fas fa-circle-info"></i> ${e(share.providerNote())}</div>
        <div class="form-row cols-2"><div class="form-group"><label class="required">رقم واتساب العميل</label><input id="is-phone" dir="ltr" inputmode="tel" value="${e(share.phoneOf(sale))}" placeholder="01012345678"><small class="help-text">${sale.customerId ? 'من بيانات العميل — يمكنك تعديله' : 'فاتورة بدون عميل مسجل — اكتب الرقم'}</small></div>
        <div class="form-group"><label>نسخة PDF</label><div class="flex gap-2"><select id="is-kind"><option value="receipt" ${s.invSharePdf !== 'a4' ? 'selected' : ''}>إيصال حراري</option><option value="a4" ${s.invSharePdf === 'a4' ? 'selected' : ''}>فاتورة A4</option></select><button type="button" class="btn btn-outline" id="is-pdf"><i class="fas fa-file-pdf"></i> ${window.desktop && window.desktop.printPdf ? 'حفظ PDF' : 'تحميل PDF'}</button></div><small class="help-text">${window.desktop && window.desktop.printPdf ? 'يفتح نافذة الحفظ' : 'من نافذة الطباعة اختر «حفظ كـ PDF» (Save as PDF)'}</small></div></div>
        <label class="checkbox mb-2"><input type="checkbox" id="is-lines" ${lines ? 'checked' : ''}> تضمين الأصناف في الرسالة</label>
        <textarea id="is-text" rows="14" style="width:100%;font-family:inherit;line-height:1.6">${e(share.buildText(sale, { includeLines: lines }))}</textarea>
        <div class="text-xs muted mt-1"><span id="is-len" class="num"></span> حرف${sale.waSentAt ? ` · أُرسلت من قبل ${u.relTime(sale.waSentAt)} إلى <span class="num" dir="ltr">+${e(sale.waSentTo || '')}</span>` : ''}</div>`,
        footer: '<button class="btn" data-a="close">إغلاق</button><button class="btn btn-success" data-a="send"><i class="fab fa-whatsapp"></i> إرسال واتساب</button>' });
      const txt = h.$('#is-text'), len = () => { h.$('#is-len').textContent = txt.value.length; }; len();
      txt.oninput = len;
      h.$('#is-lines').onchange = ev => { lines = ev.target.checked; txt.value = share.buildText(sale, { includeLines: lines }); len(); };
      h.$('#is-pdf').onclick = async () => { try { const r = await share.savePdf(sale, h.$('#is-kind').value); if (r.mode === 'desktop') { if (r.saved) ERP.ui.success('تم حفظ الـ PDF — أرفقه في محادثة واتساب'); } } catch (err) { ERP.ui.error(err.message); } };
      h.$('[data-a=close]').onclick = () => h.close();
      h.$('[data-a=send]').onclick = async () => { const b = h.$('[data-a=send]'); b.disabled = true; try { await share.send(sale, h.$('#is-phone').value, txt.value.trim()); ERP.ui.success('تم تجهيز/إرسال الرسالة'); h.close(); } catch (err) { ERP.ui.error(err.message); } finally { b.disabled = false; } };
      return h;
    },
    /** POS hook after a sale: optional suggestion toast when the customer has a phone */
    afterSale(sale) {
      if (!sale || !ERP.settings.get('invShareAutoOffer') || !sale.customerId) return false;
      const phone = share.phoneOf(sale); if (!phone || !ERP.whatsapp || !ERP.whatsapp.normalize(phone)) return false;
      ERP.ui.toast(`إرسال الفاتورة ${sale.no} للعميل على واتساب؟`, 'info', { title: 'واتساب', duration: 12000, action: { label: 'إرسال', onClick: () => share.dialog(sale) } });
      return true;
    },
  };
  ERP.invoiceShare = share;

  /* ---------- settings section ---------- */
  ERP.settingsSections = ERP.settingsSections || [];
  ERP.settingsSections.push({
    id: 'invoiceshare', icon: 'paper-plane', label: 'إرسال الفواتير',
    render(s, h) {
      return `<div class="alert alert-info mb-3"><i class="fas fa-circle-info"></i> زر «إرسال للعميل واتساب» في تفاصيل الفاتورة ونافذة ما بعد البيع. يستخدم مزوّد الواتساب المضبوط في قسم «واتساب». المتغيرات المتاحة في الرأس والتذييل: <code>{store}</code> <code>{no}</code> <code>{date}</code> <code>{customer}</code> <code>{total}</code></div>`
        + h.row('رأس الرسالة', 'فارغ = اسم المتجر بخط عريض', h.inp('invShareHeader', s.invShareHeader, 'text', 'placeholder="*{store}* — شكراً لزيارتكم"'))
        + h.row('تذييل الرسالة', 'فارغ = «رسالة الشكر» من إعدادات الإيصال', `<textarea name="invShareFooter" rows="2" style="min-width:280px">${h.e(s.invShareFooter || '')}</textarea>`)
        + h.row('تضمين الأصناف', 'اسم الصنف × الكمية = الإجمالي', h.sw('invShareLines', s.invShareLines !== false))
        + h.row('أقصى عدد أصناف في الرسالة', 'الباقي يظهر «و N أصناف أخرى»', h.inp('invShareMaxLines', s.invShareMaxLines, 'number', 'min="1" max="200" style="max-width:100px"'))
        + h.row('نسخة PDF الافتراضية', '', `<select name="invSharePdf"><option value="receipt" ${s.invSharePdf !== 'a4' ? 'selected' : ''}>إيصال حراري</option><option value="a4" ${s.invSharePdf === 'a4' ? 'selected' : ''}>فاتورة A4</option></select>`)
        + h.row('اقتراح الإرسال بعد كل بيع', 'في نقطة البيع: تنبيه «إرسال واتساب» بعد كل فاتورة لعميل له رقم', h.sw('invShareAutoOffer', s.invShareAutoOffer))
        + `<div class="divider"></div><div class="text-sm muted mb-2">معاينة على آخر فاتورة:</div><pre class="text-sm" id="is-prev" style="white-space:pre-wrap;background:var(--bg-muted,#f1f5f9);padding:.75rem;border-radius:8px;max-height:260px;overflow:auto"></pre>`;
    },
    bind(body) {
      const pre = body.querySelector('#is-prev'); if (!pre) return;
      const last = ERP.db.collection('sales').latest(1, 'date')[0];
      pre.textContent = last ? share.buildText(last) : 'لا توجد فواتير بعد';
    },
    save(patch) { if ('invShareMaxLines' in patch) patch.invShareMaxLines = Math.max(1, Math.min(200, Math.round(u.num(patch.invShareMaxLines) || 25))); },
  });
})();
