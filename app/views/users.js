/* ==========================================================================
   View: Users & Roles (permissions matrix)
   ========================================================================== */
window.ERP = window.ERP || {}; ERP.views = ERP.views || {};
(function () {
  const u = ERP.utils; const e = u.escapeHtml;
  let el;
  function refresh() {
    if (!el) return;
    const roles = u.keyBy(ERP.auth.roles());
    $('#us-list', el).innerHTML = ERP.auth.users().map(x => { const r = roles[x.roleId]; return `<div class="card card-body flex items-center gap-3 mb-2"><div class="avatar" style="background:${x.avatarColor || 'var(--primary)'};color:#fff">${e(u.initials(x.name))}</div><div class="flex-1"><div class="fw-700">${e(x.name)} ${x.active === false ? u.badge('معطل', 'neutral') : ''} ${x.mustChangePin ? u.badge('رمز افتراضي!', 'danger') : ''}</div><div class="text-xs muted">@${e(x.username || '')} · <span style="color:${r?.color}">${e(r?.name || '?')}</span> · آخر دخول ${x.lastLogin ? u.relTime(x.lastLogin) : '—'}</div></div><button class="btn btn-sm btn-ghost" data-pin="${x.id}"><i class="fas fa-key"></i> رمز</button><button class="btn btn-sm btn-ghost" data-edit="${x.id}"><i class="fas fa-pen"></i></button><button class="btn btn-sm btn-ghost text-danger" data-del="${x.id}"><i class="fas fa-trash"></i></button></div>`; }).join('');
    $('#us-roles', el).innerHTML = ERP.auth.roles().map(r => `<div class="card card-body flex items-center gap-3 mb-2"><div class="avatar" style="background:${e(r.color)}22;color:${e(r.color)}"><i class="fas fa-shield-halved"></i></div><div class="flex-1"><div class="fw-700">${e(r.name)} ${r.isSystem ? u.badge('نظام', 'neutral') : ''}</div><div class="text-xs muted">${r.permissions.includes('*') ? 'كل الصلاحيات' : r.permissions.length + ' صلاحية'} · ${ERP.auth.users().filter(x => x.roleId === r.id).length} مستخدم</div></div><button class="btn btn-sm btn-ghost" data-role="${r.id}"><i class="fas fa-pen"></i> الصلاحيات</button>${!r.isSystem ? `<button class="btn btn-sm btn-ghost text-danger" data-rdel="${r.id}"><i class="fas fa-trash"></i></button>` : ''}</div>`).join('');
  }
  async function userForm(id = null) {
    const x = id ? ERP.auth.users().find(y => y.id === id) : null;
    const r = await ERP.ui.form({ title: x ? `تعديل ${e(x.name)}` : 'مستخدم جديد', icon: 'user-gear', values: x || { active: true }, fields: [{ name: 'name', label: 'الاسم', required: true }, { name: 'username', label: 'اسم المستخدم' }, { name: 'roleId', label: 'الدور', type: 'select', options: u.options(ERP.auth.roles(), { selected: x?.roleId }) }, ...(!x ? [{ name: 'pin', label: 'رمز الدخول (4 أرقام أو أكثر)', type: 'password', required: true }] : []), { name: 'employeeId', label: 'الموظف المرتبط', type: 'select', options: u.options(ERP.hr.employees(), { selected: x?.employeeId, empty: '— بدون —' }) }, { name: 'avatarColor', label: 'لون', type: 'color', value: x?.avatarColor || '#1a56f5' }, ...(x ? [{ name: 'active', type: 'checkbox', checkLabel: 'نشط' }] : [])], onSubmit: d => x ? ERP.auth.updateUser(id, d) : ERP.auth.createUser(d) });
    if (r) { ERP.ui.success('تم'); refresh(); ERP.router.renderSidebar(); }
  }
  async function pinForm(id) { const x = ERP.auth.users().find(y => y.id === id); const r = await ERP.ui.form({ title: `تغيير رمز ${e(x.name)}`, icon: 'key', fields: [{ name: 'pin', label: 'الرمز الجديد', type: 'password', required: true }, { name: 'pin2', label: 'تأكيد الرمز', type: 'password', required: true }], onSubmit: d => { if (d.pin !== d.pin2) throw new Error('الرمزان غير متطابقين'); return ERP.auth.changePin(id, null, d.pin); } }); if (r) { ERP.ui.success('تم تغيير الرمز'); refresh(); } }
  function roleForm(id = null) {
    const role = id ? ERP.auth.roles().find(r => r.id === id) : { name: '', color: '#3178ff', permissions: [] };
    const all = role.permissions.includes('*');
    const h = ERP.ui.modal({ title: id ? `صلاحيات: ${e(role.name)}` : 'دور جديد', icon: 'shield-halved', size: 'lg', body: `<div class="form-row cols-2 mb-3"><div class="form-group"><label>اسم الدور</label><input id="rl-name" value="${e(role.name)}" ${role.isSystem ? 'readonly' : ''}></div><div class="form-group"><label>اللون</label><input type="color" id="rl-color" value="${e(role.color)}"></div></div>${role.id === 'admin' ? '<div class="alert alert-info"><i class="fas fa-lock"></i> مدير النظام يمتلك كل الصلاحيات دائماً.</div>' : `<div class="flex justify-between items-center mb-2"><label class="checkbox"><input type="checkbox" id="rl-all"> تحديد الكل</label><span class="text-xs muted" id="rl-count"></span></div>${Object.entries(ERP.auth.PERMISSIONS).map(([grp, perms]) => `<div class="card card-body mb-2"><div class="fw-700 mb-2 flex items-center justify-between">${grp}<button class="btn btn-sm btn-ghost" data-grp="${e(grp)}">تحديد المجموعة</button></div><div class="grid grid-2 gap-2">${Object.entries(perms).map(([k, label]) => `<label class="checkbox text-sm"><input type="checkbox" class="rl-p" value="${k}" ${all || role.permissions.includes(k) ? 'checked' : ''}> ${label}</label>`).join('')}</div></div>`).join('')}`}`, footer: `<button class="btn" data-a="c">إلغاء</button><button class="btn btn-primary" data-a="ok"><i class="fas fa-check"></i> حفظ</button>` });
    const count = () => { const c = h.$('#rl-count'); if (c) c.textContent = `${h.$$('.rl-p:checked').length} / ${h.$$('.rl-p').length}`; }; count();
    const ra = h.$('#rl-all'); if (ra) ra.onchange = () => { h.$$('.rl-p').forEach(c => { c.checked = ra.checked; }); count(); };
    h.body.addEventListener('change', count);
    h.body.addEventListener('click', ev => { const g = ev.target.closest('[data-grp]'); if (g) { g.closest('.card').querySelectorAll('.rl-p').forEach(c => { c.checked = true; }); count(); } });
    h.$('[data-a=c]').onclick = () => h.close();
    h.$('[data-a=ok]').onclick = () => { const name = h.$('#rl-name').value.trim(); if (!name) return ERP.ui.warn('اسم الدور مطلوب'); const perms = role.id === 'admin' ? ['*'] : h.$$('.rl-p:checked').map(c => c.value); ERP.auth.saveRole({ ...role, name, color: h.$('#rl-color').value, permissions: perms }); h.close(); ERP.ui.success('تم الحفظ'); refresh(); ERP.router.renderSidebar(); };
  }
  ERP.views.users = { userForm, roleForm, pinForm };
  ERP.router.register({
    id: 'users', title: 'المستخدمون والصلاحيات', icon: 'user-shield', section: 'النظام', order: 1, perm: 'users.manage',
    render(root) {
      el = root;
      root.innerHTML = `<div class="page-header"><div><h2><i class="fas fa-user-shield"></i> المستخدمون والصلاحيات</h2><div class="desc">حسابات الدخول برمز PIN وأدوار بصلاحيات دقيقة</div></div><div class="page-actions"><button class="btn btn-outline" id="us-role-add"><i class="fas fa-shield-halved"></i> دور جديد</button><button class="btn btn-primary" id="us-add"><i class="fas fa-user-plus"></i> مستخدم جديد</button></div></div><div class="grid grid-2 gap-6"><div><h3 class="mb-3"><i class="fas fa-users text-primary"></i> المستخدمون</h3><div id="us-list"></div></div><div><h3 class="mb-3"><i class="fas fa-shield-halved text-primary"></i> الأدوار</h3><div id="us-roles"></div></div></div>`;
      $('#us-add', root).onclick = () => userForm(); $('#us-role-add', root).onclick = () => roleForm();
      root.addEventListener('click', async ev => { const t = ev.target.closest('[data-edit],[data-del],[data-pin],[data-role],[data-rdel]'); if (!t) return; if (t.dataset.edit) userForm(t.dataset.edit); if (t.dataset.pin) pinForm(t.dataset.pin); if (t.dataset.role) roleForm(t.dataset.role); if (t.dataset.del) { if (await ERP.ui.confirm('حذف المستخدم؟', { danger: true })) { try { ERP.auth.deleteUser(t.dataset.del); refresh(); } catch (err) { ERP.ui.error(err.message); } } } if (t.dataset.rdel) { if (await ERP.ui.confirm('حذف الدور؟', { danger: true })) { try { ERP.auth.deleteRole(t.dataset.rdel); refresh(); } catch (err) { ERP.ui.error(err.message); } } } });
    },
    onShow() { refresh(); },
  });
})();
