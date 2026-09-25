/* ==========================================================================
   ERP.whatsapp — send a text to manager numbers through a chosen provider
   - link (free): wa.me chat opened by the user (needs a click; scheduled sends → notification + toast)
   - callmebot (free API, per-recipient apikey), cloud (Meta WhatsApp Cloud API), webhook (any gateway)
   - request building is pure (build*) so it's testable without the network; tokens are never logged
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  const u = ERP.utils; const e = u.escapeHtml;
  ERP.settings.extend({
    waProvider: 'link', waRecipients: '', waCallmebotKeys: '',
    waCloudPhoneId: '', waCloudToken: '', waCloudMode: 'template', waCloudTemplate: '', waCloudLang: 'ar', waCloudVersion: 'v20.0',
    waWebhookUrl: '', waWebhookMethod: 'POST', waWebhookBody: '{"to":"{phone}","body":"{text}"}', waWebhookNoCors: false,
  });
  const PROVIDERS = { link: 'رابط واتساب (مجاني — يحتاج ضغطة)', callmebot: 'CallMeBot (مجاني — API لكل مستلم)', cloud: 'WhatsApp Cloud API (Meta)', webhook: 'بوابة Webhook (UltraMsg وغيرها)' };
  const pending = []; // link-mode messages waiting for a user click [{ phone, text, title, at }]

  const wa = {
    PROVIDERS,
    /** 010xxxxxxxx → 2010xxxxxxxx · +20… / 0020… → 20… · '' when not a plausible number */
    normalize(num, cc) {
      cc = String(cc ?? ERP.settings.get('countryCode', '20') ?? '20').replace(/\D/g, '') || '20';
      let d = u.normalizeDigits(String(num || '')).replace(/\D/g, '');
      if (!d) return '';
      if (d.startsWith('00')) d = d.slice(2);
      else if (d.startsWith('0')) d = cc + d.replace(/^0+/, '');
      else if (!d.startsWith(cc) && d.length <= 10) d = cc + d; // local number typed without the leading 0 (1012345678)
      return d.length >= 8 && d.length <= 15 ? d : '';
    },
    /** "010…, 011…" (commas / new lines / ؛) → unique normalized list */
    parseList(str, cc) { return u.uniq(String(str || '').split(/[,\n;،؛]+/).map(x => wa.normalize(x, cc)).filter(Boolean)); },
    /** "number:apikey" list → { normalizedNumber: apikey } */
    parseKeys(str, cc) { const o = {}; String(str || '').split(/[,\n;،؛]+/).forEach(x => { const i = x.lastIndexOf(':'); if (i < 1) return; const n = wa.normalize(x.slice(0, i), cc), k = x.slice(i + 1).trim(); if (n && k) o[n] = k; }); return o; },
    recipients(s = ERP.settings.all()) { const l = wa.parseList(s.waRecipients, s.countryCode); return l.length ? l : wa.parseList(s.ownerPhone, s.countryCode); },
    /** Cloud-API template parameter: ≤1024 chars, no new lines/tabs, no runs of spaces */
    compact(text, max = 1024) { const t = String(text || '').replace(/\r/g, '').split('\n').map(x => x.trim()).filter(Boolean).join(' | ').replace(/\t/g, ' ').replace(/ {2,}/g, ' '); return t.length > max ? t.slice(0, max - 1) + '…' : t; },

    /* ---------- pure request builders ---------- */
    buildLink(phone, text) { return `https://wa.me/${phone}?text=${encodeURIComponent(text)}`; },
    buildCallmebot(phone, text, apikey) { return `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(apikey)}`; },
    buildCloud(cfg, phone, text) {
      const id = String(cfg.waCloudPhoneId || '').trim(), ver = String(cfg.waCloudVersion || 'v20.0').trim();
      const body = cfg.waCloudMode === 'text'
        ? { messaging_product: 'whatsapp', recipient_type: 'individual', to: phone, type: 'text', text: { preview_url: false, body: String(text).slice(0, 4096) } }
        : { messaging_product: 'whatsapp', to: phone, type: 'template', template: { name: String(cfg.waCloudTemplate || '').trim(), language: { code: String(cfg.waCloudLang || 'ar').trim() }, components: [{ type: 'body', parameters: [{ type: 'text', text: wa.compact(text) }] }] } };
      return { url: `https://graph.facebook.com/${encodeURIComponent(ver)}/${encodeURIComponent(id)}/messages`, init: { method: 'POST', headers: { Authorization: `Bearer ${String(cfg.waCloudToken || '').trim()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) } };
    },
    /** {phone}/{text} placeholders: JSON-escaped inside a JSON body, URL-encoded in the URL / form bodies */
    buildWebhook(cfg, phone, text) {
      const method = String(cfg.waWebhookMethod || 'POST').toUpperCase() === 'GET' ? 'GET' : 'POST';
      const enc = s => encodeURIComponent(s), jsn = s => JSON.stringify(String(s)).slice(1, -1);
      const fill = (tpl, f) => String(tpl || '').replace(/\{phone\}/g, () => f(phone)).replace(/\{text\}/g, () => f(text));
      const url = fill(String(cfg.waWebhookUrl || '').trim(), enc);
      if (method === 'GET') return { url, init: { method: 'GET' } };
      const tpl = String(cfg.waWebhookBody || '').trim(); const isJson = tpl.startsWith('{') || tpl.startsWith('[');
      const noCors = !!cfg.waWebhookNoCors; // no-cors allows only "simple" content types → JSON goes as text/plain
      return { url, init: { method: 'POST', headers: { 'Content-Type': isJson ? (noCors ? 'text/plain;charset=utf-8' : 'application/json') : 'application/x-www-form-urlencoded' }, body: fill(tpl, isJson ? jsn : enc) } };
    },
    validate(s = ERP.settings.all()) {
      const p = s.waProvider || 'link';
      if (p === 'cloud' && (!s.waCloudPhoneId || !s.waCloudToken)) return 'أدخل Phone Number ID و Access Token';
      if (p === 'cloud' && s.waCloudMode !== 'text' && !s.waCloudTemplate) return 'أدخل اسم القالب المعتمد (أو اختر وضع النص الحر)';
      if (p === 'webhook' && !/^https?:\/\//i.test(s.waWebhookUrl || '')) return 'أدخل رابط الـ Webhook';
      return '';
    },

    /* ---------- sending ---------- */
    /** send text to numbers. opts.interactive = called from a user click (link mode may open a window directly). → [{ phone, ok, note|err }] */
    async send(numbers, text, { interactive = false, title = 'رسالة واتساب' } = {}) {
      const s = ERP.settings.all(); const p = s.waProvider || 'link';
      const list = u.uniq((Array.isArray(numbers) ? numbers : wa.parseList(numbers, s.countryCode)).map(n => wa.normalize(n, s.countryCode)).filter(Boolean));
      if (!list.length) throw new Error('لا توجد أرقام مستلمين صالحة — أضفها في الإعدادات ← واتساب');
      if (!text) throw new Error('الرسالة فارغة');
      const bad = wa.validate(s); if (bad) throw new Error(bad);
      if (p === 'link') return wa._link(list, text, { interactive, title });
      const keys = p === 'callmebot' ? wa.parseKeys(s.waCallmebotKeys, s.countryCode) : null;
      const out = [];
      for (const phone of list) {
        try {
          if (p === 'callmebot') {
            if (!keys[phone]) { out.push({ phone, ok: false, err: 'لا يوجد apikey لهذا الرقم' }); continue; }
            await fetch(wa.buildCallmebot(phone, text, keys[phone]), { mode: 'no-cors', cache: 'no-store' }); // CallMeBot sends no CORS headers → fire-and-forget
            out.push({ phone, ok: true, note: 'أُرسل (لا يمكن تأكيد الاستلام من المتصفح)' });
          } else if (p === 'cloud') {
            const r = wa.buildCloud(s, phone, text); const res = await fetch(r.url, r.init); let j = null; try { j = await res.json(); } catch { /* */ }
            if (!res.ok || !j || j.error) out.push({ phone, ok: false, err: (j && j.error && (j.error.error_user_msg || j.error.message)) || `HTTP ${res.status}` });
            else out.push({ phone, ok: true, note: 'قُبلت الرسالة' });
          } else if (p === 'webhook') {
            const r = wa.buildWebhook(s, phone, text);
            if (s.waWebhookNoCors) { await fetch(r.url, { ...r.init, mode: 'no-cors' }); out.push({ phone, ok: true, note: 'أُرسل (no-cors — بدون تأكيد)' }); }
            else { const res = await fetch(r.url, r.init); const t = await res.text().catch(() => ''); out.push(res.ok ? { phone, ok: true, note: `HTTP ${res.status}` } : { phone, ok: false, err: `HTTP ${res.status} ${t.slice(0, 120)}` }); }
          }
        } catch (err) { out.push({ phone, ok: false, err: err && err.name === 'TypeError' ? 'تعذر الاتصال (الإنترنت أو CORS)' : String((err && err.message) || err) }); }
      }
      wa._log(p, out);
      return out;
    },
    _link(list, text, { interactive, title }) {
      if (interactive && list.length === 1) { window.open(wa.buildLink(list[0], text), '_blank', 'noopener'); wa._log('link', [{ phone: list[0], ok: true }]); return [{ phone: list[0], ok: true, note: 'فُتحت المحادثة' }]; }
      list.forEach(phone => pending.push({ phone, text, title, at: u.now() }));
      if (interactive) wa.openPending();
      else {
        if (ERP.notifications) ERP.notifications.push({ type: 'info', title: `${title} جاهزة للإرسال عبر واتساب`, text: `${list.length} مستلم — الإعدادات ← واتساب ← «رسائل بانتظار الإرسال»`, link: 'settings', params: { sec: 'whatsapp' }, key: `wa_${u.todayISO()}_${title}` });
        if (ERP.ui && ERP.ui.toast) ERP.ui.toast(`${title} جاهزة — اضغط لفتح واتساب`, 'info', { title: 'واتساب', duration: 30000, action: { label: 'فتح واتساب', onClick: () => wa.openPending() } });
      }
      return list.map(phone => ({ phone, ok: true, note: 'بانتظار ضغطة المستخدم' }));
    },
    pending() { return pending.slice(); },
    /** modal with one wa.me button per waiting message (each click = a user gesture → no popup blocking) */
    openPending() {
      if (!pending.length) return ERP.ui.info('لا توجد رسائل بانتظار الإرسال');
      const h = ERP.ui.view('رسائل واتساب بانتظار الإرسال', `<div class="alert alert-info mb-3"><i class="fas fa-circle-info"></i> اضغط «فتح» لكل رقم — تفتح المحادثة والرسالة جاهزة، ثم اضغط إرسال في واتساب.</div><div class="flex flex-col gap-2" id="wa-pend">${pending.map((m, i) => `<div class="list-row"><div class="grow"><div class="title num" dir="ltr">+${e(m.phone)}</div><div class="sub">${e(m.title)} · ${u.relTime(m.at)}</div></div><a class="btn btn-sm btn-success" target="_blank" rel="noopener" data-i="${i}" href="${e(wa.buildLink(m.phone, m.text))}"><i class="fab fa-whatsapp"></i> فتح</a></div>`).join('')}</div>`, { icon: 'paper-plane', footer: '<button class="btn btn-ghost text-danger" data-act="wa-clear">مسح القائمة</button><button class="btn" data-act="view-close">إغلاق</button>' });
      const done = new Set();
      h.$('#wa-pend').onclick = ev => { const a = ev.target.closest('a[data-i]'); if (!a) return; done.add(+a.dataset.i); a.classList.replace('btn-success', 'btn-outline'); a.innerHTML = '<i class="fas fa-check"></i> تم الفتح'; };
      h.$('[data-act=wa-clear]').onclick = () => { pending.length = 0; h.close(); };
      h.$('[data-act=view-close]').onclick = () => { [...done].sort((a, b) => b - a).forEach(i => pending.splice(i, 1)); h.close(); }; // opened ones leave the queue
    },
    _log(provider, out) { const okN = out.filter(x => x.ok).length; ERP.db.kvSet('wa.last', { at: u.now(), provider, ok: okN, fail: out.length - okN, errs: out.filter(x => !x.ok).map(x => `${x.phone}: ${x.err}`).slice(0, 5) }).catch(() => { }); if (okN < out.length) console.warn('[whatsapp] failed', out.filter(x => !x.ok).map(x => x.phone + ': ' + x.err)); },
    async last() { try { return await ERP.db.kvGet('wa.last'); } catch { return null; } },
  };
  ERP.whatsapp = wa;

  /* ---------- settings section ---------- */
  ERP.settingsSections = ERP.settingsSections || [];
  ERP.settingsSections.push({
    id: 'whatsapp', icon: 'comment-dots', label: 'واتساب',
    render(s, h) {
      const p = s.waProvider || 'link'; const opt = (v, cur, l) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${l}</option>`;
      const show = id => (p === id ? '' : 'style="display:none"');
      return `<div class="alert alert-info mb-3"><i class="fas fa-circle-info"></i> يُستخدم لإرسال التقرير اليومي وملخص الوردية للمديرين (إعداداتهما في قسم «التقرير اليومي»). اكتب الأرقام محلياً (010…) أو دولياً — تُحوّل تلقائياً بكود الدولة.</div>`
        + h.row('طريقة الإرسال', 'رابط واتساب مجاني لكنه يحتاج ضغطة من المستخدم لكل رسالة', `<select name="waProvider" id="wa-prov">${Object.entries(PROVIDERS).map(([k, l]) => opt(k, p, l)).join('')}</select>`)
        + h.row('أرقام المديرين', 'افصل بينها بفاصلة. إن تُركت فارغة يُستخدم «واتساب صاحب المتجر»', h.inp('waRecipients', s.waRecipients, 'text', 'placeholder="01012345678, 01122223333" dir="ltr"'))
        + h.row('كود الدولة', 'مصر = 20', h.inp('countryCode', s.countryCode, 'text', 'style="max-width:90px" dir="ltr"'))
        + `<div data-wa="callmebot" ${show('callmebot')}><div class="alert alert-warning mt-2 mb-2"><i class="fas fa-key"></i> كل مستلم يجب أن يرسل أولاً من واتساب الرسالة <code dir="ltr">I allow callmebot to send me messages</code> إلى رقم CallMeBot المنشور على موقع callmebot.com، فيصله apikey خاص به. اكتب كل رقم مع مفتاحه بالشكل <code dir="ltr">01012345678:123456</code>.</div>${h.row('الأرقام ومفاتيحها', 'رقم:apikey — افصل بفاصلة', h.inp('waCallmebotKeys', s.waCallmebotKeys, 'text', 'dir="ltr" placeholder="01012345678:123456" autocomplete="off"'))}</div>`
        + `<div data-wa="cloud" ${show('cloud')}><div class="alert alert-warning mt-2 mb-2"><i class="fas fa-triangle-exclamation"></i> Meta لا تسمح برسالة يبدأها النشاط التجاري خارج نافذة 24 ساعة إلا عبر <strong>قالب معتمد</strong>. أنشئ قالب «Utility» نصه متغير واحد <code dir="ltr">{{1}}</code> — يُرسل التقرير مضغوطاً في سطر واحد (حد 1024 حرف). النص الحر يعمل فقط إذا راسلك المدير خلال آخر 24 ساعة. التوكن يُحفظ في إعدادات النظام (ويدخل في النسخ الاحتياطية) — استخدم توكن System User بصلاحية الرسائل فقط.</div>${h.row('Phone Number ID', '', h.inp('waCloudPhoneId', s.waCloudPhoneId, 'text', 'dir="ltr"')) + h.row('Access Token', '', h.inp('waCloudToken', s.waCloudToken, 'password', 'dir="ltr" autocomplete="off"')) + h.row('نوع الرسالة', '', `<select name="waCloudMode">${opt('template', s.waCloudMode, 'قالب معتمد (موصى به)')}${opt('text', s.waCloudMode, 'نص حر (داخل نافذة 24 ساعة فقط)')}</select>`) + h.row('اسم القالب', '', h.inp('waCloudTemplate', s.waCloudTemplate, 'text', 'dir="ltr" placeholder="daily_report"')) + h.row('كود اللغة', 'ar أو en_US … كما في القالب', h.inp('waCloudLang', s.waCloudLang, 'text', 'dir="ltr" style="max-width:110px"')) + h.row('إصدار Graph API', '', h.inp('waCloudVersion', s.waCloudVersion, 'text', 'dir="ltr" style="max-width:110px"'))}</div>`
        + `<div data-wa="webhook" ${show('webhook')}><div class="alert alert-info mt-2 mb-2"><i class="fas fa-plug"></i> لأي بوابة (UltraMsg وغيرها): اكتب الرابط وقالب الجسم مستخدماً <code>{phone}</code> و<code>{text}</code>. الجسم الذي يبدأ بـ { يُرسل JSON، وغير ذلك يُرسل form — مثال UltraMsg: <code dir="ltr">token=XXX&amp;to={phone}&amp;body={text}</code></div>${h.row('الرابط', 'مع GET يمكن وضع {phone} و{text} في الرابط', h.inp('waWebhookUrl', s.waWebhookUrl, 'url', 'dir="ltr" placeholder="https://api.ultramsg.com/instanceXXXX/messages/chat"')) + h.row('الطريقة', '', `<select name="waWebhookMethod">${opt('POST', s.waWebhookMethod, 'POST')}${opt('GET', s.waWebhookMethod, 'GET')}</select>`) + h.row('قالب الجسم', '', `<textarea name="waWebhookBody" rows="3" dir="ltr" style="min-width:280px">${e(s.waWebhookBody || '')}</textarea>`) + h.row('وضع no-cors', 'فعّله إذا كانت البوابة لا تدعم CORS (يُرسل بدون قراءة الرد)', h.sw('waWebhookNoCors', s.waWebhookNoCors))}</div>`
        + `<div class="divider"></div><div class="flex gap-2 flex-wrap items-center"><button type="button" class="btn btn-soft-success" id="wa-test"><i class="fab fa-whatsapp"></i> إرسال رسالة تجريبية</button><button type="button" class="btn btn-outline" id="wa-pending"><i class="fas fa-inbox"></i> رسائل بانتظار الإرسال (<span class="num">${pending.length}</span>)</button></div><div class="text-xs muted mt-2" id="wa-last">احفظ الإعدادات قبل التجربة.</div>`;
    },
    bind(body) {
      const sel = body.querySelector('#wa-prov'); if (sel) sel.onchange = () => body.querySelectorAll('[data-wa]').forEach(x => { x.style.display = x.dataset.wa === sel.value ? '' : 'none'; });
      wa.last().then(l => { const x = body.querySelector('#wa-last'); if (x && l) x.textContent = `آخر إرسال ${u.relTime(l.at)} (${l.provider}): ${l.ok} ناجح${l.fail ? ` · ${l.fail} فشل — ${(l.errs || []).join('، ')}` : ''} · احفظ الإعدادات قبل التجربة.`; });
      body.querySelector('#wa-test').onclick = async () => { try { const s = ERP.settings.all(); const r = await wa.send(wa.recipients(s), `✅ رسالة تجريبية من ${s.storeName}${s.branchName ? ' — ' + s.branchName : ''}\n${u.fmtDateTime(new Date())}`, { interactive: true, title: 'رسالة تجريبية' }); const bad = r.filter(x => !x.ok); if (bad.length) ERP.ui.error(bad.map(x => `${x.phone}: ${x.err}`).join(' · ')); else ERP.ui.success(r.map(x => `${x.phone}: ${x.note}`).join(' · ')); } catch (err) { ERP.ui.error(err.message); } };
      body.querySelector('#wa-pending').onclick = () => wa.openPending();
    },
    save(patch) { if ('waRecipients' in patch) { const l = wa.parseList(patch.waRecipients, patch.countryCode || ERP.settings.get('countryCode')); patch.waRecipients = l.length ? l.map(x => '+' + x).join(', ') : String(patch.waRecipients || '').trim(); } },
  });
})();
