/* ==========================================================================
   View: مركز الاستيراد — type cards · wizard (template → options → file →
   preview → apply) · import history with details and undo
   ERP.views.imports.open(typeId) opens the wizard from anywhere (products, accounting…)
   ========================================================================== */
window.ERP = window.ERP || {}; ERP.views = ERP.views || {};
(function () {
  const u = ERP.utils; const e = u.escapeHtml; const IC = () => ERP.importCenter;
  let el, tab = 'types', hTable;
  const ST = { create: ['جديد', 'success'], update: ['تحديث', 'info'], skip: ['تخطي', 'neutral'], error: ['خطأ', 'danger'] };
  const fmtT = t => (t.money ? u.fmtMoney(t.value) : t.qty ? u.fmtQty(t.value) : u.fmtNum(t.value, Number.isInteger(t.value) ? 0 : 1));
  const list = (items, cls, icon) => (items.length ? `<div class="alert alert-${cls} mb-2" style="display:block;max-height:160px;overflow:auto"><i class="fas fa-${icon}"></i> ${items.map(x => e(x)).join('<br>')}</div>` : '');

  function typesHtml() {
    const all = ERP.importTypes.allowed();
    if (!all.length) return '<div class="empty-state"><i class="fas fa-lock"></i><h4>لا توجد أنواع استيراد متاحة لصلاحياتك</h4></div>';
    return IC().GROUPS.map(g => { const ts = all.filter(t => t.group === g); return ts.length ? `<h4 class="mt-4 mb-2 muted">${e(g)}</h4><div class="grid grid-auto gap-4">${ts.map(t => `<div class="card card-body cursor-pointer" role="button" tabindex="0" data-type="${e(t.id)}"><div class="flex items-center gap-3 mb-2"><div class="kpi-icon primary"><i class="fas fa-${e(t.icon)}"></i></div><strong>${e(t.label)}</strong></div><div class="text-sm muted">${e(t.desc)}</div><div class="flex gap-1 mt-2 flex-wrap">${t.modes.map(m => u.badge(IC().MODES[m], 'neutral')).join('')}${t.multiSheet ? u.badge('عدة صفحات', 'purple') : ''}</div></div>`).join('')}</div>` : ''; }).join('');
  }

  /* ---------------- wizard ---------------- */
  function open(typeId) {
    const def = ERP.importTypes.get(typeId); if (!def) return ERP.ui.error('نوع استيراد غير معروف');
    if (def.perm && !ERP.auth.require(def.perm)) return;
    let wb = null, parsed = null, pv = null, fileName = '', filter = 'all';
    const fg = (label, input) => `<div class="form-group"><label>${label}</label>${input}</div>`;
    const opt = x => {
      const v = x.default ? x.default() : '';
      if (x.type === 'select') return fg(e(x.label), `<select data-opt="${e(x.key)}">${x.required ? '<option value="">— اختر —</option>' : ''}${x.choices().map(c => `<option value="${e(c.value)}" ${String(c.value) === String(v) ? 'selected' : ''}>${e(c.label)}</option>`).join('')}</select>`);
      if (x.type === 'bool') return `<div class="form-group"><label class="checkbox mt-4"><input type="checkbox" data-opt="${e(x.key)}" ${v ? 'checked' : ''}> ${e(x.label)}</label></div>`;
      return fg(e(x.label), `<input type="${x.type === 'date' ? 'date' : x.type === 'number' ? 'number' : 'text'}" data-opt="${e(x.key)}" value="${e(v)}">`);
    };
    const opts = [
      def.modes.length > 1 ? fg('طريقة الاستيراد', `<select data-o="mode">${def.modes.map(md => `<option value="${md}">${IC().MODES[md]}</option>`).join('')}</select>`) : '',
      def.matchBy.length > 1 ? fg('البحث عن الموجود بـ', `<select data-o="matchBy">${def.matchBy.map(x => `<option value="${e(x.key)}">${e(x.label)}</option>`).join('')}</select>`) : '',
      ...def.options.map(opt),
    ].join('');
    const h = ERP.ui.modal({
      title: `استيراد ${e(def.label)}`, icon: def.icon || 'file-import', size: 'xl',
      body: `<div class="alert alert-info mb-3"><i class="fas fa-circle-info"></i> <div>${e(def.desc)}</div></div>
        <div class="flex gap-2 flex-wrap items-center mb-3"><span class="badge badge-primary">١</span><button class="btn btn-outline" data-a="tpl"><i class="fas fa-download"></i> تحميل النموذج</button><span class="text-xs muted">${def.multiSheet ? 'املأ الصفحات التي تحتاجها' : 'املأ صفحة البيانات — صفحة «تعليمات» تشرح كل عمود والقيم المقبولة'}</span></div>
        ${opts ? `<div class="form-row cols-3 mb-2" id="imp-opts">${opts}</div>` : ''}
        <div class="flex gap-2 flex-wrap items-center mb-3"><span class="badge badge-primary">٢</span><button class="btn btn-primary" data-a="pick"><i class="fas fa-upload"></i> اختيار ملف Excel</button><span class="text-sm muted" id="imp-file"></span></div>
        <div id="imp-pv"></div>`,
      footer: `<button class="btn" data-a="close">إغلاق</button><div class="flex-1"></div>${def.multiSheet ? '' : '<label class="checkbox text-sm"><input type="checkbox" id="imp-valid"> استيراد الأسطر السليمة فقط وتجاهل الأخطاء</label>'}<button class="btn btn-success" data-a="apply" disabled><i class="fas fa-check"></i> استيراد</button>`,
    });
    const validOnly = () => !!(h.$('#imp-valid') && h.$('#imp-valid').checked);
    const readOpts = () => { const o = { options: {}, validOnly: validOnly(), fileName }; h.$$('[data-o]').forEach(x => { o[x.dataset.o] = x.value; }); h.$$('[data-opt]').forEach(x => { o.options[x.dataset.opt] = x.type === 'checkbox' ? x.checked : x.value; }); return o; };
    const run = () => { if (!wb) return; try { if (!def.multiSheet && !parsed) parsed = IC().parse(def.id, wb); pv = IC().preview(def.id, def.multiSheet ? wb : parsed, readOpts()); show(); } catch (err) { console.error(err); ERP.ui.error('تعذر قراءة الملف: ' + err.message); } };
    function show() {
      const c = pv.counts; const valid = c.create + c.update;
      const rows = pv.items.filter(it => filter === 'all' || (filter === 'warn' ? it.warnings.length : it.status === filter));
      const pill = (f, label, n, kind) => `<button class="pill ${filter === f ? 'active' : ''}" data-f="${f}">${label} <span class="badge badge-${kind} num">${n}</span></button>`;
      h.$('#imp-pv').innerHTML = list(pv.fileErrors, 'danger', 'circle-xmark') + list(pv.fileWarnings, 'warning', 'triangle-exclamation')
        + (pv.totals && pv.totals.length ? `<div class="flex gap-3 flex-wrap mb-3">${pv.totals.map(t => `<div class="card card-body" style="padding:.5rem .9rem"><div class="text-xs muted">${e(t.label)}</div><div class="fw-700 num">${fmtT(t)}</div></div>`).join('')}</div>` : '')
        + `<div class="flex justify-between items-center flex-wrap gap-2 mb-2"><div class="pills">${pill('all', 'الكل', c.total, 'neutral')}${pill('create', 'جديد', c.create, 'success')}${pill('update', 'تحديث', c.update, 'info')}${pill('skip', 'تخطي', c.skip, 'neutral')}${pill('error', 'أخطاء', c.error, 'danger')}${pill('warn', 'تنبيهات', c.warn, 'warning')}</div>${c.error || pv.fileErrors.length ? '<button class="btn btn-sm btn-soft-danger" data-a="errs"><i class="fas fa-file-excel"></i> تنزيل الأسطر الخاطئة</button>' : ''}</div>`
        + `<div class="table-wrap" style="max-height:48vh;overflow:auto"><table class="table table-compact"><thead><tr><th class="num">السطر</th><th>الحالة</th><th>البيان</th><th>الأخطاء / التنبيهات</th></tr></thead><tbody>${rows.slice(0, 200).map(it => `<tr class="${it.status === 'error' ? 'row-danger' : it.warnings.length ? 'row-warning' : ''}"><td class="num">${it.row ?? ''}${it.sheet ? ` <span class="text-xs muted">${e(it.sheet)}</span>` : ''}</td><td>${u.badge(...ST[it.status])}</td><td>${e(it.label)}</td><td class="text-sm">${it.errors.map(x => `<div class="text-danger">${e(x)}</div>`).join('')}${it.warnings.map(x => `<div class="text-warning">${e(x)}</div>`).join('')}</td></tr>`).join('') || '<tr><td colspan="4" class="text-center muted">لا أسطر</td></tr>'}</tbody></table></div>${rows.length > 200 ? `<div class="text-xs muted mt-1">يعرض أول 200 من ${rows.length} سطر</div>` : ''}`;
      const btn = h.$('[data-a=apply]'); btn.disabled = !(!pv.fileErrors.length && valid > 0 && (!c.error || (validOnly() && !def.multiSheet)));
      btn.innerHTML = `<i class="fas fa-check"></i> استيراد ${valid} سطر`;
    }
    h.$('[data-a=close]').onclick = () => h.close();
    h.$('[data-a=tpl]').onclick = () => { try { IC().template(def.id); } catch (err) { ERP.ui.error(err.message); } };
    h.$('[data-a=pick]').onclick = () => { const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.xlsx,.xls,.csv'; inp.onchange = async () => { const f = inp.files[0]; if (!f) return; try { wb = await IC().read(f); parsed = null; fileName = f.name; h.$('#imp-file').textContent = f.name; filter = 'all'; run(); } catch (err) { ERP.ui.error('تعذر قراءة الملف: ' + err.message); } }; inp.click(); };
    h.body.addEventListener('change', ev => { if (ev.target.matches('[data-o],[data-opt]')) run(); });
    h.body.addEventListener('click', ev => { const f = ev.target.closest('[data-f]'); if (f) { filter = f.dataset.f; show(); } if (ev.target.closest('[data-a=errs]')) { try { IC().downloadErrors(pv); } catch (err) { ERP.ui.error(err.message); } } });
    const vo = h.$('#imp-valid'); if (vo) vo.onchange = () => pv && show();
    h.$('[data-a=apply]').onclick = async () => {
      if (!pv) return; const c = pv.counts;
      if (!await ERP.ui.confirm(`سيتم استيراد <strong>${c.create + c.update}</strong> سطر (${c.create} جديد، ${c.update} تحديث)${c.error ? ` وتجاهل <strong>${c.error}</strong> سطر خاطئ` : ''}.<br><span class="text-sm muted">يمكنك التراجع لاحقاً من «سجل الاستيراد» ما دام لم يحدث نشاط على البيانات المستوردة.</span>`, { title: `تأكيد استيراد ${e(def.label)}` })) return;
      const l = ERP.ui.loading('جاري الاستيراد...');
      setTimeout(() => { // let the spinner paint
        try { const b = IC().apply(pv, { validOnly: validOnly(), fileName }); l.close(); h.close(); ERP.ui.success(`تم ${b.no}: ${b.summary}`, { duration: 7000 }); ERP.router.go('imports', { tab: 'history' }); }
        catch (err) { l.close(); console.error(err); ERP.ui.error(err.message); run(); }
      }, 40);
    };
    return { handle: h, load(book, name = '') { wb = book; parsed = null; fileName = name; h.$('#imp-file').textContent = name; run(); return pv; }, get preview() { return pv; } };
  }

  /* ---------------- history ---------------- */
  const countsText = b => { const c = b.counts || {}; return `${c.create || 0} جديد · ${c.update || 0} تحديث${c.error ? ` · ${c.error} خطأ متجاهل` : ''}`; };
  function details(id) {
    const b = IC().batch(id); if (!b) return;
    const kv = o => Object.entries(o || {}).map(([k, n]) => `${e(k)}: <strong class="num">${n}</strong>`).join(' · ') || '—';
    const by = arr => { const o = {}; (arr || []).forEach(x => { const k = IC().COL_AR[x.col] || x.col; o[k] = (o[k] || 0) + 1; }); return o; };
    const item = (l, v) => `<div class="detail-item"><div class="dl">${l}</div><div class="dv">${v}</div></div>`;
    ERP.ui.view(`استيراد ${e(b.no)}`, `<div class="detail-grid mb-3">${item('النوع', e(b.label))}${item('الملف', e(b.fileName || '—'))}${item('التاريخ', `<span class="num">${u.fmtDateTime(b.at)}</span>`)}${item('المستخدم', e(b.userName || '—'))}${item('الطريقة', e(IC().MODES[b.mode] || b.mode || '—'))}${item('الحالة', b.status === 'undone' ? `${u.badge('تم التراجع', 'warning')} <span class="text-xs muted">${u.fmtDateTime(b.undoneAt)} — ${e(b.undoneByName || '')}</span>` : u.badge('مُطبق', 'success'))}</div>
      <div class="alert alert-info mb-3"><i class="fas fa-circle-check"></i> <div>${e(b.summary || '')}<br><span class="text-sm">${e(countsText(b))}</span></div></div>
      ${b.totals && b.totals.length ? `<div class="flex gap-3 flex-wrap mb-3">${b.totals.map(t => `<div class="card card-body" style="padding:.5rem .9rem"><div class="text-xs muted">${e(t.label)}</div><div class="fw-700 num">${fmtT(t)}</div></div>`).join('')}</div>` : ''}
      <table class="table table-compact"><tbody><tr><td>سجلات أُنشئت</td><td>${kv(by(b.created))}</td></tr><tr><td>سجلات عُدّلت</td><td>${kv(by(b.updated))}</td></tr><tr><td>قيود محاسبية</td><td class="num">${(b.journal || []).length}</td></tr><tr><td>حركات مخزون</td><td class="num">${(b.moves || []).length}</td></tr></tbody></table>`, { icon: 'file-import' });
  }
  async function undo(id) {
    const b = IC().batch(id); if (!b) return;
    const chk = IC().undoCheck(id);
    if (!chk.ok) return ERP.ui.view('لا يمكن التراجع', `<div class="alert alert-danger mb-2"><i class="fas fa-ban"></i> <div>لا يمكن التراجع عن <strong>${e(b.no)}</strong> (${e(b.label)}) لأن:</div></div><ul style="padding-inline-start:1.2rem;line-height:1.9">${chk.reasons.map(r => `<li>${e(r)}</li>`).join('')}</ul><div class="text-sm muted mt-2">التراجع مسموح فقط لو البيانات المستوردة لم يحدث عليها أي نشاط بعد الاستيراد.</div>`, { icon: 'ban', size: '' });
    const s = chk.summary; const li = (o, verb) => Object.entries(o).map(([k, n]) => `<li>${verb} ${n} ${e(k)}</li>`).join('');
    const msg = `التراجع عن <strong>${e(b.no)}</strong> — ${e(b.label)}:<ul style="padding-inline-start:1.2rem;line-height:1.9">${li(s.remove, 'حذف')}${li(s.restore, 'استرجاع القيم القديمة لـ')}${s.journal ? `<li>حذف ${s.journal} قيد محاسبي</li>` : ''}${s.moves ? `<li>عكس ${s.moves} حركة مخزون</li>` : ''}</ul>`;
    if (!await ERP.ui.confirm(msg, { title: 'تأكيد التراجع', danger: true, okText: 'تراجع' })) return;
    try { IC().undo(id); ERP.ui.success(`تم التراجع عن ${b.no}`); refresh(); } catch (err) { ERP.ui.error(err.message); }
  }

  function switchTab(t) { tab = t; if (!el) return; u.$$('#imp-tabs .tab', el).forEach(x => x.classList.toggle('active', x.dataset.t === t)); u.$$('.tab-pane', el).forEach(x => x.classList.toggle('active', x.dataset.p === t)); refresh(); }
  function refresh() { if (!el) return; if (tab === 'types') u.$('#imp-types', el).innerHTML = typesHtml(); else if (hTable) hTable.setRows(IC().batches()); }

  ERP.views.imports = { open, refresh, details, undo };
  ERP.router.register({
    id: 'imports', title: 'مركز الاستيراد', icon: 'file-import', section: 'النظام', order: 3,
    get perm() { const t = ERP.importTypes.allowed()[0]; return t ? t.perm : 'backup.manage'; }, // visible to anyone allowed to use at least one import type
    render(root) {
      el = root;
      root.innerHTML = `<div class="page-header"><div><h2><i class="fas fa-file-import"></i> مركز الاستيراد</h2><div class="desc">استيراد البيانات من Excel: نموذج جاهز ← معاينة وتدقيق كل سطر ← استيراد ← تراجع عند الحاجة</div></div></div>
        <div class="tabs" id="imp-tabs"><button class="tab active" data-t="types"><i class="fas fa-grip"></i> أنواع الاستيراد</button><button class="tab" data-t="history"><i class="fas fa-clock-rotate-left"></i> سجل الاستيراد</button></div>
        <div class="tab-pane active" data-p="types"><div id="imp-types"></div></div><div class="tab-pane" data-p="history"><div id="imp-hist"></div></div>`;
      hTable = ERP.ui.table({ el: u.$('#imp-hist', root), rows: [], exportName: 'سجل الاستيراد', emptyText: 'لم يتم أي استيراد بعد', emptyIcon: 'file-import', defaultSort: { key: 'at', dir: 'desc' }, columns: [
        { key: 'no', label: 'الرقم', render: b => `<strong class="num">${e(b.no)}</strong>` },
        { key: 'label', label: 'النوع', render: b => `<i class="fas fa-${e((ERP.importTypes.get(b.typeId) || {}).icon || 'file-import')} muted"></i> ${e(b.label)}` },
        { key: 'fileName', label: 'الملف', render: b => `<span class="text-sm">${e(b.fileName || '—')}</span>` },
        { key: 'at', label: 'التاريخ', render: b => `<span class="num text-sm">${u.fmtDateTime(b.at)}</span>`, text: b => u.fmtDateTime(b.at) },
        { key: 'userName', label: 'المستخدم' },
        { id: 'counts', label: 'الأسطر', sortable: false, render: b => `<span class="text-sm">${e(countsText(b))}</span>`, text: countsText },
        { key: 'status', label: 'الحالة', render: b => (b.status === 'undone' ? u.badge('تم التراجع', 'warning') : u.badge('مُطبق', 'success')), text: b => (b.status === 'undone' ? 'تم التراجع' : 'مُطبق') },
        { id: 'a', label: '', sortable: false, export: false, class: 'actions', render: b => `<button class="btn btn-sm btn-ghost" data-det="${e(b.id)}"><i class="fas fa-eye"></i> تفاصيل</button>${b.status !== 'undone' ? `<button class="btn btn-sm btn-soft-warning" data-undo="${e(b.id)}"><i class="fas fa-rotate-left"></i> تراجع</button>` : ''}` },
      ], onRowClick: b => details(b.id) });
      u.$('#imp-tabs', root).onclick = ev => { const t = ev.target.closest('.tab'); if (t) switchTab(t.dataset.t); };
      root.addEventListener('click', ev => { const c = ev.target.closest('[data-type]'); if (c) return open(c.dataset.type); const d = ev.target.closest('[data-det]'); if (d) return details(d.dataset.det); const x = ev.target.closest('[data-undo]'); if (x) undo(x.dataset.undo); });
      root.addEventListener('keydown', ev => { const c = ev.target.closest('[data-type]'); if (c && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); open(c.dataset.type); } });
    },
    onShow(root, params) { if (params && params.tab) switchTab(params.tab); else refresh(); },
  });
  ERP.bus.on('db:change', u.debounce(ev => { if (el && ERP.router.current() === 'imports' && ev && ev.collection === 'importBatches') refresh(); }, 250));
})();
