/* ==========================================================================
   ERP.cashcount — cash denomination count (فئة × عدد = إجمالي)
   - Z: closing count saved on the shift (shift.closingCount) → closing cash
   - X: mid-shift counts saved on the shift (shift.counts[]) without closing
   - variance above the allowed amount needs a supervisor (ERP.auth.approve)
   ========================================================================== */
window.ERP = window.ERP || {};
(function () {
  const u = ERP.utils; const e = u.escapeHtml;
  const DEF = [200, 100, 50, 20, 10, 5, 1, 0.5, 0.25];
  ERP.settings.extend({ cashDenoms: DEF.slice(), cashCountRequired: false, cashCountApproval: true, cashCountMaxVariance: 50 });
  const S = () => ERP.db.collection('shifts');

  const cc = {
    DEFAULT_DENOMS: DEF,
    /** "200, 100 ,0.5" | [..] → unique positive numbers, largest first */
    parseDenoms(v) { const arr = Array.isArray(v) ? v : u.normalizeDigits(String(v ?? '')).split(/[,،\s]+/); const out = u.uniq(arr.map(x => u.round(u.num(x), 2)).filter(x => x > 0)); return out.sort((a, b) => b - a); },
    denoms() { const d = cc.parseDenoms(ERP.settings.get('cashDenoms', DEF)); return d.length ? d : DEF.slice(); },
    label(d) { return d >= 1 ? `${u.fmtNum(d, 0)} ${ERP.settings.get('currency') || ''}`.trim() : `${u.round(d * 100, 0)} قرش`; },
    /** pure: { lines:[{denom,count}], extra } → { lines (count>0, with amount), extra, total } */
    sum(count) {
      const src = Array.isArray(count) ? { lines: count } : (count || {});
      const lines = (src.lines || []).map(l => ({ denom: u.round(u.num(l.denom), 2), count: Math.max(0, Math.round(u.num(l.count))) })).filter(l => l.denom > 0 && l.count > 0).map(l => ({ ...l, amount: u.round(l.denom * l.count) }));
      const extra = u.round(u.num(src.extra));
      return { lines, extra, total: u.round(u.sum(lines, 'amount') + extra) };
    },
    variance(total, expected) { return u.round(u.num(total) - u.num(expected)); },
    needsApproval(diff) { const s = ERP.settings.all(); return !!s.cashCountApproval && Math.abs(u.num(diff)) > Math.max(0, u.num(s.cashCountMaxVariance)) + 0.004; },
    /** X count (mid-shift) — saved on the shift, the shift stays open */
    record(shiftId, { lines, extra = 0, notes = '', kind = 'X', approvedBy = null } = {}) {
      const sh = S().get(shiftId); if (!sh || sh.status !== 'open') throw new Error('الوردية غير مفتوحة');
      const c = cc.sum({ lines, extra }); const expected = ERP.shifts.expected(sh);
      const me = ERP.auth.current();
      const rec = { id: u.uid(), kind, at: u.now(), by: me ? me.name : '', byId: me ? me.id : null, lines: c.lines, extra: c.extra, total: c.total, expected, diff: cc.variance(c.total, expected), notes, approvedBy: approvedBy ? { id: approvedBy.id, name: approvedBy.name } : null };
      S().update(shiftId, { counts: [...(sh.counts || []), rec] });
      ERP.audit.log('shift.count', `${sh.no}: عدّ ${kind} ${u.fmtMoney(c.total)} (متوقع ${u.fmtMoney(expected)} فرق ${u.fmtMoney(rec.diff)})`, sh.id);
      ERP.bus.emit('shift:change', S().get(shiftId));
      return rec;
    },

    /* ---------- UI: denomination grid (used by the close / X dialogs) ---------- */
    gridHtml(values = {}) {
      return `<div class="table-wrap"><table class="table table-compact cc-grid"><thead><tr><th>الفئة</th><th class="num" style="width:110px">العدد</th><th class="num">الإجمالي</th></tr></thead><tbody>${cc.denoms().map(d => `<tr><td class="fw-700">${e(cc.label(d))}</td><td><input type="number" min="0" step="1" inputmode="numeric" class="num cc-n" data-d="${d}" value="${e(values[d] || '')}" style="min-height:32px;padding:.25rem .5rem;text-align:center"></td><td class="num cc-t" data-d="${d}">—</td></tr>`).join('')}<tr><td>مبالغ أخرى <span class="text-xs muted">(فكة/شيكات)</span></td><td><input type="number" step="any" class="num cc-x" value="${e(values.extra || '')}" style="min-height:32px;padding:.25rem .5rem;text-align:center"></td><td class="num cc-xt">—</td></tr></tbody><tfoot><tr><th colspan="2">إجمالي المعدود</th><th class="num cc-total">0.00</th></tr></tfoot></table></div>`;
    },
    /** bind a grid rendered by gridHtml. onChange(result, touched) on every edit. Returns { get, touched } */
    bindGrid(root, onChange) {
      let touched = false;
      const get = () => cc.sum({ lines: u.$$('.cc-n', root).map(i => ({ denom: i.dataset.d, count: i.value })), extra: (u.$('.cc-x', root) || {}).value });
      const upd = () => { u.$$('.cc-n', root).forEach(i => { const n = Math.max(0, Math.round(u.num(i.value))); u.$(`.cc-t[data-d="${i.dataset.d}"]`, root).textContent = n ? u.fmtNum(n * u.num(i.dataset.d)) : '—'; }); const x = u.$('.cc-x', root); u.$('.cc-xt', root).textContent = x && u.num(x.value) ? u.fmtNum(x.value) : '—'; const r = get(); u.$('.cc-total', root).textContent = u.fmtNum(r.total); if (onChange) onChange(r, touched); };
      root.addEventListener('input', ev => { if (ev.target.matches('.cc-n,.cc-x')) { touched = true; upd(); } });
      root.addEventListener('keydown', ev => { if (ev.key === 'Enter' && ev.target.matches('.cc-n,.cc-x')) { ev.preventDefault(); ev.stopPropagation(); const all = u.$$('.cc-n,.cc-x', root); const nx = all[all.indexOf(ev.target) + 1]; if (nx) { nx.focus(); nx.select(); } } });
      upd();
      return { get, touched: () => touched };
    },
    /** live variance box (a .change-box element) — returns the difference */
    diffBox(box, total, expected) { const d = cc.variance(total, expected); const ok = Math.abs(d) < 0.01; box.className = 'change-box ' + (ok ? 'ok' : 'short'); box.innerHTML = `<span>${ok ? 'مطابق ✓' : d > 0 ? 'زيادة بالدرج' : 'عجز بالدرج'}${!ok && cc.needsApproval(d) ? ' <span class="text-xs">(يحتاج اعتماد مشرف)</span>' : ''}</span><span class="val">${u.fmtNum(d)}</span>`; return d; },
    /** receipt-style rows for Z/X reports */
    breakdownRows(c) {
      if (!c) return '';
      return `${(c.lines || []).map(l => `<tr><td>${e(cc.label(l.denom))} × <span class="num">${u.num(l.count)}</span></td><td class="num" style="text-align:left">${u.fmtNum(l.amount ?? l.denom * l.count)}</td></tr>`).join('')}${u.num(c.extra) ? `<tr><td>مبالغ أخرى</td><td class="num" style="text-align:left">${u.fmtNum(c.extra)}</td></tr>` : ''}<tr class="grand"><td>إجمالي المعدود</td><td class="num" style="text-align:left">${u.fmtNum(c.total)}</td></tr>`;
    },
  };
  ERP.cashcount = cc;

  /* ---------- settings section ---------- */
  ERP.settingsSections = ERP.settingsSections || [];
  ERP.settingsSections.push({
    id: 'cashcount', icon: 'money-bill-wave', label: 'عدّ النقدية (الفئات)',
    render(s, h) {
      return `<div class="alert alert-info mb-3"><i class="fas fa-circle-info"></i> عند إغلاق الوردية يُعدّ الدرج بالفئات (الفئة × العدد) ويُحسب الإجمالي والفرق عن المتوقع تلقائياً، ويُطبع التفصيل في تقرير Z. ويمكن عمل عدّ مؤقت (X) أثناء الوردية بدون إغلاق.</div>`
        + h.row('فئات العملة', 'مفصولة بفواصل — الفئات الأقل من 1 تُعرض بالقرش (0.5 = 50 قرش)', h.inp('cashDenoms', cc.denoms().join(','), 'text', 'id="cc-denoms" dir="ltr"') + ' <button type="button" class="btn btn-sm btn-ghost" id="cc-reset">الافتراضي</button>')
        + h.row('إلزام عدّ الفئات عند الإغلاق', 'لا يمكن إغلاق الوردية بكتابة المبلغ الإجمالي يدوياً', h.sw('cashCountRequired', s.cashCountRequired))
        + h.row('موافقة مشرف عند تجاوز الفرق', 'يُطلب رمز مشرف إذا تجاوز العجز أو الزيادة المبلغ المسموح', h.sw('cashCountApproval', s.cashCountApproval))
        + h.row('الفرق المسموح بدون موافقة', `بالـ${h.e(s.currency)} (زيادة أو عجز)`, h.inp('cashCountMaxVariance', s.cashCountMaxVariance, 'number', 'min="0" step="any"'));
    },
    bind(body) { const b = u.$('#cc-reset', body); if (b) b.onclick = () => { u.$('#cc-denoms', body).value = DEF.join(','); }; },
    save(patch) { if ('cashDenoms' in patch) { const d = cc.parseDenoms(patch.cashDenoms); patch.cashDenoms = d.length ? d : DEF.slice(); } if ('cashCountMaxVariance' in patch) patch.cashCountMaxVariance = Math.max(0, u.num(patch.cashCountMaxVariance)); },
  });
})();
